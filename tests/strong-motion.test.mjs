import test from 'node:test';
import assert from 'node:assert/strict';
import { createStrongMotionController, MONITOR_INTERVAL } from '../js/strong-motion.js';
import { createStrongMotionProxy, sourceTime, frameSource } from '../scripts/strong-motion-proxy.mjs';

const now = Date.parse('2026-10-07T21:20:00+09:00');
const snapshot = { timestamp: '20261007212000', observedAt: '2026-10-07T21:20:00+09:00', image: 'frame?metric=intensity&time=20261007212000' };
const flush = () => new Promise(resolve => setImmediate(resolve));
function harness(fetcher) {
  const intervals = [], frames = [], states = [], calls = [], timers = new Map();
  let timerId = 0;
  const environment = {
    location: { href: 'http://localhost/quakewatch-v15/' }, document: { hidden: false }, Date: { now: () => now },
    Image: class { naturalWidth = 352; naturalHeight = 400; set src(value) { if (value) queueMicrotask(() => this.onload?.()); } },
    setInterval(fn, ms) { intervals.push({ fn, ms }); return intervals.length; }, clearInterval() {},
    setTimeout(fn) { timers.set(++timerId, fn); return timerId; }, clearTimeout(id) { timers.delete(id); }
  };
  const controller = createStrongMotionController({ apiBase: 'api/strong-motion/', environment,
    fetcher: async (...args) => { calls.push(args); return fetcher ? fetcher(...args) : { ok: true, json: async () => snapshot }; },
    onFrame: data => frames.push(data), onStatus: (phase, text) => states.push({ phase, text })
  });
  return { controller, intervals, frames, states, calls, environment };
}

test('decoded image reaches the map callback and failed rendering retries the same timestamp', async () => {
  const h = harness();
  h.controller.start('intensity'); await flush();
  assert.equal(h.frames[0].image.naturalWidth, 352);
  assert.equal(h.frames[0].image.crossOrigin, 'anonymous');
  h.controller.stop();
  let attempts = 0;
  const controller = createStrongMotionController({ apiBase: 'api/strong-motion/', environment: h.environment,
    fetcher: async () => ({ ok: true, json: async () => snapshot }),
    onFrame: () => { if (++attempts === 1) throw new Error('Rendering failed'); }
  });
  controller.start('intensity'); await flush();
  await controller.tick();
  assert.equal(attempts, 2);
  controller.stop();
});

test('strong monitor ticks every 1000ms, uses source time, and keeps paths project-relative', async () => {
  const h = harness(); h.controller.start('intensity'); await flush();
  assert.equal(MONITOR_INTERVAL, 1000);
  assert.equal(h.intervals[0].ms, 1000);
  assert.equal(h.calls[0][1].cache, 'no-store');
  assert.equal(h.frames[0].observedAt, snapshot.observedAt);
  assert.match(h.frames[0].url, /\/quakewatch-v15\/api\/strong-motion\/frame\?/);
  assert.equal(h.states.at(-1).phase, 'live');
  await h.controller.tick();
  assert.equal(h.frames.length, 1);
});

test('switching acceleration requests that metric and stopping the controller ends updates', async () => {
  const h = harness(); h.controller.start('acceleration'); await flush();
  assert.match(h.calls[0][0], /metric=acceleration/);
  assert.equal(h.frames[0].metric, 'acceleration');
  h.controller.stop(); await h.controller.tick();
  assert.equal(h.calls.length, 1);
});

test('new observations update the frame callback without navigation or rebuilding the controller', async () => {
  let current = snapshot;
  const h = harness(async () => ({ ok: true, json: async () => current }));
  for (const method of ['reload', 'assign', 'replace']) {
    h.environment.location[method] = () => assert.fail('Live polling must not navigate the page');
  }
  h.controller.start('intensity'); await flush();
  current = { timestamp: '20261007212001', observedAt: '2026-10-07T21:20:01+09:00', image: 'frame?metric=intensity&time=20261007212001' };
  await h.controller.tick();
  assert.equal(h.frames.length, 2);
  assert.equal(h.frames[1].timestamp, current.timestamp);
  assert.equal(h.intervals.length, 1);
  assert.equal(h.environment.location.href, 'http://localhost/quakewatch-v15/');
  await h.controller.tick();
  assert.equal(h.frames.length, 2);
});

test('background documents and overlapping polls do not flood the source', async () => {
  let release;
  const h = harness(() => new Promise(resolve => { release = resolve; }));
  h.controller.start('intensity');
  await h.controller.tick(); assert.equal(h.calls.length, 1);
  release({ ok: true, json: async () => snapshot }); await flush();
  h.environment.document.hidden = true; await h.controller.tick();
  assert.equal(h.calls.length, 1);
});

test('returning to a visible tab resumes the monitor immediately without duplicating its timer', async () => {
  const h = harness();
  const handlers = {};
  h.environment.document.addEventListener = (type, fn) => { handlers[type] = fn; };
  const controller = createStrongMotionController({ apiBase: 'api/strong-motion/', environment: h.environment,
    fetcher: async (...args) => { h.calls.push(args); return { ok: true, json: async () => snapshot }; } });
  h.environment.document.hidden = true;
  controller.start('intensity'); await flush();
  assert.equal(h.calls.length, 0);
  h.environment.document.hidden = false;
  handlers.visibilitychange(); await flush();
  assert.equal(h.calls.length, 1);
  assert.equal(h.intervals.length, 1);
  controller.stop(); handlers.visibilitychange(); await flush();
  assert.equal(h.calls.length, 1);
});

test('visible-tab resume and manual ticks never bypass relay rate limits', async () => {
  const h = harness(), handlers = {};
  h.environment.document.addEventListener = (type, fn) => { handlers[type] = fn; };
  let requests = 0;
  const controller = createStrongMotionController({ apiBase: 'api/strong-motion/', environment: h.environment,
    fetcher: async () => { requests++; return { ok: false, status: 429, headers: new Headers({ 'Retry-After': '90' }) }; } });
  controller.start('intensity'); await flush();
  handlers.visibilitychange(); await controller.tick(); await flush();
  assert.equal(requests, 1);
  controller.stop();
});

test('missing static-host API pauses immediate retries and makes its limitation explicit', async () => {
  const h = harness(async () => ({ ok: false, status: 404 }));
  h.controller.start('intensity'); await flush(); await h.controller.tick();
  assert.equal(h.states.at(-1).phase, 'unavailable'); assert.equal(h.calls.length, 1);
});

test('missing monitor relay automatically recovers after 30 seconds without a reload or user action', async () => {
  let clock = now, available = false;
  const h = harness(async () => available ? { ok: true, json: async () => snapshot } : { ok: false, status: 404 });
  h.environment.Date.now = () => clock;
  h.controller.start('intensity'); await flush();
  for (let i = 0; i < 29; i++) { clock += 1000; await h.controller.tick(); }
  assert.equal(h.calls.length, 1); assert.equal(h.frames.length, 0);
  available = true; clock += 1000; await h.controller.tick();
  assert.equal(h.calls.length, 2); assert.equal(h.frames.length, 1);
  assert.equal(h.intervals.length, 1); h.controller.stop();
});

test('monitor rate-limit cooldown is respected before automatic retry', async () => {
  let clock = now;
  const h = harness(async () => ({ ok: false, status: 429, headers: new Headers({ 'Retry-After': '90' }) }));
  h.environment.Date.now = () => clock;
  h.controller.start('intensity'); await flush();
  clock += 89999; await h.controller.tick(); assert.equal(h.calls.length, 1);
  clock++; await h.controller.tick(); assert.equal(h.calls.length, 2); h.controller.stop();
});

test('an old 404 cannot stop or delay a replacement monitor metric', async () => {
  let release;
  const h = harness(url => url.includes('intensity') ? new Promise(resolve => { release = resolve; }) : { ok: true, json: async () => snapshot });
  h.controller.start('intensity'); h.controller.start('acceleration'); await flush();
  release({ ok: false, status: 404 }); await flush();
  assert.equal(h.states.at(-1).phase, 'live'); assert.equal(h.frames.at(-1).metric, 'acceleration');
  await h.controller.tick(); assert.equal(h.calls.length, 3); h.controller.stop();
});

test('production app connects the monitor on page startup without an audio or location action', async () => {
  const { readFile } = await import('node:fs/promises');
  const app = await readFile(new URL('../js/app.js', import.meta.url), 'utf8');
  assert.match(app, /selectMonitorMetric\('intensity'\);/);
  assert.ok(app.indexOf("selectMonitorMetric('intensity');") < app.indexOf('if (autoLocation)'));
  assert.match(app, /\$\('reconnect'\)\.addEventListener\('click', [^\n]*strongMotion\.tick\(\)/);
});

test('stale frames show delayed status instead of being labelled live', async () => {
  const h = harness(async () => ({ ok: true, json: async () => ({ ...snapshot, observedAt: '2026-10-07T21:19:00+09:00' }) }));
  h.controller.start('intensity'); await flush();
  assert.equal(h.states.at(-1).phase, 'delayed');
});

test('invalid image origin is rejected and fetch failures never publish a new frame', async () => {
  const h = harness(async () => ({ ok: true, json: async () => ({ ...snapshot, image: 'https://invalid.example/frame' }) }));
  h.controller.start('intensity'); await flush();
  assert.equal(h.frames.length, 0); assert.equal(h.states.at(-1).phase, 'error');
});

test('stopping ignores a late image or HTTP response', async () => {
  let release;
  const h = harness(() => new Promise(resolve => { release = resolve; }));
  h.controller.start('intensity'); h.controller.stop();
  release({ ok: true, json: async () => snapshot }); await flush();
  assert.equal(h.frames.length, 0);
});

test('known metric URLs use the official unmodified GIF and reject arbitrary source paths', () => {
  assert.deepEqual(sourceTime('2026/10/07 21:20:00'), { timestamp: snapshot.timestamp, observedAt: snapshot.observedAt });
  assert.match(frameSource('intensity', snapshot.timestamp), /jma_s\/20261007\/20261007212000.jma_s.gif$/);
  assert.match(frameSource('acceleration', snapshot.timestamp), /acmap_s\/20261007\/20261007212000.acmap_s.gif$/);
  assert.throws(() => frameSource('constructor', snapshot.timestamp));
  assert.throws(() => frameSource('intensity', '../secret'));
  assert.throws(() => sourceTime('invalid'));
});

function proxyHarness(fetcher) {
  const proxy = createStrongMotionProxy({ fetcher, now: () => now });
  return async (path, method = 'GET') => {
    const response = { status: 0, headers: {}, setHeader(k, v) { this.headers[k] = v; }, writeHead(status, headers = {}) { this.status = status; Object.assign(this.headers, headers); return this; }, end(body) { this.body = body; } };
    const handled = await proxy({ method }, response, new URL('http://localhost/quakewatch-v15/api/strong-motion/' + path), '/quakewatch-v15/');
    return { ...response, handled };
  };
}

test('proxy returns only public frame metadata and throttles simultaneous timestamp requests', async () => {
  let calls = 0;
  const get = proxyHarness(async () => { calls++; return { ok: true, json: async () => ({ latest_time: '2026/10/07 21:20:00', result: { status: 'success' }, security: { ignored: true } }) }; });
  const result = await get('latest?metric=intensity');
  assert.equal(result.status, 200); assert.equal(result.headers['Cache-Control'], 'no-store');
  assert.equal(JSON.parse(result.body).timestamp, snapshot.timestamp);
  assert.ok(!result.body.includes('security'));
  await get('latest?metric=acceleration'); assert.equal(calls, 1);
});

test('proxy rejects unknown assets, non-GET methods, and upstream HTML/errors', async () => {
  const get = proxyHarness(async () => ({ ok: false }));
  assert.equal((await get('asset?kind=constructor')).status, 400);
  assert.equal((await get('latest?metric=constructor')).status, 400);
  assert.equal((await get('latest?metric=intensity', 'POST')).status, 405);
  assert.equal((await get('latest?metric=intensity')).status, 502);
});

test('proxy forwards image bytes without modifying them or querying user-provided hosts', async () => {
  const bytes = new Uint8Array([71, 73, 70, 56, 57, 97, 96, 1, 144, 1]);
  const calls = [];
  const get = proxyHarness(async url => { calls.push(url); return { ok: true, headers: new Headers({ 'content-type': 'image/gif' }), arrayBuffer: async () => bytes.buffer }; });
  const response = await get('frame?metric=intensity&time=20261007212000');
  assert.deepEqual(response.body, bytes); assert.equal(response.headers['Content-Type'], 'image/gif');
  assert.equal(new URL(calls[0]).hostname, 'www.kmoni.bosai.go.jp');
});
