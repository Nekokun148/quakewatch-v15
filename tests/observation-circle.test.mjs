import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { observationCircle } from '../js/observations.js';

test('observed range uses only reported stations with coordinates and numeric intensity', () => {
  assert.equal(observationCircle([]), null);
  assert.equal(observationCircle([{ scale: 10, isArea: true, latitude: 35, longitude: 139 }]), null);
  const points = [
    { code: 'A', scale: 40, latitude: 35, longitude: 139 },
    { code: 'B', scale: 10, latitude: 36, longitude: 139 },
    { code: 'A', scale: 20, latitude: 35, longitude: 139 },
    { scale: 10, addr: 'Missing coordinates' },
    { scale: -1, latitude: 40, longitude: 140 }
  ];
  const circle = observationCircle(points);
  assert.equal(circle.count, 2);
  assert.equal(circle.lat, 35);
  assert.ok(circle.radius > 111000 && circle.radius < 112000);
  assert.equal(observationCircle([points[0]]).radius, 0);
});

test('observed range renders alongside wave circles and clears when the next event has no observations', async () => {
  const source = await readFile(new URL('../js/app.js', import.meta.url), 'utf8');
  const observed = [];
  const waves = ['P', 'S'];
  const status = {};
  const layer = { clearLayers() { observed.length = 0; } };
  const L = {
    circle(position, options) {
      return {
        bindTooltip(text) { this.text = text; return this; },
        addTo(target) {
          assert.equal(target, layer);
          observed.push({ position, options });
        }
      };
    }
  };
  const context = vm.createContext({
    state: { observationExtentLayer: layer, waveLayer: waves },
    window: { L }, observationCircle, $: () => status,
    displayObservationTime: value => value, escapeHtml: value => value
  });
  vm.runInContext(source.slice(source.indexOf('function renderObservationExtent('), source.indexOf('function renderObservations(')), context);
  context.renderObservationExtent({
    earthquake: { time: '2026-11-19T00:00:00+09:00' },
    points: [
      { scale: 20, latitude: 35, longitude: 139 },
      { scale: 10, latitude: 36, longitude: 139 }
    ]
  });
  assert.equal(observed.length, 1);
  assert.match(status.textContent, /2地点/);
  assert.equal(observed[0].options.dashArray, '3 7');
  assert.deepEqual(waves, ['P', 'S']);
  context.renderObservationExtent({ points: [] });
  assert.equal(observed.length, 0);
  assert.match(status.textContent, /待機中/);
});
