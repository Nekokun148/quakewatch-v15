import test from 'node:test';
import assert from 'node:assert/strict';
import { animateWaves, waveDistances, WAVE_LIFETIME } from '../js/waves.js';

test('fractional seconds grow both radii smoothly and cannot create negative radii', () => {
  assert.deepEqual(waveDistances(1000, 1016), { age: 16, p: 96, s: 56 });
  assert.deepEqual(waveDistances(1000, 1032), { age: 32, p: 192, s: 112 });
  assert.deepEqual(waveDistances(1000, 900), { age: 0, p: 0, s: 0 });
});
test('animation uses absolute time after background pauses and stops cleanly', () => {
  let now = 1000, callback, finished = 0, cancelled = 0;
  const updates = [];
  const environment = { Date: { now: () => now }, requestAnimationFrame(fn) { callback = fn; return 1; }, cancelAnimationFrame() { cancelled++; } };
  const stop = animateWaves({ origin: 1000, environment, update: value => updates.push(value), finish: () => finished++ });
  now = 1016; callback();
  now = 20000; callback();
  assert.equal(updates.at(-1).p, 114000);
  stop(); stop(); callback();
  assert.equal(updates.length, 3);
  assert.equal(finished, 1); assert.equal(cancelled, 1);
});
test('expired waves are removed and no animation frame remains scheduled', () => {
  let scheduled = 0, finished = 0;
  animateWaves({ origin: 0, environment: { Date: { now: () => WAVE_LIFETIME }, requestAnimationFrame() { scheduled++; }, cancelAnimationFrame() {} },
    update: () => assert.fail('Expired wave'), finish: () => finished++ });
  assert.equal(scheduled, 0); assert.equal(finished, 1);
});
