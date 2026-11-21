import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { createEpicenterFocus } from '../js/epicenter-focus.js';
import { PUBLIC_FILES } from '../scripts/build.mjs';

const now = Date.parse('2026-11-21T12:00:00+09:00');
// Synthetic coordinates and timestamps; these are not observed earthquakes.
const position = { lat: 41, lng: 143 };
const report = (extra = {}) => ({ source: 'TEST', issue: { eventId: 'TEST-1', time: new Date(now).toISOString() },
  earthquake: { originTime: new Date(now - 10000).toISOString() }, ...extra });
function harness() {
  const moves = [], bounds = [];
  let zoom = 5;
  const map = { getZoom: () => zoom, stop() {}, setMaxBounds: value => bounds.push(value),
    setView: (center, level, options) => moves.push({ center, level, options }) };
  return { moves, bounds, map, setZoom: value => { zoom = value; },
    focus: createEpicenterFocus({ getMap: () => map, now: () => now }) };
}

test('fresh epicenter recenters once and only a corrected position moves it again', () => {
  const h = harness();
  assert.equal(h.focus(report(), position), true);
  assert.deepEqual(h.moves[0], { center: [41, 143], level: 6, options: { animate: false } });
  assert.equal(h.focus(report(), position), false);
  assert.equal(h.focus(report({ issue: { ...report().issue, serial: 2 } }), position), false);
  assert.equal(h.focus(report(), { lat: 41.1, lng: 143.2 }), true);
  assert.equal(h.moves.length, 2);
});

test('stale, silent, training, cancelled and uncertain sources never take over the map', () => {
  const h = harness();
  for (const [data, point, options] of [
    [report(), position, { silent: true }], [report({ test: true }), position],
    [report({ isTraining: true }), position], [report({ cancelled: true }), position],
    [report({ earthquake: { assumed: true } }), position],
    [report({ earthquake: { levelMethod: true } }), position],
    [report({ issue: { time: new Date(now - 121000).toISOString() } }), position],
    [report({ issue: { time: new Date(now + 11000).toISOString() } }), position],
    [report(), null], [report(), { lat: null, lng: 143 }], [report(), { lat: 0, lng: 0 }],
    [report(), { lat: NaN, lng: 143 }], [report(), { lat: 91, lng: 143 }], [null, position]
  ]) assert.equal(h.focus(data, point, options), false);
  assert.equal(h.moves.length, 0);
  assert.equal(h.focus(report(), position), true);
});

test('missing coordinates do not consume the first valid focus and offshore points are not clamped', () => {
  const h = harness();
  assert.equal(h.focus(report(), null), false);
  h.setZoom(15);
  assert.equal(h.focus(report(), { lat: 42, lng: 165 }), true);
  assert.deepEqual(h.moves[0].center, [42, 165]);
  assert.equal(h.moves[0].level, 8);
  assert.deepEqual(h.bounds, [null]);
});

test('an older earthquake follow-up cannot steal focus from a newer earthquake', () => {
  const h = harness();
  h.focus(report(), position);
  const newer = report({ issue: { eventId: 'TEST-2', time: new Date(now + 1000).toISOString() },
    earthquake: { originTime: new Date(now - 1000).toISOString() } });
  assert.equal(h.focus(newer, position), true);
  const older = report({ issue: { ...report().issue, time: new Date(now + 2000).toISOString() } });
  assert.equal(h.focus(older, { lat: 35, lng: 140 }), false);
  assert.equal(h.moves.length, 2);
});

test('explicit history selection focuses without altering automatic report tracking', () => {
  const h = harness();
  h.focus(report(), position);
  const history = report({ issue: { time: '2020-01-01T00:00:00+09:00' } });
  assert.equal(h.focus(history, { lat: 35, lng: 140 }, { manual: true }), true);
  assert.equal(h.focus(history, { lat: 35, lng: 140 }, { manual: true }), true);
  assert.equal(h.focus(report(), position), false);
  assert.equal(h.moves.length, 3);
});

test('fallback SVG is centered on the same projected epicenter and duplicates do not reset it', () => {
  const boxes = [];
  const focus = createEpicenterFocus({ now: () => now, getLocalMap: () => ({ svg: {
    setAttribute: (key, value) => boxes.push({ key, value }) } }), project: () => ({ x: 500, y: 350 }) });
  assert.equal(focus(report(), position), true);
  assert.deepEqual(boxes, [{ key: 'viewBox', value: '225 75 550 550' }]);
  assert.equal(focus(report(), position), false);
});

test('an uninitialized map does not discard a future focus for the same report', () => {
  const h = harness(); let map = null;
  const focus = createEpicenterFocus({ now: () => now, getMap: () => map });
  assert.equal(focus(report(), position), false);
  map = h.map;
  assert.equal(focus(report(), position), true);
});

test('resize preserves the epicenter view and Japan view resets the fallback viewport', async () => {
  const source = await readFile(new URL('../js/app.js', import.meta.url), 'utf8');
  let fits = 0;
  const context = vm.createContext({ preserveMapView: true, fitJapanView() { fits++; } });
  const resize = source.match(/\.on\('resize', \(\) => \{([^\n]+)\}\);/)[1];
  vm.runInContext(resize, context); assert.equal(fits, 0);
  context.preserveMapView = false;
  vm.runInContext(resize, context); assert.equal(fits, 1);
  const boxes = [];
  const local = vm.createContext({ preserveMapView: true, LOCAL_VIEWBOX: { width: 1000, height: 1000 },
    state: { localMap: { svg: { setAttribute: (...args) => boxes.push(args) } } } });
  vm.runInContext(source.slice(source.indexOf('function fitJapanView('), source.indexOf('function loadMap(')), local);
  local.fitJapanView();
  assert.equal(local.preserveMapView, false);
  assert.deepEqual(boxes, [['viewBox', '0 0 1000 1000']]);
  assert.ok(PUBLIC_FILES.includes('js/epicenter-focus.js'));
});
