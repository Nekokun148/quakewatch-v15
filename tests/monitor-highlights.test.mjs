import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { createMonitorHighlights, layoutMonitorHighlights } from '../js/monitor-highlights.js';
import { createMonitorChangeTracker } from '../js/monitor-changes.js';
import { frameColors, UNRECEIVED_COLOR } from '../js/monitor-map.js';

const start = Date.parse('2026-10-19T22:53:00+09:00');
// Test colors and changes only; no measured intensity, earthquake or inferred hypocenter.
const station = (code, pref = '福島県', extra = {}) => ({
  code, pref, name: 'テスト観測点' + code, type: 'land', lat: 37.5, lng: 140, ...extra
});
const project = ([lat, lng]) => ({ x: 200 + (lng - 140) * 20, y: 200 - (lat - 37) * 40 });
const overlaps = (a, b) => a.x < b.x + b.width && a.x + a.width > b.x
  && a.y < b.y + b.height && a.y + a.height > b.y;
class Node {
  constructor() { this.children = []; this.style = {}; this.dataset = {}; this.attributes = {}; this.ownText = ''; }
  set textContent(value) { this.ownText = value; }
  get textContent() { return this.ownText + this.children.map(child => child.textContent).join(''); }
  append(...nodes) { this.children.push(...nodes); }
  appendChild(node) { this.append(node); return node; }
  replaceChildren(...nodes) { this.children = nodes; }
  setAttribute(key, value) { this.attributes[key] = value; }
  getAttribute(key) { return this.attributes[key] ?? null; }
  remove() { this.removed = true; }
}
function harness() {
  let time = start, id = 0;
  const timers = new Map(), events = new Map(), mapEvents = new Map(), groups = [], panes = new Map();
  const container = new Node();
  const document = { hidden: false, createElement: () => new Node(),
    addEventListener: (name, fn) => events.set(name, fn),
    removeEventListener: name => events.delete(name) };
  const environment = {
    setTimeout(fn, delay) { timers.set(++id, { fn, at: time + delay }); return id; },
    clearTimeout: key => timers.delete(key),
    addEventListener: (name, fn) => events.set(name, fn), removeEventListener: name => events.delete(name)
  };
  const map = { getPane: name => panes.get(name), createPane: name => { const node = new Node(); panes.set(name, node); return node; },
    getContainer: () => container, getSize: () => ({ x: 600, y: 500 }), latLngToContainerPoint: project,
    on: (name, fn) => mapEvents.set(name, fn), off: name => mapEvents.delete(name) };
  const L = {
    layerGroup() { const group = { layers: [], addTo() { groups.push(this); return this; },
      clearLayers() { this.layers = []; }, remove() { this.removed = true; } }; return group; },
    circleMarker(position, options) { return { position, options, addTo(group) { group.layers.push(this); return this; } }; }
  };
  const view = createMonitorHighlights({ map, L, document, environment, now: () => time });
  return { view, document, environment, events, mapEvents, timers, container, map, L, now: () => time, rings: groups[0], labels: container.children[0],
    result: (codes = ['A'], extra = {}) => ({ phase: 'changed', codes, observedAt: new Date(time).toISOString(), ...extra }),
    stations: new Map(['A', 'B', 'C'].map(code => [code, { station: station(code) }])),
    advance(ms) {
      const end = time + ms;
      for (;;) {
        const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
        if (!next || next[1].at > end) break;
        time = next[1].at; timers.delete(next[0]); next[1].fn();
      }
      time = end;
    }
  };
}

test('labels use real station anchors and names, excluding unknown, sea and offscreen stations', () => {
  const points = [station('A'), station('B'), station('C', '宮城県'),
    station('sea', '海底', { type: 'sea' }), station('bad', '不正', { lat: NaN }),
    station('outside', '範囲外', { lng: 170 })];
  const boxes = layoutMonitorHighlights(points, { x: 600, y: 500 }, project);
  assert.equal(boxes.length, 2);
  const fukushima = boxes.find(box => box.region === '福島県');
  assert.equal(fukushima.count, 2);
  assert.ok(points.includes(fukushima.station));
  for (const box of boxes) {
    assert.equal(box.station.lat, 37.5); assert.equal(box.station.lng, 140);
    assert.equal(box.station.magnitude, undefined); assert.equal(box.station.depth, undefined);
  }
});

test('dense region labels do not overlap or leave desktop, phone and tablet map bounds', () => {
  const points = Array.from({ length: 12 }, (_, index) => station('S' + index, '地域' + index));
  for (const size of [{ x: 1200, y: 700 }, { x: 768, y: 620 }, { x: 300, y: 360 }]) {
    const boxes = layoutMonitorHighlights(points, size, () => ({ x: size.x / 2, y: size.y / 2 }));
    assert.ok(boxes.length >= 1 && boxes.length <= 3);
    for (const box of boxes) {
      assert.ok(box.x >= 0 && box.y >= 0 && box.x + box.width <= size.x - 72 && box.y + box.height <= size.y - 50);
      for (const other of boxes) if (box !== other) assert.equal(overlaps(box, other), false);
    }
  }
  assert.deepEqual(layoutMonitorHighlights(points, { x: 200, y: 150 }, project), []);
});

test('baseline is silent and empty, then changed verified station coordinates get small unfilled rings', () => {
  const h = harness();
  h.view.update(h.result([], { phase: 'baseline' }), h.stations);
  assert.equal(h.rings.layers.length, 0);
  h.advance(1000); h.view.update(h.result(['A', 'A', 'missing']), h.stations);
  assert.equal(h.rings.layers.length, 1);
  const ring = h.rings.layers[0];
  assert.deepEqual(ring.position, [37.5, 140]);
  assert.equal(ring.options.radius, 6); assert.equal(ring.options.fill, false);
  assert.equal(ring.options.interactive, false);
  assert.equal(h.labels.dataset.activeCount, '1');
  assert.match(h.labels.textContent, /福島県.*テスト観測点A.*1地点の画像色変化.*地震・震源未確定/);
  assert.equal(h.stations.get('A').station.color, undefined);
  h.view.destroy();
});

test('station labels are literal safe text, never HTML or estimated measurements', () => {
  const h = harness();
  h.stations.set('A', { station: station('A', '<script>bad</script>', { name: '<img onerror=bad>', magnitude: 7, depth: 10 }) });
  h.view.update(h.result(), h.stations);
  assert.match(h.labels.textContent, /<script>bad<\/script> <img onerror=bad>/);
  assert.equal(h.labels.children[0].children.length, 3);
  assert.doesNotMatch(h.labels.textContent, /M7|10km|震度/);
  h.view.destroy();
});

test('unchanged and replayed frames cannot extend a highlight beyond its observation age', () => {
  const h = harness(), result = h.result();
  h.view.update(result, h.stations);
  h.advance(4000);
  h.view.update(result, h.stations);
  h.view.update(h.result([], { phase: 'unchanged' }), h.stations);
  h.advance(1000);
  assert.equal(h.rings.layers.length, 0); assert.equal(h.labels.children.length, 0);
  assert.equal(h.timers.size, 0);
  h.view.destroy();
});

test('new changes keep their own expiry without retaining unrelated old stations', () => {
  const h = harness();
  h.view.update(h.result(['A']), h.stations); h.advance(1000);
  h.view.update(h.result(['B']), h.stations); assert.equal(h.rings.layers.length, 2);
  h.advance(4000); assert.equal(h.rings.layers.length, 1);
  assert.match(h.labels.textContent, /テスト観測点B/);
  h.advance(1000); assert.equal(h.rings.layers.length, 0);
  h.view.destroy();
});

test('delays, reset, baseline, hidden document and future or stale frames clear highlights immediately', () => {
  for (const mode of ['delayed', 'baseline', 'clear', 'hidden', 'future', 'stale']) {
    const h = harness(); h.view.update(h.result(), h.stations);
    if (mode === 'clear') h.view.clear();
    else if (mode === 'hidden') { h.document.hidden = true; h.events.get('visibilitychange')(); }
    else if (['future', 'stale'].includes(mode)) {
      h.view.update(h.result(['B'], { observedAt: new Date(start + (mode === 'future' ? 1001 : -5001)).toISOString() }), h.stations);
    } else h.view.update(h.result([], { phase: mode }), h.stations);
    assert.equal(h.rings.layers.length, 0); assert.equal(h.labels.children.length, 0);
    assert.equal(h.timers.size, 0); h.view.destroy();
  }
});

test('map motion relayout uses current map size and destroy removes event handlers, rings and timers', () => {
  const h = harness(); h.view.update(h.result(), h.stations);
  h.mapEvents.get('move zoom resize')();
  assert.equal(h.labels.children.length, 1);
  h.events.get('pagehide')(); assert.equal(h.labels.children.length, 0);
  h.view.update(h.result(), h.stations);
  h.view.destroy(); h.view.destroy();
  h.view.update(h.result(), h.stations);
  assert.equal(h.mapEvents.size, 0); assert.equal(h.events.size, 0);
  assert.equal(h.timers.size, 0); assert.equal(h.rings.removed, true); assert.equal(h.labels.removed, true);
  assert.equal(h.rings.layers.length, 0);
});

test('image-color comparison stays in the sidebar and cannot trigger the earthquake map highlight', async () => {
  const source = await readFile(new URL('../js/app.js', import.meta.url), 'utf8');
  const render = source.slice(source.indexOf('function renderMonitorChanges('), source.indexOf('const strongMotion ='));
  let forwarded;
  const elements = new Map(), stations = new Map([['A', { station: station('A') }]]);
  const context = vm.createContext({ state: {}, window: {}, stationCircles: stations,
    monitorHighlights: { update: (...args) => { forwarded = args; } },
    document: { body: { dataset: {} }, createElement: () => new Node() },
    $: id => { if (!elements.has(id)) elements.set(id, new Node()); return elements.get(id); } });
  vm.runInContext(render, context);
  const result = { phase: 'changed', codes: ['A'], observedAt: new Date(start).toISOString() };
  context.result = result; vm.runInContext('renderMonitorChanges(result)', context);
  assert.equal(forwarded, undefined);
  assert.match(elements.get('monitorChangedStations').textContent, /画像色の変化/);
  assert.doesNotMatch(render, /createMonitorHighlights|quakeHighlight/);
  assert.doesNotMatch(render, /startWaveAnimation|alarm|speech\.say|onData\(/);
});

test('map highlight module is a public static asset, not a new data feed or earthquake estimator', async () => {
  const [source, sw, build] = await Promise.all(['../js/monitor-highlights.js', '../sw.js', '../scripts/build.mjs']
    .map(path => readFile(new URL(path, import.meta.url), 'utf8')));
  assert.match(sw, /\.\/js\/monitor-highlights\.js/);
  assert.match(build, /'js\/monitor-highlights\.js'/);
  assert.doesNotMatch(source, /fetch\(|WebSocket|speechSynthesis|localStorage|sessionStorage|magnitude:|depth:|onData\(/);
});

test('production image reception updates colors but does not display an earthquake label', async () => {
  const source = await readFile(new URL('../js/app.js', import.meta.url), 'utf8');
  const pipeline = source.slice(source.indexOf('let monitorFrames = 0;'), source.indexOf('let monitorMetric;'));
  const h = harness(), elements = new Map(), styles = [];
  const stations = new Map([...h.stations].map(([code, entry]) => [code, {
    ...entry, layer: { setStyle: style => styles.push(style) }
  }]));
  const document = h.document;
  document.body = { dataset: {} };
  const createNode = document.createElement;
  document.createElement = tag => {
    if (tag !== 'canvas') return createNode();
    let pixels;
    return { width: 0, height: 0, getContext() { return {
      drawImage(image) { pixels = image.pixels; },
      getImageData() { return { width: 352, height: 400, data: pixels }; }
    }; } };
  };
  let callbacks, created = 0;
  const context = vm.createContext({
    document, window: { L: h.L }, state: { leafletMap: h.map },
    createMonitorChangeTracker: () => createMonitorChangeTracker({ now: h.now }),
    createMonitorHighlights(options) {
      assert.equal(options.map, h.map); assert.equal(options.document, document);
      created++; return h.view;
    },
    createStrongMotionController(options) { callbacks = options; return { asset: kind => 'test/' + kind }; },
    monitorMappingReady: Promise.resolve(true), monitorPoints: [{ code: 'A', x: 1, y: 1 }],
    monitorMetric: 'intensity', monitorObservation: null, stationCircles: stations, frameColors, UNRECEIVED_COLOR,
    displayObservationTime: value => value,
    $: id => { if (!elements.has(id)) elements.set(id, new Node()); return elements.get(id); }
  });
  vm.runInContext(pipeline, context);
  const receive = async green => {
    const pixels = new Uint8ClampedArray(352 * 400 * 4);
    pixels.set(green ? [0, 255, 0, 255] : [0, 0, 255, 255], (352 + 1) * 4);
    await callbacks.onFrame({ metric: 'intensity', observedAt: new Date(h.now()).toISOString(),
      image: { naturalWidth: 352, naturalHeight: 400, pixels } });
  };
  await receive(false);
  assert.equal(created, 0); assert.equal(h.rings.layers.length, 0);
  h.advance(1000); await receive(true);
  assert.equal(created, 0); assert.equal(h.rings.layers.length, 0);
  assert.equal(h.labels.textContent, '');
  assert.equal(document.body.dataset.qwMonitorChanges, '1');
  assert.equal(document.body.dataset.qwMonitorFrames, '2');
  assert.equal(document.body.dataset.qwLiveStations, '1');
  assert.equal(styles.at(-1).fillColor, '#00ff00');
  callbacks.onStatus('error', 'test reception failure');
  assert.equal(h.rings.layers.length, 0); assert.equal(h.labels.children.length, 0);
  assert.equal(document.body.dataset.qwMonitorChanges, '0');
  h.advance(1000); await receive(false);
  assert.equal(h.rings.layers.length, 0);
  h.advance(1000); await receive(true);
  assert.equal(h.rings.layers.length, 0);
  h.view.destroy(); assert.equal(h.timers.size, 0);
});


