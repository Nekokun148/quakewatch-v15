import { createCloudVoicevox, cloudFallbackDetails, CLOUD_VOICE_PREFIX } from './cloud-voicevox.js';

export const VOICEVOX_BASE = 'http://127.0.0.1:50021';

export function voicevoxVoices(speakers) {
  if (!Array.isArray(speakers)) throw new Error('Invalid speaker list');
  return speakers.flatMap(speaker => {
    if (typeof speaker.name !== 'string' || !Array.isArray(speaker.styles)) return [];
    return speaker.styles.filter(style => Number.isInteger(style.id) && style.id >= 0
      && typeof style.name === 'string' && (!style.type || style.type === 'talk'))
      .map(style => ({ voiceURI: `voicevox:${style.id}`, name: `VOICEVOX: ${speaker.name}（${style.name}）`,
        lang: 'ja-JP', localService: true, default: false }));
  });
}

export function createVoicevoxEnvironment({ environment = window, onStatus = () => {}, onCloudStatus = () => {}, onFallback = () => {} } = {}) {
  const native = environment.speechSynthesis;
  const browserSupported = Boolean(native && environment.SpeechSynthesisUtterance);
  const localSupported = Boolean(environment.fetch && environment.Audio && environment.URL?.createObjectURL);
  const listeners = new Set();
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
    if (connecting) return connecting;
    if (!localSupported) {
      onStatus({ phase: 'error', message: 'このブラウザではVOICEVOXを利用できません' });
      return false;
    }
    onStatus({ phase: 'connecting', message: 'VOICEVOXへ接続中（この端末）' });
    const controller = new AbortController();
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = environment.setTimeout(() => { controller.abort(); reject(new Error('Discovery timeout')); }, 5000);
    });
    connecting = Promise.resolve().then(async () => {
      try {
        const next = await Promise.race([Promise.resolve().then(async () => {
          const response = await fetcher(`${VOICEVOX_BASE}/speakers`, {
            signal: controller.signal, cache: 'no-store', redirect: 'error', credentials: 'omit', referrerPolicy: 'no-referrer'
          });
          if (!response.ok) throw new Error('speakers');
          const found = voicevoxVoices(await response.json());
          if (!found.length) throw new Error('No talk styles');
          return found;
        }), timeout]);
        if (controller.signal.aborted) throw new Error('Discovery cancelled');
        voices = next;
        notify();
        onStatus({ phase: 'ready', message: `VOICEVOX接続済み・${voices.length}音声（この端末）` });
        return true;
      } catch {
        voices = [];
        notify();
        onStatus({ phase: 'error', message: browserSupported
          ? 'VOICEVOX接続不可・ブラウザ標準を使用（エンジン未起動／接続許可など）'
          : 'VOICEVOX接続不可・ブラウザ標準も未対応' });
        if (browserSupported && browserFallback) onFallback({ source: 'local', reason: 'discovery',
          message: controller.signal.aborted ? 'PC内VOICEVOXの接続確認が5秒以内に完了しませんでした。'
            : 'PC内VOICEVOXの話者を取得できませんでした（未起動・通信・接続許可等は未特定）。' });
        return false;
      } finally {
        environment.clearTimeout(timer);
        connecting = null;
      }
    });
    return connecting;
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
    const utterance = record.utterance;
    const speaker = Number(utterance.voice.voiceURI.slice('voicevox:'.length));
    if (!Number.isInteger(speaker) || speaker < 0) { settle(record, 'voice-unavailable'); return; }
    const controller = new AbortController();
    record.controller = controller;
    const options = { method: 'POST', signal: controller.signal, cache: 'no-store', redirect: 'error',
      credentials: 'omit', referrerPolicy: 'no-referrer' };
    let stage = 'query', httpStatus = 0;
    try {
      const queryUrl = new URL(`${VOICEVOX_BASE}/audio_query`);
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
      const response = await fetcher(`${VOICEVOX_BASE}/synthesis?speaker=${speaker}`, {
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
        onStatus({ phase: 'fallback', message: message + ' ブラウザ標準で読み上げを継続' });
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
  let storage;
  try { storage = environment.localStorage; } catch {}
  const adapted = {
    speechSynthesis: browserSupported || localSupported ? synth : null,
    SpeechSynthesisUtterance: Utterance,
    localStorage: storage,
    setTimeout: environment.setTimeout.bind(environment),
    clearTimeout: environment.clearTimeout.bind(environment)
  };
  onStatus({ phase: 'off', message: 'VOICEVOX未接続（この端末）' });
  return { environment: adapted, connect, cloud, setBrowserFallback(value) { browserFallback = Boolean(value); } };
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
    cancelPending() { revision++; attempted = false; }
  };
}
