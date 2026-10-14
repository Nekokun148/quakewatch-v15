import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { createEEWTracker, eewInfo, meetsAlarmThreshold } from '../js/eew.js';

// Synthetic fixtures only; these are not current observations or forecasts.
const now = Date.parse('2026-10-13T03:00:01+09:00');
const time = new Date(now - 1000).toISOString();
const report = (scale, extra = {}) => ({
  code: 556, source: 'DMDATA', time,
  issue: { eventId: 'TEST-ALARM-THRESHOLD', serial: 1, time },
  earthquake: { originTime: time, maxScale: scale }, areas: [], ...extra
});

test('automatic alarm threshold includes 5-lower and stronger, not weak or unknown intensities', () => {
  for (const scale of [0, 10, 20, 30, 40, -1, 44, 99, null, undefined, '', 'unknown', NaN]) {
    assert.equal(meetsAlarmThreshold(scale), false, String(scale));
  }
  for (const scale of [45, 50, 55, 60, 70, '45']) {
    assert.equal(meetsAlarmThreshold(scale), true, String(scale));
  }
});

test('all EEW providers still accept weak reports without sounding, and sound at 5-lower', () => {
  for (const source of ['YDITS', 'Wolfx', 'DMDATA']) {
    for (const scale of [0, 10, 20, 30, 40, -1, 45, 50, 55, 60, 70]) {
      const received = createEEWTracker()(report(scale, { source }), { now });
      assert.equal(received.accepted, true, `${source}/${scale}`);
      assert.equal(received.info.maxScale, scale, `${source}/${scale}`);
      assert.equal(received.sound, scale >= 45, `${source}/${scale}`);
    }
  }
});

test('crossing from 4 to 5-lower sounds once and duplicate or unchanged reports stay silent', () => {
  const receive = createEEWTracker();
  assert.equal(receive(report(40), { now }).sound, false);
  const stronger = report(45, { issue: { eventId: 'TEST-ALARM-THRESHOLD', serial: 2, time } });
  assert.equal(receive(stronger, { now }).sound, true);
  assert.equal(receive(stronger, { now }).accepted, false);
  assert.equal(receive({ ...stronger, issue: { ...stronger.issue, serial: 3 } }, { now }).sound, false);
  assert.equal(receive(report(55, { issue: { ...stronger.issue, serial: 4 } }), { now }).sound, true);
});

test('warning classification alone cannot override the threshold; regional upper ranges can meet it', () => {
  for (const isWarning of [false, true]) {
    assert.equal(createEEWTracker()(report(40, { isWarning }), { now }).sound, false);
    assert.equal(createEEWTracker()(report(-1, { isWarning }), { now }).sound, false);
    assert.equal(createEEWTracker()(report(45, { isWarning }), { now }).sound, true);
  }
  const received = createEEWTracker()(report(-1, {
    areas: [{ scaleFrom: 40, scaleTo: 45 }]
  }), { now });
  assert.equal(received.info.maxScale, 45); assert.equal(received.sound, true);
  const plum = createEEWTracker()(report(-1, {
    areas: [{ scaleFrom: 45, scaleTo: 99, kindCode: '19' }]
  }), { now });
  assert.equal(plum.info.plum, true); assert.equal(plum.sound, true);
});

test('strong predictions retain silent, training, cancellation and freshness guards', () => {
  for (const [data, options] of [
    [report(45), { now, silent: true }], [report(45, { isTraining: true }), { now }],
    [report(45, { cancelled: true }), { now }], [report(45), { now: now + 120001 }],
    [report(45), { now: now - 12000 }]
  ]) assert.equal(createEEWTracker()(data, options).sound, false);
});

test('intensity-unknown and weak announcement-only notices remain visible without automatic audio', async () => {
  const app = await readFile(new URL('../js/app.js', import.meta.url), 'utf8');
  const handler = app.slice(app.indexOf('function onData('), app.indexOf('function fitJapanView('));
  for (const [scale, elapsed, expected] of [
    [-1, 1000, 0], [40, 1000, 0], [45, 1000, 1], [55, 1000, 1], [45, 180000, 0]
  ]) {
    const alerts = [], toasts = [];
    const context = vm.createContext({ state: { seen: new Set() }, eewInfo, meetsAlarmThreshold,
      quakeReportTime: () => Date.now() - elapsed, showToast: text => toasts.push(text),
      alarmAnnouncer: { announce: (...args) => alerts.push(args) }, updateDiagnostics() {}
    });
    vm.runInContext(handler, context);
    const data = report(scale, { code: 554, id: 'TEST-ANNOUNCEMENT-ONLY' });
    context.onData(data);
    assert.equal(toasts.length, 1); assert.equal(alerts.length, expected);
    if (expected) assert.equal(alerts[0][1].sound, true);
    context.onData(data);
    assert.equal(toasts.length, 1); assert.equal(alerts.length, expected);
  }
  assert.match(app, /自動警報は震度5弱以上/);
  assert.match(app, /if \(await alarm\.enable\(\)\) alarmAnnouncer\.announce\('', \{ sound: true \}\)/);
});
