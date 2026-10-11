import test from 'node:test';
import assert from 'node:assert/strict';
import { simulationAt, startRegionSimulation, SIMULATED_REGIONS } from './simulation.js';
import { WAVE_LIFETIME } from '../js/waves.js';

const at = now => simulationAt({ distance: 105000, peak: 55, origin: 0, now });

test('synthetic regions wait for the same P and S radii used by the map', () => {
  assert.deepEqual(at(0), { phase: 'waiting', scale: 0, pIn: 17500, sIn: 30000 });
  assert.equal(at(17499).phase, 'waiting');
  assert.deepEqual(at(17500), { phase: 'p', scale: 10, pIn: 0, sIn: 12500 });
  assert.equal(at(29999).phase, 'p');
  assert.deepEqual(at(30000), { phase: 's', scale: 10, pIn: 0, sIn: 0 });
});

test('fixed S-wave test sequence reaches 6 lower and decays without exceeding the assigned peak', () => {
  assert.equal(at(36000).scale, 55);
  assert.equal(at(47000).scale, 55);
  assert.equal(at(48000).scale, 50);
  assert.equal(at(66000).scale, 0);
  assert.equal(at(66000).phase, 'ended');
  assert.equal(at(WAVE_LIFETIME).phase, 'ended');
  for (let now = 0; now < 100000; now += 200) assert.ok(at(now).scale <= 55);
});

test('future origins do not pre-announce arrivals and invalid inputs stay unknown', () => {
  assert.equal(simulationAt({ distance: 105000, peak: 55, origin: 10000, now: 0 }).phase, 'waiting');
  for (const bad of [{ distance: NaN }, { distance: -1 }, { peak: 99 }, { origin: NaN }, { now: NaN }]) {
    assert.equal(simulationAt({ distance: 105000, peak: 55, origin: 0, now: 0, ...bad }), null);
  }
});

test('every region is explicitly synthetic and has a fixed test-only peak', () => {
  assert.equal(SIMULATED_REGIONS.length, 4);
  for (const region of SIMULATED_REGIONS) {
    assert.match(region.name, /模擬/);
    assert.ok(Number.isFinite(region.lat) && Number.isFinite(region.lng));
    assert.ok(region.peak > 0 && region.peak <= 55);
  }
});

test('simulation updates on its own layer and disposes its interval and markers once', () => {
  const element = () => ({ children: [], style: {}, append(...children) { this.children.push(...children); },
    appendChild(child) { this.children.push(child); }, replaceChildren() { this.children = []; } });
  const panel = element(), table = element(), markers = [], removed = [], cleared = [];
  const document = { getElementById: id => id === 'simulation' ? panel : table, createElement: element };
  const layer = { addTo() { return this; } };
  const map = { removeLayer: value => removed.push(value) };
  const L = {
    layerGroup: () => layer,
    latLng: () => ({ distanceTo: () => 105000 }),
    circleMarker(position, options) {
      const marker = { position, options, addTo(value) { assert.equal(value, layer); return this; },
        bindTooltip() { return this; }, setStyle(value) { this.color = value.fillColor; },
        setTooltipContent(value) { this.tooltip = value; } };
      markers.push(marker);
      return marker;
    }
  };
  let now = 0, update;
  const environment = { Date: { now: () => now },
    setInterval(fn, milliseconds) { assert.equal(milliseconds, 200); update = fn; return 42; },
    clearInterval: id => cleared.push(id) };
  const stop = startRegionSimulation({ document, environment, map, L, origin: 0 });
  assert.equal(panel.hidden, false);
  assert.equal(table.children.length, 4);
  assert.equal(markers.length, 4);
  assert.equal(table.children[0].children[3].textContent, '到達前');
  now = 17500;
  update();
  assert.equal(table.children[0].children[3].textContent, '模擬震度1');
  now = 36000;
  update();
  assert.equal(table.children[0].children[3].textContent, '模擬震度6弱');
  assert.match(markers[0].tooltip, /S波到達.*テスト専用の仮の位置/);
  stop();
  stop();
  assert.deepEqual(cleared, [42]);
  assert.deepEqual(removed, [layer]);
});
