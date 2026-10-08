import test from 'node:test';
import assert from 'node:assert/strict';
import { createStrongMotionWorker } from '../workers/strong-motion.mjs';

const BASE = 'https://relay.example/api/strong-motion/';
const ORIGIN = 'https://nekokun148.github.io';
const STAMP = '20261008220000';
const GIF = new Uint8Array([71, 73, 70, 56, 57, 97, 96, 1, 144, 1]);
const metadata = () => Response.json({ result: { status: 'success' }, latest_time: '2026/10/08 22:00:00', private: 'not forwarded' });
const request = (path, options = {}) => new Request(BASE + path, { headers: { Origin: ORIGIN }, ...options });

test('public relay exposes only timestamp metadata and shares simultaneous latest lookups', async () => {
  const calls = [];
  const handle = createStrongMotionWorker({ fetcher: async (url, options) => { calls.push({ url, options }); return metadata(); } });
  const a = handle(request('latest?metric=intensity'));
  const b = handle(request('latest?metric=acceleration'));
  const [first, second] = await Promise.all([a, b]);
  assert.deepEqual(await first.json(), { timestamp: STAMP, observedAt: '2026-10-08T22:00:00+09:00', image: `frame?metric=intensity&time=${STAMP}` });
  assert.equal((await second.json()).image, `frame?metric=acceleration&time=${STAMP}`);
  assert.equal(calls.length, 1);
  assert.equal(new URL(calls[0].url).hostname, 'www.kmoni.bosai.go.jp');
  assert.equal(calls[0].options.redirect, 'manual');
  assert.equal(calls[0].options.cache, 'no-store');
  assert.equal(first.headers.get('access-control-allow-origin'), ORIGIN);
  assert.equal(first.headers.get('cache-control'), 'no-store');
  assert.equal(first.headers.get('set-cookie'), null);
});

test('relay blocks other origins, methods, arbitrary URLs and invalid calendar timestamps before fetching', async () => {
  let calls = 0;
  const handle = createStrongMotionWorker({ fetcher: async () => { calls++; return metadata(); } });
  assert.equal((await handle(request('latest?metric=intensity', { headers: { Origin: 'https://other.example' } }))).status, 403);
  assert.equal((await handle(request('latest?metric=intensity', { method: 'POST' }))).status, 405);
  for (const path of ['latest?metric=constructor', 'latest?metric=intensity&url=http://localhost',
    'latest?metric=intensity&metric=acceleration', 'asset?kind=constructor', 'frame?metric=intensity&time=20260230220000',
    'frame?metric=intensity&time=20261008246000']) {
    assert.equal((await handle(request(path))).status, 400, path);
  }
  assert.equal((await handle(request('unknown'))).status, 404);
  const preflight = await handle(request('latest', { method: 'OPTIONS' }));
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-methods'), 'GET, OPTIONS');
  assert.equal(calls, 0);
});

test('relay forwards unchanged official GIF bytes and coalesces image requests', async () => {
  const calls = [];
  const handle = createStrongMotionWorker({ fetcher: async url => { calls.push(url); return new Response(GIF, { headers: { 'Content-Type': 'image/gif', 'Set-Cookie': 'ignored' } }); } });
  const responses = await Promise.all([handle(request(`frame?metric=acceleration&time=${STAMP}`)), handle(request(`frame?metric=acceleration&time=${STAMP}`))]);
  for (const response of responses) {
    assert.equal(response.status, 200);
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), GIF);
    assert.equal(response.headers.get('set-cookie'), null);
    assert.equal(response.headers.get('access-control-allow-origin'), ORIGIN);
  }
  assert.equal(calls.length, 1);
  assert.match(calls[0], /acmap_s\/20261008\/20261008220000.acmap_s.gif$/);
});

test('relay rejects HTML, malformed GIF, oversized data, unsuccessful or invalid metadata without caching success', async () => {
  const sources = [
    new Response('<html>bad</html>', { headers: { 'Content-Type': 'text/html' } }),
    new Response('GIFxyz1234', { headers: { 'Content-Type': 'image/gif' } }),
    new Response(new Uint8Array(1000001), { headers: { 'Content-Type': 'image/gif' } })
  ];
  for (const source of sources) {
    const handle = createStrongMotionWorker({ fetcher: async () => source });
    assert.equal((await handle(request(`frame?metric=intensity&time=${STAMP}`))).status, 502);
  }
  for (const data of [{ result: { status: 'failed' } }, { result: { status: 'success' }, latest_time: '2026/02/30 22:00:00' }]) {
    const handle = createStrongMotionWorker({ fetcher: async () => Response.json(data) });
    assert.equal((await handle(request('latest?metric=intensity'))).status, 502);
  }
});

test('relay timestamps expire within one second and source errors are briefly throttled then retried', async () => {
  let time = 10000, calls = 0, failure = false;
  const handle = createStrongMotionWorker({ now: () => time, fetcher: async () => { calls++; if (failure) throw new Error('hidden upstream detail'); return metadata(); } });
  const get = () => handle(request('latest?metric=intensity'));
  assert.equal((await get()).status, 200);
  time += 749; await get(); assert.equal(calls, 1);
  time++; failure = true;
  const failed = await get(); assert.equal(failed.status, 502);
  assert.equal((await failed.text()).includes('hidden'), false);
  assert.equal((await get()).status, 502); assert.equal(calls, 2);
  time += 1000; failure = false;
  assert.equal((await get()).status, 200); assert.equal(calls, 3);
});

test('edge cache survives a new isolate but never returns outdated latest metadata', async () => {
  let time = 10000, calls = 0;
  const entries = new Map();
  const edgeCache = { async match(key) { return entries.get(key.url)?.clone(); }, async put(key, response) { entries.set(key.url, response); } };
  const options = { now: () => time, edgeCache, fetcher: async () => { calls++; return metadata(); } };
  await createStrongMotionWorker(options)(request('latest?metric=intensity'));
  time += 500;
  assert.equal((await createStrongMotionWorker(options)(request('latest?metric=acceleration'))).status, 200);
  assert.equal(calls, 1);
  time += 250;
  await createStrongMotionWorker(options)(request('latest?metric=intensity'));
  assert.equal(calls, 2);
});

test('edge cache failures do not disable live observations', async () => {
  const handle = createStrongMotionWorker({ fetcher: async () => metadata(), edgeCache: {
    async match() { throw new Error('Cache unavailable'); }, async put() { throw new Error('Cache unavailable'); }
  } });
  assert.equal((await handle(request('latest?metric=intensity'))).status, 200);
});

test('Worker-compatible manual redirects are rejected instead of following an arbitrary host', async () => {
  let calls = 0;
  const handle = createStrongMotionWorker({ fetcher: async (url, options) => {
    calls++;
    assert.equal(new URL(url).hostname, 'www.kmoni.bosai.go.jp');
    assert.equal(options.redirect, 'manual');
    return new Response(null, { status: 302, headers: { Location: 'http://private.example/' } });
  } });
  const result = await handle(request('latest?metric=intensity'));
  assert.equal(result.status, 502);
  assert.equal(calls, 1);
  assert.equal((await result.text()).includes('private.example'), false);
});
