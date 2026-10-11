export const YDITS_SERVERS = Object.freeze([
  'https://api.ydits.net/vxse43',
  'https://api2.ydits.net/vxse43',
  'https://api3.ydits.net/vxse43'
]);
export const YDITS_INTERVAL = 1000;
export const YDITS_RECOVERY_INTERVAL = 60000;
const scales = { '0': 0, '1': 10, '2': 20, '3': 30, '4': 40, '5-': 45, '5+': 50, '6-': 55, '6+': 60, '7': 70, unknown: -1 };
const validTime = value => typeof value === 'string' && /(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value));
const failure = (reason, extra = {}) => Object.assign(new Error(reason), { reason, ...extra });
const providerStatuses = ['Not found', 'Too many requests', 'Under maintenance', 'Service Unavailable', 'INTERNAL_ERROR'];

export function yditsSnapshot(data, now = Date.now()) {
  if (typeof data?.status === 'string' && data.status !== 'OK') {
    throw failure(data.status === 'Too many requests' ? 'rate-limit' : 'provider', {
      providerStatus: providerStatuses.includes(data.status) ? data.status : null
    });
  }
  if (!data || data.status !== 'OK' || typeof data.isEew !== 'boolean' || !validTime(data.time)) {
    throw failure('schema');
  }
  const age = now - Date.parse(data.time);
  if (age < -10000 || age > 120000) throw failure('clock');
  if (!data.isEew) return { active: false, checkedAt: data.time };
  const report = data.report;
  if (!report || !['normal', 'drill', 'test'].includes(report.type) || !validTime(report.time) ||
      !['isLast', 'isFinal', 'isCanceled', 'isWarning'].every(key => typeof report[key] === 'boolean')) {
    throw failure('schema');
  }
  const snapshot = {
    active: true, checkedAt: data.time, issuedAt: report.time, training: report.type !== 'normal',
    type: report.type, cancelled: report.isCanceled, final: report.isFinal, last: report.isLast,
    warning: report.isWarning, stale: now - Date.parse(report.time) > 120000 || Date.parse(report.time) - now > 10000
  };
  if (report.isCanceled) return snapshot;
  const quake = report.earthquake;
  if (!quake || typeof quake.condition !== 'boolean' || !validTime(quake.originTime) ||
      typeof quake.hypocenterName !== 'string' || typeof quake.intensity !== 'string' || !Object.hasOwn(scales, quake.intensity) ||
      ![quake.magnitude, quake.depth].every(value => value === null || (typeof value === 'number' && Number.isFinite(value) && value >= 0))) {
    throw failure('schema');
  }
  return { ...snapshot, originTime: quake.originTime, hypocenter: quake.hypocenterName,
    assumed: quake.condition, maxScale: scales[quake.intensity],
    magnitude: quake.condition ? null : quake.magnitude, depth: quake.condition ? null : quake.depth };
}

export function createYditsEEWAdapter() {
  const origins = new Map();
  return function receive(snapshot) {
    if (!snapshot.active) { origins.clear(); return null; }
    if (!snapshot.cancelled) origins.set(snapshot.type, snapshot.originTime);
    const origin = origins.get(snapshot.type);
    // The public schema has no event ID or report number. Use the received
    // origin time only for local deduplication; never manufacture a report number.
    return {
      code: 556, source: 'YDITS', time: snapshot.issuedAt,
      issue: { time: snapshot.issuedAt, originTime: origin, eventId: `ydits/${snapshot.type}/${Date.parse(origin || snapshot.issuedAt)}` },
      unmatchedCancel: snapshot.cancelled && !origin,
      cancelled: snapshot.cancelled, isFinal: snapshot.final, isLast: snapshot.last,
      isWarning: snapshot.warning, test: snapshot.training,
      earthquake: snapshot.cancelled ? undefined : {
        originTime: snapshot.originTime, maxScale: snapshot.maxScale, assumed: snapshot.assumed,
        hypocenter: { name: snapshot.hypocenter, magnitude: snapshot.magnitude, depth: snapshot.depth }
      },
      areas: []
    };
  };
}

export function createYditsFeed({ environment = window, fetcher = fetch, onData = () => {}, onStatus = () => {} } = {}) {
  let enabled = false, busy = false, generation = 0, timer, request;
  let server = 0, nextAt = 0, recoveryAt = 0, lastKey = '', lastRequestAt = -Infinity;
  const now = () => environment.Date?.now() ?? Date.now();
  const status = (phase, index, text, reason = null) => onStatus({ phase, server: index + 1, text, reason });

  async function poll() {
    if (!enabled || busy || now() < nextAt) return false;
    if (environment.document?.hidden) {
      environment.clearTimeout(timer);
      timer = environment.setTimeout(poll, YDITS_INTERVAL);
      return false;
    }
    environment.clearTimeout(timer);
    busy = true;
    lastRequestAt = now();
    const episode = generation;
    const previous = server;
    const index = server > 0 && now() >= recoveryAt ? 0 : server;
    const controller = new AbortController();
    request = controller;
    let rejectAbort;
    const aborted = new Promise((_, reject) => { rejectAbort = reject; });
    const cancel = () => rejectAbort(new Error('aborted'));
    controller.signal.addEventListener('abort', cancel, { once: true });
    const deadline = environment.setTimeout(() => controller.abort(), 5000);
    let delay = YDITS_INTERVAL;
    try {
      // Public GET only. The provider currently redirects its documented endpoints.
      const loading = (async () => {
        const response = await fetcher(YDITS_SERVERS[index], {
          cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer', signal: controller.signal
        });
        if (response.status === 429) {
          const seconds = Number(response.headers?.get('retry-after'));
          delay = Math.max(30000, Math.min(300000, Number.isFinite(seconds) ? seconds * 1000 : 30000));
          throw failure('rate-limit');
        }
        if (!response.ok) throw failure('http', { httpStatus: response.status });
        let body;
        try { body = await response.json(); } catch { throw failure('json'); }
        return yditsSnapshot(body, now());
      })();
      const data = await Promise.race([loading, aborted]);
      if (episode !== generation || controller.signal.aborted) return false;
      server = index;
      if (index === 0) recoveryAt = 0;
      else if (!recoveryAt) recoveryAt = now() + YDITS_RECOVERY_INTERVAL;
      const { checkedAt, ...content } = data;
      const key = JSON.stringify(content);
      if (key !== lastKey) { onData(data); lastKey = key; }
      const label = !data.active ? 'EEW発表なし' : data.training ? '訓練・試験情報（自動通知なし）'
        : data.stale ? '過去のEEW情報（自動通知なし）' : 'EEW情報受信';
      status('live', index, `YDITS サーバー${index + 1}${index ? '（1の復旧確認待ち）' : ''} / ${label} / ${checkedAt}`);
      return true;
    } catch (error) {
      if (episode !== generation) return false;
      const reason = error.reason || (controller.signal.aborted ? 'timeout' : 'network');
      if (reason === 'rate-limit') {
        delay = Math.max(delay, 30000);
        // Do not evade the provider's rate limit by switching to another server.
        status('limited', index, `YDITS サーバー${index + 1} / レート制限・再試行待ち`, reason);
      } else {
        if (index === 0 && previous > 0) {
          server = previous;
          recoveryAt = now() + YDITS_RECOVERY_INTERVAL;
        } else if (index < 2) {
          server = index + 1;
          recoveryAt = now() + YDITS_RECOVERY_INTERVAL;
        } else {
          server = 0;
          recoveryAt = 0;
          delay = 30000;
        }
        const detail = reason === 'provider' ? `APIのエラー${error.providerStatus ? `（${error.providerStatus}）` : ''}`
          : reason === 'http' ? `HTTP ${error.httpStatus}` : reason === 'json' ? 'JSONではない応答'
          : reason === 'schema' ? '配信JSONが公開仕様と不一致' : reason === 'clock' ? '配信時刻が古い・時計差の確認が必要'
          : reason === 'timeout' ? '5秒のタイムアウト' : '通信失敗（原因未確定）';
        status('error', index, `YDITS サーバー${index + 1} / ${detail} / 次は${server + 1}${delay > YDITS_INTERVAL ? '（再試行待ち）' : ''}`, reason);
      }
      return false;
    } finally {
      environment.clearTimeout(deadline);
      controller.signal.removeEventListener('abort', cancel);
      if (episode === generation) {
        busy = false; request = null;
        nextAt = now() + delay;
        if (enabled) timer = environment.setTimeout(poll, delay);
      }
    }
  }
  function stop() {
    enabled = false; generation++;
    environment.clearTimeout(timer);
    request?.abort(); request = null; busy = false;
  }
  function start() {
    if (enabled) return false;
    enabled = true; generation++;
    server = 0; nextAt = Math.max(nextAt, lastRequestAt + YDITS_INTERVAL); recoveryAt = 0;
    status('loading', 0, 'YDITS サーバー1へ接続中');
    if (now() < nextAt) {
      timer = environment.setTimeout(poll, nextAt - now());
      return false;
    }
    return poll();
  }
  return { start, stop, poll };
}
