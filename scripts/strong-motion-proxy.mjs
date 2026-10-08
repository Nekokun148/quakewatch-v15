const SOURCE = 'http://www.kmoni.bosai.go.jp/';
const METRICS = { intensity: 'jma_s', acceleration: 'acmap_s' };
const ASSETS = {
  map: 'data/map_img/CommonImg/base_map_w.gif',
  'intensity-scale': 'data/map_img/ScaleImg/nied_jma_s_b_scale.gif',
  'acceleration-scale': 'data/map_img/ScaleImg/nied_acmap_s_b_scale.gif'
};

export function sourceTime(value) {
  const match = /^(\d{4})\/(\d{2})\/(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(value || '');
  if (!match) throw new Error('Invalid source time');
  const stamp = match.slice(1).join('');
  const iso = `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}+09:00`;
  if (!Number.isFinite(Date.parse(iso))) throw new Error('Invalid source time');
  return { timestamp: stamp, observedAt: iso };
}

export function frameSource(metric, time) {
  const layer = Object.hasOwn(METRICS, metric) ? METRICS[metric] : null;
  if (!layer || !/^20\d{12}$/.test(time || '')) throw new Error('Invalid frame request');
  return `${SOURCE}data/map_img/RealTimeImg/${layer}/${time.slice(0, 8)}/${time}.${layer}.gif`;
}

export function createStrongMotionProxy({ fetcher = fetch, now = Date.now } = {}) {
  const cache = new Map();
  let latest;
  let latestPromise;

  async function getLatest() {
    if (latest && now() - latest.loadedAt < 750) return latest;
    if (!latestPromise) latestPromise = (async () => {
      const url = `${SOURCE}webservice/server/pros/latest.json?_=${now()}`;
      const response = await fetcher(url, { signal: AbortSignal.timeout(3500), headers: { 'Cache-Control': 'no-cache' } });
      if (!response.ok) throw new Error('Source unavailable');
      const data = await response.json();
      if (data.result?.status !== 'success') throw new Error('Source unavailable');
      latest = { ...sourceTime(data.latest_time), loadedAt: now() };
      return latest;
    })().finally(() => { latestPromise = null; });
    return latestPromise;
  }

  async function image(url, fixed = false) {
    const old = cache.get(url);
    if (old && now() - old.time < (fixed ? 3600000 : 4000)) return old;
    const response = await fetcher(url, { signal: AbortSignal.timeout(3500) });
    if (!response.ok || !/^image\/gif\b/i.test(response.headers.get('content-type') || '')) throw new Error('Frame unavailable');
    const data = new Uint8Array(await response.arrayBuffer());
    if (data.byteLength < 10 || data.byteLength > 1000000 || String.fromCharCode(...data.slice(0, 3)) !== 'GIF') throw new Error('Invalid image');
    const result = { data, time: now() };
    cache.set(url, result);
    if (cache.size > 12) cache.delete(cache.keys().next().value);
    return result;
  }

  return async function handle(request, response, url, base) {
    const prefix = base + 'api/strong-motion/';
    if (!url.pathname.startsWith(prefix)) return false;
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    if (request.method !== 'GET') { response.writeHead(405).end(); return true; }
    const route = url.pathname.slice(prefix.length);
    try {
      if (route === 'latest') {
        const metric = url.searchParams.get('metric');
        if (!Object.hasOwn(METRICS, metric)) { response.writeHead(400).end('Invalid metric'); return true; }
        const time = await getLatest();
        response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify({
          timestamp: time.timestamp, observedAt: time.observedAt,
          image: `frame?metric=${metric}&time=${time.timestamp}`
        }));
      } else if (route === 'frame' || route === 'asset') {
        let source;
        if (route === 'asset') {
          const kind = url.searchParams.get('kind');
          const path = Object.hasOwn(ASSETS, kind) ? ASSETS[kind] : null;
          if (!path) { response.writeHead(400).end('Invalid asset'); return true; }
          source = SOURCE + path;
        } else {
          try { source = frameSource(url.searchParams.get('metric'), url.searchParams.get('time')); }
          catch { response.writeHead(400).end('Invalid frame'); return true; }
        }
        const result = await image(source, route === 'asset');
        response.writeHead(200, { 'Content-Type': 'image/gif' }).end(result.data);
      } else response.writeHead(404).end('Not found');
    } catch {
      response.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify({ error: 'Strong monitor source unavailable' }));
    }
    return true;
  };
}
