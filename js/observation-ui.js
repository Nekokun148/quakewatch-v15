import { displayObservationTime, intensityColor, observedRegions } from './observations.js';

export function renderObservationRegions(data, { document, scaleText, measuredCount }) {
  const points = Array.isArray(data.points) ? data.points : [];
  const list = document.getElementById('regions');
  const summary = document.getElementById('regionSummary');
  list.replaceChildren();
  summary.replaceChildren();
  const unique = new Map();
  for (const point of points) {
    const key = `${Boolean(point.isArea)}/${point.pref || ''}/${point.code || point.addr || ''}`;
    const old = unique.get(key);
    if (!old || Number(point.scale) > Number(old.scale)) unique.set(key, point);
  }
  const rows = [...unique.values()].sort((a, b) => Number(b.scale) - Number(a.scale));
  for (const point of rows) {
    const row = document.createElement('div');
    row.className = 'region observed-region';
    row.style.setProperty('--intensity-color', intensityColor(point.scale) || '#aebbd0');
    const name = document.createElement('span');
    name.textContent = `${point.pref || ''} ${point.addr || '名称不明'}${point.isArea ? '（地域）' : ''}`.trim();
    const scale = document.createElement('span');
    scale.className = 'scale';
    scale.textContent = intensityColor(point.scale) ? `震度${scaleText(point.scale)}` : '震度未確認';
    row.append(name, scale);
    list.appendChild(row);
  }
  if (!rows.length) {
    const pending = document.createElement('div');
    pending.className = 'muted';
    pending.textContent = 'この地震の観測震度は発表待ち';
    list.appendChild(pending);
  }
  const regions = observedRegions(points);
  for (const region of regions) {
    const row = document.createElement('div');
    row.className = 'region-summary';
    const name = document.createElement('span');
    name.textContent = `${region.name} / ${region.count}地点${region.areaCount ? `・${region.areaCount}地域` : ''}`;
    const scale = document.createElement('strong');
    scale.style.setProperty('--intensity-color', intensityColor(region.scale));
    scale.textContent = `最大震度${scaleText(region.scale)}`;
    row.append(name, scale);
    summary.appendChild(row);
  }
  const q = data.earthquake || {};
  const time = q.time || data.issue?.time || data.time;
  const count = regions.reduce((total, region) => total + region.count, 0);
  document.getElementById('observationMeta').textContent =
    `${q.hypocenter?.name || '震源情報未発表'} / ${q.time ? '発生' : '発表'} ${displayObservationTime(time)}`
    + ` / ${regions.length}都道府県 / 地図${measuredCount}地点${count > measuredCount ? `・位置未確認${count - measuredCount}地点` : ''}`;
  document.body.dataset.qwObservationTime = time || '';
  document.body.dataset.qwObservationRegions = String(regions.length);
}
