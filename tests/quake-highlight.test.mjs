import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { quakeHighlightReport, quakeHighlightBox, createQuakeHighlight } from '../js/quake-highlight.js';
import { parseJmaQuake } from '../js/observations.js';
const now = Date.parse('2026-10-20T18:00:00+09:00');
// All bulletin values below are synthetic fixtures, never real observations.
const quake = (extra = {}) => ({ code: 551, id: 'TEST-1', observationSource: '気象庁 観測震度',
  points: [{ code: 'TEST-OBS-ONLY', addr: '模擬観測点', scale: 10 }],
  earthquake: { time: new Date(now - 10000).toISOString(),
    hypocenter: { name: '【模擬】福島県会津', depth: 10, magnitude: .7, latitude: 37.6, longitude: 139.9 } },
  ...extra, issue: { source: '気象庁', type: 'DetailScale', time: new Date(now).toISOString(), ...extra.issue } });
class Node {
  constructor() { this.children = []; this.style = {}; this.hidden = false; }
  appendChild(node) { this.children.push(node); }
  replaceChildren(...nodes) { this.children = nodes; }
  get textContent() { return this.ownText || this.children.map(child => child.textContent).join(''); }
  set textContent(text) { this.ownText = text; }
  remove() { this.removed = true; }
}
function ui() {
  const container = new Node(), groups = [], events = new Map();
  const map = { getPane: () => ({}), getContainer: () => container, getSize: () => ({ x: 600, y: 500 }),
    latLngToContainerPoint: () => ({ x: 300, y: 250 }),
    on: (names, fn) => events.set(names, fn), off: names => events.delete(names) };
  const L = { layerGroup() { return { layers: [], addTo() { groups.push(this); return this; },
    clearLayers() { this.layers = []; }, remove() { this.removed = true; } }; },
  circleMarker(point, options) { return { point, options, addTo(group) { group.layers.push(this); } }; } };
  const view = createQuakeHighlight({ map, L, document: { createElement: () => new Node() },
    environment: { addEventListener: (name, fn) => events.set(name, fn), removeEventListener: name => events.delete(name) },
    now: () => now });
  return { view, label: container.children[0], rings: groups[0], events };
}

test('only JMA earthquake reports with an actual reported intensity trigger the display, never EEW or colors', () => {
  for (const code of [556, 561, 554, 555, undefined]) assert.equal(quakeHighlightReport(quake({ code }), { now }), null);
  for (const extra of [{ points: [] }, { points: [{ code: 'A', scale: -1 }] },
    { points: [{ code: 'A', scale: 0 }] }, { observationSource: '画像色の変化' },
    { source: 'Wolfx' }, { issue: { source: 'unknown' } }, { issue: { type: 'Forecast' } }]) {
    assert.equal(quakeHighlightReport(quake(extra), { now }), null);
  }
  assert.equal(quakeHighlightReport({ phase: 'changed', codes: ['A'], observedAt: new Date(now).toISOString() }, { now }), null);
  const report = quakeHighlightReport(quake(), { now });
  assert.equal(report.name, '【模擬】福島県会津'); assert.equal(report.depth, 10);
  assert.equal(report.magnitude, .7); assert.deepEqual(report.position, [37.6, 139.9]);
});

test('history, silent, training and invalid or old report times cannot trigger a new event display', () => {
  assert.equal(quakeHighlightReport(quake(), { now, silent: true }), null);
  for (const extra of [{ test: true }, { isTraining: true }, { unmatchedCancel: true },
    { issue: { time: 'invalid' } }, { issue: { time: new Date(now - 120001).toISOString() } },
    { issue: { time: new Date(now + 10001).toISOString() } }]) {
    assert.equal(quakeHighlightReport(quake(extra), { now }), null);
  }
});

test('unknown measurements and assumed coordinates stay unknown, while actual zero values are retained', () => {
  for (const number of [null, undefined, '', '10', -1, NaN, Infinity]) {
    const report = quakeHighlightReport(quake({ earthquake: { hypocenter: { depth: number, magnitude: number } } }), { now });
    assert.equal(report.depth, null); assert.equal(report.magnitude, null); assert.equal(report.position, null);
  }
  const zero = quakeHighlightReport(quake({ earthquake: { hypocenter: { depth: 0, magnitude: 0 } } }), { now });
  assert.equal(zero.depth, 0); assert.equal(zero.magnitude, 0);
  const assumed = quakeHighlightReport(quake({ earthquake: { assumed: true,
    magnitude: 7, hypocenter: { latitude: 37, longitude: 140, depth: 10 } } }), { now });
  assert.equal(assumed, null);
});

test('observed station rings require actual reported coordinates and intensity, not image colors', () => {
  const data = quake({ points: [
    { code: 'A', pref: '模擬', addr: '点A', scale: 10, latitude: 37, longitude: 140 },
    { code: 'B', pref: '模擬', addr: '点B', scale: 10 },
    { code: 'C', pref: '模擬', addr: '点C', scale: -1, latitude: 37, longitude: 140 }
  ] });
  assert.equal(quakeHighlightReport(data, { now }).points.length, 1);
  assert.equal(quakeHighlightReport({ ...data, code: 556 }, { now }), null);
});

test('normal display stays hidden until a bulletin arrives, then shows literal source values without sound', () => {
  const h = ui(); assert.equal(h.label.hidden, true); assert.equal(h.rings.layers.length, 0);
  assert.equal(h.view.update(quake()), true);
  assert.match(h.label.textContent, /【模擬】福島県会津深さ 10 kmM0\.7地震情報・発表値/);
  assert.match(h.label.textContent, /2026\/10\/20/); assert.doesNotMatch(h.label.textContent, /時刻不明/);
  assert.equal(h.rings.layers.length, 1); assert.deepEqual(h.rings.layers[0].point, [37.6, 139.9]);
  assert.equal(h.rings.layers[0].options.fill, false);
  h.view.destroy();
});

test('the next earthquake replaces the previous label and rings, including a report without coordinates', () => {
  const h = ui(); h.view.update(quake());
  const next = quake({ id: 'TEST-2', issue: { time: new Date(now + 1000).toISOString() },
    earthquake: { hypocenter: { name: '<img onerror=bad>' } } });
  h.view.update(next);
  assert.equal(h.rings.layers.length, 0);
  assert.match(h.label.textContent, /<img onerror=bad>深さ未受信M 未受信/);
  assert.match(h.label.textContent, /震源座標未受信/); assert.doesNotMatch(h.label.textContent, /福島|10 km|M0\.7/);
  assert.equal(h.view.update(quake()), false);
  assert.match(h.label.textContent, /<img onerror=bad>/);
  h.view.destroy();
});

test('only a matching fresh non-training cancellation clears the displayed earthquake', () => {
  const h = ui(); h.view.update(quake());
  const cancel = quake({ cancelled: true, issue: { eventId: 'unrelated', time: new Date(now).toISOString() },
    earthquake: { originTime: new Date(now - 60000).toISOString() } });
  h.view.update(cancel); assert.equal(h.label.hidden, false);
  h.view.update({ ...cancel, code: 556, earthquake: { originTime: new Date(now - 10000).toISOString() } });
  assert.equal(h.label.hidden, false);
  for (const [extra, options] of [[{ test: true }, {}], [{ unmatchedCancel: true }, {}], [{}, { silent: true }]]) {
    h.view.update({ ...cancel, earthquake: { originTime: new Date(now - 10000).toISOString() }, ...extra }, options);
    assert.equal(h.label.hidden, false);
  }
  h.view.update({ ...cancel, earthquake: { originTime: new Date(now - 10000).toISOString() } });
  assert.equal(h.label.hidden, true); assert.equal(h.rings.layers.length, 0);
  h.view.destroy();
});

test('phone, tablet and PC label bounds avoid map controls without moving the map or inventing a position', () => {
  for (const size of [{ x: 312, y: 360 }, { x: 768, y: 620 }, { x: 1200, y: 700 }]) {
    for (const point of [null, [37, 140]]) {
      const box = quakeHighlightBox({ position: point }, size, () => ({ x: 9999, y: -50 }));
      assert.ok(box.x >= 54 && box.y >= 14 && box.x + box.width <= size.x - 72);
      assert.ok(box.y + 128 <= size.y - 50); assert.equal(Boolean(box.visible), false);
    }
  }
  assert.equal(quakeHighlightBox({ position: null }, { x: 200, y: 150 }, () => null), null);
});

test('history clear, page departure and destroy remove only this display and its handlers', () => {
  const h = ui(); h.view.update(quake()); h.view.clear(); assert.equal(h.label.hidden, true);
  h.view.update(quake()); h.events.get('pagehide')(); assert.equal(h.label.hidden, true);
  h.view.update(quake()); h.view.destroy(); h.view.destroy();
  assert.equal(h.events.size, 0); assert.equal(h.label.removed, true); assert.equal(h.rings.removed, true);
  assert.equal(h.view.update(quake()), false);
});

test('production earthquake handlers, not image reception, invoke the new display; asset is cached and built', async () => {
  const app = await readFile(new URL('../js/app.js', import.meta.url), 'utf8');
  const quake = app.slice(app.indexOf('function handleQuake('), app.indexOf('function handleUserSensing('));
  assert.equal((quake.match(/state\.quakeHighlight\?\.update\(d, options\)/g) || []).length, 1);
  assert.doesNotMatch(app.slice(app.indexOf('function handleEEW('), app.indexOf('function handleUserSensing(')), /quakeHighlight/);
  const monitor = app.slice(app.indexOf('function renderMonitorChanges('), app.indexOf('let monitorMetric;'));
  assert.doesNotMatch(monitor, /createMonitorHighlights|quakeHighlight/);
  assert.match(app, /state\.quakeHighlight = createQuakeHighlight/);
  assert.match(app, /state\.quakeHighlight\?\.clear\(\)/);
  const sw = await readFile(new URL('../sw.js', import.meta.url), 'utf8');
  const build = await readFile(new URL('../scripts/build.mjs', import.meta.url), 'utf8');
  assert.match(sw, /js\/quake-highlight\.js/); assert.match(build, /js\/quake-highlight\.js/);
  const module = await readFile(new URL('../js/quake-highlight.js', import.meta.url), 'utf8');
  assert.doesNotMatch(module, /fetch\(|WebSocket|speechSynthesis|localStorage|setView\(|panTo\(|flyTo\(/);
});

test('the production JMA parser supplies the official source and observation gates without inferred data', () => {
  const stamp = new Date(now).toISOString();
  const report = parseJmaQuake({ Control: { Status: '通常', DateTime: stamp },
    Head: { EventID: 'TEST-PARSER-ONLY', InfoType: '発表', ReportDateTime: stamp },
    Body: { Earthquake: { OriginTime: stamp, Magnitude: '0.7',
      Hypocenter: { Area: { Name: '【模擬】福島県会津', Coordinate: '+37.6+139.9-10000/' } } },
    Intensity: { Observation: { MaxInt: '1', Pref: [{ Name: '模擬県', Area: [{ City: [{
      IntensityStation: [{ Name: '模擬観測点', Code: 'TEST-ONLY', Int: '1', latlon: { lat: 37.5, lon: 139.8 } }]
    }] }] }] } } } });
  const display = quakeHighlightReport(report, { now });
  assert.equal(display.depth, 10); assert.equal(display.magnitude, .7);
  assert.deepEqual(display.position, [37.6, 139.9]); assert.equal(display.points.length, 1);
  assert.equal(quakeHighlightReport({ ...report, points: [] }, { now }), null);
  assert.equal(quakeHighlightReport({ ...report, test: true }, { now }), null);
});

