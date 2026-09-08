import {LocalProvider,ServerProvider} from './core/storage.js';
import {icon,logo,microsoftLogo} from './core/icons.js';
import {uid,escapeHTML as E,initials,markdown,relativeTime,fileSize,groupReactions,safeURL,MAX_FILE_SIZE} from './core/model.js';
import {Whiteboard} from './core/whiteboard.js';
import {DocumentSession} from './core/documents.js';
import {CallEngine} from './core/calls.js';
import {MediaController,recordingOptions,recordingExtension} from './core/media.js';
import {DevicePanel} from './ui/device-panel.js';
import {readConfig,saveConfig} from './config.js';

const $=selector=>document.querySelector(selector),$$=selector=>[...document.querySelectorAll(selector)];
const state={provider:null,me:null,rooms:[],users:[],events:[],messages:[],allMessages:new Map(),roomId:'product-design',route:'chat',tab:'chat',filter:'all',sidebarQuery:'',details:true,unread:new Map(),online:new Set(),connected:false,limit:100,navSeq:0,attachments:[],reply:null,edit:null,doc:null,board:null,files:[],searchId:0,calendarOffset:0,calendarView:'week',activityFilter:'all',call:null,callRoom:null,teamsCall:null,callHistory:[],typingTimer:0,typingLast:0};
const emojis=['👍','❤️','✨','🙌','😊','🎉','👀','💡','✅','🚀','👏','☕','🔥','💜','🤔','💯','🙏','👋'];
let searchWorker;try{searchWorker=new Worker(new URL('./core/search-worker.js',import.meta.url),{type:'module'});searchWorker.onmessage=event=>renderSearch(event.data);}catch(e){console.warn('Search worker unavailable; using bounded main-thread search.',e.message);}
const key=(name,provider=state.provider)=>`veyra.${name}.${provider?.kind||'local'}.${provider?.me?.id||'local-me'}`;
function readLocal(name,fallback,provider=state.provider){try{return JSON.parse(localStorage.getItem(key(name,provider))||'null')??fallback;}catch{return fallback;}}
function saveLocal(name,value,provider=state.provider){try{localStorage.setItem(key(name,provider),JSON.stringify(value));}catch{toast('Device storage is full. Export important drafts.','error');}}
const user=id=>state.users.find(u=>u.id===id)||{id,name:'Participant',color:'#e8dff1'};
const room=id=>state.rooms.find(r=>r.id===id);
const color=value=>/^#[\da-f]{6}$/i.test(value||'')?value:'#e7dff7';
function avatar(person,{large=false,small=false,presence=false,square=false}={}){
  const p=typeof person==='string'?user(person):person||{name:'?',color:'#e8dff1'};
  return `<span class="avatar${large?' large':''}${small?' small':''}${square?' square':''}" style="background:${color(p.color)}" title="${E(p.name)}">${E(initials(p.name))}${presence&&p.status!=='sample'?`<span class="presence ${E(p.status||'offline')}"></span>`:''}</span>`;
}
function roomAvatar(r,large=false){return r?.type==='direct'?avatar({name:r.name,color:r.color},{large}):`<span class="avatar square${large?' large':''}" style="background:${color(r?.color)}">${icon(r?.type==='channel'?'hash':r?.icon||'teams',large?24:18)}</span>`;}
function ib(name,title,action,extra='',cls=''){return`<button type="button" class="icon-button ${cls}" title="${E(title)}" aria-label="${E(title)}" data-action="${action}" ${extra}>${icon(name,18)}</button>`;}
function button(label,action,name='',cls='',extra=''){return`<button type="button" class="button ${cls}" data-action="${action}" ${extra}>${name?icon(name,16):''}${E(label)}</button>`;}
function empty(title,text,name='chat',actions=''){return`<div class="empty-state"><div class="empty-symbol">${icon(name,28)}</div><h2>${E(title)}</h2><p>${E(text)}</p>${actions?`<div class="row">${actions}</div>`:''}</div>`;}
function toast(message,type='info'){
  const node=document.createElement('div');node.className=`toast ${type==='error'?'error':''}`;node.innerHTML=`${icon(type==='error'?'info':'check',16)}<span>${E(message)}</span>`;$('#toasts').append(node);setTimeout(()=>node.remove(),type==='error'?7500:4200);
}
function modal(title,body,subtitle='',footer=''){
  clearDeviceDialog();hidePopover();const dlg=$('#modal');dlg.innerHTML=`<div class="modal-head"><div><h2 id="modal-title">${E(title)}</h2>${subtitle?`<p>${E(subtitle)}</p>`:''}</div>${ib('close','Close dialog','close-modal')}</div><div class="modal-body">${body}</div>${footer?`<div class="modal-footer">${footer}</div>`:''}`;
  dlg.setAttribute('aria-labelledby','modal-title');if(!dlg.open)dlg.showModal();
}
function formError(error){const form=$('#modal .modal-body');if(!form)return toast(error.message||error,'error');form.querySelector('.form-error')?.remove();const el=document.createElement('div');el.className='form-error';el.setAttribute('role','alert');el.textContent=error.message||String(error);form.prepend(el);}
function hidePopover(){$('#popover').hidden=true;}
function popover(html,anchor){const box=$('#popover');box.innerHTML=html;box.hidden=false;const rect=anchor.getBoundingClientRect();box.style.left=`${Math.max(8,Math.min(innerWidth-box.offsetWidth-8,rect.right-box.offsetWidth))}px`;box.style.top=`${Math.min(innerHeight-box.offsetHeight-12,rect.bottom+6)}px`;}
function menuItem(label,action,name='more',extra='',danger=false){return`<button type="button" class="menu-item${danger?' danger':''}" data-action="${action}" ${extra}>${icon(name,16)}${E(label)}</button>`;}
function field(label,name,value='',type='text',extra=''){return`<label class="field"><span>${E(label)}</span><input type="${type}" name="${name}" value="${E(value)}" ${extra}></label>`;}
function downloadBlob(blob,name){const a=document.createElement('a');const url=URL.createObjectURL(blob);a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),30000);}
async function copy(text){if(navigator.clipboard?.writeText)await navigator.clipboard.writeText(text);else{const el=document.createElement('textarea');el.value=text;document.body.append(el);el.select();document.execCommand('copy');el.remove();}toast('Copied to clipboard.');}
function indexMessages(messages){for(const m of messages)state.allMessages.set(`${m.roomId}:${m.id}`,m);searchWorker?.postMessage({type:'index',messages});}
function findMessage(id){return state.messages.find(m=>m.id===id)||[...state.allMessages.values()].find(m=>m.id===id);}
function upsertMessage(message){indexMessages([message]);if(message.roomId===state.roomId){const index=state.messages.findIndex(m=>m.id===message.id);if(index<0)state.messages.push(message);else state.messages[index]=message;state.messages.sort((a,b)=>a.createdAt.localeCompare(b.createdAt)||a.id.localeCompare(b.id));}}
function renderTopbar(){
  $('#topbar').innerHTML=`<div class="brand">${logo}<span class="brand-name">Veyra</span><span class="brand-divider"></span><button type="button" class="workspace-name" data-action="settings">${state.provider.kind==='microsoft'?'Microsoft workspace':'Veyra Studio'} ${icon('down',12)}</button></div><label class="global-search">${icon('search',17)}<input id="global-search" type="search" placeholder="Search messages, people, and more" aria-label="Search loaded messages and people" autocomplete="off"><kbd>⌘ K</kbd></label><div class="topbar-actions">${ib('help','Help and shortcuts','help')}${ib('settings','Settings','settings')}<button type="button" data-action="profile" aria-label="Your profile" title="Your profile">${avatar(state.me,{presence:true})}</button></div>`;
}
function renderRail(){
  const active=state.route==='chat'&&state.tab==='board'?'board':state.route;
  $('#rail').innerHTML=[['activity','Activity'],['chat','Chat'],['teams','Teams'],['calendar','Calendar'],['calls','Calls'],['files','Files'],['board','Whiteboard']].map(([id,label])=>`<button type="button" class="rail-item${active===id?' active':''}" data-action="nav" data-value="${id}" aria-label="${label}" ${active===id?'aria-current="page"':''}>${icon(id,21)}<span>${label}</span>${id==='activity'&&[...state.unread.values()].some(v=>v)?'<i class="rail-count"></i>':''}</button>`).join('')+`<span class="rail-spacer"></span><button class="rail-item" data-action="settings" aria-label="Settings">${icon('settings',20)}<span>Settings</span></button><button class="rail-item" data-action="help" aria-label="Help">${icon('help',20)}<span>Help</span></button>`;
}
function roomPreview(r){const messages=[...state.allMessages.values()].filter(m=>m.roomId===r.id&&!m.deleted).sort((a,b)=>b.createdAt.localeCompare(a.createdAt));return messages[0];}
function renderSidebar(){
  const oldScroll=$('.conversation-list')?.scrollTop||0;
  const isVisible=r=>(state.filter==='all'||state.filter==='unread'&&(state.unread.get(r.id)||0)>0||state.filter==='chats'&&r.type!=='channel'||state.filter==='channels'&&r.type==='channel')&&(!state.sidebarQuery||r.name.toLowerCase().includes(state.sidebarQuery.toLowerCase()));
  const visible=state.rooms.filter(isVisible),favorites=visible.filter(r=>r.favorite),chats=visible.filter(r=>!r.favorite&&r.type!=='channel'),channels=visible.filter(r=>!r.favorite&&r.type==='channel');
  function item(r){const m=roomPreview(r),unread=state.unread.get(r.id)||0;return `<button type="button" class="conversation${r.id===state.roomId&&state.route==='chat'?' active':''}${r.type==='channel'?' channel':''}" data-action="room" data-id="${E(r.id)}" ${r.id===state.roomId&&state.route==='chat'?'aria-current="page"':''}>${r.type==='channel'?icon('hash',16):roomAvatar(r)}<span class="grow"><span class="room-title truncate">${E(r.name)}</span>${r.type!=='channel'?`<span class="room-preview truncate">${E(m?.content?.replaceAll('\n',' ').slice(0,65)||r.description||'Start a conversation')}</span>`:''}</span>${m&&r.type!=='channel'?`<span class="room-time">${E(relativeTime(m.createdAt))}</span>`:''}${unread?`<span class="badge-count">${unread>99?'99+':unread}</span>`:''}</button>`;}
  const connected=state.provider.kind==='server'?state.connected:state.provider.kind==='microsoft';
  $('#sidebar').innerHTML=`<div class="sidebar-top"><div class="sidebar-title"><h1>Chat</h1><div class="row">${ib('filter','Filter conversations','sidebar-filter')}${ib('edit','New conversation','new-chat')}</div></div><div class="filter-chips">${[['all','All'],['unread','Unread'],['chats','Chats'],['channels','Channels']].map(([id,label])=>`<button class="filter-chip${state.filter===id?' active':''}" data-action="filter" data-value="${id}" aria-pressed="${state.filter===id}">${label}</button>`).join('')}</div><input id="sidebar-filter" class="sidebar-filter" placeholder="Find a conversation" aria-label="Filter conversations by name" value="${E(state.sidebarQuery)}" ${state.sidebarQuery?'':'hidden'}></div><div class="conversation-list">${favorites.length?`<div class="list-heading">${icon('down',11)} FAVORITES ${ib('plus','New conversation','new-chat')}</div>${favorites.map(item).join('')}`:''}${chats.length?`<div class="list-heading">${icon('down',11)} CHATS</div>${chats.map(item).join('')}`:''}${channels.length?`<div class="list-heading">${icon('down',11)} TEAMS & CHANNELS ${ib('plus','New channel','new-channel')}</div>${[...new Set(channels.map(c=>c.teamName||'Veyra Studio'))].map(team=>`<div class="team-heading">${icon('down',11)}<span class="team-icon">${icon('teams',14)}</span>${E(team)}</div>${channels.filter(c=>(c.teamName||'Veyra Studio')===team).map(item).join('')}`).join('')}`:''}${!visible.length?'<div class="empty-state small"><p>No matching conversations.</p></div>':''}</div><div class="sidebar-bottom"><div class="connection-label"><span class="status-dot${connected?'':' local'}"></span>${state.provider.kind==='local'?'LOCAL SAMPLE · THIS DEVICE':state.provider.kind==='microsoft'?'MICROSOFT CONNECTED':state.connected?'LIVE WORKSPACE':'RECONNECTING'}</div><button class="link-button" data-action="settings">${icon(state.provider.kind==='local'?'cloud':'shield',13)}${state.provider.kind==='local'?'Connect your workspace':'Workspace & connection settings'} ${icon('chevron',11)}</button></div>`;
  $('.conversation-list').scrollTop=oldScroll;
}
async function activateProvider(provider){
  ++state.navSeq;const oldDoc=state.doc;state.doc=null;state.board?.dispose();state.board=null;await oldDoc?.close();await leaveCall(false);state.provider?.dispose();
  const data=await provider.bootstrap();state.provider=provider;state.me=data.me;provider.me=data.me;state.rooms=data.rooms;state.users=data.users;state.events=data.events||[];state.messages=[];state.allMessages.clear();state.online.clear();state.connected=false;state.unread=new Map(state.rooms.map(r=>[r.id,r.unread||0]));
  state.unread=new Map([...state.unread,...Object.entries(readLocal('unread',{}))]);state.callHistory=readLocal('callHistory',[]);state.attachments=[];state.reply=null;state.edit=null;state.roomId=state.rooms[0]?.id||'';state.route='chat';state.tab='chat';state.filter='all';state.sidebarQuery='';
  searchWorker?.postMessage({type:'reset'});localStorage.setItem('veyra.mode',provider.kind);
  provider.addEventListener('change',e=>providerChanged(e.detail,provider).catch(err=>console.warn('Veyra event:',err.message)));
  if(provider.kind==='local'){const snapshot=await provider.export();indexMessages(snapshot.messages);}
  renderTopbar();renderRail();renderSidebar();provider.connect?.();await navigate('chat',state.roomId,'chat',{initial:true});
}
async function providerChanged(change,provider){
  if(provider!==state.provider)return;
  if(change.type==='ready'){state.online=new Set(change.online||[]);return;}
  if(change.type==='connection'){
    const was=state.connected;state.connected=change.connected;renderSidebar();
    if(change.connected&&!was&&state.roomId){const id=state.roomId,seq=state.navSeq;try{const messages=await provider.messages(id);if(provider!==state.provider||id!==state.roomId||seq!==state.navSeq)return;state.messages=messages;indexMessages(messages);renderFeed();}catch{}}
  }else if(change.type==='presence'){change.online?state.online.add(change.userId):state.online.delete(change.userId);}
  else if(change.type==='message'){
    const message=change.message,known=state.allMessages.has(`${message.roomId}:${message.id}`);upsertMessage(message);
    if(!known&&message.authorId!==state.me.id&&(message.roomId!==state.roomId||state.route!=='chat'||state.tab!=='chat')){state.unread.set(message.roomId,(state.unread.get(message.roomId)||0)+1);saveLocal('unread',Object.fromEntries(state.unread));}
    renderFeed(message.authorId===state.me.id);renderSidebar();renderRail();if(state.route==='activity')renderActivity();renderCallChat();
    if(!known&&message.authorId!==state.me.id&&document.hidden&&readLocal('notifications',false)&&typeof Notification!=='undefined'&&Notification.permission==='granted')new Notification(`${message.authorName||'New message'} · Veyra`,{body:message.content.slice(0,160),tag:message.id});
  }else if(change.type==='sync'&&change.roomId===state.roomId){state.messages=change.messages;indexMessages(change.messages);renderFeed();renderSidebar();}
  else if(change.type==='room'){const i=state.rooms.findIndex(r=>r.id===change.room.id);if(i<0)state.rooms.push(change.room);else state.rooms[i]={...state.rooms[i],...change.room};renderSidebar();if(state.route==='teams')renderTeams();}
  else if(change.type==='directory'){const data=await provider.bootstrap();if(provider!==state.provider)return;state.rooms=data.rooms;state.users=data.users;state.events=data.events;renderSidebar();renderDetails();}
  else if(change.type==='profile'){const i=state.users.findIndex(u=>u.id===change.user.id);if(i<0)state.users.push(change.user);else state.users[i]=change.user;if(change.user.id===state.me.id){state.me=change.user;provider.me=change.user;renderTopbar();}renderFeed();renderDetails();}
  else if(change.type==='event'){const i=state.events.findIndex(e=>e.id===change.event.id);if(i<0)state.events.push(change.event);else state.events[i]=change.event;if(state.route==='calendar')renderCalendar();renderDetails();}
  else if(change.type==='event-deleted'){state.events=state.events.filter(e=>e.id!==change.id);if(state.route==='calendar')renderCalendar();renderDetails();}
  else if(change.type==='typing'&&change.roomId===state.roomId&&change.peerId!==provider.peerId){const target=$('#typing-line');if(target){target.textContent=`${change.name||'Someone'} is typing…`;clearTimeout(state.typingTimer);state.typingTimer=setTimeout(()=>{if($('#typing-line'))$('#typing-line').textContent='';},2600);}}
  else if(change.type==='files'&&change.roomId===state.roomId){renderDetails();}
  else if(change.type==='notice')toast(change.message);
}
function pageHeader(title,subtitle,actions=''){return`<header class="page-header">${ib('menu','Open conversations','toggle-sidebar','','mobile-menu')}<div class="grow"><h1>${E(title)}</h1><p>${E(subtitle)}</p></div><div class="row">${actions}</div></header>`;}
async function navigate(route,roomId=state.roomId,tab='chat',options={}){
  const seq=++state.navSeq;const oldDoc=state.doc;state.doc=null;state.board?.dispose();state.board=null;await oldDoc?.close();if(seq!==state.navSeq)return;
  const roomChanged=roomId!==state.roomId;state.route=route;state.roomId=roomId;state.tab=tab;state.limit=100;
  if(roomChanged){state.attachments=[];state.reply=null;state.edit=null;state.messages=[];}
  $('#sidebar').classList.remove('open');hidePopover();$('#search-results').hidden=true;
  if(route==='chat'&&roomId){state.unread.set(roomId,0);saveLocal('unread',Object.fromEntries(state.unread));}
  renderRail();renderSidebar();
  if(route==='chat'){
    if(!room(roomId)){$('#main').innerHTML=empty('Make room for a conversation',state.provider.kind==='microsoft'&&state.provider.personal?'Your Microsoft account is signed in. Personal Microsoft accounts do not expose Teams chats through Microsoft Graph.':'Start a conversation, or connect another workspace.','chat',button('New conversation','new-chat','plus','primary')+button('Workspace settings','settings','settings'));return;}
    renderChatShell();
    if(tab==='chat'){
      const provider=state.provider;
      try{const messages=await provider.messages(roomId);if(provider!==state.provider||seq!==state.navSeq)return;state.messages=messages;indexMessages(messages);renderFeed(!options.initial);renderSidebar();if(options.initial&&provider.kind==='local')$('#message-scroll').scrollTop=0;provider.watch?.(roomId);}
      catch(e){if(seq===state.navSeq)$('#message-feed').innerHTML=empty('The conversation could not be loaded',e.message,'cloud',button('Try again','refresh','refresh'));}
    }else if(tab==='files')await renderFiles(true,seq);
    else await openDocument(tab==='notes'?'notes':'board',seq);
  }else if(route==='teams')renderTeams();
  else if(route==='activity')renderActivity();
  else if(route==='calendar')renderCalendar();
  else if(route==='files')await renderFiles(false,seq);
  else if(route==='calls')renderCalls();
}
function renderChatShell(){
  const r=room(state.roomId);if(!r)return;const memberList=(r.members||[]).map(user),sample=state.provider.kind==='local';
  $('#main').innerHTML=`<header class="conversation-header">${ib('menu','Open conversations','toggle-sidebar','','mobile-menu')}${roomAvatar(r,true)}<div class="grow"><h1>${E(r.name)} ${ib('star',r.favorite?'Remove from favorites':'Add to favorites','favorite',`data-id="${E(r.id)}"`,r.favorite?'active':'')}</h1><div class="subtitle">${r.type==='channel'?'Channel':`${r.members?.length||1} members`} <span>·</span><button class="link-button" data-action="members">${sample?'A space to create, together':state.provider.kind==='microsoft'?'Microsoft-connected conversation':'Private to conversation members'}</button></div></div><div class="header-actions"><div class="avatar-stack">${memberList.slice(0,3).map(p=>avatar(p,{small:true})).join('')}${memberList.length>3?`<span class="avatar more-avatar">+${memberList.length-3}</span>`:''}</div><span class="divider"></span>${button(state.provider.kind==='microsoft'?'Teams meeting':'Meet',state.provider.kind==='microsoft'?'join-teams':'start-call','video')}${ib('info','Conversation details','toggle-details')}</div></header><div class="tabs" role="tablist" aria-label="Conversation views">${[['chat','Chat'],['files','Shared'],['notes','Notes'],['board','Whiteboard']].map(([id,label])=>`<button type="button" class="tab${state.tab===id?' active':''}" role="tab" aria-selected="${state.tab===id}" data-action="tab" data-value="${id}">${id==='board'?icon('board',14):''}${label}</button>`).join('')}${ib('refresh','Refresh conversation','refresh')}</div><div id="conversation-content" class="chat-layout">${state.tab==='chat'?`<section class="chat-column" aria-label="Messages">${sample?'<div class="sample-banner">'+icon('lock',12)+' Local example · fictional people · messages stay on this device until you connect a workspace</div>':''}<div id="message-scroll" class="message-scroll"><div id="message-feed" class="message-feed" data-room-id="${E(r.id)}"></div></div><div id="typing-line" class="typing-line" aria-live="polite"></div><div class="composer-wrap"><form id="compose-form" class="composer"><div id="composer-context"></div><div id="attachment-chips"></div><label class="visually-hidden" for="composer-input">Write a message</label><textarea id="composer-input" placeholder="Write a message…" rows="2" maxlength="12000"></textarea><div class="composer-bottom"><div class="composer-tools">${ib('format','Bold selected text','format')}${ib('smile','Emoji','emoji')}${ib('attach','Attach files','attach')}${ib('board','Open shared whiteboard','open-board')}${ib('calendar','Schedule a meeting','new-event')}</div><div class="composer-send"><span>New line with Shift + Enter</span><button type="submit" class="send-button" title="Send message" aria-label="Send message">${icon('send',17)}</button></div></div></form><p class="composer-hint">A little kindness goes a long way. Make this a good place to work.</p></div></section><aside id="details-panel" class="details-panel${state.details?'':' hidden-detail'}" aria-label="Conversation details"></aside>`:''}</div>`;
  if(state.tab==='chat'){const input=$('#composer-input');input.value=readLocal(`draft.${state.roomId}`,'');renderComposerContext();renderFeed();renderDetails();if(!state.details)$('#details-panel').style.display='none';}
}
function sampleDesignCard(){return`<div class="design-card"><div class="design-preview"><div class="mini-window"><div class="mini-titlebar"><i></i><i></i><i></i><span>V E Y R A</span></div><div class="mini-content"><div class="mini-sidebar"><b></b><b></b><b></b><b></b></div><div class="mini-main"><strong>A little space for great work.</strong><p>Less noise. More room for what matters.</p><div class="mini-cards"><div></div><div></div><div></div></div></div></div></div><div class="preview-caption">WORKSPACE EXPLORATIONS / 01</div></div><div class="design-card-footer">${icon('board',21)}<div><strong>Workspace explorations</strong><small>Original sample concept · open the editable whiteboard</small></div>${ib('chevron','Open whiteboard','open-board')}</div></div>`;}
function sampleMeetingCard(){const e=state.events.find(e=>e.id==='design-review');if(!e)return'';const d=new Date(e.start);return`<button type="button" class="meeting-card" data-action="event-details" data-id="${E(e.id)}"><div class="meeting-date"><small>${d.toLocaleDateString('en',{month:'short'}).toUpperCase()}</small><strong>${d.getDate()}</strong></div><div><h4>${E(e.title)}</h4><p>${E(timeRange(e))} · ${E(room(e.roomId)?.name||'Calendar')}</p></div>${icon('chevron',15)}</button>`;}
function attachmentHTML(file){return `<button type="button" class="message-attachment" data-action="download-file" data-id="${E(file.id)}">${icon('files',22)}<span class="grow"><span class="file-name">${E(file.name||'Shared file')}</span><small>${file.size?fileSize(file.size):state.provider.kind==='microsoft'?'Open in Microsoft 365':'Shared attachment'}</small></span>${icon('download',15)}</button>`;}
function messageHTML(m){
  const own=m.authorId===state.me.id,person=state.users.find(u=>u.id===m.authorId)||{name:m.authorName||'Participant',color:'#e5ddef'},parent=m.replyTo?findMessage(m.replyTo):null;
  return `<div class="message-avatar">${avatar(person)}</div><div class="message-body"><div class="message-meta"><span class="message-author">${E(own?'You':person.name)}</span><time class="message-time" datetime="${E(m.createdAt)}">${E(relativeTime(m.createdAt))}</time>${m.editedAt?'<span class="message-time">edited</span>':''}</div><div class="message-bubble">${parent?`<div class="reply-preview"><strong>${E(parent.authorName||user(parent.authorId).name)}</strong>${E(parent.deleted?'Message deleted':parent.content.slice(0,200))}</div>`:''}${m.deleted?'This message was deleted.':markdown(m.content)}${!m.deleted?(m.attachments||[]).map(attachmentHTML).join(''):''}${state.provider.kind==='local'&&m.id.startsWith('sample-')&&m.card==='design'?sampleDesignCard():''}${state.provider.kind==='local'&&m.card==='meeting'?sampleMeetingCard():''}</div>${!m.deleted&&!m.pending?`<div class="message-tools">${ib('smile','React to message','react',`data-id="${E(m.id)}"`)}${ib('reply','Reply to message','reply',`data-id="${E(m.id)}"`)}${ib('bookmark','Save message for yourself','bookmark',`data-id="${E(m.id)}"`)}${ib('more','More message actions','message-menu',`data-id="${E(m.id)}"`)}</div>`:''}${(m.reactions||[]).length?`<div class="reactions">${groupReactions(m.reactions).map(r=>`<button class="reaction${r.users.includes(state.me.id)?' mine':''}" data-action="react-direct" data-id="${E(m.id)}" data-emoji="${E(r.emoji)}" title="${E(r.users.map(id=>user(id).name).join(', '))}" aria-label="${E(r.emoji)} reaction, ${r.count}">${E(r.emoji)}<span>${r.count}</span></button>`).join('')}</div>`:''}${own?`<div class="message-status${m.failed?' failed':''}">${m.failed?`Not sent ${button('Retry','retry-send','','quiet small',`data-id="${E(m.id)}"`)}${button('Discard','discard-send','','quiet small',`data-id="${E(m.id)}"`)}`:m.pending?'Sending…':`${icon('check',11)} ${state.provider.kind==='local'?'Saved on this device':'Sent'}`}</div>`:''}</div>`;
}
function renderFeed(forceBottom=false){
  const feed=$('#message-feed'),scroll=$('#message-scroll');if(!feed||feed.dataset.roomId!==state.roomId||!scroll)return;
  const nearBottom=scroll.scrollHeight-scroll.scrollTop-scroll.clientHeight<110,oldTop=scroll.scrollTop;
  const queue=readLocal('outbox',[]).filter(m=>m.roomId===state.roomId&&!state.messages.some(s=>s.id===m.id)).map(m=>({...m,authorId:state.me.id,authorName:state.me.name,pending:true}));
  const messages=[...state.messages,...queue].sort((a,b)=>a.createdAt.localeCompare(b.createdAt)||a.id.localeCompare(b.id));
  const visible=messages.slice(-state.limit),existing=new Map([...feed.querySelectorAll('[data-message-id]')].map(n=>[n.dataset.messageId,n])),fragment=document.createDocumentFragment();let lastDate='';
  if(messages.length>state.limit){const more=document.createElement('div');more.className='row';more.style.justifyContent='center';more.innerHTML=button(`Show ${Math.min(100,messages.length-state.limit)} earlier messages`,'load-older','','quiet small');fragment.append(more);}
  for(const m of visible){
    const date=new Date(m.createdAt),label=date.toDateString()===new Date().toDateString()?'Today':date.toLocaleDateString([],{weekday:'long',month:'long',day:'numeric'});
    if(label!==lastDate){const divider=document.createElement('div');divider.className='date-divider';divider.textContent=label;fragment.append(divider);lastDate=label;}
    let el=existing.get(m.id);if(!el){el=document.createElement('article');el.dataset.messageId=m.id;el.tabIndex=-1;}
    const signature=JSON.stringify([m,state.users.find(u=>u.id===m.authorId)?.name]);
    el.className=`message${m.authorId===state.me.id?' own':''}${m.deleted?' deleted':''}`;
    if(el.dataset.signature!==signature){el.innerHTML=messageHTML(m);el.dataset.signature=signature;}
    fragment.append(el);
  }
  feed.replaceChildren(fragment);
  if(!messages.length)feed.innerHTML=empty('A fresh conversation','Share an idea, ask a question, or just say hello.','chat');
  if(forceBottom||nearBottom)scroll.scrollTop=scroll.scrollHeight;else scroll.scrollTop=oldTop;
}
function renderComposerContext(){
  const target=$('#composer-context');if(!target)return;
  target.innerHTML=state.reply||state.edit?`<div class="composer-context">${icon(state.edit?'edit':'reply',14)}<div class="truncate"><strong>${state.edit?'Editing your message':`Replying to ${user(state.reply.authorId).name}`}</strong> · ${E((state.edit||state.reply).content.slice(0,140))}</div>${ib('close','Cancel reply or edit','cancel-reply')}</div>`:'';
  $('#attachment-chips').innerHTML=state.attachments.length?`<div class="attachment-chips">${state.attachments.map(f=>`<span class="attachment-chip">${icon('files',13)}${E(f.name)}<button type="button" data-action="remove-attachment" data-id="${E(f.id)}" aria-label="Remove ${E(f.name)}">${icon('close',12)}</button></span>`).join('')}</div>`:'';
}
async function renderDetails(){
  const el=$('#details-panel'),r=room(state.roomId);if(!el||!r)return;const id=r.id,provider=state.provider;
  const pinnedId=readLocal(`pinned.${id}`,null),pinned=pinnedId?findMessage(pinnedId):null;
  const members=(r.members||[]).map(user),event=state.events.filter(e=>e.roomId===id).sort((a,b)=>a.start.localeCompare(b.start)).find(e=>+new Date(e.end)>Date.now())||state.events.find(e=>e.roomId===id);
  el.innerHTML=`<div class="details-top"><h2>About this chat</h2>${ib('close','Close details','toggle-details')}</div><p class="details-description">${E(r.description||'A shared space for conversations, decisions, and everything in between.')}</p><div class="details-label">${icon('teams',13)} Members <button data-action="members">View all</button></div>${members.slice(0,4).map(p=>`<div class="detail-member">${avatar(p,{small:true})}<div class="grow"><div class="member-name">${E(p.name)}${p.id===state.me.id?' (you)':''}</div><div class="member-title">${E(p.title||p.email||'Workspace member')}</div></div>${p.status==='sample'?'<span class="sample-label">sample</span>':''}</div>`).join('')}${members.length>4?`<button class="details-more" data-action="members">+ ${members.length-4} more members</button>`:''}<div class="details-section"><div class="details-label">${icon('pin',13)} Pinned for you</div><div class="pinned-card">${pinned?`<span class="tiny">${E(pinned.authorName||user(pinned.authorId).name)}</span>${E(pinned.content.slice(0,150))}`:'Pin an important message here. Your pins are private to you.'}</div></div><div class="details-section"><div class="details-label">${icon('folder',13)} Shared files <button data-action="tab" data-value="files">See all</button></div><div id="detail-files"><span class="tiny muted">Loading files…</span></div></div>${event?`<div class="details-section"><div class="details-label">${icon('calendar',13)} On the calendar</div><button class="detail-meeting" data-action="event-details" data-id="${E(event.id)}"><h4>${E(event.title)}</h4><p>${E(timeRange(event))}</p><div class="meeting-bottom"><span>${E(new Date(event.start).toLocaleDateString([],{month:'short',day:'numeric'}))}</span><span class="join-label">Details ${icon('chevron',9)}</span></div></button></div>`:''}`;
  try{const files=await provider.files(id);if(provider!==state.provider||id!==state.roomId||!$('#detail-files'))return;state.detailFiles=files;$('#detail-files').innerHTML=files.length?files.slice(0,3).map(f=>`<button class="detail-file" data-action="download-file" data-id="${E(f.id)}"><span class="file-symbol">${icon('files',18)}</span><span class="grow"><span class="file-title">${E(f.name)}</span><small>${f.size?fileSize(f.size):'Microsoft 365 file'}</small></span></button>`).join(''):'<p class="tiny muted">Files you share appear here.</p>';}catch(e){if($('#detail-files'))$('#detail-files').textContent=e.message;}
}
async function openDocument(kind,seq){
  const parent=$('#conversation-content');if(!parent)return;
  if(!state.provider.capabilities[kind==='notes'?'notes':'board']){parent.innerHTML=empty('Keep shared content in its own workspace','Microsoft chat integration does not turn Veyra notes or whiteboards into Teams or Loop documents. Switch to a local or live Veyra workspace to use these editors.','shield',button('Workspace settings','settings','settings','primary'));return;}
  parent.innerHTML=`<div class="${kind==='board'?'board-wrap':'notes-wrap'}"><div class="document-toolbar"><div id="doc-status" class="document-status"><span class="status-dot"></span>Opening shared ${kind==='board'?'whiteboard':'notes'}…</div><div class="row">${kind==='board'?'<span id="renderer-pill" class="renderer-pill"><span class="status-dot"></span>Starting renderer</span>':''}${button('Export','doc-export','download','small')}${ib('refresh','Reload latest revision','doc-reload')}${ib('cloud','Save now','doc-save')}</div></div>${kind==='board'?'<div id="board-stage" class="board-stage" tabindex="0" aria-label="Editable whiteboard. Select a tool to draw. Delete removes selection. Control Z undoes."></div>':'<textarea id="notes-editor" class="notes-page" aria-label="Shared notes" placeholder="Make space for your next idea…" spellcheck="true" maxlength="100000"></textarea><p class="document-footer">Autosaved with revision checks · your edits stay recoverable on this device</p>'}${kind==='board'?`<div class="board-tools" role="toolbar" aria-label="Whiteboard tools">${[['cursor','Select & move','select'],['hand','Pan','pan'],['edit','Pen','pen'],['note','Sticky note','note'],['rect','Rectangle','rect'],['ellipse','Ellipse','ellipse'],['arrow','Arrow','arrow']].map(([name,title,id])=>ib(name,title,'board-tool',`data-value="${id}"`,id==='select'?'active':'')).join('')}<hr><input type="color" class="board-color" id="board-color" value="#7162b8" aria-label="Drawing color"><hr>${ib('undo','Undo drawing','board-undo')}${ib('redo','Redo drawing','board-redo')}${ib('trash','Delete selected shape','board-delete')}</div><div class="board-bottom">${ib('zoomOut','Zoom out','board-zoom-out')}<span data-board-zoom>100%</span>${ib('zoomIn','Zoom in','board-zoom-in')}${ib('fit','Fit whiteboard','board-fit')}</div><div class="board-hint">Draw a thought. Connect an idea. Double-click a note to edit.</div>`:''}</div>`;
  const provider=state.provider,id=state.roomId,session=new DocumentSession(provider,id,kind);
  try{
    await session.load();if(seq!==state.navSeq||provider!==state.provider){await session.close();return;}state.doc=session;
    const mount=()=>{
      if(state.doc!==session)return;
      if(kind==='notes')$('#notes-editor').value=session.value.text;
      else{state.board?.dispose();state.board=new Whiteboard($('#board-stage'),{shapes:session.value.shapes,onChange:shapes=>session.update({shapes}),onMode:mode=>{const badge=$('#renderer-pill');if(badge&&state.doc===session)badge.innerHTML=`<span class="status-dot"></span>${E(mode)}`;}});requestAnimationFrame(()=>{if(state.doc===session)state.board?.fit();});}
    };
    session.addEventListener('status',updateDocumentStatus);session.addEventListener('remote',mount);mount();updateDocumentStatus();
  }catch(e){if(seq===state.navSeq)parent.innerHTML=empty('Unable to open this document',e.message,'files',button('Try again','refresh','refresh'));}
}
function updateDocumentStatus(){const s=state.doc,el=$('#doc-status');if(!s||!el)return;el.classList.toggle('conflict',s.conflict);const text=s.conflict?'Revision conflict · export your draft before reloading':s.saving?'Saving…':s.dirty?s.message||'Unsaved changes · saved recovery draft':`All changes saved · revision ${s.version}`;el.innerHTML=`<span class="status-dot"></span>${E(text)}`;}

function renderTeams(){
  $('#main').innerHTML=pageHeader('Teams & channels','Give every project a place to belong.',button('New channel','new-channel','plus','primary'))+`<div class="view-content"><div class="cards-grid">${state.rooms.filter(r=>r.type==='channel').map(r=>`<button type="button" class="room-card" data-action="room" data-id="${E(r.id)}">${roomAvatar(r,true)}<h3>${E(r.name)}</h3><p>${E(r.description||`A shared channel in ${r.teamName||'your Veyra workspace'}.`)}</p><div class="room-card-bottom"><span>${r.members?.length||'Team'} members</span><span>Open channel ${icon('chevron',13)}</span></div></button>`).join('')}</div>${!state.rooms.some(r=>r.type==='channel')?empty('Your next project starts here','Create a channel in a live or local workspace, or connect your organization’s Microsoft Teams channels.','teams',button('Workspace settings','settings','settings')):''}</div>`;
}
function renderActivity(){
  let messages=[...state.allMessages.values()].filter(m=>!m.deleted).sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
  const saved=new Set(readLocal('bookmarks',[])),firstName=state.me.name.split(' ')[0].toLowerCase();
  if(state.activityFilter==='saved')messages=messages.filter(m=>saved.has(m.id));
  if(state.activityFilter==='unread')messages=messages.filter(m=>(state.unread.get(m.roomId)||0)>0&&m.authorId!==state.me.id);
  if(state.activityFilter==='mentions')messages=messages.filter(m=>m.content.toLowerCase().includes('@'+firstName));
  $('#main').innerHTML=pageHeader('Activity','The conversations that keep your work moving.',button('Mark all as read','mark-all-read','check','small'))+`<div class="view-content"><div class="activity-filters">${[['all','All activity'],['unread','Unread'],['mentions','Mentions'],['saved','Saved']].map(([id,label])=>`<button class="filter-chip${id===state.activityFilter?' active':''}" data-action="activity-filter" data-value="${id}">${label}</button>`).join('')}</div>${messages.length?messages.slice(0,150).map(m=>`<button class="activity-item" data-action="jump-message" data-id="${E(m.id)}" data-room="${E(m.roomId)}">${avatar(state.users.find(u=>u.id===m.authorId)||{name:m.authorName})}<div class="grow"><h3>${E(m.authorName||user(m.authorId).name)} <small>in ${E(room(m.roomId)?.name||'a conversation')}</small></h3><p>${E(m.content.slice(0,240))}</p></div><span class="activity-time">${E(relativeTime(m.createdAt))}</span></button>`).join(''):empty('A little breathing room','No matching activity in your loaded conversations. Open a chat to load its history.','activity')}</div>`;
}
async function renderFiles(shared=false,seq=state.navSeq){
  const target=shared?$('#conversation-content'):$('#main'),provider=state.provider,id=shared?state.roomId:null;
  if(!target)return;
  target.innerHTML=(shared?'':pageHeader('Files','The details, documents, and ideas you share.',button('Upload file','upload-files','upload','primary')))+`<div class="view-content" id="files-view">${shared?`<div class="row between" style="margin-bottom:19px"><div><h3>Shared in this conversation</h3><p class="small muted" style="margin-top:7px">Files stay with the conversation they belong to.</p></div>${button('Upload','upload-files','upload','small')}</div>`:''}<div id="files-content"><div class="empty-state"><p>Opening shared files…</p></div></div><div class="drop-zone" data-dropzone="files">${icon('upload',23)}<span>Drop files here, or <button class="link-button" data-action="upload-files">browse your device</button></span><span class="tiny">Up to 10 MB per file · shared only with this conversation</span></div></div>`;
  try{
    const files=await provider.files(id);if(provider!==state.provider||seq!==state.navSeq||!$('#files-content'))return;state.files=files;
    $('#files-content').innerHTML=files.length?`<table class="files-table"><thead><tr><th>Name</th><th>Conversation</th><th>Shared by</th><th>Size</th><th><span class="visually-hidden">Download</span></th></tr></thead><tbody>${files.map(f=>`<tr><td><button class="file-row-name" data-action="download-file" data-id="${E(f.id)}"><span class="file-symbol">${icon('files',18)}</span><span>${E(f.name)}</span></button></td><td>${E(room(f.roomId)?.name||'Microsoft 365')}</td><td>${E(f.authorName||user(f.ownerId).name)}</td><td>${f.size?fileSize(f.size):'—'}</td><td>${ib(state.provider.kind==='microsoft'?'link':'download',state.provider.kind==='microsoft'?'Open file':'Download file','download-file',`data-id="${E(f.id)}"`)}</td></tr>`).join('')}</tbody></table>`:empty('Room for something useful','Upload a real file, then share it with the people in this conversation.','files');
  }catch(e){if($('#files-content'))$('#files-content').innerHTML=empty('Files are unavailable',e.message,'lock',button('Try again','refresh','refresh'));}
}
function timeRange(e){return`${new Date(e.start).toLocaleTimeString([],{hour:'numeric',minute:'2-digit'})} – ${new Date(e.end).toLocaleTimeString([],{hour:'numeric',minute:'2-digit'})}`;}
function localDatetime(value){const d=new Date(value);return new Date(d.getTime()-d.getTimezoneOffset()*60000).toISOString().slice(0,16);}
function weekStart(){const d=new Date();d.setHours(0,0,0,0);d.setDate(d.getDate()-((d.getDay()+6)%7)+state.calendarOffset*7);return d;}
function eventsForDay(day){
  const start=new Date(day);start.setHours(9,0,0,0);const end=new Date(day);end.setHours(18,0,0,0);
  const items=state.events.filter(e=>new Date(e.start)<end&&new Date(e.end)>start).map(e=>({event:e,start:Math.max(+new Date(e.start),+start),end:Math.min(+new Date(e.end),+end)})).sort((a,b)=>a.start-b.start||b.end-a.end);
  let group=[],ends=[],groupEnd=0;
  const finish=()=>{for(const item of group)item.columns=ends.length;group=[];ends=[];};
  for(const item of items){if(item.start>=groupEnd){finish();groupEnd=0;}let lane=ends.findIndex(end=>end<=item.start);if(lane<0)lane=ends.length;ends[lane]=item.end;item.lane=lane;group.push(item);groupEnd=Math.max(groupEnd,item.end);}
  finish();return items.map(item=>({...item,top:(item.start-start)/3600000*65,height:Math.max(18,(item.end-item.start)/3600000*65-3)}));
}
function renderCalendar(){
  const start=weekStart(),days=Array.from({length:5},(_,i)=>{const d=new Date(start);d.setDate(d.getDate()+i);return d;}),end=new Date(start);end.setDate(end.getDate()+7);
  const label=`${start.toLocaleDateString([],{month:'long',day:'numeric'})} – ${days[4].toLocaleDateString([],{day:'numeric'})}, ${days[4].getFullYear()}`;
  const items=state.events.filter(e=>new Date(e.start)<end&&new Date(e.end)>=start).sort((a,b)=>a.start.localeCompare(b.start));
  $('#main').innerHTML=pageHeader('Calendar','Make time for the work, and for each other.',button('New meeting','new-event','plus','primary'))+`<div class="calendar-toolbar">${ib('left','Previous week','calendar-prev')}${ib('chevron','Next week','calendar-next')}<span class="calendar-title">${E(label)}</span>${button('Today','calendar-today','','small')}<span class="spacer"></span>${state.provider.kind==='microsoft'?button('Sync Microsoft','calendar-sync','refresh','small'):''}<button class="button small" data-action="calendar-view">${icon(state.calendarView==='week'?'calendar':'files',14)}${state.calendarView==='week'?'Workweek':'Agenda'} ${icon('down',12)}</button></div><div class="calendar-content">${state.calendarView==='week'?`<div class="calendar-grid"><div class="calendar-day-head">09–18</div>${days.map(d=>`<div class="calendar-day-head${d.toDateString()===new Date().toDateString()?' today':''}">${d.toLocaleDateString('en',{weekday:'short'}).toUpperCase()}<strong>${d.getDate()}</strong></div>`).join('')}<div class="calendar-time-column">${Array.from({length:9},(_,i)=>`<div class="calendar-hour-label">${String(i+9).padStart(2,'0')}:00</div>`).join('')}</div>${days.map(d=>`<div class="calendar-day" data-date="${localDatetime(d).slice(0,10)}" title="Double-click to schedule a meeting">${eventsForDay(d).map((item,i)=>`<button class="calendar-event ${['','green','peach'][i%3]}" data-action="event-details" data-id="${E(item.event.id)}" style="top:${item.top}px;height:${item.height}px;left:calc(${item.lane/item.columns*100}% + 4px);width:calc(${100/item.columns}% - 8px);right:auto"><h3>${E(item.event.title)}</h3><p>${E(timeRange(item.event))}</p></button>`).join('')}</div>`).join('')}</div><p class="tiny muted" style="margin:15px 0 0 55px">Workweek view: Monday–Friday, 09:00–18:00. Agenda includes evenings and weekends.</p>`:items.length?items.map(e=>`<button class="agenda-event" data-action="event-details" data-id="${E(e.id)}"><div class="agenda-time">${new Date(e.start).toLocaleDateString([],{weekday:'short',month:'short',day:'numeric'})}<br><br>${new Date(e.start).toLocaleTimeString([],{hour:'numeric',minute:'2-digit'})}</div><div class="grow"><h3>${E(e.title)}</h3><p>${E(timeRange(e))} · ${E(room(e.roomId)?.name||'Your calendar')}</p></div>${icon('chevron',16)}</button>`).join(''):empty('Space for what matters','No meetings on this week’s calendar. Schedule time to connect.','calendar',button('New meeting','new-event','plus','primary'))}</div>`;
}
function eventForm(event=null,startTime=null){
  const start=event?.start||startTime||(()=>{const d=new Date();d.setMinutes(0,0,0);d.setHours(d.getHours()+1);return d.toISOString();})(),end=event?.end||new Date(+new Date(start)+30*60000).toISOString();
  modal(event?'Edit meeting':'Make time to connect',`<form id="event-form"><input type="hidden" name="id" value="${E(event?.id||'')}">${field('Meeting title','title',event?.title||'','text','required maxlength="160" placeholder="What are we getting together for?"')}<div class="field-row">${field('Starts','start',localDatetime(start),'datetime-local','required')}${field('Ends','end',localDatetime(end),'datetime-local','required')}</div><label class="field"><span>Conversation</span><select name="roomId">${state.rooms.map(r=>`<option value="${E(r.id)}" ${(event?.roomId||state.roomId)===r.id?'selected':''}>${E(r.name)}</option>`).join('')}<option value="" ${event&&!event.roomId?'selected':''}>Just my calendar</option></select></label><label class="field"><span>Notes and agenda</span><textarea name="description" maxlength="4000" placeholder="A little context goes a long way…">${E(event?.description||'')}</textarea></label>${state.provider.kind==='microsoft'?'<div class="notice">Saved to your Microsoft calendar. Work accounts can create a Teams meeting link when the tenant supports it. This form does not send attendee invitations.</div>':field('External meeting link (optional)','joinUrl',event?.joinUrl||'','url','placeholder="https://…"')}<p class="tiny muted">Veyra room meetings are joinable by conversation members. Calendar entries do not automatically call or invite anyone.</p><div class="row" style="justify-content:flex-end;margin-top:22px">${button('Cancel','close-modal','','quiet')}<button type="submit" class="button primary">${icon('calendar',16)}${event?'Save changes':'Create meeting'}</button></div></form>`, 'A shared plan starts with a little time together.');
}
function eventDetails(id){
  const event=state.events.find(e=>e.id===id);if(!event)return toast('Meeting is no longer available.','error');
  const canEdit=!event.creatorId||event.creatorId===state.me.id||state.provider.kind==='microsoft';
  modal(event.title,`<div class="notice"><div class="row">${icon('calendar',21)}<div><strong>${E(new Date(event.start).toLocaleDateString([],{weekday:'long',month:'long',day:'numeric'}))}</strong><br>${E(timeRange(event))}</div></div></div><div class="field"><span>Conversation</span><p class="small muted">${E(room(event.roomId)?.name||'Your calendar')}</p></div>${event.description?`<div class="field"><span>Agenda</span><p class="small muted" style="white-space:pre-wrap;line-height:1.9">${E(event.description)}</p></div>`:''}${event.joinUrl?`<div class="notice"><strong>Meeting link</strong><br><span style="overflow-wrap:anywhere">${E(event.joinUrl)}</span></div>`:''}<div class="row" style="flex-wrap:wrap">${button(event.joinUrl?'Join meeting':'Join room call','join-event','video','primary',`data-id="${E(id)}"`)}${button('Export .ics','export-event','download','',`data-id="${E(id)}"`)}${canEdit?button('Edit','edit-event','edit','quiet',`data-id="${E(id)}"`):''}${canEdit?ib('trash','Delete meeting','delete-event',`data-id="${E(id)}"`):''}</div>`, 'A little space to think together.');
}
function exportEvent(event){
  const esc=s=>String(s||'').replace(/\\/g,'\\\\').replace(/\r?\n/g,'\\n').replace(/,/g,'\\,').replace(/;/g,'\\;');
  const date=s=>new Date(s).toISOString().replace(/[-:]/g,'').replace(/\.\d{3}/,'');
  const lines=['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//Veyra//Workspace//EN','CALSCALE:GREGORIAN','BEGIN:VEVENT',`UID:${esc(event.id)}@veyra.local`,`DTSTAMP:${date(new Date())}`,`DTSTART:${date(event.start)}`,`DTEND:${date(event.end)}`,`SUMMARY:${esc(event.title)}`,`DESCRIPTION:${esc(event.description)}`,...(event.joinUrl?[`URL:${event.joinUrl}`]:[]),'END:VEVENT','END:VCALENDAR'];
  const folded=lines.map(line=>{let output='',part='',bytes=0;for(const c of line){const n=new TextEncoder().encode(c).length;if(bytes+n>73){output+=part+'\r\n ';part='';bytes=1;}part+=c;bytes+=n;}return output+part;}).join('\r\n')+'\r\n';downloadBlob(new Blob([folded],{type:'text/calendar;charset=utf-8'}),`${event.title.replace(/[^\w -]/g,'').slice(0,80)||'meeting'}.ics`);
}
function renderCalls(){
  $('#main').innerHTML=pageHeader('Calls','Good conversations bring us closer.',button('Teams meeting','join-teams','link','small')+button('Start a call','start-call','video','primary'))+`<div class="view-content">${state.callHistory.length?`<div class="eyebrow" style="margin-bottom:12px">Your calls on this device</div>${[...state.callHistory].reverse().slice(0,50).map(c=>`<div class="call-history-item">${roomAvatar(room(c.roomId)||{name:c.title,type:'group'},true)}<div class="grow"><strong>${E(c.title)}</strong><p>${E(new Date(c.startedAt).toLocaleString())} · ${Math.max(1,Math.round(c.duration/60000))} min · ${c.kind==='teams'?'ACS meeting':'Veyra call'}</p></div>${c.kind==='teams'?ib('link','Join a Teams meeting','join-teams'):button('Call again','call-room','video','small',`data-id="${E(c.roomId)}"`)}</div>`).join('')}`:empty('A real conversation starts here','Start a voice or video call, share your screen, or join a Teams meeting through the supported Azure Communication Services integration.','calls',button('Start a call','start-call','video','primary')+button('Join Teams meeting','join-teams','link'))}<div class="notice" style="margin-top:28px;max-width:760px"><strong>No simulated calls.</strong> Veyra calls use actual WebRTC media. Local mode connects tabs on this device; live mode connects signed-in room members. Reliable internet calling requires your administrator’s TURN service. This build supports up to eight mesh participants.</div></div>`;
}
function showMembers(){const r=room(state.roomId);modal('The people in this space',`<div>${(r?.members||[]).map(id=>{const p=user(id);return`<div class="detail-member" style="margin:17px 0">${avatar(p)}<div class="grow"><div class="member-name" style="font-size:12px">${E(p.name)}${p.id===state.me.id?' (you)':''}</div><div class="member-title" style="font-size:10px">${E(p.title||p.email||'Workspace member')}</div></div><span class="pill">${p.status==='sample'?'Fictional sample':state.online.has(id)?'Connected':'Member'}</span></div>`;}).join('')}</div>`,r?.name||'Conversation members');}
function newRoom(type='group',selected=null){
  if(state.provider.kind==='microsoft'&&type==='channel')return modal('Microsoft channel administration',`<div class="notice">This adapter reads your existing Teams channels and sends channel messages. Creating teams, managing channel membership, and tenant administration are not implemented. Use your tenant’s supported management interface for those operations.</div>`,'Your organization remains the authority for membership.');
  const choices=state.users.filter(u=>u.id!==state.me.id);
  modal(type==='channel'?'A home for your next project':'Start something together',`<form id="new-room-form"><input type="hidden" name="type" value="${type}">${field(type==='channel'?'Channel name':'Conversation name','name',selected?user(selected).name:'','text','required maxlength="100" placeholder="Give this space a name"')}<label class="field"><span>${state.provider.kind==='local'?'Sample members (not connected people)':'Choose workspace members'}</span></label><div class="member-options">${choices.length?choices.map(p=>`<label class="member-option"><input type="checkbox" name="members" value="${E(p.id)}" ${p.id===selected?'checked':''}>${avatar(p,{small:true})}<span>${E(p.name)}</span><small>${p.status==='sample'?'sample':E(p.email||'')}</small></label>`).join(''):'<p class="small muted" style="padding:12px">Other registered members will appear here.</p>'}</div><div class="notice">${state.provider.kind==='local'?'This creates a local conversation. Sample people will not reply. Open a second browser tab to test actual local collaboration.':state.provider.kind==='microsoft'?'Creates a real Microsoft chat with the selected users. Creating a chat may require an additional consent prompt.':'Only the selected members can access this conversation. General remains shared by all registered members of this installation.'}</div><div class="row" style="justify-content:flex-end">${button('Cancel','close-modal','','quiet')}<button type="submit" class="button primary">${icon('plus',15)}Create ${type==='channel'?'channel':'conversation'}</button></div></form>`,type==='channel'?'Give conversations and shared work a clear place.':'Bring the right people into the conversation.');
}
function showSettings(){
  const config=readConfig(),theme=localStorage.getItem('veyra.theme')||'light';
  modal('Your workspace, your way',`<section class="settings-section"><div class="settings-profile">${avatar(state.me,{large:true,presence:true})}<div class="grow"><h3>${E(state.me.name)}</h3><p>${E(state.me.email||'Your local profile')} · ${E(state.provider.name)}</p></div>${state.provider.kind!=='microsoft'?button('Edit','edit-profile','edit','small'):''}</div></section><section class="settings-section"><h3>Connected workspaces</h3><div class="mode-card${state.provider.kind==='local'?' active':''}">${icon('board',20)}<div class="grow"><h4>Local workspace</h4><p>Fictional sample content, real device storage. Works without an account. Tabs on this origin can communicate.</p></div>${button(state.provider.kind==='local'?'Active':'Open','use-local','','small')}</div><div class="mode-card${state.provider.kind==='server'?' active':''}">${icon('cloud',20)}<div class="grow"><h4>Live Veyra workspace</h4><p>Real accounts, shared rooms, files, notes, and calls through the included Node/SQLite server.</p></div>${button(state.provider.kind==='server'?'Sign out':'Connect',state.provider.kind==='server'?'workspace-logout':'workspace-login','','small')}</div><div class="mode-card${state.provider.kind==='microsoft'?' active':''}">${microsoftLogo}<div class="grow"><h4>Microsoft account</h4><p>Official sign-in and Microsoft Graph chats, channels, and calendar. Teams chat APIs require a supported work or school account.</p></div>${button(state.provider.kind==='microsoft'?'Sign out':'Sign in',state.provider.kind==='microsoft'?'microsoft-logout':'microsoft-login','','small')}</div></section><section class="settings-section"><h3>Microsoft app configuration</h3><form id="microsoft-config-form">${field('Application (client) ID — public identifier','microsoftClientId',config.microsoftClientId,'text','placeholder="00000000-0000-0000-0000-000000000000" autocomplete="off"')}${field('Tenant','microsoftTenantId',config.microsoftTenantId,'text','placeholder="common, organizations, or your tenant ID"')}<div class="notice"><strong>Register a Single-page application redirect URI:</strong><br><code>${E(new URL('./auth.html',location.href).href.split('#')[0])}</code><br>No client secret belongs in the browser. Your Microsoft password is entered only on Microsoft’s sign-in page.</div><div class="row between"><button type="button" class="link-button tiny" data-action="copy-redirect">Copy redirect URI</button><button type="submit" class="button small">Save configuration</button></div></form></section><section class="settings-section"><h3>Make yourself at home</h3><div class="setting-row"><div><h4>Appearance</h4><p>A calmer canvas, day or night.</p></div><select id="theme-select" aria-label="Appearance" class="button small">${[['light','Light'],['dark','Dark'],['system','System']].map(([id,label])=>`<option value="${id}" ${theme===id?'selected':''}>${label}</option>`).join('')}</select></div><div class="setting-row"><div><h4>Desktop notifications</h4><p>Opt in to previews for incoming messages while this tab is hidden.</p></div>${button(readLocal('notifications',false)?'Disable':'Enable','notifications','activity','small')}</div><div class="setting-row"><div><h4>Export workspace data</h4><p>JSON metadata and messages. Download file contents separately. No sign-in tokens are included.</p></div>${button('Export','export-workspace','download','small')}</div></section><div class="notice"><strong>Microsoft interoperability is explicit.</strong> Veyra is an original implementation, not a private Teams protocol replacement. Meeting interop uses ACS as a separate external participant. Calls in Veyra rooms use WebRTC, not Teams calling protocols.</div>`, 'Accounts, connections, and all the little details.');
}
function authForm(mode='login'){
  modal(mode==='register'?'Create a Veyra account':'Connect your live workspace',`<form id="workspace-auth-form"><input type="hidden" name="mode" value="${mode}">${mode==='register'?field('Your name','name','','text','required maxlength="80" autocomplete="name"'):''}${field('Veyra account email','email','','email','required autocomplete="username"')}${field('Veyra password — not your Microsoft password','password','','password',`required minlength="12" maxlength="256" autocomplete="${mode==='register'?'new-password':'current-password'}"`)}<div class="notice">${mode==='register'?'Your account belongs to this Veyra installation. All registered users join General; other rooms are private to their selected members. Email ownership is not verified by this self-hosted build.':'This connects to the included Veyra server on the current origin. Microsoft account sign-in is a separate option in workspace settings.'}</div><div class="row between"><button type="button" class="link-button small" data-action="workspace-auth-mode" data-value="${mode==='login'?'register':'login'}">${mode==='login'?'Create an account':'Already registered? Sign in'}</button><button type="submit" class="button primary">${icon('lock',15)}${mode==='register'?'Create account':'Connect'}</button></div></form>`,'Your shared space, with real people and real conversations.');
}
function profileMenu(anchor){popover(`<div style="padding:10px 11px 13px"><strong style="font-size:12px">${E(state.me.name)}</strong><p class="tiny muted" style="margin-top:5px">${E(state.me.email||state.provider.name)}</p></div>${state.provider.kind!=='microsoft'?['available','busy','away','offline'].map(status=>menuItem(status[0].toUpperCase()+status.slice(1),'set-status',status===state.me.status?'check':'clock',`data-value="${status}"`)).join(''):''}<div class="separator" style="margin:5px"></div>${menuItem('Workspace settings','settings','settings')}${menuItem('Help & keyboard shortcuts','help','help')}`,anchor);}
function editProfile(){modal('A familiar face',`<form id="profile-form">${field('Display name','name',state.me.name,'text','required maxlength="80"')}<div class="notice">This changes your ${state.provider.kind==='local'?'device-local':'Veyra workspace'} profile. It does not change your Microsoft account.</div><div class="row" style="justify-content:flex-end"><button type="submit" class="button primary">Save profile</button></div></form>`,'Make your workspace feel a little more like you.');}
function showHelp(){modal('A little help goes a long way',`<div class="help-grid"><div class="notice"><strong>Veyra 1.1</strong> · Original, framework-free collaboration workspace. Sample people and messages are fictional. Buttons operate on real local data, the self-hosted server, or explicitly connected Microsoft data.</div><h3>Conversations</h3><p><kbd>Enter</kbd> sends a message. <kbd>Shift</kbd> + <kbd>Enter</kbd> adds a new line. Hover a message to react, reply, save, edit, or delete your own messages. Message receipts say “Sent” or “Saved on this device”; Veyra does not invent read receipts.</p><h3>Find your way</h3><p><kbd>Ctrl</kbd>/<kbd>⌘</kbd> + <kbd>K</kbd> opens search. Search covers messages already loaded into this session and available workspace members. Open a conversation to load its history. JSON export includes the server’s full authorized message history.</p><h3>Notes & whiteboards</h3><p>Edits autosave with revision checks. Conflicting versions are never silently merged. Export your recovery draft before reloading another revision. Whiteboard tools draw real geometry; select and drag to move, drag a selection’s lower-right handle to resize, and double-click a sticky note to edit. <kbd>Ctrl</kbd>/<kbd>⌘</kbd> + <kbd>Z</kbd> undoes. Wheel pans; Ctrl/⌘ + wheel zooms.</p><h3>Real calls</h3><p>Use the pre-call device panel to test your microphone level and camera preview. Devices start only after an explicit Test, Enable, or Join action. Retry denied devices after allowing browser/site permissions, or join without devices. Local calls work between tabs on this origin. Live calls require registered room members, HTTPS, and a TURN service for reliable connectivity across networks. Eight-person mesh limit. “Record me” records only your own microphone/camera, with explicit confirmation.</p><h3>Microsoft integration</h3><p>Configure an Entra app registration with the shown SPA redirect URI. Sign in through MSAL; Graph permissions are requested for the actions you use. Personal sign-in is supported, but Teams chat APIs are not available to personal Microsoft accounts. ACS meetings require the included server, a Veyra session, and an administrator-configured ACS resource. You join as an external ACS participant, not as your Teams identity.</p><h3>Your data</h3><p>Local mode stores data in IndexedDB; clearing browser data removes it. Live mode stores data in SQLite and the server’s uploads directory. Export messages and metadata from Settings, and download important files. The browser stores recoverable drafts, personal pins, and appearance settings separately.</p></div>`,'Small details. Clear boundaries. Actual functionality.');}
function runSearch(query){
  const id=++state.searchId;if(!query.trim()){$('#search-results').hidden=true;return;}
  if(searchWorker)searchWorker.postMessage({type:'query',id,query});else{const words=query.toLowerCase().split(/\s+/);const messages=[...state.allMessages.values()].filter(m=>!m.deleted&&words.every(w=>`${m.authorName} ${m.content}`.toLowerCase().includes(w)));renderSearch({id,query,messages:messages.slice(0,20),total:messages.length});}
}
function renderSearch(data){
  if(data.id!==state.searchId)return;const people=state.users.filter(u=>`${u.name} ${u.email||''}`.toLowerCase().includes(data.query.toLowerCase())).slice(0,5),el=$('#search-results');
  el.innerHTML=`<div class="search-label">${data.total} matching loaded messages${people.length?` · ${people.length} people`:''}</div>${people.map(p=>`<button class="search-hit" data-action="search-person" data-id="${E(p.id)}">${avatar(p)}<div class="grow"><h4>${E(p.name)}</h4><small>${E(p.email||p.title||'Workspace member')}${p.status==='sample'?' · fictional sample':''}</small></div></button>`).join('')}${data.messages.map(m=>`<button class="search-hit" data-action="jump-message" data-id="${E(m.id)}" data-room="${E(m.roomId)}">${icon('chat',20)}<div class="grow"><h4>${E(m.authorName||user(m.authorId).name)} · ${E(room(m.roomId)?.name||'Conversation')}</h4><p>${E(m.content.slice(0,200))}</p><small>${E(relativeTime(m.createdAt))}</small></div></button>`).join('')}${!people.length&&!data.messages.length?'<div class="empty-state" style="min-height:140px;padding:25px"><p>No matches. Search only includes loaded messages.</p></div>':''}`;el.hidden=false;
}

function clearDeviceDialog(){
  const session=state.prejoin;state.prejoin=null;state.devicePanel?.dispose();state.devicePanel=null;
  if(session&&!session.transferred){session.media.dispose();if(state.call?.media===session.media)leaveCall(false).catch(()=>{});}
}
function attachPrejoinPanel(session){
  state.devicePanel?.dispose();
  state.devicePanel=new DevicePanel($('#prejoin-devices'),session.media,{onIntent:(kind,enabled)=>{
    const field=$('#call-join-form')?.elements.namedItem(kind);if(field)field.checked=enabled;
    ++session.attempt;const submit=$('#call-join-form [type=submit]');if(submit&&!session.joining)submit.disabled=false;
  }});
}
function prejoin(roomId=state.roomId){
  if(state.provider.kind==='microsoft')return joinTeamsForm();
  if(state.call||state.teamsCall)return toast('Leave the current call before opening another.');
  if(!state.rooms.length)return toast('Create a conversation before starting a call.');
  const selected=room(roomId)||state.rooms[0];
  modal('Ready when you are',`<form id="call-join-form"><label class="field"><span>Conversation</span><select name="roomId">${state.rooms.map(r=>`<option value="${E(r.id)}" ${r.id===selected.id?'selected':''}>${E(r.name)}</option>`).join('')}</select></label><div id="prejoin-devices"></div><label class="checkbox-row"><input name="audio" type="checkbox" checked> Use microphone in this call</label><label class="checkbox-row"><input name="video" type="checkbox"> Use camera in this call</label><div class="notice">${state.provider.kind==='local'?'Local mode connects actual tabs on this device, not other phones or computers. Sample people never join calls.':'Only conversation members can join. Cross-network connectivity depends on your deployment’s TURN service.'}</div><div class="prejoin-actions">${button('Cancel','close-modal','','quiet')}${button('Join without devices','call-join-without','','small')}<button type="submit" class="button primary">${icon('video',16)}Join call</button></div><p class="device-notice" id="prejoin-progress" role="status"></p></form>`,selected.name);
  const session={media:new MediaController(),attempt:0,joining:false,transferred:false};state.prejoin=session;attachPrejoinPanel(session);
}
async function submitCallJoin(form,receiveOnly=false){
  const session=state.prejoin;if(!session||session.joining)return;
  const attempt=++session.attempt,submit=form.querySelector('[type=submit]');submit.disabled=true;
  if(receiveOnly){form.elements.namedItem('audio').checked=false;form.elements.namedItem('video').checked=false;}
  const options={audio:form.elements.namedItem('audio').checked,video:form.elements.namedItem('video').checked};
  const roomId=form.elements.namedItem('roomId').value;
  // Start native capture in this submit/click stack; keep the dialog through permission failures.
  const preparing=session.media.prepare(options);
  $('#prejoin-progress').textContent=options.audio||options.video?'Waiting for selected devices. You can cancel or join without devices.':'Joining without sending microphone or camera…';
  try{
    await preparing;if(state.prejoin!==session||attempt!==session.attempt||session.media.closed)return;
    session.joining=true;$('#prejoin-progress').textContent='Connecting to the conversation…';
    form.querySelectorAll('input,select,button').forEach(el=>{if(el.dataset.action!=='close-modal')el.disabled=true;});
    await startCall(roomId,options,session.media);
    if(state.prejoin!==session||attempt!==session.attempt)return;
    session.transferred=true;$('#modal').close();
  }catch(cause){
    if(state.prejoin!==session||attempt!==session.attempt)return;
    if(session.media.closed){session.media=new MediaController();attachPrejoinPanel(session);formError(cause);}
    else state.devicePanel?.showError(cause);
    $('#prejoin-progress').textContent='Not joined. Retry a device, uncheck the blocked device, or join without devices.';
  }finally{
    if(state.prejoin===session&&attempt===session.attempt){session.joining=false;form.querySelectorAll('input,select,button').forEach(el=>el.disabled=false);state.devicePanel?.update();}
  }
}
function showCallDevices(){
  if(!state.call)return;
  modal('Call devices',`<div id="active-call-devices"></div><div class="row">${button('Export diagnostics','call-diagnostics','download','small')}</div>`,'Changes apply to the active call. No need to hang up.');
  state.devicePanel=new DevicePanel($('#active-call-devices'),state.call.media,{call:state.call});
}
function renderCallParticipants(){
  const target=$('#call-participants');if(!target||!state.call)return;
  const people=[{id:'local',name:state.me.name+' (you)',...state.call.payload(),state:'local'},...[...state.call.peers.values()].map(p=>({...p,state:p.pc.connectionState}))];
  target.innerHTML=people.map(p=>`<div class="call-person">${avatar({name:p.name,color:'#e7dff7'})}<div class="grow"><strong>${E(p.name)}</strong><p>${p.muted?'Microphone off':'Microphone on'} · ${p.camera?'Camera on':'Camera off'} · ${E(p.state)}${p.hand?' · Hand raised':''}${p.screen?' · Sharing screen':''}</p></div>${button(state.focusedPeer===p.id?'Unpin':'Pin','call-pin','pin','small',`data-id="${E(p.id)}"`)}</div>`).join('');
}
function exportCallDiagnostics(){
  const c=state.call;if(!c)return;
  const media=Object.fromEntries(Object.entries(c.media.snapshot()).map(([kind,v])=>[kind,{status:v.status,capturing:v.capturing,interrupted:v.interrupted,errorCode:v.issue?.code||null}]));
  const report={version:'1.1.0',provider:state.provider.kind,secureContext:globalThis.isSecureContext,media,screenCapture:!!navigator.mediaDevices?.getDisplayMedia,statistics:c.stats||null};
  downloadBlob(new Blob([JSON.stringify(report,null,2)],{type:'application/json'}),'veyra-call-diagnostics.json');
}
function callControl(name,label,action,cls=''){return`<button class="call-control ${cls}" data-action="${action}" aria-label="${E(label)}"><span class="control-disc">${icon(name,20)}</span><span>${E(label)}</span></button>`;}
function buildCallOverlay(title,teams=false){
  const overlay=$('#call-overlay');overlay.hidden=false;
  overlay.innerHTML=`<header class="call-top"><div class="grow"><h2>${E(title)}</h2><p id="call-status">${teams?'Starting official ACS meeting connection…':'Opening a real peer-to-peer call…'}</p></div>${button('Copy invite','copy-call-link','link','small')}${ib('close','Leave call','call-leave')}</header><div id="call-media-warning" class="call-media-warning" role="status" hidden></div><div class="call-layout"><div id="call-videos" class="call-videos"></div><aside id="call-chat" class="call-chat" hidden><h3>Conversation chat</h3><div id="call-chat-messages" class="call-chat-messages"></div><form id="call-chat-form" class="call-chat-form"><input name="content" placeholder="Write a message…" aria-label="Call chat message" maxlength="12000" required><button type="submit" aria-label="Send call chat message">${icon('send',17)}</button></form></aside></div><footer><div class="call-controls">${callControl('mic','Mute','call-mic')}${callControl('videoOff','Camera','call-camera')}${callControl('screen','Share','call-screen')}${!teams?callControl('settings','Devices','call-devices')+callControl('teams','People','call-people')+callControl('hand','Raise hand','call-hand')+callControl('chat','Chat','call-chat')+callControl('activity','Record me','call-record'):''}${callControl('calls','Leave','call-leave','leave')}</div><div id="call-stats" class="call-stats">${teams?'Official Azure Communication Services · external participant identity':'WebRTC · encrypted in transit · no simulated participants'}</div></footer>`;
}
function playCallVideo(video){
  const tile=video.closest('.video-tile'),button=tile?.querySelector('[data-action=call-play]');
  if(!button||!video.srcObject?.active)return;
  video.play().then(()=>{button.hidden=true;},()=>{if(video.isConnected)button.hidden=false;});
}
function videoTile(id,name,stream,{self=false,peer=null,screen=false}={}){
  const parent=$('#call-videos');if(!parent||!stream)return;
  let tile=[...parent.children].find(el=>el.dataset.peerId===id);
  if(!tile){
    tile=document.createElement('div');tile.className='video-tile';tile.dataset.peerId=id;
    tile.innerHTML=`<video autoplay playsinline></video><div class="video-placeholder">${avatar({name,color:'#675177'})}</div><button type="button" class="button playback-retry" data-action="call-play" data-id="${E(id)}" hidden>${self?'Play preview':'Tap to play audio/video'}</button><div class="video-label"><span class="video-name"></span><small class="video-state"></small><span class="hand-indicator"></span>${ib('pin','Pin participant','call-pin',`data-id="${E(id)}"`)}</div>`;parent.append(tile);
    const video=tile.querySelector('video');video.muted=self;video.defaultMuted=self;video.playsInline=true;
    video.addEventListener('loadedmetadata',()=>playCallVideo(video));
  }
  const video=tile.querySelector('video');video.muted=self;
  if(video.srcObject!==stream)video.srcObject=stream;
  if(video.paused)playCallVideo(video);video.classList.toggle('screen',screen);
  const hasVideo=stream.getVideoTracks().some(t=>t.readyState==='live'&&t.enabled&&!t.muted);
  const visible=hasVideo&&(self?(screen||state.call?.camera):(peer?.camera!==false||peer?.screen||screen));
  tile.querySelector('.video-placeholder').hidden=visible;
  tile.querySelector('.video-name').textContent=name+(self?' (you)':'');
  tile.querySelector('.video-state').textContent=peer?.muted?'· muted':self&&state.call?.muted?'· muted':'';
  tile.querySelector('.hand-indicator').textContent=peer?.hand||self&&state.call?.hand?'✋':'';
  tile.classList.toggle('focused',state.focusedPeer===id);updateCallRoster();
}
function updateCallRoster(){
  if(!state.call)return;const parent=$('#call-videos');if(!parent)return;
  parent.querySelector('.waiting-tile')?.remove();
  if(!state.call.peers.size){const tile=document.createElement('div');tile.className='waiting-tile';tile.innerHTML=`${icon('teams',29)}<h3>Your space is open.</h3><p>${state.provider.kind==='local'?'Open a second Veyra tab on this device and join the same conversation. Only actual tabs will appear here.':'Share the invite with a conversation member. They can join after signing in to this installation.'}</p>${button('Copy invite','copy-call-link','link','small')}`;parent.append(tile);}
  renderCallParticipants();
  const target=$('#call-status');if(target)target.textContent=`${state.call.peers.size+1} ${state.call.peers.size?'participants':'participant'} · ${state.provider.kind==='local'?'Device-local collaboration':'Live Veyra room'} · ${state.call.muted?'Microphone off':'Microphone on'}`;
}
function updateCallControls(){
  const c=state.call||state.teamsCall;if(!c)return;
  const set=(action,active,name,label)=>{const button=$(`[data-action="${action}"].call-control`);if(button){button.classList.toggle('active',active);button.setAttribute('aria-pressed',String(active));button.setAttribute('aria-label',label);button.innerHTML=`<span class="control-disc">${icon(name,20)}</span><span>${label}</span>`;}};
  set('call-mic',c.muted,c.muted?'micOff':'mic',c.muted?'Unmute':'Mute');set('call-camera',c.camera,'video','Camera');set('call-screen',!!c.screen,'screen',c.screen?'Stop share':'Share');set('call-hand',!!c.hand,'hand',c.hand?'Lower hand':'Raise hand');set('call-record',!!state.recorder,'activity',state.recorder?'Stop record':'Record me');
  const share=$('[data-action=call-screen].call-control');if(share&&!state.teamsCall){share.disabled=!navigator.mediaDevices?.getDisplayMedia;share.title=share.disabled?'Screen sharing is not supported by this browser.':'';}
  if(state.call?.local)videoTile('local',state.me.name,state.call.screen||state.call.local,{self:true,screen:!!state.call.screen});
}
async function startCall(roomId,options,media){
  if(state.call||state.teamsCall)throw new Error('Leave your current call first.');
  const engine=new CallEngine(state.provider,media?{media}:{});state.call=engine;state.callRoom=roomId;buildCallOverlay(room(roomId)?.name||'Veyra call');
  engine.addEventListener('local',e=>{
    if(state.recorder&&state.recordingTracks?.some(t=>t.readyState!=='live'||!engine.local?.getTracks().includes(t)))stopRecording();
    videoTile('local',state.me.name,e.detail.stream,{self:true,screen:e.detail.screen});
  });
  engine.addEventListener('media',e=>{const target=$('#call-media-warning');if(!target)return;const issues=Object.values(e.detail).filter(v=>v.issue||v.interrupted);target.hidden=!issues.length;target.innerHTML=issues.length?`${E(issues.map(v=>v.issue?.title||'A device was interrupted').join('. '))} ${button('Check devices','call-devices','settings','small')}`:'';});
  engine.addEventListener('signaling',e=>{const target=$('#call-media-warning');if(target&&!e.detail.connected){target.hidden=false;target.textContent='Signaling disconnected. Reconnecting; existing media may continue.';}});
  engine.addEventListener('peer',()=>updateCallRoster());
  engine.addEventListener('remote',e=>videoTile(e.detail.peer.id,e.detail.peer.name,e.detail.stream,{peer:e.detail.peer,screen:e.detail.peer.screen}));
  engine.addEventListener('peer-state',e=>{if(e.detail.peer.stream)videoTile(e.detail.peer.id,e.detail.peer.name,e.detail.peer.stream,{peer:e.detail.peer,screen:e.detail.peer.screen});});
  engine.addEventListener('left',e=>{[...($('#call-videos')?.children||[])].find(n=>n.dataset.peerId===e.detail.peerId)?.remove();updateCallRoster();});
  engine.addEventListener('state',updateCallControls);
  engine.addEventListener('joined',()=>{state.callStartedAt=Date.now();updateCallControls();updateCallRoster();});
  engine.addEventListener('error',e=>toast(e.detail.message,'error'));
  engine.addEventListener('stats',e=>{const target=$('#call-stats'),s=e.detail;if(target)target.textContent=`WebRTC · ${s.connected} connected peers · ${Math.round(s.bytesReceived/1024)} KB received · ${Math.round(s.roundTripTime*1000)} ms RTT · ${Math.round(s.receiveKbps)} kb/s · ${Math.round(s.jitter*1000)} ms jitter · ${s.packetsLost} packets lost`;});
  try{await engine.join(roomId,options);renderCallChat();}catch(e){if(state.call===engine)await leaveCall(false);else await engine.dispose();throw e;}
}
function renderCallChat(){const target=$('#call-chat-messages');if(!target||!state.callRoom)return;const near=target.scrollHeight-target.scrollTop-target.clientHeight<60;target.innerHTML=[...state.allMessages.values()].filter(m=>m.roomId===state.callRoom&&!m.deleted).sort((a,b)=>a.createdAt.localeCompare(b.createdAt)).slice(-50).map(m=>`<div class="call-chat-message"><strong>${E(m.authorName||user(m.authorId).name)}</strong>${E(m.content)}</div>`).join('');if(near)target.scrollTop=target.scrollHeight;}
async function leaveCall(saveHistory=true){
  const engine=state.call,teams=state.teamsCall,started=state.callStartedAt;
  if(!engine&&!teams)return;
  if(state.devicePanel?.call===engine){state.devicePanel.dispose();state.devicePanel=null;if($('#modal').open&&!state.prejoin)$('#modal').close();}
  stopRecording();state.focusedPeer=null;state.call=null;state.teamsCall=null;state.callStartedAt=null;$('#call-overlay').hidden=true;$('#call-overlay').innerHTML='';
  if(started&&saveHistory){state.callHistory.push({id:uid(),roomId:state.callRoom,title:teams?'Teams meeting':room(state.callRoom)?.name||'Veyra call',kind:teams?'teams':'veyra',startedAt:started,duration:Date.now()-started});state.callHistory=state.callHistory.slice(-100);saveLocal('callHistory',state.callHistory);}
  state.callRoom=null;await engine?.dispose();await teams?.leave();if(state.route==='calls'&&state.provider)renderCalls();
}
function stopRecording(){if(state.recorder&&state.recorder.state!=='inactive')state.recorder.stop();state.recorder=null;clearTimeout(state.recordingTimer);updateCallControls();}
function toggleRecording(){
  if(state.recorder)return stopRecording();if(!state.call?.local)throw new Error('Join a Veyra call before recording your own media.');
  if(typeof MediaRecorder==='undefined')throw new Error('This browser does not support local recording.');
  const tracks=state.call.local.getTracks().filter(t=>t.readyState==='live'&&t.enabled);if(!tracks.length)throw new Error('Enable your microphone or camera before recording yourself.');
  if(!confirm('Record only your own microphone and camera? Remote participants and shared screens are not included. A recording file will be saved to this device. Recording stops automatically after 30 minutes.'))return;
  const stream=new MediaStream(tracks);state.recordingTracks=tracks;
  const recorder=new MediaRecorder(stream,recordingOptions(MediaRecorder,tracks.some(t=>t.kind==='video'))),chunks=[];recorder.ondataavailable=e=>{if(e.data.size)chunks.push(e.data);};recorder.onerror=()=>{toast('Local recording stopped because the browser could not continue.','error');stopRecording();};recorder.onstop=()=>{if(state.recorder===recorder){state.recorder=null;clearTimeout(state.recordingTimer);updateCallControls();}downloadBlob(new Blob(chunks,{type:recorder.mimeType}),`veyra-self-recording-${Date.now()}.${recordingExtension(recorder.mimeType)}`);};recorder.start(1000);state.recorder=recorder;state.recordingTimer=setTimeout(stopRecording,30*60000);updateCallControls();toast('Recording only your own microphone and camera.');
}
function joinTeamsForm(link=''){
  modal('Join a Microsoft Teams meeting',`<form id="teams-join-form">${field('Teams meeting link','link',link,'url','required placeholder="https://teams.microsoft.com/l/meetup-join/…"')}${field('Guest display name','name',state.me.name,'text','required maxlength="80"')}<label class="checkbox-row"><input type="checkbox" name="audio" checked> Turn on microphone when I join</label><label class="checkbox-row"><input type="checkbox" name="video"> Turn on camera when I join</label><div class="notice"><strong>Supported ACS interop, not a private protocol clone.</strong><br>You join as an external Azure Communication Services participant, not as your signed-in Teams identity. The organizer may need to admit you from the lobby. Tenant policies can prevent entry. The meeting’s Teams chat is not provided by this adapter.</div><div class="notice warning">Requires a live Veyra server session, configured ACS_CONNECTION_STRING, and the official browser calling SDKs. Sign in to the live workspace first; Microsoft Graph sign-in alone does not create an ACS token.</div><div class="row" style="justify-content:flex-end"><button type="submit" class="button primary">${microsoftLogo}Join through ACS</button></div></form>`,'Your meeting stays hosted by Microsoft Teams.');
}
async function startTeamsMeeting(data){
  if(state.call||state.teamsCall)throw new Error('Leave your current call first.');
  const {TeamsMeeting}=await import('./integrations/teams-calling.js');
  const tokenProvider=async()=>{const p=new ServerProvider();return(await p.request('/acs/token',{method:'POST',body:'{}'})).token;};
  const meeting=new TeamsMeeting({tokenProvider,displayName:data.name});state.teamsCall=meeting;state.teamsLink=data.link;buildCallOverlay('Microsoft Teams meeting',true);
  meeting.addEventListener('state',e=>{if($('#call-status'))$('#call-status').textContent=`${e.detail.state} · External ACS participant`;if(e.detail.state==='Connected'&&!state.callStartedAt)state.callStartedAt=Date.now();if(e.detail.state==='Disconnected')leaveCall().catch(()=>{});updateCallControls();});
  meeting.addEventListener('participant',e=>{
    const parent=$('#call-videos');if(!parent)return;const d=e.detail;let tile=[...parent.children].find(n=>n.dataset.peerId===d.id);if(!tile){tile=document.createElement('div');tile.className='video-tile';tile.dataset.peerId=d.id;tile.innerHTML=`${avatar({name:d.name,color:'#675177'})}<div class="video-label">${E(d.name)}</div>`;parent.append(tile);}if(d.view===null)tile.querySelector('.acs-view')?.remove();if(d.view){tile.querySelector('.acs-view')?.remove();d.view.classList.add('acs-view');tile.prepend(d.view);}
  });
  meeting.addEventListener('participant-left',e=>{[...($('#call-videos')?.children||[])].find(n=>n.dataset.peerId===e.detail.id)?.remove();});meeting.addEventListener('error',e=>toast(e.detail.message,'error'));
  try{await meeting.join(data.link,{audio:data.audio,video:data.video});updateCallControls();}catch(e){if(state.teamsCall===meeting)await leaveCall(false);else await meeting.leave();throw e;}
}

async function sendComposer(){
  const input=$('#composer-input');if(!input)return;
  const provider=state.provider,roomId=state.roomId,content=input.value.trim(),attachments=[...state.attachments];if(!content&&!attachments.length)return;
  if(state.edit){const id=state.edit.id;await provider.edit(id,content);state.edit=null;state.reply=null;input.value='';saveLocal(`draft.${roomId}`,'',provider);renderComposerContext();return;}
  const message={id:uid(),roomId,content,replyTo:state.reply?.id||null,attachments,createdAt:new Date().toISOString(),failed:false};
  const queue=readLocal('outbox',[],provider);queue.push(message);saveLocal('outbox',queue,provider);
  input.value='';input.style.height='';state.attachments=[];state.reply=null;saveLocal(`draft.${roomId}`,'',provider);renderComposerContext();renderFeed(true);
  await deliver(message,provider);
}
async function deliver(message,provider=state.provider){
  try{
    const saved=await provider.send(message);saveLocal('outbox',readLocal('outbox',[],provider).filter(m=>m.id!==message.id),provider);
    if(provider===state.provider){upsertMessage(saved);renderFeed(true);renderSidebar();renderDetails();}
  }catch(e){const queue=readLocal('outbox',[],provider).map(m=>m.id===message.id?{...m,failed:true}:m);saveLocal('outbox',queue,provider);if(provider===state.provider){renderFeed();toast(`Message not sent: ${e.message}`,'error');}}
}
async function uploadFiles(files,intent='compose',targetRoom=state.roomId){
  if(!targetRoom)throw new Error('Choose a conversation before uploading.');
  const provider=state.provider;let count=0;
  for(const file of files){if(file.size>MAX_FILE_SIZE){toast(`${file.name} exceeds the 10 MB limit.`,'error');continue;}if(intent==='compose'&&state.attachments.length>=8){toast('Attach up to eight files per message.','error');break;}const metadata=await provider.upload(file,targetRoom);count++;if(intent==='compose'&&provider===state.provider&&targetRoom===state.roomId)state.attachments.push(metadata);}
  if(provider!==state.provider)return;
  if(intent==='compose')renderComposerContext();else if(state.route==='files'||state.tab==='files')await renderFiles(state.route==='chat');renderDetails();if(count)toast(`${count} ${count===1?'file':'files'} uploaded${intent==='compose'?' · ready to send':''}.`);
}
async function downloadFile(id){
  let file=[...(state.files||[]),...(state.detailFiles||[]),...state.messages.flatMap(m=>m.attachments||[])].find(f=>f.id===id);
  if(!file)file=(await state.provider.files()).find(f=>f.id===id);if(!file)throw new Error('This file is no longer available.');
  const data=await state.provider.download(file);if(data instanceof Blob)downloadBlob(data,file.name||'download');else if(data?.url&&safeURL(data.url)){const a=document.createElement('a');a.href=data.url;a.target='_blank';a.rel='noopener noreferrer';a.click();}else throw new Error('The provider did not return a valid file.');
}
async function jumpMessage(id,roomId){await navigate('chat',roomId,'chat');const index=state.messages.findIndex(m=>m.id===id);if(index>=0&&state.messages.length-index>state.limit){state.limit=state.messages.length-index+5;renderFeed();}const node=$$('[data-message-id]').find(el=>el.dataset.messageId===id);if(node){node.scrollIntoView({block:'center',behavior:'smooth'});node.classList.add('flash-highlight');node.focus({preventScroll:true});}else toast('This message is outside the loaded history window.');}
async function microsoftSignIn(){
  const config=readConfig();if(!config.microsoftClientId){showSettings();formError(new Error('Enter and save your Microsoft application client ID first.'));return;}
  const {MicrosoftProvider}=await import('./integrations/microsoft.js');const provider=await new MicrosoftProvider(config).init(true);$('#modal').close();await activateProvider(provider);toast(provider.personal?'Microsoft account signed in. Teams chat APIs require a work or school account.':'Microsoft workspace connected.');
}
function applyTheme(value=localStorage.getItem('veyra.theme')||'light'){localStorage.setItem('veyra.theme',value);document.documentElement.dataset.theme=value==='system'?(matchMedia('(prefers-color-scheme:dark)').matches?'dark':'light'):value;}

async function action(name,el){
  const id=el.dataset.id,value=el.dataset.value;
  switch(name){
    case'nav':return navigate(value==='board'?'chat':value,state.roomId,value==='board'?'board':'chat');
    case'room':return navigate('chat',id,'chat');
    case'tab':return navigate('chat',state.roomId,value);
    case'refresh':return navigate(state.route,state.roomId,state.tab);
    case'settings':return showSettings();case'help':return showHelp();case'profile':return profileMenu(el);
    case'close-modal':return $('#modal').close();
    case'toggle-sidebar':return $('#sidebar').classList.toggle('open');
    case'toggle-details':state.details=!state.details;{const panel=$('#details-panel');if(panel){panel.style.display=state.details?'':'none';panel.classList.toggle('force-visible',state.details&&innerWidth<=1250);}}return;
    case'filter':state.filter=value;return renderSidebar();
    case'sidebar-filter':{const input=$('#sidebar-filter');input.hidden=!input.hidden;if(!input.hidden)input.focus();return;}
    case'new-chat':return newRoom('group');case'new-channel':return newRoom('channel');case'members':return showMembers();
    case'favorite':{const r=room(id);if(!r)return;const saved=await state.provider.updateRoom(id,{favorite:!r.favorite});Object.assign(r,saved);renderSidebar();const star=$('.conversation-header [data-action=favorite]');star?.classList.toggle('active',!!r.favorite);return;}
    case'format':{const input=$('#composer-input');if(!input)return;const {selectionStart:a,selectionEnd:b}=input;input.setRangeText(`**${input.value.slice(a,b)||'bold text'}**`,a,b,'select');input.focus();input.dispatchEvent(new Event('input',{bubbles:true}));return;}
    case'emoji':return popover(`<div class="emoji-grid">${emojis.map(e=>`<button class="emoji-button" data-action="insert-emoji" data-emoji="${E(e)}" aria-label="Insert ${E(e)}">${e}</button>`).join('')}</div>`,el);
    case'insert-emoji':{const input=$('#composer-input');if(input){input.setRangeText(el.dataset.emoji,input.selectionStart,input.selectionEnd,'end');input.focus();input.dispatchEvent(new Event('input',{bubbles:true}));}hidePopover();return;}
    case'attach':case'upload-files':{const input=$('#file-input');input.dataset.intent=name==='attach'?'compose':'files';input.dataset.roomId=state.roomId||state.rooms[0]?.id||'';input.value='';input.click();return;}
    case'remove-attachment':state.attachments=state.attachments.filter(f=>f.id!==id);return renderComposerContext();
    case'cancel-reply':state.reply=null;if(state.edit){state.edit=null;$('#composer-input').value=readLocal(`draft.${state.roomId}`,'');}return renderComposerContext();
    case'reply':state.reply=findMessage(id);state.edit=null;renderComposerContext();$('#composer-input')?.focus();return;
    case'react':return popover(`<div class="emoji-grid">${emojis.map(e=>`<button class="emoji-button" data-action="react-direct" data-id="${E(id)}" data-emoji="${E(e)}" aria-label="React ${E(e)}">${e}</button>`).join('')}</div>`,el);
    case'react-direct':hidePopover();{const m=await state.provider.react(id,el.dataset.emoji);upsertMessage(m);renderFeed();return;}
    case'message-menu':{const m=findMessage(id);if(!m)return;const own=m.authorId===state.me.id;return popover(menuItem('Copy message','copy-message','copy',`data-id="${E(id)}"`)+menuItem('Reply','reply','reply',`data-id="${E(id)}"`)+menuItem('Save for yourself','bookmark','bookmark',`data-id="${E(id)}"`)+menuItem('Pin in your details','pin-message','pin',`data-id="${E(id)}"`)+(own?menuItem('Edit message','edit-message','edit',`data-id="${E(id)}"`)+menuItem('Delete message','delete-message','trash',`data-id="${E(id)}"`,true):''),el);}
    case'copy-message':hidePopover();return copy(findMessage(id)?.content||'');
    case'bookmark':{const saved=new Set(readLocal('bookmarks',[]));saved.has(id)?saved.delete(id):saved.add(id);saveLocal('bookmarks',[...saved]);hidePopover();toast(saved.has(id)?'Saved for you · find it in Activity → Saved.':'Removed from your saved messages.');return;}
    case'pin-message':saveLocal(`pinned.${state.roomId}`,id);hidePopover();renderDetails();toast('Pinned privately in your conversation details.');return;
    case'edit-message':state.edit=findMessage(id);state.reply=null;hidePopover();$('#composer-input').value=state.edit.content;renderComposerContext();$('#composer-input').focus();return;
    case'delete-message':hidePopover();if(confirm('Delete your message? This cannot be undone.')){const m=await state.provider.deleteMessage(id);upsertMessage(m);renderFeed();}return;
    case'retry-send':{const m=readLocal('outbox',[]).find(m=>m.id===id);if(m){if(state.provider.kind==='microsoft'&&!confirm('Microsoft Graph does not provide a send idempotency key. A retry after an ambiguous network error can duplicate a message. Retry?'))return;return deliver(m);}return;}
    case'discard-send':saveLocal('outbox',readLocal('outbox',[]).filter(m=>m.id!==id));renderFeed();return;
    case'load-older':{const scroll=$('#message-scroll'),height=scroll.scrollHeight,top=scroll.scrollTop;state.limit+=100;renderFeed();scroll.scrollTop=top+scroll.scrollHeight-height;return;}
    case'download-file':return downloadFile(id);
    case'open-board':return navigate('chat',state.roomId,'board');
    case'board-tool':state.board?.setTool(value);$$('[data-action=board-tool]').forEach(b=>b.classList.toggle('active',b.dataset.value===value));return;
    case'board-undo':return state.board?.undo();case'board-redo':return state.board?.redo();case'board-delete':return state.board?.deleteSelected();case'board-zoom-in':return state.board?.zoom(1.2);case'board-zoom-out':return state.board?.zoom(1/1.2);case'board-fit':return state.board?.fit();
    case'doc-save':return state.doc?.flush();
    case'doc-reload':if(state.doc&&(state.doc.dirty||state.doc.conflict)&&!confirm('Discard this device’s recovery draft and reload the current shared revision? Export your draft first to keep it.'))return;return state.doc?.reload();
    case'doc-export':if(!state.doc)return;if(state.doc.kind==='board'&&state.board)downloadBlob(new Blob([state.board.toSVG()],{type:'image/svg+xml'}),'veyra-whiteboard.svg');else downloadBlob(new Blob([state.doc.value.text],{type:'text/plain;charset=utf-8'}),'veyra-notes.txt');return;
    case'activity-filter':state.activityFilter=value;return renderActivity();
    case'mark-all-read':state.unread=new Map(state.rooms.map(r=>[r.id,0]));saveLocal('unread',Object.fromEntries(state.unread));renderSidebar();renderRail();renderActivity();toast('Your local unread counters are cleared.');return;
    case'jump-message':return jumpMessage(id,el.dataset.room);
    case'search-person':{const existing=state.rooms.find(r=>r.type==='direct'&&r.members?.includes(id)&&r.members.includes(state.me.id));$('#search-results').hidden=true;if(existing)return navigate('chat',existing.id);return newRoom('group',id);}
    case'calendar-prev':state.calendarOffset--;return renderCalendar();case'calendar-next':state.calendarOffset++;return renderCalendar();case'calendar-today':state.calendarOffset=0;return renderCalendar();case'calendar-view':state.calendarView=state.calendarView==='week'?'agenda':'week';return renderCalendar();
    case'calendar-sync':state.events=await state.provider.calendar(true);return renderCalendar();
    case'new-event':return eventForm();case'event-details':return eventDetails(id);case'edit-event':return eventForm(state.events.find(e=>e.id===id));case'export-event':return exportEvent(state.events.find(e=>e.id===id));
    case'delete-event':if(confirm('Delete this calendar entry?')){await state.provider.deleteEvent(id);state.events=state.events.filter(e=>e.id!==id);$('#modal').close();if(state.route==='calendar')renderCalendar();}return;
    case'join-event':{const e=state.events.find(e=>e.id===id);if(!e)return;$('#modal').close();if(e.joinUrl){const url=new URL(e.joinUrl);if(['teams.microsoft.com','teams.cloud.microsoft','teams.live.com'].includes(url.hostname))return joinTeamsForm(e.joinUrl);if(safeURL(e.joinUrl)){window.open(e.joinUrl,'_blank','noopener,noreferrer');return;}}return prejoin(e.roomId||state.roomId);}
    case'call-join-without':return submitCallJoin($('#call-join-form'),true);
    case'call-devices':return showCallDevices();
    case'call-diagnostics':return exportCallDiagnostics();
    case'call-people':if(state.call){modal('People in this call','<div id="call-participants"></div>','Only actual connected participants are listed.');renderCallParticipants();}return;
    case'call-pin':state.focusedPeer=state.focusedPeer===id?null:id;for(const tile of $$('#call-videos .video-tile'))tile.classList.toggle('focused',tile.dataset.peerId===state.focusedPeer);renderCallParticipants();return;
    case'call-play':{const video=[...($('#call-videos')?.children||[])].find(n=>n.dataset.peerId===id)?.querySelector('video');if(video)playCallVideo(video);return;}
    case'start-call':return prejoin();case'call-room':return prejoin(id);case'join-teams':return joinTeamsForm();
    case'copy-call-link':return copy(state.teamsCall?state.teamsLink:new URL(`./#call=${encodeURIComponent(state.callRoom)}`,location.href).href);
    case'call-mic':{const c=state.call||state.teamsCall;if(c)await c.setMuted(!c.muted);return updateCallControls();}
    case'call-camera':{const c=state.call||state.teamsCall;if(c)await c.setCamera(!c.camera);return updateCallControls();}
    case'call-screen':await(state.call||state.teamsCall)?.shareScreen();return updateCallControls();
    case'call-hand':if(state.call){state.call.hand=!state.call.hand;await state.call.state();}return;
    case'call-chat':$('#call-chat').hidden=!$('#call-chat').hidden;renderCallChat();return;
    case'call-record':return toggleRecording();case'call-leave':return leaveCall();
    case'use-local':$('#modal').close();if(state.provider.kind!=='local')await activateProvider(await new LocalProvider().init());return;
    case'workspace-login':return authForm('login');case'workspace-auth-mode':return authForm(value);
    case'workspace-logout':await leaveCall();await state.provider.logout();$('#modal').close();await activateProvider(await new LocalProvider().init());return;
    case'microsoft-login':return microsoftSignIn();case'microsoft-logout':await state.provider.logout();$('#modal').close();await activateProvider(await new LocalProvider().init());return;
    case'copy-redirect':return copy(new URL('./auth.html',location.href).href.split('#')[0]);
    case'edit-profile':return editProfile();
    case'set-status':hidePopover();state.me=await state.provider.setProfile({status:value});renderTopbar();return;
    case'notifications':{if(readLocal('notifications',false)){saveLocal('notifications',false);showSettings();return;}if(typeof Notification==='undefined')throw new Error('This browser does not support desktop notifications.');const permission=await Notification.requestPermission();if(permission==='granted'){saveLocal('notifications',true);toast('Notifications enabled for this workspace.');showSettings();}else toast('Notifications are not permitted. Change browser site permissions to enable them.');return;}
    case'export-workspace':{const snapshot=await state.provider.export();downloadBlob(new Blob([JSON.stringify(snapshot,null,2)],{type:'application/json'}),`veyra-${state.provider.kind}-export.json`);toast('Exported messages and metadata. File contents are downloaded separately.');return;}
    default:console.warn('Unknown Veyra action',name);
  }
}

document.addEventListener('click',event=>{
  const el=event.target.closest('[data-action]');if(el&&!el.disabled){event.preventDefault();Promise.resolve(action(el.dataset.action,el)).catch(error=>{$('#modal').open?formError(error):toast(error.message,'error');});}
  if(!event.target.closest('#popover')&&!event.target.closest('[data-action=profile],[data-action=emoji],[data-action=react],[data-action=message-menu]'))hidePopover();
  if(!event.target.closest('#search-results,.global-search'))$('#search-results').hidden=true;
});
document.addEventListener('submit',async event=>{
  // Read the attribute: an input named 'id' shadows HTMLFormElement.id.
  const form=event.target;if(!(form instanceof HTMLFormElement))return;event.preventDefault();const data=new FormData(form),object=Object.fromEntries(data),submit=form.querySelector('[type=submit]');
  if(submit)submit.disabled=true;
  try{
    if(form.getAttribute('id')==='compose-form')await sendComposer();
    else if(form.getAttribute('id')==='new-room-form'){const members=data.getAll('members');let type=object.type;if(type==='group'&&members.length===1)type='direct';const r=await state.provider.createRoom(object.name,type,members);if(!state.rooms.some(x=>x.id===r.id))state.rooms.push(r);$('#modal').close();await navigate('chat',r.id);}
    else if(form.getAttribute('id')==='workspace-auth-form'){const provider=await new ServerProvider().authenticate(object.mode,{email:object.email,password:object.password,name:object.name});form.querySelector('[name=password]').value='';$('#modal').close();await activateProvider(provider);toast('Connected to your live workspace.');}
    else if(form.getAttribute('id')==='microsoft-config-form'){saveConfig(object);toast('Public Microsoft app configuration saved.');}
    else if(form.getAttribute('id')==='profile-form'){state.me=await state.provider.setProfile({name:object.name});$('#modal').close();renderTopbar();renderFeed();toast('Profile updated.');}
    else if(form.getAttribute('id')==='event-form'){const input={...object,id:object.id||undefined,start:new Date(object.start).toISOString(),end:new Date(object.end).toISOString()};const saved=await state.provider.saveEvent(input);const i=state.events.findIndex(e=>e.id===saved.id);if(i<0)state.events.push(saved);else state.events[i]=saved;$('#modal').close();if(state.route==='calendar')renderCalendar();else renderDetails();toast('Meeting saved to the calendar.');}
    else if(form.getAttribute('id')==='call-join-form'){await submitCallJoin(form);}
    else if(form.getAttribute('id')==='teams-join-form'){await startTeamsMeeting({link:object.link,name:object.name,audio:data.has('audio'),video:data.has('video')});$('#modal').close();}
    else if(form.getAttribute('id')==='call-chat-form'){const content=object.content.trim();if(content){const saved=await state.provider.send({id:uid(),roomId:state.callRoom,content,attachments:[]});upsertMessage(saved);form.reset();renderCallChat();}}
  }catch(e){if($('#modal').open)formError(e);else toast(e.message,'error');}
  finally{if(submit&&form.getAttribute('id')!=='call-join-form')submit.disabled=false;}
});
document.addEventListener('input',event=>{
  const el=event.target;
  if(el.id==='composer-input'){saveLocal(`draft.${state.roomId}`,el.value);el.style.height='auto';el.style.height=`${Math.min(150,el.scrollHeight)}px`;if(Date.now()-state.typingLast>1800){state.typingLast=Date.now();state.provider.typing?.(state.roomId);}}
  else if(el.id==='global-search')runSearch(el.value);
  else if(el.id==='sidebar-filter'){state.sidebarQuery=el.value;const caret=el.selectionStart;renderSidebar();const input=$('#sidebar-filter');input.hidden=false;input.focus();input.setSelectionRange(caret,caret);}
  else if(el.id==='notes-editor')state.doc?.update({text:el.value});
  else if(el.id==='board-color'&&state.board)state.board.color=el.value;
});
document.addEventListener('change',event=>{const el=event.target;if(el.closest('#call-join-form')&&['audio','video'].includes(el.name)&&state.devicePanel){Promise.resolve(state.devicePanel.enable(el.name,el.checked)).catch(e=>state.devicePanel?.showError(e));}if(el.id==='file-input')uploadFiles([...el.files],el.dataset.intent,el.dataset.roomId).catch(e=>toast(e.message,'error'));if(el.id==='theme-select')applyTheme(el.value);});
document.addEventListener('keydown',event=>{
  if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='k'){event.preventDefault();$('#global-search')?.focus();$('#global-search')?.select();}
  if(event.target.id==='composer-input'&&event.key==='Enter'&&!event.shiftKey&&!event.isComposing){event.preventDefault();$('#compose-form').requestSubmit();}
  if(event.key==='Escape'){hidePopover();$('#search-results').hidden=true;$('#sidebar').classList.remove('open');}
});
document.addEventListener('dblclick',event=>{const day=event.target.closest('.calendar-day');if(day&&!event.target.closest('.calendar-event')){const offset=event.clientY-day.getBoundingClientRect().top,hour=Math.min(17,Math.max(9,9+Math.floor(offset/65))),d=new Date(day.dataset.date+'T'+String(hour).padStart(2,'0')+':00:00');eventForm(null,d.toISOString());}});
for(const type of ['dragenter','dragover','dragleave','drop'])document.addEventListener(type,event=>{
  const target=event.target.closest('[data-dropzone],.composer');if(!target)return;
  if(![...event.dataTransfer?.types||[]].includes('Files'))return;event.preventDefault();target.classList.toggle('dragging',type==='dragenter'||type==='dragover');
  if(type==='drop'){target.classList.remove('dragging');uploadFiles([...event.dataTransfer.files],target.matches('.composer')?'compose':'files',state.roomId).catch(e=>toast(e.message,'error'));}
});
$('#modal').addEventListener('close',()=>{if(!$('#modal').open)clearDeviceDialog();});
$('#modal').addEventListener('click',event=>{if(event.target===$('#modal')){const r=$('#modal').getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)$('#modal').close();}});
window.addEventListener('beforeunload',event=>{if(state.doc?.dirty||state.doc?.saving||state.call||state.teamsCall){event.preventDefault();event.returnValue='';}});
window.addEventListener('pageshow',event=>{if(event.persisted&&state.call?.closed)leaveCall(false).catch(()=>{});});
window.addEventListener('pagehide',()=>{clearDeviceDialog();state.call?.dispose();state.teamsCall?.leave();});
matchMedia('(prefers-color-scheme:dark)').addEventListener('change',()=>{if(localStorage.getItem('veyra.theme')==='system')applyTheme('system');});
Object.defineProperty(window,'veyraDiagnostics',{get:()=>({version:'1.1.0',provider:state.provider?.kind,roomId:state.roomId,messages:state.messages.length,loadedMessages:state.allMessages.size,renderer:state.board?.renderer.mode||'DOM',shapes:state.board?.shapes.length||0,renderedFrames:state.board?.renderer.frames||0,vertexCount:(state.board?.renderer.vertices.length||0)/6,gpuUploads:state.board?.renderer.uploads||0,callPeers:state.call?.peers.size||0,camera:state.call?.camera||false,muted:state.call?.muted??true,prejoinMedia:state.prejoin?.media.snapshot()||null,callState:state.call?.roomId?'joined':state.teamsCall?.call?.state||'idle',rtcBytesReceived:state.call?.stats?.bytesReceived||0,docVersion:state.doc?.version||0,docDirty:!!state.doc?.dirty,docConflict:!!state.doc?.conflict})});

async function boot(){
  applyTheme();let provider;const mode=localStorage.getItem('veyra.mode');
  try{
    if(mode==='server')provider=await new ServerProvider().init();
    else if(mode==='microsoft'&&readConfig().microsoftClientId){const {MicrosoftProvider}=await import('./integrations/microsoft.js');provider=await new MicrosoftProvider(readConfig()).init(false);}
  }catch(e){console.info('Veyra connection not restored:',e.message);toast('Your connection needs attention. Opening the local workspace.');}
  provider||=await new LocalProvider().init();await activateProvider(provider);
  const callMatch=location.hash.match(/^#call=(.+)$/);if(callMatch){const id=decodeURIComponent(callMatch[1]);if(room(id))prejoin(id);else toast('Sign in to the workspace and join this conversation before using its call link.');}
}
boot().catch(e=>{$('#main').innerHTML=empty('The workspace could not open',`${e.message} Enable browser storage and serve the app through HTTP or HTTPS.`,'info',button('Reload','refresh','refresh'));console.error(e);});
