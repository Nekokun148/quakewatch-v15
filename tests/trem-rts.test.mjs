import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { createTremFeed, parseTremStations, parseTremFrame, decodeTremEvent, TREM_STATIONS, TREM_STREAM } from '../js/trem-rts.js';

const csv = 'loc_code,id,lat,lon,floor,code,net,time,work\n1,A1,23,121,1,123,3,2026-01-01,1\n1,B2,24,120,1,123,3,2026-01-01,0';
const now = Date.parse('2026-11-19T12:00:00+09:00');
const frame = (time = now) => ({ ts: time, stations: { A1: { i: 1.2, pga: 4.3 } }, eq: [] });
const flush = () => new Promise(resolve => setImmediate(resolve));

test('RTS preserves Taiwan values and only joins active, identified stations with verified coordinates', () => {
  const stations = parseTremStations(csv);
  assert.equal(stations.size, 1);
  const data = frame();
  data.stations.B2 = { i: 5 };
  data.stations.UNKNOWN = { i: 6 };
  const parsed = parseTremFrame(data, stations, now);
  assert.equal(parsed.points.length, 1);
  assert.equal(parsed.points[0].intensity, 1.2);
  assert.equal(parsed.points[0].latitude, 23);
  assert.equal(parsed.points[0].pga, 4.3);
  assert.deepEqual(Object.keys(parsed).sort(), ['points', 'time']);
  assert.throws(() => parseTremFrame(frame(now - 15001), stations, now));
  assert.throws(() => parseTremFrame(frame(now + 5001), stations, now));
  assert.throws(() => parseTremStations('<html>error</html>'));
});

test('gzip SSE data is decoded with bounded and validated input', async () => {
  const encoded = gzipSync(JSON.stringify(frame())).toString('base64');
  assert.deepEqual(await decodeTremEvent(encoded), frame());
  await assert.rejects(decodeTremEvent('not!base64'));
  await assert.rejects(decodeTremEvent(gzipSync('x'.repeat(2000001)).toString('base64')));
});

function harness(decode = async () => frame()) {
  const sources = [], requests = [], frames = [], statuses = [], timers = new Map();
  let timerId = 0;
  class EventSource {
    listeners = new Map();
    closed = false;
    constructor(url, options) {
      assert.equal(url, TREM_STREAM);
      assert.equal(options.withCredentials, false);
      sources.push(this);
    }
    addEventListener(type, callback) { this.listeners.set(type, callback); }
    close() { this.closed = true; }
    async emit(type, data) { await this.listeners.get(type)?.({ data }); }
  }
  const environment = {
    Date: { now: () => now }, document: { hidden: false },
    EventSource, DecompressionStream,
    setTimeout(fn, ms) { timers.set(++timerId, { fn, ms }); return timerId; },
    clearTimeout(id) { timers.delete(id); },
    setInterval(fn, ms) { timers.set(++timerId, { fn, ms }); return timerId; },
    clearInterval(id) { timers.delete(id); }
  };
  const feed = createTremFeed({
    environment, decode,
    fetcher: async (url, options) => {
      requests.push({ url, options });
      return new Response(csv);
    },
    onFrame: data => frames.push(data), onStatus: data => statuses.push(data)
  });
  return { feed, environment, sources, requests, frames, statuses, timers };
}

test('RTS opens only after ON, renders a fresh frame and closes all activity on OFF', async () => {
  const h = harness();
  assert.equal(h.requests.length, 0);
  h.feed.start();
  h.feed.start();
  await flush();
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].url, TREM_STATIONS);
  assert.equal(h.requests[0].options.credentials, 'omit');
  assert.equal(h.sources.length, 1);
  await h.sources[0].emit('trem.rts.v1', 'mock');
  assert.equal(h.statuses.at(-1).phase, 'live');
  assert.equal(h.frames.at(-1).points.length, 1);
  h.feed.stop();
  assert.equal(h.sources[0].closed, true);
  assert.equal(h.frames.at(-1), null);
  assert.equal(h.timers.size, 0);
  await h.sources[0].emit('trem.rts.v1', 'late');
  assert.equal(h.frames.at(-1), null);
});

test('late decompression cannot repopulate observations after OFF or a new permission session', async () => {
  let release;
  const h = harness(() => new Promise(resolve => { release = resolve; }));
  h.feed.start();
  await flush();
  const receiving = h.sources[0].emit('trem.rts.v1', 'mock');
  h.feed.stop();
  h.feed.start();
  await flush();
  release(frame());
  await receiving;
  assert.equal(h.frames.at(-1), null);
  assert.notEqual(h.statuses.at(-1).phase, 'live');
  h.feed.stop();
});

test('RTS errors back off and hidden tabs close the stream until visible', async () => {
  const h = harness();
  h.feed.start();
  await flush();
  h.sources[0].onerror();
  assert.equal(h.sources[0].closed, true);
  assert.equal(h.statuses.at(-1).phase, 'error');
  assert.equal([...h.timers.values()].filter(timer => timer.ms === 30000).length, 1);
  h.feed.stop();
  h.feed.start();
  await flush();
  h.environment.document.hidden = true;
  h.feed.visibilityChanged();
  assert.equal(h.sources.at(-1).closed, true);
  assert.equal(h.timers.size, 0);
  h.environment.document.hidden = false;
  h.feed.visibilityChanged();
  await flush();
  assert.equal(h.sources.at(-1).closed, false);
  h.feed.stop();
});
