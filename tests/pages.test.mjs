import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import vm from 'node:vm';
import { build, PUBLIC_FILES } from '../scripts/build.mjs';

const root = new URL('../', import.meta.url);
const swSource = await readFile(new URL('sw.js', root), 'utf8');
async function filesAt(root, prefix = '') {
  const files = [];
  for (const entry of await readdir(new URL(prefix || './', root), { withFileTypes: true })) {
    const path = prefix + entry.name;
    if (entry.isDirectory()) files.push(...await filesAt(root, path + '/'));
    else files.push(path);
  }
  return files.sort();
}

test('Pages build publishes only allowlisted files and removes stale artifacts', async () => {
  await build();
  await writeFile(new URL('dist/stale-secret.txt', root), 'test-only stale artifact');
  await build();
  assert.deepEqual(await filesAt(new URL('dist/', root)), [...PUBLIC_FILES, '.nojekyll'].sort());
  const manifest = JSON.parse(await readFile(new URL('dist/manifest.json', root), 'utf8'));
  assert.equal(manifest.id, './');
  assert.equal(manifest.scope, './');
  assert.equal(manifest.start_url, './');
  const html = await readFile(new URL('dist/index.html', root), 'utf8');
  assert.ok(!/href="\/(?!\/)|src="\/(?!\/)/.test(html));
  for (const file of PUBLIC_FILES) assert.equal(await readFile(new URL('dist/' + file, root), 'utf8'), await readFile(new URL(file, root), 'utf8'));
});

test('GitHub workflow tests and uploads the generated static directory', async () => {
  const workflow = await readFile(new URL('.github/workflows/pages.yml', root), 'utf8');
  assert.match(workflow, /node --test tests\/\*\.test\.mjs/);
  assert.match(workflow, /node scripts\/build\.mjs/);
  assert.match(workflow, /path: dist/);
  assert.match(workflow, /pages: write/);
  assert.match(workflow, /id-token: write/);
  assert.ok(!workflow.includes('secrets.'));
  assert.match(workflow, /KMONI_API_BASE: https:\/\/quakewatch-v15-relay\.kouryou148\.workers\.dev\/api\/strong-motion\//);
});

test('Pages relay configuration is HTTPS-only, public, and does not change local source HTML', async () => {
  const source = await readFile(new URL('index.html', root), 'utf8');
  const relay = 'https://quakewatch-v15-relay.kouryou148.workers.dev/api/strong-motion/';
  await build({ monitorApiBase: relay });
  const html = await readFile(new URL('dist/index.html', root), 'utf8');
  assert.match(html, /<body data-kmoni-api-base="https:\/\/quakewatch-v15-relay\.kouryou148\.workers\.dev\/api\/strong-motion\/">/);
  assert.equal(await readFile(new URL('index.html', root), 'utf8'), source);
  assert.deepEqual(await filesAt(new URL('dist/', root)), [...PUBLIC_FILES, '.nojekyll'].sort());
  for (const value of ['http://relay.example/api/strong-motion/', 'https://user:password@relay.example/api/strong-motion/',
    'https://relay.example/api/strong-motion/?token=test', 'https://relay.example/api/strong-motion/#test', 'https://relay.example/other/']) {
    await assert.rejects(build({ monitorApiBase: value }), /public HTTPS/);
  }
  await build({ monitorApiBase: '' });
  assert.equal(await readFile(new URL('dist/index.html', root), 'utf8'), source);
});

test('unified screen places both metrics on one geographic map, with no separate image map', async () => {
  const html = await readFile(new URL('index.html', root), 'utf8');
  assert.match(html, /<div id="map"[^>]*>/);
  assert.doesNotMatch(html, /<div id="map"[^>]*\bhidden\b/);
  assert.match(html, /<section id="strongMonitor"[^>]*>/);
  assert.doesNotMatch(html, /<section id="strongMonitor"[^>]*\bhidden\b/);
  assert.ok(!html.includes('id="viewMap"'));
  assert.match(html, /id="viewIntensity"[^>]*aria-controls="monitorDisplay"/);
  assert.match(html, /id="viewAcceleration"[^>]*aria-controls="monitorDisplay"/);
  assert.ok(html.indexOf('id="strongMonitor"') < html.indexOf('id="map"'));
  assert.ok(html.indexOf('id="monitorDisplay"') < html.indexOf('id="map"'));
  assert.ok(!html.includes('id="monitorFrame"'));
  assert.ok(!html.includes('id="monitorBase"'));
  const app = await readFile(new URL('js/app.js', root), 'utf8');
  assert.ok(!app.includes("$('map').hidden ="));
  assert.ok(!app.includes('selectMapView'));
});

test('speech voice menu is labelled and connected without starting playback on selection', async () => {
  const html = await readFile(new URL('index.html', root), 'utf8');
  assert.match(html, /<label[^>]*for="speechVoice"/);
  assert.match(html, /<select id="speechVoice" disabled>/);
  assert.match(html, /<option value="">自動選択（日本語）<\/option>/);
  const app = await readFile(new URL('js/app.js', root), 'utf8');
  assert.match(app, /\$\('speechVoice'\)\.addEventListener\('change', event => \{\s*speech\.setVoice\(event\.target\.value\);\s*\}\);/);
});

function workerHarness({ offline = false } = {}) {
  const handlers = {}, deleted = [], stored = [], added = [];
  const prefix = 'quake-v15-%2Fquakewatch-v15%2F-';
  const cached = new Response('cached page');
  const cache = {
    addAll: async values => added.push(...values),
    put: async request => stored.push(request.url),
    match: async request => request.url.endsWith('missing.js') ? undefined : cached.clone()
  };
  vm.runInNewContext(swSource, {
    URL, Response,
    self: {
      registration: { scope: 'https://example.github.io/quakewatch-v15/' },
      addEventListener: (name, fn) => { handlers[name] = fn; },
      skipWaiting: async () => {}, clients: { claim: async () => {} }
    },
    caches: {
      open: async () => cache,
      keys: async () => [prefix + 'old', prefix + 'unified-map-v14', prefix + 'unified-map-v15', prefix + 'unified-map-v16', 'another-project-cache'],
      delete: async key => { deleted.push(key); }
    },
    fetch: async request => {
      if (offline) throw new Error('offline');
      return new Response('live page', { status: request.url.endsWith('missing.js') ? 404 : 200 });
    }
  });
  const fetchEvent = async (url, method = 'GET') => {
    let promise;
    handlers.fetch({ request: new Request(url, { method }), respondWith: result => { promise = result; } });
    return promise ? await promise : null;
  };
  return { handlers, fetchEvent, deleted, stored, added, prefix };
}

test('Service Worker precaches assets and deletes only its own previous project cache', async () => {
  const h = workerHarness();
  let promise;
  h.handlers.install({ waitUntil: value => { promise = value; } });
  await promise;
  assert.ok(h.added.includes('./js/observations.js'));
  h.handlers.activate({ waitUntil: value => { promise = value; } });
  await promise;
  assert.deepEqual(h.deleted, [h.prefix + 'old', h.prefix + 'unified-map-v14', h.prefix + 'unified-map-v15']);
});

test('Service Worker never caches live APIs, sibling sites, or non-GET requests', async () => {
  const h = workerHarness();
  assert.equal(await h.fetchEvent('https://www.jma.go.jp/bosai/quake/data/list.json'), null);
  assert.equal(await h.fetchEvent('https://api.p2pquake.net/v2/history'), null);
  assert.equal(await h.fetchEvent('https://example.github.io/quakewatch-v15/api/strong-motion/latest'), null);
  assert.equal(await h.fetchEvent('https://quakewatch-v15-relay.kouryou148.workers.dev/api/strong-motion/latest'), null);
  assert.equal(await h.fetchEvent('https://example.github.io/other/index.html'), null);
  assert.equal(await h.fetchEvent('https://example.github.io/quakewatch-v15/submit', 'POST'), null);
  const result = await h.fetchEvent('https://example.github.io/quakewatch-v15/index.html');
  assert.equal(await result.text(), 'live page');
  assert.equal(h.stored.length, 1);
  await h.fetchEvent('https://example.github.io/quakewatch-v15/missing.js');
  assert.equal(h.stored.length, 1);
});

test('offline fallback is confined to that project and uncached files fail explicitly', async () => {
  const h = workerHarness({ offline: true });
  assert.equal(await (await h.fetchEvent('https://example.github.io/quakewatch-v15/index.html')).text(), 'cached page');
  assert.equal((await h.fetchEvent('https://example.github.io/quakewatch-v15/missing.js')).status, 503);
});
