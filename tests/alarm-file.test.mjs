import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createAlarmController, createAlarmAnnouncer } from '../js/alarm.js';
import { createSpeechController } from '../js/speech.js';

const soundUrl = 'https://example.test/quakewatch-v15/audio/eew-alarm.mp3';
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function harness({ fetch, decode, fileFailure } = {}) {
  const files = [], tones = [], gains = [], statuses = [], requests = [], decodes = [], timers = new Map();
  let timerId = 0;
  const parameter = () => ({
    events: [],
    setValueAtTime(value, at) { this.events.push({ value, at }); },
    linearRampToValueAtTime(value, at) { this.events.push({ value, at }); }
  });
  const source = () => ({
    starts: [], stops: [], disconnected: false,
    connect() {}, disconnect() { this.disconnected = true; },
    start(at) { this.starts.push(at); }, stop(at) { this.stops.push(at); }
  });
  const decoded = { duration: 3.768 };
  class Context {
    state = 'suspended'; currentTime = 10; destination = {};
    async resume() { this.state = 'running'; }
    async decodeAudioData(bytes) { decodes.push(bytes); return decode ? decode(bytes) : decoded; }
    createBufferSource() {
      if (fileFailure === 'create') throw new Error('Buffer source unavailable');
      const node = source();
      if (fileFailure === 'start') node.start = () => { throw new Error('Playback unavailable'); };
      files.push(node);
      return node;
    }
    createOscillator() {
      const node = { ...source(), frequency: parameter() };
      tones.push(node);
      return node;
    }
    createGain() {
      const node = { gain: parameter(), disconnected: false, connect() {}, disconnect() { this.disconnected = true; } };
      gains.push(node);
      return node;
    }
  }
  const environment = {
    AudioContext: Context,
    async fetch(url, options) {
      requests.push({ url, options });
      return fetch ? fetch(url, options) : { ok: true, arrayBuffer: async () => new ArrayBuffer(8) };
    },
    setTimeout(callback, delay) { const id = ++timerId; timers.set(id, { callback, delay }); return id; },
    clearTimeout(id) { timers.delete(id); }
  };
  const alarm = createAlarmController({ soundUrl, environment, onStatus: info => statuses.push(info) });
  return { alarm, files, tones, gains, statuses, requests, decodes, timers, decoded,
    status: () => statuses.at(-1) };
}

function withSpeech(h) {
  const spoken = [], statuses = [];
  const speech = createSpeechController({ environment: {
    speechSynthesis: { getVoices: () => [], addEventListener() {}, cancel() {}, speak: utterance => spoken.push(utterance) },
    SpeechSynthesisUtterance: class { constructor(text) { this.text = text; } },
    setTimeout: () => 1, clearTimeout() {}
  }, onStatus: info => statuses.push(info) });
  return { ...h, speech, spoken, announcer: createAlarmAnnouncer({ alarm: h.alarm, speech }),
    speechStatus: () => statuses.at(-1),
    finishSpeech() { spoken.at(-1).onstart(); spoken.at(-1).onend(); } };
}

test('configured MP3 stays silent and unloaded until activation, then is decoded only once', async () => {
  const h = harness();
  assert.equal(h.alarm.play(), false);
  assert.equal(h.requests.length, 0);
  assert.equal(h.status().phase, 'off');
  assert.equal(await h.alarm.enable(), true);
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].url, soundUrl);
  assert.equal(h.requests[0].options.redirect, 'error');
  assert.equal(h.decodes.length, 1);
  assert.equal(h.files.length, 0);
  assert.equal(h.tones.length, 0);
  assert.equal(h.status().source, 'file');
  assert.equal(h.status().assetPhase, 'ready');
  assert.equal(h.status().duration, 3.768);
  assert.equal(h.timers.size, 0);
  h.alarm.disable();
  assert.equal(await h.alarm.enable(), true);
  assert.equal(h.requests.length, 1);
  assert.equal(h.files.length, 0);
});

test('MP3 plays in full without looping and completion fires only at natural end', async () => {
  const h = harness();
  await h.alarm.enable();
  let completed = 0;
  assert.equal(h.alarm.play({ onComplete: () => completed++ }), true);
  const file = h.files[0], events = h.gains[0].gain.events;
  assert.equal(file.buffer, h.decoded);
  assert.equal(file.loop, false);
  assert.deepEqual(file.starts, [10.02]);
  assert.deepEqual(file.stops, []);
  assert.equal(h.tones.length, 0);
  assert.equal(h.status().phase, 'playing');
  assert.equal(h.status().played, 1);
  assert.ok(events.every(event => event.value >= 0 && event.value <= 0.14));
  assert.equal(events.at(-1).at, file.starts[0] + h.decoded.duration);
  assert.equal(events.at(-1).value, 0);
  assert.equal(completed, 0);
  file.onended(); file.onended();
  assert.equal(completed, 1);
  assert.equal(file.disconnected, true);
  assert.equal(h.gains[0].disconnected, true);
  assert.equal(h.status().phase, 'armed');
});

test('new MP3 alert stops the previous source and ignores its late completion', async () => {
  const h = harness();
  await h.alarm.enable();
  let oldCompleted = 0, newCompleted = 0;
  h.alarm.play({ onComplete: () => oldCompleted++ });
  h.alarm.play({ onComplete: () => newCompleted++ });
  assert.deepEqual(h.files[0].stops, [undefined]);
  h.files[0].onended();
  assert.equal(oldCompleted, 0);
  assert.equal(h.status().phase, 'playing');
  assert.equal(h.gains[0].disconnected, true);
  h.files[1].onended();
  assert.equal(newCompleted, 1);
  assert.equal(h.status().played, 2);
});

test('MP3 natural end precedes the caution and the latest EEW speech', async () => {
  const h = withSpeech(harness());
  await h.alarm.enable(); h.speech.enable();
  h.announcer.announce('第1報。', { sound: true });
  h.announcer.announce('第2報。');
  assert.equal(h.spoken.length, 0);
  h.files[0].onended();
  assert.equal(h.spoken[0].text, '強い揺れに警戒してください。');
  h.files[0].onended();
  assert.equal(h.spoken.length, 1);
  h.finishSpeech();
  assert.equal(h.spoken[1].text, '第2報。');
  assert.ok(!h.spoken.some(utterance => utterance.text === '第1報。'));
});

test('replaced MP3 callbacks cannot repeat the caution or release speech early', async () => {
  const h = withSpeech(harness());
  await h.alarm.enable(); h.speech.enable();
  h.announcer.announce('第1報。', { sound: true });
  h.announcer.announce('強まった第2報。', { sound: true });
  h.files[0].onended();
  assert.equal(h.spoken.length, 0);
  h.files[1].onended(); h.finishSpeech();
  assert.equal(h.spoken[1].text, '強まった第2報。');
});

test('MP3 cancellation stops playback, suppresses caution, and preserves cancellation speech', async () => {
  const h = withSpeech(harness());
  await h.alarm.enable(); h.speech.enable();
  h.announcer.announce('警報。', { sound: true });
  h.announcer.cancel();
  h.announcer.announce('緊急地震速報は取り消されました。');
  h.files[0].onended();
  assert.deepEqual(h.files[0].stops, [undefined]);
  assert.deepEqual(h.spoken.map(utterance => utterance.text), ['緊急地震速報は取り消されました。']);
});

test('alarm OFF stops the MP3 and cancels its queued caution', async () => {
  const h = withSpeech(harness());
  await h.alarm.enable(); h.speech.enable();
  h.announcer.announce('警報。', { sound: true });
  h.announcer.cancel(); h.alarm.disable(); h.files[0].onended();
  assert.equal(h.spoken.length, 0);
  assert.equal(h.status().phase, 'off');
  assert.equal(h.alarm.play(), false);
  assert.equal(h.files[0].disconnected, true);
});

test('MP3 completion never enables speech that was OFF or disabled during playback', async () => {
  const h = withSpeech(harness());
  await h.alarm.enable();
  h.announcer.announce('第1報。', { sound: true }); h.files[0].onended();
  assert.equal(h.spoken.length, 0);
  assert.equal(h.speechStatus().enabled, false);
  h.speech.enable();
  h.announcer.announce('第2報。', { sound: true }); h.speech.disable(); h.files[1].onended();
  assert.equal(h.spoken.length, 0);
  assert.equal(h.speechStatus().phase, 'off');
});

test('OFF during MP3 fetch promptly cancels activation and cannot install a late buffer', async () => {
  const response = deferred();
  const h = harness({ fetch: () => response.promise });
  const activation = h.alarm.enable();
  await tick();
  assert.equal(h.status().assetPhase, 'loading');
  h.alarm.disable();
  assert.equal(await activation, false);
  assert.equal(h.requests[0].options.signal.aborted, true);
  assert.equal(h.timers.size, 0);
  response.resolve({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) });
  await tick();
  assert.equal(h.status().phase, 'off');
  assert.equal(h.status().assetPhase, 'unloaded');
  assert.equal(h.status().source, 'tone');
  assert.equal(h.alarm.play(), false);
});

test('OFF during MP3 decoding cannot re-enable the controller or retain stale audio', async () => {
  const decode = deferred();
  const h = harness({ decode: () => decode.promise });
  const activation = h.alarm.enable();
  await tick();
  assert.equal(h.decodes.length, 1);
  h.alarm.disable();
  assert.equal(await activation, false);
  decode.resolve({ duration: 3.768 });
  await tick();
  assert.equal(h.status().source, 'tone');
  assert.equal(h.status().phase, 'off');
  assert.equal(h.files.length, 0);
  assert.equal(h.timers.size, 0);
});

test('a repeated activation discards the earlier decode and uses only the current buffer', async () => {
  const first = deferred(), second = deferred();
  let decodes = 0;
  const h = harness({ decode: () => (++decodes === 1 ? first.promise : second.promise) });
  const oldActivation = h.alarm.enable();
  await tick();
  const newActivation = h.alarm.enable();
  await tick();
  assert.equal(await oldActivation, false);
  const newBuffer = { duration: 4 };
  second.resolve(newBuffer);
  assert.equal(await newActivation, true);
  first.resolve({ duration: 2 });
  await tick();
  h.alarm.play();
  assert.equal(h.files[0].buffer, newBuffer);
  assert.equal(h.status().duration, 4);
  assert.equal(h.timers.size, 0);
});

test('alerts remain usable during loading and finishing the decode does not end a playing fallback', async () => {
  const decode = deferred();
  const h = harness({ decode: () => decode.promise });
  const activation = h.alarm.enable();
  await tick();
  assert.equal(h.alarm.play(), true);
  assert.equal(h.tones.length, 1);
  decode.resolve({ duration: 3.768 });
  assert.equal(await activation, true);
  assert.equal(h.status().phase, 'playing');
  assert.equal(h.tones[0].stops.length, 1);
  h.tones[0].onended();
  assert.equal(h.status().phase, 'armed');
  assert.equal(h.alarm.play(), true);
  assert.equal(h.files.length, 1);
});

test('MP3 failures visibly fall back to the original tone without disabling alerts', async t => {
  const cases = [
    ['network', { fetch: async () => { throw new Error('offline'); } }],
    ['HTTP', { fetch: async () => ({ ok: false }) }],
    ['empty file', { fetch: async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(0) }) }],
    ['oversized file', { fetch: async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(2000001) }) }],
    ['decoder', { decode: async () => { throw new Error('invalid MP3'); } }],
    ...[0, -1, 31, Infinity, NaN].map(duration => [`invalid duration ${duration}`, { decode: async () => ({ duration }) }])
  ];
  for (const [name, options] of cases) await t.test(name, async () => {
    const h = harness(options);
    assert.equal(await h.alarm.enable(), true);
    assert.equal(h.status().enabled, true);
    assert.equal(h.status().assetPhase, 'error');
    assert.match(h.status().assetWarning, /既存の警報音/);
    assert.equal(h.alarm.play(), true);
    assert.equal(h.files.length, 0);
    assert.equal(h.tones[0].type, 'sawtooth');
    assert.deepEqual(h.tones[0].stops, [12.57]);
    assert.equal(h.timers.size, 0);
  });
});

test('MP3 loading has a bounded timeout and late completion cannot replace the fallback', async () => {
  const decode = deferred();
  const h = harness({ decode: () => decode.promise });
  const activation = h.alarm.enable();
  await tick();
  const timer = [...h.timers.values()][0];
  assert.equal(timer.delay, 5000);
  timer.callback();
  assert.equal(await activation, true);
  assert.equal(h.status().assetPhase, 'error');
  assert.equal(h.alarm.play(), true);
  decode.resolve({ duration: 3.768 });
  await tick();
  assert.equal(h.status().source, 'tone');
  assert.equal(h.status().phase, 'playing');
  assert.equal(h.timers.size, 0);
});

test('MP3 source creation or playback failure falls back once and preserves completion speech', async t => {
  for (const fileFailure of ['create', 'start']) await t.test(fileFailure, async () => {
    const h = withSpeech(harness({ fileFailure }));
    await h.alarm.enable(); h.speech.enable();
    h.announcer.announce('テスト速報。', { sound: true });
    assert.equal(h.status().enabled, true);
    assert.equal(h.status().played, 1);
    assert.equal(h.status().source, 'tone');
    assert.match(h.status().assetWarning, /再生できません/);
    if (h.files.length) {
      h.files[0].onended();
      assert.equal(h.files[0].disconnected, true);
    }
    assert.equal(h.spoken.length, 0);
    assert.equal(h.tones.length, 1);
    h.tones[0].onended();
    assert.equal(h.spoken[0].text, '強い揺れに警戒してください。');
    h.finishSpeech();
    assert.equal(h.spoken[1].text, 'テスト速報。');
  });
});

test('the public app uses the original generated alarm without fetching unverified audio', async () => {
  const app = await readFile(new URL('../js/app.js', import.meta.url), 'utf8');
  assert.match(app, /createAlarmController\(\{ soundUrl: null/);
  assert.doesNotMatch(app, /new URL\('\.\.\/audio\/eew-alarm\.mp3'/);
  assert.match(app, /qwAlarmAsset = info\.assetPhase/);
});
