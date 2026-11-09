import { PGlite, type Transaction } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHash, randomUUID, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { WorkspaceObjectSchema,WorkspaceCanvasOperationSchema,WorkspaceDisplayEdgeSchema,type WorkspaceObject } from "@canvas/contracts";
import { contentHash } from "./workspacePrototype.ts";
import {validateObjectMutation} from './objectMutation.ts';

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const passwordHash = (password:string,salt:string):Promise<Buffer> => new Promise((done,reject)=>
  scrypt(password,salt,64,{N:16384,r:8,p:1},(error,key)=>error?reject(error):done(key)));
export class LocalWorkspaceDatabase {
  private constructor(private db: PGlite) {}
  static async open(root: string, directory?: string) {
    const db = await PGlite.create(directory ?? "memory://");
    try {
      await db.exec("CREATE TABLE IF NOT EXISTS public.workspace_migrations(version integer primary key,sha256 text not null)");
      for(const [index,name] of ['001_workspace.sql','002_local_identity.sql','003_local_assets.sql','004_binding_order.sql','005_local_run_attempts.sql','006_local_run_outputs.sql','007_canvas_change_journal.sql','008_local_run_cancellation.sql','009_run_artifact_evidence.sql','010_archive_recovery_leases.sql','011_canvas_operations.sql','012_unplaced_run_results.sql','013_private_documents.sql','014_display_edges.sql','015_task_cards.sql'].entries()){
        const version=index+1,sql=readFileSync(resolve(root,"db/migrations",name),"utf8");
        const applied=await db.query<{sha256:string}>("SELECT sha256 FROM public.workspace_migrations WHERE version=$1",[version]);
        if(!applied.rows.length)await db.transaction(async tx=>{
          await tx.exec(sql);await tx.query("INSERT INTO public.workspace_migrations VALUES($1,$2)",[version,hash(sql)]);
        });
        else if(applied.rows[0].sha256!==hash(sql))throw new Error("MIGRATION_CHECKSUM_CHANGED");
      }
      return new LocalWorkspaceDatabase(db);
    } catch (error) { await db.close(); throw error; }
  }
  async close() { await this.db.close(); }
  async needsLocalSetup(){return (await this.db.query('SELECT id FROM workspace_auth.users LIMIT 1')).rows.length===0;}
  async setupLocalOwner(username:string,password:string){
    if(!/^[a-z][a-z0-9_-]{2,39}$/.test(username)||password.length<16||password.length>128)throw new Error('INVALID_LOCAL_CREDENTIALS');
    const salt=randomBytes(32).toString('hex'),derived=await passwordHash(password,salt),id=randomUUID();
    try{return await this.db.transaction(async tx=>{
      await tx.exec('LOCK TABLE workspace_auth.users IN EXCLUSIVE MODE');
      if((await tx.query('SELECT id FROM workspace_auth.users LIMIT 1')).rows.length)throw new Error('LOCAL_SETUP_COMPLETE');
      await tx.query('INSERT INTO workspace_auth.users(id,username,password_salt,password_hash) VALUES($1,$2,$3,$4)',[id,username,salt,derived.toString('hex')]);
      return {id,username};
    });}finally{derived.fill(0);}
  }
  // Trusted local setup only; this is deliberately not a public registration route.
  async registerLocalUser(username:string,password:string){
    if(!/^[a-z][a-z0-9_-]{2,39}$/.test(username)||password.length<16||password.length>128)throw new Error("INVALID_LOCAL_CREDENTIALS");
    const id=randomUUID(),salt=randomBytes(32).toString('hex'),derived=await passwordHash(password,salt);
    try{await this.db.query("INSERT INTO workspace_auth.users(id,username,password_salt,password_hash) VALUES($1,$2,$3,$4)",[id,username,salt,derived.toString('hex')]);}
    finally{derived.fill(0);}
    return {id,username};
  }
  async login(username:string,password:string,now=new Date()){
    if(typeof username!=='string'||typeof password!=='string'||username.length>40||password.length>128)throw new Error("LOGIN_FAILED");
    const user=(await this.db.query<{id:string;username:string;password_salt:string;password_hash:string}>("SELECT * FROM workspace_auth.users WHERE username=$1",[username])).rows[0];
    const derived=await passwordHash(password,user?.password_salt??'missing-local-account');
    const expected=Buffer.from(user?.password_hash??'00'.repeat(64),'hex');
    const valid=expected.length===derived.length&&timingSafeEqual(derived,expected);derived.fill(0);expected.fill(0);
    if(!user||!valid)throw new Error("LOGIN_FAILED");
    const token=randomBytes(32).toString('base64url'),expiresAt=new Date(now.getTime()+12*60*60*1000).toISOString();
    await this.db.query("INSERT INTO workspace_auth.sessions VALUES($1,$2,$3,NULL)",[hash(token),user.id,expiresAt]);
    return {token,expiresAt,user:{id:user.id,username:user.username}};
  }
  async authenticate(token:string,now=new Date()){
    if(!/^[A-Za-z0-9_-]{43}$/.test(token))throw new Error("UNAUTHENTICATED");
    const user=(await this.db.query<{id:string;username:string}>("SELECT u.id,u.username FROM workspace_auth.users u JOIN workspace_auth.sessions s ON s.user_id=u.id WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at>$2",[hash(token),now.toISOString()])).rows[0];
    if(!user)throw new Error("UNAUTHENTICATED");return user;
  }
  async logout(token:string){
    if(!/^[A-Za-z0-9_-]{43}$/.test(token))return;
    await this.db.query("UPDATE workspace_auth.sessions SET revoked_at=now() WHERE token_hash=$1 AND revoked_at IS NULL",[hash(token)]);
  }
  // Administrative fixture/bootstrap port. Never exposed as an HTTP endpoint.
  async seedProject(projectId: string, name: string, members: {userId:string;role:string}[], budget = "100") {
    await this.db.transaction(async tx => {
      await tx.query("INSERT INTO workspace.projects(id,name) VALUES($1,$2)", [projectId,name]);
      for (const m of members) await tx.query("INSERT INTO workspace.project_members VALUES($1,$2,$3)", [projectId,m.userId,m.role]);
      await tx.query("INSERT INTO workspace.canvases(project_id) VALUES($1)",[projectId]);
      await tx.query("INSERT INTO workspace.budgets(project_id,currency,limit_amount) VALUES($1,'USD',$2)",[projectId,budget]);
    });
  }
  // actorId must come from the trusted local session, never request JSON.
  async asActor<T>(actorId: string, action: (tx: Transaction) => Promise<T>): Promise<T> {
    if (!/^[a-f0-9-]{36}$/i.test(actorId)) throw new Error("INVALID_ACTOR");
    return this.db.transaction(async tx => {
      await tx.exec("SET LOCAL ROLE workspace_app");
      await tx.query("SELECT set_config('app.actor_id',$1,true)",[actorId]);
      return action(tx);
    });
  }
  async acquireLease(actorId:string,projectId:string,takeover=false,now=new Date()) {
    const token=randomUUID(), expiresAt=new Date(now.getTime()+60_000).toISOString();
    return this.asActor(actorId,async tx=>{
      const row=(await tx.query<{holder_id:string;fencing_token:number;expires_at:Date}>("SELECT * FROM workspace.edit_leases WHERE project_id=$1 FOR UPDATE",[projectId])).rows[0];
      if(row && new Date(row.expires_at).getTime()>now.getTime() && row.holder_id!==actorId && !takeover) throw new Error("LEASE_CONFLICT");
      const fencing=Number(row?.fencing_token??0)+1;
      await tx.query("INSERT INTO workspace.edit_leases VALUES($1,$2,$3,$4,$5) ON CONFLICT(project_id) DO UPDATE SET holder_id=excluded.holder_id,token_hash=excluded.token_hash,fencing_token=excluded.fencing_token,expires_at=excluded.expires_at",[projectId,actorId,hash(token),fencing,expiresAt]);
      return {token,fencing,expiresAt};
    });
  }
  /** Privileged read-only dispatcher inventory, never routed to public HTTP. */
  async pendingLocalRuns(){
    const rows=(await this.db.query<{project_id:string;run_id:string;actor_id:string}>(`SELECT o.project_id,o.run_id,s.payload->'authorization'->>'actorId' AS actor_id
      FROM workspace.outbox o JOIN workspace.runs r ON r.project_id=o.project_id AND r.id=o.run_id
      JOIN workspace.run_snapshots s ON s.project_id=r.project_id AND s.id=r.snapshot_id
      JOIN workspace.projects p ON p.id=r.project_id AND p.deleted_at IS NULL
      JOIN workspace.project_members m ON m.project_id=p.id AND m.user_id::text=s.payload->'authorization'->>'actorId' AND m.role IN ('owner','creator','designer')
      WHERE o.dispatched_at IS NULL AND o.event_type='run.created' AND r.state='queued' AND s.payload->'authorization'->>'scope'='local-resize-only-v1'
      ORDER BY o.created_at LIMIT 100`)).rows;
    return rows.filter(row=>/^[0-9a-f-]{36}$/i.test(row.actor_id));
  }
  async expiredLocalAttempts(){
    return (await this.db.query<{project_id:string;run_id:string;actor_id:string}>(`SELECT a.project_id,a.run_id,a.actor_id FROM workspace.run_attempts a
      JOIN workspace.projects p ON p.id=a.project_id AND p.deleted_at IS NULL
      JOIN workspace.project_members m ON m.project_id=p.id AND m.user_id=a.actor_id AND m.role IN ('owner','creator','designer')
      WHERE a.lease_expires_at<=now() AND a.stage IN ('claimed','submitted','returned') AND NOT EXISTS(SELECT 1 FROM workspace.run_archive_claims c WHERE c.project_id=a.project_id AND c.run_id=a.run_id AND c.status='claimed' AND c.expires_at>now()) LIMIT 100`)).rows;
  }
  async saveObject(actorId:string,projectId:string,raw:unknown,baseCanvasRevision:number,lease:{token:string;fencing:number},now=new Date()) {
    const object=WorkspaceObjectSchema.parse(raw);
    if(object.projectId!==projectId) throw new Error("NOT_FOUND");
    if(!Number.isSafeInteger(baseCanvasRevision)||baseCanvasRevision<0)throw new Error('REVISION_CONFLICT');
    return this.asActor(actorId,async tx=>{
      const canvas=(await tx.query<{revision:number}>("SELECT revision FROM workspace.canvases WHERE project_id=$1 FOR UPDATE",[projectId])).rows[0];
      if(!canvas) throw new Error("NOT_FOUND");
      const current=(await tx.query<{token_hash:string;holder_id:string;fencing_token:number;expires_at:Date}>("SELECT * FROM workspace.edit_leases WHERE project_id=$1 FOR UPDATE",[projectId])).rows[0];
      if(!current || current.holder_id!==actorId || current.token_hash!==hash(lease.token) || Number(current.fencing_token)!==lease.fencing || new Date(current.expires_at).getTime()<=now.getTime()) throw new Error("LEASE_CONFLICT");
      const currentRevision=Number(canvas.revision);
      if(currentRevision!==baseCanvasRevision){
        // Only a complete journal of independent result appends may be rebased.
        // A user edit, legacy gap, future revision or object conflict still fails.
        const changes=(await tx.query<{count:string;only_outputs:boolean}>("SELECT count(*)::text AS count,bool_and(kind='run_output') AS only_outputs FROM workspace.canvas_changes WHERE project_id=$1 AND revision>$2 AND revision<=$3",[projectId,baseCanvasRevision,currentRevision])).rows[0];
        if(baseCanvasRevision<0||!Number.isInteger(baseCanvasRevision)||Number(changes.count)!==currentRevision-baseCanvasRevision||changes.only_outputs!==true)throw new Error('REVISION_CONFLICT');
      }
      const previous=(await tx.query<{current_revision:number;payload:unknown}>('SELECT o.current_revision,r.payload FROM workspace.objects o JOIN workspace.object_revisions r ON r.project_id=o.project_id AND r.object_id=o.id AND r.revision=o.current_revision WHERE o.project_id=$1 AND o.id=$2',[projectId,object.id])).rows[0];
      if(object.revision!==Number(previous?.current_revision??0)+1) throw new Error("OBJECT_REVISION_CONFLICT");
      validateObjectMutation(previous?WorkspaceObjectSchema.parse(previous.payload):undefined,object);
      await this.checkObjectAsset(tx,object);
      await tx.query("INSERT INTO workspace.objects VALUES($1,$2,$3) ON CONFLICT(project_id,id) DO UPDATE SET current_revision=excluded.current_revision",[projectId,object.id,object.revision]);
      await tx.query("INSERT INTO workspace.object_revisions VALUES($1,$2,$3,$4,$5,$6)",[projectId,object.id,object.revision,(object.type==='image'||object.type==='file')?object.assetVersionId:null,JSON.stringify(object),contentHash(object)]);
      await tx.query("UPDATE workspace.canvases SET revision=revision+1 WHERE project_id=$1",[projectId]);
      await tx.query("INSERT INTO workspace.canvas_changes(project_id,revision,kind,object_id,object_revision,actor_id) VALUES($1,$2,'editor',$3,$4,$5)",[projectId,currentRevision+1,object.id,object.revision,actorId]);
      return currentRevision+1;
    });
  }
  async saveCanvasOperation(actorId:string,projectId:string,raw:unknown,lease:{token:string;fencing:number},now=new Date()){
    const input=WorkspaceCanvasOperationSchema.parse(raw);
    if([...input.objects,...(input.edges??[])].some(item=>item.projectId.toLowerCase()!==projectId.toLowerCase()))throw Error('NOT_FOUND');
    if(new Set(input.objects.map(object=>object.id.toLowerCase())).size!==input.objects.length||new Set((input.edges??[]).map(edge=>edge.id.toLowerCase())).size!==(input.edges?.length??0))throw Error('INVALID_BODY');
    const requestHash=contentHash(input);
    return this.asActor(actorId,async tx=>{
      const visible=(await tx.query<{allowed:boolean}>('SELECT workspace.can_edit(project_id) AS allowed FROM workspace.canvases WHERE project_id=$1',[projectId])).rows[0];
      if(!visible)throw Error('NOT_FOUND');if(!visible.allowed)throw Error('ACCESS_DENIED');
      const canvas=(await tx.query<{revision:number;allowed:boolean}>('SELECT revision,workspace.can_edit(project_id) AS allowed FROM workspace.canvases WHERE project_id=$1 FOR UPDATE',[projectId])).rows[0];
      if(!canvas)throw Error('NOT_FOUND');if(!canvas.allowed)throw Error('ACCESS_DENIED');
      const prior=(await tx.query<{actor_id:string;request_hash:string;result:{revision:number;objects:{id:string;revision:number}[]}}>('SELECT actor_id,request_hash,result FROM workspace.canvas_operations WHERE project_id=$1 AND id=$2',[projectId,input.id])).rows[0];
      if(prior){if(prior.actor_id!==actorId||prior.request_hash!==requestHash)throw Error('IDEMPOTENCY_CONFLICT');return {...prior.result,reused:true};}
      const current=(await tx.query<{token_hash:string;holder_id:string;fencing_token:number;expires_at:Date}>('SELECT * FROM workspace.edit_leases WHERE project_id=$1 FOR UPDATE',[projectId])).rows[0];
      if(!current||current.holder_id!==actorId||current.token_hash!==hash(lease.token)||Number(current.fencing_token)!==lease.fencing||new Date(current.expires_at).getTime()<=now.getTime())throw Error('LEASE_CONFLICT');
      const startRevision=Number(canvas.revision);
      if(startRevision!==input.baseRevision){
        const changes=(await tx.query<{count:string;only_outputs:boolean}>("SELECT count(*)::text AS count,bool_and(kind='run_output') AS only_outputs FROM workspace.canvas_changes WHERE project_id=$1 AND revision>$2 AND revision<=$3",[projectId,input.baseRevision,startRevision])).rows[0];
        if(Number(changes.count)!==startRevision-input.baseRevision||changes.only_outputs!==true)throw Error('REVISION_CONFLICT');
      }
      let revision=startRevision;
      for(const object of input.objects){
        const previous=(await tx.query<{current_revision:number;payload:unknown}>('SELECT o.current_revision,r.payload FROM workspace.objects o JOIN workspace.object_revisions r ON r.project_id=o.project_id AND r.object_id=o.id AND r.revision=o.current_revision WHERE o.project_id=$1 AND o.id=$2',[projectId,object.id])).rows[0];
        if(object.revision!==Number(previous?.current_revision??0)+1)throw Error('OBJECT_REVISION_CONFLICT');
        validateObjectMutation(previous?WorkspaceObjectSchema.parse(previous.payload):undefined,object);
        await this.checkObjectAsset(tx,object);
        if(!previous&&object.deleted)throw Error('INVALID_BODY');
        await tx.query('INSERT INTO workspace.objects VALUES($1,$2,$3) ON CONFLICT(project_id,id) DO UPDATE SET current_revision=excluded.current_revision',[projectId,object.id,object.revision]);
        await tx.query('INSERT INTO workspace.object_revisions VALUES($1,$2,$3,$4,$5,$6)',[projectId,object.id,object.revision,(object.type==='image'||object.type==='file')?object.assetVersionId:null,JSON.stringify(object),contentHash(object)]);
        revision++;
        await tx.query("INSERT INTO workspace.canvas_changes(project_id,revision,kind,object_id,object_revision,actor_id) VALUES($1,$2,'editor',$3,$4,$5)",[projectId,revision,object.id,object.revision,actorId]);
      }
      for(const edge of input.edges??[]){
        const previous=(await tx.query<{current_revision:number;payload:unknown}>('SELECT e.current_revision,r.payload FROM workspace.display_edges e JOIN workspace.display_edge_revisions r ON r.project_id=e.project_id AND r.edge_id=e.id AND r.revision=e.current_revision WHERE e.project_id=$1 AND e.id=$2',[projectId,edge.id])).rows[0];
        if(edge.revision!==Number(previous?.current_revision??0)+1)throw Error('EDGE_REVISION_CONFLICT');
        const old=previous?WorkspaceDisplayEdgeSchema.parse(previous.payload):null;
        if(old&&(old.sourceObjectId.toLowerCase()!==edge.sourceObjectId.toLowerCase()||old.targetObjectId.toLowerCase()!==edge.targetObjectId.toLowerCase()))throw Error('EDGE_IDENTITY_CONFLICT');
        if(!old&&edge.deleted)throw Error('INVALID_BODY');
        // A hidden relation can still be deleted; creating/restoring a live
        // relation requires both current endpoints, including this operation.
        if(!edge.deleted){
          const endpoints=(await tx.query<{id:string;payload:unknown}>('SELECT o.id,r.payload FROM workspace.objects o JOIN workspace.object_revisions r ON r.project_id=o.project_id AND r.object_id=o.id AND r.revision=o.current_revision WHERE o.project_id=$1 AND o.id IN ($2,$3)',[projectId,edge.sourceObjectId,edge.targetObjectId])).rows;
          if(endpoints.length!==2||endpoints.some(row=>WorkspaceObjectSchema.parse(row.payload).deleted))throw Error('EDGE_ENDPOINT_NOT_FOUND');
        }
        await tx.query('INSERT INTO workspace.display_edges VALUES($1,$2,$3) ON CONFLICT(project_id,id) DO UPDATE SET current_revision=excluded.current_revision',[projectId,edge.id,edge.revision]);
        await tx.query('INSERT INTO workspace.display_edge_revisions VALUES($1,$2,$3,$4,$5,$6,$7)',[projectId,edge.id,edge.revision,edge.sourceObjectId,edge.targetObjectId,JSON.stringify(edge),contentHash(edge)]);
        revision++;
        await tx.query("INSERT INTO workspace.canvas_changes(project_id,revision,kind,edge_id,edge_revision,actor_id) VALUES($1,$2,'editor_edge',$3,$4,$5)",[projectId,revision,edge.id,edge.revision,actorId]);
      }
      await tx.query('UPDATE workspace.canvases SET revision=$1 WHERE project_id=$2',[revision,projectId]);
      const result={revision,objects:input.objects.map(object=>({id:object.id,revision:object.revision})),...(input.edges?{edges:input.edges.map(edge=>({id:edge.id,revision:edge.revision}))}:{})};
      await tx.query('INSERT INTO workspace.canvas_operations(project_id,id,actor_id,request_hash,result) VALUES($1,$2,$3,$4,$5)',[projectId,input.id,actorId,requestHash,JSON.stringify(result)]);
      return {...result,reused:false};
    });
  }
  private async checkObjectAsset(tx:Transaction,object:WorkspaceObject){
    if(object.type==='task'){if(!(await tx.query('SELECT id FROM workspace.runs WHERE project_id=$1 AND id=$2',[object.projectId,object.runId])).rows.length)throw Error('NOT_FOUND');return;}
    if(object.type!=='image'&&object.type!=='file')return;
    const asset=(await tx.query<{kind:string}>('SELECT kind FROM workspace.asset_versions WHERE project_id=$1 AND id=$2',[object.projectId,object.assetVersionId])).rows[0];
    if(!asset)throw Error('NOT_FOUND');if(asset.kind!==(object.type==='file'?'document':'image'))throw Error('ASSET_KIND_MISMATCH');
  }
  async registerLocalDocument(actorId:string,projectId:string,asset:{id:string;sha256:string;byteSize:number;mime:string;name:string;characterCount:number;lineCount:number;hasBom:boolean},writeBytes:()=>void){
    return this.asActor(actorId,async tx=>{
      const visible=(await tx.query<{allowed:boolean}>('SELECT workspace.can_edit(project_id) AS allowed FROM workspace.canvases WHERE project_id=$1',[projectId])).rows[0];if(!visible)throw Error('NOT_FOUND');if(!visible.allowed)throw Error('ACCESS_DENIED');
      if(!(await tx.query('SELECT project_id FROM workspace.canvases WHERE project_id=$1 FOR UPDATE',[projectId])).rows.length)throw Error('NOT_FOUND');
      const used=(await tx.query<{used:string}>('SELECT (coalesce((SELECT sum(byte_size) FROM workspace.asset_files WHERE project_id=$1),0)+coalesce((SELECT sum(byte_size) FROM workspace.asset_documents WHERE project_id=$1),0))::text AS used',[projectId])).rows[0].used;
      if(Number(used)+asset.byteSize>64*1024*1024)throw Error('ASSET_QUOTA_EXCEEDED');writeBytes();
      await tx.query("INSERT INTO workspace.asset_versions(project_id,id,sha256,state,storage_key,kind) VALUES($1,$2,$3,'ready',$4,'document')",[projectId,asset.id,asset.sha256,`${projectId}/${asset.id}.bin`]);
      await tx.query('INSERT INTO workspace.asset_documents(project_id,id,byte_size,mime,original_name,character_count,line_count,has_bom) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[projectId,asset.id,asset.byteSize,asset.mime,asset.name,asset.characterCount,asset.lineCount,asset.hasBom]);
    });
  }
  async readLocalDocument(actorId:string,projectId:string,id:string){
    const row=(await this.asActor(actorId,tx=>tx.query<{id:string;sha256:string;mime:string;byte_size:number;original_name:string;character_count:number;line_count:number;has_bom:boolean}>('SELECT d.*,v.sha256 FROM workspace.asset_documents d JOIN workspace.asset_versions v ON v.project_id=d.project_id AND v.id=d.id AND v.kind=d.kind WHERE d.project_id=$1 AND d.id=$2',[projectId,id]))).rows[0];if(!row)throw Error('NOT_FOUND');return row;
  }
  async renewLease(actorId:string,projectId:string,lease:{token:string;fencing:number},now=new Date()){
    return this.asActor(actorId,async tx=>{
      const expiresAt=new Date(now.getTime()+60_000).toISOString();
      const updated=await tx.query("UPDATE workspace.edit_leases SET expires_at=$1 WHERE project_id=$2 AND holder_id=$3 AND token_hash=$4 AND fencing_token=$5 AND expires_at>$6 RETURNING project_id",[expiresAt,projectId,actorId,hash(lease.token),lease.fencing,now.toISOString()]);
      if(!updated.rows.length)throw new Error('LEASE_CONFLICT');return {expiresAt};
    });
  }
  async registerLocalAsset(actorId:string,projectId:string,asset:{id:string;sha256:string;byteSize:number;mime:string;name:string;width:number;height:number},writeBytes:()=>void){
    return this.asActor(actorId,async tx=>{
      if(!(await tx.query('SELECT project_id FROM workspace.canvases WHERE project_id=$1 FOR UPDATE',[projectId])).rows.length)throw new Error('NOT_FOUND');
      const size=(await tx.query<{used:string}>("SELECT (coalesce((SELECT sum(byte_size) FROM workspace.asset_files WHERE project_id=$1),0)+coalesce((SELECT sum(byte_size) FROM workspace.asset_documents WHERE project_id=$1),0))::text AS used",[projectId])).rows[0].used;
      if(Number(size)+asset.byteSize>64*1024*1024)throw new Error('ASSET_QUOTA_EXCEEDED');
      writeBytes();
      await tx.query("INSERT INTO workspace.asset_versions VALUES($1,$2,$3,'ready',$4)",[projectId,asset.id,asset.sha256,`${projectId}/${asset.id}.bin`]);
      await tx.query('INSERT INTO workspace.asset_files VALUES($1,$2,$3,$4,$5,$6,$7)',[projectId,asset.id,asset.byteSize,asset.mime,asset.name,asset.width,asset.height]);
    });
  }
  async readLocalAsset(actorId:string,projectId:string,id:string){
    const asset=(await this.asActor(actorId,tx=>tx.query<{id:string;sha256:string;mime:string;byte_size:number;original_name:string;width:number;height:number}>(
      'SELECT f.*,v.sha256 FROM workspace.asset_files f JOIN workspace.asset_versions v ON v.project_id=f.project_id AND v.id=f.id WHERE f.project_id=$1 AND f.id=$2',[projectId,id]))).rows[0];
    if(!asset)throw new Error('NOT_FOUND');return asset;
  }
  async enqueue(actorId:string,projectId:string,snapshot:unknown,key:string,amount:string) {
    if(!/^\d+(\.\d{1,8})?$/.test(amount) || !/^[a-zA-Z0-9_-]{1,128}$/.test(key)) throw new Error("INVALID_RUN_INPUT");
    const requestHash=contentHash({snapshot,amount});
    return this.asActor(actorId,async tx=>{
      // Lock order is always budget -> existing run -> inserts. The single
      // local engine serializes transactions; native multi-connection tests remain pending.
      const budget=await tx.query("SELECT * FROM workspace.budgets WHERE project_id=$1 FOR UPDATE",[projectId]);
      if(!budget.rows.length) throw new Error("NOT_FOUND");
      const prior=(await tx.query<{id:string;request_hash:string}>("SELECT id,request_hash FROM workspace.runs WHERE project_id=$1 AND idempotency_key=$2",[projectId,key])).rows[0];
      if(prior){if(prior.request_hash!==requestHash)throw new Error("IDEMPOTENCY_CONFLICT");return prior.id;}
      const reserved=await tx.query("UPDATE workspace.budgets SET reserved_amount=reserved_amount+$2::numeric WHERE project_id=$1 AND limit_amount-spent_amount-reserved_amount >= $2::numeric RETURNING project_id",[projectId,amount]);
      if(!reserved.rows.length)throw new Error("BUDGET_EXCEEDED");
      const runId=randomUUID(),snapshotId=randomUUID();
      await tx.query("INSERT INTO workspace.run_snapshots VALUES($1,$2,$3,$4)",[projectId,snapshotId,JSON.stringify(snapshot),contentHash(snapshot)]);
      await tx.query("INSERT INTO workspace.runs(project_id,id,snapshot_id,state,idempotency_key,request_hash,reserved_amount) VALUES($1,$2,$3,'queued',$4,$5,$6)",[projectId,runId,snapshotId,key,requestHash,amount]);
      await tx.query("INSERT INTO workspace.outbox(project_id,id,run_id,event_type,payload) VALUES($1,$2,$3,'run.created',$4)",[projectId,randomUUID(),runId,JSON.stringify({runId})]);
      return runId;
    });
  }
}
