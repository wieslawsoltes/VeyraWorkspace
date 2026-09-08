import { createSample } from './seed.js';
import { uid, error, validText, identifier, validateMessage, toggleReaction, normalizeEvent, validateDocument, messageFingerprint, MAX_FILE_SIZE } from './model.js';

/** Transactions resolve only on commit, never merely on the last request's success. */
class Database {
  async open(name) {
    this.db=await new Promise((resolve,reject)=>{
      const r=indexedDB.open(name,1);
      r.onupgradeneeded=()=>{
        for(const key of ['users','rooms','messages','events','docs','files','meta']){
          const store=r.result.createObjectStore(key,{keyPath:'id'});
          if(key==='messages'||key==='files')store.createIndex('roomId','roomId');
        }
      };
      r.onerror=()=>reject(r.error);r.onsuccess=()=>resolve(r.result);
      r.onblocked=()=>reject(error('Close older Veyra tabs to upgrade browser storage.',409));
    });
    this.db.onversionchange=()=>this.db.close();return this;
  }
  transaction(stores,mode,callback) {
    return new Promise((resolve,reject)=>{
      const tx=this.db.transaction(stores,mode);let result,thrown;
      tx.oncomplete=()=>resolve(typeof result==='function'?result():result);
      tx.onerror=()=>reject(thrown||tx.error);tx.onabort=()=>reject(thrown||tx.error||error('Storage transaction aborted.'));
      const abort=e=>{thrown=e;tx.abort();};
      try{result=callback(tx,abort);}catch(e){abort(e);}
    });
  }
  get(store,id){return this.transaction([store],'readonly',tx=>{const r=tx.objectStore(store).get(id);return()=>r.result;});}
  all(store,roomId=null){return this.transaction([store],'readonly',tx=>{const s=tx.objectStore(store),r=roomId?s.index('roomId').getAll(roomId):s.getAll();return()=>r.result;});}
  put(store,value){return this.transaction([store],'readwrite',tx=>{tx.objectStore(store).put(value);return value;});}
  remove(store,id){return this.transaction([store],'readwrite',tx=>{tx.objectStore(store).delete(id);});}
  change(store,id,mutate){return this.transaction([store],'readwrite',(tx,abort)=>{
    const s=tx.objectStore(store),r=s.get(id);let result;
    r.onsuccess=()=>{try{result=mutate(r.result);if(result)s.put(result);}catch(e){abort(e);}};
    return()=>result;
  });}
}

export class LocalProvider extends EventTarget {
  kind='local'; name='Local workspace'; capabilities={files:true,notes:true,board:true,calls:true,createRoom:true};
  async init(){
    this.db=await new Database().open('veyra.workspace.v1');
    const stores=['meta','users','rooms','messages','events','docs','files'];
    await this.db.transaction(stores,'readwrite',(tx,abort)=>{
      const r=tx.objectStore('meta').get('initialized');
      r.onsuccess=()=>{try{if(r.result)return;for(const [store,records]of Object.entries(createSample()))for(const record of records)tx.objectStore(store).put(record);tx.objectStore('meta').put({id:'initialized',value:true});}catch(e){abort(e);}};
    });
    this.me=await this.db.get('users','local-me');this.peerId=uid();
    this.channel=typeof BroadcastChannel!=='undefined'?new BroadcastChannel('veyra.workspace.v1'):null;
    this.channel?.addEventListener('message',event=>this.emit(event.data,false));return this;
  }
  emit(detail,broadcast=true){this.dispatchEvent(new CustomEvent('change',{detail}));if(broadcast)this.channel?.postMessage(detail);}
  async bootstrap(){return{me:this.me,rooms:await this.db.all('rooms'),users:await this.db.all('users'),events:await this.db.all('events')};}
  async messages(roomId){return(await this.db.all('messages',roomId)).sort((a,b)=>a.createdAt.localeCompare(b.createdAt)||a.id.localeCompare(b.id));}
  async send(input){
    const clean=validateMessage(input),fingerprint=messageFingerprint(clean);
    if(!await this.db.get('rooms',clean.roomId))throw error('Conversation not found.',404);
    const message={...clean,authorId:this.me.id,authorName:this.me.name,createdAt:new Date().toISOString(),reactions:[],fingerprint};
    const saved=await this.db.change('messages',clean.id,existing=>{
      if(existing){if(existing.authorId!==this.me.id||existing.fingerprint!==fingerprint)throw error('This identifier belongs to another message.',409);return existing;}
      return message;
    });
    this.emit({type:'message',message:saved});return saved;
  }
  async edit(id,content){
    content=validText(content,'Message');
    const message=await this.db.change('messages',id,old=>{if(!old||old.deleted)throw error('Message not found.',404);if(old.authorId!==this.me.id)throw error('Only the author can edit this message.',403);return{...old,content,editedAt:new Date().toISOString()};});
    this.emit({type:'message',message});return message;
  }
  async deleteMessage(id){
    const message=await this.db.change('messages',id,old=>{if(!old)throw error('Message not found.',404);if(old.authorId!==this.me.id)throw error('Only the author can delete this message.',403);return{...old,content:'',deleted:true,attachments:[],reactions:[]};});
    this.emit({type:'message',message});return message;
  }
  async react(id,emoji){const message=await this.db.change('messages',id,old=>toggleReaction(old,emoji,this.me.id));this.emit({type:'message',message});return message;}
  async createRoom(name,type='group',members=[]){
    if(!['group','direct','channel'].includes(type))throw error('Invalid conversation type.');
    const room={id:uid(),name:validText(name,'Conversation name',100),type,members:[...new Set([this.me.id,...members])],color:'#e7dff7',unread:0};
    if(type==='channel')room.teamName='Veyra Studio';await this.db.put('rooms',room);this.emit({type:'room',room});return room;
  }
  async updateRoom(id,patch){const room=await this.db.change('rooms',id,old=>{if(!old)throw error('Conversation not found.',404);return{...old,...(typeof patch.favorite==='boolean'?{favorite:patch.favorite}:{})};});this.emit({type:'room',room});return room;}
  async upload(file,roomId){
    if(file.size>MAX_FILE_SIZE)throw error('Files are limited to 10 MB.',413);
    const record={id:uid(),roomId,ownerId:this.me.id,name:validText(file.name,'Filename',240),type:file.type,size:file.size,blob:file,createdAt:new Date().toISOString(),authorName:this.me.name};
    await this.db.put('files',record);const {blob,...metadata}=record;this.emit({type:'files',roomId});return metadata;
  }
  async files(roomId=null){return(await this.db.all('files',roomId)).map(({blob,...file})=>file);}
  async download(file){const record=await this.db.get('files',file.id);if(!record)throw error('The file is not stored on this device.',404);return record.blob;}
  async getDoc(roomId,kind){return await this.db.get('docs',`${roomId}:${kind}`)||{id:`${roomId}:${kind}`,text:'',shapes:[],version:0};}
  async saveDoc(roomId,kind,value,version){
    const clean=validateDocument(kind,{...value,version}),id=`${roomId}:${kind}`;
    const doc=await this.db.change('docs',id,old=>{
      if((old?.version||0)!==version)throw error('The shared document changed. Export your draft before reloading.',409);
      return{...clean,id,version:version+1};
    });
    this.emit({type:'doc',roomId,kind,version:doc.version,source:this.peerId});return doc;
  }
  async saveEvent(input){const event=normalizeEvent(input);await this.db.put('events',event);this.emit({type:'event',event});return event;}
  async deleteEvent(id){await this.db.remove('events',id);this.emit({type:'event-deleted',id});}
  async setProfile(patch){
    const status=patch.status||this.me.status;if(!['available','busy','away','offline'].includes(status))throw error('Invalid profile status.');
    this.me={...this.me,status,name:patch.name===undefined?this.me.name:validText(patch.name,'Name',80)};await this.db.put('users',this.me);this.emit({type:'profile',user:this.me});return this.me;
  }
  typing(roomId){this.emit({type:'typing',roomId,userId:this.me.id,name:this.me.name,peerId:this.peerId});}
  async signal(type,payload){this.emit({...payload,type,peerId:this.peerId,userId:this.me.id,name:this.me.name});return{peers:[]};}
  async export(){const data={schemaVersion:1,exportedAt:new Date().toISOString()};for(const store of ['users','rooms','messages','events','docs'])data[store]=await this.db.all(store);data.files=await this.files();return data;}
  dispose(){this.channel?.close();this.db.db.close();}
}

export class ServerProvider extends EventTarget {
  kind='server';name='Live workspace';capabilities={files:true,notes:true,board:true,calls:true,createRoom:true};
  constructor(){super();this.peerId=uid();this.streamReady=false;}
  async request(path,options={}){
    const response=await fetch('./api'+path,{credentials:'same-origin',...options,headers:{...(options.body&&!(options.body instanceof Blob)?{'Content-Type':'application/json'}:{}),...options.headers},signal:options.signal||AbortSignal.timeout(30000)});
    let data;if(response.status!==204){try{data=await response.json();}catch{throw error('This origin is not running the included Veyra server.',503);}}
    if(!response.ok)throw Object.assign(error(data?.error||`Request failed (${response.status}).`,response.status),{retryAfter:response.headers.get('Retry-After')});
    return data;
  }
  async init(){const data=await this.bootstrap();this.me=data.me;return this;}
  async authenticate(mode,data){await this.request(`/auth/${mode}`,{method:'POST',body:JSON.stringify(data)});return this.init();}
  bootstrap(){return this.request('/bootstrap');}
  connect(){
    this.stream?.close();this.streamReady=false;
    this.stream=new EventSource(`./api/stream?peerId=${encodeURIComponent(this.peerId)}`);
    this.stream.onmessage=event=>{let detail;try{detail=JSON.parse(event.data);}catch{return;}if(detail.type==='ready'){this.streamReady=true;this.dispatchEvent(new CustomEvent('change',{detail:{type:'connection',connected:true}}));}this.dispatchEvent(new CustomEvent('change',{detail}));};
    this.stream.onerror=()=>{this.streamReady=false;this.dispatchEvent(new CustomEvent('change',{detail:{type:'connection',connected:false}}));};
  }
  async ready(){const end=Date.now()+10000;while(!this.streamReady){if(this.disposed||Date.now()>end)throw error('The live connection is not ready. Try reconnecting.',503);await new Promise(r=>setTimeout(r,40));}}
  messages(roomId){return this.request(`/rooms/${encodeURIComponent(roomId)}/messages`);}
  send(input){return this.request('/messages',{method:'POST',body:JSON.stringify(validateMessage(input))});}
  edit(id,content){return this.request(`/messages/${encodeURIComponent(id)}`,{method:'PATCH',body:JSON.stringify({content})});}
  deleteMessage(id){return this.request(`/messages/${encodeURIComponent(id)}`,{method:'DELETE'});}
  react(id,emoji){return this.request(`/messages/${encodeURIComponent(id)}/reactions`,{method:'POST',body:JSON.stringify({emoji})});}
  createRoom(name,type='group',members=[]){return this.request('/rooms',{method:'POST',body:JSON.stringify({name,type,members})});}
  updateRoom(id,patch){return this.request(`/rooms/${encodeURIComponent(id)}`,{method:'PATCH',body:JSON.stringify(patch)});}
  upload(file,roomId){if(file.size>MAX_FILE_SIZE)throw error('Files are limited to 10 MB.',413);return this.request(`/files?roomId=${encodeURIComponent(roomId)}`,{method:'POST',headers:{'Content-Type':'application/octet-stream','X-File-Name':encodeURIComponent(file.name),'X-File-Type':file.type},body:file});}
  files(roomId=null){return this.request(`/files${roomId?'?roomId='+encodeURIComponent(roomId):''}`);}
  async download(file){const response=await fetch(`./api/files/${encodeURIComponent(file.id)}`,{credentials:'same-origin',signal:AbortSignal.timeout(30000)});if(!response.ok)throw error('File is not available.',response.status);return response.blob();}
  getDoc(roomId,kind){return this.request(`/rooms/${encodeURIComponent(roomId)}/docs/${kind}`);}
  saveDoc(roomId,kind,value,version){return this.request(`/rooms/${encodeURIComponent(roomId)}/docs/${kind}`,{method:'PUT',body:JSON.stringify({...value,version})});}
  saveEvent(input){return this.request('/events',{method:'POST',body:JSON.stringify(normalizeEvent(input))});}
  deleteEvent(id){return this.request(`/events/${encodeURIComponent(id)}`,{method:'DELETE'});}
  async setProfile(patch){this.me=await this.request('/profile',{method:'PATCH',body:JSON.stringify(patch)});return this.me;}
  typing(roomId){this.signal('typing',{roomId}).catch(()=>{});}
  async signal(type,payload){await this.ready();return this.request('/signal',{method:'POST',body:JSON.stringify({...payload,type,peerId:this.peerId})});}
  export(){return this.request('/export');}
  async logout(){await this.request('/auth/logout',{method:'POST',body:'{}'});this.dispose();}
  dispose(){this.disposed=true;this.streamReady=false;this.stream?.close();}
}
