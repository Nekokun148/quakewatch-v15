import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createTaiwanFeed, parseTaiwanRss, TAIWAN_INTERVAL } from '../js/taiwan-feed.js';
import { mountTaiwan } from '../js/taiwan-ui.js';
import { createTaiwanRssRelay, CWA_RSS_SOURCE } from '../workers/taiwan-rss.mjs';
import { createStrongMotionWorker } from '../workers/strong-motion.mjs';

const XML = '<?xml version="1.0"?><rss version="2.0"><channel><title>TEST ONLY RSS</title></channel></rss>';
const headline = '【表示テスト】地震報告（実際の地震ではありません）';
const entry = { title: headline, link: 'https://www.cwa.gov.tw/V8/C/E/index.html' };
const response = (body = XML, status = 200, headers = {}) => new Response(body, { status, headers: { 'Content-Type': 'application/xml', ...headers } });
const flush = () => new Promise(resolve => setImmediate(resolve));

function harness(fetcher = async () => response(), parse = () => [entry]) {
  let clock = 100000;
  const timers = new Map(), calls = [], items = [], states = [];
  let id = 0;
  const environment = {
    location: { href: 'http://localhost/quakewatch-v15/' }, document: { hidden: false },
    Date: { now: () => clock }, setTimeout(fn, ms) { timers.set(++id, { fn, ms }); return id; },
    clearTimeout(key) { timers.delete(key); }
  };
  Object.defineProperty(environment, 'localStorage', { get() { assert.fail('Consent must not be restored from storage'); } });
  const feed = createTaiwanFeed({ apiBase: 'api/strong-motion/', environment, parse,
    fetcher: async (...args) => { calls.push(args); return fetcher(...args); },
    onItems: value => items.push(value), onStatus: value => states.push(value) });
  return { feed, environment, calls, items, states, timers,
    async run(ms) {
      const [key, task] = [...timers].find(([, value]) => value.ms === ms) || [];
      assert.ok(task, 'Expected scheduled timer: ' + ms);
      timers.delete(key); clock += ms; task.fn(); await flush();
    }
  };
}

test('Taiwan receiving is opt-in, never loads keys/storage, and requests only its fixed relay after start', async () => {
  const h = harness();
  await h.feed.tick();
  assert.equal(h.calls.length, 0);
  h.feed.start(); h.feed.start(); await flush();
  assert.equal(h.calls.length, 1); assert.equal(TAIWAN_INTERVAL, 60000);
  const [url, options] = h.calls[0];
  assert.equal(url, 'http://localhost/quakewatch-v15/api/strong-motion/taiwan');
  assert.equal(options.credentials, 'omit'); assert.equal(options.redirect, 'error'); assert.equal(options.cache, 'no-store');
  assert.ok(!Object.hasOwn(options.headers, 'Authorization'));
  assert.deepEqual(h.items.at(-1), [entry]); assert.equal(h.states.at(-1).phase, 'ready');
  await h.run(60000); assert.equal(h.calls.length, 2);
  h.feed.stop(); await h.feed.tick();
  assert.equal(h.calls.length, 2); assert.equal(h.states.at(-1).enabled, false);
  assert.deepEqual(h.items.at(-1), []); assert.equal(h.timers.size, 0);
});

test('OFF aborts in-flight Taiwan requests and a late old response cannot overwrite a new permission session', async () => {
  let release, count = 0;
  const h = harness(() => ++count === 1 ? new Promise(resolve => { release = resolve; }) : response());
  h.feed.start(); await h.feed.tick();
  assert.equal(h.calls.length, 1);
  h.feed.stop(); assert.equal(h.calls[0][1].signal.aborted, true);
  h.feed.start(); await flush();
  release(response()); await flush();
  assert.equal(h.items.filter(value => value.length).length, 1);
  assert.equal(h.states.at(-1).phase, 'ready'); h.feed.stop();
});

test('hidden tabs do not fetch or catch up in bursts; a visible tab can resume', async () => {
  const h = harness();
  h.environment.document.hidden = true;
  h.feed.start(); await flush(); assert.equal(h.calls.length, 0);
  h.environment.document.hidden = false; await h.feed.tick();
  assert.equal(h.calls.length, 1);
  h.environment.document.hidden = true; await h.run(60000);
  assert.equal(h.calls.length, 1);
  h.environment.document.hidden = false; await h.feed.tick();
  assert.equal(h.calls.length, 2); h.feed.stop();
});

test('Taiwan failures back off, respect Retry-After, and do not invent a successful empty feed', async () => {
  const h = harness(async () => response('limit', 429, { 'Retry-After': '180' }));
  h.feed.start(); await flush();
  assert.equal(h.states.at(-1).phase, 'error'); assert.deepEqual(h.items.at(-1), []);
  await h.feed.tick(); assert.equal(h.calls.length, 1);
  await h.run(180000); assert.equal(h.calls.length, 2);
  h.feed.stop();
  const missing = harness(async () => response('missing', 404));
  missing.feed.start(); await flush();
  assert.equal(missing.states.at(-1).enabled, false); assert.equal(missing.states.at(-1).phase, 'unavailable');
  assert.equal(missing.timers.size, 0); missing.feed.stop();
});

test('timeout releases a stalled request and OFF prevents any scheduled retry', async () => {
  const h = harness(() => new Promise(() => {}));
  h.feed.start(); await h.run(8000);
  assert.equal(h.states.at(-1).phase, 'error'); assert.equal(h.calls[0][1].signal.aborted, true);
  h.feed.stop(); assert.equal(h.timers.size, 0);
});

test('HTML, oversized XML and parse failures do not become Taiwan earthquake reports', async () => {
  for (const make of [
    () => response('<html>bad</html>', 200, { 'Content-Type': 'text/html' }),
    () => response('x'.repeat(262145)),
    () => response(XML, 200, { 'Content-Length': '262145' })
  ]) {
    const h = harness(async () => make());
    h.feed.start(); await flush();
    assert.equal(h.states.at(-1).phase, 'error'); assert.deepEqual(h.items.at(-1), []); h.feed.stop();
  }
  const h = harness(async () => response(), () => { throw new Error('Malformed XML'); });
  h.feed.start(); await flush(); assert.equal(h.states.at(-1).phase, 'error'); h.feed.stop();
});

function xmlElement(localName, textContent = '', children = []) { return { localName, textContent, children }; }
function item(title, link = entry.link) { return xmlElement('item', '', [xmlElement('title', title), xmlElement('link', link)]); }
function parserFor(items, { rootName = 'rss', parserError = false, noChannel = false } = {}) {
  return class {
    parseFromString(text, type) {
      assert.equal(type, 'application/xml'); assert.equal(text, XML);
      return { documentElement: xmlElement(rootName, '', noChannel ? [] : [xmlElement('channel', '', items)]),
        getElementsByTagName: name => name === 'parsererror' && parserError ? [{}] : [] };
    }
  };
}

test('oversized declared bodies are canceled before consuming any source or browser bytes', async () => {
  let canceled = 0, pulls = 0;
  const oversized = () => new Response(new ReadableStream({
    pull() { pulls++; }, cancel() { canceled++; }
  }, { highWaterMark: 0 }), { headers: { 'Content-Type': 'application/xml', 'Content-Length': '262145' } });
  const h = harness(async () => oversized());
  h.feed.start(); await flush(); h.feed.stop();
  const relay = createTaiwanRssRelay({ fetcher: async () => oversized() });
  await assert.rejects(relay.read('https://relay.test'));
  assert.equal(canceled, 2); assert.equal(pulls, 0);
});

test('RSS normalization exposes original earthquake headlines and official links only, never derived coordinates or intensities', () => {
  const Parser = parserFor([
    item(headline), item('大雨特報'), item(headline),
    item('地震<script>not HTML</script>', 'https://scweb.cwa.gov.tw/zh-tw/earthquake/details/test'),
    item('地震 不明リンク', 'https://example.test/'), item('地震 不明リンク', 'javascript:alert(1)'),
    item('地震 不明リンク', 'https://user:password@www.cwa.gov.tw/V8/C/E/index.html'),
    item('地震 不明リンク', 'https://www.cwa.gov.tw/other'), item('地震 不明リンク', 'http://www.cwa.gov.tw/V8/C/E/index.html')
  ]);
  const parsed = parseTaiwanRss(XML, Parser);
  assert.equal(parsed.length, 2); assert.equal(parsed[0].title, headline);
  assert.deepEqual(Object.keys(parsed[0]), ['title', 'link']);
  assert.equal(parsed[1].title, '地震<script>not HTML</script>');
});

test('RSS normalization rejects entity declarations, parser errors, foreign roots and missing channels; lists are bounded', () => {
  for (const options of [{ parserError: true }, { rootName: 'html' }, { noChannel: true }]) {
    assert.throws(() => parseTaiwanRss(XML, parserFor([], options)));
  }
  assert.throws(() => parseTaiwanRss('<!DOCTYPE rss>' + XML, parserFor([])));
  assert.throws(() => parseTaiwanRss('<!ENTITY test "x">' + XML, parserFor([])));
  assert.throws(() => parseTaiwanRss('x'.repeat(262145), parserFor([])));
  const items = Array.from({ length: 30 }, (_, i) => item(headline, entry.link + '?report=' + i));
  assert.equal(parseTaiwanRss(XML, parserFor(items)).length, 20);
  assert.deepEqual(parseTaiwanRss(XML, parserFor([])), []);
});

function uiHarness() {
  const nodes = new Map(), handlers = new Map(), received = [], counts = { start: 0, stop: 0, tick: 0 };
  let options;
  function element() {
    return { checked: false, dataset: {}, textContent: '', children: [], handlers: new Map(),
      addEventListener(name, fn) { this.handlers.set(name, fn); },
      replaceChildren(...items) { this.children = items; }, append(node) { this.children.push(node); } };
  }
  for (const id of ['taiwanReports', 'taiwanConsent', 'taiwanStatus', 'taiwanItems']) nodes.set(id, element());
  const environment = { document: {
    getElementById: id => nodes.get(id), createElement: () => element(),
    addEventListener(name, fn) { handlers.set(name, fn); }
  }, addEventListener(name, fn) { handlers.set(name, fn); } };
  Object.defineProperty(environment, 'localStorage', { get() { assert.fail('Consent persistence is forbidden'); } });
  const feed = { start() { counts.start++; }, stop() { counts.stop++; options.onItems([]); options.onStatus({ enabled: false, phase: 'off', text: '未許可・未接続' }); }, tick() { counts.tick++; } };
  nodes.get('taiwanConsent').checked = true;
  mountTaiwan({ environment, createFeed(value) { options = value; received.push(value); return feed; } });
  return { nodes, handlers, counts, received, get options() { return options; } };
}

test('Taiwan UI starts unchecked, renders text rather than HTML, clears on OFF and requires fresh permission after page restore', () => {
  const h = uiHarness(), toggle = h.nodes.get('taiwanConsent'), list = h.nodes.get('taiwanItems');
  assert.equal(toggle.checked, false); assert.equal(h.counts.start, 0);
  h.options.onItems([entry]); assert.equal(list.children.length, 0);
  toggle.checked = true; toggle.handlers.get('change')(); assert.equal(h.counts.start, 1);
  h.options.onItems([{ ...entry, title: '<img src=x onerror=alert(1)>地震' }]);
  const link = list.children[0].children[0];
  assert.equal(link.textContent, '<img src=x onerror=alert(1)>地震');
  assert.equal(link.rel, 'noopener noreferrer'); assert.equal(link.target, '_blank');
  h.handlers.get('visibilitychange')(); assert.equal(h.counts.tick, 1);
  toggle.checked = false; toggle.handlers.get('change')(); assert.equal(h.counts.stop, 1); assert.equal(list.children.length, 0);
  h.handlers.get('online')(); assert.equal(h.counts.tick, 1);
  toggle.checked = true; toggle.handlers.get('change')();
  h.handlers.get('pagehide')(); assert.equal(toggle.checked, false);
  h.handlers.get('pageshow')({ persisted: true }); assert.equal(toggle.checked, false);
  assert.equal(h.counts.start, 2);
});

test('the CWA relay is lazy, keeps RSS bytes unchanged, and coalesces clients for one minute', async () => {
  let clock = 100000, calls = 0;
  const relay = createTaiwanRssRelay({ now: () => clock, fetcher: async (url, options) => {
    calls++; assert.equal(url, CWA_RSS_SOURCE); assert.equal(options.redirect, 'manual'); return response();
  } });
  assert.equal(calls, 0);
  const values = await Promise.all([relay.read('https://relay.test'), relay.read('https://relay.test')]);
  assert.equal(calls, 1); assert.equal(new TextDecoder().decode(values[0]), XML); assert.deepEqual(values[0], values[1]);
  clock += 59999; await relay.read('https://relay.test'); assert.equal(calls, 1);
  clock++; await relay.read('https://relay.test'); assert.equal(calls, 2);
});

test('CWA upstream errors are throttled, rate-limit wait survives callers, and redirects/HTML/oversize/DTD fail closed', async () => {
  let clock = 100000, calls = 0;
  const relay = createTaiwanRssRelay({ now: () => clock, fetcher: async () => { calls++; return response('limit', 429, { 'Retry-After': '180' }); } });
  await assert.rejects(relay.read('https://relay.test'), error => error.status === 429);
  clock += 179999;
  await assert.rejects(relay.read('https://relay.test'), error => error.status === 429); assert.equal(calls, 1);
  clock++; await assert.rejects(relay.read('https://relay.test')); assert.equal(calls, 2);
  for (const make of [
    () => new Response(null, { status: 302, headers: { Location: 'https://example.test' } }),
    () => response('<html>bad</html>', 200, { 'Content-Type': 'text/html' }),
    () => response('x'.repeat(262145)), () => response('<!DOCTYPE rss>' + XML), () => response('not xml')
  ]) {
    const bad = createTaiwanRssRelay({ fetcher: async () => make() });
    await assert.rejects(bad.read('https://relay.test'));
  }
});

test('the CWA edge cache is reused by new worker instances and cannot hide a failure with expired data', async () => {
  const saved = new Map();
  const edgeCache = { async match(key) { return saved.get(key.url)?.clone(); }, async put(key, value) { saved.set(key.url, value.clone()); } };
  let clock = 100000, calls = 0;
  const fetcher = async () => { calls++; return response(); };
  await createTaiwanRssRelay({ now: () => clock, fetcher, edgeCache }).read('https://relay.test');
  await createTaiwanRssRelay({ now: () => clock, fetcher, edgeCache }).read('https://relay.test');
  assert.equal(calls, 1);
  clock += 60000;
  const fail = createTaiwanRssRelay({ now: () => clock, edgeCache, fetcher: async () => response('down', 503) });
  await assert.rejects(fail.read('https://relay.test'));
});

test('the Taiwan worker route keeps existing origin restrictions and rejects methods or parameters before upstream access', async () => {
  let calls = 0;
  const handle = createStrongMotionWorker({ fetcher: async () => { calls++; return response(); } });
  const url = 'https://relay.test/api/strong-motion/taiwan';
  const request = (target = url, method = 'GET', origin = 'https://nekokun148.github.io') => new Request(target, { method, headers: { Origin: origin } });
  assert.equal((await handle(request(url, 'GET', 'https://other.test'))).status, 403);
  assert.equal((await handle(request(url, 'POST'))).status, 405);
  assert.equal((await handle(request(url + '?url=https://other.test'))).status, 400);
  assert.equal((await handle(request(url, 'OPTIONS'))).status, 204);
  assert.equal(calls, 0);
  const result = await handle(request());
  assert.equal(result.status, 200); assert.equal(await result.text(), XML);
  assert.equal(result.headers.get('Access-Control-Allow-Origin'), 'https://nekokun148.github.io'); assert.equal(calls, 1);
});

test('Taiwan integration ships only code, not live RSS or consent, and does not call Japanese alerts or wave handlers', async () => {
  const ui = await readFile(new URL('../js/taiwan-ui.js', import.meta.url), 'utf8');
  const feed = await readFile(new URL('../js/taiwan-feed.js', import.meta.url), 'utf8');
  const app = await readFile(new URL('../js/app.js', import.meta.url), 'utf8');
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const sw = await readFile(new URL('../sw.js', import.meta.url), 'utf8');
  const { PUBLIC_FILES } = await import('../scripts/build.mjs');
  assert.match(app, /mountTaiwan\(\{ apiBase:/);
  assert.match(html, /id="taiwanConsent" type="checkbox" aria-describedby="taiwanSource"/);
  assert.doesNotMatch(html, /id="taiwanConsent"[^>]*checked/);
  assert.doesNotMatch(ui + feed, /localStorage|sessionStorage|speech\.|alarm\.|animateWaves|addMarker/);
  for (const file of ['js/taiwan-feed.js', 'js/taiwan-ui.js']) { assert.ok(PUBLIC_FILES.includes(file)); assert.ok(sw.includes('./' + file)); }
  assert.ok(!PUBLIC_FILES.includes('workers/taiwan-rss.mjs'));
  assert.match(sw, /new URL\('api\/', SCOPE\)/);
});
