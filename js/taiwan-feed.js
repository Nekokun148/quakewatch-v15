export const TAIWAN_INTERVAL = 60000;
export const CWA_RSS_URL = 'https://www.cwa.gov.tw/rss/Data/cwa_warning.xml';
const MAX_BYTES = 262144;

function child(element, name) {
  return [...(element?.children || [])].find(node => node.localName === name);
}

function officialLink(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
    const valid = url.hostname === 'www.cwa.gov.tw' && url.pathname.startsWith('/V8/C/E/') ||
      url.hostname === 'scweb.cwa.gov.tw' && /^\/zh-(?:tw|TW)\/earthquake\//.test(url.pathname);
    return valid ? url.href : null;
  } catch { return null; }
}

export function parseTaiwanRss(text, Parser = globalThis.DOMParser) {
  if (typeof text !== 'string' || new TextEncoder().encode(text).length > MAX_BYTES ||
      /<!DOCTYPE|<!ENTITY/i.test(text) || typeof Parser !== 'function') throw new Error('Invalid RSS');
  const document = new Parser().parseFromString(text, 'application/xml');
  if (document.getElementsByTagName('parsererror').length || document.documentElement?.localName !== 'rss') throw new Error('Invalid RSS');
  const channel = child(document.documentElement, 'channel');
  if (!channel) throw new Error('Invalid RSS');
  const entries = [], seen = new Set();
  for (const item of [...channel.children].filter(node => node.localName === 'item')) {
    const title = child(item, 'title')?.textContent;
    const link = officialLink(child(item, 'link')?.textContent?.trim());
    if (typeof title !== 'string' || !title.includes('地震') || title.length > 1000 || !link || seen.has(link)) continue;
    seen.add(link);
    // RSS conditions allow the original headline and a link, not derived earthquake data.
    entries.push({ title, link });
    if (entries.length === 20) break;
  }
  return entries;
}

async function readText(response) {
  if (Number(response.headers.get('Content-Length')) > MAX_BYTES) {
    await response.body?.cancel().catch(() => {});
    throw new Error('Invalid RSS');
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Invalid RSS');
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let text = '', size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > MAX_BYTES) throw new Error('RSS too large');
      text += decoder.decode(part.value, { stream: true });
    }
    return text + decoder.decode();
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally { reader.releaseLock(); }
}

export function createTaiwanFeed({
  apiBase, environment = window, fetcher = fetch,
  parse = text => parseTaiwanRss(text, environment.DOMParser),
  onItems = () => {}, onStatus = () => {}
}) {
  const base = new URL(apiBase, environment.location.href);
  if (!/^https?:$/.test(base.protocol) || base.username || base.password || base.search || base.hash) throw new Error('Invalid relay');
  const endpoint = new URL('taiwan', base).href;
  let enabled = false, generation = 0, busy = false, request, timer, deadline;
  let failures = 0, nextAt = 0;
  const now = () => environment.Date?.now() ?? Date.now();
  const status = (phase, text) => onStatus({ phase, text, enabled });
  function stop() {
    enabled = false; generation++;
    environment.clearTimeout(timer); environment.clearTimeout(deadline);
    request?.abort(); request = null; busy = false;
    onItems([]); status('off', '未許可・未接続');
  }
  async function tick() {
    if (!enabled || busy || environment.document?.hidden || now() < nextAt) return;
    busy = true;
    const episode = generation, controller = new AbortController();
    request = controller;
    let delay = TAIWAN_INTERVAL;
    try {
      const result = await Promise.race([
        (async () => {
          const response = await fetcher(endpoint, {
            credentials: 'omit', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer',
            signal: controller.signal, headers: { Accept: 'application/xml' }
          });
          if (!response.ok) {
            await response.body?.cancel().catch(() => {});
            const error = new Error('RSS unavailable');
            error.status = response.status;
            error.retry = response.headers?.get('Retry-After');
            throw error;
          }
          if (!/^(?:text|application)\/(?:xml|rss\+xml)\b/i.test(response.headers.get('Content-Type') || '')) {
            await response.body?.cancel().catch(() => {});
            throw new Error('Invalid RSS');
          }
          return parse(await readText(response));
        })(),
        new Promise((_, reject) => {
          deadline = environment.setTimeout(() => { controller.abort(); reject(new Error('Timeout')); }, 8000);
        })
      ]);
      if (episode !== generation || controller.signal.aborted) return;
      onItems(result); failures = 0;
      status('ready', `公式RSSの地震見出し：${result.length}件`);
    } catch (error) {
      if (episode !== generation) return;
      if ([400, 401, 403, 404, 405].includes(error.status)) {
        enabled = false; onItems([]);
        status('unavailable', '台湾RSSの中継は未対応・受信停止');
        return;
      }
      delay = Math.min(TAIWAN_INTERVAL * 2 ** Math.min(failures++, 4), 900000);
      if (error.status === 429) {
        const seconds = Number(error.retry);
        const date = Date.parse(error.retry || '');
        const wait = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : date - now();
        if (Number.isFinite(wait) && wait > 0) delay = Math.max(delay, wait);
      }
      onItems([]);
      status('error', 'RSS取得失敗・再試行待ち（受信未確認）');
    } finally {
      if (episode === generation) {
        environment.clearTimeout(deadline); busy = false; request = null;
        if (enabled) {
          nextAt = now() + delay;
          timer = environment.setTimeout(tick, delay);
        }
      }
    }
  }
  function start() {
    if (enabled) return;
    enabled = true; generation++; failures = 0; nextAt = 0;
    status('loading', '中央氣象署RSSを取得中');
    void tick();
  }
  return { start, stop, tick };
}
