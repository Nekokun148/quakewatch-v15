export const MONITOR_INTERVAL = 1000;
const METRICS = ['intensity', 'acceleration'];

export function createStrongMotionController({
  apiBase, environment = window, fetcher = fetch,
  onFrame = () => {}, onStatus = () => {}
}) {
  const base = new URL(apiBase, environment.location.href);
  if (!/^https?:$/.test(base.protocol) || base.username || base.password) throw new Error('Invalid monitor API');
  let metric = 'intensity';
  let timer;
  let request;
  let generation = 0;
  let enabled = false;
  let busy = false;
  let lastStamp = '';

  function loadImage(url, signal) {
    return new Promise((resolve, reject) => {
      const img = new environment.Image();
      const cancel = () => { img.src = ''; finish(new Error('Aborted')); };
      const timeout = environment.setTimeout(() => finish(new Error('Image timeout')), 3500);
      function finish(error) {
        environment.clearTimeout(timeout);
        signal.removeEventListener('abort', cancel);
        img.onload = img.onerror = null;
        if (error) reject(error);
        else resolve(img);
      }
      img.onload = () => finish(img.naturalWidth > 1 && img.naturalHeight > 1 ? null : new Error('No observation image'));
      img.onerror = () => finish(new Error('Image unavailable'));
      signal.addEventListener('abort', cancel, { once: true });
      img.crossOrigin = 'anonymous';
      if (signal.aborted) cancel();
      else img.src = url;
    });
  }

  async function tick() {
    if (!enabled || busy || environment.document?.hidden) return;
    busy = true;
    const episode = generation;
    request = new AbortController();
    const currentRequest = request;
    const deadline = environment.setTimeout(() => currentRequest.abort(), 5000);
    try {
      const url = new URL('latest', base);
      url.searchParams.set('metric', metric);
      const response = await fetcher(url.href, { cache: 'no-store', signal: currentRequest.signal });
      if (response.status === 404) {
        stop();
        onStatus('unavailable', '強震モニタ中継APIがありません（公式サイトで確認できます）');
        return;
      }
      if (!response.ok) throw new Error('Source unavailable');
      const data = await response.json();
      const observed = Date.parse(data.observedAt);
      if (!/^20\d{12}$/.test(data.timestamp || '') || !Number.isFinite(observed)) throw new Error('Invalid observation');
      const image = new URL(data.image, base);
      if (image.origin !== base.origin || !image.pathname.startsWith(base.pathname)) throw new Error('Invalid frame origin');
      const stamp = metric + '/' + data.timestamp;
      if (stamp !== lastStamp) {
        const decodedImage = await loadImage(image.href, currentRequest.signal);
        if (episode !== generation || currentRequest.signal.aborted) return;
        await onFrame({ metric, url: image.href, image: decodedImage, timestamp: data.timestamp, observedAt: data.observedAt });
        if (episode !== generation) return;
        lastStamp = stamp;
      }
      if (episode === generation) {
        const age = Math.abs((environment.Date?.now() ?? Date.now()) - observed);
        onStatus(age > 5000 ? 'delayed' : 'live', age > 5000 ? '画像の配信が遅れています' : '1秒間隔で更新中');
      }
    } catch {
      if (episode === generation) onStatus('error', '画像を取得できません・再試行待ち');
    } finally {
      environment.clearTimeout(deadline);
      if (episode === generation) { busy = false; request = null; }
    }
  }

  function stop() {
    enabled = false;
    generation++;
    environment.clearInterval(timer);
    request?.abort();
    request = null;
    busy = false;
  }

  function start(value) {
    if (!METRICS.includes(value)) throw new Error('Invalid metric');
    stop();
    metric = value;
    lastStamp = '';
    enabled = true;
    onStatus('loading', '公式観測画像を取得中');
    timer = environment.setInterval(tick, MONITOR_INTERVAL);
    tick();
  }

  return { start, stop, tick, asset: kind => new URL(`asset?kind=${encodeURIComponent(kind)}`, base).href };
}
