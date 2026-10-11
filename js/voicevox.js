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

export function createVoicevoxEnvironment({ environment = window, onStatus = () => {} } = {}) {
  const native = environment.speechSynthesis;
  const browserSupported = Boolean(native && environment.SpeechSynthesisUtterance);
  const localSupported = Boolean(environment.fetch && environment.Audio && environment.URL?.createObjectURL);
  const listeners = new Set();
  let voices = [];
  let connecting = null;
  let serial = 0;
  let active = null;
  const notify = () => listeners.forEach(listener => listener());
  const fetcher = environment.fetch?.bind(environment);

  async function connect() {
    if (connecting) return connecting;
    if (!localSupported) {
      onStatus({ phase: 'error', message: 'このブラウザではVOICEVOXを利用できません' });
      return false;
    }
    onStatus({ phase: 'connecting', message: 'VOICEVOXへ接続中（このPC）' });
    const controller = new AbortController();
    const timer = environment.setTimeout(() => controller.abort(), 5000);
    connecting = Promise.resolve().then(async () => {
      try {
        const response = await fetcher(`${VOICEVOX_BASE}/speakers`, { signal: controller.signal, cache: 'no-store', redirect: 'error' });
        if (!response.ok) throw new Error('speakers');
        const next = voicevoxVoices(await response.json());
        if (!next.length) throw new Error('No talk styles');
        voices = next;
        notify();
        onStatus({ phase: 'ready', message: `VOICEVOX接続済み・${voices.length}音声（このPC）` });
        return true;
      } catch {
        voices = [];
        notify();
        onStatus({ phase: 'error', message: 'VOICEVOXへ接続できません。起動状態・ブラウザの接続許可を確認してください' });
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
    }
    if (record.url) environment.URL.revokeObjectURL(record.url);
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

  async function speakLocal(record) {
    const utterance = record.utterance;
    const speaker = Number(utterance.voice.voiceURI.slice('voicevox:'.length));
    if (!Number.isInteger(speaker) || speaker < 0) { settle(record, 'voice-unavailable'); return; }
    const controller = new AbortController();
    record.controller = controller;
    const options = { method: 'POST', signal: controller.signal, cache: 'no-store', redirect: 'error' };
    try {
      const queryUrl = new URL(`${VOICEVOX_BASE}/audio_query`);
      queryUrl.searchParams.set('text', utterance.text);
      queryUrl.searchParams.set('speaker', String(speaker));
      const queryResponse = await fetcher(queryUrl.href, options);
      if (!queryResponse.ok) throw new Error('audio_query');
      const query = await queryResponse.json();
      if (active !== record) return;
      query.speedScale = utterance.rate;
      query.volumeScale = Math.max(0, Math.min(1, utterance.volume));
      const response = await fetcher(`${VOICEVOX_BASE}/synthesis?speaker=${speaker}`, {
        ...options, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(query)
      });
      if (!response.ok) throw new Error('synthesis');
      const blob = await response.blob();
      if (active !== record) return;
      if (!blob.size || !/^(audio\/|application\/octet-stream)/i.test(blob.type)) throw new Error('audio');
      record.url = environment.URL.createObjectURL(blob);
      const audio = new environment.Audio(record.url);
      record.audio = audio;
      audio.onended = () => settle(record);
      audio.onerror = () => settle(record, 'audio-hardware');
      await audio.play();
      if (active === record) utterance.onstart?.();
    } catch (error) {
      if (active === record) settle(record, error.name === 'NotAllowedError' ? 'not-allowed' : 'network');
    }
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
    getVoices: () => [...(native?.getVoices() || []), ...voices],
    addEventListener(type, listener) { if (type === 'voiceschanged') listeners.add(listener); },
    resume() { native?.resume(); },
    cancel,
    speak(utterance) {
      cancel();
      const record = { utterance, serial };
      active = record;
      if (utterance.voice?.voiceURI?.startsWith('voicevox:')) {
        void speakLocal(record);
        return;
      }
      if (!browserSupported) { settle(record, 'synthesis-unavailable'); return; }
      const nativeUtterance = new environment.SpeechSynthesisUtterance(utterance.text);
      for (const key of ['lang', 'rate', 'pitch', 'volume']) nativeUtterance[key] = utterance[key];
      if (utterance.voice) nativeUtterance.voice = utterance.voice;
      nativeUtterance.onstart = () => { if (active === record) utterance.onstart?.(); };
      nativeUtterance.onend = () => settle(record);
      nativeUtterance.onerror = event => settle(record, event.error);
      native.speak(nativeUtterance);
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
  onStatus({ phase: 'off', message: 'VOICEVOX未接続（このPC）' });
  return { environment: adapted, connect };
}
