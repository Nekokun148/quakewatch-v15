const SCOPE = new URL(self.registration.scope);
const PREFIX = `quake-v15-${encodeURIComponent(SCOPE.pathname)}-`;
const CACHE = PREFIX + 'unified-map-v49-public';
const ASSETS = ['./', './index.html', './css/style.css', './js/app.js', './js/observations.js', './js/observation-ui.js', './js/strong-motion.js', './js/monitor-map.js', './js/monitor-changes.js', './js/ydits.js', './js/waves.js', './data/basemap.geojson', './data/monitor-points.json', './THIRD_PARTY_NOTICES.md', './js/eew.js', './js/alarm.js', './js/speech.js', './js/voicevox.js', './js/location.js', './js/sensing-areas.js', './js/seafloor-stations.js', './js/data.js', './js/stations.js', './manifest.json', './icons/icon.svg'];

self.addEventListener('install', event => event.waitUntil(
  caches.open(CACHE).then(cache => cache.addAll([...ASSETS, './js/cloud-voicevox.js', './js/wolfx.js', './js/dmdata.js', './js/dmdata-ui.js', './js/dmdata-shared.js', './js/taiwan-feed.js', './js/taiwan-ui.js', './js/monitor-highlights.js', './js/quake-highlight.js']
    .map(path => new Request(new URL(path, SCOPE), { cache: 'reload' })))).then(() => self.skipWaiting())
));
self.addEventListener('activate', event => event.waitUntil(
  caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith(PREFIX) && key !== CACHE).map(key => caches.delete(key))))
    .then(() => self.clients.claim())
));
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  // Live earthquake APIs bypass this cache; project caches never share data.
  if (event.request.method !== 'GET' || url.origin !== SCOPE.origin || !url.pathname.startsWith(SCOPE.pathname)) return;
  if (url.pathname.startsWith(new URL('api/', SCOPE).pathname)) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const response = await fetch(new Request(event.request, { cache: 'no-store' }));
      if (response.ok) {
        try { await cache.put(event.request, response.clone()); } catch {}
      }
      return response;
    } catch {
      return await cache.match(event.request) || new Response('Offline: file not cached', { status: 503 });
    }
  })());
});
