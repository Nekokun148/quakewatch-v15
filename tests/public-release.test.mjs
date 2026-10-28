import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PUBLIC_FILES } from '../scripts/build.mjs';

const root = new URL('../', import.meta.url);

test('public release preserves the requested name and existing PWA identity', async () => {
  const html = await readFile(new URL('index.html', root), 'utf8');
  const manifest = JSON.parse(await readFile(new URL('manifest.json', root), 'utf8'));
  assert.match(html, /<title>QuakeWatch ver15<\/title>/);
  assert.match(html, /<h1>QuakeWatch ver15<\/h1>/);
  assert.equal(manifest.name, 'QuakeWatch ver15');
  assert.equal(manifest.short_name, 'QuakeWatch ver15');
  for (const field of ['id', 'start_url', 'scope']) assert.equal(manifest[field], './');
});

test('public release excludes private saved credentials and audio while shipping personal-key input', async () => {
  assert.ok(PUBLIC_FILES.every(file => !file.includes('/local/') && !file.startsWith('audio/')));
  const app = await readFile(new URL('js/app.js', root), 'utf8');
  assert.doesNotMatch(app, /\/local\/|qwDmdataKey|eew-alarm\.mp3/);
  assert.match(app, /import \{ mountDmdata \} from '\.\/dmdata-ui\.js'/);
  assert.ok(PUBLIC_FILES.includes('js/dmdata.js'));
  assert.ok(PUBLIC_FILES.includes('js/dmdata-ui.js'));
  const receiver = await readFile(new URL('js/dmdata.js', root), 'utf8');
  const ui = await readFile(new URL('js/dmdata-ui.js', root), 'utf8');
  assert.doesNotMatch(receiver + ui, /localStorage|sessionStorage|indexedDB|qwDmdataKey|console\./);
  const sw = await readFile(new URL('sw.js', root), 'utf8');
  assert.doesNotMatch(sw, /\/local\/|eew-alarm\.mp3/);
  assert.match(sw, /unified-map-v42-public/);
  const ignore = await readFile(new URL('.gitignore', root), 'utf8');
  assert.match(ignore, /audio\/eew-alarm\.mp3/);
  assert.match(ignore, /js\/local\//);
});

test('public VOICEVOX controls retain a visible and accessible PC-only compatibility notice', async () => {
  const html = await readFile(new URL('index.html', root), 'utf8');
  assert.match(html, /<p id="voicevoxCompatibility" class="speech-status">この端末のVOICEVOX連携はPC限定です。クラウド音声は別途同意が必要です。<\/p>/);
  assert.match(html, /<input id="voicevoxPrefer"[^>]*aria-describedby="voicevoxCompatibility"[^>]*checked>/);
  assert.match(html, /<button id="voicevoxConnect"[^>]*aria-describedby="voicevoxCompatibility"/);
  assert.ok(html.indexOf('id="voicevoxCompatibility"') > html.indexOf('id="voicevoxStatus"'));
  assert.ok(html.indexOf('id="voicevoxCompatibility"') < html.indexOf('id="speechStatus"'));
  assert.match(html, /<button id="browserSpeech"[^>]*>ブラウザ標準<\/button>/);
});

test('public generated alarm completes before caution without loading any audio asset', async () => {
  const { createAlarmController, createAlarmAnnouncer } = await import('../js/alarm.js');
  const sources = [], spoken = [], held = [];
  let requests = 0;
  const parameter = { setValueAtTime() {}, linearRampToValueAtTime() {} };
  class Context {
    state = 'suspended'; currentTime = 0; destination = {};
    async resume() { this.state = 'running'; }
    createOscillator() {
      const source = { connect() {}, disconnect() {}, start() {}, stop() {}, frequency: parameter };
      sources.push(source);
      return source;
    }
    createGain() { return { connect() {}, disconnect() {}, gain: parameter }; }
  }
  const alarm = createAlarmController({ soundUrl: null, environment: {
    AudioContext: Context, fetch() { requests++; throw new Error('unexpected audio fetch'); }
  } });
  const speech = { hold() { held.push(true); }, release() { held.push(false); },
    say(text) { spoken.push(text); }, stop() {} };
  const announce = createAlarmAnnouncer({ alarm, speech });
  assert.equal(alarm.play(), false);
  assert.equal(await alarm.enable(), true);
  assert.equal(sources.length, 0);
  announce.announce('テスト速報。', { sound: true });
  assert.equal(sources.length, 1);
  assert.deepEqual(spoken, []);
  sources[0].onended();
  sources[0].onended();
  assert.deepEqual(spoken, ['強い揺れに警戒してください。テスト速報。']);
  assert.deepEqual(held, [true, false]);
  assert.equal(requests, 0);
});
