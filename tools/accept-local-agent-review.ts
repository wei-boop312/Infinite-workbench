import {randomUUID} from 'node:crypto';
import {resolve} from 'node:path';
import {mkdirSync,writeFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {LocalWorkspaceDatabase} from '../apps/api/src/localWorkspaceDatabase.ts';
import {LocalWorkspaceAssets} from '../apps/api/src/localWorkspaceAssets.ts';
import {LocalWorkflowVersions} from '../apps/api/src/localWorkflowVersions.ts';
import {LocalAgentReview} from '../apps/api/src/localAgentReview.ts';
import {WorkspaceModelGateway} from '../apps/api/src/workspaceModelGateway.ts';
import {contentHash} from '../apps/api/src/workspacePrototype.ts';
const caseId=randomUUID(),directory=resolve('work','owned-agent-review-'+caseId),evidence=resolve('docs/evidence/2026-11-10/agent-review',caseId),actor=randomUUID(),project=randomUUID();
mkdirSync(directory,{recursive:true});mkdirSync(evidence,{recursive:true});
let db:LocalWorkspaceDatabase|undefined;const report:Record<string,unknown>={caseId,status:'starting',mode:'review_only'};
const gateway=()=>new WorkspaceModelGateway({compilerConfigured:true,localResizeExecutor:false});
try{
  db=await LocalWorkspaceDatabase.open(process.cwd(),resolve(directory,'postgres'));
  await db.seedProject(project,'owned review restart',[{userId:actor,role:'owner'}]);
  const assets=new LocalWorkspaceAssets(db,resolve(directory,'assets')),repo=new LocalWorkflowVersions(db),template=await repo.ensureResizeTemplate(actor,project),sharp=createRequire(new URL('../apps/api/package.json',import.meta.url))('sharp'),bytes=await sharp({create:{width:8,height:8,channels:3,background:'#3366cc'}}).png().toBuffer(),asset=await assets.upload(actor,project,bytes,'image/png','owned-review.png'),lease=await db.acquireLease(actor,project);
  const source={id:randomUUID(),projectId:project,revision:1,type:'image',assetVersionId:asset.id,x:0,y:0,width:260,height:180},tool={id:randomUUID(),projectId:project,revision:1,type:'tool',templateVersionId:template.id,x:300,y:0,width:330,height:510};
  await db.saveCanvasOperation(actor,project,{id:randomUUID(),baseRevision:0,objects:[source,tool]},lease);
  const binding=await repo.bind(actor,project,{id:randomUUID(),projectId:project,taskLineId:randomUUID(),sourceObjectId:source.id,sourceObjectRevision:1,toolObjectId:tool.id,toolObjectRevision:1,templateVersionId:template.id});
  let review=new LocalAgentReview(db,gateway());
  const request={id:randomUUID(),level:'L1',bindingIds:[binding.id],ttlSeconds:600,maxActions:2,maxPixels:65536},grant=(await review.createGrant(actor,project,request)).grant,proposal=(await review.propose(actor,project,grant.id,{id:randomUUID(),bindingId:binding.id,parameters:{width:64,height:64}})).proposal,approval={hash:proposal.approvalHash,nonce:randomUUID()},hash=contentHash(proposal);
  await review.approve(actor,project,proposal.id,approval);
  await db.close();db=undefined;
  db=await LocalWorkspaceDatabase.open(process.cwd(),resolve(directory,'postgres'));review=new LocalAgentReview(db,gateway());
  const state=await review.inspect(actor,project,proposal.id),reused=await review.approve(actor,project,proposal.id,approval),oldGrant=await review.createGrant(actor,project,request);
  if(state.verdict!=='approved'||state.executionAuthorized||state.executed||contentHash(state.proposal)!==hash||!reused.reused||oldGrant.grant.expiresAt!==grant.expiresAt)throw Error('REVIEW_RESTART_FAILED');
  await review.revoke(actor,project,grant.id,'owned acceptance withdrawal');
  if((await review.inspect(actor,project,proposal.id)).reason!=='AGENT_GRANT_REVOKED')throw Error('REVOCATION_FAILED');
  const counts=await db.asActor(actor,async tx=>{const result:Record<string,number>={};for(const table of ['runs','outbox','run_attempts'])result[table]=(await tx.query(`SELECT * FROM workspace.${table} WHERE project_id=$1`,[project])).rows.length;return result;});
  if(Object.values(counts).some(Boolean))throw Error('UNEXPECTED_EXECUTION');
  Object.assign(report,{status:'passed',databaseReopened:true,proposalHashUnchanged:true,approvalNonceRetryReused:true,grantExpiryUnchanged:true,revocationBlocks:true,executionAuthorized:false,counts,modelRequests:0});
}catch(error){report.status='failed';report.error=(error as Error).message;process.exitCode=1;}
finally{if(db)await db.close();writeFileSync(resolve(evidence,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({...report,evidence},null,2));}
