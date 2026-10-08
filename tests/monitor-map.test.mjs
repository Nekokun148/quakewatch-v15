import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { matchMonitorPoints, frameColors } from '../js/monitor-map.js';

const station = { code: 'A', lat: 35, lng: 139 };
const point = { ...station, x: 10, y: 20 };
test('mapping requires matching codes and coordinates, unique pixels and valid bounds', () => {
  assert.equal(matchMonitorPoints({ points: [point] }, [station]).length, 1);
  for (const value of [{ code: 'unknown' }, { lat: 36 }, { lng: 140 }, { lat: NaN }, { x: -1 }, { y: 400 }, { x: 1.5 }]) {
    assert.equal(matchMonitorPoints({ points: [{ ...point, ...value }] }, [station]).length, 0);
  }
  assert.equal(matchMonitorPoints({ points: [point, { ...point, code: 'B' }] }, [station]).length, 0);
  assert.equal(matchMonitorPoints({ points: [point, { ...point, x: 11 }] }, [station]).length, 0);
});
test('frame reproduces source colors without turning them into numeric observations', () => {
  const image = { width: 352, height: 400, data: new Uint8ClampedArray(352 * 400 * 4) };
  const offset = (point.y * 352 + point.x) * 4;
  image.data.set([0, 255, 64, 255], offset);
  assert.equal(frameColors(image, [point]).get('A'), '#00ff40');
  for (const rgba of [[255,255,255,255], [0,0,255,0], [10,10,10,255]]) {
    image.data.set(rgba, offset);
    assert.equal(frameColors(image, [point]).get('A'), null);
  }
  assert.throws(() => frameColors({ ...image, width: 353 }, [point]));
});
test('pinned metadata matches actual land stations, not offshore or relocated stations', async () => {
  const catalog = JSON.parse(await readFile(new URL('../data/monitor-points.json', import.meta.url)));
  const environment = { window: {} };
  vm.runInNewContext(await readFile(new URL('../js/stations.js', import.meta.url), 'utf8'), environment);
  const points = matchMonitorPoints(catalog, environment.window.OBSERVATION_STATIONS);
  assert.ok(points.length > 900);
  assert.equal(new Set(points.map(p => `${p.x}/${p.y}`)).size, points.length);
  assert.match(catalog.sha256, /^[a-f0-9]{64}$/);
  const land = JSON.parse(await readFile(new URL('../data/basemap.geojson', import.meta.url)));
  assert.ok(land.features.some(f => f.properties.name === 'Japan'));
  assert.ok(land.features.length > 5);
});
