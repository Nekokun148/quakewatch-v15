export const TREM_STATIONS = 'https://static.core-tyo1.exptech.dev/resource/station';
export const TREM_STREAM = 'https://api.lb-tpe1.exptech.dev/api/v1/trem/sse?topics=trem.rts.v1&mode=live';

async function boundedText(stream, maximum) {
  const reader = stream.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let text = '', size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) return text + decoder.decode();
      size += part.value.byteLength;
      if (size > maximum) throw new Error('Oversized TREM response');
      text += decoder.decode(part.value, { stream: true });
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export function parseTremStations(csv) {
  if (typeof csv !== 'string' || csv.length > 1000000) throw new Error('Invalid station list');
  const lines = csv.trim().split(/\r?\n/);
  if (lines.shift() !== 'loc_code,id,lat,lon,floor,code,net,time,work') throw new Error('Invalid station header');
  const stations = new Map();
  for (const line of lines) {
    const columns = line.split(',');
    const id = columns[1], latitude = Number(columns[2]), longitude = Number(columns[3]);
    if (columns.length !== 9 || columns[8] !== '1' || !/^[\da-f]+$/i.test(id || '')
      || !columns[2] || !columns[3] || !Number.isFinite(latitude) || !Number.isFinite(longitude)
      || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) continue;
    stations.set(id.toUpperCase(), { id, latitude, longitude });
  }
  if (!stations.size) throw new Error('No active stations');
  return stations;
}

export async function decodeTremEvent(value, environment = globalThis) {
  if (typeof value !== 'string' || value.length > 1000000 || !/^[A-Za-z0-9+/=]+$/.test(value)) throw new Error('Invalid TREM event');
  const bytes = Uint8Array.from(environment.atob(value), character => character.charCodeAt(0));
  const stream = new Blob([bytes]).stream().pipeThrough(new environment.DecompressionStream('gzip'));
  return JSON.parse(await boundedText(stream, 2000000));
}

export function parseTremFrame(data, stations, now = Date.now()) {
  if (!Number.isFinite(data?.ts) || now - data.ts > 15000 || data.ts > now + 5000
    || !data.stations || typeof data.stations !== 'object' || Array.isArray(data.stations)) throw new Error('Invalid or stale RTS frame');
  const points = [];
  for (const [id, value] of Object.entries(data.stations)) {
    const station = stations.get(id.toUpperCase());
    if (!station || !Number.isFinite(value?.i) || value.i < -5 || value.i > 10) continue;
    const pga = Number.isFinite(value.pga) && value.pga >= 0 && value.pga <= 1000000 ? value.pga : null;
    points.push({ ...station, intensity: value.i, pga });
  }
  return { time: data.ts, points };
}

export function createTremFeed({
  environment = window, fetcher = fetch, decode = value => decodeTremEvent(value, environment),
  onFrame = () => {}, onStatus = () => {}
} = {}) {
  let enabled = false, generation = 0, socket, request, retry, watchdog;
  let stations, lastTime = 0, lastReceived = 0, failures = 0;
  const now = () => environment.Date.now();
  const status = (phase, text) => onStatus({ phase, text, enabled });
  function disconnect() {
    generation++;
    request?.abort(); request = null;
    if (socket) { socket.onerror = null; socket.close(); socket = null; }
    environment.clearTimeout(retry);
    environment.clearInterval(watchdog);
    lastTime = 0;
    onFrame(null);
  }
  function fail(text) {
    disconnect();
    if (!enabled) return;
    status('error', text + '・自動再接続待ち');
    const delay = Math.min(30000 * 2 ** Math.min(failures++, 4), 300000);
    retry = environment.setTimeout(connect, delay);
  }
  async function connect() {
    if (!enabled || environment.document.hidden) return;
    disconnect();
    const episode = generation;
    status('loading', 'TREM RTSへ接続中');
    try {
      if (!stations) {
        const controller = new AbortController();
        request = controller;
        const deadline = environment.setTimeout(() => controller.abort(), 8000);
        try {
          const response = await fetcher(TREM_STATIONS, {
            credentials: 'omit', redirect: 'error', cache: 'no-store', signal: controller.signal
          });
          if (!response.ok) throw new Error('Station request failed');
          stations = parseTremStations(await boundedText(response.body, 1000000));
        } finally { environment.clearTimeout(deadline); }
      }
      if (episode !== generation || !enabled) return;
      socket = new environment.EventSource(TREM_STREAM, { withCredentials: false });
      socket.onerror = () => { if (episode === generation) fail('TREM RTSの通信に失敗'); };
      socket.addEventListener('info', event => {
        if (episode !== generation) return;
        try {
          const info = JSON.parse(event.data);
          if (info.denied?.includes('trem.rts.v1')) { fail('TREM RTSの受信が配信元から許可されませんでした'); return; }
          status('waiting', 'TREM RTS接続済み・観測データ待機');
        } catch { fail('TREM RTSの接続応答を確認できません'); }
      });
      socket.addEventListener('trem.rts.v1', async event => {
        if (episode !== generation || !enabled) return;
        try {
          const decoded = await decode(event.data);
          if (episode !== generation || !enabled) return;
          const frame = parseTremFrame(decoded, stations, now());
          if (frame.time <= lastTime) return;
          lastTime = frame.time; lastReceived = now(); failures = 0;
          onFrame(frame);
          status('live', 'TREM RTS受信中（台湾方式の震度指標）');
        } catch { if (episode === generation) fail('TREM RTSの形式・観測時刻を確認できません'); }
      });
      lastReceived = now();
      watchdog = environment.setInterval(() => {
        if (episode === generation && now() - lastReceived > 15000) fail('TREM RTSの観測データが15秒以上届いていません');
      }, 5000);
    } catch {
      if (episode === generation && enabled) fail('TREM RTSの観測点一覧を取得できません');
    }
  }
  function stop() {
    enabled = false;
    disconnect();
    status('off', 'TREM RTS OFF');
  }
  return {
    start() {
      if (enabled) return;
      if (!environment.EventSource || !environment.DecompressionStream) {
        status('unsupported', 'このブラウザはTREM RTSのストリームに未対応です');
        return;
      }
      enabled = true; failures = 0; void connect();
    },
    stop,
    visibilityChanged() {
      if (!enabled) return;
      disconnect();
      if (environment.document.hidden) status('paused', 'TREM RTS休止中・ページ表示時に再開');
      else void connect();
    }
  };
}

export function mountTrem({ environment = window, onFrame = () => {}, createFeed = createTremFeed } = {}) {
  const document = environment.document;
  const toggle = document.getElementById('tremConsent');
  const status = document.getElementById('tremStatus');
  const list = document.getElementById('tremStations');
  if (!toggle || !status || !list) return null;
  toggle.checked = false;
  const feed = createFeed({ environment,
    onStatus(info) {
      if (status.textContent !== info.text) status.textContent = info.text;
      status.dataset.phase = info.phase;
    },
    onFrame(frame) {
      list.replaceChildren();
      onFrame(frame);
      if (!frame || !toggle.checked) return;
      const time = new Date(frame.time).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
      const heading = document.createElement('li');
      heading.textContent = `${time} JST / ${frame.points.length}地点`;
      list.append(heading);
      for (const point of [...frame.points].sort((a, b) => b.intensity - a.intensity).slice(0, 5)) {
        const row = document.createElement('li');
        row.textContent = `${point.id} / 台湾RTS指標 ${point.intensity.toFixed(1)}${point.pga == null ? '' : ` / PGA ${point.pga} Gal`}`;
        list.append(row);
      }
    }
  });
  toggle.addEventListener('change', () => toggle.checked ? feed.start() : feed.stop());
  document.addEventListener('visibilitychange', () => feed.visibilityChanged());
  environment.addEventListener('pagehide', () => { toggle.checked = false; feed.stop(); });
  return feed;
}
