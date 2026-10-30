import { createCloudVoicevox, cloudFallbackDetails, CLOUD_VOICE_PREFIX } from './cloud-voicevox.js';

export const VOICEVOX_BASE = 'http://127.0.0.1:50021';
const BASE_STORAGE_KEY = 'qwVoicevoxBase';

export function normalizeVoicevoxBase(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  const match = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(?::([0-9]{1,5}))?\/?$/i.exec(text);
  if (!match || (match[2] && (Number(match[2]) < 1 || Number(match[2]) > 65535))) {
    throw new Error('接続先は http://127.0.0.1:50021 のように、このPCの127.0.0.1・localhost・[::1]とポート番号を指定してください。追加パス・認証情報・クエリは使えません。');
  }
  return new URL(text).origin;
}

export function voicevoxVoices(speakers) {
  if (!Array.isArray(speakers)) throw new Error('Invalid speaker list');
  return speakers.flatMap(speaker => {
    if (typeof speaker.name !== 'string' || !Array.isArray(speaker.styles)) return [];
    return speaker.styles.filter(style => Number.isInteger(style.id) && style.id >= 0
      && typeof style.name === 'string' && (!style.type || style.type === 'talk' || style.type === 'streaming_talk'))
      .map(style => ({ voiceURI: `voicevox:${style.id}`, name: `VOICEVOX: ${speaker.name}（${style.name}）`,
        lang: 'ja-JP', localService: true, default: false }));
  });
}

export function createVoicevoxEnvironment({ environment = window, onStatus = () => {}, onCloudStatus = () => {}, onFallback = () => {} } = {}) {
  const native = environment.speechSynthesis;
  const browserSupported = Boolean(native && environment.SpeechSynthesisUtterance);
  const localSupported = Boolean(environment.fetch && environment.Audio && environment.URL?.createObjectURL);
  const listeners = new Set();
  let storage, base = VOICEVOX_BASE, invalidSavedBase = false;
  try {
    storage = environment.localStorage;
    const saved = storage?.getItem(BASE_STORAGE_KEY);
    if (saved != null) {
      try { base = normalizeVoicevoxBase(saved); } catch { invalidSavedBase = true; }
    }
  } catch {}
  const reportLocal = info => onStatus({ ...info, base });
  let voices = [];
  let connecting = null;
  let serial = 0;
  let active = null;
  let browserFallback = false;
  const notify = () => listeners.forEach(listener => listener());
  const fetcher = environment.fetch?.bind(environment);
  const cloud = createCloudVoicevox({ environment, onStatus(info) {
    notify(); onCloudStatus(info);
    if (info.phase === 'fallback' && !active?.utterance.voice?.voiceURI?.startsWith(CLOUD_VOICE_PREFIX)) {
      onFallback(cloudFallbackDetails(info));
    }
  } });

  async function connect() {
    if (connecting) return connecting.promise;
    if (!localSupported) {
      reportLocal({ phase: 'error', message: 'このブラウザではVOICEVOXを利用できません' });
      return false;
    }
    reportLocal({ phase: 'connecting', message: 'VOICEVOXへ接続中（この端末）' });
    const controller = new AbortController();
    const record = { controller, base };
    connecting = record;
    let timer, timedOut = false, stage = 'connection', httpStatus = 0;
    const timeout = new Promise((_, reject) => {
      controller.signal.addEventListener('abort', () => reject(new Error('Discovery cancelled')), { once: true });
      timer = environment.setTimeout(() => { timedOut = true; controller.abort(); }, 5000);
    });
    record.promise = Promise.resolve().then(async () => {
      try {
        const next = await Promise.race([Promise.resolve().then(async () => {
          if (controller.signal.aborted) throw new Error('Discovery cancelled');
          const response = await fetcher(`${record.base}/speakers`, {
            signal: controller.signal, cache: 'no-store', redirect: 'error', credentials: 'omit', referrerPolicy: 'no-referrer'
          });
          httpStatus = response.status;
          if (!response.ok) throw new Error('speakers');
          stage = 'format';
          const found = voicevoxVoices(await response.json());
          stage = 'voices';
          if (!found.length) throw new Error('No talk styles');
          return found;
        }), timeout]);
        if (connecting !== record) return false;
        if (controller.signal.aborted) throw new Error('Discovery cancelled');
        voices = next;
        notify();
        reportLocal({ phase: 'ready', message: `VOICEVOX接続済み・${voices.length}音声（この端末）` });
        return true;
      } catch {
        if (connecting !== record) return false;
        voices = [];
        notify();
        const message = (timedOut ? 'PC内VOICEVOXの接続確認が5秒以内に完了しませんでした。'
          : stage === 'voices' ? 'VOICEVOXは応答しましたが、読み上げ用の話者がありません（対応形式を確認）。'
          : stage === 'format' ? 'VOICEVOXの話者一覧の形式を確認できませんでした。'
          : 'PC内VOICEVOXへ接続できませんでした（未起動・通信・接続許可等は未特定）。')
          + (Number.isInteger(httpStatus) && httpStatus >= 400 && httpStatus <= 599 ? `（HTTP ${httpStatus}）` : '');
        reportLocal({ phase: 'error', message: message
          + (browserSupported ? ' ブラウザ標準を使用' : ' ブラウザ標準も未対応') });
        if (browserSupported && browserFallback) onFallback({ source: 'local', reason: 'discovery', message });
        return false;
      } finally {
        environment.clearTimeout(timer);
        if (connecting === record) connecting = null;
      }
    });
    return record.promise;
  }

  function setBase(value) {
    const next = normalizeVoicevoxBase(value);
    const changed = base !== next;
    if (changed) {
      const old = connecting;
      connecting = null;
      old?.controller.abort();
      cancel();
      base = next;
      voices = [];
      notify();
      onFallback(null);
    }
    let saved = false;
    try { if (storage) { storage.setItem(BASE_STORAGE_KEY, base); saved = true; } } catch {}
    if (changed || invalidSavedBase) {
      reportLocal({ phase: 'off', message: '接続先を設定しました。「このPCへ接続」で確認してください。' });
      invalidSavedBase = false;
    }
    return { base, saved };
  }

  function dispose(record) {
    record.controller?.abort();
    if (record.audio) {
      record.audio.onended = null;
      record.audio.onerror = null;
      record.audio.pause();
      record.audio.removeAttribute('src');
      record.audio = null;
    }
    if (record.url) { environment.URL.revokeObjectURL(record.url); record.url = null; }
  }

  function cancel() {
    serial++;
    const old = active;
    active = null;
    if (old) dispose(old);
    native?.cancel();
  }

  function settle(record, error) {
    if (active !== record || record.serial !== serial) return;
    active = null;
    dispose(record);
    if (error) record.utterance.onerror?.({ error });
    else record.utterance.onend?.();
  }

  function speakBrowser(record) {
    if (!browserSupported) { settle(record, 'synthesis-unavailable'); return; }
    const utterance = record.utterance;
    const nativeUtterance = new environment.SpeechSynthesisUtterance(utterance.text);
    for (const key of ['lang', 'rate', 'pitch', 'volume']) nativeUtterance[key] = utterance[key];
    if (utterance.voice?.voiceURI?.startsWith('voicevox:') || utterance.voice?.voiceURI?.startsWith(CLOUD_VOICE_PREFIX)) {
      const japanese = native.getVoices().filter(voice => /^ja(?:[-_]|$)/i.test(voice.lang));
      nativeUtterance.voice = japanese.find(voice => voice.localService && voice.default)
        || japanese.find(voice => voice.localService) || japanese.find(voice => voice.default) || japanese[0] || null;
    } else if (utterance.voice) nativeUtterance.voice = utterance.voice;
    nativeUtterance.onstart = () => { if (active === record) utterance.onstart?.(); };
    nativeUtterance.onend = () => settle(record);
    nativeUtterance.onerror = event => settle(record, event.error);
    try { native.speak(nativeUtterance); } catch { settle(record, 'synthesis-unavailable'); }
  }

  async function speakLocal(record) {
    const localBase = base;
    const utterance = record.utterance;
    const speaker = Number(utterance.voice.voiceURI.slice('voicevox:'.length));
    if (!Number.isInteger(speaker) || speaker < 0) { settle(record, 'voice-unavailable'); return; }
    const controller = new AbortController();
    record.controller = controller;
    const options = { method: 'POST', signal: controller.signal, cache: 'no-store', redirect: 'error',
      credentials: 'omit', referrerPolicy: 'no-referrer' };
    let stage = 'query', httpStatus = 0;
    try {
      const queryUrl = new URL(`${localBase}/audio_query`);
      queryUrl.searchParams.set('text', utterance.text);
      queryUrl.searchParams.set('speaker', String(speaker));
      const queryResponse = await fetcher(queryUrl.href, options);
      httpStatus = queryResponse.status;
      if (!queryResponse.ok) throw new Error('audio_query');
      const query = await queryResponse.json();
      if (active !== record) return;
      query.speedScale = utterance.rate;
      query.volumeScale = Math.max(0, Math.min(1, utterance.volume));
      stage = 'synthesis'; httpStatus = 0;
      const response = await fetcher(`${localBase}/synthesis?speaker=${speaker}`, {
        ...options, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(query)
      });
      httpStatus = response.status;
      if (!response.ok) throw new Error('synthesis');
      stage = 'audio';
      const blob = await response.blob();
      if (active !== record) return;
      if (!blob.size || !/^(audio\/|application\/octet-stream)/i.test(blob.type)) throw new Error('audio');
      record.url = environment.URL.createObjectURL(blob);
      const audio = new environment.Audio(record.url);
      record.audio = audio;
      audio.onended = () => settle(record);
      audio.onerror = () => settle(record, 'audio-hardware');
      stage = 'playback';
      await audio.play();
      if (active === record) { onFallback(null); utterance.onstart?.(); }
    } catch (error) {
      if (active !== record) return;
      if (browserFallback && browserSupported && error.name !== 'NotAllowedError') {
        dispose(record);
        voices = [];
        notify();
        const message = ({ query: 'PC内VOICEVOXの音声クエリを取得できませんでした。',
          synthesis: 'PC内VOICEVOXの音声合成に失敗しました。', audio: 'PC内VOICEVOXから有効な音声データを取得できませんでした。',
          playback: 'PC内VOICEVOX音声を再生できませんでした。' })[stage]
          + (Number.isInteger(httpStatus) && httpStatus >= 400 && httpStatus <= 599 ? `（HTTP ${httpStatus}）` : '');
        reportLocal({ phase: 'fallback', message: message + ' ブラウザ標準で読み上げを継続' });
        onFallback({ source: 'local', reason: stage, message });
        speakBrowser(record);
      } else settle(record, error.name === 'NotAllowedError' ? 'not-allowed' : 'network');
    }
  }

  async function speakCloud(record) {
    const controller = new AbortController();
    record.controller = controller;
    function failed(error) {
      if (active !== record || record.fallback) return;
      record.fallback = true;
      dispose(record);
      if (error.name === 'NotAllowedError') { settle(record, 'not-allowed'); return; }
      const details = cloudFallbackDetails(error);
      if (!error.cloudReported) onCloudStatus({ phase: 'fallback',
        message: details.message + '・ブラウザ標準で継続', enabled: cloud.enabled, reason: details.reason });
      onFallback(details);
      speakBrowser(record);
    }
    try {
      const blob = await cloud.synthesize(record.utterance, controller.signal);
      if (active !== record) return;
      record.url = environment.URL.createObjectURL(blob);
      const audio = new environment.Audio(record.url);
      record.audio = audio;
      audio.onended = () => settle(record);
      audio.onerror = () => {
        if (record.started) settle(record, 'audio-hardware');
        else failed(new Error('Cloud audio unavailable'));
      };
      await audio.play();
      if (active === record && record.audio === audio) {
        record.started = true;
        onFallback(null);
        record.utterance.onstart?.();
      }
    } catch (error) { failed(error); }
  }

  class Utterance {
    constructor(text) {
      this.text = String(text);
      this.lang = 'ja-JP';
      this.rate = 1;
      this.pitch = 1;
      this.volume = 1;
      this.voice = null;
    }
  }

  const synth = {
    get paused() { return native?.paused || false; },
    getVoices: () => [...(native?.getVoices() || []), ...voices, ...cloud.getVoices()],
    addEventListener(type, listener) { if (type === 'voiceschanged') listeners.add(listener); },
    resume() { native?.resume(); },
    cancel,
    speak(utterance) {
      cancel();
      const record = { utterance, serial };
      active = record;
      if (utterance.voice?.voiceURI?.startsWith(CLOUD_VOICE_PREFIX)) {
        void speakCloud(record);
        return;
      }
      if (utterance.voice?.voiceURI?.startsWith('voicevox:')) {
        void speakLocal(record);
        return;
      }
      speakBrowser(record);
    }
  };
  native?.addEventListener('voiceschanged', notify);
  const adapted = {
    speechSynthesis: browserSupported || localSupported ? synth : null,
    SpeechSynthesisUtterance: Utterance,
    localStorage: storage,
    setTimeout: environment.setTimeout.bind(environment),
    clearTimeout: environment.clearTimeout.bind(environment)
  };
  reportLocal({ phase: 'off', message: invalidSavedBase
    ? '保存した接続先が無効なため、初期値を使用しています。接続先を確認して保存してください。'
    : 'VOICEVOX未接続（この端末）' });
  return { environment: adapted, connect, cloud, get base() { return base; }, setBase,
    setBrowserFallback(value) { browserFallback = Boolean(value); } };
}

export function createVoicevoxPreference({ voicevox, speech, environment = window,
  isEnabled = () => false, onPreference = () => {} }) {
  const storageKey = 'qwPreferVoicevox';
  let preferred = false, revision = 0, attempted = false, pending = null;
  try {
    const saved = environment.localStorage?.getItem(storageKey);
    const savedVoice = environment.localStorage?.getItem('qwSpeechVoice');
    if (saved === 'true' || saved === 'false') preferred = saved === 'true';
    else if (savedVoice?.startsWith('voicevox:')) preferred = true;
  } catch {}
  const report = () => { voicevox.setBrowserFallback(preferred); onPreference(preferred); };
  function setPreferred(value, { resetVoice = true } = {}) {
    revision++;
    attempted = false;
    preferred = Boolean(value);
    try { environment.localStorage?.setItem(storageKey, String(preferred)); } catch {}
    if (!preferred && resetVoice) speech.setVoice('');
    report();
  }
  function prepare({ force = false, allowWhileOff = false } = {}) {
    if (!preferred || (!allowWhileOff && !isEnabled())) return Promise.resolve(false);
    if (pending?.revision === revision) return pending.promise;
    if (attempted && !force) return Promise.resolve(false);
    attempted = true;
    const current = revision;
    const promise = voicevox.connect().then(ready => {
      if (!ready || !preferred || current !== revision || (!allowWhileOff && !isEnabled())) return false;
      const voices = voicevox.environment.speechSynthesis.getVoices().filter(voice => voice.voiceURI?.startsWith('voicevox:'));
      let saved;
      try { saved = environment.localStorage?.getItem('qwSpeechVoice'); } catch {}
      const voice = voices.find(item => item.voiceURI === saved) || voices[0];
      return Boolean(voice && speech.setVoice(voice.voiceURI));
    }).finally(() => { if (pending?.promise === promise) pending = null; });
    pending = { revision: current, promise };
    return promise;
  }
  report();
  return { prepare, setPreferred,
    selectVoice(id) {
      if (!speech.setVoice(id)) return false;
      setPreferred(id.startsWith('voicevox:'), { resetVoice: false });
      return true;
    },
    connect() { setPreferred(true); return prepare({ force: true, allowWhileOff: true }); },
    setBase(value) {
      const next = normalizeVoicevoxBase(value);
      if (next !== voicevox.base) {
        revision++;
        attempted = false;
        speech.stop();
      }
      return voicevox.setBase(next);
    },
    cancelPending() { revision++; attempted = false; }
  };
}

export function mountLocalVoicevox({ voicevox, preference, document = window.document }) {
  const input = document.getElementById('voicevoxBase');
  const message = document.getElementById('voicevoxSettingsMessage');
  function refresh() {
    input.value = voicevox.base;
    document.getElementById('voicevoxVersion').href = `${voicevox.base}/version`;
    document.getElementById('voicevoxEngineSettings').href = `${voicevox.base}/setting`;
  }
  function save(value) {
    try {
      const result = preference.setBase(value);
      refresh();
      input.setAttribute('aria-invalid', 'false');
      message.textContent = result.saved ? '接続先を保存しました。「このPCへ接続」で確認してください。'
        : 'ブラウザに保存できないため、今回のみ使用します。「このPCへ接続」で確認してください。';
    } catch (error) {
      input.setAttribute('aria-invalid', 'true');
      message.textContent = error.message;
      input.focus();
    }
  }
  refresh();
  document.getElementById('voicevoxSettings').addEventListener('submit', event => {
    event.preventDefault();
    save(input.value);
  });
  document.getElementById('voicevoxBaseReset').addEventListener('click', () => save(VOICEVOX_BASE));
}
