import {MAX_CALL_PEERS, error} from './model.js';
/** Authenticated signaling + actual RTCPeerConnections. A bounded mesh, not an SFU. */
export class CallEngine extends EventTarget {
  constructor(provider){
    super();this.provider=provider;this.peers=new Map();this.roomId=null;this.local=null;this.screen=null;this.muted=true;this.camera=false;this.hand=false;this.generation=0;this.abort=new AbortController();
    provider.addEventListener('change',event=>this.onSignal(event.detail).catch(e=>this.emit('error',{message:e.message})),{signal:this.abort.signal});
  }
  emit(type,detail={}){this.dispatchEvent(new CustomEvent(type,{detail}));}
  async join(roomId,{audio=true,video=false}={}){
    if(this.roomId)throw error('Leave the current call first.',409);
    if(!navigator.mediaDevices?.getUserMedia)throw error('Media capture requires HTTPS or localhost and a supported browser.');
    const generation=++this.generation;
    const stream=audio||video?await navigator.mediaDevices.getUserMedia({audio:audio?{echoCancellation:true,noiseSuppression:true}:false,video:video?{width:{ideal:1280},height:{ideal:720},frameRate:{ideal:24,max:30}}:false}):new MediaStream();
    if(generation!==this.generation){stream.getTracks().forEach(t=>t.stop());throw error('Call cancelled.');}
    this.local=stream;this.muted=!audio;this.camera=video;this.iceServers=[];
    try{
      if(this.provider.kind==='server')this.iceServers=(await this.provider.request('/ice')).iceServers;
      if(generation!==this.generation)throw error('Call cancelled.');
      this.roomId=roomId;this.emit('local',{stream});
      const result=await this.provider.signal('call-join',{roomId});
      for(const peer of result?.peers||[])this.ensurePeer(peer);
      this.startedAt=Date.now();this.emit('joined',{roomId});
      this.timer=setInterval(()=>this.statistics(),3000);
      this.heartbeat=setInterval(()=>{if(this.roomId)this.provider.signal('call-presence',{roomId:this.roomId}).catch(()=>{});},5000);
    }catch(e){await this.leave();throw e;}
  }
  ensurePeer(data){
    if(!this.roomId||data.peerId===this.provider.peerId)return null;
    const existing=this.peers.get(data.peerId);if(existing){existing.seen=Date.now();return existing;}
    if(this.peers.size>=MAX_CALL_PEERS-1){this.emit('error',{message:`This mesh build supports ${MAX_CALL_PEERS} participants.`});return null;}
    const pc=new RTCPeerConnection({iceServers:this.iceServers,bundlePolicy:'max-bundle'});
    const peer={id:data.peerId,userId:data.userId,name:data.name||'Participant',pc,polite:this.provider.peerId.localeCompare(data.peerId)>0,makingOffer:false,ignoreOffer:false,settingAnswer:false,pending:[],seen:Date.now(),restarts:0,queue:Promise.resolve(),stream:new MediaStream()};
    this.peers.set(peer.id,peer);
    for(const kind of ['audio','video']){
      const track=kind==='video'&&this.screen?this.screen.getVideoTracks()[0]:this.local.getTracks().find(t=>t.kind===kind);
      peer[kind+'Sender']=pc.addTransceiver(track||kind,{direction:'sendrecv',streams:[this.local]}).sender;
    }
    pc.onicecandidate=({candidate})=>{if(candidate)this.send(peer,{candidate:candidate.toJSON()}).catch(()=>{});};
    pc.ontrack=event=>{
      if(!peer.stream.getTracks().some(t=>t.id===event.track.id))peer.stream.addTrack(event.track);
      event.track.onunmute=()=>this.emit('remote',{peer,stream:peer.stream});
      this.emit('remote',{peer,stream:peer.stream});
    };
    pc.onnegotiationneeded=async()=>{
      try{peer.makingOffer=true;await pc.setLocalDescription();await this.send(peer,{description:pc.localDescription.toJSON()});}
      catch(e){if(this.roomId&&pc.signalingState!=='closed')this.emit('error',{message:e.message});}
      finally{peer.makingOffer=false;}
    };
    pc.onconnectionstatechange=()=>{
      this.emit('peer-state',{peer,state:pc.connectionState});
      if(pc.connectionState==='failed'){if(peer.restarts++<2)pc.restartIce();else this.emit('error',{message:`Unable to connect to ${peer.name}. Check the deployment's TURN configuration.`});}
    };
    this.emit('peer',{peer});return peer;
  }
  send(peer,payload){if(!this.roomId||peer.pc.signalingState==='closed')return Promise.resolve();return this.provider.signal('rtc',{roomId:this.roomId,target:peer.id,...payload});}
  async onSignal(data){
    if(data.type==='connection'&&data.connected&&this.roomId&&this.provider.kind==='server'){
      const roomId=this.roomId;for(const id of [...this.peers.keys()])this.removePeer(id);
      const result=await this.provider.signal('call-join',{roomId});if(this.roomId===roomId)for(const peer of result.peers||[])this.ensurePeer(peer);return;
    }
    if(!this.roomId||data.roomId!==this.roomId||data.peerId===this.provider.peerId)return;
    if(data.type==='call-join'){this.ensurePeer(data);await this.provider.signal('call-presence',{roomId:this.roomId});return;}
    if(data.type==='call-presence'){this.ensurePeer(data);return;}
    if(data.type==='call-leave'){this.removePeer(data.peerId);return;}
    if(data.type==='call-state'){const peer=this.peers.get(data.peerId);if(peer){Object.assign(peer,{muted:data.muted,camera:data.camera,hand:data.hand,screen:data.screen});this.emit('peer-state',{peer,state:peer.pc.connectionState});}return;}
    if(data.type!=='rtc'||data.target!==this.provider.peerId)return;
    const peer=this.ensurePeer(data);if(!peer)return;
    peer.queue=peer.queue.catch(()=>{}).then(()=>this.receive(peer,data));await peer.queue;
  }
  async receive(peer,data){
    const pc=peer.pc;if(pc.signalingState==='closed')return;
    if(data.description){
      const ready=!peer.makingOffer&&(pc.signalingState==='stable'||peer.settingAnswer),collision=data.description.type==='offer'&&!ready;
      peer.ignoreOffer=!peer.polite&&collision;if(peer.ignoreOffer)return;
      peer.settingAnswer=data.description.type==='answer';
      try{await pc.setRemoteDescription(data.description);}finally{peer.settingAnswer=false;}
      for(const candidate of peer.pending.splice(0))await pc.addIceCandidate(candidate);
      if(data.description.type==='offer'){await pc.setLocalDescription();await this.send(peer,{description:pc.localDescription.toJSON()});}
    }else if(data.candidate){
      if(peer.ignoreOffer)return;
      if(!pc.remoteDescription){if(peer.pending.length<100)peer.pending.push(data.candidate);}
      else await pc.addIceCandidate(data.candidate);
    }
  }
  removePeer(id){const peer=this.peers.get(id);if(!peer)return;peer.pc.close();this.peers.delete(id);this.emit('left',{peerId:id});}
  async setMuted(muted){
    if(!this.local)throw error('Join a call first.');let tracks=this.local.getAudioTracks();
    if(!muted&&!tracks.length){const stream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true}});if(!this.local){stream.getTracks().forEach(t=>t.stop());return;}for(const t of stream.getTracks())this.local.addTrack(t);tracks=this.local.getAudioTracks();await Promise.all([...this.peers.values()].map(p=>p.audioSender.replaceTrack(tracks[0])));}
    tracks.forEach(t=>t.enabled=!muted);this.muted=muted;await this.state();
  }
  async setCamera(enabled){
    if(!this.local)throw error('Join a call first.');let tracks=this.local.getVideoTracks();
    if(enabled&&!tracks.length){const stream=await navigator.mediaDevices.getUserMedia({video:{width:{ideal:1280},height:{ideal:720}}});if(!this.local){stream.getTracks().forEach(t=>t.stop());return;}for(const t of stream.getTracks())this.local.addTrack(t);tracks=this.local.getVideoTracks();if(!this.screen)await Promise.all([...this.peers.values()].map(p=>p.videoSender.replaceTrack(tracks[0])));}
    tracks.forEach(t=>t.enabled=enabled);this.camera=enabled;this.emit('local',{stream:this.screen||this.local,screen:!!this.screen});await this.state();
  }
  async shareScreen(){
    if(this.screen)return this.stopScreen();if(!navigator.mediaDevices?.getDisplayMedia)throw error('Screen sharing is unavailable in this browser.');
    const stream=await navigator.mediaDevices.getDisplayMedia({video:{frameRate:{max:15}},audio:false});
    if(!this.roomId){stream.getTracks().forEach(t=>t.stop());return;}
    this.screen=stream;const track=stream.getVideoTracks()[0];track.onended=()=>this.stopScreen().catch(()=>{});
    await Promise.all([...this.peers.values()].map(p=>p.videoSender.replaceTrack(track)));this.emit('local',{stream,screen:true});await this.state();
  }
  async stopScreen(){
    const stream=this.screen;this.screen=null;if(!stream)return;stream.getTracks().forEach(t=>{t.onended=null;t.stop();});
    const camera=this.local?.getVideoTracks()[0]||null;await Promise.all([...this.peers.values()].map(p=>p.videoSender.replaceTrack(camera)));
    if(this.local)this.emit('local',{stream:this.local});if(this.roomId)await this.state();
  }
  async state(){const state={muted:this.muted,camera:this.camera,hand:this.hand,screen:!!this.screen};this.emit('state',state);if(this.roomId)await this.provider.signal('call-state',{roomId:this.roomId,...state});}
  async statistics(){
    let packetsLost=0,bytesReceived=0,roundTripTime=0,connected=0;
    for(const peer of [...this.peers.values()]){
      if(this.provider.kind==='local'&&Date.now()-peer.seen>25000){this.removePeer(peer.id);continue;}
      if(peer.pc.connectionState==='connected')connected++;
      try{const stats=await peer.pc.getStats();stats.forEach(s=>{if(s.type==='inbound-rtp'){packetsLost+=s.packetsLost||0;bytesReceived+=s.bytesReceived||0;}if(s.type==='candidate-pair'&&s.state==='succeeded')roundTripTime=Math.max(roundTripTime,s.currentRoundTripTime||0);});}catch{}
    }
    this.stats={participants:this.peers.size+1,connected,packetsLost,bytesReceived,roundTripTime};this.emit('stats',this.stats);
  }
  async leave(){
    this.generation++;clearInterval(this.timer);clearInterval(this.heartbeat);const roomId=this.roomId;this.roomId=null;
    // Stop hardware immediately; network acknowledgement is not a precondition for cleanup.
    for(const stream of [this.local,this.screen])stream?.getTracks().forEach(t=>{t.onended=null;t.stop();});this.local=null;this.screen=null;
    for(const id of [...this.peers.keys()])this.removePeer(id);
    if(roomId)await this.provider.signal('call-leave',{roomId}).catch(()=>{});this.emit('ended');
  }
  async dispose(){this.abort.abort();await this.leave();}
}
