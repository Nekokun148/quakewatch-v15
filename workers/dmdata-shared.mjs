import { validDmdataKey, dmdataSocketUrl } from '../js/dmdata.js';
import { SHARED_CLASSES, SHARED_TYPES, sharedTelegram } from './dmdata-shared-data.mjs';

export const SHARED_PATH = '/api/dmdata/stream';
const ORIGIN = 'https://nekokun148.github.io';
const phases = new Set(['loading', 'live', 'error', 'off', 'unconfigured']);
const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', Vary: 'Origin' };
const reply = (status, phase) => new Response(JSON.stringify({ version: 1, phase }), {
  status, headers: { ...headers, 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': ORIGIN }
});

async function readTicket(response) {
  const reader = response.body?.getReader();
  if (!reader || Number(response.headers.get('content-length')) > 16384) throw new Error('ticket-size');
  const parts = []; let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      length += value.length; if (length > 16384) throw new Error('ticket-size'); parts.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  const bytes = new Uint8Array(length); let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.length; }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}

export function sharedRequestAllowed(request) {
  const url = new URL(request.url);
  return url.protocol === 'https:' && url.pathname === SHARED_PATH && !url.search
    && request.method === 'GET' && request.headers.get('Origin') === ORIGIN
    && request.headers.get('Upgrade')?.toLowerCase() === 'websocket'
    && !request.headers.has('Authorization');
}

export function createSharedUpstream({ key, environment = globalThis, fetcher = fetch, onReport = () => {}, onStatus = () => {} }) {
  let enabled = false, generation = 0, socket = null, abort = null, retry = null, watch = null, failures = 0, fatal = false;
  const status = phase => onStatus(phases.has(phase) ? phase : 'error');
  function clear() {
    environment.clearTimeout(retry); environment.clearTimeout(watch); abort?.abort(); abort = null;
    const old = socket; socket = null; try { old?.close(); } catch {}
  }
  function stop() { enabled = false; generation++; clear(); status('off'); }
  async function connect() {
    if (!enabled || fatal) return;
    clear(); const run = ++generation; status('loading');
    const current = () => enabled && generation === run;
    const fail = (terminal, minimum = 0) => {
      if (!current()) return;
      generation++; clear(); fatal ||= terminal; status('error');
      if (!fatal) retry = environment.setTimeout(connect, Math.max(minimum, Math.min(60000, 5000 * 2 ** Math.min(failures++, 4))));
    };
    const deadline = ms => { environment.clearTimeout(watch); watch = environment.setTimeout(() => fail(false), ms); };
    try {
      abort = new AbortController(); deadline(10000);
      const response = await fetcher('https://api.dmdata.jp/v2/socket', {
        method: 'POST', redirect: 'error', credentials: 'omit', cache: 'no-store', signal: abort.signal,
        headers: { Authorization: `Basic ${btoa(key + ':')}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ classifications: SHARED_CLASSES, types: SHARED_TYPES, test: 'no', appName: 'QuakeWatch shared', formatMode: 'json' })
      });
      if (!current()) return;
      if (!response.ok) { fail([400, 401, 402, 403, 409].includes(response.status), response.status === 429 ? 60000 : 0); return; }
      const info = await readTicket(response);
      if (!current()) return;
      if (info.status !== 'ok' || JSON.stringify(info.websocket?.protocol) !== '["dmdata.v2"]') { fail(true); return; }
      let target;
      try { target = dmdataSocketUrl(info.websocket.url); } catch { fail(true); return; }
      socket = new environment.WebSocket(target, ['dmdata.v2']);
      const activeSocket = socket; let started = false, queued = 0, queue = Promise.resolve();
      deadline(15000);
      socket.onmessage = event => {
        if (!current() || socket !== activeSocket) return;
        let message;
        try {
          if (typeof event.data !== 'string' || event.data.length > 2500000) throw new Error();
          message = JSON.parse(event.data);
        } catch { fail(false); return; }
        if (message.type === 'start') {
          if (!Array.isArray(message.classifications) || message.classifications.length !== SHARED_CLASSES.length
            || !SHARED_CLASSES.every(value => message.classifications.includes(value)) || !Number.isFinite(Date.parse(message.time))
            || !Array.isArray(message.types) || message.types.length !== SHARED_TYPES.length
            || !SHARED_TYPES.every(value => message.types.includes(value)) || message.test !== 'no') { fail(true); return; }
          started = true; failures = 0; deadline(150000); status('live'); return;
        }
        if (message.type === 'ping') {
          if (typeof message.pingId !== 'string' || message.pingId.length > 64) return;
          try { activeSocket.send(JSON.stringify({ type: 'pong', pingId: message.pingId })); if (started) { deadline(150000); status('live'); } } catch { fail(false); }
          return;
        }
        if (message.type === 'error') { fail([4400, 4404, 4409, 4807, 4808].includes(message.code)); return; }
        if (message.type !== 'data' || !started) return;
        if (++queued > 16) { fail(false); return; }
        queue = queue.then(async () => {
          if (!current()) return;
          const report = await sharedTelegram(message, environment.Date?.now() ?? Date.now());
          if (current() && report) onReport(report);
        }).catch(() => {}).finally(() => { queued--; });
      };
      socket.onclose = () => fail(false); socket.onerror = () => fail(false);
    } catch { fail(false); }
  }
  return { start() { if (enabled || fatal) return; if (!validDmdataKey(key)) { status('unconfigured'); return; } enabled = true; void connect(); }, stop };
}

export class DmdataSharedHub {
  constructor(state, env) {
    this.state = state; this.env = env; this.clients = new Set(); this.phase = 'off'; this.recent = new Map();
    this.upstream = createSharedUpstream({ key: env.DMDATA_API_KEY,
      onReport: message => this.publish(message), onStatus: phase => {
        this.phase = phase; this.broadcast({ type: 'status', version: 1, phase });
      } });
  }
  send(socket, message) { try { socket.send(JSON.stringify(message)); } catch { this.remove(socket); } }
  broadcast(message) { for (const socket of [...this.clients]) this.send(socket, message); }
  remove(socket) {
    if (!this.clients.delete(socket)) return;
    try { socket.close(1000, 'closed'); } catch {}
    if (!this.clients.size) { this.upstream.stop(); this.recent.clear(); }
  }
  publish(message) {
    const key = `${message.kind}/${message.report.issue.eventId}`;
    const old = this.recent.get(key)?.report;
    if (old && (Date.parse(old.time) > Date.parse(message.report.time)
      || (old.issue.serial && old.issue.serial > message.report.issue.serial))) return;
    this.recent.set(key, message);
    while (this.recent.size > 32) this.recent.delete(this.recent.keys().next().value);
    this.broadcast(message);
  }
  async fetch(request) {
    if (!sharedRequestAllowed(request)) return reply(403, 'off');
    if (this.env.SHARED_ENABLED !== 'true' || !validDmdataKey(this.env.DMDATA_API_KEY)) return reply(503, 'unconfigured');
    const limit = Math.max(1, Math.min(200, Number(this.env.MAX_CLIENTS) || 64));
    if (this.clients.size >= limit) return reply(503, 'error');
    const [client, server] = Object.values(new WebSocketPair());
    server.accept(); this.clients.add(server);
    server.addEventListener('close', () => this.remove(server));
    server.addEventListener('error', () => this.remove(server));
    // Downstream is receive-only; no credentials, remote URLs or control commands are accepted.
    server.addEventListener('message', () => this.remove(server));
    this.send(server, { type: 'status', version: 1, phase: this.phase });
    for (const message of this.recent.values()) {
      const issued = Date.parse(message.report.time);
      if (Date.now() - issued <= 120000 && issued <= Date.now() + 10000) this.send(server, { ...message, replay: true });
    }
    this.upstream.start();
    return new Response(null, { status: 101, webSocket: client, headers });
  }
}

export default {
  async fetch(request, env) {
    if (!sharedRequestAllowed(request)) return reply(403, 'off');
    if (env.SHARED_ENABLED !== 'true' || !env.DMDATA_SHARED || !validDmdataKey(env.DMDATA_API_KEY)) return reply(503, 'unconfigured');
    return env.DMDATA_SHARED.get(env.DMDATA_SHARED.idFromName('warning-and-earthquake-only')).fetch(request);
  }
};
