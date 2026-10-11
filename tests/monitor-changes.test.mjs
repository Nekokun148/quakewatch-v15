import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createMonitorChangeTracker } from '../js/monitor-changes.js';

const initial = Date.parse('2026-10-10T01:15:00+09:00');
function harness() {
  let time = initial;
  const tracker = createMonitorChangeTracker({ now: () => time });
  return { tracker, advance: ms => { time += ms; },
    frame: (colors, extra = {}) => ({ colors: new Map(colors), metric: 'intensity', observedAt: new Date(time).toISOString(), ...extra }) };
}

test('first frame is a baseline, identical colors and casing changes are not detections', () => {
  const h = harness();
  assert.equal(h.tracker.receive(h.frame([['A', '#AABBCC']])).phase, 'baseline');
  h.advance(1000); const same = h.tracker.receive(h.frame([['A', '#aabbcc']]));
  assert.equal(same.phase, 'unchanged'); assert.deepEqual(same.codes, []);
  h.advance(1000); assert.deepEqual(h.tracker.receive(h.frame([['A', '#abcdef']])).codes, ['A']);
});

test('new, missing, invalid or unreceived points cannot masquerade as image-color changes', () => {
  const h = harness(); h.tracker.receive(h.frame([['A', '#0000ff'], ['B', null], ['D', '#0000ff']]));
  h.advance(1000);
  const result = h.tracker.receive(h.frame([['A', '#00ff00'], ['B', '#0000ff'], ['C', '#0000ff'], ['E', 'NaN']]));
  assert.deepEqual(result.codes, ['A']); assert.equal(result.intensity, undefined);
  assert.equal(result.earthquake, undefined); assert.equal(result.latitude, undefined);
});

test('input mutation does not change the comparison baseline', () => {
  const h = harness(), frame = h.frame([['A', '#0000ff']]); h.tracker.receive(frame);
  frame.colors.set('A', '#00ff00'); h.advance(1000);
  assert.deepEqual(h.tracker.receive(h.frame([['A', '#0000ff']])).codes, []);
});

test('metric change, reset and long gaps require a new baseline', () => {
  const h = harness(); h.tracker.receive(h.frame([['A', '#0000ff']])); h.advance(1000);
  assert.equal(h.tracker.receive(h.frame([['A', '#00ff00']], { metric: 'acceleration' })).phase, 'baseline');
  h.advance(1000); h.tracker.reset();
  assert.equal(h.tracker.receive(h.frame([['A', '#ff0000']])).phase, 'baseline');
  h.advance(6000); assert.equal(h.tracker.receive(h.frame([['A', '#00ff00']])).phase, 'baseline');
});

test('duplicates and out-of-order frames neither detect changes nor overwrite the baseline', () => {
  const h = harness(), frame = h.frame([['A', '#0000ff']]); h.tracker.receive(frame);
  assert.deepEqual(h.tracker.receive({ ...frame, colors: new Map([['A', '#ff0000']]) }).codes, []);
  h.advance(1000); assert.deepEqual(h.tracker.receive(h.frame([['A', '#0000ff']])).codes, []);
});

test('stale or future frames are explicitly delayed and do not leak previous changes', () => {
  for (const offset of [-5001, 1001]) {
    const h = harness(); h.tracker.receive(h.frame([['A', '#0000ff']]));
    const result = h.tracker.receive(h.frame([['A', '#ff0000']], { observedAt: new Date(initial + offset).toISOString() }));
    assert.equal(result.phase, 'delayed'); assert.deepEqual(result.codes, []);
    assert.equal(h.tracker.receive(h.frame([['A', '#ff0000']])).phase, 'baseline');
  }
});

test('invalid comparison inputs fail explicitly instead of fabricating observations', () => {
  const h = harness();
  for (const extra of [{ metric: 'gal' }, { colors: [] }, { observedAt: 'invalid' }]) {
    assert.throws(() => h.tracker.receive(h.frame([], extra)), /Invalid/);
  }
});

test('change display is separate, non-alerting and uses actual station names with safe text rendering', async () => {
  const app = await readFile(new URL('../js/app.js', import.meta.url), 'utf8');
  const render = app.slice(app.indexOf('function renderMonitorChanges('), app.indexOf('const strongMotion ='));
  assert.match(render, /地震・震源未確定/); assert.match(render, /stationCircles\.get\(code\)/);
  assert.match(render, /row\.textContent/); assert.doesNotMatch(render, /innerHTML|startWaveAnimation|alarm|speech\.say|onData\(/);
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(html, /id="monitorChangeStatus"/); assert.match(html, /id="monitorChangedStations"/);
});
