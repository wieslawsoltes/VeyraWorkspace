import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {createGuestMeetings, attachGuestMeetings} from '../server/guest-meetings.mjs';

async function fixture(t, options = {}) {
  let origin;
  const broker = createGuestMeetings({origin: () => origin, createLimit: 100, ...options});
  const server = http.createServer(async (req, res) => {
    if (!await broker.handle(req, res)) {res.writeHead(req.url.startsWith('/api/') ? 401 : 404); res.end('{}');}
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {broker.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));});
  async function request(route = '', body, auth, method = body === undefined ? 'GET' : 'POST', requestOrigin = origin) {
    const headers = {Origin: requestOrigin};
    if (auth) headers.Authorization = auth;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await fetch(origin + '/api/guest-meetings' + route, {method, headers, body: body === undefined ? undefined : JSON.stringify(body)});
    return {status: response.status, headers: response.headers, data: await response.json().catch(() => null)};
  }
  async function create(extra = {}) {const result = await request('', {name: 'Host', title: 'Design review', ...extra}); assert.equal(result.status, 201); return result.data;}
  async function join(host, extra = {}) {return request(`/${host.roomId}/join`, {name: 'Guest', ...extra}, `Invite ${host.inviteKey}`);}
  const auth = person => `Bearer ${person.participantToken}`;
  const command = (person, action, extra = {}) => request(`/${person.roomId}/control`, {action, ...extra}, auth(person));
  async function stream(person) {
    const abort = new AbortController(); t.after(() => abort.abort());
    const response = await fetch(`${origin}/api/guest-meetings/${person.roomId}/events`, {headers: {Origin: origin, Authorization: auth(person)}, signal: abort.signal});
    assert.equal(response.status, 200);
    const reader = response.body.getReader(), decoder = new TextDecoder(); let buffer = '';
    async function next(type) {
      for (;;) {
        let end = buffer.indexOf('\n\n');
        if (end < 0) {const {value, done} = await reader.read(); if (done) return null; buffer += decoder.decode(value, {stream: true}); continue;}
        const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
        if (!frame.startsWith('data:')) continue;
        const event = JSON.parse(frame.slice(5)); if (!type || event.type === type) return event;
      }
    }
    assert.equal((await next()).type, 'ready'); return {abort, next};
  }
  const presence = person => request(`/${person.roomId}/presence`, {audio: true}, auth(person));
  return {broker, server, origin, request, create, join, auth, command, stream, presence};
}

test('guest creation requires no account, issues only scoped capabilities, and defaults to a waiting room', async t => {
  const f = await fixture(t), host = await f.create(), guest = (await f.join(host)).data;
  assert.match(host.inviteKey, /^[\w-]{43}$/); assert.match(host.participantToken, /^[\w-]{43}$/);
  assert.notEqual(host.participantToken, guest.participantToken); assert.notEqual(host.inviteKey, host.participantToken);
  assert.equal(guest.approved, false); assert.deepEqual(guest.peers, []); assert.deepEqual(guest.waiting, []);
  assert.equal('inviteKey' in guest, false); assert.equal('participantToken' in guest.peers, false);
  assert.equal((await f.request(`/${host.roomId}/ice`, undefined, f.auth(guest))).status, 403);
});

test('Origin is mandatory for mutations; malicious and null origins are rejected', async t => {
  const f = await fixture(t);
  for (const origin of ['https://evil.example', 'null', '']) assert.equal((await f.request('', {name: 'Host'}, undefined, 'POST', origin)).status, 403);
  assert.equal((await f.request('')).status, 200);
});

test('host admits waiting guests; guests cannot use host controls or impersonate a host', async t => {
  const f = await fixture(t), host = await f.create(), guest = (await f.join(host, {host: true, approved: true})).data;
  const waiting = await f.stream(guest);
  assert.equal((await f.command(guest, 'end')).status, 403);
  assert.equal((await f.command(host, 'admit', {participantId: guest.participantId})).status, 200);
  assert.equal((await waiting.next('admitted')).type, 'admitted');
  assert.equal((await f.request(`/${host.roomId}/ice`, undefined, f.auth(guest))).status, 200);
  assert.equal((await f.command(guest, 'lock', {locked: true})).status, 403);
});

test('invite and participant capabilities are not interchangeable or valid across meetings', async t => {
  const f = await fixture(t), one = await f.create(), two = await f.create();
  assert.equal((await f.request(`/${one.roomId}/join`, {name: 'X'}, f.auth(one))).status, 403);
  assert.equal((await f.request(`/${one.roomId}/ice`, undefined, `Bearer ${one.inviteKey}`)).status, 401);
  assert.equal((await f.request(`/${two.roomId}/ice`, undefined, f.auth(one))).status, 401);
  assert.equal((await f.request(`/${one.roomId}/join`, {name: 'X'}, `Invite ${two.inviteKey}`)).status, 403);
  assert.equal((await fetch(f.origin + '/api/bootstrap', {headers: {Authorization: f.auth(one)}})).status, 401);
});

test('lock prevents new joins without revoking admitted participants; unlock restores access', async t => {
  const f = await fixture(t), host = await f.create({waitingRoom: false}), guest = (await f.join(host)).data;
  assert.equal((await f.command(host, 'lock', {locked: true})).status, 200);
  assert.equal((await f.join(host)).status, 423);
  assert.equal((await f.request(`/${host.roomId}/ice`, undefined, f.auth(guest))).status, 200);
  assert.equal((await f.command(host, 'lock', {locked: 'false'})).status, 400);
  await f.command(host, 'lock', {locked: false}); assert.equal((await f.join(host)).status, 201);
});

test('removal invalidates tokens, closes media roster membership and emits removal', async t => {
  const f = await fixture(t), host = await f.create({waitingRoom: false}), guest = (await f.join(host)).data;
  const events = await f.stream(guest); await f.presence(guest);
  assert.equal((await f.command(host, 'remove', {participantId: guest.participantId})).status, 200);
  assert.equal((await events.next('removed')).type, 'removed');
  assert.equal((await f.request(`/${host.roomId}/ice`, undefined, f.auth(guest))).status, 401);
  assert.equal((await f.command(host, 'remove', {participantId: host.participantId})).status, 404);
});

test('end closes the room for all participants and destroys invitation access', async t => {
  const f = await fixture(t), host = await f.create(), stream = await f.stream(host);
  assert.equal((await f.command(host, 'end')).status, 200); assert.equal((await stream.next('ended')).type, 'ended');
  assert.equal((await f.join(host)).status, 404); assert.equal((await f.request(`/${host.roomId}/ice`, undefined, f.auth(host))).status, 404);
});

test('capacity remains bounded with concurrent join requests and admits', async t => {
  const f = await fixture(t), host = await f.create({waitingRoom: false});
  const results = await Promise.all(Array.from({length: 12}, () => f.join(host)));
  assert.equal(results.filter(r => r.status === 201).length, 7);
  assert.equal(results.filter(r => r.status === 409).length, 5);
  const waitingHost = await f.create();
  const waiting = await Promise.all(Array.from({length: 25}, () => f.join(waitingHost)));
  assert.equal(waiting.filter(r => r.status === 201).length, 16);
  const admitted = await Promise.all(waiting.filter(r => r.status === 201).map(r => f.command(waitingHost, 'admit', {participantId: r.data.participantId})));
  assert.equal(admitted.filter(r => r.status === 200).length, 7);
});

test('room creation limit is rechecked after reading concurrent request bodies', async t => {
  const f = await fixture(t, {maxRooms: 1});
  const results = await Promise.all(Array.from({length: 4}, () => f.request('', {name: 'Host'})));
  assert.equal(results.filter(r => r.status === 201).length, 1); assert.equal(results.filter(r => r.status === 503).length, 3);
});

test('room lifetime and disconnected participant grace expire capabilities', async t => {
  let now = Date.now(); const f = await fixture(t, {now: () => now, ttlMs: 10000, graceMs: 1000});
  const host = await f.create(), guest = (await f.join(host)).data;
  await f.stream(host); now += 1001; f.broker.sweep();
  assert.equal((await f.request(`/${host.roomId}/ice`, undefined, f.auth(guest))).status, 401);
  now += 10000; f.broker.sweep(); assert.equal((await f.join(host)).status, 404);
});

test('per-address create budget applies without trusting spoofed forwarded headers', async t => {
  const f = await fixture(t, {createLimit: 1}); await f.create();
  const response = await fetch(f.origin + '/api/guest-meetings', {method: 'POST', headers: {Origin: f.origin, 'Content-Type': 'application/json', 'X-Forwarded-For': '8.8.8.8'}, body: '{"name":"Host"}'});
  assert.equal(response.status, 429);
});

test('CORS uses exact configured origins without cookies or wildcards', async t => {
  const f = await fixture(t, {allowedOrigins: ['https://wieslawsoltes.github.io']});
  const response = await fetch(f.origin + '/api/guest-meetings', {method: 'OPTIONS', headers: {Origin: 'https://wieslawsoltes.github.io'}});
  assert.equal(response.status, 204); assert.equal(response.headers.get('access-control-allow-origin'), 'https://wieslawsoltes.github.io');
  assert.equal(response.headers.has('access-control-allow-credentials'), false);
  assert.equal((await f.request('', {name: 'Host'}, undefined, 'POST', 'https://wieslawsoltes.github.io.evil.example')).status, 403);
  assert.throws(() => createGuestMeetings({allowedOrigins: ['*']}));
});

test('signaling requires active scoped streams and strips forged sender identity', async t => {
  const f = await fixture(t), host = await f.create({waitingRoom: false}), guest = (await f.join(host)).data;
  assert.equal((await f.presence(host)).status, 409);
  await f.stream(host); const stream = await f.stream(guest); await f.presence(host); await f.presence(guest);
  const route = `/${host.roomId}/signal`, sdp = {type: 'offer', sdp: 'v=0\r\n'};
  const response = await f.request(route, {target: guest.participantId, description: sdp, from: 'forged', name: 'Impersonated'}, f.auth(host));
  assert.equal(response.status, 200);
  const received = await stream.next('signal'); assert.equal(received.from, host.participantId); assert.equal(received.name, 'Host');
  assert.equal((await f.request(route, {target: guest.participantId, description: {type: 'rollback', sdp: 'v=0'}}, f.auth(host))).status, 400);
  assert.equal((await f.request(route, {target: guest.participantId, candidate: {candidate: 'x', sdpMLineIndex: -1}}, f.auth(host))).status, 400);
  assert.equal((await f.request(route, {target: host.participantId, description: sdp}, f.auth(host))).status, 404);
});

test('reopening a stream clears stale joined membership and requires a fresh presence', async t => {
  const f = await fixture(t), host = await f.create({waitingRoom: false}), guest = (await f.join(host)).data;
  await f.stream(host); await f.stream(guest); await f.presence(host); await f.presence(guest);
  await f.stream(guest);
  const roster = (await f.presence(host)).data; assert.deepEqual(roster.peers, []);
  await f.presence(guest); assert.equal((await f.presence(host)).data.peers.length, 1);
});

test('guest ICE is explicit; optional TURN credentials are short-lived and room-bounded', async t => {
  const f = await fixture(t, {ttlMs: 300000, turnSecret: 'test-only-secret', turnUrls: ['turn:relay.example:3478']});
  const host = await f.create(); const result = await f.request(`/${host.roomId}/ice`, undefined, f.auth(host));
  assert.equal(result.status, 200); const turn = result.data.iceServers[0];
  assert.equal(turn.urls[0], 'turn:relay.example:3478'); assert.ok(Number(turn.username.split(':')[0]) * 1000 <= host.expiresAt);
  assert.match(turn.credential, /^[\w+/]+=*$/); assert.equal(JSON.stringify(result.data).includes('test-only-secret'), false);
  const g = await fixture(t), plain = await g.create(); assert.deepEqual((await g.request(`/${plain.roomId}/ice`, undefined, g.auth(plain))).data.iceServers, []);
});

test('disabled service rejects requests; adapter preserves non-guest request handling', async t => {
  const f = await fixture(t, {enabled: false}); assert.equal((await f.request('')).status, 503);
  const server = http.createServer((req, res) => {res.writeHead(401); res.end('private');});
  const broker = attachGuestMeetings(server, {enabled: false});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {broker.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));});
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/bootstrap`);
  assert.equal(response.status, 401); assert.equal(await response.text(), 'private');
});

test('bounded JSON and strict field validation reject malformed anonymous inputs', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('', {name: ''})).status, 400);
  assert.equal((await f.request('', {name: 'x'.repeat(81)})).status, 400);
  assert.equal((await f.request('', {name: 'Host', padding: 'x'.repeat(81000)})).status, 413);
  const response = await fetch(f.origin + '/api/guest-meetings', {method: 'POST', headers: {Origin: f.origin, 'Content-Type': 'text/plain'}, body: '{}'});
  assert.equal(response.status, 415);
});


test('same-origin header-authenticated GET works without Origin; mutations still reject its absence', async t => {
  const f = await fixture(t), host = await f.create(), headers = {Authorization: f.auth(host)};
  const ice = await fetch(`${f.origin}/api/guest-meetings/${host.roomId}/ice`, {headers});
  assert.equal(ice.status, 200);
  const abort = new AbortController(); t.after(() => abort.abort());
  const events = await fetch(`${f.origin}/api/guest-meetings/${host.roomId}/events`, {headers, signal: abort.signal});
  assert.equal(events.status, 200); abort.abort();
  const mutation = await fetch(`${f.origin}/api/guest-meetings/${host.roomId}/control`, {method: 'POST', headers: {...headers, 'Content-Type': 'application/json'}, body: JSON.stringify({action: 'end'})});
  assert.equal(mutation.status, 403);
});
