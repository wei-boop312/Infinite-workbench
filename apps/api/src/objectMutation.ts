import type {WorkspaceObject} from '@canvas/contracts';
/** Used by both the legacy and atomic write ports. Unlock must be a separate
 * revision before geometry/deletion/group membership can change. */
export function validateObjectMutation(previous:WorkspaceObject|undefined,next:WorkspaceObject){
  if(!previous)return;
  if(previous.type!==next.type)throw Error('OBJECT_IDENTITY_CONFLICT');
  if(previous.type==='task'&&next.type==='task'&&previous.runId.toLowerCase()!==next.runId.toLowerCase())throw Error('OBJECT_IDENTITY_CONFLICT');
  if(previous.locked&&(['x','y','width','height'] as const).some(key=>previous[key]!==next[key]))throw Error('OBJECT_LOCKED');
  if(previous.locked&&((previous.deleted??false)!==(next.deleted??false)||(previous.groupId??null)!==(next.groupId??null)))throw Error('OBJECT_LOCKED');
}
