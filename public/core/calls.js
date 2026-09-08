import {MAX_CALL_PEERS, error} from './model.js';
import {MediaController} from './media.js';
import {callState} from './call-state.js';

/** Authenticated signaling + actual RTCPeerConnections. A bounded mesh, not an SFU.
 * Media ownership transfers from preflight; all asynchronous work is generation-fenced.
 */
export class CallEngine extends EventTarget {
  constructor(provider, {media = new MediaController(), PeerConnection = globalThis.RTCPeerConnection} = {}) {
    super(); this.provider = provider; this.media = media; this.PeerConnection = PeerConnection;
    this.peers = new Map(); this.roomId = null; this.local = null; this.screen = null;
    this.muted = true; this.camera = false; this.hand = false; this.generation = 0;
    this.joining = false; this.closed = false; this.mediaQueue = Promise.resolve(); this.abort = new AbortController();
    provider.addEventListener('change', event => this.onSignal(event.detail).catch(e => this.emit('error', {message: e.message})), {signal: this.abort.signal});
    media.addEventListener('change', () => {
      this.syncMedia().catch(e => this.emit('error', {message: e.message}));
      this.emit('media', media.snapshot());
    }, {signal: this.abort.signal});
  }
  emit(type, detail = {}) {if (!this.closed || type === 'ended') this.dispatchEvent(new CustomEvent(type, {detail}));}
  payload() {return callState({muted: this.muted, camera: this.camera, hand: this.hand, screen: !!this.screen});}
  async join(roomId, options = {}) {
    if (this.closed) throw error('This call has ended. Start a new call.');
    if (this.roomId || this.joining) throw error('Leave the current call first.', 409);
    if (!this.PeerConnection || !this.media.Stream) throw error('This browser does not support WebRTC calls.');
    this.joining = true; const generation = ++this.generation;
    const preparation = this.media.prepare({audio: options.audio ?? true, video: options.video ?? false});
    const check = () => {if (this.closed || generation !== this.generation) throw error('Call cancelled.');};
    try {
      this.local = await preparation; check();
      this.iceServers = this.provider.kind === 'server' ? (await this.provider.request('/ice')).iceServers : [];
      check(); this.roomId = roomId;
      // Capture can end or be interrupted while ICE configuration is in flight.
      const audio = this.media.track('audio'), video = this.media.track('video');
      this.muted = !audio?.enabled || !!audio?.muted; this.camera = !!video?.enabled && !video.muted;
      this.emit('local', {stream: this.local});
      const result = await this.provider.signal('call-join', {roomId, ...this.payload()});
      if (this.closed || generation !== this.generation) {
        // A cancelled HTTP join can still have reached the server. Remove that membership.
        await this.provider.signal('call-leave', {roomId}).catch(() => {}); check();
      }
      for (const peer of result?.peers || []) this.ensurePeer(peer);
      this.startedAt = Date.now(); this.emit('joined', {roomId}); await this.state();
      check(); this.timer = setInterval(() => this.statistics(), 3000);
      this.heartbeat = setInterval(() => {
        if (this.roomId) this.provider.signal('call-presence', {roomId: this.roomId, ...this.payload()}).catch(() => {});
      }, 5000);
    } catch (cause) {await this.leave(); throw cause;}
    finally {this.joining = false;}
  }
  ensurePeer(data) {
    if (!this.roomId || this.closed || data.peerId === this.provider.peerId) return null;
    const existing = this.peers.get(data.peerId);
    if (existing) {
      existing.seen = Date.now();
      if ('muted' in data || 'camera' in data) {Object.assign(existing, callState({...existing, ...data})); this.emit('peer-state', {peer: existing, state: existing.pc.connectionState});}
      return existing;
    }
    if (this.peers.size >= MAX_CALL_PEERS - 1) {this.emit('error', {message: `This mesh build supports ${MAX_CALL_PEERS} participants.`}); return null;}
    const pc = new this.PeerConnection({iceServers: this.iceServers, bundlePolicy: 'max-bundle'});
    const peer = {id: data.peerId, userId: data.userId, name: data.name || 'Participant', pc,
      polite: this.provider.peerId.localeCompare(data.peerId) > 0, makingOffer: false, ignoreOffer: false, settingAnswer: false,
      pending: [], seen: Date.now(), restarts: 0, queue: Promise.resolve(), stream: new this.media.Stream(), ...callState(data)};
    this.peers.set(peer.id, peer);
    for (const kind of ['audio', 'video']) {
      const track = kind === 'video' && this.screen ? this.screen.getVideoTracks()[0] : this.media.track(kind);
      peer[kind + 'Sender'] = pc.addTransceiver(track || kind, {direction: 'sendrecv', streams: [this.local]}).sender;
    }
    pc.onicecandidate = ({candidate}) => {if (candidate) this.send(peer, {candidate: candidate.toJSON()}).catch(() => {});};
    pc.ontrack = event => {
      if (!peer.stream.getTracks().some(t => t.id === event.track.id)) peer.stream.addTrack(event.track);
      const update = () => {if (this.peers.get(peer.id) === peer) this.emit('remote', {peer, stream: peer.stream});};
      event.track.onunmute = update; event.track.onmute = update; event.track.onended = update; update();
    };
    pc.onnegotiationneeded = async () => {
      try {peer.makingOffer = true; await pc.setLocalDescription(); await this.send(peer, {description: pc.localDescription.toJSON()});}
      catch (cause) {if (this.roomId && pc.signalingState !== 'closed') this.emit('error', {message: cause.message});}
      finally {peer.makingOffer = false;}
    };
    pc.onconnectionstatechange = () => {
      this.emit('peer-state', {peer, state: pc.connectionState});
      if (pc.connectionState === 'connected') peer.restarts = 0;
      if (pc.connectionState === 'failed') {
        if (peer.restarts++ < 2) pc.restartIce();
        else this.emit('error', {message: `Unable to connect to ${peer.name}. Check the deployment’s TURN configuration.`});
      }
    };
    this.emit('peer', {peer}); return peer;
  }
  send(peer, payload) {
    if (!this.roomId || this.closed || peer.pc.signalingState === 'closed') return Promise.resolve();
    return this.provider.signal('rtc', {roomId: this.roomId, target: peer.id, ...payload});
  }
  async onSignal(data) {
    if (this.closed) return;
    if (data.type === 'connection' && this.roomId && this.provider.kind === 'server') {
      this.emit('signaling', {connected: data.connected});
      if (!data.connected || this.reconnecting || this.joining) return;
      const roomId = this.roomId, generation = this.generation; this.reconnecting = true;
      try {
        for (const id of [...this.peers.keys()]) this.removePeer(id);
        const result = await this.provider.signal('call-join', {roomId, ...this.payload()});
        if (this.closed || generation !== this.generation) {await this.provider.signal('call-leave', {roomId}).catch(() => {}); return;}
        for (const peer of result?.peers || []) this.ensurePeer(peer);
        await this.state();
      } finally {this.reconnecting = false;}
      return;
    }
    if (!this.roomId || data.roomId !== this.roomId || data.peerId === this.provider.peerId) return;
    if (data.type === 'call-join') {this.ensurePeer(data); await this.provider.signal('call-presence', {roomId: this.roomId, ...this.payload()}); return;}
    if (data.type === 'call-presence') {this.ensurePeer(data); return;}
    if (data.type === 'call-leave') {this.removePeer(data.peerId); return;}
    if (data.type === 'call-state') {
      const peer = this.peers.get(data.peerId);
      if (peer) {Object.assign(peer, callState(data)); peer.seen = Date.now(); this.emit('peer-state', {peer, state: peer.pc.connectionState});}
      return;
    }
    if (data.type !== 'rtc' || data.target !== this.provider.peerId) return;
    const peer = this.ensurePeer(data); if (!peer) return;
    peer.queue = peer.queue.catch(() => {}).then(() => this.receive(peer, data)); await peer.queue;
  }
  async receive(peer, data) {
    const pc = peer.pc; if (pc.signalingState === 'closed') return;
    if (data.description) {
      const ready = !peer.makingOffer && (pc.signalingState === 'stable' || peer.settingAnswer);
      const collision = data.description.type === 'offer' && !ready;
      peer.ignoreOffer = !peer.polite && collision; if (peer.ignoreOffer) return;
      peer.settingAnswer = data.description.type === 'answer';
      try {await pc.setRemoteDescription(data.description);} finally {peer.settingAnswer = false;}
      for (const candidate of peer.pending.splice(0)) await pc.addIceCandidate(candidate);
      if (data.description.type === 'offer') {await pc.setLocalDescription(); await this.send(peer, {description: pc.localDescription.toJSON()});}
    } else if (data.candidate) {
      if (peer.ignoreOffer) return;
      if (!pc.remoteDescription) {if (peer.pending.length < 100) peer.pending.push(data.candidate);}
      else await pc.addIceCandidate(data.candidate);
    }
  }
  removePeer(id) {
    const peer = this.peers.get(id); if (!peer) return;
    for (const track of peer.stream.getTracks()) {track.onmute = null; track.onunmute = null; track.onended = null; track.stop();}
    peer.pc.ontrack = null; peer.pc.onicecandidate = null; peer.pc.onconnectionstatechange = null; peer.pc.onnegotiationneeded = null;
    peer.pc.close(); this.peers.delete(id); this.emit('left', {peerId: id});
  }
  syncMedia() {
    const generation = this.generation;
    this.mediaQueue = this.mediaQueue.catch(() => {}).then(async () => {
      if (!this.roomId || this.closed || generation !== this.generation) return;
      const audio = this.media.track('audio'), video = this.media.track('video');
      this.muted = !audio?.enabled || !!audio?.muted; this.camera = !!video?.enabled && !video.muted;
      const outgoingVideo = this.screen?.getVideoTracks()[0] || video;
      const results = await Promise.allSettled([...this.peers.values()].flatMap(peer => {
        if (peer.pc.signalingState === 'closed') return [];
        return [['audio', audio], ['video', outgoingVideo]].filter(([kind, track]) => peer[kind + 'Sender'].track !== track)
          .map(([kind, track]) => peer[kind + 'Sender'].replaceTrack(track));
      }));
      if (this.closed || generation !== this.generation) return;
      this.emit('local', {stream: this.screen || this.local, screen: !!this.screen}); await this.state();
      const failed = results.find(result => result.status === 'rejected'); if (failed) throw failed.reason;
    });
    return this.mediaQueue;
  }
  setMuted(muted) {return this.setDevice('audio', !muted);}
  setCamera(enabled) {return this.setDevice('video', enabled);}
  async setDevice(kind, enabled) {
    if (!this.roomId || this.closed) throw error('Join a call first.');
    if (enabled) await this.media.request(kind, {force: !!this.media.track(kind)?.muted}); else this.media.release(kind);
    await this.syncMedia();
  }
  async selectDevice(kind, id) {if (!this.roomId) throw error('Join a call first.'); await this.media.select(kind, id); await this.syncMedia();}
  async flipCamera() {if (!this.roomId) throw error('Join a call first.'); await this.media.flipCamera(); await this.syncMedia();}
  async shareScreen() {
    if (!this.roomId || this.closed) throw error('Join a call first.');
    if (this.screen) return this.stopScreen(); if (this.sharing) return;
    if (!this.media.devicesAPI?.getDisplayMedia) throw error('Screen sharing is unavailable in this browser. Camera calls can still be used.');
    const generation = this.generation; this.sharing = true;
    try {
      // Keep the native picker inside the Share button's user gesture.
      const stream = await this.media.devicesAPI.getDisplayMedia({video: {frameRate: {max: 15}}, audio: false});
      if (this.closed || generation !== this.generation) {stream.getTracks().forEach(t => t.stop()); return;}
      const track = stream.getVideoTracks()[0];
      if (!track) {stream.getTracks().forEach(t => t.stop()); throw error('No shared screen was returned.');}
      this.screen = stream; track.onended = () => this.stopScreen().catch(() => {}); await this.syncMedia();
    } finally {this.sharing = false;}
  }
  async stopScreen() {
    const stream = this.screen; this.screen = null; if (!stream) return;
    stream.getTracks().forEach(track => {track.onended = null; track.stop();}); await this.syncMedia();
  }
  async state() {
    const payload = this.payload(); this.emit('state', payload);
    if (this.roomId && !this.closed) await this.provider.signal('call-state', {roomId: this.roomId, ...payload});
  }
  async statistics() {
    if (this.closed || this.readingStats) return; this.readingStats = true;
    let packetsLost = 0, bytesReceived = 0, roundTripTime = 0, connected = 0, jitter = 0;
    try {
      for (const peer of [...this.peers.values()]) {
        if (this.provider.kind === 'local' && Date.now() - peer.seen > 25000) {this.removePeer(peer.id); continue;}
        if (peer.pc.connectionState === 'connected') connected++;
        try {
          const stats = await peer.pc.getStats(); stats.forEach(s => {
            if (s.type === 'inbound-rtp') {packetsLost += Math.max(0, s.packetsLost || 0); bytesReceived += s.bytesReceived || 0; jitter = Math.max(jitter, s.jitter || 0);}
            if (s.type === 'candidate-pair' && s.state === 'succeeded' && (s.nominated || s.selected)) roundTripTime = Math.max(roundTripTime, s.currentRoundTripTime || 0);
          });
        } catch {}
      }
      const now = Date.now(), elapsed = (now - (this.statsAt || now)) / 1000;
      const receiveKbps = elapsed > 0 ? Math.max(0, (bytesReceived - (this.stats?.bytesReceived || 0)) * 8 / elapsed / 1000) : 0;
      this.statsAt = now; this.stats = {participants: this.peers.size + 1, connected, packetsLost, bytesReceived, roundTripTime, receiveKbps, jitter};
      this.emit('stats', this.stats);
    } finally {this.readingStats = false;}
  }
  async leave() {
    if (this.closed) return; this.closed = true; ++this.generation; this.abort.abort();
    clearInterval(this.timer); clearInterval(this.heartbeat); const roomId = this.roomId; this.roomId = null;
    // Hardware must stop immediately, even with offline signaling or an unanswered picker.
    this.media.dispose(); this.screen?.getTracks().forEach(track => {track.onended = null; track.stop();});
    this.local = null; this.screen = null; this.muted = true; this.camera = false;
    for (const id of [...this.peers.keys()]) this.removePeer(id);
    this.emit('ended'); if (roomId) await this.provider.signal('call-leave', {roomId}).catch(() => {});
  }
  async dispose() {await this.leave();}
}
