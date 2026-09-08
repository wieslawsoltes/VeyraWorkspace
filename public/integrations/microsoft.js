import {uid,escapeHTML,safeURL,validateMessage,validText,MAX_FILE_SIZE} from '../core/model.js';
import {readConfig} from '../config.js';
const GRAPH='https://graph.microsoft.com/v1.0';
const CONSUMER_TENANT='9188040d-6c67-4c5b-b112-36a304b66dad';
const enc=encodeURIComponent;
const base64=value=>btoa(String.fromCharCode(...new TextEncoder().encode(String(value)))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function digest(value){return[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)))].map(v=>v.toString(16).padStart(2,'0')).join('');}
function bodyText(body){
  if(body?.contentType!=='html')return String(body?.content||'');
  const template=document.createElement('template');template.innerHTML=String(body.content||'');const doc=template.content;
  doc.querySelectorAll('script,style,iframe,object,img,video,audio,source,link').forEach(n=>n.remove());
  doc.querySelectorAll('br').forEach(n=>n.replaceWith('\n'));
  doc.querySelectorAll('p,div,li').forEach(n=>n.append('\n'));
  return doc.textContent.trim();
}
const reactionDisplay=value=>({like:'👍',heart:'❤️',laugh:'😆',surprised:'😮',sad:'😢',angry:'😠'}[value]||value);
/** Delegated Graph adapter. It never uses a private Teams endpoint or exports SDK token caches. */
export class MicrosoftProvider extends EventTarget {
  kind='microsoft';name='Microsoft 365';capabilities={files:true,notes:false,board:false,calls:false,createRoom:true};
  constructor(config=readConfig(),dependencies={}){
    super();this.config={...config,microsoftClientId:config.microsoftClientId||config.clientId||'',microsoftTenantId:config.microsoftTenantId||config.tenantId||'common'};this.fetch=dependencies.fetchImpl||globalThis.fetch.bind(globalThis);this.loadMsal=dependencies.loadMsal||(()=>config.useBundledSDKs?import('../vendor/msal.js'):import('https://esm.sh/@azure/msal-browser@4.26.1?bundle'));
    this.roomMap=new Map();this.messageMap=new Map();this.messageCache=new Map();this.eventMap=new Map();this.peerId=uid();this.disposed=false;
  }
  emit(detail){if(!this.disposed)this.dispatchEvent(new CustomEvent('change',{detail}));}
  async init(interactive=true){
    if(!/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(this.config.microsoftClientId||''))throw new Error('Configure a valid Microsoft Entra SPA application client ID in Settings.');
    const tenant=this.config.microsoftTenantId||'common';if(!/^(common|organizations|consumers|[\da-f-]{36}|[a-z0-9.-]+\.[a-z]{2,})$/i.test(tenant))throw new Error('Invalid Microsoft tenant.');
    const {PublicClientApplication}=await this.loadMsal();
    this.redirectUri=new URL('../auth.html',import.meta.url).href;
    this.msal=new PublicClientApplication({auth:{clientId:this.config.microsoftClientId,authority:`https://login.microsoftonline.com/${tenant}`,redirectUri:this.redirectUri,navigateToLoginRequestUrl:false},cache:{cacheLocation:'sessionStorage'},system:{loggerOptions:{piiLoggingEnabled:false}}});
    await this.msal.initialize();await this.msal.handleRedirectPromise();
    this.account=this.msal.getActiveAccount()||this.msal.getAllAccounts()[0];
    if(interactive)this.account=(await this.msal.loginPopup({scopes:['User.Read'],prompt:'select_account'})).account;
    if(!this.account)throw new Error('Microsoft sign-in is required. Open Settings to reconnect.');
    this.msal.setActiveAccount(this.account);this.personal=this.account.tenantId===CONSUMER_TENANT;
    const profile=await this.request('/me',['User.Read']);
    this.me={id:profile.id,name:profile.displayName||'Microsoft user',email:profile.mail||profile.userPrincipalName||'',status:'unknown',color:'#dce8e0'};
    if(!this.personal&&interactive)await this.token(['Chat.Read','Team.ReadBasic.All','Channel.ReadBasic.All'],true);
    this.connect();return this;
  }
  async token(scopes,interactive=false){
    try{return(await this.msal.acquireTokenSilent({scopes,account:this.account})).accessToken;}
    catch(cause){
      if(!interactive)throw Object.assign(new Error('Microsoft consent or a renewed sign-in is required. Reconnect in Settings.'),{cause,status:401});
      // Only explicit foreground actions may display an authentication window.
      return(await this.msal.acquireTokenPopup({scopes,account:this.account})).accessToken;
    }
  }
  async request(path,scopes,options={},interactive=false,attempt=0){
    const url=new URL(path.startsWith('https:')?path:GRAPH+path);
    if(url.origin!=='https://graph.microsoft.com'||!url.pathname.startsWith('/v1.0/')||url.username||url.password)throw new Error('Untrusted Graph URL rejected before acquiring a token.');
    const token=await this.token(scopes,interactive);
    const response=await this.fetch(url.href,{...options,headers:{...(/\/(calendarView|events)(\/|$)/.test(url.pathname)?{Prefer:'outlook.timezone="UTC"'}:{}),...options.headers,Authorization:`Bearer ${token}`,...(options.body&&!(options.body instanceof Blob)?{'Content-Type':'application/json'}:{})},signal:options.signal||AbortSignal.timeout(30000)});
    if([429,503].includes(response.status)&&(!options.method||options.method==='GET')&&attempt<3){
      const retry=response.headers.get('Retry-After'),seconds=retry===null?NaN:Number(retry);
      const wait=Number.isFinite(seconds)?seconds*1000:retry?+new Date(retry)-Date.now():1000*2**attempt;
      await sleep(Math.max(500,Math.min(30000,Number.isFinite(wait)?wait:1000))+Math.random()*200);
      return this.request(path,scopes,options,false,attempt+1);
    }
    if(response.status===204)return null;
    const data=await response.json().catch(()=>null);
    if(!response.ok)throw Object.assign(new Error(data?.error?.message||`Microsoft Graph returned HTTP ${response.status}.`),{status:response.status,code:data?.error?.code});
    return data;
  }
  async pages(path,scopes,{interactive=false,maxPages=20}={}){
    const values=[];let next=path;
    for(let page=0;next&&page<maxPages;page++){const data=await this.request(next,scopes,{},interactive);values.push(...data.value||[]);next=data['@odata.nextLink'];}
    if(next)this.emit({type:'notice',message:'Graph pagination reached this view’s safety limit. The export includes loaded records, not the entire tenant archive.'});
    return values;
  }
  favoriteKey(){return`veyra.microsoft.favorites.${this.me.id}`;}
  favorites(){try{return JSON.parse(localStorage.getItem(this.favoriteKey())||'{}');}catch{return{};}}
  async bootstrap(){
    if(this.personal){this.rooms=[];this.users=[this.me];return{me:this.me,rooms:[],users:this.users,events:[],notice:'Personal Microsoft sign-in is supported; Graph Teams chat APIs do not support consumer accounts.'};}
    const users=new Map([[this.me.id,this.me]]),rooms=[],favorites=this.favorites();
    const chats=await this.pages('/me/chats?$expand=members&$top=50',['Chat.Read']);
    for(const chat of chats){
      for(const member of chat.members||[])if(member.userId)users.set(member.userId,{id:member.userId,name:member.displayName||member.email||'Member',email:member.email||'',status:'unknown',color:'#e8dff2'});
      const id=`ms-${await digest(`chat:${chat.id}`)}`;
      const r={id,name:chat.topic||(chat.members||[]).filter(m=>m.userId!==this.me.id).map(m=>m.displayName||m.email).join(', ')||'Chat',type:chat.chatType==='oneOnOne'?'direct':'group',members:(chat.members||[]).map(m=>m.userId).filter(Boolean),color:'#e7dff7',favorite:!!favorites[id],graphChatId:chat.id,webUrl:safeURL(chat.webUrl)};
      rooms.push(r);this.roomMap.set(id,r);
    }
    try{
      const teams=await this.pages('/me/joinedTeams',['Team.ReadBasic.All']);
      for(const team of teams){
        const channels=await this.pages(`/teams/${enc(team.id)}/channels`,['Channel.ReadBasic.All']);
        for(const channel of channels){const id=`ms-${await digest(`channel:${team.id}:${channel.id}`)}`,r={id,name:channel.displayName,description:channel.description||'',type:'channel',teamName:team.displayName,members:[],favorite:!!favorites[id],color:'#e7dff7',graphTeamId:team.id,graphChannelId:channel.id,webUrl:safeURL(channel.webUrl)};rooms.push(r);this.roomMap.set(id,r);}
      }
    }catch(error){this.emit({type:'notice',message:`Chats connected; channel discovery was unavailable: ${error.message}`});}
    this.rooms=rooms;this.users=[...users.values()];return{me:this.me,rooms,users:this.users,events:this.events||[]};
  }
  messageBase(r){if(!r)throw new Error('Conversation not found.');return r.graphChatId?`/chats/${enc(r.graphChatId)}/messages`:`/teams/${enc(r.graphTeamId)}/channels/${enc(r.graphChannelId)}/messages`;}
  readScopes(r){return[r.graphChatId?'Chat.Read':'ChannelMessage.Read.All'];}
  writeScopes(r,send=false){return[r.graphChatId?(send?'ChatMessage.Send':'Chat.ReadWrite'):(send?'ChannelMessage.Send':'ChannelMessage.ReadWrite')];}
  messageId(r,id){return`${r.id}.${base64(id)}`;}
  normalizeMessage(m,r,root=null){
    const id=this.messageId(r,m.id),rootId=root||m.replyToId||null;
    const value={id,roomId:r.id,content:bodyText(m.body),authorId:m.from?.user?.id||m.from?.application?.id||'system',authorName:m.from?.user?.displayName||m.from?.application?.displayName||'System',createdAt:m.createdDateTime||new Date(0).toISOString(),editedAt:m.lastEditedDateTime||null,deleted:!!m.deletedDateTime,replyTo:rootId?this.messageId(r,rootId):null,attachments:(m.attachments||[]).filter(f=>safeURL(f.contentUrl)).map(f=>({id:f.id||uid(),name:f.name||'Microsoft attachment',url:safeURL(f.contentUrl),size:0,type:f.contentType||'reference'})),reactions:(m.reactions||[]).map(x=>({emoji:reactionDisplay(x.reactionType),userId:x.user?.user?.id||'',graphReactionType:x.reactionType}))};
    this.messageMap.set(id,{room:r,graphId:m.id,rootId,value});return value;
  }
  async messages(roomId,interactive=true){
    const r=this.roomMap.get(roomId);if(!r)throw new Error('Conversation not found.');if(interactive)this.activeRoom=roomId;
    const raw=await this.pages(`${this.messageBase(r)}?$top=50${r.graphChannelId?'&$expand=replies':''}`,this.readScopes(r),{interactive,maxPages:10});
    const values=[];
    for(const m of raw){values.push(this.normalizeMessage(m,r));for(const reply of m.replies||[])values.push(this.normalizeMessage(reply,r,m.id));
      if(m['replies@odata.nextLink'])for(const reply of await this.pages(m['replies@odata.nextLink'],this.readScopes(r),{interactive:false,maxPages:5}))values.push(this.normalizeMessage(reply,r,m.id));}
    values.sort((a,b)=>a.createdAt.localeCompare(b.createdAt)||a.id.localeCompare(b.id));this.messageCache.set(roomId,values);return values;
  }
  watch(roomId){this.activeRoom=roomId;}
  connect(){clearInterval(this.poll);this.poll=setInterval(async()=>{if(document.hidden||this.polling||!this.activeRoom||this.disposed)return;this.polling=true;const roomId=this.activeRoom;try{const previous=new Map((this.messageCache.get(roomId)||[]).map(m=>[m.id,JSON.stringify(m)]));const messages=await this.messages(roomId,false);if(roomId===this.activeRoom){for(const message of messages)if(previous.get(message.id)!==JSON.stringify(message))this.emit({type:'message',message});this.emit({type:'connection',connected:true});}}catch(error){this.emit({type:'connection',connected:false,message:error.message});}finally{this.polling=false;}},Math.max(10000,this.config.graphPollMilliseconds||15000));}
  locate(id){const found=this.messageMap.get(id);if(!found)throw new Error('Reload the conversation before changing this message.');return{...found,path:this.messageBase(found.room)+(found.rootId&&found.room.graphChannelId?`/${enc(found.rootId)}/replies`:'')+`/${enc(found.graphId)}`};}
  async send(input){
    const m=validateMessage(input),r=this.roomMap.get(m.roomId);if(!r)throw new Error('Conversation not found.');
    let prefix='',path=this.messageBase(r);
    if(m.replyTo){const parent=this.locate(m.replyTo);if(parent.room.id!==r.id)throw new Error('Replies must stay within the conversation.');if(r.graphChannelId)path+=`/${enc(parent.rootId||parent.graphId)}/replies`;else prefix=`<blockquote>${escapeHTML(parent.value.authorName)}: ${escapeHTML(parent.value.content.slice(0,500))}</blockquote>`;}
    const attachments=m.attachments.map(f=>{const url=safeURL(f.url);if(!url||new URL(url).protocol!=='https:')throw new Error('Microsoft attachments require an HTTPS OneDrive or SharePoint reference.');return{id:f.id,contentType:'reference',contentUrl:url,name:f.name};});
    const content=prefix+escapeHTML(m.content).replace(/\n/g,'<br>')+attachments.map(f=>`<attachment id="${escapeHTML(f.id)}"></attachment>`).join('');
    const raw=await this.request(path,this.writeScopes(r,true),{method:'POST',body:JSON.stringify({body:{contentType:'html',content},...(attachments.length?{attachments}:{})})},true);
    const value=this.normalizeMessage(raw,r);this.emit({type:'message',message:value});return value;
  }
  async edit(id,content){const found=this.locate(id);if(found.value.authorId!==this.me.id)throw new Error('Only your own messages can be edited.');content=validText(content,'Message');await this.request(found.path,this.writeScopes(found.room),{method:'PATCH',body:JSON.stringify({body:{contentType:'html',content:escapeHTML(content).replace(/\n/g,'<br>')}})},true);const value={...found.value,content,editedAt:new Date().toISOString()};this.messageMap.get(id).value=value;this.emit({type:'message',message:value});return value;}
  async deleteMessage(id){const found=this.locate(id);if(found.value.authorId!==this.me.id)throw new Error('Only your own messages can be deleted.');await this.request(found.path+'/softDelete',this.writeScopes(found.room),{method:'POST'},true);const value={...found.value,deleted:true,content:'',attachments:[],reactions:[]};this.messageMap.get(id).value=value;this.emit({type:'message',message:value});return value;}
  async react(id,emoji){const found=this.locate(id),existing=found.value.reactions.find(x=>x.userId===this.me.id&&x.emoji===emoji);await this.request(`${found.path}/${existing?'unsetReaction':'setReaction'}`,this.writeScopes(found.room),{method:'POST',body:JSON.stringify({reactionType:existing?.graphReactionType||emoji})},true);const raw=await this.request(found.path,this.readScopes(found.room));const value=this.normalizeMessage(raw,found.room,found.rootId);this.emit({type:'message',message:value});return value;}
  async createRoom(name,type,members){
    if(type==='channel')throw new Error('Create Microsoft channels using the organization’s Teams administration workflow.');
    const ids=[...new Set([this.me.id,...members])];if(ids.length<2)throw new Error('Choose at least one colleague.');for(const id of ids)if(!/^[\da-f-]{36}$/i.test(id))throw new Error('The selected member does not have a usable Microsoft directory identity.');
    const chatType=ids.length===2?'oneOnOne':'group';
    const raw=await this.request('/chats',['Chat.Create'],{method:'POST',body:JSON.stringify({chatType,...(chatType==='group'?{topic:validText(name,'Conversation name',100)}:{}),members:ids.map(id=>({'@odata.type':'#microsoft.graph.aadUserConversationMember',roles:['owner'],'user@odata.bind':`${GRAPH}/users('${id}')`}))})},true);
    await this.bootstrap();const r=[...this.roomMap.values()].find(r=>r.graphChatId===raw.id);if(!r)throw new Error('Microsoft created the chat, but it is not yet visible. Refresh before trying again.');return r;
  }
  async updateRoom(id,patch){const r=this.roomMap.get(id);if(!r)throw new Error('Conversation not found.');const favorites=this.favorites();if(typeof patch.favorite==='boolean'){favorites[id]=patch.favorite;r.favorite=patch.favorite;localStorage.setItem(this.favoriteKey(),JSON.stringify(favorites));}return{...r};}
  async upload(file,roomId){
    const r=this.roomMap.get(roomId);if(!r)throw new Error('Choose a conversation first.');if(r.graphChannelId)throw new Error('Use the channel’s SharePoint/Teams file workflow for uploads. This adapter cannot safely infer the complete channel file access list.');
    if(file.size>MAX_FILE_SIZE)throw new Error('Uploads are limited to 10 MB.');
    const others=r.members.filter(id=>id!==this.me.id).map(id=>this.users.find(u=>u.id===id));if(others.some(u=>!u?.email))throw new Error('An email address is missing for a recipient. Share the file from OneDrive so permissions can be reviewed.');
    const name=`Veyra-${Date.now()}-${file.name.replace(/[<>:"/\\|?*\x00-\x1f]/g,'_')}`;
    const item=await this.request(`/me/drive/root:/${enc(name)}:/content`,['Files.ReadWrite'],{method:'PUT',headers:{'Content-Type':file.type||'application/octet-stream'},body:file},true);
    try{if(others.length)await this.request(`/me/drive/items/${enc(item.id)}/invite`,['Files.ReadWrite'],{method:'POST',body:JSON.stringify({recipients:others.map(u=>({email:u.email})),requireSignIn:true,sendInvitation:false,roles:['read']})},true);}
    catch(cause){throw new Error(`Uploaded to your OneDrive, but permissions could not be granted. Review the new file in OneDrive before sharing. ${cause.message}`);}
    return{id:uid(),roomId,name:file.name,url:safeURL(item.webUrl),driveItemId:item.id,size:file.size,type:file.type,createdAt:new Date().toISOString(),authorName:this.me.name};
  }
  async files(roomId){const result=[];for(const [id,messages] of this.messageCache)if(!roomId||roomId===id)for(const m of messages)for(const f of m.attachments)result.push({...f,roomId:id,authorName:m.authorName,createdAt:m.createdAt});return result;}
  calendarEvent(raw,roomId=null){const id=`mscal-${base64(raw.id)}`;this.eventMap.set(id,raw.id);const utc=v=>/[zZ]$|[+-]\d\d:\d\d$/.test(v)?v:v+'Z';return{id,title:raw.subject||'Meeting',start:utc(raw.start.dateTime),end:utc(raw.end.dateTime),description:bodyText(raw.body),roomId,joinUrl:safeURL(raw.onlineMeeting?.joinUrl||raw.onlineMeetingUrl),creatorId:this.me.id};}
  async calendar(interactive=true){const start=new Date(Date.now()-14*86400000),end=new Date(Date.now()+60*86400000);const raw=await this.pages(`/me/calendarView?startDateTime=${enc(start.toISOString())}&endDateTime=${enc(end.toISOString())}&$top=100`,['Calendars.Read'],{interactive});this.events=raw.map(r=>this.calendarEvent(r));return this.events;}
  async saveEvent(input){
    const rawId=input.id&&this.eventMap.get(input.id),payload={subject:validText(input.title,'Title',160),body:{contentType:'text',content:input.description||''},start:{dateTime:new Date(input.start).toISOString().replace(/Z$/,''),timeZone:'UTC'},end:{dateTime:new Date(input.end).toISOString().replace(/Z$/,''),timeZone:'UTC'}};
    if(!rawId&&!this.personal)Object.assign(payload,{isOnlineMeeting:true,onlineMeetingProvider:'teamsForBusiness'});
    const raw=await this.request(rawId?`/me/events/${enc(rawId)}`:'/me/events',['Calendars.ReadWrite'],{method:rawId?'PATCH':'POST',body:JSON.stringify(payload)},true);
    const value=this.calendarEvent(raw,input.roomId||null);this.emit({type:'event',event:value});return value;
  }
  async deleteEvent(id){const rawId=this.eventMap.get(id);if(!rawId)throw new Error('Sync the calendar before deleting an event.');await this.request(`/me/events/${enc(rawId)}`,['Calendars.ReadWrite'],{method:'DELETE'},true);this.emit({type:'event-deleted',id});}
  async setProfile(){throw new Error('Edit your Microsoft profile in your organization’s account portal.');}
  async download(id){const file=(await this.files()).find(f=>f.id===id);if(!file?.url)throw new Error('Reload the conversation to locate this Microsoft attachment.');return{url:file.url};}
  async typing(){} // No supported arbitrary typing-indicator API is asserted.
  async export(){return{schemaVersion:1,provider:'Microsoft Graph',scope:'Loaded authorized records only',exportedAt:new Date().toISOString(),rooms:this.rooms||[],users:this.users||[],messages:[...this.messageMap.values()].map(m=>m.value),events:this.events||[],files:await this.files()};}
  async logout(){this.dispose();await this.msal.logoutPopup({account:this.account,postLogoutRedirectUri:this.redirectUri});}
  dispose(){this.disposed=true;clearInterval(this.poll);}
}
