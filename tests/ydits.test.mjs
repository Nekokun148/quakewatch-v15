import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { YDITS_SERVERS, yditsSnapshot, createYditsEEWAdapter, createYditsFeed } from '../js/ydits.js';
import { eewInfo, createEEWTracker } from '../js/eew.js';
import { eewAnnouncement } from '../js/speech.js';

const initial = Date.parse('2026-10-10T01:15:00+09:00');
const iso = time => new Date(time).toISOString();
const idle = time => ({ status: 'OK', time: iso(time), isEew: false });
function warning(time = initial) {
  return { ...idle(time), isEew: true, report: {
    type: 'normal', time: iso(time), isLast: false, isFinal: false, isCanceled: false, isWarning: true,
    earthquake: { originTime: iso(initial - 15000), arrivalTime: iso(time), condition: false,
      hypocenterName: 'TEST ONLY', intensity: '6-', magnitude: 7.4, depth: 80 }
  } };
}
const response = body => ({ ok: true, status: 200, json: async () => body });

function harness(t, fetcher = (_url, _options, now) => response(idle(now))) {
  let clock = initial, id = 0;
  const calls = [], data = [], statuses = [], timers = new Map();
  const document = { hidden: false };
  const environment = { document, Date: { now: () => clock },
    setTimeout(fn, delay) { timers.set(++id, { fn, delay }); return id; },
    clearTimeout(key) { timers.delete(key); } };
  const feed = createYditsFeed({ environment,
    fetcher(url, options) { calls.push({ url, options, time: clock }); return fetcher(url, options, clock); },
    onData: value => data.push(value), onStatus: value => statuses.push(value) });
  t.after(() => feed.stop());
  return { feed, calls, data, statuses, document, timers, advance: ms => { clock += ms; },
    fire(delay) { const entry = [...timers].find(([, timer]) => timer.delay === delay); assert.ok(entry); timers.delete(entry[0]); entry[1].fn(); } };
}

test('official server order is fixed and valid data retains values without invented coordinates or serials', () => {
  assert.deepEqual(YDITS_SERVERS, ['https://api.ydits.net/vxse43', 'https://api2.ydits.net/vxse43', 'https://api3.ydits.net/vxse43']);
  const snapshot = yditsSnapshot(warning(), initial);
  assert.equal(snapshot.maxScale, 55); assert.equal(snapshot.depth, 80); assert.equal(snapshot.magnitude, 7.4);
  const data = createYditsEEWAdapter()(snapshot);
  assert.equal(data.source, 'YDITS'); assert.deepEqual(data.areas, []);
  assert.equal(data.issue.serial, undefined); assert.equal(data.earthquake.hypocenter.latitude, undefined);
  assert.equal(data.earthquake.hypocenter.longitude, undefined); assert.equal(eewInfo(data).stage, '警報');
});

test('all documented intensities, including zero and unknown, retain distinct values', () => {
  for (const [text, value] of Object.entries({ '0': 0, '1': 10, '2': 20, '3': 30, '4': 40, '5-': 45, '5+': 50, '6-': 55, '6+': 60, '7': 70, unknown: -1 })) {
    const data = warning(); data.report.earthquake.intensity = text;
    const result = createYditsEEWAdapter()(yditsSnapshot(data, initial));
    assert.equal(eewInfo(result).maxScale, value);
  }
});

test('HTTP success is insufficient: invalid schema, provider errors and stale server clocks are rejected', () => {
  for (const mutate of [
    data => { data.status = 'Service Unavailable'; }, data => { delete data.time; },
    data => { data.time = '2026-10-10 01:15:00'; }, data => { data.time = iso(initial - 120001); },
    data => { data.time = iso(initial + 10001); }, data => { data.isEew = 'true'; },
    data => { data.report.type = 'other'; }, data => { data.report.isLast = 1; },
    data => { delete data.report.isFinal; }, data => { data.report.earthquake.intensity = '6弱'; },
    data => { data.report.earthquake.condition = 'false'; }, data => { data.report.earthquake.depth = '80'; },
    data => { data.report.earthquake.magnitude = NaN; }, data => { data.report.earthquake.originTime = null; }
  ]) { const data = warning(); mutate(data); assert.throws(() => yditsSnapshot(data, initial)); }
});

test('assumed hypocenter is not inferred to be PLUM and uncertain magnitude/depth remain unknown', () => {
  const data = warning(); data.report.earthquake.condition = true;
  const result = createYditsEEWAdapter()(yditsSnapshot(data, initial));
  assert.equal(result.earthquake.assumed, true); assert.equal(result.earthquake.hypocenter.depth, null);
  assert.equal(result.earthquake.hypocenter.magnitude, null); assert.equal(eewInfo(result).plum, false);
});

test('cancellation needs no hypocenter, correlates only to local received origin and marks unmatched cancellations', () => {
  const data = warning(); data.report.isCanceled = true; delete data.report.earthquake;
  const adapter = createYditsEEWAdapter();
  assert.equal(adapter(yditsSnapshot(data, initial)).unmatchedCancel, true);
  const received = adapter(yditsSnapshot(warning(), initial));
  const cancel = adapter(yditsSnapshot(data, initial));
  assert.equal(cancel.issue.eventId, received.issue.eventId); assert.equal(cancel.unmatchedCancel, false);
  assert.equal(cancel.earthquake, undefined);
  assert.equal(adapter(yditsSnapshot(idle(initial), initial)), null);
  assert.equal(adapter(yditsSnapshot(data, initial)).unmatchedCancel, true);
});

test('inactive snapshot ignores residual reports; training and old report times are explicitly classified', () => {
  const data = warning(); data.isEew = false;
  assert.deepEqual(yditsSnapshot(data, initial), { active: false, checkedAt: iso(initial) });
  for (const type of ['drill', 'test']) {
    const data = warning(); data.report.type = type;
    const snapshot = yditsSnapshot(data, initial);
    assert.equal(snapshot.training, true);
    assert.equal(createEEWTracker()(createYditsEEWAdapter()(snapshot), { now: initial }).sound, false);
  }
  const old = warning(); old.report.time = iso(initial - 120001);
  assert.equal(yditsSnapshot(old, initial).stale, true);
});

test('isLast update-end is not invented as a final report or a report number', () => {
  const data = warning(); data.report.isLast = true;
  const result = createYditsEEWAdapter()(yditsSnapshot(data, initial));
  assert.equal(eewInfo(result).final, false); assert.equal(eewInfo(result).stage, '警報・更新終了');
  data.report.isFinal = true;
  assert.equal(eewInfo(createYditsEEWAdapter()(yditsSnapshot(data, initial))).stage, '警報・最終報');
});

test('YDITS deduplication does not suppress same-time intensity escalation or a real report after training', () => {
  const adapter = createYditsEEWAdapter(), receive = createEEWTracker();
  const data = warning(); data.report.earthquake.intensity = '4';
  const first = adapter(yditsSnapshot(data, initial));
  assert.equal(receive({ ...first, test: true }, { now: initial }).sound, false);
  const real = receive(first, { now: initial });
  assert.equal(real.accepted, true); assert.equal(real.sound, false);
  assert.equal(receive(first, { now: initial }).accepted, false);
  data.report.earthquake.intensity = '6-';
  assert.equal(receive(adapter(yditsSnapshot(data, initial)), { now: initial }).sound, true);
  data.report.isLast = true;
  const last = receive(adapter(yditsSnapshot(data, initial)), { now: initial });
  assert.equal(last.accepted, true); assert.equal(last.sound, false);
});

test('healthy primary is the only server used and clock-only refreshes do not duplicate delivery', async t => {
  const h = harness(t);
  await h.feed.start();
  assert.equal(await h.feed.poll(), false); h.advance(999); assert.equal(await h.feed.poll(), false);
  h.advance(1); await h.feed.poll(); h.advance(1000); await h.feed.poll();
  assert.deepEqual(h.calls.map(call => call.url), Array(3).fill(YDITS_SERVERS[0]));
  assert.equal(h.data.length, 1); assert.equal(h.statuses.at(-1).phase, 'live');
  assert.ok(h.calls.every(call => call.options.cache === 'no-store' && call.options.credentials === 'omit' && call.options.referrerPolicy === 'no-referrer'));
});

test('only a primary failure enables backup 2; server 1 is restored on its recovery check', async t => {
  let primaryFailed = true;
  const h = harness(t, (url, _options, now) => {
    if (url === YDITS_SERVERS[0] && primaryFailed) throw new Error('offline');
    return response(idle(now));
  });
  await h.feed.start(); h.advance(1000); await h.feed.poll();
  h.advance(1000); await h.feed.poll();
  assert.deepEqual(h.calls.map(call => call.url), [YDITS_SERVERS[0], YDITS_SERVERS[1], YDITS_SERVERS[1]]);
  primaryFailed = false; h.advance(58000); await h.feed.poll(); h.advance(1000); await h.feed.poll();
  assert.deepEqual(h.calls.slice(-2).map(call => call.url), [YDITS_SERVERS[0], YDITS_SERVERS[0]]);
  assert.equal(h.statuses.at(-1).server, 1); assert.equal(h.data.length, 1);
});

test('failed recovery check preserves a healthy backup instead of unnecessarily using server 3', async t => {
  const h = harness(t, (url, _options, now) => {
    if (url === YDITS_SERVERS[0]) throw new Error('offline');
    return response(idle(now));
  });
  await h.feed.start(); h.advance(1000); await h.feed.poll();
  h.advance(59000); await h.feed.poll(); h.advance(1000); await h.feed.poll();
  assert.deepEqual(h.calls.map(call => call.url), [YDITS_SERVERS[0], YDITS_SERVERS[1], YDITS_SERVERS[0], YDITS_SERVERS[1]]);
});

test('fallback order is 1, 2, 3 and all-server failure backs off before retrying 1', async t => {
  const h = harness(t, () => { throw new Error('offline'); });
  await h.feed.start(); h.advance(1000); await h.feed.poll(); h.advance(1000); await h.feed.poll();
  h.advance(29999); assert.equal(await h.feed.poll(), false);
  h.advance(1); await h.feed.poll();
  assert.deepEqual(h.calls.map(call => call.url), [...YDITS_SERVERS, YDITS_SERVERS[0]]);
  assert.equal(h.data.length, 0); assert.equal(h.statuses.at(-1).phase, 'error');
});

test('valid backup 3 is used only after 1 and 2 fail', async t => {
  const h = harness(t, (url, _options, now) => {
    if (url !== YDITS_SERVERS[2]) throw new Error('offline');
    return response(idle(now));
  });
  await h.feed.start(); h.advance(1000); await h.feed.poll(); h.advance(1000); await h.feed.poll();
  assert.deepEqual(h.calls.map(call => call.url), YDITS_SERVERS); assert.equal(h.statuses.at(-1).server, 3);
});

test('malformed HTTP 200 and service error JSON trigger failure, not false live status', async t => {
  for (const body of [{ status: 'INTERNAL_ERROR' }, { status: 'OK', isEew: 'false' }]) {
    const h = harness(t, () => response(body));
    await h.feed.start(); h.advance(1000); await h.feed.poll();
    assert.equal(h.statuses.at(-1).phase, 'error'); assert.equal(h.data.length, 0);
    assert.deepEqual(h.calls.map(call => call.url), YDITS_SERVERS.slice(0, 2));
  }
});

test('HTTP 429 does not evade limits via a backup or manual reconnect', async t => {
  const h = harness(t, () => ({ ok: false, status: 429, headers: { get: () => '60' } }));
  await h.feed.start(); assert.equal(h.statuses.at(-1).phase, 'limited');
  h.feed.stop(); h.advance(1000); await h.feed.start(); assert.equal(h.calls.length, 1);
  h.advance(58999); assert.equal(await h.feed.poll(), false);
  h.advance(1); await h.feed.poll();
  assert.deepEqual(h.calls.map(call => call.url), [YDITS_SERVERS[0], YDITS_SERVERS[0]]);
});

test('non-numeric Retry-After retains a bounded minimum wait', async t => {
  const h = harness(t, () => ({ ok: false, status: 429, headers: { get: () => 'tomorrow' } }));
  await h.feed.start(); h.advance(29999); assert.equal(await h.feed.poll(), false);
  h.advance(1); await h.feed.poll(); assert.equal(h.calls.length, 2);
});

test('polls never overlap and start is idempotent while enabled', async t => {
  let release;
  const h = harness(t, () => new Promise(resolve => { release = resolve; }));
  const pending = h.feed.start(); h.advance(1000);
  assert.equal(h.feed.start(), false); assert.equal(await h.feed.poll(), false); assert.equal(h.calls.length, 1);
  release(response(idle(initial + 1000))); await pending;
  assert.equal(await h.feed.poll(), false);
});

test('stop aborts pending work and late responses cannot overwrite a restarted feed', async t => {
  let release, number = 0;
  const h = harness(t, (_url, _options, now) => ++number === 1 ? new Promise(resolve => { release = resolve; }) : response(idle(now)));
  const pending = h.feed.start(); h.feed.stop();
  assert.equal(h.calls[0].options.signal.aborted, true); await pending;
  h.advance(1000); await h.feed.start(); release(response(warning(initial)));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.data.length, 1); assert.equal(h.data[0].active, false); assert.equal(h.statuses.at(-1).phase, 'live');
});

test('five-second deadline releases even a fetcher that never settles', async t => {
  const h = harness(t, () => new Promise(() => {}));
  const pending = h.feed.start(); h.advance(5000); h.fire(5000);
  assert.equal(await pending, false); assert.equal(h.statuses.at(-1).phase, 'error');
  assert.equal(h.statuses.at(-1).reason, 'timeout');
  assert.equal(h.calls[0].options.signal.aborted, true);
});

test('hidden tab makes no requests and resumes using primary without catch-up bursts', async t => {
  const h = harness(t); h.document.hidden = true;
  await h.feed.start(); assert.equal(h.calls.length, 0);
  h.advance(10000); h.document.hidden = false; await h.feed.poll();
  assert.equal(h.calls.length, 1); assert.equal(await h.feed.poll(), false);
});

test('same report across failover/reconnect is delivered once and late/training data are labelled non-alerting', async t => {
  let fail = false;
  const h = harness(t, (_url, _options, now) => {
    if (fail) { fail = false; throw new Error('offline'); }
    const data = warning(); data.time = iso(now); return response(data);
  });
  await h.feed.start(); fail = true; h.advance(1000); await h.feed.poll();
  h.advance(1000); await h.feed.poll(); h.feed.stop(); h.advance(1000); await h.feed.start();
  assert.equal(h.data.length, 1);
  const old = harness(t, (_url, _options, now) => { const data = warning(); data.report.time = iso(now - 120001); return response(data); });
  await old.feed.start(); assert.match(old.statuses.at(-1).text, /過去.*自動通知なし/);
  const drill = harness(t, () => { const data = warning(); data.report.type = 'drill'; return response(data); });
  await drill.feed.start(); assert.match(drill.statuses.at(-1).text, /訓練.*自動通知なし/);
});

const app = await readFile(new URL('../js/app.js', import.meta.url), 'utf8');
const handler = app.slice(app.indexOf('function handleEEW('), app.indexOf('function handleUserSensing('));
function eewUi() {
  const calls = { waves: [], cancels: 0, clears: 0, alerts: [] }, elements = new Map();
  const element = id => { if (!elements.has(id)) elements.set(id, { appendChild() {} }); return elements.get(id); };
  const state = { bannerTime: 0, waveLayer: { clearLayers() { calls.clears++; } } };
  const receiveEEW = createEEWTracker();
  const context = vm.createContext({ state, $: element, document: { querySelector: element, createElement: () => ({}) },
    receiveEEW: (data, options) => receiveEEW(data, { ...options, now: initial }),
    setEventColor() {}, scaleText: value => value === 55 ? '6弱' : '不明',
    escapeHtml: value => String(value), displayObservationTime: value => value, addMarker() {},
    findLatLng: h => h.latitude == null || h.longitude == null ? null : { lat: h.latitude, lng: h.longitude },
    startWaveAnimation: (...args) => calls.waves.push(args), clearWaveTimers() { calls.clears++; },
    eewAnnouncement, rememberAnnouncement() {}, showToast() {},
    alarmAnnouncer: { cancel() { calls.cancels++; }, announce: (...args) => calls.alerts.push(args) } });
  vm.runInContext(handler, context);
  return { calls, elements, state, receive: (data, options) => context.handleEEW(data, options) };
}

test('production app starts YDITS only, preserving JMA and strong-motion sources without P2P fallback', async () => {
  assert.doesNotMatch(app, /new WebSocket|api\.p2pquake\.net|P2P_WS|P2P_HISTORY|loadHistory\(/);
  assert.match(app, /void yditsFeed\.start\(\)/);
  assert.match(app, /createObservationFeed\(/); assert.match(app, /createStrongMotionController\(/);
  assert.match(app, /silent: snapshot\.stale \|\| snapshot\.training/);
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(html, /id="yditsFeedStatus"/); assert.match(html, /P2Pの常時監視停止中/);
});

test('YDITS warning updates UI and alarm without inventing P/S waves or region forecasts', () => {
  const h = eewUi(), data = createYditsEEWAdapter()(yditsSnapshot(warning(), initial));
  h.receive(data);
  assert.equal(h.calls.alerts.length, 1); assert.equal(h.calls.alerts[0][1].sound, true);
  assert.equal(h.calls.waves.length, 0); assert.ok(h.calls.clears > 0);
  assert.match(h.elements.get('eewDetails').innerHTML, /YDITS.*6弱/);
  assert.match(h.elements.get('eewWaveStatus').textContent, /震源座標未受信/);
  assert.match(h.elements.get('headlineSub').textContent, /地域別予測未受信/);
  h.receive(data); assert.equal(h.calls.alerts.length, 1);
});

test('only explicit real coordinates allow P/S; assumed, PLUM and training reports do not create waves', () => {
  const base = createYditsEEWAdapter()(yditsSnapshot(warning(), initial));
  const coordinates = { ...base, earthquake: { ...base.earthquake, hypocenter: { ...base.earthquake.hypocenter, latitude: 41, longitude: 143 } } };
  const h = eewUi(); h.receive(coordinates); assert.equal(h.calls.waves.length, 1);
  for (const data of [{ ...coordinates, test: true },
    { ...coordinates, earthquake: { ...coordinates.earthquake, assumed: true } },
    { ...coordinates, areas: [{ kindCode: '19', scaleFrom: 55, scaleTo: 55 }] }]) {
    const h = eewUi(); h.receive(data); assert.equal(h.calls.waves.length, 0);
  }
});

test('unmatched, silent and training cancellation cannot stop or overwrite an unrelated live event', () => {
  const base = createYditsEEWAdapter()(yditsSnapshot(warning(), initial));
  for (const [data, options] of [[{ ...base, cancelled: true, unmatchedCancel: true }, {}],
    [{ ...base, cancelled: true, test: true }, {}], [{ ...base, cancelled: true }, { silent: true }]]) {
    const h = eewUi(); h.receive(data, options);
    assert.equal(h.calls.cancels, 0); assert.equal(h.calls.clears, 0); assert.equal(h.calls.alerts.length, 0);
    if (data.unmatchedCancel || data.test) assert.equal(h.state.bannerTime, 0);
  }
  const h = eewUi(); h.receive({ ...base, cancelled: true });
  assert.equal(h.calls.cancels, 1); assert.ok(h.calls.clears > 0);
});

test('HTTP 200 INTERNAL_ERROR is explained without exposing provider internals or marking live', async t => {
  const h = harness(t, () => response({ status: 'INTERNAL_ERROR', message: 'private diagnostic', _forward: 'private address' }));
  await h.feed.start();
  assert.equal(h.statuses.at(-1).phase, 'error'); assert.equal(h.statuses.at(-1).reason, 'provider');
  assert.match(h.statuses.at(-1).text, /INTERNAL_ERROR/);
  assert.doesNotMatch(h.statuses.at(-1).text, /private|diagnostic|address/);
  assert.equal(h.data.length, 0);
});

test('non-JSON and schema mismatch are distinguishable from a network failure', async t => {
  for (const [fetcher, reason] of [
    [() => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('bad JSON'); } }), 'json'],
    [() => response({ status: 'OK', isEew: false }), 'schema'],
    [() => { throw new TypeError('fetch failed'); }, 'network']
  ]) {
    const h = harness(t, fetcher); await h.feed.start();
    assert.equal(h.statuses.at(-1).reason, reason); assert.equal(h.data.length, 0);
  }
});

test('rate-limit provider JSON also backs off without trying another server', async t => {
  const h = harness(t, () => response({ status: 'Too many requests' }));
  await h.feed.start(); assert.equal(h.statuses.at(-1).phase, 'limited');
  h.advance(1000); assert.equal(await h.feed.poll(), false); assert.equal(h.calls.length, 1);
});
