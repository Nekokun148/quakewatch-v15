import test from 'node:test';
import assert from 'node:assert/strict';
import { wolfxReport, createWolfxFeed, WOLFX_EEW_SOCKET } from '../js/wolfx.js';
import { createEEWTracker } from '../js/eew.js';
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
