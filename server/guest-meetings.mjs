import {randomBytes, createHash, createHmac, timingSafeEqual} from 'node:crypto';
import {MAX_GUEST_PEERS, ID_PATTERN, TOKEN_PATTERN, fault, object, text, mediaState, rtcSignal, iceConfiguration} from '../public/core/guest-protocol.js';

const PREFIX = '/api/guest-meetings';
const token = () => randomBytes(32).toString('base64url');
const id = () => randomBytes(16).toString('base64url');
const digest = value => createHash('sha256').update(value).digest();
const equal = (value, expected) => TOKEN_PATTERN.test(value || '') && timingSafeEqual(digest(value), expected);

/** Anonymous, ephemeral capability-scoped signaling. No access to workspace DB/sessions.
 * Media/chat use WebRTC, not this service. Admission never asks for an account/password.
 */
export function createGuestMeetings(options = {}) {
  const enabled = options.enabled ?? process.env.GUEST_MEETINGS_ENABLED !== 'false';
  const origin = options.origin || (() => process.env.PUBLIC_ORIGIN || 'http://localhost:4173');
  const allowed = new Set(options.allowedOrigins ?? (process.env.GUEST_ALLOWED_ORIGINS || '').split(',').filter(Boolean));
  for (const value of allowed) if (new URL(value).origin !== value || !/^https:\/\//.test(value)) throw fault('GUEST_ALLOWED_ORIGINS must contain exact HTTPS origins.');
  const maxRooms = options.maxRooms ?? 128, ttl = options.ttlMs ?? 4 * 3600000;
  const grace = options.graceMs ?? 120000, now = options.now || Date.now;
  const ice = iceConfiguration(options.iceServers ?? JSON.parse(process.env.GUEST_ICE_SERVERS_JSON || '[]'));
  const turnSecret = options.turnSecret ?? (process.env.GUEST_TURN_ENABLED === 'true' ? process.env.TURN_SECRET : '');
  const turnUrls = options.turnUrls ?? (process.env.TURN_URLS || '').split(',').filter(Boolean);
  if (turnSecret) iceConfiguration([{urls: turnUrls}]);
  const rooms = new Map(), rates = new Map(); let closed = false;
  function rate(key, maximum, period = 60000) {
    let bucket = rates.get(key); const time = now();
    if (!bucket || bucket.until <= time) {
      if (rates.size >= 20000) for (const [k, b] of rates) if (b.until <= time) rates.delete(k);
      if (rates.size >= 20000 && !rates.has(key)) throw fault('Service is busy. Try again later.', 503);
      rates.set(key, bucket = {count: 0, until: time + period});
    }
    if (++bucket.count > maximum) throw fault('Too many requests. Try again later.', 429);
  }
  function json(res, status, data) {
    res.writeHead(status, {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store'});
    res.end(JSON.stringify(data));
  }
  async function body(req) {
    if (!(req.headers['content-type'] || '').startsWith('application/json')) {req.resume(); throw fault('Use application/json.', 415);}
    if (Number(req.headers['content-length'] || 0) > 80000) {req.resume(); throw fault('Request is too large.', 413);}
    const chunks = []; let size = 0;
    for await (const chunk of req) {size += chunk.length; if (size > 80000) throw fault('Request is too large.', 413); chunks.push(chunk);}
    try {return object(JSON.parse(Buffer.concat(chunks).toString('utf8')));} catch (e) {throw fault(e.status ? e.message : 'Invalid JSON.');}
  }
  function send(person, event) {
    const response = person.res;
    if (!response || response.destroyed || response.writableEnded) return;
    if (response.writableLength > 256 * 1024) {response.destroy(); return;}
    response.write(`data: ${JSON.stringify(event)}\n\n`);
  }
  const personDTO = p => ({id: p.id, name: p.name, host: p.host, ...p.state});
  function snapshot(room, person) {
    return {type: 'roster', revision: room.revision, title: room.title, locked: room.locked, expiresAt: room.expiresAt, host: person.host,
      hostConnected: [...room.people.values()].some(p => p.host && !!p.res),
      approved: person.approved, selfId: person.id,
      peers: person.approved ? [...room.people.values()].filter(p => p.joined && p.id !== person.id).map(personDTO) : [],
      waiting: person.host ? [...room.people.values()].filter(p => !p.approved).map(personDTO) : []};
  }
  function roster(room) {++room.revision; for (const person of room.people.values()) send(person, snapshot(room, person));}
  function disconnect(room, person, response) {
    if (person.res !== response) return;
    person.res = null; person.joined = false; person.touched = now(); roster(room);
  }
  function remove(room, person, reason = 'removed') {
    room.people.delete(person.id); send(person, {type: reason}); const res = person.res; person.res = null; res?.end(); roster(room);
  }
  function finish(room, reason = 'ended') {
    rooms.delete(room.id);
    for (const p of room.people.values()) {send(p, {type: reason}); const res = p.res; p.res = null; res?.end();}
    room.people.clear();
  }
  function sweep() {
    const time = now();
    for (const [key, bucket] of rates) if (bucket.until <= time) rates.delete(key);
    for (const room of rooms.values()) {
      if (room.expiresAt <= time) {finish(room, 'expired'); continue;}
      for (const person of [...room.people.values()]) {
        if (!person.res && time - person.touched > grace) remove(room, person, 'expired');
        else if (person.res) {
          if (person.res.writableLength > 256 * 1024) person.res.destroy();
          else person.res.write(': heartbeat\n\n');
        }
      }
      if (!room.people.size) rooms.delete(room.id);
    }
  }
  const timer = setInterval(sweep, options.sweepMs ?? 15000); timer.unref();
  function newPerson(name, host, approved) {
    const secret = token(), person = {id: id(), name: text(name, 80, 'Display name'), host, approved, joined: false,
      secretHash: digest(secret), state: mediaState(), touched: now(), res: null};
    return {person, secret};
  }
  function authenticate(req, room) {
    const secret = (req.headers.authorization || '').replace(/^Bearer /, '');
    if (!TOKEN_PATTERN.test(secret)) throw fault('Meeting session is not valid.', 401);
    const hash = digest(secret), person = [...room.people.values()].find(p => timingSafeEqual(hash, p.secretHash));
    if (!person) throw fault('Meeting session has ended.', 401);
    person.touched = now(); return person;
  }
  async function route(req, res, url) {
    if (!enabled || closed) throw fault('Guest meetings are disabled on this server.', 503);
    const address = req.socket.remoteAddress || 'unknown'; // Never trust forwarded IP headers by default.
    rate(`all:${address}`, 1200);
    const supplied = req.headers.origin, expected = typeof origin === 'function' ? origin() : origin;
    const accepted = supplied && supplied !== 'null' && (supplied === expected || allowed.has(supplied));
    res.setHeader('Vary', 'Origin');
    if (accepted && supplied !== expected) {
      res.setHeader('Access-Control-Allow-Origin', supplied);
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
      res.setHeader('Access-Control-Max-Age', '600');
    }
    if (req.method === 'OPTIONS') {
      if (!accepted) throw fault('Origin is not allowed.', 403);
      res.writeHead(204); res.end(); return;
    }
    const parts = url.pathname.slice(PREFIX.length).split('/').filter(Boolean);
    if (!parts.length && req.method === 'GET') return json(res, 200, {service: 'veyra-guest-meetings', maxPeers: MAX_GUEST_PEERS, ttlMs: ttl});
    // Same-origin browser GETs may omit Origin. These reads require a non-ambient
    // bearer capability; mutations and cross-origin requests still require an exact origin.
    if (!accepted && !(req.method === 'GET' && supplied === undefined))
      throw fault('Origin is not allowed. Configure PUBLIC_ORIGIN and, when needed, GUEST_ALLOWED_ORIGINS.', 403);
    if (!parts.length && req.method === 'POST') {
      rate(`create:${address}`, options.createLimit ?? 10, 3600000);
      if (rooms.size >= maxRooms) throw fault('Meeting capacity reached. Try again later.', 503);
      const input = await body(req), {person, secret} = newPerson(input.name, true, true);
      const inviteKey = token(), room = {id: id(), title: text(input.title || 'Guest meeting', 100, 'Meeting title'),
        revision: 0, inviteHash: digest(inviteKey), expiresAt: now() + ttl, locked: false, waitingRoom: input.waitingRoom !== false, people: new Map([[person.id, person]])};
      // Recheck after the body await: concurrent requests must not evade capacity.
      if (rooms.size >= maxRooms) throw fault('Meeting capacity reached.', 503);
      rooms.set(room.id, room);
      return json(res, 201, {roomId: room.id, inviteKey, participantId: person.id, participantToken: secret, ...snapshot(room, person)});
    }
    if (parts.length > 2 || !ID_PATTERN.test(parts[0] || '')) throw fault('Meeting not found.', 404);
    const room = rooms.get(parts[0]);
    if (!room || room.expiresAt <= now()) {if (room) finish(room, 'expired'); throw fault('This meeting has ended or expired.', 404);}
    const action = parts[1];
    if (action === 'join' && req.method === 'POST') {
      rate(`join:${address}`, 60, 3600000);
      if (!equal((req.headers.authorization || '').replace(/^Invite /, ''), room.inviteHash)) throw fault('Invalid or expired invitation.', 403);
      const input = await body(req);
      if (room.locked) throw fault('The host has locked this meeting.', 423);
      if (!rooms.has(room.id) || room.expiresAt <= now()) throw fault('This meeting has ended.', 404);
      if (room.people.size >= MAX_GUEST_PEERS + 16 || (room.waitingRoom && [...room.people.values()].filter(p => !p.approved).length >= 16)) throw fault('This meeting and its waiting room are full.', 409);
      if (!room.waitingRoom && [...room.people.values()].filter(p => p.approved).length >= MAX_GUEST_PEERS) throw fault('This meeting is full.', 409);
      const {person, secret} = newPerson(input.name, false, !room.waitingRoom); room.people.set(person.id, person); roster(room);
      return json(res, 201, {roomId: room.id, participantId: person.id, participantToken: secret, ...snapshot(room, person)});
    }
    const person = authenticate(req, room);
    rate(`session:${person.id}`, 600);
    if (action === 'events' && req.method === 'GET') {
      // One stream per capability. Abort old stream before installing its replacement.
      if (person.res) {const previous = person.res; person.res = null; person.joined = false; previous.end(); roster(room);}
      res.writeHead(200, {'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store, no-transform', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no'});
      person.res = res; send(person, {...snapshot(room, person), type: 'ready'});
      res.on('close', () => disconnect(room, person, res)); return;
    }
    if (action === 'leave' && req.method === 'POST') {await body(req); remove(room, person, 'left'); return json(res, 200, {ok: true});}
    if (!person.approved) throw fault('Wait for the host to admit you.', 403);
    if (action === 'ice' && req.method === 'GET') {
      rate(`ice:${person.id}`, 6);
      const iceServers = structuredClone(ice);
      if (turnSecret) {
        const expires = Math.min(Math.floor(room.expiresAt / 1000), Math.floor(now() / 1000) + 600), username = `${expires}:guest-${person.id}`;
        iceServers.push({urls: turnUrls, username, credential: createHmac('sha1', turnSecret).update(username).digest('base64')});
      }
      return json(res, 200, {iceServers});
    }
    if (action === 'presence' && req.method === 'POST') {
      const input = await body(req);
      if (!person.res) throw fault('Reconnect signaling before joining media.', 409);
      if (!room.people.has(person.id)) throw fault('Meeting session has ended.', 401);
      person.state = mediaState(input); person.joined = true; roster(room); return json(res, 200, snapshot(room, person));
    }
    if (action === 'signal' && req.method === 'POST') {
      if (!person.joined || !person.res) throw fault('Join the meeting first.', 403);
      const input = await body(req), target = room.people.get(input.target);
      if (!room.people.has(person.id)) throw fault('Meeting session has ended.', 401);
      if (!target?.joined || !target.res || target.id === person.id) throw fault('The participant is no longer connected.', 404);
      send(target, {type: 'signal', from: person.id, name: person.name, ...rtcSignal(input)}); return json(res, 200, {ok: true});
    }
    if (action === 'control' && req.method === 'POST') {
      if (!person.host) throw fault('Only the host may change meeting access.', 403);
      const input = await body(req);
      if (!room.people.has(person.id) || !rooms.has(room.id)) throw fault('Meeting session has ended.', 401);
      if (input.action === 'end') {finish(room); return json(res, 200, {ok: true});}
      if (input.action === 'lock') {
        if (typeof input.locked !== 'boolean') throw fault('locked must be a boolean.'); room.locked = input.locked;
      } else {
        const target = room.people.get(input.participantId);
        if (!target || target.host) throw fault('Participant not found.', 404);
        if (input.action === 'admit') {
          if (!target.approved && [...room.people.values()].filter(p => p.approved).length >= MAX_GUEST_PEERS) throw fault('This meeting is full.', 409);
          target.approved = true; send(target, {type: 'admitted'});
        } else if (input.action === 'remove') remove(room, target);
        else throw fault('Unknown host control.');
      }
      roster(room); return json(res, 200, {ok: true});
    }
    throw fault('Meeting route not found.', 404);
  }
  return {
    async handle(req, res) {
      let url; try {url = new URL(req.url, 'http://localhost');} catch {return false;}
      if (url.pathname !== PREFIX && !url.pathname.startsWith(PREFIX + '/')) return false;
      res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'no-referrer');
      res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
      try {await route(req, res, url);} catch (e) {
        if (res.headersSent) res.end(); else json(res, e.status || 500, {error: e.status ? e.message : 'Guest meeting service failed.'});
      }
      return true;
    },
    sweep,
    close() {if (closed) return; closed = true; clearInterval(timer); for (const room of rooms.values()) finish(room); rates.clear();}
  };
}

/** Explicit HTTP adapter. All non-guest requests retain the original auth/path checks. */
export function attachGuestMeetings(server, options) {
  const broker = createGuestMeetings(options), handlers = server.listeners('request');
  server.removeAllListeners('request');
  server.on('request', async (req, res) => {
    if (await broker.handle(req, res)) return;
    if (!handlers.length) {res.writeHead(404); res.end(); return;}
    for (const handler of handlers) handler.call(server, req, res);
  });
  server.once('close', () => broker.close()); return broker;
}
