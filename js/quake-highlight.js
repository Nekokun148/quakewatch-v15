import { measuredPoints, parseReportTime, displayObservationTime, intensityColor } from './observations.js';

const value = number => typeof number === 'number' && Number.isFinite(number) && number >= 0 ? number : null;
const position = h => typeof h?.latitude === 'number' && typeof h.longitude === 'number'
  && Number.isFinite(h.latitude) && Number.isFinite(h.longitude) && Math.abs(h.latitude) <= 90
  && Math.abs(h.longitude) <= 180 && (h.latitude !== 0 || h.longitude !== 0)
  ? [h.latitude, h.longitude] : null;

export function quakeHighlightReport(data, { silent = false, now = Date.now() } = {}) {
  if (Number(data?.code) !== 551 || silent || data.test || data.isTraining || data.unmatchedCancel
    || data.issue?.source !== '気象庁' || data.issue?.type !== 'DetailScale'
    || data.observationSource !== '気象庁 観測震度' || (data.source && data.source !== 'JMA')) return null;
  const quake = data.earthquake || {}, h = quake.hypocenter || {};
  const issued = parseReportTime(data.issue?.time || data.time || quake.time);
  if (!issued || now - issued > 120000 || issued - now > 10000) return null;
  const cancelled = data.cancelled === true || data.isCancel === true;
  if (quake.assumed || (!cancelled && !(Array.isArray(data.points) && data.points.some(point =>
    point && intensityColor(point.scale) && (point.addr || point.code))))) return null;
  return { issued, origin: parseReportTime(quake.originTime || quake.time || data.issue?.originTime),
    id: data.issue?.eventId || data.id || null, source: data.source || 'JMA', cancelled,
    name: typeof h.name === 'string' && h.name ? h.name : '震源名未受信',
    position: quake.assumed ? null : position(h),
    depth: quake.assumed ? null : value(h.depth),
    magnitude: quake.assumed ? null : value(quake.magnitude ?? h.magnitude),
    stage: '地震情報・発表値',
    points: measuredPoints(data.points) };
}

export function quakeHighlightBox(report, { x: width, y: height }, project) {
  const left = 54, right = 72, top = 14, bottom = 50, boxHeight = 128;
  const boxWidth = Math.min(240, width - left - right);
  if (boxWidth < 150 || height < top + boxHeight + bottom) return null;
  const point = report.position ? project(report.position) : null;
  const visible = point && Number.isFinite(point.x) && Number.isFinite(point.y)
    && point.x >= 0 && point.x <= width && point.y >= 0 && point.y <= height;
  return { x: visible ? Math.max(left, Math.min(width - right - boxWidth,
    point.x + 18 + boxWidth <= width - right ? point.x + 18 : point.x - boxWidth - 18)) : width - right - boxWidth,
  y: visible ? Math.max(top, Math.min(height - bottom - boxHeight, point.y - boxHeight - 12)) : top,
  width: boxWidth, visible };
}

export function createQuakeHighlight({ map, L, document = globalThis.document,
  environment = globalThis, now = () => Date.now() }) {
  const pane = 'quakeHighlightPane';
  if (!map.getPane(pane)) map.createPane(pane).style.zIndex = '440';
  const rings = L.layerGroup().addTo(map), label = document.createElement('div');
  label.className = 'quake-highlight-label';
  label.hidden = true;
  map.getContainer().appendChild(label);
  let current = null, destroyed = false;
  function draw() {
    if (!current) return;
    const box = quakeHighlightBox(current, map.getSize(), point => map.latLngToContainerPoint(point));
    label.hidden = !box;
    if (!box) return;
    label.style.left = box.x + 'px'; label.style.top = box.y + 'px'; label.style.width = box.width + 'px';
    const name = document.createElement('strong'); name.textContent = current.name;
    const depth = document.createElement('span'); depth.textContent = current.depth === null ? '深さ未受信' : '深さ ' + current.depth + ' km';
    const magnitude = document.createElement('span'); magnitude.textContent = current.magnitude === null ? 'M 未受信' : 'M' + current.magnitude;
    const stage = document.createElement('small'); stage.textContent = current.stage + ' / ' + displayObservationTime(new Date(current.issued).toISOString());
    const location = document.createElement('small');
    location.textContent = !current.position ? '震源座標未受信' : !box.visible ? '震源は画面外' : '';
    label.replaceChildren(name, depth, magnitude, stage, location);
  }
  function clear() { current = null; rings.clearLayers(); label.replaceChildren(); label.hidden = true; }
  function update(data, options) {
    if (destroyed) return false;
    const report = quakeHighlightReport(data, { ...options, now: now() });
    if (!report || (current && report.issued < current.issued)) return false;
    if (report.cancelled) {
      // An unrelated or historical cancellation must not erase a different earthquake.
      if (current && ((report.origin && report.origin === current.origin)
        || (report.id && report.id === current.id && report.source === current.source))) clear();
      return false;
    }
    current = report; rings.clearLayers();
    if (report.position) L.circleMarker(report.position, {
      pane, radius: 12, color: '#b6ff66', weight: 1.5, fill: false, interactive: false
    }).addTo(rings);
    for (const point of report.points) L.circleMarker([point.lat, point.lng], {
      pane, radius: 6, color: '#b6ff66', weight: 1.3, fill: false, interactive: false
    }).addTo(rings);
    draw(); return true;
  }
  map.on('move zoom resize', draw);
  environment.addEventListener?.('pagehide', clear);
  return { update, clear, destroy() {
    if (destroyed) return;
    destroyed = true; clear(); rings.remove(); label.remove();
    map.off('move zoom resize', draw); environment.removeEventListener?.('pagehide', clear);
  } };
}

