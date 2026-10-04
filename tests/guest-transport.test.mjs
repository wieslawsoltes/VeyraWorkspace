import test from 'node:test';
import assert from 'node:assert/strict';
import {GuestTransport} from '../public/core/guest-transport.js';
const membership = {roomId: 'a'.repeat(22), participantId: 'b'.repeat(22), participantToken: 'c'.repeat(43)};

test('guest HTTP requests omit workspace credentials and keep capabilities out of URLs', async () => {
  const requests = [];
  const transport = new GuestTransport('https://meet.example.com', {fetch: async (url, options) => {requests.push({url, options}); return Response.json(membership);}});
  await transport.create('Alex', 'Design'); await transport.ice();
  assert.equal(requests[0].options.credentials, 'omit'); assert.equal(requests[0].options.headers.Authorization, undefined);
  assert.equal(requests[1].options.headers.Authorization, `Bearer ${membership.participantToken}`);
  assert.equal(requests[1].url.includes(membership.participantToken), false); assert.equal(requests[1].options.referrerPolicy, 'no-referrer');
  transport.close(false);
});

test('non-idempotent failed create is never silently retried', async () => {
  let attempts = 0; const transport = new GuestTransport('https://meet.example.com', {fetch: async () => {attempts++; return Response.json({error: 'Unavailable'}, {status: 503});}});
  await assert.rejects(transport.create('Alex', 'Design'), /Unavailable/); assert.equal(attempts, 1); transport.close(false);
});

test('stream parser handles fragmented UTF-8/CRLF frames and terminal removal without reconnect', async () => {
  const encoder = new TextEncoder(), frames = encoder.encode('data: {"type":"ready"}\r\n\r\ndata: {"type":"roster","title":"Zażółć 🎉"}\r\n\r\ndata: {"type":"removed"}\r\n\r\n');
  let requests = 0;
  const transport = new GuestTransport('https://meet.example.com', {fetch: async () => {requests++; return new Response(new ReadableStream({start(controller) {
    for (let i = 0; i < frames.length; i += 3) controller.enqueue(frames.slice(i, i + 3)); controller.close();
  }}), {headers: {'Content-Type': 'text/event-stream'}});}});
  transport.session = {...membership}; const events = []; transport.addEventListener('event', e => events.push(e.detail));
  await transport.start(); assert.equal(requests, 1); assert.equal(events[1].title, 'Zażółć 🎉'); assert.equal(transport.closed, true); assert.equal(transport.session, null);
});

test('expired guest capabilities terminate rather than entering an infinite reconnect loop', async () => {
  const transport = new GuestTransport('https://meet.example.com', {fetch: async () => Response.json({error: 'Expired'}, {status: 401})});
  transport.session = {...membership}; const events = []; transport.addEventListener('event', e => events.push(e.detail));
  await transport.start(); assert.equal(events[0].type, 'expired'); assert.equal(transport.closed, true);
});

test('oversized streaming frames are rejected with bounded buffering', async () => {
  const transport = new GuestTransport('https://meet.example.com', {fetch: async () => new Response(new ReadableStream({start(controller) {controller.enqueue(new TextEncoder().encode('x'.repeat(160001))); controller.close();}}), {headers: {'Content-Type': 'text/event-stream'}})});
  transport.session = {...membership}; let message;
  transport.addEventListener('error', e => {message = e.detail.message; transport.close(false);});
  await transport.start(); assert.match(message, /too large/);
});


test('native-style fetch keeps its global receiver for requests, streams and leave', async () => {
  const requests = [];
  function nativeLike(url, options) {
    assert.equal(this, globalThis, 'Web IDL fetch receiver must be the global object');
    requests.push(url);
    if (url.endsWith('/events')) return Promise.resolve(new Response('data: {"type":"ready"}\n\ndata: {"type":"ended"}\n\n', {headers: {'Content-Type': 'text/event-stream'}}));
    return Promise.resolve(Response.json(membership));
  }
  const transport = new GuestTransport('https://meet.example.com', {fetch: nativeLike});
  await transport.create('Alex', 'Meeting'); await transport.ice(); await transport.start();
  assert.equal(transport.closed, true); assert.equal(requests.length, 3);
  const leaving = new GuestTransport('https://meet.example.com', {fetch: nativeLike});
  leaving.session = {...membership}; leaving.close();
  assert.ok(requests.at(-1).endsWith('/leave'));
});

test('silent signaling headers time out instead of leaving joining stuck forever', async () => {
  const transport = new GuestTransport('https://meet.example.com', {streamTimeoutMs: 20, fetch: (url, {signal}) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), {once: true});
  })});
  transport.session = {...membership}; let message;
  transport.addEventListener('error', e => {message = e.detail.message; transport.close(false);});
  await transport.start(); assert.match(message, /stopped responding/); assert.equal(transport.closed, true);
});

test('a stalled SSE body is aborted and reported even after a ready event', async () => {
  const transport = new GuestTransport('https://meet.example.com', {streamTimeoutMs: 20, fetch: async (url, {signal}) => new Response(new ReadableStream({start(controller) {
    controller.enqueue(new TextEncoder().encode('data: {"type":"ready"}\n\n'));
    signal.addEventListener('abort', () => controller.error(new DOMException('Aborted', 'AbortError')), {once: true});
  }}), {headers: {'Content-Type': 'text/event-stream'}})});
  transport.session = {...membership}; let wasConnected = false;
  transport.addEventListener('connection', e => {wasConnected ||= e.detail.connected;});
  transport.addEventListener('error', () => transport.close(false));
  await transport.start(); assert.equal(wasConnected, true); assert.equal(transport.closed, true);
});

test('explicit reconnect replaces only the stream and keeps the participant capability', async () => {
  let count = 0; const options = [];
  const transport = new GuestTransport('https://meet.example.com', {fetch: async (url, init) => {
    options.push(init); count++;
    return new Response(new ReadableStream({start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"type":"ready"}\n\n'));
      if (count === 2) {controller.enqueue(new TextEncoder().encode('data: {"type":"ended"}\n\n')); controller.close();}
      else init.signal.addEventListener('abort', () => controller.error(new DOMException('Aborted', 'AbortError')), {once: true});
    }}), {headers: {'Content-Type': 'text/event-stream'}});
  }});
  transport.session = {...membership}; const errors = [];
  transport.addEventListener('error', e => errors.push(e.detail));
  transport.addEventListener('event', e => {if (e.detail.type === 'ready' && count === 1) transport.reconnect();});
  await transport.start(); assert.equal(count, 2); assert.equal(errors.length, 0);
  assert.equal(options[0].headers.Authorization, options[1].headers.Authorization);
});
