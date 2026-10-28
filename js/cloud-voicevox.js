export const CLOUD_VOICES_URL = 'https://static.tts.quest/voicevox_speakers.json';
export const CLOUD_SYNTHESIS_URL = 'https://api.tts.quest/v3/voicevox/synthesis';
export const CLOUD_VOICE_PREFIX = 'voicevox-cloud:';
export const CLOUD_DEADLINE = 4000;

export function cloudVoices(data) {
  if (!Array.isArray(data) || data.length > 2048) throw new Error('Invalid cloud voices');
  return data.flatMap((name, id) => typeof name === 'string' && name.startsWith('VOICEVOX:') && name.length <= 160
    ? [{ voiceURI: CLOUD_VOICE_PREFIX + id, name: name + ' [tts.quest]', lang: 'ja-JP', localService: false, default: false }] : []);
}

export function cloudAudioUrls(data) {
  function checked(value, file) {
    const url = new URL(value);
    if (url.protocol !== 'https:' || !/^audio[1-9][0-9]*\.tts\.quest$/.test(url.hostname)
      || url.port || url.username || url.password || url.search || url.hash
      || !new RegExp('^/v1/data/[a-f0-9]{64}/' + file.replace('.', '\\.') + '$').test(url.pathname)) {
      throw new Error('Invalid cloud audio URL');
    }
    return url;
  }
  const status = checked(data.audioStatusUrl, 'status.json');
  const audio = checked(data.mp3DownloadUrl, 'audio.mp3');
  if (new URL('.', status).href !== new URL('.', audio).href) throw new Error('Mismatched cloud audio');
  return { status: status.href, audio: audio.href };
}

async function boundedBody(response, maximum) {
  if (Number(response.headers.get('Content-Length')) > maximum) {
    await response.body?.cancel();
    throw new Error('Cloud response too large');
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Missing cloud response');
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > maximum) throw new Error('Cloud response too large');
      chunks.push(part.value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally { reader.releaseLock(); }
  return new Blob(chunks, { type: response.headers.get('Content-Type') || '' });
}

export function createCloudVoicevox({ environment = window, onStatus = () => {} } = {}) {
  let enabled = false, generation = 0, voices = [], pending = null, retryAt = 0, nextSynthesisAt = 0;
  const controllers = new Set();
  const now = () => environment.Date?.now() ?? Date.now();
  const report = (phase, message) => onStatus({ phase, message, enabled });
  function defer(value) {
    const seconds = Number(value), date = Date.parse(value || '');
    const wait = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : date - now();
    retryAt = Math.max(retryAt, now() + Math.max(30000, Number.isFinite(wait) ? wait : 0));
  }
  async function run(signal, task) {
    if (!enabled || now() < retryAt) throw new Error('Cloud not permitted or cooling down');
    const episode = generation, controller = new AbortController();
    const abort = () => controller.abort();
    const checkpoint = () => {
      if (!enabled || generation !== episode || controller.signal.aborted) throw new DOMException('Cancelled', 'AbortError');
    };
    controllers.add(controller);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) controller.abort();
    let timer;
    const deadline = new Promise((_, reject) => {
      controller.signal.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError')), { once: true });
      timer = environment.setTimeout(() => controller.abort(), CLOUD_DEADLINE);
    });
    async function request(url, options = {}, audio = false) {
      checkpoint();
      const response = await environment.fetch(url, { ...options, signal: controller.signal,
        cache: 'no-store', credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer' });
      checkpoint();
      const type = response.headers.get('Content-Type') || '';
      if (!(audio ? /^audio\/(?:mpeg|mp3)\b/i : /^application\/json\b/i).test(type)) {
        if (!response.ok) defer(response.headers.get('Retry-After'));
        await response.body?.cancel();
        throw new Error('Invalid cloud response');
      }
      const blob = await boundedBody(response, audio ? 8388608 : 262144);
      checkpoint();
      if (audio) {
        if (!response.ok || !blob.size) throw new Error('Invalid cloud audio');
        return blob;
      }
      const data = JSON.parse(await blob.text());
      checkpoint();
      if (!response.ok || data?.retryAfter != null) {
        defer(response.headers.get('Retry-After')); defer(data?.retryAfter);
        throw new Error('Cloud unavailable or rate limited');
      }
      return data;
    }
    function wait() {
      return new Promise((resolve, reject) => {
        const id = environment.setTimeout(() => { controller.signal.removeEventListener('abort', cancel); resolve(); }, 1000);
        const cancel = () => { environment.clearTimeout(id); reject(new DOMException('Cancelled', 'AbortError')); };
        controller.signal.addEventListener('abort', cancel, { once: true });
        if (controller.signal.aborted) cancel();
      });
    }
    try {
      checkpoint();
      return await Promise.race([task({ request, wait, checkpoint }), deadline]);
    } catch (error) {
      if (enabled && generation === episode && !signal?.aborted) {
        defer(); report('fallback', 'クラウド利用不可・ブラウザ標準へ切替（30秒以上待機）');
      }
      throw error;
    } finally {
      environment.clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      controller.abort(); controllers.delete(controller);
    }
  }
  function setEnabled(value) {
    enabled = Boolean(value); generation++;
    for (const controller of controllers) controller.abort();
    pending = null; voices = [];
    report(enabled ? 'idle' : 'off', enabled ? '外部送信に同意済み・未接続' : '未許可・未接続');
  }
  async function connect() {
    if (!enabled) return false;
    if (pending) return pending;
    if (now() < retryAt) { report('fallback', 'クラウド再接続待ち・ブラウザ標準を使用'); return false; }
    report('connecting', 'tts.questの話者一覧を確認中');
    const episode = generation;
    const promise = run(null, async ({ request, checkpoint }) => {
      const found = cloudVoices(await request(CLOUD_VOICES_URL));
      checkpoint();
      if (!found.length) throw new Error('No cloud voices');
      voices = found;
      report('ready', `クラウド接続確認・${voices.length}音声（非公式tts.quest）`);
      return true;
    }).catch(() => false).finally(() => { if (pending === promise && generation === episode) pending = null; });
    pending = promise;
    return promise;
  }
  async function synthesize(utterance, signal) {
    const id = utterance.voice?.voiceURI;
    if (!enabled || !voices.some(voice => voice.voiceURI === id) || Array.from(utterance.text).length > 120
      || !utterance.text.trim() || now() < nextSynthesisAt) throw new Error('Cloud voice unavailable');
    nextSynthesisAt = now() + 2000;
    return run(signal, async ({ request, wait, checkpoint }) => {
      report('synthesizing', 'クラウド合成待ち（最大4秒）');
      const data = await request(CLOUD_SYNTHESIS_URL, { method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ speaker: id.slice(CLOUD_VOICE_PREFIX.length), text: utterance.text }).toString() });
      if (data?.success !== true) throw new Error('Cloud synthesis failed');
      const urls = cloudAudioUrls(data);
      for (let attempt = 0; attempt < 3; attempt++) {
        const status = await request(urls.status);
        if (status?.success !== true || status.isAudioError !== false) throw new Error('Cloud synthesis failed');
        if (status.isAudioReady === true) {
          const blob = await request(urls.audio, {}, true);
          checkpoint(); report('ready', 'クラウド音声データ取得済み（非公式tts.quest）');
          return blob;
        }
        if (status.isAudioReady !== false || attempt === 2) throw new Error('Cloud audio not ready');
        await wait();
      }
    });
  }
  report('off', '未許可・未接続');
  return { setEnabled, connect, synthesize, getVoices: () => [...voices], get enabled() { return enabled; } };
}

export function mountCloudVoicevox({ voicevox, speech, preference, environment = window }) {
  const consent = environment.document.getElementById('cloudVoicevoxConsent');
  const retry = environment.document.getElementById('cloudVoicevoxRetry');
  let revision = 0;
  consent.checked = false;
  function disable({ resetVoice = true } = {}) {
    const wasEnabled = voicevox.cloud.enabled;
    revision++;
    consent.checked = false; retry.disabled = true;
    voicevox.cloud.setEnabled(false);
    if (wasEnabled) {
      speech.stop();
      if (resetVoice) preference.setPreferred(false);
    }
  }
  async function connect() {
    if (!consent.checked) return false;
    const current = ++revision;
    retry.disabled = true;
    preference.setPreferred(false);
    try {
      const ready = await voicevox.cloud.connect();
      if (!ready || current !== revision || !consent.checked) return false;
      const voices = voicevox.cloud.getVoices();
      return Boolean(voices.length && speech.setVoice(voices[0].voiceURI));
    } finally { if (current === revision) retry.disabled = !consent.checked; }
  }
  consent.addEventListener('change', () => {
    if (!consent.checked) { disable(); return; }
    speech.stop(); voicevox.cloud.setEnabled(true);
    void connect();
  });
  retry.addEventListener('click', () => { void connect(); });
  environment.addEventListener('pagehide', () => disable());
  environment.addEventListener('pageshow', event => { if (event.persisted) disable(); });
  return { disable, selectVoice(id) {
    if (!id.startsWith(CLOUD_VOICE_PREFIX)) disable({ resetVoice: false });
    return preference.selectVoice(id);
  } };
}
