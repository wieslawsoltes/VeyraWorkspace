import {MediaController, MicrophoneMeter} from './core/media.js';
import {MeetingSession} from './core/meeting-session.js';
import {GuestTransport} from './core/guest-transport.js';
import {guestConfig} from './guest-config.js';
import {REACTIONS, text, parseInvitation, meetingURL, serverURL, iceConfiguration} from './core/guest-protocol.js';

const $ = selector => document.querySelector(selector);
const media = new MediaController(), abort = new AbortController();
let transport, session, inviteLink = '', direct = false, pinned = '', lastRoster, startedAt, durationTimer, stateTimer, reactionTimer;
let finished = false, starting = false, joiningMedia = false, joiningEpoch = -1, joinAgain = false, connectionEpoch = 0, mode = 'link';
const tiles = new Map(), sinks = new Map();
const meter = new MicrophoneMeter(level => {$('#mic-meter').value = level;});
const initialURL = location.href;
$('#server').value = guestConfig.signalingURL; $('#ice').value = JSON.stringify(guestConfig.directIceServers);

function notify(message, error = false) {const node = $('#notice'); node.textContent = message; node.hidden = !message; node.classList.toggle('error', error);}
function failure(error) {if (!finished && error.name !== 'AbortError') notify(error.message, true);}
function bind(id, fn) {
  $(id).addEventListener('click', event => {
    event.preventDefault(); try {const promise = fn(event); if (promise?.catch) promise.catch(failure);} catch (error) {failure(error);}
  });
}
function name() {if (!$('#name').reportValidity()) throw new Error('Enter your display name.'); return text($('#name').value, 80, 'Display name');}
function initials(value) {return value.trim().split(/\s+/).slice(0, 2).map(part => [...part][0] || '').join('').toUpperCase();}
function setMode(value) {
  mode = value; $('#link-setup').hidden = value !== 'link'; $('#direct-setup').hidden = value !== 'direct';
  $('#mode-link').setAttribute('aria-pressed', String(value === 'link')); $('#mode-direct').setAttribute('aria-pressed', String(value === 'direct'));
}
bind('#mode-link', () => setMode('link')); bind('#mode-direct', () => setMode('direct'));
try {
  if (location.hash) {
    const invite = parseInvitation(initialURL, initialURL); $('#invite').value = initialURL;
    if (invite.server) $('#server').value = invite.server;
    history.replaceState(null, '', location.pathname + location.search);
    notify(`Invitation ready. Review the server ${$('#server').value || location.origin} and select Join meeting. No media will be sent before joining.`);
  }
} catch (error) {history.replaceState(null, '', location.pathname + location.search); failure(error);}
$('#invite').addEventListener('change', () => {
  try {const invite = parseInvitation($('#invite').value, initialURL); if (invite.server) $('#server').value = invite.server;}
  catch { /* Validation is shown on Join, not while a link is being pasted. */ }
});

function updateDevices() {
  const state = media.snapshot();
  for (const button of document.querySelectorAll('[data-device]')) {
    const kind = button.dataset.device, info = state[kind], active = info.enabled && !info.interrupted;
    button.setAttribute('aria-pressed', String(active));
    button.textContent = info.busy ? `Cancel ${kind === 'audio' ? 'microphone' : 'camera'}` : `${kind === 'audio' ? 'Microphone' : 'Camera'} ${active ? 'on' : info.status === 'error' || info.status === 'ended' || info.interrupted ? 'retry' : 'off'}`;
  }
  const video = media.track('video'); $('#preview').hidden = !video; $('#preview-avatar').hidden = !!video;
  if ($('#preview').srcObject !== media.stream) $('#preview').srcObject = media.stream;
  if (video) $('#preview').play().catch(() => {});
  if (!session) meter.attach(media.track('audio'));
  const issues = Object.values(state).filter(s => s.issue).map(s => `${s.issue.title}. ${s.issue.detail}`);
  $('#device-status').textContent = issues.join(' ') || 'Your choices carry into the meeting. You can join with both devices off.';
  if (session) renderLocal();
}
media.addEventListener('change', updateDevices, {signal: abort.signal});
media.addEventListener('devices', () => {
  for (const kind of ['audio', 'video']) {
    const select = $(`#${kind}-device`), value = media.preferences[kind].deviceId || '';
    select.replaceChildren(new Option('Automatic', ''));
    for (const device of media.devices.filter(d => d.kind === `${kind}input` && d.deviceId)) select.add(new Option(device.label || `${kind} input`, device.deviceId));
    select.value = value;
  }
}, {signal: abort.signal});
for (const button of document.querySelectorAll('[data-device]')) button.addEventListener('click', () => {
  const kind = button.dataset.device; if (!session) meter.unlock();
  if (media.pending[kind]) {media.release(kind); return;}
  const track = media.track(kind), enabled = !track?.enabled || !!track?.muted;
  const result = session ? session.setDevice(kind, enabled) : enabled ? media.request(kind, {force: !!track?.muted}) : (media.release(kind), Promise.resolve());
  result.catch(failure);
});
for (const kind of ['audio', 'video']) $(`#${kind}-device`).addEventListener('change', event => media.select(kind, event.target.value).catch(failure));
bind('#flip-preview', () => media.flipCamera()); bind('#flip', () => media.flipCamera());
$('#name').addEventListener('input', () => {$('#preview-avatar').textContent = initials($('#name').value) || 'You';});
updateDevices(); media.refreshDevices();

async function startLink(create) {
  if (starting || transport || session || finished) return;
  const displayName = name();
  let invitation, endpoint = $('#server').value.trim();
  if (!create) {
    invitation = parseInvitation($('#invite').value.trim(), initialURL);
    if (invitation.server && serverURL(invitation.server, initialURL).href !== serverURL(endpoint, initialURL).href)
      throw new Error('The invitation specifies a different server. Review and use that address in Connection settings.');
  }
  const server = serverURL(endpoint, initialURL); starting = true; notify(create ? 'Creating your guest meeting…' : 'Joining the guest meeting…');
  transport = new GuestTransport(server.href);
  try {
    const membership = create ? await transport.create(displayName, $('#title').value, $('#waiting-room').checked) : await transport.join(invitation.roomId, invitation.inviteKey, displayName);
    inviteLink = meetingURL(new URL('meet.html', initialURL), membership.roomId, create ? membership.inviteKey : invitation.inviteKey,
      server.origin === location.origin && server.pathname === new URL('./', initialURL).pathname ? '' : server.href);
    lastRoster = membership;
    transport.addEventListener('connection', ({detail}) => {
      connectionEpoch++;
      if (!detail.connected) {
        session?.resetPeers(); $('#connection-status').textContent = 'Signaling disconnected. Reconnecting…';
        $('#waiting-status').textContent = 'Reconnecting to the waiting room…';
      }
    });
    transport.addEventListener('error', ({detail}) => notify(`${detail.message} Reconnecting…`, true));
    transport.addEventListener('event', ({detail}) => handleEvent(detail).catch(failure));
    $('#setup').hidden = true; $('#waiting').hidden = membership.approved;
    if (!membership.approved) notify('Waiting for host approval. Your media remains local.');
    transport.start();
  } catch (error) {transport?.close(); transport = null; throw error;}
  finally {starting = false;}
}
bind('#create', () => startLink(true)); bind('#join', () => startLink(false));

async function handleEvent(event) {
  if (finished) return;
  if (['ended', 'expired', 'removed', 'left'].includes(event.type)) {
    endLocal(event.type === 'removed' ? 'The host removed you from the meeting.' : event.type === 'expired' ? 'This meeting session expired. Reopen a valid invitation to join again.' : 'The meeting has ended.'); return;
  }
  if (event.type === 'signal') {if (session) await session.receive(event.from, event, event.name); return;}
  if (event.type === 'admitted') {lastRoster = {...lastRoster, approved: true}; await joinMedia(); return;}
  if (event.type === 'roster' || event.type === 'ready') {
    if (event.revision < (lastRoster?.revision ?? -1)) return;
    lastRoster = event;
    if (event.approved && !session) {await joinMedia(); return;}
    if (event.type === 'ready' && event.approved && session) {await joinMedia(true); return;}
    if (finished) return;
    if (session) {session.roster(event.peers); renderPeople();}
    else $('#waiting-status').textContent = !event.hostConnected ? 'The host is disconnected. Waiting for them to reconnect…' : event.locked ? 'The meeting is locked; existing admission requests remain with the host.' : 'Connected to the host’s waiting room.';
  }
}
async function joinMedia(reconnect = false) {
  if (finished || !transport?.connected) return;
  if (joiningMedia) {if (reconnect || joiningEpoch !== connectionEpoch) joinAgain = true; return;}
  joiningMedia = true; joinAgain = false; const epoch = connectionEpoch; joiningEpoch = epoch;
  try {
    const ice = await transport.ice(); if (finished || epoch !== connectionEpoch) return;
    if (!session) makeSession({id: transport.session.participantId, name: $('#name').value, iceServers: ice.iceServers, signal: (id, data) => transport.signal(id, data)});
    else if (reconnect) {session.resetPeers(); session.iceServers = iceConfiguration(ice.iceServers);}
    showMeeting(lastRoster.title);
    const roster = await transport.presence(session.state());
    if (finished || epoch !== connectionEpoch) return;
    if (roster.revision >= (lastRoster?.revision ?? -1)) lastRoster = roster;
    session.roster(lastRoster.peers); renderPeople();
    notify(roster.host ? 'Meeting ready. Copy the invitation to invite people; waiting-room approval is controlled in People.' : 'You’ve joined. Microphone and camera use your preview choices.');
    $('#connection-status').textContent = 'Connected to meeting service · media is peer-to-peer';
  } finally {
    joiningMedia = false;
    if (joinAgain && !finished && transport?.connected) queueMicrotask(() => joinMedia(!!session).catch(failure));
  }
}
function makeSession(options) {
  session = new MeetingSession({media, ...options});
  session.addEventListener('error', ({detail}) => notify(detail.message, true));
  session.addEventListener('local', renderLocal);
  session.addEventListener('state', ({detail}) => {
    renderControls(); clearTimeout(stateTimer);
    if (transport?.connected) stateTimer = setTimeout(() => transport?.presence(detail).catch(failure), 120);
  });
  for (const type of ['peer', 'track']) session.addEventListener(type, ({detail}) => {renderPeer(detail.peer); renderPeople();});
  session.addEventListener('left', ({detail}) => {removePeerNodes(detail.id); renderPeople();});
  session.addEventListener('chat', ({detail}) => {
    const item = document.createElement('li'), title = document.createElement('strong'), content = document.createElement('p'), time = document.createElement('small');
    item.classList.toggle('local', !!detail.local); title.textContent = detail.local ? `${detail.name} (you)` : detail.name; content.textContent = detail.text;
    time.textContent = new Date(detail.at).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'}) + (detail.local ? ` · sent to ${detail.delivered} peer${detail.delivered === 1 ? '' : 's'}` : '');
    item.append(title, content, time); $('#messages').append(item); while ($('#messages').children.length > 200) $('#messages').firstChild.remove();
    $('#messages').scrollTop = $('#messages').scrollHeight;
    if ($('#side-panel').hidden || $('#chat-panel').hidden) $('#toggle-chat').textContent = 'Chat •';
  });
  session.addEventListener('reaction', ({detail}) => {
    $('#reaction-toast').textContent = `${detail.emoji}  ${detail.name}`; $('#reaction-toast').hidden = false;
    clearTimeout(reactionTimer); reactionTimer = setTimeout(() => {$('#reaction-toast').hidden = true;}, 3500);
  });
  session.addEventListener('stats', ({detail}) => {
    const connected = detail.filter(p => p.connection === 'connected');
    $('#connection-status').textContent = `${connected.length + 1} connected · ${direct ? 'Direct pairing' : 'Guest meeting'}${connected.some(p => p.route === 'relay') ? ' · TURN relay in use' : connected.length ? ' · P2P media' : ' · waiting for peers'}`;
    $('#network-stats').textContent = detail.length ? detail.map(p => `${p.name}: ${p.connection}, ${p.route} route, ${p.rttMs} ms RTT, ${p.kbps} kbps received, ${p.packetsLost} lost packets`).join('\n') : 'No remote transport connected yet.';
    if (direct && connected.length) $('#pairing').hidden = true;
  });
}
function showMeeting(title) {
  document.body.classList.add('meeting-active');
  $('#setup').hidden = true; $('#waiting').hidden = true; $('#meeting').hidden = false; $('#meeting-title').textContent = title;
  $('#copy-invite').hidden = direct; $('#host-controls').hidden = direct || !lastRoster?.host;
  if (!startedAt) {startedAt = Date.now(); durationTimer = setInterval(() => {
    const seconds = Math.floor((Date.now() - startedAt) / 1000); $('#duration').textContent = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
  }, 1000);}
  meter.dispose(); renderLocal(); renderControls(); renderPeople();
}
function renderControls() {
  if (!session) return;
  const state = session.state();
  $('#share-screen').textContent = state.screen ? 'Stop sharing' : 'Share screen'; $('#share-screen').setAttribute('aria-pressed', String(state.screen));
  $('#hand').textContent = state.hand ? 'Lower hand' : 'Raise hand'; $('#hand').setAttribute('aria-pressed', String(state.hand));
  const capable = !!navigator.mediaDevices?.getDisplayMedia; $('#share-screen').disabled = !capable;
  $('#screen-support').textContent = capable ? 'Shared audio depends on your browser, OS and the selected tab/window. Stopping screen sharing keeps your camera and microphone unchanged.' : 'Screen capture is unavailable in this browser. You can still watch another participant’s shared screen.';
}
function renderTile(key, {name, stream, screen = false, local = false, visible = true, status = '', hand = false}) {
  let tile = tiles.get(key);
  if (!tile) {
    tile = document.createElement('article'); tile.className = 'tile'; tile.dataset.key = key;
    const video = document.createElement('video'); video.autoplay = true; video.playsInline = true; video.muted = true;
    const avatar = document.createElement('div'); avatar.className = 'tile-avatar';
    const caption = document.createElement('div'); caption.className = 'tile-label'; caption.append(document.createElement('strong'), document.createElement('small'));
    const pin = document.createElement('button'); pin.type = 'button'; pin.textContent = 'Pin'; pin.addEventListener('click', () => {pinned = pinned === key ? '' : key; refreshPins();});
    const raised = document.createElement('span'); raised.className = 'hand-marker'; raised.textContent = '✋'; raised.setAttribute('aria-label', 'Hand raised');
    tile.append(video, avatar, caption, pin, raised); tiles.set(key, tile); $('#tiles').append(tile);
  }
  tile.classList.toggle('screen', screen); tile.classList.toggle('local', local);
  const video = tile.querySelector('video'); if (video.srcObject !== stream) {video.srcObject = stream || null; if (stream) video.play().catch(() => {});}
  video.hidden = !visible; tile.querySelector('.tile-avatar').hidden = visible;
  tile.querySelector('.tile-avatar').textContent = screen ? 'Screen' : initials(name);
  tile.querySelector('strong').textContent = name; tile.querySelector('small').textContent = status;
  tile.querySelector('.hand-marker').hidden = !hand; tile.querySelector('button').setAttribute('aria-label', `${pinned === key ? 'Unpin' : 'Pin'} ${name}`);
  refreshPins();
}
function removeTile(key) {const tile = tiles.get(key); if (tile) {tile.querySelector('video').srcObject = null; tile.remove(); tiles.delete(key);} if (pinned === key) pinned = ''; refreshPins();}
function refreshPins() {$('#tiles').classList.toggle('has-pin', !!pinned); for (const [key, tile] of tiles) {tile.classList.toggle('pinned', key === pinned); tile.querySelector('button').textContent = key === pinned ? 'Unpin' : 'Pin';}}
function renderLocal() {
  if (!session || finished) return;
  const state = session.state(); renderTile('self', {name: `${session.name} (you)`, stream: media.stream, local: true, visible: state.video, status: state.audio ? 'Microphone on' : 'Microphone off', hand: state.hand});
  if (state.screen) renderTile('self-screen', {name: 'Your screen', stream: session.screen, local: true, screen: true, status: state.screenAudio ? 'Sharing screen and available audio' : 'Sharing screen', visible: true});
  else removeTile('self-screen');
}
function audioSink(peer, slot) {
  const key = `${peer.id}:${slot}`; let element = sinks.get(key);
  if (!element) {element = document.createElement('audio'); element.autoplay = true; $('#audio-sinks').append(element); sinks.set(key, element);}
  const stream = peer.streams[slot]; if (element.srcObject !== stream) element.srcObject = stream;
  if (stream.getTracks().length) element.play().catch(() => {if (!finished) $('#play-audio').hidden = false;});
}
function renderPeer(peer) {
  if (!session?.current(peer) || finished) return;
  const state = peer.state, track = peer.streams.camera.getVideoTracks()[0];
  renderTile(peer.id, {name: peer.name, stream: peer.streams.camera, visible: state.video && !!track && !track.muted, hand: state.hand,
    status: `${peer.pc.connectionState} · ${state.audio ? 'microphone on' : 'microphone off'}`});
  if (state.screen) renderTile(`${peer.id}-screen`, {name: `${peer.name}’s screen`, stream: peer.streams.screen, screen: true,
    visible: !!peer.streams.screen.getVideoTracks()[0] && !peer.streams.screen.getVideoTracks()[0].muted, status: state.screenAudio ? 'Presenting with shared audio' : 'Presenting'});
  else removeTile(`${peer.id}-screen`);
  audioSink(peer, 'mic'); audioSink(peer, 'screenAudio');
}
function removePeerNodes(id) {
  removeTile(id); removeTile(`${id}-screen`);
  for (const slot of ['mic', 'screenAudio']) {const key = `${id}:${slot}`, sink = sinks.get(key); if (sink) {sink.pause(); sink.srcObject = null; sink.remove(); sinks.delete(key);}}
}
function personRow(person, waiting = false) {
  const row = document.createElement('div'); row.className = `person${waiting ? ' waiting' : ''}`;
  const label = document.createElement('span'), caption = document.createElement('small');
  label.textContent = person.name; caption.textContent = waiting ? 'Waiting for admission' : person.host ? 'Host' : person.state?.hand || person.hand ? 'Hand raised' : 'Guest'; label.append(caption); row.append(label);
  if (lastRoster?.host && person.id !== session?.id) {
    if (waiting) {const admit = document.createElement('button'); admit.textContent = 'Admit'; admit.onclick = () => transport.control('admit', {participantId: person.id}).catch(failure); row.append(admit);}
    const remove = document.createElement('button'); remove.className = 'danger'; remove.textContent = waiting ? 'Decline' : 'Remove';
    remove.onclick = () => {if (confirm(`${waiting ? 'Decline' : 'Remove'} ${person.name}?`)) transport.control('remove', {participantId: person.id}).catch(failure);}; row.append(remove);
  }
  return row;
}
function renderPeople() {
  if (!session) return;
  $('#people').replaceChildren(personRow({id: session.id, name: `${session.name} (you)`, host: lastRoster?.host, hand: session.hand}));
  for (const peer of session.peers.values()) $('#people').append(personRow(peer));
  $('#waiting-list').replaceChildren();
  if (lastRoster?.host && lastRoster.waiting?.length) {
    const heading = document.createElement('h2'); heading.className = 'waiting-label'; heading.textContent = `Waiting for approval (${lastRoster.waiting.length})`; $('#waiting-list').append(heading);
    for (const person of lastRoster.waiting) $('#waiting-list').append(personRow(person, true));
    $('#toggle-people').textContent = `People (${lastRoster.waiting.length} waiting)`;
  } else $('#toggle-people').textContent = 'People';
  $('#lock').setAttribute('aria-pressed', String(!!lastRoster?.locked)); $('#lock').textContent = lastRoster?.locked ? 'Unlock meeting' : 'Lock meeting';
}
function panel(tab) {
  $('#side-panel').hidden = false; $('#people-panel').hidden = tab !== 'people'; $('#chat-panel').hidden = tab !== 'chat';
  $('#people-tab').setAttribute('aria-selected', String(tab === 'people')); $('#chat-tab').setAttribute('aria-selected', String(tab === 'chat'));
  if (tab === 'chat') {$('#toggle-chat').textContent = 'Chat'; $('#message').focus();}
}
bind('#toggle-people', () => panel('people')); bind('#toggle-chat', () => panel('chat')); bind('#people-tab', () => panel('people')); bind('#chat-tab', () => panel('chat')); bind('#close-panel', () => {$('#side-panel').hidden = true;});
bind('#share-screen', () => session.shareScreen({audio: $('#share-audio').checked})); bind('#hand', () => {session.setHand(!session.hand); renderPeople();});
bind('#fullscreen', () => document.fullscreenElement ? document.exitFullscreen() : $('#stage').requestFullscreen?.());
bind('#play-audio', async () => {
  const results = await Promise.allSettled([...sinks.values()].filter(a => a.srcObject?.getTracks().length).map(a => a.play()));
  $('#play-audio').hidden = !results.some(r => r.status === 'rejected'); if (!$('#play-audio').hidden) notify('Audio playback is still blocked. Check site audio permissions.', true);
});
for (const emoji of REACTIONS) {const button = document.createElement('button'); button.textContent = emoji; button.type = 'button'; button.setAttribute('aria-label', `React ${emoji}`); button.onclick = () => {try {session.react(emoji);} catch (error) {failure(error);}}; $('#reactions').append(button);}
$('#chat-form').addEventListener('submit', event => {event.preventDefault(); try {session.sendChat($('#message').value); $('#message').value = '';} catch (error) {failure(error);}});
$('#message').addEventListener('keydown', event => {if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {event.preventDefault(); $('#chat-form').requestSubmit();}});
bind('#lock', () => transport.control('lock', {locked: !lastRoster.locked}));
bind('#end', async () => {if (confirm('End this meeting for everyone? All participants will be disconnected.')) {await transport.control('end'); endLocal('You ended the meeting for everyone.');}});
async function copy(value, field) {
  try {if (!navigator.clipboard?.writeText) throw new Error(); await navigator.clipboard.writeText(value); notify('Copied. Share it privately with the intended participant.');}
  catch {if (field) {field.value = value; field.focus(); field.select();} else {prompt('Copy this private meeting invitation:', value);} notify('Automatic copying is unavailable. Select and copy the displayed text.');}
}
bind('#copy-invite', () => copy(inviteLink)); bind('#copy-pairing', () => copy($('#pairing-output').value, $('#pairing-output')));

async function startDirect(accept) {
  if (starting || session || transport || finished) return;
  const displayName = name(); let ice;
  try {ice = iceConfiguration(JSON.parse($('#ice').value));} catch (error) {throw new Error(`Invalid direct-pairing ICE settings: ${error.message}`);}
  starting = true; direct = true;
  try {
    makeSession({name: displayName, iceServers: ice}); showMeeting('Direct peer-to-peer meeting');
    $('#pairing').hidden = false; $('#pairing-output').value = ''; $('#answer-box').hidden = accept;
    $('#pairing-help').textContent = 'Gathering connection details…';
    const result = accept ? await session.acceptOffer($('#offer-input').value.trim()) : await session.createOffer();
    if (finished) return;
    $('#pairing-output').value = result;
    $('#pairing-help').textContent = accept ? 'Send this answer back to the person who created the offer. Leave this tab open while they complete the connection.' : 'Send this offer privately to the other person. They select Direct pairing, paste your offer, and send their answer back. Paste that answer below.';
    notify('No signaling service is used. Keep both tabs open; configured ICE servers may still be needed to connect across networks.');
  } catch (error) {notify(error.message, true); endLocal(`Direct pairing failed: ${error.message}`);}
  finally {starting = false;}
}
bind('#direct-create', () => startDirect(false)); bind('#direct-accept', () => startDirect(true));
bind('#apply-answer', async () => {await session.acceptAnswer($('#answer-input').value.trim()); $('#answer-box').hidden = true; notify('Answer accepted. Connecting directly to your peer…');});

function endLocal(reason = 'You left the meeting. Your camera, microphone and screen capture have stopped.') {
  if (finished) return; finished = true;
  clearInterval(durationTimer); clearTimeout(stateTimer); clearTimeout(reactionTimer); abort.abort(); meter.dispose();
  session?.stop(); media.dispose(); transport?.close();
  for (const tile of tiles.values()) {const video = tile.querySelector('video'); video.pause(); video.srcObject = null;}
  for (const sink of sinks.values()) {sink.pause(); sink.srcObject = null;}
  $('#preview').srcObject = null; $('#pairing-output').value = ''; $('#answer-input').value = ''; $('#offer-input').value = ''; $('#invite').value = '';
  document.body.classList.remove('meeting-active');
  $('#setup').hidden = $('#waiting').hidden = $('#meeting').hidden = true; $('#ended').hidden = false;
  $('#ended-reason').textContent = reason; notify(''); inviteLink = ''; session = null; transport = null;
}
bind('#leave', () => endLocal()); bind('#cancel-wait', () => endLocal('You left the waiting room. Your preview devices have stopped.'));
window.addEventListener('pagehide', () => endLocal(), {once: true});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') {$('#side-panel').hidden = true; document.querySelectorAll('.more-controls[open]').forEach(el => {el.open = false;});}
  if (session && (event.ctrlKey || event.metaKey) && event.shiftKey && event.code === 'KeyM') {event.preventDefault(); session.setDevice('audio', !session.state().audio).catch(failure);}
});
