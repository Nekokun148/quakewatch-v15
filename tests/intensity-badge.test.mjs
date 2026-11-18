import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { measuredPoints } from '../js/observations.js';

test('map badges use reported numeric intensities and verified coordinates only', async () => {
  const source = await readFile(new URL('../js/app.js', import.meta.url), 'utf8');
  const markers = [];
  const layer = { clearLayers() { markers.length = 0; } };
  const L = {
    divIcon: options => options,
    marker(position, options) {
      return {
        bindTooltip(title) { this.title = title; return this; },
        addTo(target) {
          assert.equal(target, layer);
          markers.push({ position, options });
          return this;
        }
      };
    }
  };
  const context = vm.createContext({
    state: { observationLayer: layer }, window: { L }, measuredPoints,
    scaleText: value => ({ 10: '1', 45: '5弱' })[value],
    escapeHtml: value => value, displayObservationTime: value => value,
    renderObservationRegions() {}, updateDiagnostics() {}, document: {}
  });
  vm.runInContext(source.slice(source.indexOf('function renderObservations('), source.indexOf('const quakeHistory =')), context);
  context.renderObservations({
    earthquake: { time: '2026-11-19T00:00:00+09:00' },
    points: [
      { scale: 10, latitude: 35, longitude: 139, addr: 'TEST A' },
      { scale: 45, latitude: 36, longitude: 140, addr: 'TEST B' },
      { scale: 10, addr: 'Missing position' },
      { scale: -1, latitude: 37, longitude: 141 }
    ]
  });
  assert.equal(markers.length, 2);
  const one = markers.find(marker => marker.position[0] === 35);
  const five = markers.find(marker => marker.position[0] === 36);
  assert.match(one.options.icon.html, /aria-label="観測震度1">1<\/span>/);
  assert.match(five.options.icon.html, /aria-label="観測震度5弱">5弱<\/span>/);
  assert.match(one.options.icon.html, /--intensity-color:#7dd3fc/);
  context.renderObservations({ points: [] });
  assert.equal(markers.length, 0);
});
