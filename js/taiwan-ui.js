import { createTaiwanFeed } from './taiwan-feed.js';

export function mountTaiwan({ environment = window, createFeed = createTaiwanFeed, apiBase = 'api/strong-motion/' } = {}) {
  const { document } = environment;
  const section = document.getElementById('taiwanReports');
  const toggle = document.getElementById('taiwanConsent');
  const display = document.getElementById('taiwanStatus');
  const list = document.getElementById('taiwanItems');
  if (!section || !toggle || !display || !list) return null;
  toggle.checked = false;
  list.replaceChildren();
  display.textContent = '未許可・未接続';
  const feed = createFeed({
    environment, apiBase,
    onItems(items) {
      list.replaceChildren();
      if (!toggle.checked) return;
      for (const item of items) {
        const row = document.createElement('li');
        const link = document.createElement('a');
        link.textContent = item.title;
        link.href = item.link; link.target = '_blank'; link.rel = 'noopener noreferrer';
        row.append(link); list.append(row);
      }
    },
    onStatus(info) {
      display.textContent = info.text;
      section.dataset.phase = info.phase;
      if (!info.enabled) toggle.checked = false;
    }
  });
  toggle.addEventListener('change', () => {
    if (toggle.checked) feed.start();
    else feed.stop();
  });
  const resume = () => { if (toggle.checked) void feed.tick(); };
  document.addEventListener('visibilitychange', resume);
  environment.addEventListener('online', resume);
  environment.addEventListener('pagehide', () => { toggle.checked = false; feed.stop(); });
  environment.addEventListener('pageshow', event => { if (event.persisted) { toggle.checked = false; feed.stop(); } });
  return feed;
}
