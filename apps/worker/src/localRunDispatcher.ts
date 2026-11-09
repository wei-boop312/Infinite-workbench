import type {LocalWorkspaceDatabase} from '../../api/src/localWorkspaceDatabase.ts';
import type {LocalResizeWorker} from './localResizeWorker.ts';

/** Serial local adapter; durable outbox/claim, no retry of submitted attempts. */
export class LocalRunDispatcher {
  private timer:ReturnType<typeof setInterval>|undefined;private active:Promise<void>|undefined;private stopped=false;
  private observed=new Set<string>();
  constructor(private db:LocalWorkspaceDatabase,private worker:()=>LocalResizeWorker,private onError:(error:unknown,runId:string)=>void,
    private recover?:(actorId:string,projectId:string,runId:string)=>Promise<unknown>){}
  start(){if(this.timer)throw Error('DISPATCHER_ALREADY_STARTED');this.timer=setInterval(()=>this.wake(),2000);this.wake();}
  wake(){
    if(this.stopped||this.active)return;
    this.active=this.drain().catch(error=>this.onError(error,'inventory')).finally(()=>{this.active=undefined;});
  }
  private async drain(){
    if(this.recover)for(const row of await this.db.expiredLocalAttempts()){
      if(this.stopped)return;try{await this.recover(row.actor_id,row.project_id,row.run_id);}catch(error){this.onError(error,row.run_id);}
    }
    for(const row of await this.db.pendingLocalRuns()){
      if(this.stopped)return;if(this.observed.has(row.run_id))continue;this.observed.add(row.run_id);
      try{await this.worker().execute(row.actor_id,row.project_id,row.run_id);}catch(error){this.onError(error,row.run_id);}
    }
  }
  async close(){this.stopped=true;if(this.timer)clearInterval(this.timer);await this.active;}
}
