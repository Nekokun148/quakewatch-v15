import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { dmdataReport, decodeDmdata, dmdataSocketUrl, createDmdataFeed, dmdataAllowed } from '../js/dmdata.js';
import { eewInfo, createEEWTracker } from '../js/eew.js';
import { PUBLIC_FILES } from '../scripts/build.mjs';
import vm from 'node:vm';

// Synthetic protocol fixtures, not live earthquake data or credentials.
const fixture = () => ({ _schema: { type: 'eew-information', version: '1.0.0' }, eventId: 'TEST-ONLY', serialNo: '1', status: '通常', infoType: '発表', reportDateTime: new Date().toISOString(), body: {
  isLastInfo: false, isCanceled: false, isWarning: true,
  earthquake: { originTime: new Date(Date.now() - 20000).toISOString(), magnitude: { value: '7.4' }, hypocenter: { name: 'TEST ONLY', depth: { value: '80', unit: 'km' }, coordinate: { latitude: { value: '41.0' }, longitude: { value: '143.0' } } } },
  intensity: { forecastMaxInt: { from: '6-', to: '6-' }, regions: [{ name: 'TEST REGION', isPlum: false, forecastMaxInt: { from: '5-', to: '6-' } }] }
} });
const envelope = data => ({ type: 'data', format: 'json', encoding: 'utf-8', compression: null, head: { type: 'VXSE45', test: false }, body: JSON.stringify(data) });
test('received numeric values, source, serial, forecast ranges and PLUM are preserved', () => {
  const data = fixture(), report = dmdataReport(data).report;
  assert.equal(report.source, 'DMDATA'); assert.equal(report.issue.serial, 1);
  assert.equal(report.earthquake.hypocenter.depth, 80); assert.equal(report.earthquake.hypocenter.latitude, 41);
  assert.equal(eewInfo(report).maxScale, 55); assert.equal(eewInfo(report).plum, false);
  data.body.intensity.regions[0].isPlum = true; data.body.intensity.forecastMaxInt.to = 'over';
  assert.equal(eewInfo(dmdataReport(data).report).plum, true); assert.equal(eewInfo(dmdataReport(data).report).maxAbove, true);
});
test('assumed, missing, malformed and stale values cannot become real observations', () => {
  const data = fixture(); data.body.earthquake.condition = '仮定震源要素';
  assert.equal(dmdataReport(data).report.earthquake.hypocenter.latitude, undefined);
  assert.equal(dmdataReport(data).report.earthquake.magnitude, null);
  delete data.body.earthquake.condition; data.body.earthquake.hypocenter.coordinate.latitude.value = '';
  data.body.earthquake.hypocenter.depth.value = null;
  assert.equal(dmdataReport(data).report.earthquake.hypocenter.latitude, undefined);
  assert.equal(dmdataReport(data).report.earthquake.hypocenter.depth, null);
  assert.equal(dmdataReport(data, Date.now() + 180000).stale, true);
  assert.throws(() => dmdataReport({ ...data, status: 'unknown' }));
  assert.throws(() => dmdataReport({ ...data, serialNo: null }));
});
test('training, cancellation, same-event provider switching and stronger updates retain alarm guards', () => {
  const data = fixture(), receive = createEEWTracker(), report = dmdataReport(data).report;
  assert.equal(receive(report).sound, true);
  assert.equal(receive({ ...report, source: 'Wolfx' }).sound, undefined);
  data.status = '訓練'; assert.equal(createEEWTracker()(dmdataReport(data).report).sound, false);
  data.status = '通常'; data.infoType = '取消'; data.body.isCanceled = true; delete data.body.earthquake;
  assert.equal(createEEWTracker()(dmdataReport(data).report).sound, false);
});
test('JSON and base64 gzip are decoded; unsupported formats and oversized output fail closed', async () => {
  const data = fixture(), msg = envelope(data);
  assert.deepEqual(await decodeDmdata(msg), data);
  const zipped = gzipSync(Buffer.from(msg.body)).toString('base64');
  assert.deepEqual(await decodeDmdata({ ...msg, encoding: 'base64', compression: 'gzip', body: zipped }), data);
  const trained = await decodeDmdata({ ...msg, head: { ...msg.head, test: true } }); assert.equal(trained.status, '訓練');
  await assert.rejects(decodeDmdata({ ...msg, format: 'xml' }));
  await assert.rejects(decodeDmdata({ ...msg, compression: 'zip' }));
  await assert.rejects(decodeDmdata({ ...msg, encoding: 'base64', compression: 'gzip', body: gzipSync(Buffer.alloc(2100000, 65)).toString('base64') }));
});
test('only the published project and loopback preview can connect; ticket URLs are allowlisted', () => {
  assert.equal(dmdataAllowed({ protocol: 'http:', hostname: '127.0.0.1' }), true);
  assert.equal(dmdataAllowed({ protocol: 'https:', origin: 'https://nekokun148.github.io', pathname: '/quakewatch-v15/' }), true);
  for (const location of [
    { protocol: 'http:', hostname: '127.0.0.1.attacker.test' },
    { protocol: 'https:', origin: 'https://nekokun148.github.io.attacker.test', pathname: '/quakewatch-v15/' },
    { protocol: 'https:', origin: 'https://nekokun148.github.io', pathname: '/other-project/' },
    { protocol: 'https:', origin: 'https://nekokun148.github.io', pathname: '/quakewatch-v15-other/' },
    { protocol: 'file:', hostname: '' }
  ]) assert.equal(dmdataAllowed(location), false);
  assert.equal(dmdataSocketUrl('wss://ws001.api.dmdata.jp/v2/websocket?ticket=TEST-ONLY'), 'wss://ws001.api.dmdata.jp/v2/websocket?ticket=TEST-ONLY');
  for (const url of ['wss://evil.test/v2/websocket?ticket=test', 'ws://ws.api.dmdata.jp/v2/websocket?ticket=test', 'wss://ws.api.dmdata.jp:443/v2/websocket?ticket=test', 'wss://ws.api.dmdata.jp/v2/websocket?ticket=test&key=test']) assert.throws(() => dmdataSocketUrl(url));
  assert.throws(() => createDmdataFeed({ environment: { location: { protocol: 'https:', hostname: 'example.test' } } }).start('TEST-ONLY'));
});

function harness(response = { ok: true, status: 200, json: async () => ({ status: 'ok', websocket: { url: 'wss://ws.api.dmdata.jp/v2/websocket?ticket=TEST-ONLY', protocol: ['dmdata.v2'] } }) }) {
  const sockets = [], calls = [], statuses = [], reports = [], timers = new Map(); let id = 0;
  class Socket { constructor(url, protocol) { this.url = url; this.protocol = protocol; this.sent = []; sockets.push(this); } send(value) { this.sent.push(JSON.parse(value)); } close() { this.closed = true; this.onclose?.(); } }
  const environment = { location: { protocol: 'http:', hostname: '127.0.0.1' }, WebSocket: Socket, setTimeout(fn, delay) { timers.set(++id, { fn, delay }); return id; }, clearTimeout(id) { timers.delete(id); } };
  const feed = createDmdataFeed({ environment, fetcher: async (url, options) => { calls.push({ url, options }); return response; }, onData: (...args) => reports.push(args), onStatus: info => statuses.push(info) });
  const flush = async () => { for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve)); };
  const message = data => sockets.at(-1).onmessage({ data: JSON.stringify(data) });
  return { feed, sockets, calls, statuses, reports, timers, flush, message };
}
test('connect requires explicit key, sends fixed HTTPS auth, confirms start and responds to ping', async () => {
  const h = harness(); assert.equal(h.calls.length, 0);
  h.feed.start('TEST-ONLY'); h.feed.start('TEST-ONLY'); await h.flush(); assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].url, 'https://api.dmdata.jp/v2/socket');
  assert.equal(h.calls[0].options.headers.Authorization, 'Basic ' + btoa('TEST-ONLY:'));
  assert.deepEqual(JSON.parse(h.calls[0].options.body).classifications, ['eew.forecast']);
  assert.equal(h.calls[0].options.redirect, 'error'); assert.equal(h.statuses.at(-1).phase, 'loading');
  assert.equal(h.calls[0].options.credentials, 'omit');
  assert.equal(h.calls[0].options.referrerPolicy, 'no-referrer');
  assert.equal(new URL(h.calls[0].url).search, '');
  assert.equal(JSON.parse(h.calls[0].options.body).appName, 'QuakeWatch ver15');
  h.message(envelope(fixture())); await h.flush(); assert.equal(h.reports.length, 0);
  h.message({ type: 'start', classifications: ['eew.forecast'], time: new Date().toISOString() });
  assert.equal(h.statuses.at(-1).phase, 'live');
  h.message({ type: 'ping', pingId: 'TEST-PING' }); assert.deepEqual(h.sockets[0].sent, [{ type: 'pong', pingId: 'TEST-PING' }]);
  h.message(envelope(fixture())); await h.flush(); assert.equal(h.reports.length, 1);
  const stale = fixture(); stale.reportDateTime = '2020-01-01T00:00:00Z'; h.message(envelope(stale)); await h.flush(); assert.equal(h.reports.length, 1);
  h.feed.stop(); assert.equal(h.sockets[0].closed, true); assert.equal(h.timers.size, 0);
  h.message(envelope(fixture())); await h.flush(); assert.equal(h.reports.length, 1);
});
test('both subscriptions share one socket and require confirmation of both classifications', async () => {
  const h = harness(); h.feed.start('TEST-ONLY', 'both'); await h.flush();
  const request = JSON.parse(h.calls[0].options.body);
  assert.deepEqual(request.classifications, ['eew.forecast', 'eew.warning']);
  assert.deepEqual(request.types, ['VXSE43', 'VXSE44', 'VXSE45']);
  assert.equal(h.sockets.length, 1);
  h.message({ type: 'start', classifications: ['eew.warning', 'eew.forecast'], time: new Date().toISOString() });
  assert.equal(h.statuses.at(-1).phase, 'live');
  for (const type of request.types) {
    h.message({ ...envelope(fixture()), head: { type, test: false } });
    await h.flush();
  }
  assert.equal(h.reports.length, 3);
  h.feed.stop();
  const partial = harness(); partial.feed.start('TEST-ONLY', 'both'); await partial.flush();
  partial.message({ type: 'start', classifications: ['eew.forecast'], time: new Date().toISOString() });
  assert.equal(partial.statuses.at(-1).phase, 'error');
  assert.equal(partial.sockets[0].closed, true);
  assert.equal(partial.timers.size, 0);
});

test('warning-only subscribes to warning telegrams without requesting forecast', async () => {
  const h = harness(); h.feed.start('TEST-ONLY', 'eew.warning'); await h.flush();
  const request = JSON.parse(h.calls[0].options.body);
  assert.deepEqual(request.classifications, ['eew.warning']);
  assert.deepEqual(request.types, ['VXSE43']);
  h.feed.stop();
});

test('fatal authorization, contract and quota errors do not auto-retry or expose provider text', async () => {
  for (const code of [400, 401, 402, 403, 409]) {
    const h = harness({ ok: false, status: code }); h.feed.start('TEST-ONLY'); await h.flush();
    assert.equal(h.statuses.at(-1).phase, 'error'); assert.equal(h.timers.size, 0); assert.equal(h.sockets.length, 0);
    assert.doesNotMatch(JSON.stringify(h.statuses), /TEST-ONLY|Authorization|ticket/);
  }
});
test('429 backs off without alternate servers; stopped or replaced sessions cannot reconnect', async () => {
  const h = harness({ ok: false, status: 429 }); h.feed.start('TEST-ONLY'); await h.flush();
  assert.equal(h.timers.size, 1); assert.equal([...h.timers.values()][0].delay, 60000);
  h.feed.stop(); assert.equal(h.timers.size, 0);
});
test('personal-key modules ship but local saved credentials remain excluded from Pages', async () => {
  assert.equal(PUBLIC_FILES.some(file => file.includes('local/')), false);
  assert.ok(PUBLIC_FILES.includes('js/dmdata.js')); assert.ok(PUBLIC_FILES.includes('js/dmdata-ui.js'));
  const ui = await readFile(new URL('../js/dmdata-ui.js', import.meta.url), 'utf8');
  const source = await readFile(new URL('../js/dmdata.js', import.meta.url), 'utf8');
  assert.match(ui, /type="password"/); assert.match(ui, /input.value = ''/);
  assert.doesNotMatch(source, /localStorage|sessionStorage|console\.|indexedDB/);
  assert.doesNotMatch(ui, /localStorage|sessionStorage|console\.|indexedDB|dmdataRemember|dmdataForget|qwDmdataKey/);
  assert.match(ui, /APIキーの設定方法/);
  assert.match(ui, /pagehide/);
});

test('late ticket responses after stop cannot open a socket or mark a session live', async () => {
  let resolve;
  const pending = new Promise(done => { resolve = done; });
  const h = harness({ ok: true, status: 200, json: () => pending });
  h.feed.start('TEST-ONLY'); await h.flush(); h.feed.stop();
  resolve({ status: 'ok', websocket: { url: 'wss://ws.api.dmdata.jp/v2/websocket?ticket=TEST-ONLY', protocol: ['dmdata.v2'] } });
  await h.flush(); assert.equal(h.sockets.length, 0); assert.equal(h.timers.size, 0); assert.equal(h.statuses.at(-1).phase, 'off');
});
test('socket disconnect obtains a new ticket after backoff, with no overlap or replay', async () => {
  const h = harness(); h.feed.start('TEST-ONLY'); await h.flush();
  const old = h.sockets[0]; old.onclose(); assert.equal(h.timers.size, 1);
  const [id, timer] = [...h.timers][0]; assert.equal(timer.delay, 5000); h.timers.delete(id); timer.fn(); await h.flush();
  assert.equal(h.calls.length, 2); assert.equal(h.sockets.length, 2); assert.equal(old.closed, true);
  old.onmessage({ data: JSON.stringify({ type: 'start', classifications: ['eew.forecast'], time: new Date().toISOString() }) });
  assert.equal(h.statuses.at(-1).phase, 'loading'); h.feed.stop();
});
test('an unmatched cancellation is labelled and training history cannot match a real cancellation', async () => {
  const h = harness(); h.feed.start('TEST-ONLY'); await h.flush();
  h.message({ type: 'start', classifications: ['eew.forecast'], time: new Date().toISOString() });
  const data = fixture(); data.status = '訓練'; h.message(envelope(data)); await h.flush();
  data.status = '通常'; data.infoType = '取消'; data.body.isCanceled = true; delete data.body.earthquake;
  h.message(envelope(data)); await h.flush(); assert.equal(h.reports[1][0].unmatchedCancel, true); h.feed.stop();
});
test('DMDATA becomes primary only after confirmation and loss restores the existing feed', async () => {
  const source = await readFile(new URL('../js/app.js', import.meta.url), 'utf8');
  let ydits, local; const calls = { starts: 0, stops: 0, backupStops: 0, reports: 0 }, elements = new Map();
  const context = vm.createContext({ Promise, location: { protocol: 'http:', hostname: '127.0.0.1' },
    createYditsEEWAdapter: () => () => null, createYditsFeed: opts => { ydits = opts; return { start() { calls.starts++; }, stop() { calls.stops++; } }; },
    createWolfxFeed: () => ({ start() {}, stop() { calls.backupStops++; } }),
    mountDmdata: opts => { local = opts; }, document: { body: { dataset: {} } },
    $: id => { if (!elements.has(id)) elements.set(id, { dataset: {} }); return elements.get(id); }, updateDiagnostics() {}, onData() { calls.reports++; } });
  vm.runInContext(source.slice(source.indexOf('const adaptYdits ='), source.indexOf('const observationFeed =')), context);
  const start = source.indexOf('mountDmdata({');
  const end = source.indexOf('setInterval(() => observationFeed.poll()', start);
  vm.runInContext(source.slice(start, end), context);
  await new Promise(resolve => setImmediate(resolve));
  local.onStatus({ phase: 'loading', text: 'connecting' }); assert.equal(calls.stops, 0);
  local.onStatus({ phase: 'live', text: 'DMDATA live' }); assert.equal(calls.stops, 1); assert.equal(calls.backupStops, 1);
  ydits.onStatus({ phase: 'error', server: 3, text: 'old error' }); assert.equal(elements.get('status').textContent, 'DMDATA live');
  local.onData({}, {}); assert.equal(calls.reports, 1);
  local.onStatus({ phase: 'error', text: 'lost' }); assert.equal(calls.starts, 2);
  local.onData({}, {}); assert.equal(calls.reports, 1);
});

test('public project authenticates only after start, and never accepts a foreign redirect ticket', async () => {
  const h = harness();
  assert.equal(h.calls.length, 0);
  const requests = []; let sockets = 0;
  const feed = createDmdataFeed({ environment: {
    location: { origin: 'https://nekokun148.github.io', pathname: '/quakewatch-v15/' },
    WebSocket: class { constructor() { sockets++; throw new Error('unapproved ticket'); } },
    setTimeout: () => 1, clearTimeout() {}
  }, fetcher: async (_url, options) => { requests.push(options); return {
    ok: true, status: 200, json: async () => ({ status: 'ok', websocket: {
      url: 'wss://attacker.test/v2/websocket?ticket=TEST-ONLY', protocol: ['dmdata.v2']
    } })
  }; } });
  feed.start('TEST-ONLY'); await h.flush();
  assert.equal(requests.length, 1); assert.equal(sockets, 0); feed.stop();
});

test('warning telegrams omit magnitude/depth while forecast telegrams preserve received values', async () => {
  const h = harness(); h.feed.start('TEST-ONLY', 'both'); await h.flush();
  h.message({ type: 'start', classifications: ['eew.forecast', 'eew.warning'], time: new Date().toISOString() });
  const data = fixture();
  h.message(envelope(data)); await h.flush();
  assert.equal(h.reports[0][0].earthquake.magnitude, 7.4);
  assert.equal(h.reports[0][0].earthquake.hypocenter.depth, 80);
  h.message({ ...envelope(data), head: { type: 'VXSE43', test: false } }); await h.flush();
  assert.equal(h.reports[1][0].earthquake.magnitude, null);
  assert.equal(h.reports[1][0].earthquake.hypocenter.depth, null);
  h.feed.stop();
});
