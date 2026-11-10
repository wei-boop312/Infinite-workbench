import type {Transaction} from '@electric-sql/pglite';
import {AgentExecutionRequestSchema,AgentExecutionPinSchema} from '@canvas/contracts';
import {LocalWorkspaceDatabase} from './localWorkspaceDatabase.ts';
import {LocalAgentReview} from './localAgentReview.ts';
import {LocalBoundRuns} from './localBoundRuns.ts';
import {WorkspaceModelGateway} from './workspaceModelGateway.ts';
import {contentHash} from './workspacePrototype.ts';

/** Single bounded action. No model loop, shell, URL or provider credentials. */
export class LocalAgentExecution {
  readonly authority:LocalAgentReview;
  constructor(private db:LocalWorkspaceDatabase,private runs:LocalBoundRuns,gateway:WorkspaceModelGateway){this.authority=new LocalAgentReview(db,gateway,'local_resize_execute');}
  async proposals(actorId:string,projectId:string,grantId:string){
    const result=await this.authority.proposals(actorId,projectId,grantId);
    const rows=(await this.db.asActor(actorId,tx=>tx.query<{id:string;proposal_id:string;run_id:string;payload:unknown;content_hash:string;state:string}>('SELECT c.id,c.proposal_id,c.run_id,c.payload,c.content_hash,r.state FROM workspace.agent_execution_consumptions c JOIN workspace.runs r ON r.project_id=c.project_id AND r.id=c.run_id WHERE c.project_id=$1 AND c.grant_id=$2 AND c.actor_id=$3',[projectId,grantId,actorId]))).rows;
    for(const row of rows){const pin=AgentExecutionPinSchema.parse(row.payload),item=result.items.find(item=>item.proposal.id===row.proposal_id);if(!item||contentHash(pin)!==row.content_hash||pin.consumptionId!==row.id||pin.proposalId!==row.proposal_id||pin.grantId!==result.grant.id||pin.grantHash!==contentHash(result.grant)||pin.proposalHash!==contentHash(item.proposal)||pin.approvalHash!==item.proposal.approvalHash||(result.grant.level==='L1'&&pin.nonce!==item.approval?.nonce))throw Error('AGENT_CONSUMPTION_INTEGRITY_FAILED');}
    return {...result,items:result.items.map(item=>{const row=rows.find(row=>row.proposal_id===item.proposal.id);return {...item,consumption:row?{id:row.id,runId:row.run_id,state:row.state}:null};})};
  }
  async revoke(actorId:string,projectId:string,grantId:string,reason:string){
    // Release the grant lock before requesting cancellation (run lock).
    const receipt=await this.authority.revoke(actorId,projectId,grantId,reason);
    const rows=(await this.db.asActor(actorId,tx=>tx.query<{run_id:string}>('SELECT run_id FROM workspace.agent_execution_consumptions WHERE project_id=$1 AND grant_id=$2 AND actor_id=$3',[projectId,grantId,actorId]))).rows;
    let cancellationRequestedCount=0,cancellationUnavailableCount=0;
    for(const row of rows){try{const result=await this.runs.cancel(actorId,projectId,row.run_id,'Agent授权已撤销');if(result.requested)cancellationRequestedCount++;}catch{cancellationUnavailableCount++;}}
    return {...receipt,cancellationRequestedCount,cancellationUnavailableCount};
  }
  async execute(actorId:string,projectId:string,raw:unknown,now=new Date()){
    actorId=actorId.toLowerCase();projectId=projectId.toLowerCase();
    const input=AgentExecutionRequestSchema.parse(raw);input.id=input.id.toLowerCase();input.proposalId=input.proposalId.toLowerCase();if(input.nonce)input.nonce=input.nonce.toLowerCase();
    const requestHash=contentHash(input);
    return this.db.asActor(actorId,async tx=>{
      const permission=(await tx.query<{allowed:boolean}>('SELECT workspace.can_edit(project_id) AS allowed FROM workspace.canvases WHERE project_id=$1',[projectId])).rows[0];
      if(!permission)throw Error('NOT_FOUND');if(!permission.allowed)throw Error('ACCESS_DENIED');
      await tx.query('SELECT project_id FROM workspace.budgets WHERE project_id=$1 FOR UPDATE',[projectId]);
      const previous=(await tx.query<{id:string;actor_id:string;request_hash:string;run_id:string}>('SELECT id,actor_id,request_hash,run_id FROM workspace.agent_execution_consumptions WHERE project_id=$1 AND (id=$2 OR proposal_id=$3)',[projectId,input.id,input.proposalId])).rows[0];
      if(previous){if(previous.actor_id!==actorId||previous.id!==input.id||previous.request_hash!==requestHash)throw Error('IDEMPOTENCY_CONFLICT');return {id:previous.run_id,consumptionId:previous.id,reused:true};}
      const {grant,proposal,nonce}=await this.authority.validateForExecution(tx,actorId,projectId,input.proposalId,now);
      if(proposal.approvalHash!==input.hash)throw Error('AGENT_APPROVAL_CHANGED');if(nonce!==input.nonce)throw Error('AGENT_APPROVAL_REQUIRED');
      const pin=AgentExecutionPinSchema.parse({mode:'local_resize_execute',policyVersion:'local-agent-execute-v1',consumptionId:input.id,grantId:grant.id,proposalId:proposal.id,grantHash:contentHash(grant),proposalHash:contentHash(proposal),approvalHash:proposal.approvalHash,nonce});
      const run=await this.runs.createInTransaction(tx,actorId,projectId,proposal.arguments.bindingId,proposal.arguments.parameters,'agent_'+input.id,pin);
      if(run.reused)throw Error('AGENT_CONSUMPTION_INTEGRITY_FAILED');
      await tx.query('INSERT INTO workspace.agent_execution_consumptions(project_id,id,actor_id,grant_id,proposal_id,run_id,nonce,payload,content_hash,request_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',[projectId,input.id,actorId,grant.id,proposal.id,run.id,nonce,JSON.stringify(pin),contentHash(pin),requestHash]);
      return {id:run.id,consumptionId:input.id,reused:false};
    });
  }
  /** Called only for new claim / beforeSubmit, never as an archive permission. */
  async guardStart(tx:Transaction,actorId:string,projectId:string,runId:string,raw:unknown,now=new Date()){
    const pin=AgentExecutionPinSchema.parse(raw),row=(await tx.query<{actor_id:string;payload:unknown;content_hash:string;run_id:string}>('SELECT actor_id,payload,content_hash,run_id FROM workspace.agent_execution_consumptions WHERE project_id=$1 AND id=$2',[projectId,pin.consumptionId])).rows[0];
    if(!row||row.actor_id!==actorId||row.run_id!==runId||row.content_hash!==contentHash(row.payload)||row.content_hash!==contentHash(pin))throw Error('AGENT_CONSUMPTION_INTEGRITY_FAILED');
    const current=await this.authority.validateForExecution(tx,actorId,projectId,pin.proposalId,now);
    if(contentHash(current.grant)!==pin.grantHash||contentHash(current.proposal)!==pin.proposalHash||current.nonce!==pin.nonce||current.proposal.approvalHash!==pin.approvalHash)throw Error('AGENT_CONSUMPTION_INTEGRITY_FAILED');
  }
}
