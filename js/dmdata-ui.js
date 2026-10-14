import { createDmdataFeed, dmdataAllowed, validDmdataKey } from './dmdata.js';

export function mountDmdata({ onData, onStatus, environment = window, createFeed = createDmdataFeed }) {
  const { document, location } = environment;
  if (!dmdataAllowed(location)) return null;
  const section = document.createElement('section');
  section.className = 'card dmdata-panel'; section.id = 'dmdataPersonal';
  section.innerHTML = `<details><summary>DMDATA（自分のAPIキー）</summary>
    <form id="dmdataForm" class="dmdata-form" autocomplete="off">
      <label for="dmdataKey">APIキー</label>
      <input id="dmdataKey" type="password" autocomplete="off" spellcheck="false" maxlength="512" required aria-describedby="dmdataPrivacy">
      <label for="dmdataClass">配信区分</label>
      <select id="dmdataClass"><option value="eew.forecast">緊急地震速報（予報）</option><option value="eew.warning">緊急地震速報（警報）</option><option value="both">緊急地震速報（予報＋警報）</option></select>
      <div class="dmdata-actions"><button type="submit" id="dmdataConnect">接続</button><button type="button" id="dmdataDisconnect" disabled>切断</button></div>
    </form>
    <p id="dmdataPrivacy" class="muted">ご自身の契約・APIキーのみ使用できます。このページではキーを保存しません。</p>
    <nav class="dmdata-help" aria-label="DMDATAの設定ガイド">
      <a href="https://github.com/nekokun148/quakewatch-v15/blob/main/docs/dmdata-setup.md" target="_blank" rel="noopener noreferrer">APIキーの設定方法</a>
      <a href="https://manager.dmdata.jp/" target="_blank" rel="noopener noreferrer">DMDATA管理画面</a>
      <a href="https://dmdata.jp/docs/reference/api/v2/socket.start/" target="_blank" rel="noopener noreferrer">公式API資料</a>
    </nav>
    <p id="dmdataStatus" class="muted" role="status" aria-live="polite">DMDATA / 未接続</p>
  </details>`;
  document.getElementById('eewCard').after(section);
  const form = section.querySelector('form'), input = section.querySelector('input'), select = section.querySelector('select');
  const connect = section.querySelector('#dmdataConnect'), disconnect = section.querySelector('#dmdataDisconnect');
  const display = section.querySelector('#dmdataStatus');
  let submitted = false;
  function controls(active) {
    connect.disabled = active; select.disabled = active; input.disabled = active;
    disconnect.disabled = !active;
  }
  const feed = createFeed({ environment, onData, onStatus(info) {
    display.textContent = info.text; section.dataset.phase = info.phase;
    if (info.phase === 'off' || info.enabled === false) { submitted = false; controls(false); }
    onStatus(info);
  } });
  form.addEventListener('submit', event => {
    event.preventDefault(); let key = input.value; input.value = '';
    if (submitted) { key = ''; return; }
    if (!validDmdataKey(key)) { key = ''; display.textContent = 'DMDATA / APIキーの入力内容を確認してください'; return; }
    submitted = true; controls(true);
    try { feed.start(key, select.value); }
    catch { submitted = false; controls(false); display.textContent = 'DMDATA / 入力内容・接続先を確認してください'; }
    finally { key = ''; }
  });
  disconnect.addEventListener('click', () => {
    input.value = ''; feed.stop(); submitted = false; controls(false);
  });
  environment.addEventListener('pagehide', () => { input.value = ''; feed.stop(); submitted = false; controls(false); });
  return feed;
}
