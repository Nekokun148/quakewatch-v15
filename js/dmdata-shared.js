const labels = {
  unconfigured: '共有DMDATA / 配信サーバー準備中', off: '共有DMDATA / 未接続',
  loading: '共有DMDATA / 接続確認中', live: '共有DMDATA / 警報・地震情報を受信待機',
  error: '共有DMDATA / 接続失敗・代替経路で待機'
};

export function sharedStreamUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash
    || url.pathname !== '/api/dmdata/stream' || url.hostname === 'localhost' || !url.hostname.includes('.')) throw new Error('Invalid shared relay');
  url.protocol = 'wss:';
  return url.href;
}

export function sharedMessage(value, now = Date.now()) {
  if (typeof value !== 'string' || value.length > 256000) return null;
  const message = JSON.parse(value);
  if (message?.version !== 1) return null;
  if (message.type === 'status') return Object.hasOwn(labels, message.phase) ? { type: 'status', phase: message.phase } : null;
  const report = message.report;
  const issued = Date.parse(report?.time);
  if (message.type !== 'report' || !['warning', 'earthquake'].includes(message.kind) || report?.source !== 'DMDATA'
    || report.test === true || !Number.isFinite(issued) || now - issued > 120000 || issued - now > 10000
    || typeof report.issue?.eventId !== 'string' || report.issue.eventId.length > 64) return null;
  if (message.kind === 'warning') {
    if (report.code !== 556 || (!report.cancelled && (report.isWarning !== true || report.earthquake?.magnitude !== null
      || report.earthquake?.hypocenter?.depth !== null))) return null;
  } else if (report.code !== 551 || (!report.cancelled && !report.earthquake?.hypocenter)) return null;
  return { type: 'report', kind: message.kind, report, replay: message.replay === true };
}

export function createSharedDmdataFeed({ url, environment = window, onData = () => {}, onStatus = () => {} } = {}) {
  let enabled = false, socket = null, generation = 0, retry = null, watch = null, failures = 0;
  let latestWarning = null;
  const status = phase => onStatus({ phase, text: labels[phase] });
  function clear() {
    environment.clearTimeout(retry); environment.clearTimeout(watch);
    const old = socket; socket = null; try { old?.close(); } catch {}
  }
  function connect() {
    if (!enabled) return;
    const run = ++generation; clear(); status('loading');
    const current = () => enabled && generation === run;
    const fail = () => {
      if (!current()) return;
      generation++; clear(); status('error');
      retry = environment.setTimeout(connect, Math.min(60000, 5000 * 2 ** Math.min(failures++, 4)));
    };
    const deadline = ms => { environment.clearTimeout(watch); watch = environment.setTimeout(fail, ms); };
    try {
      socket = new environment.WebSocket(sharedStreamUrl(url));
      const active = socket; deadline(15000); let live = false;
      socket.onmessage = event => {
        if (!current() || socket !== active) return;
        let message;
        try { message = sharedMessage(event.data, environment.Date?.now() ?? Date.now()); } catch { return; }
        if (!message) return;
        if (message.type === 'status') {
          live = message.phase === 'live'; if (live) failures = 0;
          status(message.phase); deadline(180000); return;
        }
        if (!live) return;
        if (message.kind === 'warning') {
          const id = message.report.issue.eventId;
          const issued = Date.parse(message.report.time);
          if (message.report.cancelled) message.report.unmatchedCancel = latestWarning?.id !== id;
          else if (!latestWarning || issued >= latestWarning.issued) latestWarning = { id, issued };
        }
        onData(message.report, { silent: message.replay, shared: true }); deadline(180000);
      };
      socket.onclose = fail; socket.onerror = fail;
    } catch { fail(); }
  }
  function stop() { enabled = false; generation++; clear(); status('off'); }
  return {
    start() {
      if (enabled) return;
      if (!url) { status('unconfigured'); return; }
      try { sharedStreamUrl(url); } catch { status('unconfigured'); return; }
      enabled = true; failures = 0; connect();
    }, stop
  };
}
