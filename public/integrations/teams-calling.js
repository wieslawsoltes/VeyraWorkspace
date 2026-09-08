import {readConfig} from '../config.js';
/** Official ACS Teams guest adapter. SDK instances and rendering views have explicit lifetimes. */
export class TeamsMeeting extends EventTarget {
  constructor({tokenProvider,displayName='Veyra participant',loadSDKs}={}){
    super();if(typeof tokenProvider!=='function')throw new Error('A server-backed ACS token provider is required.');
    this.tokenProvider=tokenProvider;this.displayName=String(displayName).slice(0,80);this.loadSDKs=loadSDKs;
    this.renderers=new Map();this.subscriptions=[];this.participants=new Map();this.identities=new WeakMap();this.muted=true;this.camera=false;this.screen=false;this.closed=false;this.generation=0;
  }
  emit(type,detail){if(!this.closed)this.dispatchEvent(new CustomEvent(type,{detail}));}
  listen(object,name,handler){object.on(name,handler);this.subscriptions.push(()=>object.off(name,handler));}
  identity(participant){if(!this.identities.has(participant)){const id=participant.identifier?.microsoftTeamsUserId||participant.identifier?.communicationUserId||participant.identifier?.rawId||crypto.randomUUID();this.identities.set(participant,id);}return this.identities.get(participant);}
  ensureOpen(generation){if(this.closed||generation!==this.generation)throw new Error('The meeting join was canceled.');}
  async join(meetingLink,{audio=true,video=false}={}){
    const url=new URL(meetingLink);
    if(url.protocol!=='https:'||url.username||url.password||!['teams.microsoft.com','teams.cloud.microsoft'].includes(url.hostname))throw new Error('Enter a Microsoft Teams work/school meeting HTTPS link. Teams consumer meetings and sovereign cloud endpoints are not supported by this adapter.');
    const generation=++this.generation,config=readConfig();
    const [calling,common]=this.loadSDKs?await this.loadSDKs():await Promise.all([
      config.useBundledSDKs?import('../vendor/acs-calling.js'):import('https://esm.sh/@azure/communication-calling@1.39.1?bundle'),
      config.useBundledSDKs?import('../vendor/acs-common.js'):import('https://esm.sh/@azure/communication-common@2.4.0?bundle')
    ]);
    this.ensureOpen(generation);this.sdk=calling;
    const initialToken=await this.tokenProvider();this.ensureOpen(generation);
    if(typeof initialToken!=='string'||!initialToken)throw new Error('The ACS broker returned an invalid token.');
    this.credential=new common.AzureCommunicationTokenCredential({token:initialToken,tokenRefresher:async()=>{if(this.closed)throw new Error('Meeting closed.');return this.tokenProvider();},refreshProactively:true});
    this.client=new calling.CallClient();this.manager=await this.client.getDeviceManager();this.ensureOpen(generation);
    const agent=await this.client.createCallAgent(this.credential,{displayName:this.displayName});if(this.closed||generation!==this.generation){await agent.dispose();throw new Error('The meeting join was canceled.');}this.agent=agent;
    if(audio||video){const permissions=await this.manager.askDevicePermission({audio,video});this.ensureOpen(generation);if(audio&&!permissions.audio)throw new Error('Microphone permission was not granted.');if(video&&!permissions.video)throw new Error('Camera permission was not granted.');}
    if(video){const cameras=await this.manager.getCameras();this.ensureOpen(generation);if(!cameras.length)throw new Error('No camera is available.');this.localVideo=new calling.LocalVideoStream(cameras[0]);}
    this.muted=!audio;this.camera=video;
    this.call=this.agent.join({meetingLink:url.href},{audioOptions:{muted:!audio},...(this.localVideo?{videoOptions:{localVideoStreams:[this.localVideo]}}:{})});
    this.listen(this.call,'stateChanged',()=>this.emit('state',{state:this.call.state,reason:this.call.callEndReason}));
    this.listen(this.call,'isMutedChanged',()=>{this.muted=this.call.isMuted;this.emit('state',{state:this.call.state});});
    this.listen(this.call,'isScreenSharingOnChanged',()=>{this.screen=this.call.isScreenSharingOn;this.emit('state',{state:this.call.state});});
    this.listen(this.call,'remoteParticipantsUpdated',({added,removed})=>{added.forEach(p=>this.addParticipant(p));removed.forEach(p=>this.removeParticipant(p));});
    this.call.remoteParticipants.forEach(p=>this.addParticipant(p));
    this.emit('participant',{id:'local',name:`${this.displayName} (you)`,view:null});
    if(this.localVideo)await this.render('local','local',`${this.displayName} (you)`,this.localVideo);
    this.emit('state',{state:this.call.state});
  }
  addParticipant(participant){
    const id=this.identity(participant);if(this.participants.has(id))return;this.participants.set(id,participant);
    this.emit('participant',{id,name:participant.displayName||'Teams participant'});
    this.listen(participant,'videoStreamsUpdated',({added,removed})=>{added.forEach(stream=>this.observeVideo(participant,stream));removed.forEach(stream=>this.removeStream(`${id}:${stream.id}`,id));});
    this.listen(participant,'isMutedChanged',()=>this.emit('participant',{id,name:participant.displayName||'Teams participant',muted:participant.isMuted}));
    participant.videoStreams.forEach(stream=>this.observeVideo(participant,stream));
  }
  observeVideo(participant,stream){
    const id=this.identity(participant),key=`${id}:${stream.id}`;
    const update=()=>{if(stream.isAvailable)this.render(key,id,participant.displayName||'Teams participant',stream).catch(e=>this.emit('error',{message:e.message}));else this.removeStream(key,id);};
    this.listen(stream,'isAvailableChanged',update);update();
  }
  async render(key,id,name,stream){
    if(this.closed||this.renderers.has(key))return;
    const renderer=new this.sdk.VideoStreamRenderer(stream);this.renderers.set(key,renderer);
    try{const view=await renderer.createView({scalingMode:'Crop'});if(this.closed||this.renderers.get(key)!==renderer){view.dispose?.();return;}this.emit('participant',{id,name,view:view.target});}
    catch(error){renderer.dispose();this.renderers.delete(key);throw error;}
  }
  removeStream(key,id){const renderer=this.renderers.get(key);if(!renderer)return;renderer.dispose();this.renderers.delete(key);this.emit('participant',{id,name:id==='local'?`${this.displayName} (you)`:this.participants.get(id)?.displayName||'Teams participant',view:null});}
  removeParticipant(participant){const id=this.identity(participant);this.participants.delete(id);for(const key of [...this.renderers.keys()])if(key.startsWith(id+':'))this.removeStream(key,id);this.emit('participant-left',{id});}
  async setMuted(muted){if(!this.call)throw new Error('The meeting has not connected yet.');if(muted)await this.call.mute();else await this.call.unmute();this.muted=muted;this.emit('state',{state:this.call.state});}
  async setCamera(enabled){
    if(!this.call)throw new Error('The meeting has not connected yet.');
    if(enabled){if(!this.localVideo){const permissions=await this.manager.askDevicePermission({video:true});if(!permissions.video)throw new Error('Camera permission was not granted.');const camera=(await this.manager.getCameras())[0];if(!camera)throw new Error('No camera is available.');this.localVideo=new this.sdk.LocalVideoStream(camera);}await this.call.startVideo(this.localVideo);this.camera=true;await this.render('local','local',`${this.displayName} (you)`,this.localVideo);}
    else if(this.localVideo){await this.call.stopVideo(this.localVideo);this.camera=false;this.removeStream('local','local');}
    this.emit('state',{state:this.call.state});
  }
  async shareScreen(){if(!this.call)throw new Error('The meeting has not connected yet.');if(this.call.isScreenSharingOn)await this.call.stopScreenSharing();else await this.call.startScreenSharing();this.screen=this.call.isScreenSharingOn;this.emit('state',{state:this.call.state});}
  async leave(){
    if(this.closed)return;this.closed=true;++this.generation;
    for(const off of this.subscriptions.splice(0)){try{off();}catch{}}
    try{if(this.call&&this.call.state!=='Disconnected')await this.call.hangUp({forEveryone:false});}
    finally{for(const renderer of this.renderers.values())renderer.dispose();this.renderers.clear();this.participants.clear();await this.agent?.dispose();this.credential?.dispose();this.client?.dispose?.();this.call=null;this.agent=null;this.localVideo=null;}
  }
}
