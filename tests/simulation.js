import { waveDistances, WAVE_LIFETIME } from '../js/waves.js';
import { intensityColor } from '../js/observations.js';

export const SIMULATED_EPICENTER = { lat: 41, lng: 143 };
export const SIMULATED_REGIONS = [
  { name: '青森県（模擬）', lat: 40.8, lng: 141.5, peak: 55 },
  { name: '北海道南部（模擬）', lat: 41.6, lng: 141.9, peak: 40 },
  { name: '岩手県（模擬）', lat: 40, lng: 141.4, peak: 50 },
  { name: '宮城県（模擬）', lat: 38.3, lng: 141, peak: 30 }
];
const scales = [0, 10, 20, 30, 40, 45, 50, 55, 60, 70];
const labels = ['0', '1', '2', '3', '4', '5弱', '5強', '6弱', '6強', '7'];
const scaleLabel = scale => labels[scales.indexOf(scale)] || '未設定';

export function simulationAt({ distance, peak, origin, now }) {
  if (!Number.isFinite(distance) || distance < 0 || !Number.isFinite(origin) || !Number.isFinite(now) || !scales.includes(peak) || peak === 0) return null;
  const { age, p, s } = waveDistances(origin, now);
  const pIn = Math.max(0, distance / 6 - age);
  const sIn = Math.max(0, distance / 3.5 - age);
  if (age >= WAVE_LIFETIME) return { phase: 'ended', scale: 0, pIn, sIn };
  if (p < distance) return { phase: 'waiting', scale: 0, pIn, sIn };
  if (s < distance) return { phase: 'p', scale: 10, pIn, sIn };
  // This fixed test sequence is not a physical intensity estimate.
  const seconds = (age - distance / 3.5) / 1000;
  const peakIndex = scales.indexOf(peak);
  const step = seconds < 18
    ? Math.min(peakIndex, 1 + Math.floor(seconds))
    : Math.max(0, peakIndex - 1 - Math.floor((seconds - 18) / 3));
  return { phase: step ? 's' : 'ended', scale: scales[step], pIn, sIn };
}

export function startRegionSimulation({ document, environment, map, L, origin }) {
  const panel = document.getElementById('simulation');
  const table = document.getElementById('simulationRows');
  panel.hidden = false;
  table.replaceChildren();
  if (!L || !map) {
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.colSpan = 4;
    cell.textContent = '模擬地域の到達表示は地図の準備待ちです';
    row.appendChild(cell);
    table.appendChild(row);
    return () => {};
  }
  const layer = L.layerGroup().addTo(map);
  const rows = SIMULATED_REGIONS.map(region => {
    const row = document.createElement('tr');
    const name = document.createElement('td');
    const phase = document.createElement('small');
    name.append(region.name, phase);
    const p = document.createElement('td');
    const s = document.createElement('td');
    const scale = document.createElement('td');
    row.append(name, p, s, scale);
    table.appendChild(row);
    const marker = L.circleMarker([region.lat, region.lng], {
      radius: 9, weight: 2, color: '#fff', dashArray: '3 3', fillOpacity: .85, fillColor: '#777'
    }).addTo(layer).bindTooltip(region.name);
    return { region, phase, p, s, scale, marker,
      distance: L.latLng(SIMULATED_EPICENTER).distanceTo(L.latLng(region)), last: '' };
  });
  const arrival = remaining => remaining > 0 ? `約${(remaining / 1000).toFixed(1)}秒` : '到達';
  const phases = { waiting: '到達前', p: 'P波到達', s: 'S波到達', ended: '模擬の揺れ終了' };
  const update = () => {
    const now = environment.Date.now();
    for (const row of rows) {
      const value = simulationAt({ distance: row.distance, peak: row.region.peak, origin, now });
      row.phase.textContent = phases[value.phase];
      row.p.textContent = arrival(value.pIn);
      row.s.textContent = arrival(value.sIn);
      const key = `${value.phase}/${value.scale}`;
      if (key === row.last) continue;
      row.last = key;
      const text = value.phase === 'waiting' ? '到達前' : `模擬震度${scaleLabel(value.scale)}`;
      const color = intensityColor(value.scale) || '#aebbd0';
      row.scale.textContent = text;
      row.scale.style.color = color;
      row.marker.setStyle({ fillColor: color });
      row.marker.setTooltipContent(`${row.region.name} / ${text} / ${phases[value.phase]} / テスト専用の仮の位置`);
    }
  };
  update();
  const timer = environment.setInterval(update, 200);
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    environment.clearInterval(timer);
    map.removeLayer(layer);
  };
}
