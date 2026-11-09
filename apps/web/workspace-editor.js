// Adapted from the audited canvas/history.ts: bounded command history rather
// than whole-canvas snapshots, so background outputs are never rolled back.
export const editValue=object=>{if(!object)return null;const value=structuredClone(object);delete value.revision;return value;};
export const sameEdit=(a,b)=>JSON.stringify(editValue(a))===JSON.stringify(editValue(b));
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
