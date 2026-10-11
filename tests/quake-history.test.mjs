import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
const source = await readFile(new URL('../js/app.js', import.meta.url), 'utf8');
test('new epicenters replace old markers even when coordinates are missing', () => {
  let cleared = 0, added = 0;
  const state = { markerLayer: { clearLayers() { cleared++; } }, localMap: { markerLayer: { innerHTML: 'old' } } };
  const ctx = vm.createContext({ state, window: {}, addLocalMarker() { added++; } });
  vm.runInContext(source.slice(source.indexOf('function addMarker('), source.indexOf('function addLeafletMarker(')), ctx);
  ctx.addMarker({ lat: 41, lng: 143 }, 'test', 'quake');
  ctx.addMarker(null, 'missing', 'eew');
  assert.equal(cleared, 2);
  assert.equal(added, 1);
  assert.equal(state.localMap.markerLayer.innerHTML, '');
});
test('history selection displays stored coordinates without replaying alert or changing latest event', () => {
  const elements = new Map();
  const get = id => {
    if (!elements.has(id)) elements.set(id, { children: [], replaceChildren() { this.children = []; }, appendChild(b) { this.children.push(b); } });
    return elements.get(id);
  };
  const state = { latestQuake: 'live', localMap: { waveLayer: { innerHTML: 'waves' } } };
  const markers = [];
  const ctx = vm.createContext({ state, $: get, document: { createElement: () => ({ addEventListener(type, fn) { this.click = fn; } }) },
    sameQuakeReport: (a,b) => a.earthquake.time === b.earthquake.time, displayObservationTime: v => v, scaleText: v => String(v),
    clearWaveTimers() {}, findLatLng: h => h.latitude == null ? null : { lat: h.latitude, lng: h.longitude }, addMarker: (...args) => markers.push(args) });
  vm.runInContext(source.slice(source.indexOf('const quakeHistory ='), source.indexOf('function handleQuake(')), ctx);
  const report = n => ({ earthquake: { time: String(n), maxScale: 20, hypocenter: { name: 'TEST ONLY', latitude: n, longitude: 140 } } });
  ctx.rememberQuake(report(1)); ctx.rememberQuake(report(2)); ctx.rememberQuake(report(2));
  assert.equal(get('quakeHistory').children.length, 2);
  get('quakeHistory').children[1].click();
  assert.equal(markers[0][0].lat, 1);
  assert.equal(state.latestQuake, 'live');
  assert.match(get('quakeHistorySelection').textContent, /履歴表示/);
  for (let n = 3; n < 70; n++) ctx.rememberQuake(report(n));
  assert.equal(get('quakeHistory').children.length, 50);
});
