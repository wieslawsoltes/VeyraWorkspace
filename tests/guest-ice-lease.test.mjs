import test from 'node:test';
import assert from 'node:assert/strict';
import {IceLease} from '../public/core/ice-lease.js';
function fixture(overrides = {}) {
  const jobs = new Map(), applied = [], errors = []; let id = 0;
  const lease = new IceLease({now: () => 1000, schedule: (fn, ms) => {jobs.set(++id, {fn, ms}); return id;}, cancel: key => jobs.delete(key),
    request: async () => ({iceServers: [{urls: ['turn:relay.example'], credential: 'new'}], expiresAt: 1201000}),
    apply: servers => applied.push(servers), onError: error => errors.push(error), ...overrides});
  async function tick() {const [key, job] = jobs.entries().next().value; jobs.delete(key); await job.fn();}
  return {lease, jobs, applied, errors, tick};
}

test('TURN credentials renew at half-life and apply to existing and future ICE configuration', async () => {
  const f = fixture(); f.lease.start({expiresAt: 601000});
  assert.equal([...f.jobs.values()][0].ms, 300000); await f.tick();
  assert.equal(f.applied[0][0].credential, 'new'); assert.equal(f.jobs.size, 1); f.lease.close(); assert.equal(f.jobs.size, 0);
});

test('non-expiring explicit ICE configuration does not poll the broker', () => {
  const f = fixture(); f.lease.start({expiresAt: null}); assert.equal(f.jobs.size, 0); f.lease.close();
});

test('failed renewal is visible and retries with a bounded thirty-second delay', async () => {
  const f = fixture({request: async () => {throw new Error('offline');}}); f.lease.start({expiresAt: 2000});
  assert.equal([...f.jobs.values()][0].ms, 15000); await f.tick();
  assert.equal(f.errors[0].message, 'offline'); assert.equal(f.applied.length, 0); assert.equal([...f.jobs.values()][0].ms, 30000); f.lease.close();
});

test('pause and restart discard a stale asynchronous lease without applying old credentials', async () => {
  let resolve; const f = fixture({request: () => new Promise(r => {resolve = r;})});
  f.lease.start({expiresAt: 601000}); const work = f.tick();
  f.lease.pause(); f.lease.start({expiresAt: 901000}); resolve({iceServers: ['stale'], expiresAt: 601000}); await work;
  assert.equal(f.applied.length, 0); assert.equal(f.jobs.size, 1); f.lease.close();
});

test('closing during a pending renewal prevents media changes and subsequent timers', async () => {
  let resolve; const f = fixture({request: () => new Promise(r => {resolve = r;})});
  f.lease.start({expiresAt: 601000}); const work = f.tick(); f.lease.close();
  resolve({iceServers: [], expiresAt: 601000}); await work; f.lease.start({expiresAt: 601000});
  assert.equal(f.applied.length, 0); assert.equal(f.jobs.size, 0);
});
