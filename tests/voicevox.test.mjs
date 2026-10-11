import test from 'node:test';
import assert from 'node:assert/strict';
import { createVoicevoxEnvironment, voicevoxVoices, VOICEVOX_BASE } from '../js/voicevox.js';
import { createSpeechController } from '../js/speech.js';

const speakers = [{ name: 'Test speaker', styles: [{ id: 2, name: 'Normal', type: 'talk' }, { id: 3, name: 'Singing', type: 'sing' }] }];
const flush = () => new Promise(resolve => setImmediate(resolve));

function harness(fetcher) {
  const requests = [], audio = [], nativePlayed = [], revoked = [], statuses = [], connections = [];
  const timers = new Map();
  const storage = new Map();
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
    localStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) },
    setTimeout: callback => { timers.set(++id, callback); return id; }, clearTimeout: id => timers.delete(id),
    fetch: async (url, options) => {
      requests.push({ url, options });
      if (fetcher) return fetcher(url, options);
      if (url.endsWith('/speakers')) return { ok: true, json: async () => speakers };
      if (url.includes('/audio_query')) return { ok: true, json: async () => ({ accent_phrases: [] }) };
      return { ok: true, blob: async () => new Blob(['mock wav'], { type: 'audio/wav' }) };
    }
  };
  const adapter = createVoicevoxEnvironment({ environment, onStatus: value => connections.push(value) });
  const controller = createSpeechController({ environment: adapter.environment, onStatus: value => statuses.push(value) });
  return { adapter, controller, environment, requests, audio, nativePlayed, revoked, statuses, connections, timers, storage };
}

test('only returned talk styles are exposed and malformed styles are rejected', () => {
  assert.deepEqual(voicevoxVoices(speakers).map(voice => voice.voiceURI), ['voicevox:2']);
  assert.match(voicevoxVoices(speakers)[0].name, /^VOICEVOX: Test speaker/);
  assert.deepEqual(voicevoxVoices([{ name: 'Bad', styles: [{ id: -1, name: 'Bad' }, { id: '2', name: 'Bad' }] }]), []);
  assert.throws(() => voicevoxVoices(null));
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
