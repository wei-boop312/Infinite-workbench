const node=(tag,text)=>{const element=document.createElement(tag);if(text!==undefined)element.textContent=text;return element;};
const editable=fact=>Object.fromEntries(['id','name','value','unit','userConfirmed','excluded'].map(key=>[key,fact[key]]));
const definitive=new Set(['FACT_CONFLICT_UNRESOLVED','FACT_UNKNOWN_UNCONFIRMABLE','FACT_IDENTITY_CONFLICT','FACT_REVISION_CONFLICT','FACT_INTEGRITY_FAILED','LEASE_CONFLICT','ACCESS_DENIED','NOT_FOUND','INVALID_INPUT','INVALID_BODY','BODY_TOO_LARGE']);
const messages={FACT_CONFLICT_UNRESOLVED:'同名字段有不同值，请先排除冲突候选，再确认保留项。',FACT_UNKNOWN_UNCONFIRMABLE:'未知值不能确认，请核对原件后填写明确值。',FACT_REVISION_CONFLICT:'服务器已有新版本。请下载未保存内容，再明确读取最新版本。',LEASE_CONFLICT:'编辑租约已失效。请先下载未保存内容，再关闭并重开项目。',ACCESS_DENIED:'当前没有编辑权限。'};

export class DocumentFactsPanel {
  constructor({api,context,flushEdits}){
    this.api=api;this.context=context;this.flushEdits=flushEdits;this.generation=0;this.dirty=false;this.busy=false;
    this.dialog=node('dialog');this.dialog.id='facts-dialog';this.dialog.setAttribute('aria-labelledby','facts-title');const header=node('header'),title=node('h2','资料事实');title.id='facts-title';title.style.cssText='font-size:18px;margin:0';this.close=node('button','关闭');this.close.style.marginLeft='auto';header.append(title,this.close);
    const body=node('section');body.style.cssText='padding:20px;max-height:72vh;overflow:auto';body.append(node('p','本地规则只整理明确的“字段：值”，不是 AI 分析。请核对原文后逐条确认；修改字段会清除确认。'));
    this.meta=node('p');this.message=node('p');this.message.setAttribute('role','status');this.message.style.cssText='white-space:pre-wrap;color:#6b3345';this.controls=node('div');this.controls.className='history-actions';
    this.extract=node('button','整理候选（本地规则）');this.save=node('button','保存事实版本');this.retry=node('button','确认上次保存');this.download=node('button','下载未保存事实');this.latest=node('button','读取最新版本');this.discard=node('button','放弃编辑并关闭');
    this.version=node('input');this.version.type='number';this.version.min='1';this.version.setAttribute('aria-label','历史事实版本号');this.version.style.width='100px';this.history=node('button','查看历史版本');this.controls.append(this.extract,this.save,this.retry,this.download,this.latest,this.version,this.history,this.discard);
    this.list=node('div');this.list.setAttribute('aria-label','事实候选');body.append(this.meta,this.message,this.controls,this.list);this.dialog.append(header,body);document.body.append(this.dialog);
    this.close.onclick=()=>{if(this.busy)return;if(this.dirty&&!this.pending){this.message.textContent='还有未保存编辑。可先保存或下载，也可明确放弃编辑并关闭。';return;}this.dialog.close();};
    this.discard.onclick=()=>{if(this.busy||this.pending)return;this.dirty=false;this.dialog.close();};
    this.dialog.addEventListener('cancel',event=>{if(this.busy||this.dirty||this.pending){event.preventDefault();this.message.textContent='编辑或保存尚未完成，请使用上方保存、下载或关闭操作。';}});
    this.dialog.addEventListener('close',()=>{this.generation++;this.list.replaceChildren();this.document=null;this.edits=[];this.dirty=false;});
    this.extract.onclick=()=>this.submit({id:crypto.randomUUID(),action:'extract'});this.save.onclick=()=>this.submit({id:crypto.randomUUID(),action:'save',baseRevision:this.document.revision,facts:structuredClone(this.edits)});this.retry.onclick=()=>this.submit(this.pending);
    this.latest.onclick=async()=>{if(this.busy||this.pending)return;this.dirty=false;await this.load();};this.history.onclick=()=>{if(this.busy||this.pending||this.dirty){this.message.textContent='请先保存或下载未保存编辑，再查看历史。';return;}this.load(Number(this.version.value));};this.download.onclick=()=>this.exportDraft();
  }
  hasUnsaved(){return this.dialog.open&&(this.dirty||!!this.pending||this.busy);}
  active(generation=this.generation){return this.dialog.open&&generation===this.generation&&this.context().projectId===this.project;}
  cacheKey(){return `workspace.document-facts.pending.${this.project}.${this.assetId}`;}
  updateControls(){
    const historical=!!this.document&&this.document.revision!==this.currentRevision,blocked=this.busy||!!this.pending||!!this.cacheError,canEdit=this.canEdit&&!historical;
    this.extract.hidden=!!this.document;this.extract.disabled=blocked||!canEdit;this.save.hidden=!this.document||historical;this.save.disabled=blocked||!canEdit||!this.dirty;
    this.retry.hidden=!this.pending;this.retry.disabled=this.busy;this.download.hidden=!this.dirty&&!this.pending&&!this.cacheError;this.latest.disabled=this.busy||!!this.pending||!!this.cacheError;this.latest.textContent=this.dirty?'放弃未保存编辑并读取最新':'读取最新版本';
    this.discard.hidden=!this.dirty||!!this.pending||!!this.cacheError;this.close.disabled=this.busy;this.close.textContent=this.pending?'保留重试记录并关闭':'关闭';this.history.disabled=blocked||this.dirty||!this.document;this.version.disabled=this.history.disabled;
    for(const input of this.list.querySelectorAll('input'))input.disabled=blocked||!canEdit;
  }
  async open(project,assetId){
    if(this.dialog.open)return;this.project=project;this.assetId=assetId;this.currentRevision=0;this.document=null;this.edits=[];this.pending=null;this.cacheError=false;this.dirty=false;this.busy=false;this.canEdit=false;this.generation++;this.message.textContent='';this.meta.textContent='读取资料事实';this.list.replaceChildren();
    try{const raw=localStorage.getItem(this.cacheKey());if(raw){const value=JSON.parse(raw),keys=Object.keys(value).sort().join(',');if(!value||typeof value.id!=='string'||!['extract','save'].includes(value.action)||(value.action==='extract'?keys!=='action,id':keys!=='action,baseRevision,facts,id')||(value.action==='save'&&(!Number.isSafeInteger(value.baseRevision)||!Array.isArray(value.facts))))throw Error('INVALID_RECOVERY_RECORD');this.pending=value;}}
    catch{this.cacheError=true;this.message.textContent='本地恢复记录无法读取，已保留。请先下载恢复记录再处理。';}
    this.dialog.showModal();this.updateControls();await this.load();
  }
  async load(revision){
    const generation=this.generation;this.busy=true;this.updateControls();
    try{const result=await this.api(`/v1/projects/${this.project}/document-facts/${this.assetId}${revision===undefined?'':'?revision='+revision}`);if(!this.active(generation))return;this.currentRevision=result.currentRevision;this.document=result.document;this.canEdit=result.canEdit;this.edits=this.document?this.document.facts.map(editable):[];
      if(this.pending?.action==='save'){const saved=new Map(this.pending.facts.map(fact=>[fact.id,fact]));this.edits=this.edits.map(fact=>saved.get(fact.id)??fact);}
      this.render();if(this.pending)this.message.textContent=`上次保存结果尚未确认（${this.pending.action==='save'?'基准版本 '+this.pending.baseRevision:'首次整理'}）。请确认同一操作，不会自动重新提交。`;
    }catch(error){if(this.active(generation))this.message.textContent=error.message;}finally{if(this.active(generation)){this.busy=false;this.updateControls();}}
  }
  render(){
    this.list.replaceChildren();if(!this.document){this.meta.textContent='尚无事实版本。可先整理候选，再人工核对。';return;}
    const value=this.document;this.meta.textContent=`事实版本 ${value.revision} / 当前 ${this.currentRevision} · ${value.facts.length} 条候选 · ${value.facts.filter(f=>f.userConfirmed).length} 条已确认 · ${value.conflicts.length} 组冲突 · ${value.unparsedCount} 行未整理\n来源 SHA256：${value.sourceSha256}`;this.meta.style.whiteSpace='pre-wrap';this.version.value=String(value.revision);this.version.max=String(this.currentRevision);
    for(let index=0;index<value.facts.length;index++){
      const fact=value.facts[index],edit=this.edits[index],row=node('section');row.dataset.factId=fact.id;row.style.cssText='border:1px solid #dfe4ef;border-radius:10px;padding:14px;margin:14px 0';const provenance=node('p',`原文第 ${fact.source.line} 行 · ${fact.unknown?'未知值 · ':''}${fact.manuallyEdited?'经人工修改 · ':''}规则候选，置信度未估计`),quote=node('pre',fact.source.quote);quote.style.cssText='white-space:pre-wrap;overflow-wrap:anywhere;background:#f5f6fa;padding:10px';row.append(provenance,quote);
      const fields=node('div');fields.style.cssText='display:grid;grid-template-columns:1fr 2fr 100px;gap:12px';const confirmed=node('input'),excluded=node('input');confirmed.type=excluded.type='checkbox';confirmed.checked=edit.userConfirmed;excluded.checked=edit.excluded;
      for(const [key,label,max] of [['name','事实名称',80],['value','事实值',1000],['unit','单位',80]]){const wrapper=node('label',label),input=node('input');input.value=edit[key];input.maxLength=max;input.setAttribute('aria-label',label);input.oninput=()=>{edit[key]=input.value;edit.userConfirmed=false;confirmed.checked=false;this.dirty=true;this.message.textContent='字段已修改，请核对来源并重新确认。';this.updateControls();};wrapper.append(input);fields.append(wrapper);}row.append(fields);
      for(const [input,label] of [[confirmed,'确认事实'],[excluded,'排除候选']]){const wrapper=node('label',label);wrapper.style.cssText='display:inline-flex;gap:8px;margin-right:24px';input.style.width='auto';input.setAttribute('aria-label',label);wrapper.prepend(input);row.append(wrapper);}
      confirmed.onchange=()=>{edit.userConfirmed=confirmed.checked;if(confirmed.checked){edit.excluded=false;excluded.checked=false;}this.dirty=true;this.updateControls();};excluded.onchange=()=>{edit.excluded=excluded.checked;if(excluded.checked){edit.userConfirmed=false;confirmed.checked=false;}this.dirty=true;this.updateControls();};this.list.append(row);
    }
    if(value.unparsedCount){const detail=node('p','未整理行：'+value.unparsed.map(item=>`${item.line}（${({no_key_value:'无明确字段和值',line_too_long:'超出单行长度',candidate_limit:'候选上限'})[item.reason]}）`).join('、')+(value.unparsedCount>value.unparsed.length?'；其余行仍保留在原件中。':''));this.list.append(detail);}
  }
  async submit(intent){
    if(!intent||this.busy||this.cacheError)return;const generation=this.generation;this.busy=true;this.updateControls();
    try{await this.flushEdits();if(!this.active(generation))return;const context=this.context();if(context.blocked||!context.lease)throw Error('请先完成画布编辑并确认租约');const raw=JSON.stringify(intent);localStorage.setItem(this.cacheKey(),raw);if(localStorage.getItem(this.cacheKey())!==raw)throw Error('无法保存恢复记录，未提交');this.pending=structuredClone(intent);this.updateControls();
      const result=await this.api(`/v1/projects/${this.project}/document-facts/${this.assetId}`,'POST',{...intent,lease:{token:context.lease.token,fencing:context.lease.fencing}});if(!this.active(generation))return;localStorage.removeItem(this.cacheKey());this.pending=null;this.dirty=false;this.message.textContent=`已确认保存事实版本 ${result.revision}`;await this.load();
    }catch(error){if(this.active(generation)){if(this.pending&&definitive.has(error.message)){localStorage.removeItem(this.cacheKey());this.pending=null;this.dirty=intent.action==='save';}this.message.textContent=messages[error.message]||(this.pending?'保存结果未确认，可确认同一操作：':'未保存：')+error.message;}}
    finally{if(this.active(generation)){this.busy=false;this.updateControls();}}
  }
  exportDraft(){const data=this.cacheError?localStorage.getItem(this.cacheKey()):JSON.stringify({scope:'unsaved-facts-recovery-not-project-export',projectId:this.project,assetVersionId:this.assetId,baseRevision:this.document?.revision??0,facts:this.edits,pending:this.pending},null,2),url=URL.createObjectURL(new Blob([data??''],{type:'application/json'})),link=node('a');link.href=url;link.download='未保存资料事实.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
}
