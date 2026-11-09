// Adapted from the audited canvas/history.ts: bounded command history rather
// than whole-canvas snapshots, so background outputs are never rolled back.
export const editValue=object=>{if(!object)return null;const value=structuredClone(object);delete value.revision;return value;};
const editKey=object=>{const value=editValue(object);return value?JSON.stringify(Object.keys(value).sort().map(key=>[key,value[key]])):null;};
export const sameEdit=(a,b)=>editKey(a)===editKey(b);
export function expandedSelection(objects,ids){const visible=objects.filter(object=>!object.deleted),chosen=new Set(ids),groups=new Set(visible.filter(object=>chosen.has(object.id)&&object.groupId).map(object=>object.groupId));return new Set(visible.filter(object=>chosen.has(object.id)||groups.has(object.groupId)).map(object=>object.id));}
export function selectionBounds(objects){if(!objects.length)return null;const x=Math.min(...objects.map(o=>o.x)),y=Math.min(...objects.map(o=>o.y));return {x,y,width:Math.max(...objects.map(o=>o.x+o.width))-x,height:Math.max(...objects.map(o=>o.y+Math.max(o.type==='tool'?510:0,o.height)))-y};}
export function boxSelection(objects,rectangle){const x=Math.min(rectangle.x,rectangle.x+rectangle.width),y=Math.min(rectangle.y,rectangle.y+rectangle.height),right=Math.max(rectangle.x,rectangle.x+rectangle.width),bottom=Math.max(rectangle.y,rectangle.y+rectangle.height);return expandedSelection(objects,objects.filter(o=>!o.deleted&&o.x<=right&&o.x+o.width>=x&&o.y<=bottom&&o.y+Math.max(o.type==='tool'?510:0,o.height)>=y).map(o=>o.id));}
export function translatedSelection(objects,ids,dx,dy){if(!Number.isFinite(dx)||!Number.isFinite(dy))throw Error('INVALID_GEOMETRY');const selected=objects.filter(o=>!o.deleted&&ids.has(o.id));if(selected.some(o=>o.locked))throw Error('OBJECT_LOCKED');return selected.map(o=>({...o,x:o.x+dx,y:o.y+dy}));}
export function copiedSelection(objects,ids,newId){const groups=new Map();return objects.filter(o=>!o.deleted&&ids.has(o.id)).map(object=>{const next={...structuredClone(object),id:newId(),revision:0,x:object.x+32,y:object.y+32,locked:false,title:('副本 · '+(object.title??'卡片')).slice(0,240)};if(object.groupId){if(!groups.has(object.groupId))groups.set(object.groupId,newId());next.groupId=groups.get(object.groupId);}return next;});}
export class BoundedEditHistory {
  constructor(){this.past=[];this.future=[];}
  clear(){this.past=[];this.future=[];}
  record(changes){
    const meaningful=changes.filter(change=>!sameEdit(change.before,change.after)).map(change=>({before:editValue(change.before),after:editValue(change.after)}));
    if(!meaningful.length)return;
    this.past=[...this.past,meaningful].slice(-20);this.future=[];
  }
  peek(direction){return structuredClone((direction==='undo'?this.past.at(-1):this.future[0])??null);}
  values(direction){const changes=this.peek(direction);return changes?.map(change=>{const value=direction==='undo'?change.before:change.after;return value??{...(change.after??change.before),deleted:true};})??[];}
  accept(direction){if(direction==='undo'){const item=this.past.pop();if(item)this.future.unshift(item);}else{const item=this.future.shift();if(item)this.past=[...this.past,item].slice(-20);}}
}
