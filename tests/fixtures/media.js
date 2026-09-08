/** Deterministic unit-test doubles only; browser acceptance uses native WebRTC. */
export const defer = () => {let resolve, reject; const promise = new Promise((a,b) => {resolve=a; reject=b;}); return {promise,resolve,reject};};
export class Track extends EventTarget {
  constructor(kind) {super();this.kind=kind;this.id=crypto.randomUUID();this.enabled=true;this.muted=false;this.readyState='live';this.stops=0;}
  stop(){this.readyState='ended';this.stops++;}
  end(){this.readyState='ended';this.dispatchEvent(new Event('ended'));}
  interrupt(muted){this.muted=muted;this.dispatchEvent(new Event(muted?'mute':'unmute'));}
  getSettings(){return {deviceId:this.id};}
}
export class Stream {
  constructor(tracks=[]){this.tracks=[...tracks];this.id=crypto.randomUUID();}
  get active(){return this.tracks.some(t=>t.readyState==='live');}
  getTracks(){return [...this.tracks];} getAudioTracks(){return this.tracks.filter(t=>t.kind==='audio');} getVideoTracks(){return this.tracks.filter(t=>t.kind==='video');}
  addTrack(track){if(!this.tracks.includes(track))this.tracks.push(track);} removeTrack(track){this.tracks=this.tracks.filter(t=>t!==track);}
}
export class Devices extends EventTarget {
  constructor(){super();this.requests=[];this.handlers=[];this.made=[];this.devices=[];}
  getUserMedia(constraints){this.requests.push(constraints);if(this.handlers.length)return this.handlers.shift()(constraints);const stream=new Stream([new Track(constraints.audio?'audio':'video')]);this.made.push(stream);return Promise.resolve(stream);}
  enumerateDevices(){return Promise.resolve(this.devices);}
  getDisplayMedia(){const stream=new Stream([new Track('video')]);this.made.push(stream);return Promise.resolve(stream);}
}
export class PeerConnection {
  constructor(config){this.config=config;this.signalingState='stable';this.connectionState='new';this.senders=[];this.candidates=[];}
  addTransceiver(track){const sender={track:typeof track==='string'?null:track,replacements:[],async replaceTrack(value){this.replacements.push(value);this.track=value;}};this.senders.push(sender);return {sender};}
  async setLocalDescription(){this.localDescription={type:this.remoteDescription?.type==='offer'?'answer':'offer',toJSON(){return {type:this.type,sdp:'v=0'};}};}
  async setRemoteDescription(desc){this.remoteDescription=desc;}
  async addIceCandidate(candidate){this.candidates.push(candidate);}
  restartIce(){this.restarts=(this.restarts||0)+1;}
  async getStats(){return new Map();}
  close(){this.signalingState='closed';this.connectionState='closed';}
}
export class Provider extends EventTarget {
  constructor(kind='local'){super();this.kind=kind;this.peerId='self';this.signals=[];this.members=[];}
  async signal(type,payload){this.signals.push({type,...payload});return {peers:this.members};}
  async request(){return {iceServers:[]};}
  fire(detail){this.dispatchEvent(new CustomEvent('change',{detail}));}
}
export const flush = () => new Promise(resolve=>setImmediate(resolve));
