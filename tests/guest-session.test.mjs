import test from 'node:test';
import assert from 'node:assert/strict';
import {MediaController} from '../public/core/media.js';
import {MeetingSession} from '../public/core/meeting-session.js';
import {mediaState, rtcSignal, iceConfiguration, meetingURL, parseInvitation, serverURL} from '../public/core/guest-protocol.js';
import {Track, Stream, Devices, defer, flush} from './fixtures/media.js';
const SELF = 'a'.repeat(22), PEER = 'z'.repeat(22);
class Channel {constructor(label) {this.label = label; this.readyState = 'connecting'; this.bufferedAmount = 0; this.sent = [];}
  send(data) {this.sent.push(JSON.parse(data));} close() {this.readyState = 'closed';}}
class RTC extends EventTarget {
  constructor(config) {super(); this.config = config; this.signalingState = 'stable'; this.connectionState = 'new'; this.iceGatheringState = 'complete'; this.transceivers = []; this.candidates = []; this.stats = new Map();}
  addTransceiver(value) {const kind = typeof value === 'string' ? value : value.kind;
    const t = {receiver: {track: new Track(kind)}, direction: 'sendrecv', sender: {track: typeof value === 'string' ? null : value, async replaceTrack(track) {this.track = track;}}}; this.transceivers.push(t); return t;}
  getTransceivers() {return this.transceivers;}
  createDataChannel(label) {return new Channel(label);}
  async createOffer() {return {type: 'offer', sdp: 'v=0\r\ns=offer\r\na=candidate:1 1 UDP 1 192.0.2.1 50000 typ host\r\n'};}
  async createAnswer() {return {type: 'answer', sdp: 'v=0\r\ns=answer\r\na=candidate:1 1 UDP 1 192.0.2.2 50001 typ host\r\n'};}
  async setLocalDescription(value) {this.localDescription = value || (this.signalingState === 'have-remote-offer' ? await this.createAnswer() : await this.createOffer()); this.signalingState = this.localDescription.type === 'offer' ? 'have-local-offer' : 'stable';}
  async setRemoteDescription(value) {this.remoteDescription = value; this.signalingState = value.type === 'offer' ? 'have-remote-offer' : 'stable'; if (!this.transceivers.length) ['audio', 'video', 'video', 'audio'].forEach(kind => this.addTransceiver(kind));}
  async addIceCandidate(candidate) {this.candidates.push(candidate);}
  async getStats() {return this.stats;}
  restartIce() {this.restarts = (this.restarts || 0) + 1;}
  close() {this.signalingState = this.connectionState = 'closed';}
}
function fixture(t, id = SELF) {
  const devices = new Devices(), media = new MediaController({mediaDevices: devices, Stream, secure: true, document: null});
  const signals = [], session = new MeetingSession({id, name: 'Alex', media, PeerConnection: RTC, signal: async (...data) => {signals.push(data);}});
  t.after(() => session.stop()); return {devices, media, session, signals};
}

test('receive-only construction and peer setup request no devices, with four stable RTP slots', t => {
  const f = fixture(t), peer = f.session.addPeer({id: PEER});
  assert.equal(f.devices.requests.length, 0); assert.equal(peer.transceivers.length, 4);
  assert.deepEqual(peer.transceivers.map(t => t.receiver.track.kind), ['audio', 'video', 'video', 'audio']);
  assert.deepEqual(f.session.state(), {audio: false, video: false, screen: false, screenAudio: false, hand: false});
});

test('camera and microphone continue unchanged during simultaneous screen/audio sharing', async t => {
  const f = fixture(t); await f.session.setDevice('audio', true); await f.session.setDevice('video', true);
  const mic = f.media.track('audio'), camera = f.media.track('video'), peer = f.session.addPeer({id: PEER});
  f.devices.getDisplayMedia = async options => {assert.equal(options.audio, true); return new Stream([new Track('video'), new Track('audio')]);};
  await f.session.shareScreen({audio: true});
  assert.equal(peer.transceivers[0].sender.track, mic); assert.equal(peer.transceivers[1].sender.track, camera);
  assert.equal(peer.transceivers[2].sender.track, f.session.screen.getVideoTracks()[0]); assert.equal(peer.transceivers[3].sender.track.kind, 'audio');
  assert.equal(f.session.state().screenAudio, true); assert.equal(camera.stops, 0); assert.equal(mic.stops, 0);
  await f.session.stopScreen(); assert.equal(camera.stops, 0); assert.equal(mic.stops, 0); assert.equal(peer.transceivers[2].sender.track, null);
});

test('native stop-sharing event ends only presentation tracks', async t => {
  const f = fixture(t); await f.session.setDevice('video', true); await f.session.shareScreen();
  const screen = f.session.screen.getVideoTracks()[0], camera = f.media.track('video');
  screen.onended(); await f.session.mediaQueue; assert.equal(f.session.screen, null); assert.equal(screen.readyState, 'ended'); assert.equal(camera.readyState, 'live');
});

test('screen-sharing denial preserves camera/microphone and exposes a real failure', async t => {
  const f = fixture(t); await f.session.setDevice('audio', true); const mic = f.media.track('audio');
  f.devices.getDisplayMedia = () => Promise.reject(new DOMException('Denied', 'NotAllowedError'));
  await assert.rejects(f.session.shareScreen(), {name: 'NotAllowedError'}); assert.equal(f.session.screen, null); assert.equal(mic.readyState, 'live');
});

test('a late screen picker result is stopped after leaving and cannot resurrect capture', async t => {
  const f = fixture(t), pending = defer(); f.devices.getDisplayMedia = () => pending.promise;
  const work = f.session.shareScreen(); f.session.stop();
  const stream = new Stream([new Track('video'), new Track('audio')]); pending.resolve(stream); await work;
  assert.ok(stream.getTracks().every(track => track.readyState === 'ended')); assert.equal(f.session.screen, null);
});

test('stop releases all local and remote devices immediately even with pending signaling', async t => {
  const f = fixture(t); await f.session.setDevice('audio', true); await f.session.setDevice('video', true); await f.session.shareScreen();
  const tracks = [...f.media.stream.getTracks(), ...f.session.screen.getTracks()], peer = f.session.addPeer({id: PEER});
  f.session.stop(); assert.ok(tracks.every(track => track.readyState === 'ended')); assert.equal(peer.pc.connectionState, 'closed'); assert.equal(f.session.peers.size, 0);
});

test('ICE candidates wait for a remote description and are flushed in order', async t => {
  const f = fixture(t); await f.session.receive(PEER, {candidate: {candidate: 'candidate:one', sdpMid: '0', sdpMLineIndex: 0}});
  const peer = f.session.peers.get(PEER); assert.equal(peer.pc.candidates.length, 0);
  await f.session.receive(PEER, {description: {type: 'offer', sdp: 'v=0\r\n'}});
  assert.equal(peer.pc.candidates.length, 1); assert.equal(f.signals.at(-1)[1].description.type, 'answer');
});

test('impolite peer ignores a colliding offer and its candidates; polite peer answers', async t => {
  const a = fixture(t), p = a.session.addPeer({id: PEER}); await p.pc.setLocalDescription();
  await a.session.receive(PEER, {description: {type: 'offer', sdp: 'v=0\r\n'}});
  assert.equal(p.ignoreOffer, true); assert.equal(p.pc.remoteDescription, undefined);
  await a.session.receive(PEER, {candidate: {candidate: 'candidate:ignored'}}); assert.equal(p.pc.candidates.length, 0);
  const b = fixture(t, PEER), other = b.session.addPeer({id: SELF}); await other.pc.setLocalDescription();
  await b.session.receive(SELF, {description: {type: 'offer', sdp: 'v=0\r\n'}});
  assert.equal(other.ignoreOffer, false); assert.equal(other.pc.localDescription.type, 'answer');
});

test('roster reconnect resets close old peers without stopping camera or microphone', async t => {
  const f = fixture(t); await f.session.setDevice('audio', true); const mic = f.media.track('audio');
  f.session.roster([{id: PEER, name: 'Sam', host: true, audio: true}]); const old = f.session.peers.get(PEER);
  assert.equal(old.host, true); f.session.resetPeers(); assert.equal(old.pc.connectionState, 'closed'); assert.equal(mic.readyState, 'live');
  f.session.roster([{id: PEER, name: 'Sam'}]); assert.notEqual(f.session.peers.get(PEER), old);
});

test('late-joining peers receive separate camera and presentation senders', async t => {
  const f = fixture(t); await f.session.setDevice('video', true); await f.session.shareScreen(); const peer = f.session.addPeer({id: PEER});
  assert.equal(peer.transceivers[1].sender.track, f.media.track('video')); assert.equal(peer.transceivers[2].sender.track, f.session.screen.getVideoTracks()[0]);
});

test('chat is not marked sent without an open data channel; congestion is bounded', t => {
  const f = fixture(t), peer = f.session.addPeer({id: PEER}); assert.throws(() => f.session.sendChat('hello'), /not been sent/);
  peer.channel.readyState = 'open'; let sent; f.session.addEventListener('chat', e => {sent = e.detail;});
  f.session.sendChat('<img src=x onerror=alert(1)>'); assert.equal(sent.delivered, 1); assert.equal(peer.channel.sent.at(-1).text, '<img src=x onerror=alert(1)>');
  peer.channel.bufferedAmount = 300000; assert.throws(() => f.session.sendChat('hello'), /not been sent/); assert.throws(() => f.session.sendChat('x'.repeat(2001)));
});

test('incoming chat identity comes from the connection, duplicates and invalid reactions are ignored', t => {
  const f = fixture(t), peer = f.session.addPeer({id: PEER, name: 'Sam'}), messages = [], reactions = [];
  f.session.addEventListener('chat', e => messages.push(e.detail)); f.session.addEventListener('reaction', e => reactions.push(e.detail));
  const message = {v: 1, type: 'chat', id: 'b'.repeat(22), name: 'Forged host', peerId: SELF, text: 'Hello'};
  peer.channel.onmessage({data: JSON.stringify(message)}); peer.channel.onmessage({data: JSON.stringify(message)});
  assert.equal(messages.length, 1); assert.equal(messages[0].name, 'Sam'); assert.equal(messages[0].peerId, PEER);
  peer.channel.onmessage({data: JSON.stringify({v: 1, type: 'reaction', id: 'c'.repeat(22), emoji: '<script>'})}); assert.equal(reactions.length, 0);
});

test('manual offers/answers bind identities and offer digest, reject mismatched or reused answers', async t => {
  const a = fixture(t), b = fixture(t, PEER), offer = await a.session.createOffer();
  const answer = await b.session.acceptOffer(offer), bad = JSON.parse(answer); bad.offerHash = 'wrong';
  await assert.rejects(a.session.acceptAnswer(JSON.stringify(bad)), /another pairing/);
  await a.session.acceptAnswer(answer); assert.equal(a.session.peers.values().next().value.pc.signalingState, 'stable');
  await assert.rejects(a.session.acceptAnswer(answer), /already been used/);
});

test('expired and oversized direct pairing data are rejected before creating a peer', async t => {
  const a = fixture(t), b = fixture(t, PEER), offer = JSON.parse(await a.session.createOffer()); offer.expiresAt = Date.now() - 1;
  await assert.rejects(b.session.acceptOffer(JSON.stringify(offer)), /expired/); assert.equal(b.session.peers.size, 0);
  assert.throws(() => b.session.directBundle('x'.repeat(100001), 'offer'), /oversized/);
});

test('real statistics fields do not disclose raw ICE addresses or credentials', async t => {
  const f = fixture(t), peer = f.session.addPeer({id: PEER}); peer.pc.connectionState = 'connected';
  peer.pc.stats = new Map([['pair', {type: 'candidate-pair', state: 'succeeded', nominated: true, localCandidateId: 'local', remoteCandidateId: 'remote', currentRoundTripTime: .021}],
    ['local', {candidateType: 'relay', address: '198.51.100.1'}], ['remote', {candidateType: 'host', address: '192.0.2.1'}], ['rtp', {type: 'inbound-rtp', bytesReceived: 1024, packetsLost: 2}]]);
  let result; f.session.addEventListener('stats', e => {result = e.detail;}); await f.session.statistics();
  assert.equal(result[0].route, 'relay'); assert.equal(result[0].rttMs, 21); assert.equal(JSON.stringify(result).includes('198.51.100.1'), false);
});

test('protocol canonicalizes flags and rejects malformed signaling, ICE, and invitations', () => {
  assert.equal(mediaState({audio: 'true', host: true}).audio, false);
  assert.throws(() => rtcSignal({candidate: {candidate: 'x', sdpMLineIndex: 9}}));
  assert.throws(() => iceConfiguration([{urls: 'https://example.com/turn'}]));
  assert.throws(() => serverURL('http://example.com', 'https://example.com'));
  assert.throws(() => serverURL('https://user:secret@example.com', 'https://example.com'));
  const url = meetingURL('https://example.com/meet.html', SELF, 'a'.repeat(43), 'https://meet.example.com');
  assert.equal(new URL(url).search, ''); assert.equal(parseInvitation(url).roomId, SELF);
  assert.throws(() => parseInvitation('https://example.com/meet.html#room=x&key=x'));
});


test('initial answerer waits for the offered RTP slots and binds its live camera once', async t => {
  const f = fixture(t, PEER); await f.session.setDevice('video', true); const p = f.session.addPeer({id: SELF});
  assert.equal(p.pc.getTransceivers().length, 0); assert.equal(p.transceivers, undefined);
  await f.session.receive(SELF, {description: {type: 'offer', sdp: 'v=0\r\n'}});
  assert.equal(p.pc.getTransceivers().length, 4);
  assert.equal(p.transceivers[1].sender.track, f.media.track('video'));
  assert.equal(f.signals.at(-1)[1].description.type, 'answer');
});

test('manual pairing refuses an apparently complete ICE gather with zero candidates', async t => {
  const f = fixture(t), old = RTC.prototype.createOffer;
  RTC.prototype.createOffer = async () => ({type: 'offer', sdp: 'v=0\r\n'});
  try {await assert.rejects(f.session.createOffer(), /No network candidates/); assert.equal(f.session.peers.size, 0);}
  finally {RTC.prototype.createOffer = old;}
});

test('ending only shared audio clears its RTP sender and advertised state without stopping presentation', async t => {
  const f = fixture(t); await f.session.setDevice('audio', true); await f.session.setDevice('video', true);
  f.devices.getDisplayMedia = async () => new Stream([new Track('video'), new Track('audio')]);
  await f.session.shareScreen({audio: true}); const peer = f.session.addPeer({id: PEER});
  const presentation = f.session.screen.getVideoTracks()[0], audio = f.session.screen.getAudioTracks()[0];
  audio.stop(); audio.onended(); await f.session.mediaQueue;
  assert.equal(f.session.state().screenAudio, false); assert.equal(f.session.state().screen, true);
  assert.equal(peer.transceivers[3].sender.track, null); assert.equal(presentation.readyState, 'live');
  assert.equal(f.media.track('audio').readyState, 'live'); assert.equal(f.media.track('video').readyState, 'live');
});

test('muted shared audio is not advertised as active and interruption handlers are cleaned up', async t => {
  const f = fixture(t); f.devices.getDisplayMedia = async () => new Stream([new Track('video'), new Track('audio')]);
  await f.session.shareScreen({audio: true}); const audio = f.session.screen.getAudioTracks()[0];
  audio.muted = true; audio.onmute(); await f.session.mediaQueue; assert.equal(f.session.state().screenAudio, false);
  audio.muted = false; audio.onunmute(); await f.session.mediaQueue; assert.equal(f.session.state().screenAudio, true);
  await f.session.stopScreen(); assert.equal(audio.onmute, null); assert.equal(audio.onunmute, null); assert.equal(audio.onended, null);
});

test('unrequested and extra display tracks are immediately stopped rather than transmitted', async t => {
  const f = fixture(t), wanted = new Track('video'), extraVideo = new Track('video'), unwantedAudio = new Track('audio');
  f.devices.getDisplayMedia = async () => new Stream([wanted, extraVideo, unwantedAudio]);
  await f.session.shareScreen(); assert.equal(extraVideo.readyState, 'ended'); assert.equal(unwantedAudio.readyState, 'ended');
  assert.deepEqual(f.session.screen.getTracks(), [wanted]);
});

test('refreshing ICE credentials preserves healthy connections, fixed slots and hardware', async t => {
  const f = fixture(t); await f.session.setDevice('video', true); const camera = f.media.track('video');
  const peer = f.session.addPeer({id: PEER}); let configuration = {iceServers: [], bundlePolicy: 'max-bundle'};
  peer.pc.getConfiguration = () => configuration; peer.pc.setConfiguration = next => {configuration = next;};
  const input = [{urls: 'turn:relay.example', username: 'renewed', credential: 'test-only'}];
  f.session.updateIceServers(input); input[0].credential = 'mutated';
  assert.equal(configuration.iceServers[0].credential, 'test-only'); assert.equal(configuration.bundlePolicy, 'max-bundle');
  assert.equal(peer.pc.restarts || 0, 0); assert.equal(camera.readyState, 'live'); assert.equal(peer.transceivers.length, 4);
  const later = f.session.addPeer({id: 'c'.repeat(22)}); assert.equal(later.pc.config.iceServers[0].username, 'renewed');
});

test('null manual bundles and answers with altered expiration fail predictably', async t => {
  const f = fixture(t); assert.throws(() => f.session.directBundle('null', 'offer'), /invalid or expired/);
  const offer = JSON.parse(await f.session.createOffer());
  const answer = {...offer, from: offer.to, to: offer.from, expiresAt: offer.expiresAt + 1, description: {type: 'answer', sdp: 'v=0\r\n'}};
  await assert.rejects(f.session.acceptAnswer(JSON.stringify(answer)), /another pairing/);
});
