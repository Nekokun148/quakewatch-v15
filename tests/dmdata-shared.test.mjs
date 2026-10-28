import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import vm from 'node:vm';
import worker, { SHARED_PATH, sharedRequestAllowed, createSharedUpstream, DmdataSharedHub } from '../workers/dmdata-shared.mjs';
import { SHARED_CLASSES, SHARED_TYPES, sharedTelegram } from '../workers/dmdata-shared-data.mjs';
import { createSharedDmdataFeed, sharedMessage, sharedStreamUrl } from '../js/dmdata-shared.js';
import { createEEWTracker } from '../js/eew.js';
import { measuredPoints } from '../js/observations.js';

// Entirely synthetic protocol messages; no live observation or credential is used.
const now = Date.parse('2026-10-14T20:00:00+09:00');
const issued = new Date(now).toISOString();
const flush = async () => { for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve)); };
const quake = () => ({ originTime: new Date(now - 20000).toISOString(), magnitude: { value: '7.4' }, hypocenter: {
  name: 'TEST ONLY', coordinate: { latitude: { value: '41.0' }, longitude: { value: '143.0' } }, depth: { value: '80', unit: 'km' }
} });
const warning = () => ({ _schema: { type: 'eew-information', version: '1.0.0' }, eventId: 'TEST-ONLY', serialNo: '1',
  reportDateTime: issued, status: '通常', infoType: '発表', body: { isWarning: true, isCanceled: false, isLastInfo: false,
    earthquake: quake(), intensity: { forecastMaxInt: { from: '5-', to: '5-' }, regions: [] } } });
const earthquake = () => ({ _schema: { type: 'earthquake-information', version: '1.1.0' }, eventId: 'TEST-ONLY',
  reportDateTime: issued, status: '通常', infoType: '発表', body: { earthquake: quake(), intensity: { maxInt: '5-',
    prefectures: [{ name: 'TEST PREFECTURE', maxInt: '5-' }] } } });
const envelope = (data = warning(), type = 'VXSE43') => ({ type: 'data', format: 'json', compression: null, encoding: 'utf-8',
  classification: type === 'VXSE43' ? 'eew.warning' : 'telegram.earthquake', head: { type, test: false },
  xmlReport: { control: { status: '通常' } }, body: JSON.stringify(data) });

test('shared gate rejects every forecast/realtime type and mismatched classification before decoding', async () => {
  for (const type of ['VXSE42', 'VXSE44', 'VXSE45', 'VXSE47', 'VXSE51', 'VZSE40']) assert.equal(await sharedTelegram(envelope(warning(), type), now), null);
  for (const classification of ['eew.forecast', 'eew.realtime', '', null, 'telegram.earthquake']) {
    assert.equal(await sharedTelegram({ ...envelope(), classification, body: 'not JSON' }, now), null);
  }
  assert.equal(await sharedTelegram({ ...envelope(earthquake(), 'VXSE53'), classification: 'eew.warning' }, now), null);
});

test('shared warnings omit magnitude and depth and do not forward raw envelopes, tickets or extra fields', async () => {
  const data = warning(); data.privateExtra = 'TEST-ONLY-NOT-A-SECRET'; data.body.earthquake.hypocenter.privateExtra = 'unused';
  const result = await sharedTelegram({ ...envelope(data), ticket: 'TEST-ONLY' }, now);
  assert.equal(result.kind, 'warning'); assert.equal(result.report.earthquake.magnitude, null);
  assert.equal(result.report.earthquake.hypocenter.depth, null);
  assert.equal(result.report.earthquake.hypocenter.latitude, 41);
  assert.doesNotMatch(JSON.stringify(result), /privateExtra|ticket|encoding|compression|TEST-ONLY-NOT/);
  data.body.isWarning = false; assert.equal(await sharedTelegram(envelope(data), now), null);
});

test('shared decode supports bounded gzip but excludes body/control/header training, stale and future information', async () => {
  const msg = envelope();
  const zipped = { ...msg, encoding: 'base64', compression: 'gzip', body: gzipSync(msg.body).toString('base64') };
  assert.equal((await sharedTelegram(zipped, now)).kind, 'warning');
  for (const status of ['訓練', '試験', 'unexpected']) {
    const data = warning(); data.status = status;
    assert.equal(await sharedTelegram(envelope(data), now), null);
    assert.equal(await sharedTelegram({ ...msg, xmlReport: { control: { status } } }, now), null);
  }
  assert.equal(await sharedTelegram({ ...msg, head: { ...msg.head, test: true } }, now), null);
  assert.equal(await sharedTelegram(msg, now + 120001), null);
  assert.equal(await sharedTelegram(msg, now - 10001), null);
  await assert.rejects(sharedTelegram({ ...zipped, body: gzipSync(Buffer.alloc(2100000, 65)).toString('base64') }, now));
});

test('shared ordinary earthquakes preserve reported values and label regional data without inventing station coordinates', async () => {
  for (const type of ['VXSE52', 'VXSE53']) {
    const result = await sharedTelegram(envelope(earthquake(), type), now);
    assert.equal(result.report.code, 551); assert.equal(result.report.earthquake.hypocenter.depth, 80);
    assert.equal(result.report.earthquake.hypocenter.magnitude, 7.4);
    assert.equal(result.report.points[0].isArea, true); assert.equal(result.report.points[0].latitude, undefined);
    assert.equal(measuredPoints(result.report.points).length, 0);
  }
  const data = earthquake(); data.body.earthquake.hypocenter.coordinate.geodeticSystem = '日本測地系';
  data.body.earthquake.magnitude.value = null; data.body.earthquake.hypocenter.depth.condition = '不明';
  const report = (await sharedTelegram(envelope(data, 'VXSE53'), now)).report;
  assert.equal(report.earthquake.hypocenter.latitude, undefined);
  assert.equal(report.earthquake.hypocenter.magnitude, null); assert.equal(report.earthquake.hypocenter.depth, null);
  assert.equal(await sharedTelegram(envelope(warning(), 'VXSE53'), now), null);
});

test('shared cancellations need no hypocenter and never become earthquake observations or alarms', async () => {
  const eew = warning(); eew.infoType = '取消'; eew.body = { isCanceled: true, isLastInfo: true };
  const result = await sharedTelegram(envelope(eew), now);
  assert.equal(result.report.cancelled, true);
  assert.equal(createEEWTracker()(result.report, { now }).sound, false);
  const eq = earthquake(); eq.infoType = '取消'; eq.body = {};
  assert.equal((await sharedTelegram(envelope(eq, 'VXSE53'), now)).report.cancelled, true);
});

function sockets() {
  const list = [], timers = new Map(); let id = 0;
  const environment = { Date: { now: () => now },
    WebSocket: class {
      constructor(url, protocols) { this.url = url; this.protocols = protocols; this.sent = []; list.push(this); }
      close() { this.closed = true; this.onclose?.(); }
      send(value) { this.sent.push(JSON.parse(value)); }
    },
    setTimeout(fn, ms) { timers.set(++id, { fn, ms }); return id; }, clearTimeout(id) { timers.delete(id); }
  };
  return { list, timers, environment, message(value) { list.at(-1).onmessage({ data: JSON.stringify(value) }); } };
}
function upstream(fetcher) {
  const h = sockets(), calls = [], reports = [], states = [];
  const controller = createSharedUpstream({ key: 'TEST-ONLY', environment: h.environment,
    fetcher: async (url, options) => { calls.push({ url, options }); return fetcher ? fetcher(url, options) : new Response(JSON.stringify({ status: 'ok',
      websocket: { url: 'wss://ws001.api.dmdata.jp/v2/websocket?ticket=TEST-ONLY', protocol: ['dmdata.v2'] } })); },
    onReport: value => reports.push(value), onStatus: value => states.push(value) });
  return { ...h, calls, reports, states, controller };
}
const start = () => ({ type: 'start', classifications: [...SHARED_CLASSES], types: [...SHARED_TYPES], test: 'no', time: issued });

test('shared upstream uses one fixed warning/ordinary subscription, secret header only, and confirmed start', async () => {
  const h = upstream(); h.controller.start(); h.controller.start(); await flush();
  assert.equal(h.calls.length, 1); assert.equal(h.calls[0].url, 'https://api.dmdata.jp/v2/socket');
  const options = h.calls[0].options, body = JSON.parse(options.body);
  assert.deepEqual(body.classifications, SHARED_CLASSES); assert.deepEqual(body.types, SHARED_TYPES);
  assert.equal(body.test, 'no'); assert.equal(options.redirect, 'error'); assert.equal(options.credentials, 'omit');
  assert.ok(options.headers.Authorization.startsWith('Basic ')); assert.doesNotMatch(options.body, /TEST-ONLY|eew.forecast/);
  h.message(envelope()); await flush(); assert.equal(h.reports.length, 0);
  h.message(start()); h.message({ type: 'ping', pingId: 'TEST-PING' }); h.message(envelope()); await flush();
  assert.equal(h.states.at(-1), 'live'); assert.equal(h.reports.length, 1);
  assert.deepEqual(h.list[0].sent, [{ type: 'pong', pingId: 'TEST-PING' }]); h.controller.stop();
});

test('unexpected forecast start or extra types is fatal rather than silently widening shared reception', async () => {
  for (const changed of [{ classifications: ['eew.forecast', ...SHARED_CLASSES] }, { types: [...SHARED_TYPES, 'VXSE45'] }, { test: 'including' }]) {
    const h = upstream(); h.controller.start(); await flush(); h.message({ ...start(), ...changed });
    assert.equal(h.states.at(-1), 'error'); assert.equal(h.list[0].closed, true); assert.equal(h.timers.size, 0);
    h.controller.start(); await flush(); assert.equal(h.calls.length, 1); h.controller.stop();
  }
});

test('shared fatal contract/auth/quota errors stop; rate limit waits a minute and provider text stays private', async () => {
  for (const code of [400, 401, 402, 403, 409, 429]) {
    const h = upstream(async () => new Response('PRIVATE ERROR TEST ONLY', { status: code }));
    h.controller.start(); await flush(); assert.equal(h.states.at(-1), 'error');
    assert.doesNotMatch(h.states.join(' '), /PRIVATE/);
    assert.equal(h.list.length, 0);
    assert.equal(h.timers.size, code === 429 ? 1 : 0);
    if (code === 429) assert.equal([...h.timers.values()][0].ms, 60000);
    h.controller.stop();
  }
});

test('shared reconnect obtains a fresh ticket and stop invalidates late callbacks without parallel sessions', async () => {
  const h = upstream(); h.controller.start(); await flush();
  const old = h.list[0]; old.onclose();
  const timer = [...h.timers.values()][0]; assert.equal(timer.ms, 5000); timer.fn(); await flush();
  assert.equal(h.calls.length, 2); assert.equal(h.list.length, 2);
  old.onmessage({ data: JSON.stringify(start()) }); assert.notEqual(h.states.at(-1), 'live');
  h.controller.stop(); h.message(start()); assert.equal(h.states.at(-1), 'off'); assert.equal(h.timers.size, 0);
  let release;
  const late = upstream(() => new Promise(resolve => { release = resolve; })); late.controller.start(); late.controller.stop();
  release(new Response(JSON.stringify({ status: 'ok', websocket: { url: 'wss://ws001.api.dmdata.jp/v2/websocket?ticket=TEST-ONLY', protocol: ['dmdata.v2'] } })));
  await flush(); assert.equal(late.list.length, 0);
});

test('shared ticket cannot redirect to an arbitrary host or leak in public statuses', async () => {
  const h = upstream(async () => new Response(JSON.stringify({ status: 'ok', websocket: {
    url: 'wss://attacker.test/v2/websocket?ticket=TEST-ONLY', protocol: ['dmdata.v2'] } })));
  h.controller.start(); await flush(); assert.equal(h.list.length, 0); assert.equal(h.states.at(-1), 'error');
  assert.doesNotMatch(h.states.join(' '), /ticket|attacker/); h.controller.stop();
});

test('oversized ticket responses fail before a socket is created', async () => {
  const h = upstream(async () => new Response('x'.repeat(16385)));
  h.controller.start(); await flush(); assert.equal(h.list.length, 0); assert.equal(h.states.at(-1), 'error'); h.controller.stop();
});

const request = (url = `https://relay.example${SHARED_PATH}`, changes = {}) => new Request(url, {
  headers: { Origin: 'https://nekokun148.github.io', Upgrade: 'websocket', ...changes }
});
test('shared relay accepts only receive-only published-origin upgrades, with no URL parameters or client credentials', async () => {
  assert.equal(sharedRequestAllowed(request()), true);
  for (const req of [request(`https://relay.example${SHARED_PATH}?classification=eew.forecast`), request('https://relay.example/other'),
    request(undefined, { Origin: 'https://attacker.test' }), request(undefined, { Authorization: 'TEST-ONLY' }),
    new Request(`https://relay.example${SHARED_PATH}`), new Request(`https://relay.example${SHARED_PATH}`, { method: 'POST' })]) {
    assert.equal(sharedRequestAllowed(req), false); assert.equal((await worker.fetch(req, {})).status, 403);
  }
  const response = await worker.fetch(request(), { SHARED_ENABLED: 'false' });
  assert.equal(response.status, 503); assert.equal((await response.json()).phase, 'unconfigured');
});

test('every viewer resolves to one durable object, and private bindings never enter the response', async () => {
  const ids = [], env = { SHARED_ENABLED: 'true', DMDATA_API_KEY: 'TEST-ONLY', DMDATA_SHARED: {
    idFromName(name) { ids.push(name); return name; }, get() { return { fetch: () => new Response('TEST OK') }; }
  } };
  await worker.fetch(request(), env); await worker.fetch(request(), env);
  assert.deepEqual(ids, ['warning-and-earthquake-only', 'warning-and-earthquake-only']);
});

test('fanout shares sanitized data and last-viewer disconnect stops upstream and clears snapshots', async () => {
  const hub = new DmdataSharedHub({}, {}), sent = [], closed = [];
  const a = { send: data => sent.push(data), close: () => closed.push('a') };
  const b = { send: data => sent.push(data), close: () => closed.push('b') };
  hub.clients.add(a); hub.clients.add(b);
  hub.publish(await sharedTelegram(envelope(), now)); assert.equal(sent.length, 2); assert.equal(hub.recent.size, 1);
  hub.remove(a); assert.equal(hub.clients.size, 1); assert.equal(hub.recent.size, 1);
  hub.remove(b); assert.equal(hub.clients.size, 0); assert.equal(hub.recent.size, 0); assert.equal(hub.phase, 'off');
});

test('durable hub upgrades a receive-only viewer, replays silently, bounds viewers and rejects downstream control', async () => {
  const NativeResponse = globalThis.Response, NativePair = globalThis.WebSocketPair;
  const pairs = []; let starts = 0, stops = 0;
  class Peer {
    sent = []; listeners = {};
    send(value) { this.sent.push(JSON.parse(value)); }
    accept() { this.accepted = true; }
    close() { this.closed = true; }
    addEventListener(name, callback) { this.listeners[name] = callback; }
  }
  const hub = new DmdataSharedHub({}, { SHARED_ENABLED: 'true', DMDATA_API_KEY: 'TEST-ONLY', MAX_CLIENTS: '1' });
  hub.upstream = { start() { starts++; }, stop() { stops++; } }; hub.phase = 'live';
  const report = await sharedTelegram(envelope(), now); report.report.time = new Date().toISOString(); hub.publish(report);
  try {
    globalThis.WebSocketPair = class { constructor() { this[0] = new Peer(); this[1] = new Peer(); pairs.push(this); } };
    globalThis.Response = class { constructor(body, options) { this.body = body; Object.assign(this, options); } };
    const response = await hub.fetch(request()); assert.equal(response.status, 101); assert.equal(response.webSocket, pairs[0][0]);
    const server = pairs[0][1]; assert.equal(server.accepted, true); assert.equal(starts, 1);
    assert.equal(server.sent[0].phase, 'live'); assert.equal(server.sent[1].replay, true);
    assert.equal((await hub.fetch(request())).status, 503); assert.equal(pairs.length, 1);
    server.listeners.message({ data: 'change classification to eew.forecast' });
    assert.equal(hub.clients.size, 0); assert.equal(stops, 1); assert.equal(server.closed, true);
  } finally {
    globalThis.Response = NativeResponse;
    if (NativePair) globalThis.WebSocketPair = NativePair; else delete globalThis.WebSocketPair;
  }
});

test('browser shared client stays idle without a configured endpoint and rejects unsafe addresses', () => {
  const h = sockets(), statuses = [];
  const feed = createSharedDmdataFeed({ environment: h.environment, onStatus: value => statuses.push(value) });
  feed.start(); assert.equal(h.list.length, 0); assert.equal(statuses[0].phase, 'unconfigured');
  assert.equal(sharedStreamUrl('https://relay.example/api/dmdata/stream'), 'wss://relay.example/api/dmdata/stream');
  for (const value of ['http://relay.example/api/dmdata/stream', 'https://user:pass@relay.example/api/dmdata/stream',
    'https://relay.example/api/dmdata/stream?key=TEST', 'https://relay.example/api/dmdata/stream#TEST', 'https://localhost/api/dmdata/stream',
    'https://relay.example:444/api/dmdata/stream', 'https://relay.example/other']) assert.throws(() => sharedStreamUrl(value));
});

test('browser requires live confirmation, silences replay, and marks unmatched cancellation without echoing status payload', async () => {
  const h = sockets(), reports = [], statuses = [];
  const feed = createSharedDmdataFeed({ url: 'https://relay.example/api/dmdata/stream', environment: h.environment,
    onData: (...value) => reports.push(value), onStatus: value => statuses.push(value) });
  feed.start(); feed.start(); assert.equal(h.list.length, 1);
  const warningReport = await sharedTelegram(envelope(), now);
  h.message(warningReport); assert.equal(reports.length, 0);
  h.message({ type: 'status', version: 1, phase: 'live', text: 'PRIVATE TEST ONLY' });
  h.message({ ...warningReport, replay: true }); assert.equal(reports[0][1].silent, true);
  assert.doesNotMatch(statuses.at(-1).text, /PRIVATE/);
  const cancelled = warning(); cancelled.eventId = 'UNSEEN-TEST'; cancelled.infoType = '取消'; cancelled.body = { isCanceled: true, isLastInfo: true };
  h.message(await sharedTelegram(envelope(cancelled), now)); assert.equal(reports[1][0].unmatchedCancel, true);
  h.message({ type: 'status', version: 1, phase: 'error' }); h.message(warningReport); assert.equal(reports.length, 2);
  feed.stop(); assert.equal(h.timers.size, 0);
});

test('browser drops forecasts, stale data, unknown versions and oversized messages on the shared path', async () => {
  const msg = await sharedTelegram(envelope(), now);
  assert.equal(sharedMessage(JSON.stringify(msg), now).kind, 'warning');
  const forecast = structuredClone(msg); forecast.report.isWarning = false;
  for (const input of [forecast, { ...msg, version: 2 }, { ...msg, kind: 'forecast' }]) assert.equal(sharedMessage(JSON.stringify(input), now), null);
  assert.equal(sharedMessage(JSON.stringify(msg), now + 120001), null);
  assert.equal(sharedMessage('x'.repeat(256001), now), null);
});

test('cancelling a previously seen older earthquake cannot cancel a newer active warning', async () => {
  const h = sockets(), reports = [];
  const feed = createSharedDmdataFeed({ url: 'https://relay.example/api/dmdata/stream', environment: h.environment, onData: report => reports.push(report) });
  feed.start(); h.message({ type: 'status', version: 1, phase: 'live' });
  h.message(await sharedTelegram(envelope(), now));
  const newer = warning(); newer.eventId = 'NEWER-TEST'; h.message(await sharedTelegram(envelope(newer), now));
  const cancel = warning(); cancel.infoType = '取消'; cancel.body = { isCanceled: true, isLastInfo: true };
  h.message(await sharedTelegram(envelope(cancel), now)); assert.equal(reports.at(-1).unmatchedCancel, true); feed.stop();
});

test('shared and personal reports use the existing threshold and cross-provider duplicate guard', async () => {
  const msg = await sharedTelegram(envelope(), now), receive = createEEWTracker();
  assert.equal(receive(msg.report, { now, silent: true }).sound, false);
  assert.equal(receive(msg.report, { now }).accepted, false);
  const fresh = createEEWTracker(); assert.equal(fresh(msg.report, { now }).sound, true);
  assert.equal(fresh({ ...msg.report, source: 'Wolfx' }, { now }).accepted, false);
});

test('app keeps private direct EEW priority, preserves exact observations, and handles only matching ordinary cancellation', async () => {
  const source = await readFile(new URL('../js/app.js', import.meta.url), 'utf8');
  const startAt = source.indexOf('function applySharedReport('), endAt = source.indexOf('sharedFeed.start();', startAt);
  const calls = [], elements = new Map(), state = { latestObservation: null };
  const history = [], context = vm.createContext({ sharedActive: true, dmdataActive: true, state, quakeHistory: history,
    onData: (report, options) => calls.push([report, options]), measuredPoints, quakeReportTime: d => Date.parse(d.time),
    renderQuakeHistory() {}, renderObservations() {}, clearWaveTimers() {}, addMarker() {}, observationFeed: { poll() {} },
    $: id => { if (!elements.has(id)) elements.set(id, {}); return elements.get(id); } });
  vm.runInContext(source.slice(startAt, endAt), context);
  context.applySharedReport((await sharedTelegram(envelope(), now)).report, {}); assert.equal(calls.length, 0);
  const eq = (await sharedTelegram(envelope(earthquake(), 'VXSE53'), now)).report;
  const station = { code: 'TEST', latitude: 41, longitude: 143, scale: 45 };
  state.latestObservation = { earthquake: eq.earthquake, points: [station], observationSource: 'TEST EXACT STATION' };
  context.applySharedReport(eq, {}); assert.equal(calls[0][0].points[0], station);
  state.latestQuake = eq; state.bannerTime = Date.parse(eq.time); history.push(eq);
  context.applySharedReport({ code: 551, source: 'DMDATA', cancelled: true, issue: { eventId: 'OTHER-TEST' } }, {});
  assert.equal(state.latestQuake, eq); assert.equal(history.length, 1);
  context.applySharedReport({ code: 551, source: 'DMDATA', cancelled: true, issue: eq.issue }, {});
  assert.equal(state.latestQuake, null); assert.equal(history.length, 0);
});

test('deployment defaults are disabled, contain no secrets, and isolate the existing monitor worker', async () => {
  const config = JSON.parse(await readFile(new URL('../workers/wrangler.dmdata.jsonc', import.meta.url), 'utf8'));
  assert.equal(config.name, 'quakewatch-v15-dmdata'); assert.equal(config.vars.SHARED_ENABLED, 'false');
  assert.equal(config.vars.DMDATA_API_KEY, undefined); assert.equal(config.observability.enabled, false);
  assert.deepEqual(config.migrations[0].new_sqlite_classes, ['DmdataSharedHub']);
  const workflow = await readFile(new URL('../.github/workflows/pages.yml', import.meta.url), 'utf8');
  assert.match(workflow, /DMDATA_SHARED_URL: \$\{\{ vars.DMDATA_SHARED_URL \}\}/);
  assert.match(workflow, /node scripts\/build\.mjs --no-shared-dmdata/);
  assert.doesNotMatch(workflow, /DMDATA_API_KEY|wrangler deploy|secrets\./);
  const sw = await readFile(new URL('../sw.js', import.meta.url), 'utf8');
  assert.match(sw, /js\/dmdata-shared.js/); assert.doesNotMatch(sw, /workers\/|DMDATA_API_KEY/);
});
