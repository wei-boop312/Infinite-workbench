import {once} from 'node:events';
import type {ServerResponse} from 'node:http';
import type {LocalWorkspaceDatabase} from './localWorkspaceDatabase.ts';
import type {LocalRunQueries} from './localRunQueries.ts';

/** Permission-checked, bounded SSE replay. Tokens stay inside the server. */
export function openLocalRunEventStream(response:ServerResponse,options:{db:LocalWorkspaceDatabase;queries:LocalRunQueries;sessionToken:string;actorId:string;projectId:string;runId:string;afterSequence:number;onStop:()=>void}){
  let stopped=false,sequence=options.afterSequence,timer:ReturnType<typeof setTimeout>|undefined,lastHeartbeat=Date.now();
  const abort=new AbortController();
  const stop=()=>{if(stopped)return;stopped=true;if(timer)clearTimeout(timer);abort.abort();options.onStop();if(!response.writableEnded&&!response.destroyed)response.end();};
  response.once('close',stop);
  response.on('error',stop);
  response.writeHead(200,{'content-type':'text/event-stream; charset=utf-8','cache-control':'no-store, no-transform','connection':'keep-alive','x-content-type-options':'nosniff'});
  response.flushHeaders();
  async function authorize(){
    const user=await options.db.authenticate(options.sessionToken);if(user.id!==options.actorId)throw Error('UNAUTHENTICATED');
    if(!(await options.db.asActor(user.id,tx=>tx.query('SELECT id FROM workspace.projects WHERE id=$1 AND deleted_at IS NULL',[options.projectId]))).rows.length)throw Error('NOT_FOUND');
  }
  async function write(frame:string){
    if(stopped||response.destroyed)throw Error('STREAM_CLOSED');
    if(!response.write(frame))await once(response,'drain',{signal:abort.signal});
  }
  async function pump(){
    if(stopped)return;
    try{
      await authorize();const page=await options.queries.events(options.actorId,options.projectId,options.runId,sequence);
      for(const event of page.items){
        // Recheck after a potentially backpressured frame, not just at connect.
        await authorize();await write(`id: ${event.sequence}\nevent: run_event\ndata: ${JSON.stringify(event)}\n\n`);sequence=event.sequence;
      }
      if(Date.now()-lastHeartbeat>=10_000){await write(': heartbeat\n\n');lastHeartbeat=Date.now();}
      if(!stopped)timer=setTimeout(()=>{void pump();},page.hasMore?0:1000);
    }catch(error){
      if(!stopped&&!response.destroyed){const denied=['UNAUTHENTICATED','NOT_FOUND'].includes((error as Error).message);response.write(`event: ${denied?'access_revoked':'stream_error'}\ndata: ${JSON.stringify({code:denied?'ACCESS_REVOKED':'EVENT_STREAM_FAILED'})}\n\n`);}
      stop();
    }
  }
  void pump();return stop;
}
