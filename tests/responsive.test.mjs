import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
const css = await readFile(new URL('../css/style.css', import.meta.url), 'utf8');
const app = await readFile(new URL('../js/app.js', import.meta.url), 'utf8');
test('epicenter icon remains centered at compact fixed size with a white outline', () => {
  assert.match(app, /iconSize: \[20, 20\]/);
  assert.match(app, /iconAnchor: \[10, 10\]/);
  assert.match(css, /\.quake-cross-icon\s*\{[^}]*width: 20px;[^}]*height: 20px;/);
  assert.match(css, /border: 1px solid #fff;/);
  const fallback = app.slice(app.indexOf('function addLocalMarker('), app.indexOf('function buildObservationStations('));
  assert.match(fallback, /p\.x - 6/);
  assert.doesNotMatch(fallback, /class: 'quake-marker'/);
});
test('responsive layouts include tablet orientation, safe areas and touch targets without disabling zoom', async () => {
  assert.match(css, /max-width: 1100px\) and \(orientation: portrait\)/);
  assert.match(css, /orientation: landscape/);
  assert.match(css, /@media \(pointer: coarse\)/);
  assert.match(css, /min-height: 44px/);
  assert.match(css, /env\(safe-area-inset-bottom\)/);
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(html, /width=device-width,initial-scale=1,viewport-fit=cover/);
  assert.doesNotMatch(html, /user-scalable=no|maximum-scale=1/);
});

test('compact header starts with settings closed while retaining audio, cloud and connection controls', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(html, /id="settingsToggle"[^>]*aria-expanded="false"[^>]*aria-controls="settingsPanel"/);
  assert.match(html, /<section id="settingsPanel"[^>]*hidden>/);
  for (const id of ['alarmToggle', 'speechToggle', 'speechVoice', 'cloudVoicevoxConsent', 'voicevoxConnect', 'locationToggle', 'reconnect']) {
    assert.match(html, new RegExp('id="' + id + '"'));
  }
  assert.match(html, /id="alarmSummary"/);
  assert.match(html, /id="speechSummary"/);
  assert.match(css, /\.settings-panel\s*\{[^}]*max-height:[^}]*overflow-y: auto/);
  assert.match(css, /\[hidden\]\s*\{\s*display: none !important/);
  assert.match(html, /<details class="map-legend">/);
  assert.doesNotMatch(html.match(/<details class="map-legend"[^>]*>/)[0], /open/);
  assert.match(css, /\.region\s*\{[^}]*border-radius: 0;[^}]*background: transparent/);
});

test('settings toggle and Escape update accessibility and map space without any audio or feed actions', () => {
  const handlers = {}, attributes = {};
  let layouts = 0, focused = 0, prevented = 0;
  const button = { setAttribute: (key, value) => { attributes[key] = value; }, focus: () => focused++,
    addEventListener: (type, fn) => { handlers['button/' + type] = fn; } };
  const panel = { hidden: true };
  const topbar = { addEventListener: (type, fn) => { handlers['header/' + type] = fn; } };
  const source = app.slice(app.indexOf('function setSettingsOpen('), app.indexOf('const scaleText'));
  vm.runInNewContext(source, { $: id => id === 'settingsPanel' ? panel : button, topbar, updateTopbarHeight: () => layouts++ });
  handlers['button/click']();
  assert.equal(panel.hidden, false);
  assert.equal(attributes['aria-expanded'], 'true');
  handlers['header/keydown']({ key: 'Tab' });
  assert.equal(panel.hidden, false);
  handlers['header/keydown']({ key: 'Escape', preventDefault: () => prevented++ });
  assert.equal(panel.hidden, true);
  assert.equal(attributes['aria-expanded'], 'false');
  assert.equal(focused, 1);
  assert.equal(prevented, 1);
  assert.equal(layouts, 2);
  handlers['header/keydown']({ key: 'Escape', preventDefault: () => prevented++ });
  assert.equal(prevented, 1);
});

test('fallback reason stays visible outside closed settings and is cleared only by an explicit clear event', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(html, /<p id="speechFallback"[^>]*role="status"[^>]*aria-live="polite"[^>]*hidden>/);
  assert.ok(html.indexOf('id="speechFallback"') < html.indexOf('id="settingsPanel"'));
  const notice = { hidden: true, textContent: '', dataset: {} };
  const source = app.slice(app.indexOf('function updateSpeechFallback('), app.indexOf('mountTaiwan('));
  const scope = { $: () => notice };
  vm.runInNewContext(source, scope);
  scope.updateSpeechFallback({ source: 'cloud', reason: 'interval', message: '模擬の理由です。' });
  assert.equal(notice.hidden, false);
  assert.equal(notice.dataset.reason, 'interval');
  assert.match(notice.textContent, /ブラウザ標準へ切替：模擬の理由/);
  scope.updateSpeechFallback(null);
  assert.equal(notice.hidden, true);
  assert.equal(notice.textContent, '');
});

test('manually selecting browser speech clears the old reason without clearing it on a cloud selection', () => {
  const selection = app.match(/\$\('speechVoice'\)\.addEventListener\('change', event => \{([\s\S]*?)\n\}\);/)[1];
  const selected = [], cleared = [];
  const handler = vm.runInNewContext('(event) => {' + selection + '}', {
    cloudVoicevox: { selectVoice: id => selected.push(id) }, updateSpeechFallback: info => cleared.push(info)
  });
  handler({ target: { value: 'voicevox-cloud:0' } });
  assert.equal(cleared.length, 0);
  handler({ target: { value: 'browser-ja' } });
  assert.deepEqual(selected, ['voicevox-cloud:0', 'browser-ja']);
  assert.deepEqual(cleared, [null]);
});
