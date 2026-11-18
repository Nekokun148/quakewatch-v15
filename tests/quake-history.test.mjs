import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { jmaQuakeHistory, parseReportTime } from '../js/observations.js';
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
    if (!elements.has(id)) elements.set(id, { value: '0', addEventListener(type, fn) { this.change = fn; }, children: [], replaceChildren() { this.children = []; }, appendChild(b) { this.children.push(b); } });
    return elements.get(id);
  };
  const state = { latestQuake: 'live', localMap: { waveLayer: { innerHTML: 'waves' } } };
  const markers = [];
  const today = Date.parse('2026-11-13T00:10:00+09:00');
  class Clock extends Date { static now() { return today; } }
  const ctx = vm.createContext({ state, Date: Clock, parseReportTime, $: get, document: { createElement: () => ({ addEventListener(type, fn) { this.click = fn; } }) },
    sameQuakeReport: (a,b) => a.earthquake.time === b.earthquake.time, displayObservationTime: v => v, scaleText: v => String(v),
    clearWaveTimers() {}, findLatLng: h => h.latitude == null ? null : { lat: h.latitude, lng: h.longitude }, addMarker: (...args) => markers.push(args) });
  vm.runInContext(source.slice(source.indexOf('const quakeHistory ='), source.indexOf('function handleQuake(')), ctx);
  const report = n => ({ earthquake: { time: new Date(today + n * 1000).toISOString(), maxScale: 20, hypocenter: { name: 'TEST ONLY', latitude: n, longitude: 140 } } });
  ctx.rememberQuake(report(1)); ctx.rememberQuake(report(2)); ctx.rememberQuake(report(2));
  assert.equal(get('quakeHistory').children.length, 2);
  get('quakeHistory').children[1].click();
  assert.equal(markers[0][0].lat, 1);
  assert.equal(state.latestQuake, 'live');
  assert.match(get('quakeHistorySelection').textContent, /履歴表示/);
  assert.equal(get('quakeWaveformHelp').hidden, false);
  for (let n = 3; n < 70; n++) ctx.rememberQuake(report(n));
  assert.equal(get('quakeHistory').children.length, 50);
  const origin = '2026-11-10T23:59:00+09:00';
  const first = { ttl: '震源・震度情報', eid: 'first', ift: '発表', at: origin, rdt: '2026-11-11T00:02:00+09:00',
    maxi: '5-', anm: '青森県東方沖', cod: '+41.0+143.0-80000/', mag: '7.4' };
  ctx.archive = jmaQuakeHistory([
    first, { ...first, maxi: '4', rdt: '2026-11-11T00:01:00+09:00' },
    { ...first, eid: 'cancelled' },
    { ...first, eid: 'cancelled', ift: '取消', at: undefined, rdt: '2026-11-11T00:03:00+09:00' }
  ]);
  assert.equal(ctx.archive.length, 1);
  assert.equal(ctx.archive[0].earthquake.maxScale, 45);
  vm.runInContext('jmaHistory = archive', ctx);
  get('quakeHistoryDay').value = '3';
  get('quakeHistoryDay').change();
  assert.equal(get('quakeHistory').children.length, 1);
  get('quakeHistory').children[0].click();
  assert.equal(markers.at(-1)[0].lat, 41);
  assert.match(get('quakeHistoryCount').textContent, /2026\/11\/10.*1件/);
  get('quakeHistoryDay').value = 'date';
  get('quakeHistoryDate').value = '2026-11-10';
  get('quakeHistoryDay').change();
  assert.equal(get('quakeHistoryDate').hidden, false);
  assert.equal(get('quakeHistory').children.length, 1);
  get('quakeHistoryDate').value = '2020-01-01';
  get('quakeHistoryDate').change();
  assert.equal(get('quakeHistory').children.length, 0);
  assert.match(get('quakeHistoryCount').textContent, /取得済みの一覧に該当情報なし/);
  get('quakeHistoryDay').value = 'all';
  get('quakeHistoryDay').change();
  assert.equal(get('quakeHistory').children.length, 51);
  assert.equal(get('quakeHistoryDate').hidden, true);
});
