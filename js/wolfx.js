import { parseReportTime } from './observations.js';

export const WOLFX_EEW_SOCKET = 'wss://ws-api.wolfx.jp/jma_eew';
const scales = { '0': 0, '1': 10, '2': 20, '3': 30, '4': 40, '5弱': 45, '5強': 50, '6弱': 55, '6強': 60, '7': 70, '不明': -1 };
const number = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;

export function wolfxReport(data, now = Date.now()) {
  const issued = parseReportTime(data?.AnnouncedTime);
  const origin = parseReportTime(data?.OriginTime);
  if (!issued || typeof data.EventID !== 'string' || !data.EventID || !Number.isInteger(data.Serial) || data.Serial < 1
    || !['isTraining', 'isAssumption', 'isWarn', 'isFinal', 'isCancel'].every(key => typeof data[key] === 'boolean')
    || !['通常', '訓練', '試験'].includes(data.Issue?.Status)
    || (!data.isCancel && (!origin || typeof data.Hypocenter !== 'string' || !Object.hasOwn(scales, data.MaxIntensity)))) throw new Error('Wolfx schema');
  const training = data.isTraining || data.Issue.Status !== '通常';
  const coordinates = !data.isAssumption && typeof data.Latitude === 'number' && typeof data.Longitude === 'number'
    && Number.isFinite(data.Latitude) && Number.isFinite(data.Longitude) && Math.abs(data.Latitude) <= 90
    && Math.abs(data.Longitude) <= 180 && (data.Latitude !== 0 || data.Longitude !== 0);
  return { stale: now - issued > 120000 || issued - now > 10000, training, report: {
    code: 556, source: 'Wolfx', time: new Date(issued).toISOString(), test: training,
    issue: { eventId: data.EventID, serial: data.Serial, time: new Date(issued).toISOString(), originTime: origin ? new Date(origin).toISOString() : undefined },
    cancelled: data.isCancel, isFinal: data.isFinal, isWarning: data.isWarn,
    earthquake: data.isCancel ? undefined : { originTime: new Date(origin).toISOString(), assumed: data.isAssumption,
      maxScale: scales[data.MaxIntensity], magnitude: data.isAssumption ? null : number(data.Magnitude),
      hypocenter: { name: data.Hypocenter, depth: data.isAssumption ? null : number(data.Depth),
        ...(coordinates ? { latitude: data.Latitude, longitude: data.Longitude } : {}) } },
    areas: data.isCancel ? [] : (Array.isArray(data.WarnArea) ? data.WarnArea : []).filter(area => typeof area.Chiiki === 'string' && Object.hasOwn(scales, area.Shindo1)).map(area => ({ name: area.Chiiki, scaleFrom: scales[area.Shindo2] ?? -1, scaleTo: scales[area.Shindo1] }))
  } };
}

export function createWolfxFeed({ environment = window, onData = () => {}, onStatus = () => {} } = {}) {
  let enabled = false, socket = null, retry = null, watchdog = null, failures = 0;
  const receivedEvents = new Set();
  const status = (phase, text) => onStatus({ phase, text: `Wolfx / ${text}` });
  const clear = () => { environment.clearTimeout(retry); environment.clearTimeout(watchdog); };
  function connect() {
    if (!enabled || socket) return;
    status('loading', '接続中（YDITS障害時の代替）');
    let ws;
    const current = () => enabled && socket === ws;
    const fail = () => {
      if (!current()) return;
      clear(); socket = null; ws?.close();
      const delay = Math.min(60000, 5000 * 2 ** Math.min(failures++, 4));
      status('error', `接続失敗・${delay / 1000}秒後に再接続`);
      retry = environment.setTimeout(connect, delay);
    };
    const watch = delay => { environment.clearTimeout(watchdog); watchdog = environment.setTimeout(fail, delay); };
    try { ws = new environment.WebSocket(WOLFX_EEW_SOCKET); socket = ws; } catch { socket = ws; fail(); return; }
    watch(10000);
    ws.onopen = () => { if (!current()) return; watch(90000); status('connected', '速報待機'); try { ws.send('query_jmaeew'); } catch { fail(); } };
    ws.onmessage = event => {
      if (!current()) return;
      let data;
      try { data = JSON.parse(event.data); } catch { status('error', '受信JSON不正'); return; }
      if (data.type === 'heartbeat' || data.type === 'pong') {
        const timestamp = Number(data.timestamp);
        if (!Number.isFinite(timestamp) || Math.abs(Date.now() - timestamp) > 90000) return;
        failures = 0; watch(90000); status('live', '接続確認受信・速報待機（YDITS障害時の代替）');
        if (data.type === 'heartbeat') { try { ws.send('ping'); } catch { fail(); } }
        return;
      }
      if (data.type !== 'jma_eew') return;
      let parsed;
      try { parsed = wolfxReport(data); } catch { status('error', '速報形式不正'); return; }
      failures = 0; watch(90000);
      if (!parsed.stale) {
        const key = `${parsed.report.issue.eventId}/${parsed.training}`;
        if (parsed.report.cancelled) parsed.report.unmatchedCancel = !receivedEvents.has(key);
        else { receivedEvents.add(key); if (receivedEvents.size > 50) receivedEvents.delete(receivedEvents.values().next().value); }
        onData(parsed.report, { silent: parsed.training });
      }
      status('live', parsed.stale ? '過去の最終受信情報・新しい速報待機' : parsed.training ? '訓練情報受信（自動警報なし）' : '速報受信');
    };
    ws.onerror = fail; ws.onclose = fail;
  }
  return {
    start() { if (enabled) return; enabled = true; failures = 0; connect(); },
    stop() { enabled = false; clear(); const old = socket; socket = null; old?.close(); status('waiting', '待機（YDITS優先）'); }
  };
}
