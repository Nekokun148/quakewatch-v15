export const CWA_RSS_SOURCE = 'https://www.cwa.gov.tw/rss/Data/cwa_warning.xml';
const TTL = 60000, MAX_BYTES = 262144;

function validate(bytes) {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  if (!bytes.length || bytes.length > MAX_BYTES || /<!DOCTYPE|<!ENTITY/i.test(text) ||
      !/^\s*(?:<\?xml[^>]*>\s*)?<rss\b/.test(text) || !text.includes('<channel>') || !/<\/rss>\s*$/.test(text)) throw new Error('Invalid RSS');
  return bytes;
}

async function bytesOf(response) {
  if (Number(response.headers.get('Content-Length')) > MAX_BYTES) {
    await response.body?.cancel().catch(() => {});
    throw new Error('Invalid RSS');
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Invalid RSS');
  const parts = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > MAX_BYTES) throw new Error('RSS too large');
      parts.push(part.value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.byteLength; }
  return validate(bytes);
}

export function createTaiwanRssRelay({ fetcher = fetch, now = Date.now, edgeCache } = {}) {
  let cached, pending, retryAt = 0, failedStatus = 502;
  return {
    async read(host, context) {
      if (cached && now() >= cached.at && now() - cached.at < TTL) return cached.bytes;
      if (now() < retryAt) {
        const error = new Error('RSS unavailable');
        error.status = failedStatus; error.retryAfter = Math.ceil((retryAt - now()) / 1000);
        throw error;
      }
      if (pending) return pending;
      pending = (async () => {
        const cache = edgeCache || (typeof caches === 'undefined' ? undefined : caches.default);
        const key = new Request(new URL('/__qw_cache/cwa-warning-rss', host));
        let saved;
        try { saved = await cache?.match(key); } catch { /* An unavailable cache is not an unavailable source. */ }
        const at = Number(saved?.headers.get('X-QW-Fetched-At'));
        if (saved?.ok && at > 0 && now() >= at && now() - at < TTL) {
          try {
            const bytes = await bytesOf(saved);
            cached = { at, bytes }; return bytes;
          } catch { /* Invalid cache entries are never returned as official RSS. */ }
        }
        const response = await fetcher(CWA_RSS_SOURCE, {
          signal: AbortSignal.timeout(8000), redirect: 'manual', cache: 'no-store',
          headers: { Accept: 'application/xml' }
        });
        if (!response.ok) {
          await response.body?.cancel().catch(() => {});
          const error = new Error('RSS unavailable');
          const value = response.headers.get('Retry-After');
          const seconds = Number(value), date = Date.parse(value || '');
          const wait = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : date - now();
          error.retryAfter = Number.isFinite(wait) && wait > 0 ? Math.ceil(wait / 1000) : 60;
          error.status = response.status === 429 ? 429 : 502;
          throw error;
        }
        if (!/^(?:text|application)\/(?:xml|rss\+xml)\b/i.test(response.headers.get('Content-Type') || '')) {
          await response.body?.cancel().catch(() => {});
          throw new Error('RSS unavailable');
        }
        const bytes = await bytesOf(response);
        cached = { at: now(), bytes }; retryAt = 0;
        if (cache) {
          const write = cache.put(key, new Response(bytes, { headers: {
            'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'public, max-age=60',
            'X-QW-Fetched-At': String(cached.at)
          } })).catch(() => {});
          if (context?.waitUntil) context.waitUntil(write);
          else await write;
        }
        return bytes;
      })().catch(error => {
        failedStatus = error.status || 502;
        retryAt = now() + Math.max(TTL, (error.retryAfter || 60) * 1000);
        throw error;
      }).finally(() => { pending = null; });
      return pending;
    }
  };
}
