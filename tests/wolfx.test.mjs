import test from 'node:test';
import assert from 'node:assert/strict';
import { wolfxReport, createWolfxFeed, WOLFX_EEW_SOCKET } from '../js/wolfx.js';
import { createEEWTracker, eewInfo } from '../js/eew.js';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

test('app starts fallback only after server 3 fails and closes it on YDITS recovery', async () => {
  const source = await readFile(new URL('../js/app.js', import.meta.url), 'utf8');
  let ydits, wolfx, starts = 0, stops = 0;
  const elements = new Map();
  const context = vm.createContext({ createYditsEEWAdapter: () => () => null,
    createYditsFeed: options => { ydits = options; return { start() {} }; },
    createWolfxFeed: options => { wolfx = options; return { start() { starts++; }, stop() { stops++; } }; },
    document: { body: { dataset: {} } }, $: id => { if (!elements.has(id)) elements.set(id, { dataset: {} }); return elements.get(id); }, updateDiagnostics() {}, onData() {} });
  vm.runInContext(source.slice(source.indexOf('const adaptYdits ='), source.indexOf('const observationFeed =')), context);
  ydits.onStatus({ phase: 'error', server: 1, text: 'failure1' });
  ydits.onStatus({ phase: 'error', server: 2, text: 'failure2' }); assert.equal(starts, 0);
  ydits.onStatus({ phase: 'limited', server: 3, text: 'limited' }); assert.equal(starts, 0);
  ydits.onStatus({ phase: 'error', server: 3, text: 'failure3' }); assert.equal(starts, 1);
  wolfx.onStatus({ phase: 'live', text: 'Wolfx live' });
  ydits.onStatus({ phase: 'error', server: 1, text: 'failure1' }); assert.equal(elements.get('status').textContent, 'Wolfx live');
  ydits.onStatus({ phase: 'live', server: 1, text: 'YDITS live' }); assert.equal(stops, 1); assert.equal(elements.get('status').textContent, 'YDITS live');
});

// Synthetic fixtures only; never a current observed earthquake.
const fixture = () => ({ type: 'jma_eew', EventID: 'TEST-ONLY', Serial: 1, AnnouncedTime: new Date().toISOString(), OriginTime: new Date(Date.now() - 10000).toISOString(), Issue: { Status: '通常' }, Hypocenter: 'TEST ONLY', Latitude: 41, Longitude: 143, Depth: 80, Magnitude: 7.4, MaxIntensity: '6弱', WarnArea: [], isTraining: false, isAssumption: false, isWarn: true, isFinal: false, isCancel: false });

test('level-method compatibility values are not treated as a measured hypocenter or origin', () => {
  const raw = { ...fixture(), CodeType: '最大予測震度のみの緊急地震速報', Depth: 10, Magnitude: 0 };
  const { report } = wolfxReport(raw);
  assert.equal(report.earthquake.levelMethod, true);
  assert.equal(report.earthquake.assumed, false);
  assert.equal(report.earthquake.originTime, undefined);
  assert.equal(report.issue.originTime, undefined);
  assert.equal(report.earthquake.detectionTime, raw.OriginTime);
  assert.equal(report.earthquake.magnitude, null);
  assert.equal(report.earthquake.hypocenter.depth, null);
  assert.equal(report.earthquake.hypocenter.latitude, undefined);
  assert.equal(eewInfo(report).plum, false);
  assert.equal(eewInfo(report).maxScale, 55);
  assert.doesNotThrow(() => wolfxReport({ ...raw, OriginTime: '不明' }));
});

test('explicit regional PLUM descriptions are preserved independently of isAssumption', () => {
  const raw = { ...fixture(), WarnArea: [null,
    { Chiiki: 'TEST PLUM AREA', Shindo1: '6弱', Shindo2: '5強', Time: '123456', Type: '警報', Arrive: 'PLUM法による予測' },
    { Chiiki: 'TEST NORMAL AREA', Shindo1: '4', Shindo2: '3', Time: '//////', Type: '予報', Arrive: '既に主要動到達と推測' }] };
  const { report } = wolfxReport(raw);
  assert.equal(report.earthquake.assumed, false);
  assert.equal(report.areas[0].isPlum, true);
  assert.equal(report.areas[0].arrivalTimeText, '123456');
  assert.equal(report.areas[0].forecastType, '警報');
  assert.equal(report.areas[1].isPlum, false);
  assert.equal(eewInfo(report).plum, true);
  assert.equal(eewInfo(wolfxReport({ ...fixture(), isAssumption: true }).report).plum, false);
});

test('unknown numeric placeholders stay unknown and Magnitude is the authoritative field', () => {
  const unknown = wolfxReport({ ...fixture(), Magnitude: 0, Depth: 0, Accuracy: { Depth: '不明' } }).report;
  assert.equal(unknown.earthquake.magnitude, null);
  assert.equal(unknown.earthquake.hypocenter.depth, null);
  const shallow = wolfxReport({ ...fixture(), Depth: 0, Accuracy: { Depth: 'ごく浅い' }, Magunitude: 9 }).report;
  assert.equal(shallow.earthquake.hypocenter.depth, 0);
  assert.equal(shallow.earthquake.magnitude, 7.4);
  assert.equal(wolfxReport({ ...fixture(), Magnitude: undefined, Magunitude: 9 }).report.earthquake.magnitude, null);
});

test('origin refinement for the same event does not replay an unchanged warning', () => {
  const raw = { ...fixture(), CodeType: '最大予測震度のみの緊急地震速報' };
  const receive = createEEWTracker();
  assert.equal(receive(wolfxReport(raw).report).sound, true);
  const refined = { ...raw, CodeType: 'Ｍ、最大予測震度及び主要動到達予測時刻の緊急地震速報', Serial: 2 };
  assert.equal(receive(wolfxReport(refined).report).sound, false);
  const stronger = { ...refined, Serial: 3, MaxIntensity: '6強' };
  assert.equal(receive(wolfxReport(stronger).report).sound, true);
  const cancel = { ...stronger, Serial: 4, isCancel: true, Issue: { Status: '取り消し' } };
  assert.equal(wolfxReport(cancel).report.issue.originTime, undefined);
  const result = receive(wolfxReport(cancel).report);
  assert.equal(result.accepted, true);
  assert.equal(result.sound, false);
});

test('malformed root values are rejected while malformed area entries cannot crash parsing', () => {
  for (const value of [null, [], 'jma_eew', 1]) assert.throws(() => wolfxReport(value));
  assert.deepEqual(wolfxReport({ ...fixture(), WarnArea: [null, {}, 3] }).report.areas, []);
});
test('Wolfx preserves received report values and rejects malformed data', () => {
  const data = fixture(), parsed = wolfxReport(data);
  assert.equal(parsed.report.earthquake.maxScale, 55);
  assert.equal(parsed.report.issue.eventId, 'TEST-ONLY');
  assert.equal(parsed.report.earthquake.hypocenter.depth, 80);
  assert.throws(() => wolfxReport({ ...data, isWarn: 'true' }));
  assert.throws(() => wolfxReport({ ...data, MaxIntensity: 'invalid' }));
  assert.equal(wolfxReport({ ...data, Latitude: null }).report.earthquake.hypocenter.latitude, undefined);
  assert.equal(wolfxReport({ ...data, isAssumption: true }).report.earthquake.magnitude, null);
  assert.equal(wolfxReport({ ...data, isAssumption: true }).report.earthquake.hypocenter.latitude, undefined);
  assert.equal(wolfxReport(data, Date.now() + 180000).stale, true);
});
test('Wolfx accepts cancellation status only for cancellation reports without marking it as training', () => {
  const data = { ...fixture(), Issue: { Status: '取り消し' }, Serial: 2, isCancel: true,
    Hypocenter: '', Latitude: 0, Longitude: 0, Magnitude: 0, Depth: 0, MaxIntensity: '不明' };
  const parsed = wolfxReport(data);
  assert.equal(parsed.training, false);
  assert.equal(parsed.report.test, false);
  assert.equal(parsed.report.cancelled, true);
  assert.equal(parsed.report.issue.eventId, data.EventID);
  assert.equal(parsed.report.issue.serial, 2);
  assert.equal(parsed.report.earthquake, undefined);
  assert.deepEqual(parsed.report.areas, []);
  assert.equal(wolfxReport(data, Date.now() + 180000).stale, true);
  assert.throws(() => wolfxReport({ ...data, isCancel: false }));
  assert.throws(() => wolfxReport({ ...data, isCancel: 'true' }));
  assert.throws(() => wolfxReport({ ...data, Issue: { Status: 'unknown' } }));
  assert.equal(wolfxReport({ ...data, isTraining: true }).training, true);
  for (const status of ['通常', '訓練', '試験']) {
    assert.equal(wolfxReport({ ...data, Issue: { Status: status } }).training, status !== '通常');
  }
});
test('cancellation messages stay separate from training and old cancellations cannot replay alerts', () => {
  const sockets = [], timers = new Map(), received = [], statuses = []; let id = 0;
  const tracker = createEEWTracker();
  class Socket { constructor() { sockets.push(this); } send() {} close() { this.onclose?.(); } }
  const feed = createWolfxFeed({ environment: { WebSocket: Socket,
    setTimeout(fn) { timers.set(++id, fn); return id; }, clearTimeout(id) { timers.delete(id); } },
  onData: (report, options) => received.push({ report, options, tracked: tracker(report, options) }),
  onStatus: status => statuses.push(status) });
  const active = fixture();
  const cancel = { ...active, Issue: { Status: '取り消し' }, Serial: 2, isCancel: true };
  const send = data => sockets[0].onmessage({ data: JSON.stringify(data) });
  feed.start(); sockets[0].onopen();
  send({ ...cancel, AnnouncedTime: '2020/01/01 00:00:00' });
  assert.equal(received.length, 0);
  assert.equal(statuses.at(-1).phase, 'live');
  assert.match(statuses.at(-1).text, /過去の最終受信情報/);
  send({ ...cancel, EventID: 'UNMATCHED-TEST-ONLY', OriginTime: new Date(Date.now() - 60000).toISOString() });
  assert.equal(received[0].report.unmatchedCancel, true);
  assert.equal(received[0].report.test, false);
  assert.equal(received[0].options.silent, false);
  assert.equal(received[0].tracked.sound, false);
  assert.match(statuses.at(-1).text, /取消報受信/);
  send(active);
  assert.equal(received[1].tracked.sound, true);
  send(cancel);
  assert.equal(received[2].report.unmatchedCancel, false);
  assert.equal(received[2].tracked.info.training, false);
  assert.equal(received[2].tracked.info.cancelled, true);
  assert.equal(received[2].tracked.sound, false);
  send({ ...cancel, isCancel: false });
  assert.equal(received.length, 3);
  assert.equal(statuses.at(-1).phase, 'error');
  feed.stop(); assert.equal(timers.size, 0);
});
test('socket queries once, ignores historical reports, silences training, and closes without reconnect', () => {
  const sockets = [], timers = new Map(), received = []; let id = 0;
  class Socket { constructor(url) { assert.equal(url, WOLFX_EEW_SOCKET); sockets.push(this); this.sent = []; } send(value) { this.sent.push(value); } close() { this.closed = true; this.onclose?.(); } }
  const feed = createWolfxFeed({ environment: { WebSocket: Socket, setTimeout(fn) { timers.set(++id, fn); return id; }, clearTimeout(id) { timers.delete(id); } }, onData: (...args) => received.push(args) });
  feed.start(); feed.start(); assert.equal(sockets.length, 1);
  const ws = sockets[0]; ws.onopen(); assert.deepEqual(ws.sent, ['query_jmaeew']);
  ws.onmessage({ data: JSON.stringify({ ...fixture(), AnnouncedTime: '2020/01/01 00:00:00' }) }); assert.equal(received.length, 0);
  ws.onmessage({ data: JSON.stringify({ ...fixture(), isTraining: true }) }); assert.equal(received[0][1].silent, true);
  ws.onmessage({ data: '{' }); assert.equal(received.length, 1);
  ws.onmessage({ data: JSON.stringify({ ...fixture(), isCancel: true }) }); assert.equal(received[1][0].unmatchedCancel, true);
  feed.stop(); assert.equal(ws.closed, true); assert.equal(timers.size, 0);
  ws.onmessage({ data: JSON.stringify(fixture()) }); assert.equal(received.length, 2);
});
test('provider switching cannot replay the same earthquake alarm', () => {
  const report = wolfxReport(fixture()).report;
  const receive = createEEWTracker();
  assert.equal(receive(report).sound, true);
  const ydits = { ...report, source: 'YDITS', issue: { ...report.issue, eventId: 'ydits/test', serial: undefined } };
  assert.equal(receive(ydits).sound, false);
  assert.equal(receive({ ...ydits, time: new Date().toISOString(), earthquake: { ...ydits.earthquake, maxScale: 60 }, issue: { ...ydits.issue, time: new Date(Date.now() + 1000).toISOString() } }).sound, true);
});

test('failed sockets reconnect with bounded backoff and stale callbacks cannot reconnect after stop', () => {
  const sockets = [], timers = new Map(), delays = []; let id = 0;
  class Socket { constructor() { sockets.push(this); } close() { this.onclose?.(); } }
  const feed = createWolfxFeed({ environment: { WebSocket: Socket, setTimeout(fn, delay) { timers.set(++id, { fn, delay }); return id; }, clearTimeout(id) { timers.delete(id); } } });
  feed.start();
  for (let attempt = 0; attempt < 6; attempt++) {
    const socket = sockets.at(-1); socket.onerror();
    assert.equal(timers.size, 1);
    const [key, timer] = [...timers][0]; delays.push(timer.delay); timers.delete(key); timer.fn();
    const count = sockets.length; socket.onerror(); assert.equal(sockets.length, count);
  }
  assert.deepEqual(delays, [5000, 10000, 20000, 40000, 60000, 60000]);
  feed.stop(); assert.equal(timers.size, 0);
});

test('documented millisecond-string heartbeat keeps one socket alive and ignores invalid timestamps', () => {
  const fixedNow = Date.now(), sockets = [], statuses = [], timers = new Map(); let id = 0;
  class Socket {
    constructor() { sockets.push(this); this.sent = []; }
    send(value) { this.sent.push(value); }
    close() { this.closed = true; this.onclose?.(); }
  }
  const feed = createWolfxFeed({ environment: { WebSocket: Socket, Date: { now: () => fixedNow },
    setTimeout(fn, delay) { timers.set(++id, { fn, delay }); return id; }, clearTimeout(key) { timers.delete(key); } },
    onStatus: status => statuses.push(status) });
  feed.start(); const ws = sockets[0]; ws.onopen();
  const send = data => ws.onmessage({ data: JSON.stringify(data) });
  const timer = [...timers.keys()][0];
  for (const timestamp of [null, [], {}, '', String(fixedNow - 100000), String(fixedNow + 100000)]) {
    send({ type: 'heartbeat', timestamp });
    assert.equal([...timers.keys()][0], timer);
  }
  send({ type: 'heartbeat', timestamp: String(fixedNow), ver: 1, id: 'TEST-ONLY' });
  assert.deepEqual(ws.sent, ['query_jmaeew', 'ping']);
  assert.equal(statuses.at(-1).phase, 'live');
  assert.equal([...timers.values()][0].delay, 90000);
  send({ type: 'pong', timestamp: String(fixedNow) });
  assert.deepEqual(ws.sent, ['query_jmaeew', 'ping']);
  for (const invalid of [null, [], true, 42]) assert.doesNotThrow(() => send(invalid));
  assert.equal(statuses.at(-1).phase, 'error');
  send({ type: 'heartbeat', timestamp: String(fixedNow) });
  assert.equal(statuses.at(-1).phase, 'live');
  feed.start(); assert.equal(sockets.length, 1);
  feed.stop(); assert.equal(timers.size, 0);
});

test('synchronous socket failures and throwing close still use bounded retry and stop cleanly', () => {
  for (const constructorFailure of [true, false]) {
    const sockets = [], timers = new Map(); let id = 0;
    class Socket {
      constructor() { if (constructorFailure) throw new Error('TEST constructor failure'); sockets.push(this); }
      close() { throw new Error('TEST close failure'); }
    }
    const feed = createWolfxFeed({ environment: { WebSocket: Socket,
      setTimeout(fn, delay) { timers.set(++id, { fn, delay }); return id; }, clearTimeout(key) { timers.delete(key); } } });
    assert.doesNotThrow(() => feed.start());
    if (!constructorFailure) assert.doesNotThrow(() => sockets[0].onerror());
    assert.equal(timers.size, 1);
    assert.equal([...timers.values()][0].delay, 5000);
    assert.doesNotThrow(() => feed.stop());
    assert.equal(timers.size, 0);
  }
});
