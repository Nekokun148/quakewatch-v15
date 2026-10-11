import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { acceptsQuakeReport, sameQuakeReport, parseReportTime, selectObservationReport } from '../js/observations.js';

const app = await readFile(new URL('../js/app.js', import.meta.url), 'utf8');
const html = await readFile(new URL('./browser.html', import.meta.url), 'utf8');
const handler = app.slice(app.indexOf('function handleQuake('), app.indexOf('function handleEEW('));

function scenario() {
  let received;
  const now = Date.now();
  class Clock extends Date { static now() { return now; } }
  const elements = new Map();
  const frame = {
    contentWindow: { __quakeWatchV15: { state: { latestQuake: null }, onData(data, options) { received = { data, options }; } } },
    addEventListener() {}
  };
  const document = {
    querySelector(selector) {
      if (selector === 'iframe') return frame;
      if (!elements.has(selector)) elements.set(selector, {});
      return elements.get(selector);
    },
    querySelectorAll() { return []; }
  };
  const code = html.match(/<script type="module">([\s\S]*?)<\/script>/)[1]
    .replace(/^\s*import [^;]+;/gm, '');
  vm.runInNewContext(code, { document, Date: Clock, parseReportTime, structuredClone, window: {}, startRegionSimulation: () => () => {} });
  elements.get('#aomori').onclick();
  return { ...received, text: elements.get('#result').textContent, now };
}

function receiver() {
  const state = { seen: new Set(), latestQuake: null, latestObservation: null, bannerTime: 0 };
  const calls = { waves: [], speech: [], toast: [] };
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, {});
    return elements.get(id);
  };
  const context = vm.createContext({
    state, $: element, document: { querySelector: element }, acceptsQuakeReport, sameQuakeReport,
    quakeReportTime: data => parseReportTime(data.issue?.time), selectObservationReport,
    scaleText: scale => scale === 55 ? '6弱' : String(scale), displayObservationTime: value => value,
    escapeHtml: value => String(value), setEventColor() {}, renderObservations() {}, addMarker() {},
    findLatLng: h => h.latitude != null && h.longitude != null ? { lat: h.latitude, lng: h.longitude } : null,
    startWaveAnimation: (...args) => calls.waves.push(args), quakeAnnouncement: () => 'test announcement',
    rememberQuake() {}, rememberAnnouncement() {}, showToast: text => calls.toast.push(text), speech: { say: text => calls.speech.push(text) }
  });
  vm.runInContext(handler, context);
  return { calls, receive: (data, options) => context.handleQuake(data, options) };
}

test('Aomori display scenario keeps user values and explicitly labels synthetic position and waves', () => {
  const result = scenario();
  assert.equal(result.data.earthquake.maxScale, 55);
  assert.equal(result.data.earthquake.hypocenter.depth, 80);
  assert.equal(result.data.earthquake.hypocenter.magnitude, 7.4);
  assert.equal(result.data.earthquake.hypocenter.latitude, 41);
  assert.equal(result.data.earthquake.hypocenter.longitude, 143);
  assert.match(result.data.earthquake.hypocenter.name, /表示テスト・仮の震源/);
  assert.equal(result.data.test, true);
  assert.equal(result.data.points.length, 0);
  assert.equal(parseReportTime(result.data.earthquake.time), result.now - 15000);
  assert.equal(result.options.silent, true);
  assert.equal(result.options.animateWaves, true);
  assert.match(result.text, /実際の地震ではありません/);
  assert.match(result.text, /深さを使った伝播計算ではありません/);
});

test('silent display test animates waves without speech or toast and does not repeat a report', () => {
  const { data, options } = scenario();
  const h = receiver();
  h.receive(data, options);
  assert.equal(h.calls.waves.length, 1);
  assert.equal(h.calls.waves[0][0].lat, 41);
  assert.equal(h.calls.waves[0][0].lng, 143);
  assert.equal(h.calls.waves[0][1], data.earthquake.time);
  assert.deepEqual(h.calls.speech, []);
  assert.deepEqual(h.calls.toast, []);
  h.receive({ ...data, id: data.id + '-duplicate' }, options);
  assert.equal(h.calls.waves.length, 1);
});

test('silent live history remains unanimated unless explicitly requested', () => {
  const h = receiver();
  h.receive(scenario().data, { silent: true });
  assert.deepEqual(h.calls.waves, []);
  assert.deepEqual(h.calls.speech, []);
});

test('normal live reception still animates and announces', () => {
  const h = receiver();
  h.receive(scenario().data, {});
  assert.equal(h.calls.waves.length, 1);
  assert.equal(h.calls.speech.length, 1);
  assert.equal(h.calls.toast.length, 1);
});
