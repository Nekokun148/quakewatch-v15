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
  let retryAt = 0;
  const now = () => environment.Date?.now() ?? Date.now();

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
    if (!enabled || busy || environment.document?.hidden || now() < retryAt) return;
    busy = true;
    const episode = generation;
    request = new AbortController();
    const currentRequest = request;
    let stage = 'metadata', httpStatus = 0;
    const deadline = environment.setTimeout(() => currentRequest.abort(), 5000);
    try {
      const url = new URL('latest', base);
      url.searchParams.set('metric', metric);
      const response = await fetcher(url.href, { cache: 'no-store', signal: currentRequest.signal });
      if (episode !== generation || currentRequest.signal.aborted) return;
      if (response.status === 404) {
        retryAt = now() + 30000;
        onStatus('unavailable', '強震モニタ中継APIがありません・30秒後に自動再接続');
        return;
      }
      if (response.status === 429) {
        const seconds = Number(response.headers?.get('Retry-After'));
        retryAt = now() + Math.max(60000, Number.isFinite(seconds) ? Math.min(seconds * 1000, 3600000) : 0);
        onStatus('error', '強震モニタ中継の回数制限・自動再接続待ち');
        return;
      }
      httpStatus = response.status;
      if (!response.ok) throw new Error('Source unavailable');
      stage = 'format';
      const data = await response.json();
      if (episode !== generation || currentRequest.signal.aborted) return;
      const observed = Date.parse(data.observedAt);
      if (!/^20\d{12}$/.test(data.timestamp || '') || !Number.isFinite(observed)) throw new Error('Invalid observation');
      const image = new URL(data.image, base);
      if (image.origin !== base.origin || !image.pathname.startsWith(base.pathname)) throw new Error('Invalid frame origin');
      const stamp = metric + '/' + data.timestamp;
      if (stamp !== lastStamp) {
        stage = 'image';
        const decodedImage = await loadImage(image.href, currentRequest.signal);
        if (episode !== generation || currentRequest.signal.aborted) return;
        stage = 'render';
        await onFrame({ metric, url: image.href, image: decodedImage, timestamp: data.timestamp, observedAt: data.observedAt });
        if (episode !== generation) return;
        lastStamp = stamp;
      }
      if (episode === generation) {
        const age = Math.abs((environment.Date?.now() ?? Date.now()) - observed);
        onStatus(age > 5000 ? 'delayed' : 'live', age > 5000 ? '画像の配信が遅れています' : '1秒間隔で更新中');
      }
    } catch {
      if (episode === generation) {
        const reason = currentRequest.signal.aborted ? '強震モニタの受信が5秒以内に完了しませんでした'
          : stage === 'metadata' ? '強震モニタ中継の時刻情報を取得できません'
          : stage === 'format' ? '強震モニタ中継の応答形式を確認できません'
          : stage === 'image' ? '観測画像を読み込めません（配信元・通信・接続許可等は未特定）'
          : '観測点を描画できません（地図・地点対応表等を確認）';
        const status = stage === 'metadata' && Number.isInteger(httpStatus) && httpStatus >= 400 && httpStatus <= 599
          ? `（HTTP ${httpStatus}）` : '';
        onStatus('error', reason + status + '・自動再試行待ち');
      }
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
    retryAt = 0;
    enabled = true;
    onStatus('loading', '公式観測画像を取得中');
    timer = environment.setInterval(tick, MONITOR_INTERVAL);
    tick();
  }

  environment.document?.addEventListener?.('visibilitychange', () => {
    if (!environment.document.hidden) void tick();
  });
  return { start, stop, tick, asset: kind => new URL(`asset?kind=${encodeURIComponent(kind)}`, base).href };
}
