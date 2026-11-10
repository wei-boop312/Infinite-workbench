import {contentHash} from './workspacePrototype.ts';
export type OwnedCancellationReceipt={scope:'owned-cpu-resize-single-run';providerRequestId:string;ownedProcessStopped:true;history:unknown};
/** A request to cancel is not proof of cancellation. Bind the interruption to
 * the exact saved graph and require no output plus an owned-process stop. */
export function isInterruptedWithoutOutput(history:unknown,providerRequestId:string,prompt:unknown):boolean{
  const h=history as Record<string,any>;
  return !!h&&Array.isArray(h.prompt)&&h.prompt[1]===providerRequestId&&!!h.prompt[2]&&!!prompt&&
    contentHash(h.prompt[2])===contentHash(prompt)&&h.status?.status_str==='error'&&Array.isArray(h.status.messages)&&
    h.status.messages.some((message:unknown)=>Array.isArray(message)&&message[0]==='execution_interrupted'&&message[1]?.prompt_id===providerRequestId)&&
    !!h.outputs&&typeof h.outputs==='object'&&!Array.isArray(h.outputs)&&Object.keys(h.outputs).length===0;
}
