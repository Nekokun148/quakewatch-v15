import { createSpeechController, quakeAnnouncement, eewAnnouncement } from './speech.js';
import { createVoicevoxEnvironment, createVoicevoxPreference } from './voicevox.js';
import { SENSING_AREAS } from './sensing-areas.js';
import { SEAFLOOR_STATIONS } from './seafloor-stations.js';
import { createLocationController } from './location.js';
import { measuredPoints, selectObservationReport, acceptsQuakeReport, sameQuakeReport, displayObservationTime, quakeReportTime, intensityColor, createObservationFeed } from './observations.js';
import { renderObservationRegions } from './observation-ui.js';
import { createStrongMotionController } from './strong-motion.js';
import { createAlarmController, createAlarmAnnouncer } from './alarm.js';
import { createEEWTracker } from './eew.js';
import { matchMonitorPoints, frameColors, UNRECEIVED_COLOR } from './monitor-map.js';
import { createMonitorChangeTracker } from './monitor-changes.js';
import { createYditsFeed, createYditsEEWAdapter } from './ydits.js';
import { createWolfxFeed } from './wolfx.js';
import { animateWaves } from './waves.js';

const state = {
  ws: null,
  speech: false,
  lastAnnouncement: '',
  sensingReports: new Map(),
  sensingAnnouncements: new Map(),
  locationEnabled: false,
  locationLayer: null,
  observationLayer: null,
  latestQuake: null,
  latestObservation: null,
  bannerTime: 0,
  seen: new Set(),
  leafletMap: null,
  stationLayer: null,
  markerLayer: null,
  waveLayer: null,
  localMap: null,
  waveTimers: [],
  reconnectTimer: null
};

const $ = id => document.getElementById(id);
const stationCircles = new Map();
let monitorPoints = [];
let monitorObservation;
let monitorMappingReady;
function updateCurrentTime() {
  const now = new Date();
  $('currentTime').dateTime = now.toISOString();
  $('currentTime').textContent = `${displayObservationTime(now.toISOString())} JST`;
}
updateCurrentTime();
setInterval(updateCurrentTime, 1000);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) updateCurrentTime();
});
const topbar = document.querySelector('.topbar');
function updateTopbarHeight() {
  document.documentElement.style.setProperty('--topbar-height', `${topbar.offsetHeight}px`);
}
updateTopbarHeight();
if ('ResizeObserver' in window) new ResizeObserver(updateTopbarHeight).observe(topbar);
const scaleText = s => ({ 10:'1', 20:'2', 30:'3', 40:'4', 45:'5弱', 50:'5強', 55:'6弱', 60:'6強', 70:'7' })[Number(s)] ?? '不明';
const receiveEEW = createEEWTracker();
const alarm = createAlarmController({ soundUrl: null, onStatus(info) {
  $('alarmToggle').checked = info.enabled;
  $('alarmToggle').disabled = !info.supported;
  $('alarmTest').disabled = !info.supported;
  $('alarmStatus').textContent = info.error || ({ off: '警報音 OFF', armed: '警報音 ON', playing: '警報音を再生中', unsupported: '警報音 未対応' })[info.phase];
  if (!info.error && info.supported) {
    $('alarmStatus').textContent += info.assetWarning ? ` / ${info.assetWarning}`
      : info.source === 'file' ? ` / 指定MP3・${info.duration.toFixed(1)}秒`
      : info.assetPhase === 'none' ? ''
      : info.assetPhase === 'loading' ? ' / MP3読込中（既存音で待機）' : ' / 指定MP3はON時に準備';
  }
  document.body.dataset.qwAlarm = info.phase;
  document.body.dataset.qwAlarmPlayed = String(info.played);
  document.body.dataset.qwAlarmSource = info.source;
  document.body.dataset.qwAlarmAsset = info.assetPhase;
} });
function setEventColor(element, scale) {
  element.style.setProperty('--intensity-color', intensityColor(scale) || '#aebbd0');
  element.dataset.colored = String(Boolean(intensityColor(scale)));
}
const MAP_CENTER = { lat: 37.25, lng: 138.2 };
const MAP_BOUNDS = { north: 46.8, south: 24.0, west: 122.0, east: 149.6 };
const LOCAL_VIEWBOX = { width: 1000, height: 1000 };
const PX_PER_KM = LOCAL_VIEWBOX.width / ((MAP_BOUNDS.east - MAP_BOUNDS.west) * 88);

function showToast(text) {
  const t = $('toast');
  t.textContent = text;
  t.classList.add('show');
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => t.classList.remove('show'), 5000);
}

function updateDiagnostics() {
  document.body.dataset.qwMap = state.leafletMap ? 'leaflet' : state.localMap ? 'local' : 'none';
  document.body.dataset.qwStations = String(state.stationLayer?.getLayers?.().length ?? state.localMap?.stationLayer?.childElementCount ?? 0);
  document.body.dataset.qwMarkers = String(state.markerLayer?.getLayers?.().length ?? state.localMap?.markerLayer?.childElementCount ?? 0);
  document.body.dataset.qwWaves = String(state.waveLayer?.getLayers?.().length ?? state.localMap?.waveLayer?.childElementCount ?? 0);
  document.body.dataset.qwStatus = $('status')?.textContent || '';
  document.body.dataset.qwHeadline = $('headline')?.textContent || '';
  document.body.dataset.qwMeasured = String(state.observationLayer?.getLayers?.().length ?? state.localMap?.observationLayer?.childElementCount ?? 0);
}

let speechVoiceOptionsKey = '';

function updateSpeechUi(info) {
  state.speech = info.enabled;
  $('speechToggle').textContent = info.supported ? (info.enabled ? '🔊 読み上げ ON' : '🔇 読み上げ OFF') : '音声未対応';
  $('speechToggle').setAttribute('aria-pressed', String(info.enabled));
  $('speechToggle').disabled = !info.supported;
  $('speechTest').disabled = !info.supported;
  $('browserSpeech').disabled = !window.speechSynthesis || typeof window.SpeechSynthesisUtterance !== 'function';
  $('readLatest').disabled = !info.supported || !state.lastAnnouncement;
  const select = $('speechVoice');
  const optionsKey = JSON.stringify([info.voices, info.preferredVoice]);
  if (speechVoiceOptionsKey !== optionsKey) {
    const options = [new Option('自動選択（日本語）', '')];
    for (const voice of info.voices) {
      options.push(new Option(`${voice.name}（${voice.localService ? '端末' : 'オンライン'}）`, voice.id));
    }
    if (info.preferredVoice && !info.voices.some(v => v.id === info.preferredVoice)) {
      const unavailable = new Option('保存した声（利用不可・自動選択中）', info.preferredVoice);
      unavailable.disabled = true;
      options.push(unavailable);
    }
    select.replaceChildren(...options);
    select.value = info.preferredVoice;
    speechVoiceOptionsKey = optionsKey;
  }
  select.disabled = !info.supported || !info.voices.length;
  select.title = info.voice ? `現在の声：${info.voice}` : '日本語音声を準備中';
  $('speechStatus').textContent = info.error || ({
    off: '停止中',
    ready: '地震情報の読み上げ待機中',
    starting: '音声を開始中',
    speaking: '読み上げ中',
    unsupported: 'このブラウザは音声を利用できません'
  })[info.phase] + (info.voice ? ` / ${info.voice}` : '');
  $('speechStatus').dataset.phase = info.phase;
  document.body.dataset.qwSpeech = info.phase;
  document.body.dataset.qwSpeechVoice = info.voice;
  document.body.dataset.qwSpeechError = info.error;
  document.body.dataset.qwSpeechText = info.lastText;
  document.body.dataset.qwSpeechStarted = String(info.started);
  document.body.dataset.qwSpeechCompleted = String(info.completed);
}

const voicevox = createVoicevoxEnvironment({ environment: window, onStatus: info => {
  $('voicevoxConnect').disabled = info.phase === 'connecting';
  $('voicevoxStatus').textContent = info.message;
  $('voicevoxStatus').dataset.phase = info.phase;
} });
const speech = createSpeechController({ environment: voicevox.environment, onStatus: updateSpeechUi });
const voicevoxPreference = createVoicevoxPreference({ voicevox, speech, environment: window,
  isEnabled: () => state.speech,
  onPreference(preferred) {
    $('voicevoxPrefer').checked = preferred;
    document.body.dataset.qwVoicevoxPreferred = String(preferred);
  }
});
const alarmAnnouncer = createAlarmAnnouncer({ alarm, speech });

function rememberAnnouncement(text) {
  state.lastAnnouncement = text;
  $('readLatest').disabled = $('speechToggle').disabled || !text;
}

function asNumber(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function toLatLng(lat, lng) {
  const y = asNumber(lat);
  const x = asNumber(lng);
  return y !== null && x !== null && y >= -90 && y <= 90 && x >= -180 && x <= 180 ? { lat: y, lng: x } : null;
}

function leafletLatLng(pos) {
  return [pos.lat, pos.lng];
}

function projectLatLng(pos) {
  if (!pos) return null;
  return {
    x: ((pos.lng - MAP_BOUNDS.west) / (MAP_BOUNDS.east - MAP_BOUNDS.west)) * LOCAL_VIEWBOX.width,
    y: ((MAP_BOUNDS.north - pos.lat) / (MAP_BOUNDS.north - MAP_BOUNDS.south)) * LOCAL_VIEWBOX.height
  };
}

function localPath(points) {
  return points.map(([lat, lng], i) => {
    const p = projectLatLng({ lat, lng });
    return `${i ? 'L' : 'M'}${p.x.toFixed(1)} ${p.y.toFixed(1)}`;
  }).join(' ') + ' Z';
}

function parseEventTime(value) {
  if (!value) return Date.now();
  if (typeof value === 'number') return value;
  const raw = String(value).trim();
  const direct = Date.parse(raw);
  if (Number.isFinite(direct)) return direct;
  const normalized = raw.replace(/\//g, '-').replace(' ', 'T');
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function makeSvgElement(name, attrs = {}) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', name);
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value);
  return el;
}

function findLatLng(value) {
  if (!value) return null;
  if (Array.isArray(value) && value.length >= 2) {
    return toLatLng(value[0], value[1]) || toLatLng(value[1], value[0]);
  }
  if (typeof value !== 'object') return null;
  const direct = toLatLng(value.latitude ?? value.lat, value.longitude ?? value.lng ?? value.lon);
  if (direct) return direct;
  for (const key of ['coordinate', 'coordinates', 'point', 'location', 'hypocenter', 'earthquake']) {
    const nested = findLatLng(value[key]);
    if (nested) return nested;
  }
  return null;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
}

function addMarker(pos, title, kind = 'quake') {
  if (kind === 'quake' || kind === 'eew') {
    state.markerLayer?.clearLayers();
    if (state.localMap) state.localMap.markerLayer.innerHTML = '';
  }
  if (!pos) return;
  if (state.leafletMap && window.L) {
    addLeafletMarker(pos, title, kind);
    return;
  }
  if (state.localMap) addLocalMarker(pos, title, kind);
}

function addLeafletMarker(pos, title, kind = 'quake') {
  const L = window.L;
  let layer;
  if (kind === 'quake') {
    const icon = L.divIcon({
      className: '',
      html: '<span class="quake-cross-icon" aria-hidden="true"></span>',
      iconSize: [20, 20],
      iconAnchor: [10, 10]
    });
    layer = L.marker(leafletLatLng(pos), { icon, title, zIndexOffset: 1000 });
  } else {
    layer = L.circleMarker(leafletLatLng(pos), {
      radius: kind === 'eew' ? 9 : 8,
      color: '#fff',
      weight: 1.6,
      fillColor: kind === 'eew' ? '#ffcc00' : '#4bc0ff',
      fillOpacity: 1
    }).bindTooltip(escapeHtml(title));
  }
  layer.addTo(state.markerLayer);
  updateDiagnostics();
  if (kind === 'sensing') setTimeout(() => state.markerLayer?.removeLayer(layer), 20 * 60 * 1000);
}

function addLocalMarker(pos, title, kind = 'quake') {
  const p = projectLatLng(pos);
  if (!state.localMap || !p) return;
  const marker = makeSvgElement('g', { 'aria-label': title });
  if (kind === 'quake') {
    marker.appendChild(makeSvgElement('path', {
      d: `M${p.x - 6} ${p.y - 6} L${p.x + 6} ${p.y + 6} M${p.x + 6} ${p.y - 6} L${p.x - 6} ${p.y + 6}`,
      stroke: '#fff',
      'stroke-width': '5',
      'stroke-linecap': 'round'
    }));
    marker.appendChild(makeSvgElement('path', {
      d: `M${p.x - 6} ${p.y - 6} L${p.x + 6} ${p.y + 6} M${p.x + 6} ${p.y - 6} L${p.x - 6} ${p.y + 6}`,
      stroke: '#ff2f21',
      'stroke-width': '3',
      'stroke-linecap': 'round'
    }));
  } else {
    marker.appendChild(makeSvgElement('circle', {
      cx: p.x,
      cy: p.y,
      r: kind === 'eew' ? 9 : 8,
      class: kind === 'eew' ? 'eew-marker' : 'sensing-marker'
    }));
  }
  state.localMap.markerLayer.appendChild(marker);
  updateDiagnostics();
  if (kind === 'sensing') setTimeout(() => marker.remove(), 20 * 60 * 1000);
}

function buildObservationStations() {
  return (window.OBSERVATION_STATIONS || []).map(station => ({
    ...station,
    title: `${station.network} ${station.pref === '-' ? '' : station.pref} ${station.name} (${station.code}) / 観測値未受信`
  }));
}

function buildOffshoreStations() {
  return SEAFLOOR_STATIONS.map(s => ({ ...s, title: `${s.network} ${s.code} / 水深${s.depth}m / 観測値未受信` }));
}

function renderLeafletObservationNetwork() {
  if (!state.stationLayer || !window.L) return;
  const L = window.L;
  const stations = [...buildObservationStations(), ...buildOffshoreStations()];
  const circles = [];
  for (const s of stations) {
    const layer = L.circleMarker([s.lat, s.lng], {
      radius: s.type === 'sea' ? 1.9 : 1.8,
      color: s.type === 'sea' ? '#168dff' : UNRECEIVED_COLOR,
      weight: s.type === 'sea' ? .8 : 0,
      fillColor: UNRECEIVED_COLOR,
      fillOpacity: s.type === 'sea' ? 0 : .55,
      interactive: true
    }).bindTooltip(() => stationTooltip(s)).addTo(state.stationLayer);
    stationCircles.set(s.code, { layer, station: s, color: null });
    circles.push({ layer, type: s.type });
  }
  const updateRadii = () => {
    const scale = Math.max(.7, Math.min(1.6, 2 ** ((state.leafletMap.getZoom() - 5) / 3)));
    for (const { layer, type } of circles) layer.setRadius((type === 'sea' ? 1.9 : 1.8) * scale);
  };
  state.leafletMap.on('zoomend', updateRadii);
  updateRadii();
  updateDiagnostics();
}

function stationTooltip(station) {
  const circle = stationCircles.get(station.code);
  const title = `${station.network} ${station.code} / ${station.name || station.pref || ''}`;
  if (!circle?.color || !monitorObservation) return escapeHtml(`${title} / 観測値未受信`);
  const metric = monitorObservation.metric === 'intensity' ? 'リアルタイム震度' : '最大加速度';
  const stale = Date.now() - Date.parse(monitorObservation.observedAt) > 5000 ? ' / 遅延' : '';
  return escapeHtml(`${title} / ${metric}：画像の色・数値未取得 / ${displayObservationTime(monitorObservation.observedAt)} JST${stale}`);
}

function resetMonitorColors() {
  for (const circle of stationCircles.values()) {
    if (circle.station.type === 'sea' || !circle.color) continue;
    circle.color = null;
    circle.layer.setStyle({ fillColor: UNRECEIVED_COLOR, fillOpacity: .55 });
  }
  document.body.dataset.qwLiveStations = '0';
}

async function loadMonitorMapping() {
  const response = await fetch('data/monitor-points.json');
  if (!response.ok) throw new Error('Station mapping unavailable');
  const catalog = await response.json();
  monitorPoints = matchMonitorPoints(catalog, buildObservationStations());
  if (!monitorPoints.length) throw new Error('No verified station mappings');
  document.body.dataset.qwMappedStations = String(monitorPoints.length);
  return monitorPoints;
}

function renderLocalObservationNetwork() {
  if (!state.localMap) return;
  const stations = [...buildObservationStations(), ...buildOffshoreStations()];
  for (const s of stations) {
    const p = projectLatLng({ lat: s.lat, lng: s.lng });
    if (!p) continue;
    state.localMap.stationLayer.appendChild(makeSvgElement('circle', {
      cx: p.x,
      cy: p.y,
      r: s.type === 'sea' ? 4.2 : 3.2,
      class: s.type === 'sea' ? 'sea-station-svg' : 'land-station-svg'
    }));
  }
  updateDiagnostics();
}

function renderLocalMap() {
  const mapEl = $('map');
  mapEl.innerHTML = '<div class="local-map" aria-label="日本全国の簡易地震観測地図"></div>';
  const holder = mapEl.firstElementChild;
  const svg = makeSvgElement('svg', {
    viewBox: `0 0 ${LOCAL_VIEWBOX.width} ${LOCAL_VIEWBOX.height}`,
    role: 'img',
    'aria-label': '地図ライブラリが読み込めない場合の簡易ローカル地図'
  });
  holder.appendChild(svg);
  svg.appendChild(makeSvgElement('rect', { x: 0, y: 0, width: LOCAL_VIEWBOX.width, height: LOCAL_VIEWBOX.height, class: 'sea' }));

  for (let lng = 125; lng <= 145; lng += 5) {
    const a = projectLatLng({ lat: MAP_BOUNDS.north, lng });
    const b = projectLatLng({ lat: MAP_BOUNDS.south, lng });
    svg.appendChild(makeSvgElement('line', { x1: a.x, y1: a.y, x2: b.x, y2: b.y, class: 'grid' }));
  }
  for (let lat = 25; lat <= 45; lat += 5) {
    const a = projectLatLng({ lat, lng: MAP_BOUNDS.west });
    const b = projectLatLng({ lat, lng: MAP_BOUNDS.east });
    svg.appendChild(makeSvgElement('line', { x1: a.x, y1: a.y, x2: b.x, y2: b.y, class: 'grid' }));
  }

  const landShapes = [
    [[45.4, 141.0], [44.7, 145.3], [43.4, 146.2], [41.5, 143.3], [41.8, 140.4], [43.1, 140.0]],
    [[41.5, 140.8], [40.2, 142.0], [38.0, 141.6], [36.2, 140.9], [35.3, 139.9], [34.6, 137.5], [35.5, 136.1], [35.6, 134.0], [34.6, 132.4], [34.2, 130.9], [33.8, 130.3], [34.4, 135.2], [35.5, 139.0], [37.1, 139.2], [39.7, 140.2]],
    [[34.4, 134.0], [33.9, 134.8], [33.3, 133.7], [33.4, 132.0], [34.2, 132.6]],
    [[33.9, 130.2], [33.1, 131.7], [31.4, 131.0], [31.0, 130.0], [32.1, 129.5], [33.3, 129.7]],
    [[26.8, 127.6], [26.3, 128.3], [25.8, 127.8], [26.1, 127.1]]
  ];
  for (const shape of landShapes) svg.appendChild(makeSvgElement('path', { d: localPath(shape), class: 'land' }));

  svg.appendChild(makeSvgElement('text', { x: 28, y: 42, class: 'label' })).textContent = '地震監視Web';
  svg.appendChild(makeSvgElement('text', { x: 28, y: 70, class: 'note' })).textContent = 'Leafletを読み込めないため簡易地図で表示中';

  const waveLayer = makeSvgElement('g');
  const stationLayer = makeSvgElement('g');
  const markerLayer = makeSvgElement('g');
  const observationLayer = makeSvgElement('g');
  svg.appendChild(waveLayer);
  svg.appendChild(stationLayer);
  svg.appendChild(observationLayer);
  svg.appendChild(markerLayer);
  state.localMap = { svg, waveLayer, stationLayer, observationLayer, markerLayer };
  renderLocalObservationNetwork();
  updateDiagnostics();
}

function clearWaveTimers() {
  for (const stop of state.waveTimers) stop();
  state.waveTimers = [];
}

function startWaveAnimation(pos, originTimeRaw) {
  if (!pos) return;
  clearWaveTimers();
  if (state.leafletMap && window.L) {
    startLeafletWaveAnimation(pos, originTimeRaw);
    return;
  }
  if (state.localMap) startLocalWaveAnimation(pos, originTimeRaw);
}

function startLeafletWaveAnimation(pos, originTimeRaw) {
  const L = window.L;
  state.waveLayer.clearLayers();
  const pRing = L.circle(leafletLatLng(pos), {
    radius: 0,
    color: '#48f08c',
    weight: 2.4,
    opacity: .9,
    fillOpacity: 0,
    interactive: false
  }).addTo(state.waveLayer);
  const sRing = L.circle(leafletLatLng(pos), {
    radius: 0,
    color: '#ff9d2e',
    weight: 2.4,
    opacity: .86,
    fillOpacity: 0,
    interactive: false
  }).addTo(state.waveLayer);
  const origin = parseEventTime(originTimeRaw);
  const stop = animateWaves({ origin, update: ({ p, s }) => {
    pRing.setRadius(p);
    sRing.setRadius(s);
  }, finish: () => {
    state.waveLayer?.removeLayer(pRing);
    state.waveLayer?.removeLayer(sRing);
    updateDiagnostics();
  } });
  state.waveTimers.push(stop);
  updateDiagnostics();
}

function startLocalWaveAnimation(pos, originTimeRaw) {
  const p = projectLatLng(pos);
  if (!state.localMap || !p) return;
  state.localMap.waveLayer.innerHTML = '';
  const pRing = makeSvgElement('circle', { cx: p.x, cy: p.y, r: 0, class: 'p-ring' });
  const sRing = makeSvgElement('circle', { cx: p.x, cy: p.y, r: 0, class: 's-ring' });
  state.localMap.waveLayer.appendChild(sRing);
  state.localMap.waveLayer.appendChild(pRing);
  const origin = parseEventTime(originTimeRaw);
  const stop = animateWaves({ origin, update: ({ p, s }) => {
    pRing.setAttribute('r', String(p / 1000 * PX_PER_KM));
    sRing.setAttribute('r', String(s / 1000 * PX_PER_KM));
  }, finish: () => {
    pRing.remove();
    sRing.remove();
    updateDiagnostics();
  } });
  state.waveTimers.push(stop);
  updateDiagnostics();
}

function renderObservations(data) {
  const measured = measuredPoints(data.points);
  state.observationLayer?.clearLayers();
  if (state.localMap) state.localMap.observationLayer.innerHTML = '';
  for (const point of measured) {
    const title = `${point.pref} ${point.addr} / 観測震度${scaleText(point.scale)} / ${displayObservationTime(data.earthquake?.time)}`;
    if (state.observationLayer && window.L) {
      window.L.circleMarker([point.lat, point.lng], {
        pane: 'observationPane', radius: 6, color: '#fff', weight: 1.4,
        fillColor: point.color, fillOpacity: 1
      }).bindTooltip(escapeHtml(title)).addTo(state.observationLayer);
    } else if (state.localMap) {
      const p = projectLatLng(point);
      const circle = makeSvgElement('circle', { cx: p.x, cy: p.y, r: 6, fill: point.color, stroke: '#fff', 'stroke-width': 1.4 });
      circle.appendChild(makeSvgElement('title')).textContent = title;
      state.localMap.observationLayer.appendChild(circle);
    }
  }
  renderObservationRegions(data, { document, scaleText, measuredCount: measured.length });
  updateDiagnostics();
}

const quakeHistory = [];
function rememberQuake(d) {
  const index = quakeHistory.findIndex(previous => previous.earthquake?.time && previous.earthquake.time === d.earthquake?.time && previous.earthquake.hypocenter?.name === d.earthquake.hypocenter?.name);
  if (index >= 0) quakeHistory.splice(index, 1);
  quakeHistory.unshift(d);
  quakeHistory.length = Math.min(quakeHistory.length, 50);
  const list = $('quakeHistory');
  if (!list) return;
  list.replaceChildren();
  for (const report of quakeHistory) {
    const q = report.earthquake || {}, h = q.hypocenter || {};
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = `${displayObservationTime(q.time)} / ${h.name || '震源不明'} / 震度${scaleText(q.maxScale)}`;
    button.addEventListener('click', () => {
      clearWaveTimers();
      state.waveLayer?.clearLayers();
      if (state.localMap) state.localMap.waveLayer.innerHTML = '';
      addMarker(findLatLng(h), `履歴：${h.name || '震源不明'}`, 'quake');
      $('quakeHistorySelection').textContent = `履歴表示：${displayObservationTime(q.time)} / ${h.name || '震源不明'} / M${h.magnitude ?? '-'} / 深さ${h.depth ?? '-'}km`;
    });
    list.appendChild(button);
  }
  $('quakeHistorySelection').textContent = '最新の震源を表示';
}

function handleQuake(d, options = {}) {
  const q = d.earthquake || {};
  const h = q.hypocenter || {};
  const eventKey = d.id || `${q.time}-${h.latitude}-${h.longitude}`;
  if (state.seen.has(eventKey)) return;
  state.seen.add(eventKey);
  if (state.seen.size > 300) state.seen.delete(state.seen.values().next().value);
  if (!acceptsQuakeReport(state.latestQuake, d)) return;
  const sameReport = sameQuakeReport(state.latestQuake, d);
  state.latestQuake = d;
  rememberQuake(d);
  const max = q.maxScale;
  const title = `${h.name || '地震'} / 最大震度 ${scaleText(max)}`;
  if (quakeReportTime(d) >= state.bannerTime) {
    state.bannerTime = quakeReportTime(d);
    $('headline').textContent = title;
    $('reportStage').textContent = '観測震度';
    $('headlineSub').textContent = `${displayObservationTime(q.time || d.time)}　M${h.magnitude ?? '-'}　深さ${h.depth ?? '-'}km`;
    setEventColor(document.querySelector('.hero-card'), max);
  }
  setEventColor($('quakeCard'), max);
  $('quakeDetails').innerHTML = `震源：<span class="event-location">${escapeHtml(h.name || '不明')}</span><br>発生：${escapeHtml(displayObservationTime(q.time))}<br>規模：M${escapeHtml(h.magnitude ?? '-')} / 深さ ${escapeHtml(h.depth ?? '-')} km<br>最大震度：<span class="forecast-scale">${scaleText(max)}</span>`;
  state.latestObservation = selectObservationReport(state.latestObservation, d);
  renderObservations(state.latestObservation);
  const pos = findLatLng(h);
  addMarker(pos, title, 'quake');
  if ((!options.silent || options.animateWaves === true) && !sameReport) startWaveAnimation(pos, q.time || d.time);
  const text = quakeAnnouncement(d, scaleText);
  rememberAnnouncement(text);
  if (!options.silent && !sameReport) {
    showToast(text);
    speech.say(text);
  }
}

function handleEEW(d, options = {}) {
  const received = receiveEEW(d, { silent: options.silent });
  if (!received.accepted) return;
  const info = received.info;
  if (options.silent && info.time < state.bannerTime) return;
  const e = d.earthquake || {};
  const h = e.hypocenter || {};
  $('eewCard').hidden = false;
  setEventColor($('eewCard'), info.cancelled ? -1 : info.maxScale);
  const maximum = `${info.maxScale === 0 ? '0' : scaleText(info.maxScale)}${info.maxAbove ? '以上' : ''}`;
  $('eewDetails').innerHTML = `${d.source === 'YDITS' ? 'YDITS / ' : ''}${escapeHtml(info.stage)}<br>震源：<span class="event-location">${escapeHtml(h.name || '情報なし')}</span><br>発表：${escapeHtml(displayObservationTime(d.issue?.time || d.time))}<br>予想最大震度：<span class="forecast-scale">${info.cancelled ? '取消' : maximum}</span>${!info.cancelled && info.plum ? '<br>PLUM法による予想を含む' : ''}${e.assumed ? '<br>仮定震源要素・規模と深さは未確定' : ''}${d.unmatchedCancel ? '<br>取消の対象地震は未確認' : ''}`;
  $('eewRegions').innerHTML = '';
  if (d.source === 'Wolfx') $('eewDetails').innerHTML = 'Wolfx / ' + $('eewDetails').innerHTML;
  if (d.source === 'DMDATA') $('eewDetails').innerHTML = 'DMDATA / ' + $('eewDetails').innerHTML;
  if (!info.cancelled) for (const area of info.areas) {
    const row = document.createElement('div');
    row.className = 'region forecast-region';
    setEventColor(row, area.scale);
    row.innerHTML = `<span>${escapeHtml(area.pref || '')} ${escapeHtml(area.name || '')}${area.plum ? '<br>PLUM法' : ''}</span><span class="forecast-scale">予想 ${scaleText(area.scale)}${area.above ? '以上' : ''}</span>`;
    $('eewRegions').appendChild(row);
  }
  if (info.time >= state.bannerTime && !d.unmatchedCancel && !info.training) {
    state.bannerTime = info.time;
    $('headline').textContent = info.cancelled ? '緊急地震速報 取消' : `${h.name || '緊急地震速報'} / 予想最大震度 ${maximum}`;
    $('headlineSub').textContent = `${displayObservationTime(d.issue?.time || d.time)}${info.cancelled ? '' : info.areas.length ? ` / ${info.areas.length}地域${info.plum ? ' / PLUM法' : ''}` : ' / 地域別予測未受信'}`;
    $('reportStage').textContent = info.stage;
    setEventColor(document.querySelector('.hero-card'), info.cancelled ? -1 : info.maxScale);
  }
  if (info.cancelled) {
    if (!options.silent && !info.training && !d.unmatchedCancel) {
      alarmAnnouncer.cancel();
      clearWaveTimers();
      state.waveLayer?.clearLayers();
      if (state.localMap) state.localMap.waveLayer.innerHTML = '';
    }
    $('eewWaveStatus').textContent = 'P/S表示：取消';
  } else {
    const pos = findLatLng(h);
    addMarker(pos, `緊急地震速報 ${info.stage}`, 'eew');
    if (['YDITS', 'Wolfx', 'DMDATA'].includes(d.source) && (!pos || (d.source === 'DMDATA' && (!e.originTime || info.plum || e.assumed))) && !options.silent && !info.training) {
      clearWaveTimers();
      state.waveLayer?.clearLayers();
      if (state.localMap) state.localMap.waveLayer.innerHTML = '';
    }
    $('eewWaveStatus').textContent = info.plum ? 'P/S表示：PLUM・到達時刻未確定'
      : e.assumed ? 'P/S表示：仮定震源要素・未確定'
      : d.source === 'DMDATA' && !e.originTime ? 'P/S表示：発生時刻未受信'
      : !pos ? 'P/S表示：震源座標未受信' : 'P/S表示：受信震源からの簡易到達予測';
    if (!options.silent && !info.training && pos && !info.plum && !e.assumed && (d.source !== 'DMDATA' || e.originTime)) startWaveAnimation(pos, e.originTime || e.time || d.time);
  }
  const text = eewAnnouncement(d);
  rememberAnnouncement(text);
  if (!options.silent && !info.training && !d.unmatchedCancel) {
    showToast(text);
    alarmAnnouncer.announce(text, { sound: received.sound });
  }
}

function handleUserSensing(d, options = {}) {
  const eventKey = d.id ? `sensing-${d.id}` : d.time ? `sensing-${d.time}-${d.area}` : null;
  if (eventKey && state.seen.has(eventKey)) return;
  if (eventKey) {
    state.seen.add(eventKey);
    if (state.seen.size > 300) state.seen.delete(state.seen.values().next().value);
  }
  const area = SENSING_AREAS[Number(d.area)];
  const name = area?.name || d.pref || '地域不明';
  const key = String(d.area ?? name);
  const previous = state.sensingReports.get(key);
  state.sensingReports.set(key, {
    name,
    count: (previous?.count || 0) + 1,
    time: parseEventTime(d.time)
  });
  if (state.sensingReports.size > 30) state.sensingReports.delete(state.sensingReports.keys().next().value);
  const list = $('sensingReports');
  list.innerHTML = '';
  for (const report of [...state.sensingReports.values()].sort((a, b) => b.time - a.time).slice(0, 10)) {
    const row = document.createElement('div');
    row.className = 'region';
    const label = document.createElement('span');
    label.textContent = `${report.name} / ${report.count}件`;
    const detail = document.createElement('span');
    detail.className = 'sensing-detail';
    detail.textContent = new Date(report.time).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Tokyo' });
    row.append(label, detail);
    list.appendChild(row);
  }
  const pos = findLatLng(d) || (area ? toLatLng(area.lat, area.lng) : null);
  addMarker(pos, `揺れの報告：${name}（地域代表位置・震度未確定）`, 'sensing');
  if (!options.silent) {
    const text = `利用者の揺れ報告。${name}で揺れたという報告がありました。震度は未確認です。`;
    showToast(text);
    const now = Date.now();
    const lastSpoken = state.sensingAnnouncements.get(key);
    if (lastSpoken == null || now - lastSpoken >= 60000) {
      if (speech.say(text)) state.sensingAnnouncements.set(key, now);
    }
  }
  document.body.dataset.qwSensingRegions = String(state.sensingReports.size);
}

function onData(d, options = {}) {
  if (!d || typeof d !== 'object') return;
  switch (Number(d.code)) {
    case 551:
      handleQuake(d, options);
      break;
    case 556:
      handleEEW(d, options);
      break;
    case 554:
      if (!options.silent && !state.seen.has(d.id || d.time)) {
        state.seen.add(d.id || d.time);
        showToast('緊急地震速報の発表を検出しました。続報に注意してください。');
        const time = quakeReportTime(d);
        if (time && Math.abs(Date.now() - time) <= 120000) alarmAnnouncer.announce('', { sound: true });
      }
      break;
    case 561:
      handleUserSensing(d, options);
      break;
    case 9611:
      if (d.count > 0) $('sensingStatus').textContent = `感知情報の解析：${d.count}件 / 信頼度 ${Math.round((d.confidence || 0) * 100)}%（震度未確定）`;
      break;
  }
  updateDiagnostics();
}

function fitJapanView() {
  const map = state.leafletMap;
  if (!map || $('map').hidden) return;
  const attributionHeight = document.querySelector('.leaflet-control-attribution')?.offsetHeight || 0;
  document.querySelector('.map-panel').style.setProperty('--attribution-height', `${attributionHeight}px`);
  map.invalidateSize({ pan: false });
  map.fitBounds([[MAP_BOUNDS.south, MAP_BOUNDS.west], [MAP_BOUNDS.north, MAP_BOUNDS.east]], {
    paddingTopLeft: [30, 24],
    paddingBottomRight: [75, attributionHeight + 24],
    animate: false
  });
}

function loadMap() {
  if (!window.L) {
    renderLocalMap();
    showToast('Leafletを読み込めないため、簡易ローカル地図で表示します。');
    return;
  }

  const L = window.L;
  state.localMap = null;
  state.leafletMap = L.map('map', {
    preferCanvas: true,
    minZoom: 2,
    maxZoom: 18,
    zoomSnap: .25,
    zoomControl: true
  }).setView([MAP_CENTER.lat, MAP_CENTER.lng], 5);

  state.leafletMap.createPane('landPane').style.zIndex = 200;
  fetch('data/basemap.geojson').then(response => {
    if (!response.ok) throw new Error('Basemap unavailable');
    return response.json();
  }).then(data => {
    L.geoJSON(data, { pane: 'landPane', interactive: false,
      style: { color: '#606168', weight: .65, fillColor: '#3d3e43', fillOpacity: 1 }
    }).addTo(state.leafletMap);
    document.body.dataset.qwBasemap = 'ready';
  }).catch(() => {
    document.body.dataset.qwBasemap = 'error';
    showToast('背景地図を読み込めません。観測点の位置のみ表示中です。');
  });
  state.leafletMap.attributionControl.addAttribution('<a href="https://www.naturalearthdata.com/" target="_blank" rel="noopener">Natural Earth</a>');

  state.leafletMap.attributionControl.addAttribution('<a href="https://www.kyoshin.bosai.go.jp/ja/stationlist/" target="_blank" rel="noopener">観測点位置：防災科研</a>');
  state.leafletMap.attributionControl.addAttribution('<a href="https://www.seafloor.bosai.go.jp/st_info/" target="_blank" rel="noopener">海底観測点：防災科研</a>');

  state.leafletMap.setMaxBounds([[MAP_BOUNDS.south - 10, MAP_BOUNDS.west - 10], [MAP_BOUNDS.north + 10, MAP_BOUNDS.east + 10]]);
  state.stationLayer = L.layerGroup().addTo(state.leafletMap);
  state.waveLayer = L.layerGroup().addTo(state.leafletMap);
  state.markerLayer = L.layerGroup().addTo(state.leafletMap);
  state.locationLayer = L.layerGroup().addTo(state.leafletMap);
  state.leafletMap.createPane('observationPane').style.zIndex = 450;
  state.observationLayer = L.layerGroup().addTo(state.leafletMap);
  renderLeafletObservationNetwork();
  const cities = [['札幌',43.0618,141.3545],['釧路',42.985,144.382],['青森',40.8246,140.74],['仙台',38.2682,140.8694],['新潟',37.9161,139.0364],['東京',35.6762,139.6503],['名古屋',35.1815,136.9066],['大阪',34.6937,135.5023],['広島',34.3853,132.4553],['高知',33.5597,133.5311],['福岡',33.5904,130.4017],['鹿児島',31.5966,130.5571],['那覇',26.2124,127.6809]];
  state.leafletMap.createPane('cityPane').style.zIndex = 410;
  for (const [name, lat, lng] of cities) L.marker([lat, lng], { pane: 'cityPane', interactive: false,
    icon: L.divIcon({ className: 'city-label', html: escapeHtml(name), iconSize: [48, 16], iconAnchor: [24, 8] })
  }).addTo(state.leafletMap);
  fitJapanView();
  state.leafletMap.on('resize', fitJapanView);
  updateDiagnostics();
}

function runDemoEvent() {
  speech.disable();
  onData({
    code: 551,
    id: `local-demo-${Date.now()}`,
    earthquake: {
      time: new Date(Date.now() - 15000).toISOString(),
      maxScale: 30,
      hypocenter: {
        name: 'テスト震源 東京湾',
        latitude: 35.55,
        longitude: 139.85,
        depth: 30,
        magnitude: 4.2
      }
    },
    points: [
      { pref: '東京都', addr: '千代田区大手町', scale: 30 },
      { pref: '神奈川県', addr: '横浜市中区', scale: 20 }
    ]
  });
  showToast('ローカルテスト用の震源を表示しました。');
  updateDiagnostics();
}

function clearLocation() {
  state.locationLayer?.clearLayers();
  state.localMap?.svg.querySelector('.current-location')?.remove();
}

function renderLocation(pos) {
  clearLocation();
  if (state.locationLayer && window.L) {
    if (pos.accuracy > 0) window.L.circle(leafletLatLng(pos), {
      radius: pos.accuracy, color: '#f4f5ff', weight: 1, fillOpacity: .1, interactive: false
    }).addTo(state.locationLayer);
    window.L.circleMarker(leafletLatLng(pos), {
      radius: 7, color: '#fff', weight: 3, fillColor: '#db3c9d', fillOpacity: 1
    }).bindTooltip('現在地').addTo(state.locationLayer);
  } else if (state.localMap) {
    const p = projectLatLng(pos);
    state.localMap.svg.appendChild(makeSvgElement('circle', {
      cx: p.x, cy: p.y, r: 7, class: 'current-location', fill: '#db3c9d', stroke: '#fff', 'stroke-width': 3
    }));
  }
}

const locationControl = createLocationController({
  environment: window,
  onPosition: renderLocation,
  onClear: clearLocation,
  onStatus(info) {
    state.locationEnabled = info.enabled;
    $('locationToggle').textContent = `現在地 ${info.enabled ? 'ON' : 'OFF'}`;
    $('locationToggle').setAttribute('aria-pressed', String(info.enabled));
    $('locationToggle').disabled = !info.supported;
    $('locationStatus').textContent = info.message;
    document.body.dataset.qwLocation = info.phase;
  }
});

$('locationToggle').addEventListener('click', () => {
  const enable = !state.locationEnabled;
  if (enable) locationControl.start();
  else locationControl.stop();
  try { localStorage.setItem('qwLocationEnabled', String(enable)); } catch {}
});

$('speechToggle').addEventListener('click', () => {
  if (state.speech) { voicevoxPreference.cancelPending(); speech.disable(); }
  else if (speech.enable()) {
    void voicevoxPreference.prepare();
    speech.say('地震情報の読み上げを開始します。', { interrupt: true });
  }
});

$('speechTest').addEventListener('click', () => {
  if (speech.enable()) {
    void voicevoxPreference.prepare();
    speech.say('読み上げのテストです。日本語の音声を確認しています。', { interrupt: true });
  }
});

$('speechVoice').addEventListener('change', event => {
  voicevoxPreference.selectVoice(event.target.value);
});

$('voicevoxConnect').addEventListener('click', () => { void voicevoxPreference.connect(); });
$('browserSpeech').addEventListener('click', () => { voicevoxPreference.setPreferred(false); });
$('voicevoxPrefer').addEventListener('change', event => {
  voicevoxPreference.setPreferred(event.target.checked);
  if (state.speech) void voicevoxPreference.prepare();
});

$('readLatest').addEventListener('click', () => {
  if (state.lastAnnouncement && speech.enable()) {
    void voicevoxPreference.prepare();
    speech.say(state.lastAnnouncement, { interrupt: true });
  }
});

$('reconnect').addEventListener('click', () => { wolfxActive = false; wolfxFeed.stop(); yditsFeed.stop(); void yditsFeed.start(); });
$('alarmToggle').addEventListener('change', async () => {
  if ($('alarmToggle').checked) await alarm.enable();
  else {
    alarmAnnouncer.cancel();
    alarm.disable();
  }
});
$('alarmTest').addEventListener('click', async () => {
  if (await alarm.enable()) alarmAnnouncer.announce('', { sound: true });
});
let monitorFrames = 0;
const monitorChanges = createMonitorChangeTracker();
function renderMonitorChanges(result) {
  const text = result.phase === 'baseline' ? '画像色の変化：比較用の初回画像'
    : result.phase === 'delayed' ? '画像色の変化：配信遅延・比較待機'
    : `画像色の変化：${result.codes.length}地点 / 地震・震源未確定`;
  $('monitorChangeStatus').textContent = text;
  $('monitorChangeStatus').dataset.phase = result.phase;
  document.body.dataset.qwMonitorChanges = String(result.codes.length);
  const rows = result.codes.map(code => {
    const station = stationCircles.get(code)?.station;
    const row = document.createElement('div');
    row.className = 'region';
    row.textContent = station ? `${station.pref === '-' ? '' : station.pref} ${station.name} (${code}) / 画像色の変化` : code;
    return row;
  });
  $('monitorChangedStations').replaceChildren(...rows);
}
const strongMotion = createStrongMotionController({
  apiBase: document.body.dataset.kmoniApiBase || 'api/strong-motion/',
  async onFrame(frame) {
    if (!await monitorMappingReady) throw new Error('Station mapping unavailable');
    const canvas = document.createElement('canvas');
    canvas.width = frame.image.naturalWidth;
    canvas.height = frame.image.naturalHeight;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    context.drawImage(frame.image, 0, 0);
    const colors = frameColors(context.getImageData(0, 0, canvas.width, canvas.height), monitorPoints);
    if (frame.metric !== monitorMetric) return;
    if (!state.leafletMap) throw new Error('Live monitor requires geographic map');
    renderMonitorChanges(monitorChanges.receive({ colors, metric: frame.metric, observedAt: frame.observedAt }));
    monitorObservation = frame;
    let received = 0;
    for (const [code, color] of colors) {
      const circle = stationCircles.get(code);
      if (!circle) continue;
      if (color) received++;
      if (circle.color === color) continue;
      circle.color = color;
      circle.layer.setStyle({ fillColor: color || UNRECEIVED_COLOR, fillOpacity: color ? 1 : .55 });
    }
    const scale = strongMotion.asset(`${frame.metric}-scale`);
    if ($('monitorScale').getAttribute('src') !== scale) $('monitorScale').src = scale;
    $('monitorScale').hidden = false;
    $('monitorCoverage').textContent = `観測画像の色：${received}地点 / 数値未取得`;
    $('monitorTime').textContent = `${displayObservationTime(frame.observedAt)} JST`;
    $('monitorTime').dateTime = frame.observedAt;
    document.body.dataset.qwMonitorTime = frame.observedAt;
    document.body.dataset.qwMonitorFrames = String(++monitorFrames);
    document.body.dataset.qwLiveStations = String(received);
  },
  onStatus(phase, text) {
    if ($('monitorStatus').textContent !== text) $('monitorStatus').textContent = text;
    $('monitorStatus').dataset.phase = phase;
    document.body.dataset.qwMonitor = phase;
    $('monitorDisplay').dataset.phase = phase;
    if (['loading', 'error', 'unavailable', 'delayed'].includes(phase)) {
      monitorChanges.reset();
      $('monitorChangeStatus').textContent = '画像色の変化：取得・比較待機 / 地震・震源未確定';
      $('monitorChangedStations').replaceChildren();
      document.body.dataset.qwMonitorChanges = '0';
    }
  }
});
let monitorMetric;
const monitorTabs = [['viewIntensity', 'intensity'], ['viewAcceleration', 'acceleration']];
function selectMonitorMetric(mode) {
  if (monitorMetric === mode) return;
  monitorMetric = mode;
  for (const [id, value] of monitorTabs) {
    const selected = mode === value;
    $(id).setAttribute('aria-selected', String(selected));
    $(id).tabIndex = selected ? 0 : -1;
    if (selected) $('monitorDisplay').setAttribute('aria-labelledby', id);
  }
  document.body.dataset.qwMonitorMetric = mode;
  resetMonitorColors();
  monitorChanges.reset();
  monitorObservation = null;
  $('monitorScale').hidden = true;
  $('monitorCoverage').textContent = '観測画像の色：未受信';
  $('monitorTime').textContent = '観測画像未受信';
  $('monitorTime').removeAttribute('datetime');
  delete document.body.dataset.qwMonitorTime;
  $('monitorTitle').textContent = mode === 'intensity' ? 'リアルタイム震度（地表・目安）' : '最大加速度（地表・Gal）';
  strongMotion.start(mode);
}
for (const [id, metric] of monitorTabs) {
  $(id).addEventListener('click', () => selectMonitorMetric(metric));
  $(id).addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const index = event.key === 'Home' ? 0 : event.key === 'End' ? 1 : metric === 'intensity' ? 1 : 0;
    selectMonitorMetric(monitorTabs[index][1]);
    $(monitorTabs[index][0]).focus();
  });
}
window.__quakeWatchV15 = { onData, state };
loadMap();
monitorMappingReady = loadMonitorMapping().catch(() => {
  document.body.dataset.qwMapping = 'error';
  return null;
});
document.body.dataset.qwMapView = 'unified';
selectMonitorMetric('intensity');
let autoLocation = true;
try { autoLocation = localStorage.getItem('qwLocationEnabled') !== 'false'; } catch {}
if (autoLocation) locationControl.start();
const adaptYdits = createYditsEEWAdapter();
let wolfxActive = false;
let wolfxStatus = 'Wolfx / 接続準備';
const wolfxFeed = createWolfxFeed({
  onData(report, options) { if (wolfxActive) onData(report, options); },
  onStatus(info) {
    wolfxStatus = info.text;
    $('wolfxFeedStatus').textContent = info.text;
    $('wolfxFeedStatus').dataset.phase = info.phase;
    document.body.dataset.qwWolfx = info.phase;
    if (wolfxActive) { $('status').textContent = info.text; updateDiagnostics(); }
  }
});
const yditsFeed = createYditsFeed({
  onData(snapshot) {
    document.body.dataset.qwYditsActive = String(snapshot.active);
    const report = adaptYdits(snapshot);
    if (report) onData(report, { silent: snapshot.stale || snapshot.training });
  },
  onStatus(info) {
    if (info.phase === 'live') { wolfxActive = false; wolfxFeed.stop(); }
    if (info.phase === 'error' && info.server === 3 && !wolfxActive) { wolfxActive = true; wolfxFeed.start(); }
    $('status').textContent = wolfxActive ? wolfxStatus : info.text;
    $('yditsFeedStatus').textContent = info.text;
    $('yditsFeedStatus').dataset.phase = info.phase;
    document.body.dataset.qwYdits = info.phase;
    document.body.dataset.qwYditsServer = String(info.server);
    updateDiagnostics();
  }
});
void yditsFeed.start();
const observationFeed = createObservationFeed({
  onData: (data, options) => onData(data, options),
  onStatus(phase, text) {
    $('observationFeedStatus').textContent = text;
    $('observationFeedStatus').dataset.phase = phase;
    document.body.dataset.qwObservationFeed = phase;
  }
});
observationFeed.poll();
setInterval(() => observationFeed.poll(), 60000);
if (new URLSearchParams(location.search).has('demo')) setTimeout(runDemoEvent, 1000);
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js')
    .then(registration => {
      document.body.dataset.qwServiceWorker = 'registered';
      document.body.dataset.qwServiceWorkerScope = registration.scope;
      navigator.serviceWorker.ready.then(ready => {
        if (ready.scope === registration.scope) document.body.dataset.qwServiceWorkerReady = 'true';
      });
    })
    .catch(err => {
      document.body.dataset.qwServiceWorker = 'error';
      console.warn(err);
    });
} else {
  document.body.dataset.qwServiceWorker = 'unsupported';
}
