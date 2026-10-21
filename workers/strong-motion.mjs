import { createTaiwanRssRelay } from './taiwan-rss.mjs';

const SOURCE = 'http://www.kmoni.bosai.go.jp/';
const ORIGIN = 'https://nekokun148.github.io';
const PREFIX = '/api/strong-motion/';
const METRICS = { intensity: 'jma_s', acceleration: 'acmap_s' };
const ASSETS = {
  map: 'data/map_img/CommonImg/base_map_w.gif',
  'intensity-scale': 'data/map_img/ScaleImg/nied_jma_s_b_scale.gif',
  'acceleration-scale': 'data/map_img/ScaleImg/nied_acmap_s_b_scale.gif'
};

function sourceTime(value) {
  const match = /^(20\d{2})\/(\d{2})\/(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(value || '');
  if (!match) throw new Error('Invalid source time');
  const [year, month, day, hour, minute, second] = match.slice(1).map(Number);
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() + 1 !== month || date.getUTCDate() !== day ||
      date.getUTCHours() !== hour || date.getUTCMinutes() !== minute || date.getUTCSeconds() !== second) {
    throw new Error('Invalid source time');
  }
  return { timestamp: match.slice(1).join(''), observedAt: `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}+09:00` };
}

async function readBounded(response, maximum) {
  if (Number(response.headers.get('content-length')) > maximum) throw new Error('Source too large');
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Empty source');
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.byteLength;
      if (length > maximum) throw new Error('Source too large');
      chunks.push(part.value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

/** @param {{ fetcher?: typeof fetch, now?: () => number, edgeCache?: Pick<Cache, 'match' | 'put'> }} options */
export function createStrongMotionWorker({ fetcher = fetch, now = Date.now, edgeCache } = {}) {
  const taiwanRss = createTaiwanRssRelay({ fetcher, now, edgeCache });
  const memory = new Map();
  const pending = new Map();

  async function obtain(source, ttl, json, host, context) {
    const old = memory.get(source);
    if (old && now() - old.loadedAt < old.ttl) {
      if (old.error) throw new Error('Source unavailable');
      return old.value;
    }
    if (pending.has(source)) return pending.get(source);
    if (pending.size >= 12) throw new Error('Relay busy');
    const task = (async () => {
      const key = new Request(new URL(`/__qw_cache/${encodeURIComponent(source)}`, host));
      const cache = edgeCache || (typeof caches === 'undefined' ? undefined : caches.default);
      let cached;
      try { cached = await cache?.match(key); } catch { /* Cache failure must not disable observations. */ }
      const cachedAt = Number(cached?.headers.get('X-QW-Fetched-At'));
      let loadedAt = now();
      let value;
      if (cached?.ok && cachedAt > 0 && loadedAt >= cachedAt && loadedAt - cachedAt < ttl) {
        loadedAt = cachedAt;
        value = json ? await cached.json() : new Uint8Array(await cached.arrayBuffer());
      } else {
        const controller = new AbortController();
        const deadline = setTimeout(() => controller.abort(), 3500);
        try {
          const response = await fetcher(source + (json ? `?_=${now()}` : ''), {
            signal: controller.signal, redirect: 'manual', cache: 'no-store'
          });
          if (!response.ok) throw new Error(`Source returned HTTP ${response.status}`);
          const bytes = await readBounded(response, json ? 65536 : 1000000);
          if (json) {
            const data = JSON.parse(new TextDecoder().decode(bytes));
            if (data.result?.status !== 'success') throw new Error('Source unavailable');
            value = sourceTime(data.latest_time);
          } else {
            if (!/^image\/gif\b/i.test(response.headers.get('content-type') || '') || bytes.length < 10 ||
                !['GIF87a', 'GIF89a'].includes(new TextDecoder().decode(bytes.slice(0, 6)))) throw new Error('Invalid image');
            value = bytes;
          }
        } finally { clearTimeout(deadline); }
        loadedAt = now();
        if (cache) {
          const response = new Response(value instanceof Uint8Array ? value : JSON.stringify(value), { headers: {
            'Content-Type': json ? 'application/json' : 'image/gif',
            'Cache-Control': `public, max-age=${Math.ceil(ttl / 1000)}`,
            'X-QW-Fetched-At': String(loadedAt)
          } });
          const write = cache.put(key, response).catch(() => {});
          if (context?.waitUntil) context.waitUntil(write);
          else await write;
        }
      }
      memory.set(source, { loadedAt, ttl, value });
      return value;
    })().catch(error => {
      memory.set(source, { loadedAt: now(), ttl: 1000, error: true });
      throw error;
    }).finally(() => {
      pending.delete(source);
      while (memory.size > 12) memory.delete(memory.keys().next().value);
    });
    pending.set(source, task);
    return task;
  }

  return async function handle(request, env, context) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin');
    const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', Vary: 'Origin' };
    if (origin && origin !== ORIGIN) return new Response('Origin not allowed', { status: 403, headers });
    if (origin) headers['Access-Control-Allow-Origin'] = ORIGIN;
    const reply = (body, status = 200, extra = {}) => new Response(body, { status, headers: { ...headers, ...extra } });
    if (!url.pathname.startsWith(PREFIX)) return reply('Not found', 404);
    if (request.method === 'OPTIONS') return reply(null, 204, {
      'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Max-Age': '86400'
    });
    if (request.method !== 'GET') return reply('Method not allowed', 405, { Allow: 'GET, OPTIONS' });
    const route = url.pathname.slice(PREFIX.length);
    if (route === 'taiwan') {
      if (url.search) return reply('Invalid parameters', 400);
      try {
        const bytes = await taiwanRss.read(url.origin, context);
        return reply(bytes, 200, { 'Content-Type': 'application/xml; charset=utf-8' });
      } catch (error) {
        return reply('Taiwan RSS unavailable', error.status === 429 ? 429 : 502, { 'Retry-After': String(Math.max(60, error.retryAfter || 60)) });
      }
    }
    const allowed = route === 'latest' ? ['metric'] : route === 'frame' ? ['metric', 'time'] : route === 'asset' ? ['kind'] : null;
    if (!allowed) return reply('Not found', 404);
    if ([...url.searchParams.keys()].some(key => !allowed.includes(key) || url.searchParams.getAll(key).length !== 1)) {
      return reply('Invalid parameters', 400);
    }
    const metric = url.searchParams.get('metric');
    let source, ttl;
    if (route === 'asset') {
      const kind = url.searchParams.get('kind');
      if (!Object.hasOwn(ASSETS, kind)) return reply('Invalid asset', 400);
      source = SOURCE + ASSETS[kind]; ttl = 3600000;
    } else {
      if (!Object.hasOwn(METRICS, metric)) return reply('Invalid metric', 400);
      if (route === 'latest') {
        source = SOURCE + 'webservice/server/pros/latest.json'; ttl = 750;
      } else {
        const time = url.searchParams.get('time');
        if (!/^20\d{12}$/.test(time || '')) return reply('Invalid frame', 400);
        try { sourceTime(`${time.slice(0, 4)}/${time.slice(4, 6)}/${time.slice(6, 8)} ${time.slice(8, 10)}:${time.slice(10, 12)}:${time.slice(12)}`); }
        catch { return reply('Invalid frame', 400); }
        const layer = METRICS[metric];
        source = `${SOURCE}data/map_img/RealTimeImg/${layer}/${time.slice(0, 8)}/${time}.${layer}.gif`; ttl = 4000;
      }
    }
    try {
      const result = await obtain(source, ttl, route === 'latest', url.origin, context);
      return route === 'latest'
        ? reply(JSON.stringify({ ...result, image: `frame?metric=${metric}&time=${result.timestamp}` }), 200, { 'Content-Type': 'application/json; charset=utf-8' })
        : reply(result, 200, { 'Content-Type': 'image/gif', 'Cache-Control': `public, max-age=${ttl / 1000}` });
    } catch (error) {
      console.warn({ event: 'strong-motion-upstream-failure', name: error.name, message: error.message });
      return reply(JSON.stringify({ error: 'Strong monitor source unavailable' }), 502, { 'Content-Type': 'application/json; charset=utf-8', 'Retry-After': '1' });
    }
  };
}

export default { fetch: createStrongMotionWorker() };
