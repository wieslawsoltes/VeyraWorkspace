import {clone} from './model.js';
/** Revision-checked, serialized saves with a device-local recovery draft. Not a CRDT. */
export class DocumentSession extends EventTarget {
  constructor(provider,roomId,kind){super();this.provider=provider;this.roomId=roomId;this.kind=kind;this.dirty=false;this.conflict=false;this.version=0;this.abort=new AbortController();this.key=`veyra.recovery.${provider.kind}.${provider.me.id}.${roomId}.${kind}`;}
  notify(message=''){this.message=message;this.dispatchEvent(new Event('status'));}
  async load(){
    const data=await this.provider.getDoc(this.roomId,this.kind);this.version=data.version;this.value=this.kind==='notes'?{text:data.text||''}:{shapes:data.shapes||[]};
    try{const saved=JSON.parse(localStorage.getItem(this.key)||'null');if(saved){this.value=saved.value;this.dirty=true;this.conflict=saved.version!==this.version;}}catch{}
    this.provider.addEventListener('change',e=>this.remote(e.detail),{signal:this.abort.signal});
    if(this.dirty&&!this.conflict)this.schedule();return this;
  }
  update(value){this.value=clone(value);this.dirty=true;this.recover();this.notify();this.schedule();}
  recover(){try{localStorage.setItem(this.key,JSON.stringify({value:this.value,version:this.version}));}catch{this.notify('Recovery storage is full. Export your draft.');}}
  schedule(){clearTimeout(this.timer);if(!this.conflict&&!this.closed)this.timer=setTimeout(()=>this.flush().catch(()=>{}),900);}
  async flush(){
    clearTimeout(this.timer);if(this.saving){await this.saving;return this.flush();}
    if(!this.dirty||this.conflict||this.closed)return;
    const value=clone(this.value);this.dirty=false;
    this.saving=this.provider.saveDoc(this.roomId,this.kind,value,this.version);
    this.notify('Saving…');
    try{const saved=await this.saving;this.version=saved.version;if(this.dirty)this.recover();else localStorage.removeItem(this.key);this.notify();}
    catch(e){this.dirty=true;this.conflict=e.status===409;this.recover();this.notify(e.message);throw e;}
    finally{this.saving=null;this.notify(this.message==='Saving…'?'':this.message);if(this.dirty&&!this.conflict&&!this.closed)this.schedule();}
  }
  async remote(change){
    if(this.closed||change.type!=='doc'||change.roomId!==this.roomId||change.kind!==this.kind||change.version<=this.version)return;
    if(change.source===this.provider.peerId||this.saving&&change.version===this.version+1)return;
    if(this.dirty||this.saving){this.conflict=true;clearTimeout(this.timer);this.notify('A newer revision exists. Export this draft or reload.');return;}
    try{const data=await this.provider.getDoc(this.roomId,this.kind);if(this.closed||this.dirty||this.saving)return;this.version=data.version;this.value=this.kind==='notes'?{text:data.text||''}:{shapes:data.shapes||[]};this.dispatchEvent(new Event('remote'));this.notify();}catch(e){this.notify(e.message);}
  }
  async reload(){clearTimeout(this.timer);if(this.saving)await this.saving.catch(()=>{});const data=await this.provider.getDoc(this.roomId,this.kind);this.version=data.version;this.value=this.kind==='notes'?{text:data.text||''}:{shapes:data.shapes||[]};this.dirty=false;this.conflict=false;localStorage.removeItem(this.key);this.dispatchEvent(new Event('remote'));this.notify();}
  async close(){clearTimeout(this.timer);await this.flush().catch(()=>{});this.closed=true;clearTimeout(this.timer);this.abort.abort();}
}
