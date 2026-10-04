import {MediaController} from './media.js';
import {MAX_GUEST_PEERS, MAX_CHAT_LENGTH, REACTIONS, ID_PATTERN, fault, text, mediaState, rtcSignal, iceConfiguration} from './guest-protocol.js';

const slots = ['mic', 'camera', 'screen', 'screenAudio'];
const kinds = ['audio', 'video', 'video', 'audio'];
const randomId = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const hash = async value => btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const stopStream = stream => stream?.getTracks().forEach(track => {track.onended = track.onmute = track.onunmute = null; track.stop();});
const liveTrack = (stream, kind) => stream?.getTracks().find(track => track.kind === kind && track.readyState === 'live') || null;

/** Four fixed RTP slots preserve camera + microphone while presenting screen + audio.
 * Reuses the workspace's permission/recovery controller; supports live or manual signaling.
 * Chat/reactions travel on RTCDataChannel, not via the meeting broker.
 */
export class MeetingSession extends EventTarget {
  constructor({id = randomId(), name = 'Guest', media = new MediaController(), iceServers = [], signal,
    PeerConnection = globalThis.RTCPeerConnection} = {}) {
    super(); this.id = id; this.name = text(name, 80, 'Display name'); this.media = media;
    this.iceServers = iceConfiguration(iceServers); this.signal = signal; this.PC = PeerConnection;
    this.peers = new Map(); this.screen = null; this.hand = false; this.closed = false;
    this.abort = new AbortController(); this.mediaQueue = Promise.resolve(); this.epoch = 0;
    media.addEventListener('change', () => this.syncMedia().catch(e => this.report(e)), {signal: this.abort.signal});
    this.statsTimer = setInterval(() => this.statistics(), 3000);
  }
  emit(type, detail = {}) {if (!this.closed) this.dispatchEvent(new CustomEvent(type, {detail}));}
  report(error) {this.emit('error', {message: error.message});}
  state() {
    const audio = this.media.track('audio'), video = this.media.track('video');
    return mediaState({audio: !!audio?.enabled && !audio.muted, video: !!video?.enabled && !video.muted,
      screen: !!this.screen?.getVideoTracks().some(t => t.readyState === 'live'),
      screenAudio: !!this.screen?.getAudioTracks().some(t => t.readyState === 'live' && t.enabled && !t.muted), hand: this.hand});
  }
  tracks() {return [this.media.track('audio'), this.media.track('video'), liveTrack(this.screen, 'video'), liveTrack(this.screen, 'audio')];}
  current(peer) {return !this.closed && this.peers.get(peer.id) === peer && peer.pc.signalingState !== 'closed';}
  enqueue(peer, task) {
    peer.queue = peer.queue.catch(() => {}).then(() => {if (this.current(peer)) return task();});
    return peer.queue;
  }
  addPeer(data, {direct = false, answerer = false} = {}) {
    if (this.closed || data.id === this.id) return null;
    const found = this.peers.get(data.id);
    if (found) {found.name = data.name || found.name; if (data.state) found.state = mediaState(data.state); return found;}
    if (!ID_PATTERN.test(data.id || '') || this.peers.size >= MAX_GUEST_PEERS - 1) throw fault('Invalid participant or full meeting.');
    if (!this.PC || !this.media.Stream) throw fault('This browser does not support WebRTC.');
    const pc = new this.PC({iceServers: this.iceServers, bundlePolicy: 'max-bundle'});
    const peer = {id: data.id, name: data.name || 'Guest', pc, direct, host: !!data.host, polite: answerer || this.id > data.id,
      queue: Promise.resolve(), pending: [], streams: Object.fromEntries(slots.map(slot => [slot, new this.media.Stream()])),
      state: mediaState(data.state || data), makingOffer: false, ignoreOffer: false, settingAnswer: false, restarts: 0, receivedIds: new Set()};
    this.peers.set(peer.id, peer);
    // Only the lower-ID peer creates initial RTP transceivers. The answerer reuses
    // the offer's four slots; pre-creating both sides can duplicate media sections.
    if (!answerer && (direct || this.id < peer.id)) this.configureSlots(peer);
    pc.ontrack = event => {
      const index = pc.getTransceivers().indexOf(event.transceiver), slot = slots[index]; if (!slot) return;
      const stream = peer.streams[slot];
      for (const track of stream.getTracks()) if (track !== event.track) stream.removeTrack(track);
      if (!stream.getTracks().includes(event.track)) stream.addTrack(event.track);
      const update = () => {if (this.current(peer)) this.emit('track', {peer, slot, stream});};
      event.track.onunmute = update; event.track.onmute = update; event.track.onended = update; update();
    };
    pc.ondatachannel = event => this.configureChannel(peer, event.channel);
    if (!answerer && (direct || this.id < peer.id)) this.configureChannel(peer, pc.createDataChannel('veyra-meeting', {ordered: true}));
    pc.onicecandidate = event => {
      if (!direct && event.candidate && this.current(peer)) this.signal?.(peer.id, {candidate: event.candidate.toJSON()}).catch(e => this.report(e));
    };
    pc.onnegotiationneeded = () => {
      if (direct) return;
      this.enqueue(peer, async () => {
        if (pc.signalingState !== 'stable' || !peer.transceivers) return;
        try {
          peer.makingOffer = true; await pc.setLocalDescription();
          if (this.current(peer)) await this.signal(peer.id, {description: {type: pc.localDescription.type, sdp: pc.localDescription.sdp}});
        } finally {peer.makingOffer = false;}
      }).catch(e => this.report(e));
    };
    pc.onconnectionstatechange = () => {
      if (!this.current(peer)) return;
      if (pc.connectionState === 'connected') peer.restarts = 0;
      if (pc.connectionState === 'failed') {
        if (!direct && peer.restarts++ < 2) pc.restartIce();
        else this.report(fault(direct ? 'Direct connection failed. Check ICE servers and exchange a fresh offer/answer.' : 'Media connection failed. The deployment may need TURN.'));
      }
      this.emit('peer', {peer});
    };
    this.emit('peer', {peer}); return peer;
  }
  configureSlots(peer, existing = false) {
    const tracks = this.tracks();
    if (existing) {
      const transceivers = peer.pc.getTransceivers();
      if (transceivers.length !== 4 || transceivers.some((t, index) => t.receiver.track.kind !== kinds[index])) throw fault('Unsupported meeting media layout.');
      peer.transceivers = transceivers;
      return Promise.all(transceivers.map((t, index) => {t.direction = 'sendrecv'; return t.sender.replaceTrack(tracks[index]);}));
    }
    peer.transceivers = kinds.map((kind, index) => peer.pc.addTransceiver(tracks[index] || kind, {direction: 'sendrecv'}));
  }
  roster(peers) {
    if (this.closed) return;
    const ids = new Set(peers.map(p => p.id));
    for (const id of [...this.peers.keys()]) if (!ids.has(id)) this.removePeer(id);
    for (const data of peers) {
      const peer = this.addPeer(data); if (!peer) continue;
      peer.state = mediaState(data); peer.host = !!data.host; this.emit('peer', {peer});
    }
  }
  async receive(from, payload, name = 'Guest') {
    if (this.closed) return;
    const data = rtcSignal(payload), peer = this.addPeer({id: from, name}); if (!peer) return;
    return this.enqueue(peer, async () => {
      const pc = peer.pc;
      if (data.description) {
        const ready = !peer.makingOffer && (pc.signalingState === 'stable' || peer.settingAnswer);
        const collision = data.description.type === 'offer' && !ready;
        peer.ignoreOffer = !peer.polite && collision; if (peer.ignoreOffer) return;
        peer.settingAnswer = data.description.type === 'answer';
        try {await pc.setRemoteDescription(data.description);} finally {peer.settingAnswer = false;}
        if (!this.current(peer)) return;
        if (data.description.type === 'offer' && !peer.transceivers) await this.configureSlots(peer, true);
        for (const candidate of peer.pending.splice(0)) {if (this.current(peer)) await pc.addIceCandidate(candidate);}
        if (data.description.type === 'offer' && this.current(peer)) {
          await pc.setLocalDescription();
          if (this.current(peer)) await this.signal(peer.id, {description: {type: pc.localDescription.type, sdp: pc.localDescription.sdp}});
        }
      } else if (data.candidate && !peer.ignoreOffer) {
        if (!pc.remoteDescription) {if (peer.pending.length >= 128) throw fault('Too many queued ICE candidates.'); peer.pending.push(data.candidate);}
        else await pc.addIceCandidate(data.candidate);
      }
    });
  }
  configureChannel(peer, channel) {
    if (channel.label !== 'veyra-meeting' || peer.channel) {channel.close(); return;}
    peer.channel = channel;
    channel.onopen = () => {if (this.current(peer)) {this.sendPacket(peer, {type: 'state', state: this.state()}); this.emit('peer', {peer});}};
    channel.onclose = () => this.emit('peer', {peer});
    channel.onmessage = ({data}) => {
      if (!this.current(peer) || typeof data !== 'string' || data.length > 12000) return;
      try {
        const now = Date.now(); if (!peer.windowAt || now - peer.windowAt > 10000) {peer.windowAt = now; peer.packetCount = 0;}
        if (++peer.packetCount > 100) return;
        const packet = JSON.parse(data); if (packet.v !== 1) return;
        if (packet.type === 'state') {peer.state = mediaState(packet.state); this.emit('peer', {peer}); return;}
        if (!ID_PATTERN.test(packet.id || '') || peer.receivedIds.has(packet.id)) return;
        peer.receivedIds.add(packet.id); if (peer.receivedIds.size > 256) peer.receivedIds.delete(peer.receivedIds.values().next().value);
        if (packet.type === 'chat') this.emit('chat', {id: packet.id, peerId: peer.id, name: peer.name, text: text(packet.text, MAX_CHAT_LENGTH), at: now});
        if (packet.type === 'reaction' && REACTIONS.includes(packet.emoji)) this.emit('reaction', {peerId: peer.id, name: peer.name, emoji: packet.emoji});
      } catch { /* Malformed peer data never enters the DOM. */ }
    };
  }
  sendPacket(peer, packet) {
    if (peer.channel?.readyState !== 'open' || peer.channel.bufferedAmount > 256 * 1024) return false;
    try {peer.channel.send(JSON.stringify({v: 1, ...packet})); return true;} catch {return false;}
  }
  sendChat(value) {
    const content = text(value, MAX_CHAT_LENGTH, 'Message'), id = randomId(); let delivered = 0;
    for (const peer of this.peers.values()) if (this.sendPacket(peer, {type: 'chat', id, text: content})) delivered++;
    if (!delivered) throw fault('No peer data channel is connected. Your message has not been sent.');
    this.emit('chat', {id, peerId: this.id, name: this.name, text: content, at: Date.now(), local: true, delivered});
  }
  react(emoji) {
    if (!REACTIONS.includes(emoji)) throw fault('Unsupported reaction.');
    let delivered = 0; const id = randomId();
    for (const peer of this.peers.values()) if (this.sendPacket(peer, {type: 'reaction', id, emoji})) delivered++;
    if (!delivered) throw fault('Connect to another participant first.');
    this.emit('reaction', {peerId: this.id, name: this.name, emoji});
  }
  publish() {
    if (this.closed) return;
    const state = this.state(); for (const peer of this.peers.values()) this.sendPacket(peer, {type: 'state', state});
    this.emit('state', state);
  }
  syncMedia() {
    const epoch = this.epoch;
    this.mediaQueue = this.mediaQueue.catch(() => {}).then(async () => {
      if (this.closed || epoch !== this.epoch) return;
      const tracks = this.tracks();
      const results = await Promise.allSettled([...this.peers.values()].flatMap(peer => (peer.transceivers || []).map((t, i) =>
        this.current(peer) && t.sender.track !== tracks[i] ? t.sender.replaceTrack(tracks[i]) : Promise.resolve())));
      if (this.closed || epoch !== this.epoch) return;
      this.emit('local', {camera: this.media.stream, screen: this.screen}); this.publish();
      const failure = results.find(r => r.status === 'rejected'); if (failure) throw failure.reason;
    });
    return this.mediaQueue;
  }
  updateIceServers(value) {
    if (this.closed) throw fault('The meeting has ended.');
    const next = iceConfiguration(value); this.iceServers = next;
    // Refresh future gathers without interrupting healthy RTP or requesting devices.
    // Keep all other immutable connection configuration from the original instance.
    let failure;
    for (const peer of this.peers.values()) if (this.current(peer)) {
      try {peer.pc.setConfiguration({...peer.pc.getConfiguration(), iceServers: next});}
      catch (error) {failure ||= error;}
    }
    if (failure) throw failure;
  }
  setDevice(kind, enabled) {
    if (this.closed) return Promise.reject(fault('The meeting has ended.'));
    const change = enabled ? this.media.request(kind, {force: !!this.media.track(kind)?.muted}) : (this.media.release(kind), Promise.resolve());
    return change.then(() => this.syncMedia());
  }
  setHand(value) {this.hand = !!value; this.publish();}
  async shareScreen({audio = false} = {}) {
    if (this.closed) throw fault('The meeting has ended.');
    if (this.screen) return this.stopScreen(); if (this.sharing) return;
    if (!this.media.devicesAPI?.getDisplayMedia) throw fault('This browser cannot share its screen. You can still view presentations and use camera/audio.');
    this.sharing = true; const epoch = this.epoch;
    try {
      // The native picker is invoked directly in the button’s activation stack.
      const stream = await this.media.devicesAPI.getDisplayMedia({video: {frameRate: {ideal: 15, max: 30}}, audio});
      if (this.closed || epoch !== this.epoch) {stopStream(stream); return;}
      const track = liveTrack(stream, 'video'); if (!track) {stopStream(stream); throw fault('No screen was selected.');}
      const sharedAudio = audio ? liveTrack(stream, 'audio') : null;
      for (const extra of stream.getTracks()) if (extra !== track && extra !== sharedAudio) {stream.removeTrack(extra); extra.stop();}
      this.screen = stream; track.contentHint = 'detail';
      const changed = () => {if (this.screen === stream && !this.closed) this.syncMedia().catch(e => this.report(e));};
      track.onended = () => {if (this.screen === stream) this.stopScreen().catch(e => this.report(e));};
      track.onmute = track.onunmute = changed;
      if (sharedAudio) {
        sharedAudio.onmute = sharedAudio.onunmute = changed;
        sharedAudio.onended = () => {
          if (this.screen !== stream) return;
          sharedAudio.onended = sharedAudio.onmute = sharedAudio.onunmute = null;
          stream.removeTrack(sharedAudio); changed();
        };
      }
      try {await this.syncMedia();} catch (error) {await this.stopScreen(); throw error;}
    } finally {this.sharing = false;}
  }
  async stopScreen() {const previous = this.screen; this.screen = null; stopStream(previous); await this.syncMedia();}
  async statistics() {
    if (this.closed || this.readingStats) return; this.readingStats = true;
    const rows = [];
    try {
      for (const peer of [...this.peers.values()]) {
        try {
          const stats = await peer.pc.getStats(); if (!this.current(peer)) continue;
          let bytes = 0, lost = 0, pair;
          stats.forEach(item => {
            if (item.type === 'inbound-rtp') {bytes += item.bytesReceived || 0; lost += Math.max(0, item.packetsLost || 0);}
            if (item.type === 'transport' && item.selectedCandidatePairId) pair = stats.get(item.selectedCandidatePairId);
          });
          if (!pair) stats.forEach(item => {if (item.type === 'candidate-pair' && item.state === 'succeeded' && item.nominated) pair = item;});
          const local = stats.get(pair?.localCandidateId), remote = stats.get(pair?.remoteCandidateId), now = Date.now();
          const kbps = peer.statsAt ? Math.max(0, (bytes - peer.statsBytes) * 8 / Math.max(1, now - peer.statsAt)) : 0;
          peer.statsAt = now; peer.statsBytes = bytes;
          rows.push({id: peer.id, name: peer.name, connection: peer.pc.connectionState, rttMs: Math.round((pair?.currentRoundTripTime || 0) * 1000),
            kbps: Math.round(kbps), packetsLost: lost, route: !pair ? 'unknown' : local?.candidateType === 'relay' || remote?.candidateType === 'relay' ? 'relay' : 'direct'});
        } catch { /* A peer can leave during a statistics sample. */ }
      }
      this.emit('stats', rows);
    } finally {this.readingStats = false;}
  }
  removePeer(id) {
    const peer = this.peers.get(id); if (!peer) return;
    this.peers.delete(id);
    for (const stream of Object.values(peer.streams)) stopStream(stream);
    if (peer.channel) {peer.channel.onopen = peer.channel.onclose = peer.channel.onmessage = null; peer.channel.close();}
    peer.pc.ontrack = peer.pc.ondatachannel = peer.pc.onicecandidate = peer.pc.onnegotiationneeded = peer.pc.onconnectionstatechange = null;
    peer.pc.close(); this.emit('left', {id});
  }
  resetPeers() {++this.epoch; for (const id of [...this.peers.keys()]) this.removePeer(id);}
  stop() {
    if (this.closed) return;
    this.closed = true; ++this.epoch; clearInterval(this.statsTimer); this.abort.abort();
    this.media.dispose(); stopStream(this.screen); this.screen = null;
    for (const id of [...this.peers.keys()]) this.removePeer(id);
  }
  async gather(peer) {
    if (peer.pc.iceGatheringState !== 'complete') await new Promise((resolve, reject) => {
      const finish = error => {clearTimeout(timer); peer.pc.removeEventListener('icegatheringstatechange', change); this.abort.signal.removeEventListener('abort', cancel); error ? reject(error) : resolve();};
      const change = () => {if (peer.pc.iceGatheringState === 'complete') finish();};
      const cancel = () => finish(fault('Pairing cancelled.'));
      const timer = setTimeout(() => finish(fault('ICE gathering timed out. Check the configured STUN/TURN servers and try again.')), 15000);
      peer.pc.addEventListener('icegatheringstatechange', change); this.abort.signal.addEventListener('abort', cancel, {once: true}); change();
    });
    if (!/a=candidate:/.test(peer.pc.localDescription?.sdp || ''))
      throw fault('No network candidates are available. Browser policy or network restrictions may block WebRTC. Check the browser and configured ICE servers.');
  }
  directBundle(value, type) {
    if (typeof value !== 'string' || value.length > 100000) throw fault('Invalid or oversized pairing data.');
    let bundle; try {bundle = JSON.parse(value);} catch {throw fault('Paste the complete pairing JSON.');}
    if (!bundle || typeof bundle !== 'object' || Array.isArray(bundle) || bundle.v !== 1 || bundle.kind !== 'veyra-direct' || ![bundle.from, bundle.to, bundle.session].every(v => ID_PATTERN.test(v || '')) ||
      bundle.from === bundle.to || !Number.isFinite(bundle.expiresAt) || bundle.expiresAt < Date.now() || bundle.expiresAt > Date.now() + 1800000)
      throw fault('This pairing data is invalid or expired. Create a fresh offer.');
    bundle.name = text(bundle.name, 80, 'Display name'); bundle.description = rtcSignal(bundle).description;
    if (!bundle.description || bundle.description.type !== type) throw fault(`Expected a pairing ${type}.`);
    return bundle;
  }
  async createOffer() {
    if (this.peers.size || this.closed) throw fault('Start a fresh meeting before pairing.');
    const peer = this.addPeer({id: randomId(), name: 'Connecting guest'}, {direct: true});
    try {
      await peer.pc.setLocalDescription(await peer.pc.createOffer()); await this.gather(peer);
      if (!this.current(peer)) throw fault('Pairing cancelled.');
      const description = {type: 'offer', sdp: peer.pc.localDescription.sdp};
      this.direct = {v: 1, kind: 'veyra-direct', session: randomId(), from: this.id, to: peer.id, name: this.name,
        expiresAt: Date.now() + 600000, description, offerHash: await hash(description.sdp)};
      return JSON.stringify(this.direct);
    } catch (error) {this.removePeer(peer.id); throw error;}
  }
  async acceptOffer(value) {
    if (this.peers.size || this.closed) throw fault('Start a fresh meeting before pairing.');
    const bundle = this.directBundle(value, 'offer');
    if (bundle.offerHash !== await hash(bundle.description.sdp)) throw fault('Pairing offer integrity check failed.');
    this.id = bundle.to;
    const peer = this.addPeer({id: bundle.from, name: bundle.name}, {direct: true, answerer: true});
    try {
      await peer.pc.setRemoteDescription(bundle.description); await this.configureSlots(peer, true);
      await peer.pc.setLocalDescription(await peer.pc.createAnswer()); await this.gather(peer);
      if (!this.current(peer)) throw fault('Pairing cancelled.');
      this.direct = bundle;
      return JSON.stringify({...bundle, from: this.id, to: peer.id, name: this.name, description: {type: 'answer', sdp: peer.pc.localDescription.sdp}});
    } catch (error) {this.removePeer(peer.id); throw error;}
  }
  async acceptAnswer(value) {
    const bundle = this.directBundle(value, 'answer'), offer = this.direct;
    if (!offer || offer.expiresAt < Date.now() || bundle.expiresAt !== offer.expiresAt || bundle.to !== this.id || bundle.from !== offer.to || bundle.session !== offer.session || bundle.offerHash !== offer.offerHash)
      throw fault('This answer belongs to another pairing offer.');
    const peer = this.peers.get(bundle.from);
    if (!peer || peer.pc.signalingState !== 'have-local-offer') throw fault('This pairing offer has already been used or cancelled.');
    await peer.pc.setRemoteDescription(bundle.description); peer.name = bundle.name; this.emit('peer', {peer});
  }
}
