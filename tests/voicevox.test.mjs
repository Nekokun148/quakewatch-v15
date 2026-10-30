import test from 'node:test';
import assert from 'node:assert/strict';
import { createVoicevoxEnvironment, createVoicevoxPreference, voicevoxVoices, VOICEVOX_BASE,
  normalizeVoicevoxBase, mountLocalVoicevox } from '../js/voicevox.js';
import { createSpeechController } from '../js/speech.js';

const speakers = [{ name: 'Test speaker', styles: [{ id: 2, name: 'Normal', type: 'talk' }, { id: 3, name: 'Singing', type: 'sing' }] }];
const flush = () => new Promise(resolve => setImmediate(resolve));

function harness(fetcher, { storage = new Map(), storageBlocked = false } = {}) {
  const requests = [], audio = [], nativePlayed = [], revoked = [], statuses = [], connections = [], fallbacks = [];
  const timers = new Map();
  let id = 0;
  const browserVoice = { voiceURI: 'browser-ja', name: 'Browser Japanese', lang: 'ja-JP', localService: true };
  const native = { getVoices: () => [browserVoice], addEventListener() {}, cancel() {}, resume() {}, speak: value => nativePlayed.push(value) };
  class Audio {
    constructor(url) { this.src = url; this.pauses = 0; audio.push(this); }
    async play() { this.played = true; }
    pause() { this.pauses++; }
    removeAttribute() { this.src = ''; }
  }
  const environment = {
    Audio, URL: { createObjectURL: () => 'blob:test', revokeObjectURL: url => revoked.push(url) },
    speechSynthesis: native, SpeechSynthesisUtterance: class { constructor(text) { this.text = text; } },
    localStorage: {
      getItem: key => { if (storageBlocked) throw new Error('Denied'); return storage.get(key); },
      setItem: (key, value) => { if (storageBlocked) throw new Error('Denied'); storage.set(key, value); }
    },
    setTimeout: callback => { timers.set(++id, callback); return id; }, clearTimeout: id => timers.delete(id),
    fetch: async (url, options) => {
      requests.push({ url, options });
      if (fetcher) return fetcher(url, options);
      if (url.endsWith('/speakers')) return { ok: true, json: async () => speakers };
      if (url.includes('/audio_query')) return { ok: true, json: async () => ({ accent_phrases: [] }) };
      return { ok: true, blob: async () => new Blob(['mock wav'], { type: 'audio/wav' }) };
    }
  };
  const adapter = createVoicevoxEnvironment({ environment, onStatus: value => connections.push(value), onFallback: info => fallbacks.push(info) });
  const controller = createSpeechController({ environment: adapter.environment, onStatus: value => statuses.push(value) });
  return { adapter, controller, environment, requests, audio, nativePlayed, revoked, statuses, connections, fallbacks, timers, storage };
}

test('only returned talk styles are exposed and malformed styles are rejected', () => {
  assert.deepEqual(voicevoxVoices(speakers).map(voice => voice.voiceURI), ['voicevox:2']);
  assert.match(voicevoxVoices(speakers)[0].name, /^VOICEVOX: Test speaker/);
  assert.deepEqual(voicevoxVoices([{ name: 'Bad', styles: [{ id: -1, name: 'Bad' }, { id: '2', name: 'Bad' }] }]), []);
  assert.throws(() => voicevoxVoices(null));
});

test('streaming talk styles remain valid for ordinary query and synthesis, unlike song or unknown styles', async () => {
  const current = [{ name: 'Current engine', styles: [
    { id: 2, name: 'Normal', type: 'streaming_talk' }, { id: 5, name: 'Legacy' },
    { id: 7, name: 'Song', type: 'sing' }, { id: 8, name: 'Teacher', type: 'singing_teacher' },
    { id: 9, name: 'Decoder', type: 'frame_decode' }, { id: 10, name: 'Unknown', type: 'other' }
  ] }];
  assert.deepEqual(voicevoxVoices(current).map(voice => voice.voiceURI), ['voicevox:2', 'voicevox:5']);
  const h = harness((url) => url.endsWith('/speakers') ? { ok: true, json: async () => current }
    : url.includes('/audio_query') ? { ok: true, json: async () => ({ accent_phrases: [] }) }
      : { ok: true, blob: async () => new Blob(['mock wav'], { type: 'audio/wav' }) });
  assert.equal(await h.adapter.connect(), true);
  assert.equal(h.controller.setVoice('voicevox:2'), true);
  assert.equal(h.audio.length + h.nativePlayed.length, 0);
  h.controller.enable(); h.controller.say('Mock streaming talk compatibility.');
  await flush();
  assert.match(h.requests[1].url, /\/audio_query\?/);
  assert.equal(h.requests[2].url, VOICEVOX_BASE + '/synthesis?speaker=2');
  assert.equal(h.audio.length, 1);
  assert.equal(h.nativePlayed.length, 0);
  h.audio[0].onended();
});

test('an engine response with no supported voices is not reported as a startup or permission failure', async () => {
  const h = harness(() => ({ ok: true, json: async () => [
    { name: 'Song only', styles: [{ id: 3, name: 'Song', type: 'sing' }] }
  ] }));
  assert.equal(await h.adapter.connect(), false);
  assert.match(h.connections.at(-1).message, /応答.*読み上げ.*話者/);
  assert.doesNotMatch(h.connections.at(-1).message, /未起動|接続許可/);
  assert.equal(h.audio.length + h.nativePlayed.length, 0);
});

test('connecting and selecting a local voice cannot enable or play speech', async () => {
  const h = harness();
  const first = h.adapter.connect();
  const second = h.adapter.connect();
  assert.equal(await first, true);
  assert.equal(await second, true);
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].url, VOICEVOX_BASE + '/speakers');
  assert.equal(h.controller.setVoice('voicevox:2'), true);
  assert.equal(h.storage.get('qwSpeechVoice'), 'voicevox:2');
  assert.equal(h.statuses.at(-1).enabled, false);
  assert.equal(h.controller.say('No playback'), false);
  assert.equal(h.audio.length, 0);
  assert.equal(h.nativePlayed.length, 0);
});

test('VOICEVOX follows query/synthesis order and releases audio after completion', async () => {
  const h = harness();
  await h.adapter.connect();
  h.controller.setVoice('voicevox:2');
  h.controller.enable();
  h.controller.say('Mock speech.');
  await flush();
  assert.equal(h.requests.length, 3);
  const query = new URL(h.requests[1].url);
  assert.equal(query.origin, VOICEVOX_BASE);
  assert.equal(query.searchParams.get('text'), 'Mock speech.');
  assert.equal(query.searchParams.get('speaker'), '2');
  assert.equal(h.requests[2].url, VOICEVOX_BASE + '/synthesis?speaker=2');
  assert.equal(h.requests[2].options.method, 'POST');
  assert.equal(JSON.parse(h.requests[2].options.body).volumeScale, 1);
  assert.equal(h.statuses.at(-1).started, 1);
  h.audio[0].onended();
  assert.equal(h.statuses.at(-1).completed, 1);
  assert.deepEqual(h.revoked, ['blob:test']);
  assert.equal(h.audio[0].pauses, 1);
});

test('OFF aborts in-flight synthesis and ignores its late result', async () => {
  let release;
  const h = harness(url => url.endsWith('/speakers')
    ? { ok: true, json: async () => speakers }
    : new Promise(resolve => { release = resolve; }));
  await h.adapter.connect();
  h.controller.setVoice('voicevox:2');
  h.controller.enable();
  h.controller.say('Pending');
  h.controller.disable();
  assert.equal(h.requests[1].options.signal.aborted, true);
  release({ ok: true, json: async () => ({ accent_phrases: [] }) });
  await flush();
  assert.equal(h.requests.length, 2);
  assert.equal(h.audio.length, 0);
  assert.equal(h.statuses.at(-1).phase, 'off');
});

test('alarm hold stops VOICEVOX, keeps new speech queued, and ignores a stale end callback', async () => {
  const h = harness();
  await h.adapter.connect();
  h.controller.setVoice('voicevox:2');
  h.controller.enable();
  h.controller.say('Before alarm');
  await flush();
  const oldEnd = h.audio[0].onended;
  h.controller.hold();
  h.controller.say('After alarm');
  await flush();
  assert.equal(h.audio.length, 1);
  oldEnd();
  assert.equal(h.statuses.at(-1).completed, 0);
  h.controller.release();
  await flush();
  assert.equal(h.audio.length, 2);
  assert.equal(h.statuses.at(-1).enabled, true);
});

test('failed local discovery retries and preserves browser speech', async () => {
  let fail = true;
  const h = harness(() => { if (fail) throw new Error('Connection refused'); return { ok: true, json: async () => speakers }; });
  assert.equal(await h.adapter.connect(), false);
  h.controller.enable();
  h.controller.say('Browser fallback');
  assert.equal(h.nativePlayed.length, 1);
  h.nativePlayed[0].onstart();
  h.nativePlayed[0].onend();
  assert.equal(h.statuses.at(-1).completed, 1);
  fail = false;
  assert.equal(await h.adapter.connect(), true);
});

test('local synthesis failure reports an error and never starts audio', async () => {
  const h = harness(url => url.endsWith('/speakers') ? { ok: true, json: async () => speakers } : { ok: false });
  await h.adapter.connect();
  h.controller.setVoice('voicevox:2');
  h.controller.enable();
  h.controller.say('Rejected');
  await flush();
  assert.equal(h.statuses.at(-1).phase, 'error');
  assert.equal(h.statuses.at(-1).enabled, false);
  assert.equal(h.audio.length, 0);
});

test('unavailable local storage does not prevent controller creation', () => {
  const h = harness();
  Object.defineProperty(h.environment, 'localStorage', { get() { throw new Error('Denied'); } });
  const adapter = createVoicevoxEnvironment({ environment: h.environment });
  assert.doesNotThrow(() => createSpeechController({ environment: adapter.environment }));
});

function preference(h, { local = false } = {}) {
  if (local) h.storage.set('qwPreferVoicevox', 'true');
  const values = [];
  const control = createVoicevoxPreference({ voicevox: h.adapter, speech: h.controller, environment: h.environment,
    isEnabled: () => h.statuses.at(-1).enabled, onPreference: value => values.push(value) });
  return { control, values };
}

test('new users default to browser speech and never require a local client, even on activation', async () => {
  const h = harness(), p = preference(h);
  assert.deepEqual(p.values, [false]);
  assert.equal(await p.control.prepare(), false);
  h.controller.enable();
  assert.equal(await p.control.prepare(), false);
  assert.equal(h.requests.length, 0);
  assert.equal(h.audio.length, 0);
  assert.equal(h.nativePlayed.length, 0);
  assert.equal(h.statuses.at(-1).enabled, true);
  h.controller.say('No local client required');
  assert.equal(h.requests.length, 0);
  assert.equal(h.nativePlayed.length, 1);
});

test('activation discovers the same-device engine once and selects an available voice without playback', async () => {
  const h = harness(), p = preference(h, { local: true });
  assert.equal(await p.control.prepare(), false);
  assert.equal(h.requests.length, 0);
  h.controller.enable();
  assert.deepEqual(await Promise.all([p.control.prepare(), p.control.prepare()]), [true, true]);
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].url, 'http://127.0.0.1:50021/speakers');
  assert.equal(h.requests[0].options.credentials, 'omit');
  assert.equal(h.requests[0].options.referrerPolicy, 'no-referrer');
  assert.equal(h.statuses.at(-1).voice, 'VOICEVOX: Test speaker（Normal）');
  assert.equal(h.storage.get('qwSpeechVoice'), 'voicevox:2');
  assert.equal(await p.control.prepare(), false);
  assert.equal(h.requests.length, 1);
  assert.equal(h.audio.length, 0);
  assert.equal(h.nativePlayed.length, 0);
});

test('browser opt-out survives reload and a later discovery cannot overwrite it', async () => {
  let release;
  const h = harness(() => new Promise(resolve => { release = resolve; }));
  const p = preference(h, { local: true });
  h.controller.enable();
  const pending = p.control.prepare();
  await flush();
  p.control.setPreferred(false);
  release({ ok: true, json: async () => speakers });
  assert.equal(await pending, false);
  assert.equal(h.storage.get('qwPreferVoicevox'), 'false');
  assert.equal(h.statuses.at(-1).voice, 'Browser Japanese');
  const reloaded = preference(h);
  assert.deepEqual(reloaded.values, [false]);
  assert.equal(await reloaded.control.prepare(), false);
  assert.equal(h.requests.length, 1);
});

test('existing explicit browser choice is preserved and saved VOICEVOX style is restored only on activation', async () => {
  const h = harness();
  h.storage.set('qwSpeechVoice', 'browser-ja');
  const browser = preference(h);
  assert.deepEqual(browser.values, [false]);
  h.controller.enable();
  assert.equal(await browser.control.prepare(), false);
  assert.equal(h.requests.length, 0);
  const saved = harness(() => ({ ok: true, json: async () => [{ name: 'Saved', styles: [
    { id: 2, name: 'First' }, { id: 7, name: 'Chosen' }
  ] }] }));
  saved.storage.set('qwSpeechVoice', 'voicevox:7');
  const vox = preference(saved);
  assert.equal(saved.requests.length, 0);
  saved.controller.enable();
  assert.equal(await vox.control.prepare(), true);
  assert.equal(saved.statuses.at(-1).preferredVoice, 'voicevox:7');
});

test('OFF invalidates pending auto-selection; explicit reconnect remains silent while OFF', async () => {
  let release;
  const h = harness(() => new Promise(resolve => { release = resolve; }));
  const p = preference(h, { local: true });
  h.controller.enable();
  const pending = p.control.prepare();
  await flush();
  p.control.cancelPending();
  h.controller.disable();
  release({ ok: true, json: async () => speakers });
  assert.equal(await pending, false);
  assert.equal(h.statuses.at(-1).preferredVoice, '');
  assert.equal(h.statuses.at(-1).enabled, false);
  const explicit = p.control.connect();
  await flush();
  release({ ok: true, json: async () => speakers });
  assert.equal(await explicit, true);
  assert.equal(h.statuses.at(-1).enabled, false);
  assert.equal(h.audio.length, 0);
  assert.equal(h.nativePlayed.length, 0);
});

test('failed auto-discovery leaves browser speech usable without repeating network attempts', async () => {
  const h = harness(() => { throw new TypeError('Blocked local network or CORS'); });
  const p = preference(h, { local: true });
  h.controller.enable();
  assert.equal(await p.control.prepare(), false);
  assert.equal(await p.control.prepare(), false);
  h.controller.say('Fallback after discovery');
  assert.equal(h.requests.length, 1);
  assert.equal(h.nativePlayed.length, 1);
  assert.equal(h.nativePlayed[0].voice.voiceURI, 'browser-ja');
  assert.equal(h.statuses.at(-1).enabled, true);
  assert.equal(h.fallbacks.at(-1).reason, 'discovery');
  assert.match(h.fallbacks.at(-1).message, /未特定/);
});

test('local query and synthesis failures expose their stage and HTTP code, not private response bodies', async () => {
  for (const stage of ['query', 'synthesis']) {
    const h = harness(url => url.endsWith('/speakers') ? { ok: true, json: async () => speakers }
      : url.includes('/audio_query') && stage === 'synthesis' ? { ok: true, json: async () => ({}) }
        : { ok: false, status: 503, text: async () => 'private server detail' });
    await h.adapter.connect(); h.adapter.setBrowserFallback(true);
    h.controller.setVoice('voicevox:2'); h.controller.enable(); h.controller.say('模擬文。'); await flush();
    assert.equal(h.nativePlayed.length, 1);
    assert.equal(h.fallbacks.at(-1).reason, stage);
    assert.match(h.fallbacks.at(-1).message, /HTTP 503/);
    assert.doesNotMatch(h.fallbacks.at(-1).message, /private server/);
  }
});

test('discovery timeout completes even if fetch ignores abort and ignores its late voices', async () => {
  let release;
  const h = harness(() => new Promise(resolve => { release = resolve; }));
  const pending = h.adapter.connect();
  await flush();
  [...h.timers.values()][0]();
  assert.equal(await pending, false);
  assert.equal(h.requests[0].options.signal.aborted, true);
  release({ ok: true, json: async () => speakers });
  await flush();
  assert.ok(h.adapter.environment.speechSynthesis.getVoices().every(voice => !voice.voiceURI.startsWith('voicevox:')));
  assert.equal(h.connections.at(-1).phase, 'error');
  assert.equal(h.timers.size, 0);
});

test('automatic synthesis failure reads the same bulletin once with browser speech and stays enabled', async () => {
  const h = harness(url => url.endsWith('/speakers') ? { ok: true, json: async () => speakers } : { ok: false });
  const p = preference(h, { local: true });
  h.controller.enable();
  assert.equal(await p.control.prepare(), true);
  h.controller.say('Current bulletin');
  await flush();
  assert.equal(h.audio.length, 0);
  assert.equal(h.nativePlayed.length, 1);
  assert.equal(h.nativePlayed[0].text, 'Current bulletin');
  assert.equal(h.nativePlayed[0].voice.voiceURI, 'browser-ja');
  assert.equal(h.connections.at(-1).phase, 'fallback');
  h.nativePlayed[0].onstart(); h.nativePlayed[0].onend();
  assert.equal(h.statuses.at(-1).completed, 1);
  assert.equal(h.statuses.at(-1).enabled, true);
  h.controller.say('Next bulletin');
  assert.equal(h.nativePlayed.length, 2);
  assert.equal(h.requests.length, 2);
});

test('autoplay denial remains visible and is never bypassed by browser fallback', async () => {
  const h = harness(), p = preference(h, { local: true });
  h.environment.Audio.prototype.play = async () => { throw new DOMException('Blocked', 'NotAllowedError'); };
  h.controller.enable();
  await p.control.prepare();
  h.controller.say('Blocked audio');
  await flush();
  assert.equal(h.nativePlayed.length, 0);
  assert.equal(h.statuses.at(-1).enabled, false);
  assert.equal(h.statuses.at(-1).phase, 'error');
  assert.match(h.statuses.at(-1).error, /開始できません/);
  assert.deepEqual(h.revoked, ['blob:test']);
});

test('preference still works with blocked storage and voice selection does not enable playback', async () => {
  const h = harness();
  Object.defineProperty(h.environment, 'localStorage', { get() { throw new Error('Denied'); } });
  const p = preference(h);
  await p.control.connect();
  assert.equal(p.control.selectVoice('browser-ja'), true);
  assert.equal(h.statuses.at(-1).voice, 'Browser Japanese');
  assert.equal(p.control.selectVoice('voicevox:9999'), false);
  assert.equal(h.statuses.at(-1).enabled, false);
  assert.equal(h.nativePlayed.length, 0);
  assert.equal(h.audio.length, 0);
});

test('local endpoint validation accepts loopback origins and rejects alternate hosts, paths and credentials', () => {
  for (const [input, expected] of [
    [' http://LOCALHOST:50022/ ', 'http://localhost:50022'],
    ['http://127.0.0.1:65535', 'http://127.0.0.1:65535'],
    ['http://[::1]:50023/', 'http://[::1]:50023'],
    ['http://localhost:80', 'http://localhost']
  ]) assert.equal(normalizeVoicevoxBase(input), expected);
  for (const input of [null, '', 'localhost:50021', 'https://localhost:50021', '//localhost:50021',
    'http://localhost:0', 'http://localhost:65536', 'http://localhost:50021/setting',
    'http://localhost:50021/../', 'http://localhost:50021/%2e/', 'http://localhost:50021?x=1',
    'http://localhost:50021?', 'http://localhost:50021#', 'http://user:pass@localhost:50021',
    'http://@localhost:50021', 'http://localhost.evil.test:50021', 'http://192.168.1.2:50021',
    'http://127.1:50021', 'http://0x7f000001:50021', 'http://[::ffff:127.0.0.1]:50021',
    'http://localhost:50021\\setting']) assert.throws(() => normalizeVoicevoxBase(input), undefined, String(input));
});

test('custom loopback endpoints are used for discovery, query and synthesis without implicit playback', async () => {
  for (const base of ['http://localhost:50022', 'http://[::1]:50023', 'http://127.0.0.1:50024']) {
    const h = harness(), p = preference(h);
    assert.deepEqual(p.control.setBase(base + '/'), { base, saved: true });
    assert.equal(h.requests.length + h.audio.length + h.nativePlayed.length, 0);
    assert.equal(h.statuses.at(-1).enabled, false);
    assert.equal(await p.control.connect(), true);
    assert.equal(h.requests[0].url, base + '/speakers');
    assert.equal(h.statuses.at(-1).enabled, false);
    h.controller.enable(); h.controller.say('設定した接続先のテスト。'); await flush();
    assert.deepEqual(h.requests.map(r => new URL(r.url).origin), [base, base, base]);
    assert.equal(new URL(h.requests[1].url).pathname, '/audio_query');
    assert.equal(h.requests[2].url, base + '/synthesis?speaker=2');
    for (const { options } of h.requests) {
      assert.equal(options.redirect, 'error');
      assert.equal(options.credentials, 'omit');
      assert.equal(options.cache, 'no-store');
    }
    assert.equal(h.audio.length, 1);
    h.audio[0].onended();
  }
});

test('endpoint and existing voice preference survive reload without automatic discovery or activation', async () => {
  const storage = new Map([['qwSpeechVoice', 'voicevox:2'], ['qwPreferVoicevox', 'true']]);
  const h = harness(undefined, { storage }), p = preference(h);
  p.control.setBase('http://localhost:50022');
  const reloaded = harness(undefined, { storage }), pref = preference(reloaded);
  assert.equal(reloaded.adapter.base, 'http://localhost:50022');
  assert.equal(reloaded.connections.at(-1).base, 'http://localhost:50022');
  assert.equal(reloaded.statuses.at(-1).preferredVoice, 'voicevox:2');
  assert.equal(reloaded.statuses.at(-1).enabled, false);
  assert.equal(await pref.control.prepare(), false);
  assert.equal(reloaded.requests.length, 0);
  assert.equal(await pref.control.connect(), true);
  assert.equal(reloaded.statuses.at(-1).preferredVoice, 'voicevox:2');
  assert.equal(reloaded.audio.length + reloaded.nativePlayed.length, 0);
});

test('blocked storage permits custom endpoints for this session and invalid stored URLs fall back visibly', async () => {
  const h = harness(undefined, { storageBlocked: true }), p = preference(h);
  assert.deepEqual(p.control.setBase('http://localhost:50022'), { base: 'http://localhost:50022', saved: false });
  assert.equal(await p.control.connect(), true);
  assert.equal(h.requests[0].url, 'http://localhost:50022/speakers');
  for (const value of ['https://evil.test', 'http://localhost:50021/path', '']) {
    const bad = harness(undefined, { storage: new Map([['qwVoicevoxBase', value]]) });
    assert.equal(bad.adapter.base, VOICEVOX_BASE);
    assert.match(bad.connections.at(-1).message, /無効.*初期値/);
    assert.equal(bad.requests.length, 0);
    preference(bad).control.setBase(VOICEVOX_BASE);
    assert.doesNotMatch(bad.connections.at(-1).message, /無効/);
    assert.equal(bad.storage.get('qwVoicevoxBase'), VOICEVOX_BASE);
  }
});

test('changing endpoint cancels discovery promptly and a late old response cannot clear a new discovery', async () => {
  let releaseOld, releaseNew;
  const h = harness(url => new Promise(resolve => {
    if (url.startsWith(VOICEVOX_BASE)) releaseOld = resolve;
    else releaseNew = resolve;
  })), p = preference(h);
  const old = p.control.connect(); await flush();
  p.control.setBase('http://localhost:50022');
  assert.equal(h.requests[0].options.signal.aborted, true);
  assert.equal(await old, false);
  const next = p.control.connect(); await flush();
  const statusesBefore = h.connections.length;
  releaseOld({ ok: true, json: async () => [{ name: 'Old', styles: [{ id: 7, name: 'Old' }] }] });
  await flush();
  assert.equal(h.connections.length, statusesBefore);
  const same = h.adapter.connect(); await flush();
  assert.equal(h.requests.length, 2);
  releaseNew({ ok: true, json: async () => speakers });
  assert.equal(await next, true);
  assert.equal(await same, true);
  assert.equal(h.connections.at(-1).base, 'http://localhost:50022');
  assert.equal(h.statuses.at(-1).preferredVoice, 'voicevox:2');
  assert.equal(h.timers.size, 0);
  assert.equal(h.audio.length + h.nativePlayed.length, 0);
});

test('saving an invalid or unchanged endpoint leaves active playback and queued speech intact', async () => {
  const h = harness(), p = preference(h);
  await p.control.connect(); h.controller.enable(); h.controller.say('最初。次。'); await flush();
  assert.throws(() => p.control.setBase('http://evil.test:50021'));
  p.control.setBase(VOICEVOX_BASE + '/');
  assert.equal(h.audio[0].pauses, 0);
  assert.equal(h.connections.at(-1).phase, 'ready');
  h.audio[0].onended(); await flush();
  assert.equal(h.audio.length, 2);
  h.audio[1].onended();
});

test('changing endpoint stops each synthesis/playback stage, drops queued text and ignores late results', async () => {
  for (const stage of ['query', 'synthesis', 'blob', 'playback', 'playing']) {
    let release;
    const blob = new Blob(['mock'], { type: 'audio/wav' });
    const query = { ok: true, json: async () => ({}) };
    const synthesis = { ok: true, blob: async () => blob };
    const h = harness(url => {
      if (url.endsWith('/speakers')) return { ok: true, json: async () => speakers };
      if (url.includes('/audio_query')) return stage === 'query' ? new Promise(r => { release = () => r(query); }) : query;
      if (stage === 'synthesis') return new Promise(r => { release = () => r(synthesis); });
      if (stage === 'blob') return { ok: true, blob: () => new Promise(r => { release = () => r(blob); }) };
      return synthesis;
    }), p = preference(h);
    if (stage === 'playback') h.environment.Audio.prototype.play = () => new Promise(r => { release = r; });
    await p.control.connect(); h.controller.enable(); h.controller.say('最初。待機中。'); await flush();
    const oldEnd = h.audio[0]?.onended;
    const oldSignal = h.requests.at(-1).options.signal;
    p.control.setBase('http://localhost:50022');
    const requestsBefore = h.requests.length, audioBefore = h.audio.length;
    assert.equal(oldSignal.aborted, true, stage);
    assert.equal(h.statuses.at(-1).enabled, true, stage);
    assert.equal(h.statuses.at(-1).phase, 'ready', stage);
    assert.equal(h.storage.get('qwSpeechVoice'), 'voicevox:2');
    assert.equal(h.storage.get('qwPreferVoicevox'), 'true');
    assert.equal(h.adapter.environment.speechSynthesis.getVoices().some(v => v.voiceURI.startsWith('voicevox:')), false);
    release?.(); oldEnd?.(); await flush();
    assert.equal(h.requests.length, requestsBefore, stage);
    assert.equal(h.audio.length, audioBefore, stage);
    assert.equal(h.nativePlayed.length, 0, stage);
    assert.equal(h.statuses.at(-1).completed, 0, stage);
    assert.equal(h.connections.at(-1).phase, 'off', stage);
    if (audioBefore) {
      assert.equal(h.audio[0].pauses, 1, stage);
      assert.deepEqual(h.revoked, ['blob:test']);
    }
    assert.equal(h.timers.size, 0, stage);
  }
});

test('discovery HTTP failures expose the status and configured endpoint without response contents', async () => {
  const h = harness(() => ({ ok: false, status: 403, text: async () => 'private detail' }));
  h.adapter.setBase('http://localhost:50022');
  assert.equal(await h.adapter.connect(), false);
  assert.match(h.connections.at(-1).message, /HTTP 403/);
  assert.match(h.connections.at(-1).message, /未特定/);
  assert.doesNotMatch(h.connections.at(-1).message, /private detail/);
  assert.equal(h.connections.at(-1).base, 'http://localhost:50022');
});

function mountSettings(h, p) {
  const elements = new Map();
  for (const id of ['voicevoxBase', 'voicevoxSettingsMessage', 'voicevoxVersion', 'voicevoxEngineSettings', 'voicevoxSettings', 'voicevoxBaseReset']) {
    elements.set(id, { value: '', textContent: '', attributes: {}, handlers: {},
      setAttribute(key, value) { this.attributes[key] = value; },
      addEventListener(type, handler) { this.handlers[type] = handler; }, focus() { this.focused = true; } });
  }
  mountLocalVoicevox({ voicevox: h.adapter, preference: p.control, document: { getElementById: id => elements.get(id) } });
  let prevented = 0;
  return { get: id => elements.get(id), submit(value) {
    elements.get('voicevoxBase').value = value;
    elements.get('voicevoxSettings').handlers.submit({ preventDefault() { prevented++; } });
    assert.ok(prevented);
  } };
}

test('settings UI validates before changing, updates saved links, resets silently and preserves voice preferences', () => {
  const storage = new Map([['qwVoicevoxBase', 'http://localhost:50022'], ['qwSpeechVoice', 'voicevox:7'], ['qwPreferVoicevox', 'true']]);
  const h = harness(undefined, { storage }), p = preference(h), ui = mountSettings(h, p);
  assert.equal(ui.get('voicevoxBase').value, 'http://localhost:50022');
  assert.equal(ui.get('voicevoxVersion').href, 'http://localhost:50022/version');
  ui.submit('http://other-pc:50021');
  assert.equal(ui.get('voicevoxBase').attributes['aria-invalid'], 'true');
  assert.equal(ui.get('voicevoxBase').focused, true);
  assert.equal(ui.get('voicevoxEngineSettings').href, 'http://localhost:50022/setting');
  assert.equal(h.adapter.base, 'http://localhost:50022');
  ui.submit(' http://[::1]:50023/ ');
  assert.equal(ui.get('voicevoxBase').value, 'http://[::1]:50023');
  assert.equal(ui.get('voicevoxVersion').href, 'http://[::1]:50023/version');
  assert.equal(ui.get('voicevoxEngineSettings').href, 'http://[::1]:50023/setting');
  assert.equal(ui.get('voicevoxBase').attributes['aria-invalid'], 'false');
  assert.match(ui.get('voicevoxSettingsMessage').textContent, /保存しました/);
  ui.get('voicevoxBaseReset').handlers.click();
  assert.equal(ui.get('voicevoxBase').value, VOICEVOX_BASE);
  assert.equal(h.storage.get('qwVoicevoxBase'), VOICEVOX_BASE);
  assert.equal(h.storage.get('qwSpeechVoice'), 'voicevox:7');
  assert.equal(h.storage.get('qwPreferVoicevox'), 'true');
  assert.equal(h.statuses.at(-1).enabled, false);
  assert.equal(h.requests.length + h.audio.length + h.nativePlayed.length, 0);
});

test('settings UI explains session-only configuration when storage is blocked', () => {
  const h = harness(undefined, { storageBlocked: true }), p = preference(h), ui = mountSettings(h, p);
  ui.submit('http://localhost:50022');
  assert.match(ui.get('voicevoxSettingsMessage').textContent, /今回のみ/);
  assert.equal(h.adapter.base, 'http://localhost:50022');
  assert.equal(h.requests.length, 0);
});
