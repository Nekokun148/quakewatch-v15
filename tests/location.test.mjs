import test from 'node:test';
import assert from 'node:assert/strict';
import { createLocationController } from '../js/location.js';
import { SEAFLOOR_STATIONS } from '../js/seafloor-stations.js';

function harness() {
  const requests = [];
  const cleared = [];
  const positions = [];
  const statuses = [];
  const geo = {
    watchPosition(success, failure, options) { requests.push({ success, failure, options }); return requests.length; },
    clearWatch(id) { cleared.push(id); }
  };
  const controller = createLocationController({
    environment: { navigator: { geolocation: geo } },
    onStatus: value => statuses.push(value),
    onPosition: value => positions.push(value)
  });
  return { controller, requests, cleared, positions, status: () => statuses.at(-1) };
}

test('location starts when requested and renders an authorized position', () => {
  const h = harness();
  assert.equal(h.controller.start(), true);
  assert.equal(h.status().phase, 'requesting');
  assert.equal(h.status().enabled, true);
  assert.equal(h.requests[0].options.enableHighAccuracy, false);
  h.requests[0].success({ coords: { latitude: 35, longitude: 139, accuracy: 12 } });
  assert.deepEqual(h.positions, [{ lat: 35, lng: 139, accuracy: 12 }]);
  assert.equal(h.status().phase, 'ready');
});

test('location OFF clears the watch and ignores late callbacks', () => {
  const h = harness();
  h.controller.start();
  h.controller.stop();
  h.requests[0].success({ coords: { latitude: 35, longitude: 139, accuracy: 12 } });
  assert.deepEqual(h.cleared, [1]);
  assert.equal(h.positions.length, 0);
  assert.equal(h.status().phase, 'off');
});

test('denied permission is respected without a retry loop', () => {
  const h = harness();
  h.controller.start();
  h.requests[0].failure({ code: 1 });
  assert.equal(h.status().phase, 'denied');
  assert.equal(h.status().enabled, false);
  assert.deepEqual(h.cleared, [1]);
  assert.equal(h.requests.length, 1);
});

test('unavailable locations remain visibly unresolved and can recover', () => {
  const h = harness();
  h.controller.start();
  h.requests[0].failure({ code: 3 });
  assert.equal(h.status().phase, 'unavailable');
  assert.equal(h.positions.length, 0);
  h.requests[0].success({ coords: { latitude: 35, longitude: 139, accuracy: 100 } });
  assert.equal(h.status().phase, 'ready');
});

test('invalid coordinates are not placed on the map', () => {
  const h = harness();
  h.controller.start();
  h.requests[0].success({ coords: { latitude: 100, longitude: 139, accuracy: 100 } });
  assert.equal(h.positions.length, 0);
});

test('no geolocation support is represented accurately', () => {
  let status;
  const c = createLocationController({ environment: {}, onStatus: s => { status = s; } });
  assert.equal(c.start(), false);
  assert.equal(status.phase, 'unsupported');
});

test('seafloor data contains real coordinates and all 150 S-net stations', () => {
  assert.equal(SEAFLOOR_STATIONS.length, 243);
  assert.equal(SEAFLOOR_STATIONS.filter(s => s.network === 'S-net').length, 150);
  assert.equal(new Set(SEAFLOOR_STATIONS.map(s => s.code)).size, 243);
  const first = SEAFLOOR_STATIONS.find(s => s.code === 'N.S1N01');
  assert.equal(first.lat, 35.8968);
  assert.equal(first.lng, 141.0535);
  assert.ok(SEAFLOOR_STATIONS.some(s => s.code === 'N.S2N13A'));
  assert.ok(SEAFLOOR_STATIONS.every(s => s.type === 'sea' && s.lat > 24 && s.lat < 47 && s.lng > 122 && s.lng < 153));
});
