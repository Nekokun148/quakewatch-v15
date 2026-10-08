import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  INTENSITY_COLORS, intensityColor, pointPosition, measuredPoints, observedRegions,
  parseReportTime, acceptsQuakeReport, sameQuakeReport, displayObservationTime,
  parseJmaQuake, createObservationFeed, JMA_QUAKE_BASE
} from '../js/observations.js';

const fixture = JSON.parse(await readFile(new URL('./fixtures/jma-quake.json', import.meta.url), 'utf8'));
const copy = () => structuredClone(fixture);
const station = document => document.Body.Intensity.Observation.Pref[0].Area[0].City[0].IntensityStation[0];
const filename = '20261007160547_20261007160305_VXSE5k_1.json';
const listing = (json = filename, rdt = '2026-10-07T16:05:00+09:00') => [{ ttl: '震源・震度情報', ift: '発表', json, rdt }];
const response = data => ({ ok: true, json: async () => data });

test('real JMA intensity report provides an exact station position and hypocenter', () => {
  const quake = parseJmaQuake(fixture);
  assert.equal(quake.code, 551);
  assert.equal(quake.earthquake.time, '2026-10-07T16:03:00+09:00');
  assert.deepEqual(quake.earthquake.hypocenter, { name: '奄美大島北東沖', latitude: 29.7, longitude: 130.5, depth: 60, magnitude: 3.5 });
  assert.equal(quake.points[0].addr, '鹿児島十島村中之島徳之尾');
  assert.deepEqual(measuredPoints(quake.points).map(p => [p.lat, p.lng, p.color]), [[29.84, 129.87, '#7dd3fc']]);
});

test('all nine published intensity levels map to separate colors', () => {
  const values = ['1', '2', '3', '4', '5-', '5+', '6-', '6+', '7'];
  const scales = [10, 20, 30, 40, 45, 50, 55, 60, 70];
  values.forEach((value, i) => {
    const document = copy();
    station(document).Int = value;
    document.Body.Intensity.Observation.MaxInt = value;
    const quake = parseJmaQuake(document);
    assert.equal(quake.points[0].scale, scales[i]);
    assert.equal(quake.earthquake.maxScale, scales[i]);
    assert.equal(measuredPoints(quake.points)[0].color, INTENSITY_COLORS[scales[i]]);
  });
  assert.equal(new Set(Object.values(INTENSITY_COLORS)).size, 9);
  assert.equal(intensityColor(-1), null);
  assert.equal(intensityColor(99), null);
});

test('coordinates are never invented for missing, invalid, or area measurements', () => {
  assert.equal(pointPosition({ latitude: null, longitude: null }), null);
  assert.equal(pointPosition({ lat: '', lng: '' }), null);
  assert.equal(pointPosition({ lat: 91, lng: 139 }), null);
  assert.equal(pointPosition({ lat: 35, lng: 181 }), null);
  assert.deepEqual(pointPosition({ latitude: '35', longitude: '139' }), { lat: 35, lng: 139 });
  assert.equal(measuredPoints([
    { addr: 'missing', scale: 10 }, { lat: 35, lng: 139, scale: -1 },
    { lat: 35, lng: 139, scale: 10, isArea: true }
  ]).length, 0);
});

test('duplicate station reports keep the highest actual measurement only', () => {
  const points = [10, 40, 20].map(scale => ({ code: 'a', pref: '東京都', addr: 'a', lat: 35, lng: 139, scale }));
  assert.deepEqual(measuredPoints(points).map(p => p.scale), [40]);
  assert.deepEqual(observedRegions(points), [{ name: '東京都', count: 1, areaCount: 0, scale: 40 }]);
});

test('observed region summaries separate areas from station counts and sort by intensity', () => {
  const regions = observedRegions([
    { pref: '北海道', addr: 'a', scale: 10 },
    { pref: '東京都', addr: 'b', scale: 20 },
    { pref: '東京都', addr: 'c', scale: 40, isArea: true },
    { pref: '東京都', addr: 'unknown', scale: -1 }
  ]);
  assert.deepEqual(regions, [
    { name: '東京都', count: 1, areaCount: 1, scale: 40 },
    { name: '北海道', count: 1, areaCount: 0, scale: 10 }
  ]);
});

test('P2P JST and JMA UTC issue times identify the same report', () => {
  assert.equal(parseReportTime('2026/10/07 16:05:47'), parseReportTime('2026-10-07T07:05:47Z'));
  assert.equal(parseReportTime('invalid'), 0);
  assert.equal(parseReportTime(''), 0);
  assert.match(displayObservationTime('2026-10-07T07:03:00Z'), /16:03:00/);
});

test('older reports cannot overwrite a newer observation layer', () => {
  const current = parseJmaQuake(fixture);
  const old = structuredClone(current);
  old.issue.time = '2026-10-07T06:05:47Z';
  assert.equal(acceptsQuakeReport(current, old), false);
  assert.equal(acceptsQuakeReport(old, current), true);
});

test('same-report P2P data cannot erase JMA coordinates or trigger duplicate speech', () => {
  const jma = parseJmaQuake(fixture);
  const p2p = structuredClone(jma);
  p2p.issue.time = '2026/10/07 16:05:47';
  p2p.earthquake.time = '2026/10/07 16:03:00';
  delete p2p.points[0].latitude;
  delete p2p.points[0].longitude;
  assert.equal(acceptsQuakeReport(jma, p2p), false);
  assert.equal(acceptsQuakeReport(p2p, jma), true);
  assert.equal(sameQuakeReport(p2p, jma), true);
  p2p.earthquake.maxScale = 20;
  assert.equal(sameQuakeReport(p2p, jma), false);
});

test('cancelled, training, and incomplete JMA reports are not displayed', () => {
  const cancelled = copy(); cancelled.Head.InfoType = '取消';
  const training = copy(); training.Control.Status = '訓練';
  assert.equal(parseJmaQuake(cancelled), null);
  assert.equal(parseJmaQuake(training), null);
  assert.equal(parseJmaQuake({}), null);
});

test('unknown magnitude and coordinates stay unknown, not zero', () => {
  const document = copy();
  document.Body.Earthquake.Magnitude = '';
  document.Body.Earthquake.Hypocenter.Area.Coordinate = '';
  station(document).Int = '不明';
  const quake = parseJmaQuake(document);
  assert.equal(quake.earthquake.hypocenter.magnitude, -1);
  assert.equal(quake.earthquake.hypocenter.latitude, null);
  assert.equal(quake.points.length, 0);
});

test('feed starts quietly, avoids duplicate downloads, and announces a new report', async () => {
  let list = listing();
  const calls = [], received = [], statuses = [];
  const feed = createObservationFeed({
    fetcher: async (url, options) => {
      calls.push(url);
      assert.equal(options.cache, 'no-store');
      assert.ok(options.signal);
      return response(url.endsWith('list.json') ? list : fixture);
    },
    onData: (data, options) => received.push({ data, options }),
    onStatus: phase => statuses.push(phase)
  });
  await feed.poll();
  await feed.poll();
  assert.equal(received.length, 1);
  assert.equal(received[0].options.silent, true);
  assert.equal(calls.filter(url => !url.endsWith('list.json')).length, 1);
  list = listing('20261007170547_20261007170305_VXSE5k_1.json', '2026-10-07T17:05:00+09:00');
  await feed.poll();
  assert.equal(received[1].options.silent, false);
  assert.equal(statuses.at(-1), 'ready');
});

test('failed downloads retain retry ability without publishing stale success', async () => {
  const statuses = [], received = [];
  let fail = true;
  const feed = createObservationFeed({
    fetcher: async url => url.endsWith('list.json') ? response(listing()) : fail ? { ok: false } : response(fixture),
    onData: (data, options) => received.push(options), onStatus: phase => statuses.push(phase)
  });
  await feed.poll();
  assert.equal(statuses.at(-1), 'error');
  fail = false;
  await feed.poll();
  assert.deepEqual(received, [{ silent: true }]);
  assert.equal(statuses.at(-1), 'ready');
});

test('feed rejects external filenames, cancellations, and irrelevant bulletins', async () => {
  const calls = [], statuses = [];
  const feed = createObservationFeed({
    fetcher: async url => {
      calls.push(url);
      return response([
        ...listing('../secret.json'), ...listing('https://example.com/a.json'),
        { ...listing()[0], ift: '取消' }, { ...listing()[0], ttl: '南海トラフ地震関連解説情報' }
      ]);
    }, onStatus: phase => statuses.push(phase)
  });
  await feed.poll();
  assert.deepEqual(calls, [JMA_QUAKE_BASE + 'list.json']);
  assert.equal(statuses.at(-1), 'empty');
});

test('polling is non-overlapping even while a network request is pending', async () => {
  let release, calls = 0;
  const pending = new Promise(resolve => { release = resolve; });
  const feed = createObservationFeed({ fetcher: async () => { calls++; await pending; return response([]); } });
  const first = feed.poll();
  await feed.poll();
  assert.equal(calls, 1);
  release();
  await first;
});
