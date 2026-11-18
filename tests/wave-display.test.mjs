import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { animateWaves, WAVE_LIFETIME } from '../js/waves.js';
import { parseReportTime } from '../js/observations.js';

test('received coordinates animate both forecast circles, display their meaning, and clear on cancellation', async () => {
  const source = await readFile(new URL('../js/app.js', import.meta.url), 'utf8');
  let now = Date.parse('2026-11-19T12:00:00+09:00');
  let nextFrame;
  class Clock extends Date { static now() { return now; } }
  const environment = {
    Date: Clock,
    requestAnimationFrame(callback) { nextFrame = callback; return 1; },
    cancelAnimationFrame() { nextFrame = null; }
  };
  const layers = new Set();
  const panel = { hidden: true, textContent: '' };
  const state = {
    leafletMap: {}, waveTimers: [],
    waveLayer: {
      clearLayers() { layers.clear(); },
      removeLayer(layer) { layers.delete(layer); }
    }
  };
  const L = { circle(position, options) {
    return {
      position, options, radius: 0,
      addTo() { layers.add(this); return this; },
      setRadius(radius) { this.radius = radius; }
    };
  } };
  const context = vm.createContext({
    state, Date: Clock, window: { L }, WAVE_LIFETIME, parseReportTime,
    $: () => panel, leafletLatLng: position => position, updateDiagnostics() {},
    animateWaves: options => animateWaves({ ...options, environment })
  });
  vm.runInContext(source.slice(source.indexOf('function clearWaveTimers()'), source.indexOf('function renderObservations(')), context);
  const origin = new Date(now - 10000).toISOString();
  context.startWaveAnimation({ lat: 41, lng: 143 }, origin, 80);
  assert.equal(layers.size, 2);
  assert.equal(panel.hidden, false);
  assert.match(panel.textContent, /深さ80km反映/);
  assert.ok([...layers].every(layer => layer.radius === 0));
  now += 20000;
  nextFrame();
  const [p, s] = [...layers];
  assert.ok(p.radius > s.radius && s.radius > 0);
  assert.equal(p.options.dashArray, '8 6');
  assert.match(panel.textContent, /発生から30秒/);
  context.clearWaveTimers();
  assert.equal(panel.hidden, true);
  assert.equal(layers.size, 0);
  assert.equal(nextFrame, null);
  context.startWaveAnimation({ lat: 41, lng: 143 }, 'invalid', 80);
  assert.equal(layers.size, 0);
  assert.equal(panel.hidden, true);
});
