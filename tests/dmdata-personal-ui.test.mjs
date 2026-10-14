import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { dmdataAllowed, validDmdataKey } from '../js/dmdata.js';

const source = await readFile(new URL('../js/dmdata-ui.js', import.meta.url), 'utf8');
const fixtureKey = 'TEST-ONLY';

function harness({ location = { origin: 'https://nekokun148.github.io', pathname: '/quakewatch-v15/' }, failStart = false } = {}) {
  const elements = new Map(), events = new Map(), starts = [], statuses = [];
  let options, mounted = 0, stopped = 0, storageReads = 0;
  function element(id) {
    if (!elements.has(id)) elements.set(id, {
      value: '', disabled: id === 'dmdataDisconnect', dataset: {}, textContent: '',
      handlers: new Map(), addEventListener(name, fn) { this.handlers.set(name, fn); },
      fire(name) { this.handlers.get(name)?.({ preventDefault() {} }); }
    });
    return elements.get(id);
  }
  element('dmdataClass').value = 'eew.forecast';
  const section = { dataset: {}, innerHTML: '', querySelector(selector) {
    return element(({ form: 'dmdataForm', input: 'dmdataKey', select: 'dmdataClass' })[selector] || selector.slice(1));
  } };
  const environment = { location, document: {
    createElement: () => section, getElementById: () => ({ after() { mounted++; } })
  }, addEventListener: (name, fn) => events.set(name, fn) };
  for (const name of ['localStorage', 'sessionStorage', 'indexedDB']) Object.defineProperty(environment, name, {
    get() { storageReads++; throw new Error('storage must not be accessed'); }
  });
  const feed = { start(key, mode) {
    starts.push({ key, mode }); if (failStart) throw new Error('TEST-ONLY');
    options.onStatus({ phase: 'loading', enabled: true, text: 'DMDATA / 接続中' });
  }, stop() { stopped++; options.onStatus({ phase: 'off', enabled: false, text: 'DMDATA / 未接続' }); } };
  const context = vm.createContext({ dmdataAllowed, validDmdataKey });
  vm.runInContext(source.replace(/^import[^\n]+\n/, '').replace('export function mountDmdata', 'function mountDmdata'), context);
  const result = context.mountDmdata({ environment, createFeed: value => { options = value; return feed; },
    onData() {}, onStatus: info => statuses.push(info) });
  return { result, element, events, starts, statuses, section,
    status: info => options.onStatus(info), mounted: () => mounted, stopped: () => stopped, storageReads: () => storageReads };
}

test('personal-key form mounts empty without reading persistence or connecting on load', () => {
  const h = harness();
  assert.equal(h.mounted(), 1); assert.equal(h.starts.length, 0); assert.equal(h.storageReads(), 0);
  assert.equal(h.element('dmdataKey').value, ''); assert.equal(h.element('dmdataConnect').disabled, false);
  assert.match(h.section.innerHTML, /type="password" autocomplete="off"/);
  assert.match(h.section.innerHTML, /このページではキーを保存しません/);
  assert.doesNotMatch(h.section.innerHTML, /dmdataRemember|dmdataForget/);
});

test('only explicit submit starts one selected subscription and clears the input immediately', () => {
  const h = harness(); h.element('dmdataKey').value = fixtureKey;
  h.element('dmdataClass').value = 'both'; h.element('dmdataForm').fire('submit');
  assert.deepEqual(h.starts, [{ key: fixtureKey, mode: 'both' }]);
  assert.equal(h.element('dmdataKey').value, ''); assert.equal(h.element('dmdataKey').disabled, true);
  h.element('dmdataKey').value = fixtureKey; h.element('dmdataForm').fire('submit');
  assert.equal(h.starts.length, 1); assert.equal(h.element('dmdataKey').value, '');
  assert.equal(h.storageReads(), 0);
});

test('disconnect and pagehide clear input and stop this feed without restoring a stored key', () => {
  const h = harness(); h.element('dmdataKey').value = fixtureKey; h.element('dmdataForm').fire('submit');
  h.element('dmdataDisconnect').fire('click');
  assert.equal(h.stopped(), 1); assert.equal(h.element('dmdataKey').value, '');
  assert.equal(h.element('dmdataConnect').disabled, false); assert.equal(h.element('dmdataClass').disabled, false);
  h.element('dmdataKey').value = fixtureKey; h.element('dmdataForm').fire('submit');
  h.events.get('pagehide')(); assert.equal(h.stopped(), 2);
  assert.equal(h.element('dmdataKey').value, ''); assert.equal(h.storageReads(), 0);
});

test('fatal failures allow manual retry; automatic backoff keeps duplicate connect disabled', () => {
  const h = harness(); h.element('dmdataKey').value = fixtureKey; h.element('dmdataForm').fire('submit');
  h.status({ phase: 'error', enabled: true, text: 'DMDATA / レート制限・待機中' });
  assert.equal(h.element('dmdataConnect').disabled, true);
  h.status({ phase: 'error', enabled: false, text: 'DMDATA / 認証失敗' });
  assert.equal(h.element('dmdataConnect').disabled, false); assert.equal(h.element('dmdataKey').disabled, false);
  h.element('dmdataKey').value = fixtureKey; h.element('dmdataForm').fire('submit');
  assert.equal(h.starts.length, 2);
});

test('invalid input and synchronous failure cannot echo or retain the key', () => {
  const h = harness({ failStart: true });
  for (const key of ['', 'short', 'TEST:ONLY', 'TEST\nONLY', fixtureKey]) {
    h.element('dmdataKey').value = key; h.element('dmdataForm').fire('submit');
    assert.equal(h.element('dmdataKey').value, ''); assert.equal(h.element('dmdataConnect').disabled, false);
    assert.ok(!h.element('dmdataStatus').textContent.includes(fixtureKey));
  }
  assert.equal(h.starts.length, 1); assert.equal(h.storageReads(), 0);
});

test('unsupported sites mount no key form and touch neither storage nor a receiver', () => {
  const h = harness({ location: { origin: 'https://example.test', pathname: '/quakewatch-v15/' } });
  assert.equal(h.result, null); assert.equal(h.mounted(), 0); assert.equal(h.starts.length, 0); assert.equal(h.storageReads(), 0);
});

test('new-tab help links use approved destinations, no credentials and safe opener policy', async () => {
  const h = harness();
  const links = [...h.section.innerHTML.matchAll(/<a href="([^"]+)" target="_blank" rel="noopener noreferrer">([^<]+)<\/a>/g)];
  assert.equal(links.length, 3);
  assert.deepEqual(links.map(link => new URL(link[1]).hostname), ['github.com', 'manager.dmdata.jp', 'dmdata.jp']);
  assert.ok(links.some(link => link[2] === 'APIキーの設定方法'));
  for (const link of links) { const url = new URL(link[1]); assert.equal(url.search, ''); assert.equal(url.username, ''); assert.equal(url.password, ''); }
  const guide = await readFile(new URL('../docs/dmdata-setup.md', import.meta.url), 'utf8');
  for (const value of ['socket.start', 'eew.get.forecast', 'eew.get.warning', 'nekokun148.github.io', 'https://dmdata.jp/docs/eew/']) assert.ok(guide.includes(value));
});
