import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createCloudVoicevox, mountCloudVoicevox, cloudVoices, cloudAudioUrls,
  CLOUD_VOICES_URL, CLOUD_SYNTHESIS_URL, CLOUD_DEADLINE } from '../js/cloud-voicevox.js';
import { createVoicevoxEnvironment, createVoicevoxPreference } from '../js/voicevox.js';
import { createSpeechController } from '../js/speech.js';
import { createAlarmAnnouncer } from '../js/alarm.js';
import { PUBLIC_FILES } from '../scripts/build.mjs';

const names = ['VOICEVOX:Test (Normal)', null, 'VOICEVOX:Second'];
const directory = 'https://audio1.tts.quest/v1/data/' + 'a'.repeat(64) + '/';
const ticket = { success: true, audioStatusUrl: directory + 'status.json', mp3DownloadUrl: directory + 'audio.mp3' };
const json = (value, options = {}) => new Response(JSON.stringify(value), { ...options,
  headers: { 'Content-Type': 'application/json', ...options.headers } });
const flush = () => new Promise(resolve => setImmediate(resolve));

function harness(fetcher) {
  let time = 100000, next = 0;
  const timers = new Map(), requests = [], statuses = [], audio = [], spoken = [], revoked = [];
  const storage = new Map();
  const browserVoice = { voiceURI: 'browser-ja', name: 'Browser Japanese', lang: 'ja-JP', localService: true };
  const environment = {
    Date: { now: () => time },
    setTimeout(callback, delay) { const id = ++next; timers.set(id, { callback, at: time + delay, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    fetch: async (url, options) => {
      requests.push({ url, options });
      if (fetcher) return fetcher(url, options);
      if (url === CLOUD_VOICES_URL) return json(names);
      if (url === CLOUD_SYNTHESIS_URL) return json(ticket);
      if (url.endsWith('status.json')) return json({ success: true, isAudioReady: true, isAudioError: false });
      return new Response('mock mp3 - not real audio', { headers: { 'Content-Type': 'audio/mpeg' } });
    },
    Audio: class {
      constructor(url) { this.src = url; audio.push(this); }
      async play() { this.played = true; }
      pause() { this.paused = true; }
      removeAttribute() { this.src = ''; }
    },
    URL: { createObjectURL: () => 'blob:mock', revokeObjectURL: url => revoked.push(url) },
    speechSynthesis: { getVoices: () => [browserVoice], addEventListener() {}, cancel() {},
      resume() {}, speak: utterance => spoken.push(utterance) },
    SpeechSynthesisUtterance: class { constructor(text) { this.text = text; } },
    localStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) }
  };
  const transport = createCloudVoicevox({ environment, onStatus: info => statuses.push(info) });
  async function advance(ms) {
    time += ms;
    for (const [id, item] of [...timers]) if (item.at <= time && timers.has(id)) { timers.delete(id); item.callback(); }
    await flush();
  }
  return { environment, transport, requests, statuses, timers, audio, spoken, revoked, storage, advance };
}

async function ready(h) {
  h.transport.setEnabled(true);
  assert.equal(await h.transport.connect(), true);
  return { text: '模擬の読み上げ文。', voice: h.transport.getVoices()[0] };
}

test('cloud is initially off, ignores saved preferences and sends no request without consent', async () => {
  const h = harness();
  h.storage.set('cloudConsent', 'true');
  assert.equal(await h.transport.connect(), false);
  await assert.rejects(h.transport.synthesize({ text: 'No consent', voice: { voiceURI: 'voicevox-cloud:0' } }));
  assert.equal(h.requests.length, 0);
  assert.equal(h.transport.enabled, false);
  assert.deepEqual(h.transport.getVoices(), []);
});

test('speaker indices survive null entries and malformed names are not invented', () => {
  assert.deepEqual(cloudVoices(names).map(v => v.voiceURI), ['voicevox-cloud:0', 'voicevox-cloud:2']);
  assert.ok(cloudVoices(names).every(v => v.localService === false));
  assert.deepEqual(cloudVoices(['Unbranded', null, 3]), []);
  assert.throws(() => cloudVoices({ speakers: names }));
  assert.throws(() => cloudVoices(Array(2049).fill(null)));
});

test('consent discovers metadata once with no synthesis, playback, credentials or referrer', async () => {
  const h = harness(); h.transport.setEnabled(true);
  const [first, second] = await Promise.all([h.transport.connect(), h.transport.connect()]);
  assert.equal(first && second, true);
  assert.equal(h.requests.length, 1);
  const request = h.requests[0];
  assert.equal(request.url, CLOUD_VOICES_URL);
  assert.equal(request.options.credentials, 'omit');
  assert.equal(request.options.referrerPolicy, 'no-referrer');
  assert.equal(request.options.redirect, 'error');
  assert.equal(request.options.cache, 'no-store');
  assert.equal(h.audio.length + h.spoken.length, 0);
  assert.equal(h.storage.size, 0);
});

test('synthesis posts only text and speaker, then validates status before bounded audio download', async () => {
  const h = harness(), utterance = await ready(h);
  const blob = await h.transport.synthesize(utterance);
  assert.equal(blob.type, 'audio/mpeg');
  assert.deepEqual(h.requests.map(r => r.url), [CLOUD_VOICES_URL, CLOUD_SYNTHESIS_URL, ticket.audioStatusUrl, ticket.mp3DownloadUrl]);
  const request = h.requests[1];
  assert.equal(request.options.method, 'POST');
  assert.deepEqual([...new URLSearchParams(request.options.body)], [['speaker', '0'], ['text', utterance.text]]);
  assert.equal(new URL(request.url).search, '');
  assert.equal(request.options.headers.Authorization, undefined);
  assert.equal(h.audio.length, 0);
});

test('provider audio URLs cannot redirect text or requests to other hosts, paths or jobs', () => {
  assert.deepEqual(cloudAudioUrls(ticket), { status: ticket.audioStatusUrl, audio: ticket.mp3DownloadUrl });
  for (const url of ['http://audio1.tts.quest' + new URL(ticket.audioStatusUrl).pathname,
    ticket.audioStatusUrl + '?key=secret', ticket.audioStatusUrl + '#fragment',
    ticket.audioStatusUrl.replace('audio1.tts.quest', 'audio1.tts.quest.evil.test'),
    ticket.audioStatusUrl.replace('audio1.tts.quest', 'user:pass@audio1.tts.quest'),
    ticket.audioStatusUrl.replace('audio1.tts.quest', '127.0.0.1:50021'),
    ticket.audioStatusUrl.replace('status.json', 'other.json')]) {
    assert.throws(() => cloudAudioUrls({ ...ticket, audioStatusUrl: url }));
  }
  assert.throws(() => cloudAudioUrls({ ...ticket, mp3DownloadUrl: ticket.mp3DownloadUrl.replace('audio1.', 'audio2.') }));
});

test('unexpected response URL is rejected before any follow-up request', async () => {
  const h = harness(url => url === CLOUD_VOICES_URL ? json(names) : json({ ...ticket, audioStatusUrl: 'https://evil.test/status.json' }));
  await assert.rejects(h.transport.synthesize(await ready(h)));
  assert.equal(h.requests.length, 2);
});

test('invalid or unselected speakers, empty and long sentences never reach cloud', async () => {
  const h = harness(), utterance = await ready(h);
  for (const u of [{ ...utterance, voice: { voiceURI: 'voicevox-cloud:1' } },
    { ...utterance, text: 'x'.repeat(121) }, { ...utterance, text: ' ' }]) await assert.rejects(h.transport.synthesize(u));
  assert.equal(h.requests.length, 1);
});

test('discovery times out even if fetch ignores abort and late responses cannot restore voices', async () => {
  let resolve;
  const h = harness(() => new Promise(done => { resolve = done; }));
  h.transport.setEnabled(true);
  const pending = h.transport.connect();
  await flush(); await h.advance(CLOUD_DEADLINE);
  assert.equal(await pending, false);
  resolve(json(names)); await flush();
  assert.deepEqual(h.transport.getVoices(), []);
  assert.equal(h.requests.length, 1);
  assert.equal(h.timers.size, 0);
});

test('withdrawal aborts discovery and invalidates replies across re-enable', async () => {
  let resolve;
  const h = harness(() => new Promise(done => { resolve = done; }));
  h.transport.setEnabled(true); const pending = h.transport.connect(); await flush();
  h.transport.setEnabled(false);
  assert.equal(await pending, false);
  assert.equal(h.requests[0].options.signal.aborted, true);
  resolve(json(names)); await flush();
  assert.deepEqual(h.transport.getVoices(), []);
  assert.equal(h.statuses.at(-1).phase, 'off');
});

test('both JSON retryAfter and HTTP Retry-After are respected, including OFF/ON and explicit retries', async () => {
  for (const response of [() => json({ retryAfter: 90 }, { status: 429 }),
    () => json({ retryAfter: 90 }, { status: 503 }),
    () => json({ success: false }, { status: 429, headers: { 'Retry-After': '90' } })]) {
    const h = harness(url => url === CLOUD_VOICES_URL ? json(names) : response());
    await assert.rejects(h.transport.synthesize(await ready(h)));
    h.transport.setEnabled(false); h.transport.setEnabled(true);
    assert.equal(await h.transport.connect(), false);
    await h.advance(89999); assert.equal(await h.transport.connect(), false);
    assert.equal(h.requests.length, 2);
    await h.advance(1); assert.equal(await h.transport.connect(), true);
  }
});

test('polling is bounded and one second apart, then falls back without downloading unfinished audio', async () => {
  const h = harness(url => url === CLOUD_VOICES_URL ? json(names) : url === CLOUD_SYNTHESIS_URL ? json(ticket)
    : json({ success: true, isAudioReady: false, isAudioError: false }));
  const pending = h.transport.synthesize(await ready(h));
  const rejection = assert.rejects(pending);
  await flush(); assert.equal(h.requests.length, 3);
  await h.advance(999); assert.equal(h.requests.length, 3);
  await h.advance(1); assert.equal(h.requests.length, 4);
  await h.advance(1000); assert.equal(h.requests.length, 5);
  await h.advance(1000); assert.equal(h.requests.length, 6);
  await h.advance(1000); await rejection;
  assert.equal(h.requests.length, 6);
  assert.equal(h.statuses.at(-1).reason, 'pending');
  assert.equal(h.timers.size, 0);
});

test('content type, oversized JSON/audio and invalid state cannot become playable audio', async () => {
  const cases = [
    () => new Response('<html>error</html>', { headers: { 'Content-Type': 'text/html' } }),
    () => json(ticket, { headers: { 'Content-Length': '300000' } }),
    () => json({ success: false }),
    () => json({ ...ticket, success: false })
  ];
  for (const response of cases) {
    const h = harness(url => url === CLOUD_VOICES_URL ? json(names) : response());
    await assert.rejects(h.transport.synthesize(await ready(h)));
    assert.equal(h.audio.length, 0);
  }
  const h = harness(url => url === CLOUD_VOICES_URL ? json(names) : url === CLOUD_SYNTHESIS_URL ? json(ticket)
    : url.endsWith('status.json') ? json({ success: true, isAudioReady: true, isAudioError: false })
      : new Response('bad', { headers: { 'Content-Type': 'audio/mpeg', 'Content-Length': '9000000' } }));
  await assert.rejects(h.transport.synthesize(await ready(h)));
});

function adapterHarness(fetcher) {
  const h = harness(fetcher);
  h.cloudStatuses = [];
  h.fallbacks = [];
  h.adapter = createVoicevoxEnvironment({ environment: h.environment, onCloudStatus: info => h.cloudStatuses.push(info),
    onFallback: info => h.fallbacks.push(info) });
  h.speech = createSpeechController({ environment: h.adapter.environment, onStatus: info => h.statuses.push(info) });
  h.enableCloud = async () => {
    h.adapter.cloud.setEnabled(true); assert.equal(await h.adapter.cloud.connect(), true);
    assert.equal(h.speech.setVoice('voicevox-cloud:0'), true);
    h.speech.enable();
  };
  return h;
}

test('adapter uses cloud without a local engine and revokes audio URLs on completion', async () => {
  const h = adapterHarness(); await h.enableCloud();
  h.speech.say('模擬文。'); await flush();
  assert.equal(h.audio.length, 1); assert.equal(h.spoken.length, 0);
  assert.ok(h.requests.every(r => !r.url.includes('127.0.0.1')));
  h.audio[0].onended();
  assert.deepEqual(h.revoked, ['blob:mock']);
  assert.equal(h.statuses.at(-1).completed, 1);
});

test('cloud four-second timeout reads the same sentence once in browser and ignores late completion', async () => {
  let resolve;
  const h = adapterHarness(url => url === CLOUD_VOICES_URL ? json(names) : new Promise(done => { resolve = done; }));
  await h.enableCloud(); h.speech.say('期限付きの模擬文。'); await flush();
  await h.advance(CLOUD_DEADLINE);
  assert.equal(h.spoken.length, 1); assert.equal(h.spoken[0].text, '期限付きの模擬文。');
  assert.equal(h.spoken[0].voice.voiceURI, 'browser-ja');
  assert.equal(h.cloudStatuses.at(-1).reason, 'timeout');
  assert.match(h.cloudStatuses.at(-1).message, /4秒以内/);
  resolve(json(ticket)); await flush();
  assert.equal(h.requests.length, 2); assert.equal(h.audio.length, 0);
  h.spoken[0].onstart(); h.spoken[0].onend();
  assert.equal(h.statuses.at(-1).enabled, true);
});

test('audio becoming ready after the third poll still plays within the original four-second deadline', async () => {
  let polls = 0;
  const h = adapterHarness(url => url === CLOUD_VOICES_URL ? json(names) : url === CLOUD_SYNTHESIS_URL ? json(ticket)
    : url.endsWith('status.json') ? json({ success: true, isAudioReady: ++polls === 4, isAudioError: false })
      : new Response('mock mp3', { headers: { 'Content-Type': 'audio/mpeg' } }));
  await h.enableCloud(); h.speech.say('三秒後に完成する模擬文。'); await flush();
  for (let second = 0; second < 3; second++) await h.advance(1000);
  assert.equal(polls, 4);
  assert.equal(h.audio.length, 1);
  assert.equal(h.spoken.length, 0);
  assert.equal(h.cloudStatuses.at(-1).phase, 'ready');
  assert.ok(h.requests.every(r => !r.url.includes('127.0.0.1')));
  h.audio[0].onended();
});

test('rate limit reason and remaining wait survive reconnect and browser fallback without more requests', async () => {
  const h = adapterHarness(url => url === CLOUD_VOICES_URL ? json(names)
    : json({ retryAfter: 90 }, { status: 429 }));
  await h.enableCloud(); h.speech.say('利用制限の模擬文。'); await flush();
  assert.equal(h.cloudStatuses.at(-1).reason, 'limited');
  assert.match(h.cloudStatuses.at(-1).message, /あと90秒/);
  assert.equal(h.spoken.length, 1);
  h.spoken[0].onend();
  await h.advance(10000);
  assert.equal(await h.adapter.cloud.connect(), false);
  assert.match(h.cloudStatuses.at(-1).message, /あと80秒/);
  h.speech.say('再試行待ちの模擬文。'); await flush();
  assert.equal(h.cloudStatuses.at(-1).reason, 'limited');
  assert.equal(h.spoken.length, 2);
  assert.equal(h.requests.length, 2);
});

test('metadata discovery does not claim successful speech and network failures remain distinguishable', async () => {
  const h = harness(); await ready(h);
  assert.match(h.statuses.at(-1).message, /音声合成は未確認/);
  const failed = harness(() => { throw new TypeError('Hidden private network detail'); });
  failed.transport.setEnabled(true);
  assert.equal(await failed.transport.connect(), false);
  assert.equal(failed.statuses.at(-1).reason, 'network');
  assert.doesNotMatch(failed.statuses.at(-1).message, /Hidden private/);
});

test('cloud voice preference and activation work with no local-client discovery', async () => {
  const h = adapterHarness();
  h.storage.set('qwSpeechVoice', 'voicevox-cloud:0');
  const preference = createVoicevoxPreference({ voicevox: h.adapter, speech: h.speech, environment: h.environment,
    isEnabled: () => h.statuses.at(-1).enabled });
  h.speech.enable();
  assert.equal(await preference.prepare(), false);
  assert.equal(h.requests.length, 0);
  await h.enableCloud();
  h.speech.say('アプリ不要の模擬文。'); await flush();
  assert.equal(h.audio.length, 1);
  assert.equal(h.spoken.length, 0);
  assert.ok(h.requests.every(r => new URL(r.url).protocol === 'https:' && !r.url.includes('127.0.0.1')));
  h.audio[0].onended();
});

test('OFF, interruption and alarm hold abort old requests without late speech', async () => {
  for (const action of ['disable', 'stop', 'hold']) {
    let resolve;
    const h = adapterHarness(url => url === CLOUD_VOICES_URL ? json(names) : new Promise(done => { resolve = done; }));
    await h.enableCloud(); h.speech.say('古い模擬文。'); await flush();
    h.speech[action]();
    resolve(json(ticket)); await flush();
    assert.equal(h.requests[1].options.signal.aborted, true);
    assert.equal(h.audio.length + h.spoken.length, 0);
  }
});

test('alarm playback starts before any cloud synthesis and caution remains queued until sound ends', async () => {
  const h = adapterHarness(); await h.enableCloud();
  let ended, sounds = 0;
  const announcer = createAlarmAnnouncer({ speech: h.speech, alarm: {
    play({ onComplete }) { sounds++; ended = onComplete; return true; }, stop() {}
  } });
  announcer.announce('続報の模擬文。', { sound: true });
  assert.equal(sounds, 1); assert.equal(h.requests.length, 1);
  ended(); await flush();
  assert.equal(h.requests[1].url, CLOUD_SYNTHESIS_URL);
  assert.equal(new URLSearchParams(h.requests[1].options.body).get('text'), '強い揺れに警戒してください。');
});

test('autoplay denial is not bypassed with browser speech', async () => {
  const h = adapterHarness();
  h.environment.Audio.prototype.play = async () => { throw new DOMException('Denied', 'NotAllowedError'); };
  await h.enableCloud(); h.speech.say('再生拒否の模擬文。'); await flush();
  assert.equal(h.spoken.length, 0);
  assert.equal(h.statuses.at(-1).phase, 'error');
  assert.deepEqual(h.revoked, ['blob:mock']);
});

test('audio loading failure and a late play rejection produce browser fallback at most once', async () => {
  const h = adapterHarness();
  let rejectPlay;
  h.environment.Audio.prototype.play = () => new Promise((_, reject) => { rejectPlay = reject; });
  await h.enableCloud(); h.speech.say('一回だけの模擬文。'); await flush();
  h.audio[0].onerror();
  rejectPlay(new Error('Late load failure')); await flush();
  assert.equal(h.spoken.length, 1);
  assert.equal(h.revoked.length, 1);
});

test('rapid following sentences do not burst synthesis requests', async () => {
  const h = harness(), utterance = await ready(h);
  await h.transport.synthesize(utterance);
  await assert.rejects(h.transport.synthesize(utterance));
  assert.equal(h.requests.length, 4);
  await h.advance(2000); await h.transport.synthesize(utterance);
  assert.equal(h.requests.length, 7);
});

test('browser fallback explains rapid following sentences without starting another cloud request', async () => {
  const h = adapterHarness(); await h.enableCloud();
  h.speech.say('最初の模擬文。次の模擬文。'); await flush();
  assert.equal(h.audio.length, 1);
  assert.equal(h.fallbacks.at(-1), null);
  h.audio[0].onended(); await flush();
  assert.equal(h.spoken.length, 1);
  assert.equal(h.fallbacks.at(-1).reason, 'interval');
  assert.match(h.fallbacks.at(-1).message, /2秒未満/);
  assert.equal(h.requests.length, 4);
});

test('cloud timeout retains a public safe reason until actual VOICEVOX playback succeeds', async () => {
  let never = true;
  const h = adapterHarness(url => url === CLOUD_VOICES_URL ? json(names) : never ? new Promise(() => {})
    : url === CLOUD_SYNTHESIS_URL ? json(ticket) : url.endsWith('status.json')
      ? json({ success: true, isAudioReady: true, isAudioError: false })
      : new Response('mock mp3', { headers: { 'Content-Type': 'audio/mpeg' } }));
  await h.enableCloud(); h.speech.say('期限超過の模擬文。'); await flush(); await h.advance(CLOUD_DEADLINE);
  assert.equal(h.fallbacks.at(-1).reason, 'timeout');
  assert.match(h.fallbacks.at(-1).message, /4秒以内/);
  assert.equal(h.fallbacks.at(-1).retryAt, 134000);
  h.spoken[0].onend(); await h.advance(30000); never = false;
  assert.equal(await h.adapter.cloud.connect(), true);
  assert.equal(h.fallbacks.at(-1).reason, 'timeout');
  h.speech.say('復旧した模擬文。'); await flush();
  assert.equal(h.audio.length, 1);
  assert.equal(h.fallbacks.at(-1), null);
  h.audio[0].onended();
});

test('metadata failure and cloud audio loading failure each expose a reason without raw network details', async () => {
  const blocked = adapterHarness(() => { throw new TypeError('private URL must not appear'); });
  blocked.adapter.cloud.setEnabled(true);
  assert.equal(await blocked.adapter.cloud.connect(), false);
  assert.equal(blocked.fallbacks.at(-1).reason, 'network');
  assert.doesNotMatch(blocked.fallbacks.at(-1).message, /private URL/);
  const h = adapterHarness(); await h.enableCloud();
  h.environment.Audio.prototype.play = async () => { throw new Error('private audio URL'); };
  h.speech.say('再生失敗の模擬文。'); await flush();
  assert.equal(h.fallbacks.at(-1).reason, 'playback');
  assert.doesNotMatch(h.fallbacks.at(-1).message, /private audio URL/);
  assert.equal(h.spoken.length, 1);
});

test('consent UI never enables speech, resets on pagehide and cannot select after withdrawal', async () => {
  const events = {}, handlers = {}, elements = {};
  for (const id of ['cloudVoicevoxConsent', 'cloudVoicevoxRetry']) elements[id] = {
    checked: false, disabled: true, addEventListener(type, fn) { handlers[id + '/' + type] = fn; }
  };
  const h = adapterHarness();
  h.environment.document = { getElementById: id => elements[id] };
  h.environment.addEventListener = (type, fn) => { events[type] = fn; };
  const choices = [], preference = { setPreferred: value => choices.push(value), selectVoice: id => h.speech.setVoice(id) };
  const ui = mountCloudVoicevox({ environment: h.environment, voicevox: h.adapter, speech: h.speech, preference });
  assert.equal(h.requests.length, 0);
  elements.cloudVoicevoxConsent.checked = true;
  handlers['cloudVoicevoxConsent/change'](); await flush();
  assert.equal(h.statuses.at(-1).enabled, false);
  assert.equal(h.statuses.at(-1).preferredVoice, 'voicevox-cloud:0');
  assert.equal(h.requests.length, 1);
  assert.equal(h.audio.length + h.spoken.length, 0);
  events.pagehide();
  assert.equal(elements.cloudVoicevoxConsent.checked, false);
  assert.equal(h.adapter.cloud.enabled, false);
  assert.equal(ui.selectVoice('voicevox-cloud:0'), false);
  assert.equal(h.requests.length, 1);
});

test('public app ships consent UI and module while keeping cloud responses outside SW cache', async () => {
  const root = new URL('../', import.meta.url);
  const html = await readFile(new URL('index.html', root), 'utf8');
  const app = await readFile(new URL('js/app.js', root), 'utf8');
  const sw = await readFile(new URL('sw.js', root), 'utf8');
  assert.match(html, /id="cloudVoicevoxConsent"[^>]*aria-describedby="cloudVoicevoxNotice"/);
  assert.doesNotMatch(html.match(/<input id="cloudVoicevoxConsent"[^>]*>/)[0], /checked/);
  assert.match(html, /非公式のtts.questへ読み上げ文を送信/);
  assert.match(app, /mountCloudVoicevox\(\{ voicevox, speech, preference: voicevoxPreference \}\)/);
  assert.match(app, /cloudVoicevox\.selectVoice\(event.target.value\)/);
  assert.match(sw, /url.origin !== SCOPE.origin/);
  assert.match(sw, /\.\/js\/cloud-voicevox.js/);
  assert.ok(PUBLIC_FILES.includes('js/cloud-voicevox.js'));
});
