const scales = { '0': 0, '1': 10, '2': 20, '3': 30, '4': 40, '5-': 45, '5+': 50, '6-': 55, '6+': 60, '7': 70, '不明': -1 };
const time = value => typeof value === 'string' && /(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value)) ? Date.parse(value) : 0;
const numeric = value => typeof value === 'string' && /^[+-]?\d+(?:\.\d+)?$/.test(value) && Number.isFinite(Number(value)) ? Number(value) : null;
const scale = value => scales[value] ?? -1;
export function dmdataAllowed(location) {
  if (location?.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(location.hostname)) return true;
  return location?.origin === 'https://nekokun148.github.io'
    && (location.pathname === '/quakewatch-v15' || location.pathname?.startsWith('/quakewatch-v15/'));
}
export const validDmdataKey = value => typeof value === 'string' && /^[\x21-\x7e]{8,512}$/.test(value) && !value.includes(':');

export function dmdataReport(data, now = Date.now(), { warningOnly = false } = {}) {
  const body = data?.body, issued = time(data?.reportDateTime);
  if (data?._schema?.type !== 'eew-information' || data._schema.version !== '1.0.0' || !issued
    || typeof data.eventId !== 'string' || !data.eventId || typeof data.serialNo !== 'string' || !/^\d+$/.test(data.serialNo) || !Number.isSafeInteger(Number(data.serialNo)) || Number(data.serialNo) < 1
    || !['通常', '訓練', '試験'].includes(data.status) || !['発表', '訂正', '遅延', '取消'].includes(data.infoType)
    || typeof body?.isCanceled !== 'boolean' || typeof body?.isLastInfo !== 'boolean') throw new Error('schema');
  const cancelled = body.isCanceled || data.infoType === '取消';
  if (!cancelled && (typeof body.isWarning !== 'boolean' || !body.earthquake?.hypocenter)) throw new Error('schema');
  const e = body.earthquake, h = e?.hypocenter;
  const assumed = e?.condition === '仮定震源要素';
  const lat = numeric(h?.coordinate?.latitude?.value), lng = numeric(h?.coordinate?.longitude?.value);
  const coordinates = !assumed && lat !== null && lng !== null && Math.abs(lat) <= 90 && Math.abs(lng) <= 180
    && (lat !== 0 || lng !== 0) && h?.coordinate?.geodeticSystem !== '日本測地系';
  const regions = Array.isArray(body.intensity?.regions) ? body.intensity.regions : [];
  const areas = regions.filter(area => typeof area.name === 'string').map(area => ({ name: area.name,
    scaleFrom: scale(area.forecastMaxInt?.from), scaleTo: area.forecastMaxInt?.to === 'over' ? 99 : scale(area.forecastMaxInt?.to),
    isPlum: area.isPlum === true, arrivalTime: time(area.arrivalTime) ? area.arrivalTime : undefined }));
  const maximum = body.intensity?.forecastMaxInt;
  const depth = h?.depth?.unit === 'km' && !h.depth.condition ? numeric(h.depth.value) : null;
  const magnitude = numeric(e?.magnitude?.value);
  return { stale: now - issued > 120000 || issued - now > 10000, training: data.status !== '通常', report: {
    code: 556, source: 'DMDATA', time: data.reportDateTime, test: data.status !== '通常', cancelled,
    isWarning: body.isWarning === true, isLast: body.isLastInfo,
    issue: { time: data.reportDateTime, eventId: data.eventId, serial: Number(data.serialNo), originTime: time(e?.originTime) ? e.originTime : undefined },
    earthquake: cancelled ? undefined : { originTime: time(e?.originTime) ? e.originTime : undefined, assumed,
      maxScale: maximum?.to === 'over' ? scale(maximum.from) : scale(maximum?.to), maxAbove: maximum?.to === 'over',
      magnitude: !warningOnly && !assumed && magnitude !== null && magnitude >= 0 ? magnitude : null,
      hypocenter: { name: typeof h?.name === 'string' ? h.name : '情報なし', depth: !warningOnly && !assumed && depth !== null && depth >= 0 ? depth : null,
        ...(coordinates ? { latitude: lat, longitude: lng } : {}) } }, areas: cancelled ? [] : areas
  } };
}

export async function decodeDmdata(message) {
  if (message?.type !== 'data' || message.format !== 'json' || !['VXSE43', 'VXSE44', 'VXSE45'].includes(message.head?.type)
    || typeof message.body !== 'string' || message.body.length > 2000000) throw new Error('format');
  let bytes;
  if (message.encoding === 'base64') bytes = Uint8Array.from(atob(message.body), char => char.charCodeAt(0));
  else if (message.encoding === 'utf-8') bytes = new TextEncoder().encode(message.body);
  else throw new Error('encoding');
  let stream = new Blob([bytes]).stream();
  if (message.compression === 'gzip') stream = stream.pipeThrough(new DecompressionStream('gzip'));
  else if (message.compression !== null) throw new Error('compression');
  const reader = stream.getReader(), parts = []; let size = 0;
  try {
    while (true) { const { done, value } = await reader.read(); if (done) break; size += value.length;
      if (size > 2000000) throw new Error('size'); parts.push(value); }
  } finally { await reader.cancel().catch(() => {}); }
  const output = new Uint8Array(size); let offset = 0;
  for (const part of parts) { output.set(part, offset); offset += part.length; }
  const data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(output));
  if (message.head.test === true || message.xmlReport?.control?.status && message.xmlReport.control.status !== '通常') data.status = '訓練';
  return data;
}

const socketHosts = ['ws.api.dmdata.jp', 'ws-tokyo.api.dmdata.jp', 'ws-osaka.api.dmdata.jp', 'ws001.api.dmdata.jp', 'ws002.api.dmdata.jp', 'ws003.api.dmdata.jp', 'ws004.api.dmdata.jp'];
export function dmdataSocketUrl(value) {
  const url = new URL(value);
  // Reject noncanonical authorities before URL normalization hides explicit ports.
  if (value !== url.href) throw new Error('ticket');
  if (url.protocol !== 'wss:' || !socketHosts.includes(url.hostname) || url.port || url.username || url.password || url.hash
    || url.pathname !== '/v2/websocket' || !url.searchParams.get('ticket') || [...url.searchParams.keys()].some(key => key !== 'ticket')) throw new Error('ticket');
  return url.href;
}

export function createDmdataFeed({ environment = window, fetcher = fetch, decode = decodeDmdata, onData = () => {}, onStatus = () => {} } = {}) {
  let enabled = false, key = '', mode = 'eew.forecast', generation = 0, ws = null, abort = null, retry = null, watchdog = null, failures = 0;
  const events = new Set();
  const classifications = () => mode === 'both' ? ['eew.forecast', 'eew.warning'] : [mode];
  const status = (phase, text) => onStatus({ phase, enabled, text: `DMDATA / ${text}` });
  const clear = () => { environment.clearTimeout(retry); environment.clearTimeout(watchdog); abort?.abort(); abort = null; const old = ws; ws = null; old?.close(); };
  function stop() { enabled = false; generation++; clear(); key = ''; status('off', '未接続'); }
  async function connect() {
    if (!enabled) return;
    const run = ++generation; const current = () => enabled && run === generation;
    clear(); status('loading', '接続中');
    const fail = (reason, fatal = false, delay = 0) => {
      if (!current()) return;
      generation++; clear();
      if (fatal) { enabled = false; key = ''; status('error', reason); return; }
      const wait = Math.max(delay, Math.min(60000, 5000 * 2 ** Math.min(failures++, 4)));
      status('error', `${reason}・${wait / 1000}秒後に再接続`); retry = environment.setTimeout(connect, wait);
    };
    const watch = ms => { environment.clearTimeout(watchdog); watchdog = environment.setTimeout(() => fail('接続確認タイムアウト'), ms); };
    try {
      abort = new AbortController(); watch(10000);
      const response = await fetcher('https://api.dmdata.jp/v2/socket', { method: 'POST', credentials: 'omit', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer', signal: abort.signal,
        headers: { Authorization: `Basic ${btoa(key + ':')}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ classifications: classifications(), types: mode === 'both' ? ['VXSE43', 'VXSE44', 'VXSE45'] : mode === 'eew.warning' ? ['VXSE43'] : ['VXSE44', 'VXSE45'], test: 'no', appName: 'QuakeWatch ver15', formatMode: 'json' }) });
      if (!current()) return;
      if (!response.ok) { const code = response.status; fail(code === 401 ? '認証失敗' : code === 402 ? '対象区分の契約なし' : code === 403 ? '権限・接続元を確認' : code === 409 ? '同時接続数の上限' : code === 429 ? 'レート制限' : 'API接続失敗', [400, 401, 402, 403, 409].includes(code), code === 429 ? 60000 : 0); return; }
      const info = await response.json(); if (!current()) return;
      if (info.status !== 'ok' || JSON.stringify(info.websocket?.protocol) !== '["dmdata.v2"]') { fail('接続情報の形式不一致', true); return; }
      const url = dmdataSocketUrl(info.websocket.url);
      abort = null; ws = new environment.WebSocket(url, ['dmdata.v2']); watch(15000);
      const socket = ws; let queue = Promise.resolve(), started = false;
      socket.onmessage = event => {
        if (!current() || socket !== ws) return;
        let message;
        try { if (typeof event.data !== 'string' || event.data.length > 2500000) throw new Error(); message = JSON.parse(event.data); }
        catch { status('invalid', '受信形式不一致'); return; }
        if (message.type === 'start') { if (!Array.isArray(message.classifications) || !classifications().every(value => message.classifications.includes(value)) || !time(message.time)) { fail('配信区分・開始情報不一致', true); return; } started = true; failures = 0; watch(150000); status('live', mode === 'both' ? '接続済み・予報と警報の速報待機' : '接続済み・速報待機'); return; }
        if (message.type === 'ping') { if (typeof message.pingId !== 'string' || message.pingId.length > 64) return;
          try { socket.send(JSON.stringify({ type: 'pong', pingId: message.pingId })); if (started) watch(150000); } catch { fail('送信失敗'); } return; }
        if (message.type === 'error') { fail('配信接続エラー', [4400, 4404, 4409, 4807, 4808].includes(message.code)); return; }
        if (message.type !== 'data' || !started) return;
        queue = queue.then(async () => {
          if (!current()) return;
          const parsed = dmdataReport(await decode(message), Date.now(), { warningOnly: message.head?.type === 'VXSE43' }); if (!current()) return;
          if (parsed.stale) { status('live', '過去の速報を除外・新しい速報待機'); return; }
          const eventKey = `${parsed.report.issue.eventId}/${parsed.training}`;
          if (parsed.report.cancelled) parsed.report.unmatchedCancel = !events.has(eventKey);
          else { events.add(eventKey); if (events.size > 50) events.delete(events.values().next().value); }
          onData(parsed.report, { silent: parsed.training }); status('live', parsed.training ? '訓練情報（自動警報なし）' : '速報受信');
        }).catch(() => { if (current()) status('invalid', '未対応・不正な速報を除外'); });
      };
      socket.onerror = () => fail('通信失敗'); socket.onclose = () => fail('切断');
    } catch { fail('通信・接続情報の確認に失敗'); }
  }
  return { start(apiKey, classification = 'eew.forecast') {
    if (enabled) return;
    if (!dmdataAllowed(environment.location)) throw new Error('unsupported-origin');
    if (!validDmdataKey(apiKey)) throw new Error('credential');
    if (!['eew.forecast', 'eew.warning', 'both'].includes(classification)) throw new Error('classification');
    enabled = true; key = apiKey; mode = classification; failures = 0; void connect();
  }, stop };
}
