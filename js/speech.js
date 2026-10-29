import { eewInfo } from './eew.js';
import { CLOUD_VOICE_PREFIX, CLOUD_PREVIEW_DEADLINE } from './cloud-voicevox.js';

const VOICE_STORAGE_KEY = 'qwSpeechVoice';
const voiceId = voice => voice.voiceURI || JSON.stringify([voice.name, voice.lang, Boolean(voice.localService)]);

export function createSpeechController({ environment = window, onStatus = () => {}, onFallback = () => {} } = {}) {
  const synth = environment.speechSynthesis;
  const supported = Boolean(synth && typeof environment.SpeechSynthesisUtterance === 'function');
  let enabled = false;
  let held = false;
  let phase = supported ? 'off' : 'unsupported';
  let error = '';
  let voice = null;
  let japanese = [];
  let preferredVoice = '';
  try { preferredVoice = environment.localStorage?.getItem(VOICE_STORAGE_KEY) || ''; } catch {}
  let active = null;
  let startTimer = null;
  let queue = [];
  let lastText = '';
  let started = 0;
  let completed = 0;

  const messages = {
    'not-allowed': '音声を開始できません。音声テストで再試行できます。',
    'language-unavailable': '日本語の音声を利用できません。',
    'voice-unavailable': '選択した音声を利用できません。',
    'synthesis-unavailable': 'このブラウザでは音声エンジンを利用できません。',
    'audio-busy': '音声の出力先が使用中です。',
    'audio-hardware': '音声の出力先を利用できません。',
    network: '音声サービスへの接続に失敗しました。',
    timeout: '音声が開始されませんでした。音声テストで再試行できます。'
  };

  function report() {
    onStatus({
      supported, enabled, phase, error, voice: voice?.name || '', preferredVoice,
      voices: japanese.map(v => ({ id: voiceId(v), name: v.name, lang: v.lang, localService: Boolean(v.localService) })),
      lastText, started, completed
    });
  }

  function refreshVoice() {
    const voices = supported ? synth.getVoices() : [];
    japanese = voices.filter(v => /^ja(?:[-_]|$)/i.test(v.lang));
    const browserVoices = japanese.filter(v => !/^voicevox(?:-cloud)?:/.test(voiceId(v)));
    voice = japanese.find(v => voiceId(v) === preferredVoice)
      || browserVoices.find(v => v.localService && v.default)
      || browserVoices.find(v => v.localService)
      || browserVoices.find(v => v.default)
      || browserVoices[0]
      || null;
    report();
  }

  function setVoice(id) {
    if (!supported || typeof id !== 'string') return false;
    refreshVoice();
    if (id && !japanese.some(v => voiceId(v) === id)) return false;
    preferredVoice = id;
    try { environment.localStorage?.setItem(VOICE_STORAGE_KEY, id); } catch {}
    // A changed preference applies to the next utterance, without cancelling a bulletin.
    refreshVoice();
    return true;
  }

  function clearPlayback() {
    environment.clearTimeout(startTimer);
    startTimer = null;
    // Drop the reference before cancel(), whose error event can arrive later.
    active = null;
    queue = [];
    if (supported) synth.cancel();
  }

  function fail(code) {
    enabled = false;
    phase = 'error';
    error = messages[code] || '音声の再生に失敗しました。';
    clearPlayback();
    report();
  }

  function playNext() {
    if (!enabled || held || active || !queue.length) return;
    refreshVoice();
    if (preferredVoice && (!voice || voiceId(voice) !== preferredVoice)) {
      const cloud = preferredVoice.startsWith('voicevox-cloud:');
      const local = preferredVoice.startsWith('voicevox:');
      onFallback({ source: cloud ? 'cloud' : local ? 'local' : 'browser', reason: 'preferred-unavailable',
        message: cloud ? '選択したクラウド話者が未取得です。外部送信への同意と話者一覧の取得を確認してください。'
          : local ? '選択したPC内話者が未取得です。VOICEVOXの起動と接続を確認してください。'
          : '選択した音声が現在の音声一覧にないため、利用可能なブラウザ音声を選びました。' });
    }
    const next = queue.shift();
    const utterance = new environment.SpeechSynthesisUtterance(next.text);
    utterance.lang = 'ja-JP';
    utterance.rate = 1;
    utterance.pitch = 1;
    utterance.volume = 1;
    if (voice) utterance.voice = voice;
    utterance.waitForCloud = next.waitForCloud && voiceId(voice || {}).startsWith(CLOUD_VOICE_PREFIX);
    active = utterance;
    phase = 'starting';
    report();
    utterance.onstart = () => {
      if (active !== utterance) return;
      environment.clearTimeout(startTimer);
      startTimer = null;
      phase = 'speaking';
      started++;
      report();
    };
    utterance.onend = () => {
      if (active !== utterance) return;
      environment.clearTimeout(startTimer);
      startTimer = null;
      active = null;
      completed++;
      phase = 'ready';
      report();
      playNext();
    };
    utterance.onerror = event => {
      if (active !== utterance) return;
      fail(event.error);
    };
    startTimer = environment.setTimeout(() => {
      if (active === utterance) fail('timeout');
    }, utterance.waitForCloud ? CLOUD_PREVIEW_DEADLINE + 4000 : 8000);
    try {
      if (synth.paused) synth.resume();
      synth.speak(utterance);
    } catch {
      fail('synthesis-unavailable');
    }
  }

  function enable() {
    if (!supported) return false;
    enabled = true;
    error = '';
    if (!active) phase = 'ready';
    report();
    return true;
  }

  function disable() {
    enabled = false;
    phase = supported ? 'off' : 'unsupported';
    error = '';
    clearPlayback();
    report();
  }

  function stop() {
    clearPlayback();
    phase = enabled ? 'ready' : error ? 'error' : supported ? 'off' : 'unsupported';
    report();
  }

  function hold() {
    held = true;
    stop();
  }

  function release() {
    held = false;
    playNext();
  }

  function say(text, { interrupt = false, waitForCloud = false } = {}) {
    if (!enabled || !supported || !text) return false;
    if (interrupt) clearPlayback();
    lastText = String(text);
    const sentences = lastText.match(/[^。！？]+[。！？]?/gu) || [lastText];
    for (const sentence of sentences) {
      const characters = Array.from(sentence);
      for (let i = 0; i < characters.length; i += 120) queue.push({ text: characters.slice(i, i + 120).join(''), waitForCloud });
    }
    playNext();
    return true;
  }

  if (supported) {
    refreshVoice();
    synth.addEventListener('voiceschanged', refreshVoice);
  } else {
    report();
  }
  return { enable, disable, say, setVoice, stop, hold, release };
}

export function quakeAnnouncement(data, scaleText) {
  const q = data.earthquake || {};
  const h = q.hypocenter || {};
  const parts = ['地震情報。', `震源は${h.name || '不明'}。`, `最大震度は${scaleText(q.maxScale)}です。`];
  if (h.magnitude != null && Number(h.magnitude) >= 0) parts.push(`マグニチュード${h.magnitude}。`);
  if (h.depth != null && Number(h.depth) >= 0) parts.push(`震源の深さは${h.depth}キロメートルです。`);
  const points = [...(data.points || [])].filter(p => Number(p.scale) >= 10).sort((a, b) => Number(b.scale) - Number(a.scale));
  const names = [...new Set(points.map(p => `${p.pref || ''}${p.addr || ''}`).filter(Boolean))];
  if (names.length) parts.push(`震度が観測された地域は、${names.slice(0, 8).join('、')}${names.length > 8 ? `、ほか${names.length - 8}地域` : ''}です。`);
  return parts.join('');
}

export function eewAnnouncement(data) {
  const info = eewInfo(data);
  if (info.cancelled) return '緊急地震速報は取り消されました。';
  const h = data.earthquake?.hypocenter || {};
  const names = [...new Set((data.areas || []).filter(a => Number(a.scaleTo) >= 30).map(a => `${a.pref || ''}${a.name || ''}`).filter(Boolean))];
  const source = h.name ? `震源は${h.name}。` : '';
  const areas = names.length ? `強い揺れが予測される地域は、${names.slice(0, 8).join('、')}${names.length > 8 ? `、ほか${names.length - 8}地域` : ''}です。` : '続報に注意してください。';
  return `緊急地震速報。${source}${info.stage}。${info.plum ? 'PLUM法による予想を含みます。' : ''}${areas}`;
}
