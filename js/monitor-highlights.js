const HOLD_MS = 5000;
const RING_COLOR = '#b6ff66';
const validStation = station => station?.type === 'land' && typeof station.code === 'string'
  && [station.lat, station.lng].every(Number.isFinite) && Math.abs(station.lat) <= 90 && Math.abs(station.lng) <= 180;

// Labels are anchored to actual stations, never an inferred epicenter or averaged coordinate.
export function layoutMonitorHighlights(stations, { x: width, y: height }, project) {
  const left = 54, right = 72, top = 14, bottom = 50;
  const boxWidth = Math.min(228, width - left - right), boxHeight = 88, gap = 8;
  if (boxWidth < 150 || height < top + boxHeight + bottom) return [];
  const groups = new Map();
  for (const station of stations) {
    if (!validStation(station)) continue;
    const point = project([station.lat, station.lng]);
    if (!point || ![point.x, point.y].every(Number.isFinite)
      || point.x < 0 || point.x > width || point.y < 0 || point.y > height) continue;
    const region = station.pref && station.pref !== '-' ? station.pref : station.name || station.code;
    if (!groups.has(region)) groups.set(region, []);
    groups.get(region).push({ station, point });
  }
  const placed = [];
  for (const [region, members] of [...groups].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))) {
    const { station, point } = members.reduce((best, item) => Math.abs(item.point.x - width / 2) + Math.abs(item.point.y - height / 2)
      < Math.abs(best.point.x - width / 2) + Math.abs(best.point.y - height / 2) ? item : best);
    const x = Math.max(left, Math.min(width - right - boxWidth,
      point.x + 14 + boxWidth <= width - right ? point.x + 14 : point.x - boxWidth - 14));
    const candidates = [point.y - boxHeight - gap, point.y + 12];
    for (const box of placed) candidates.push(box.y + box.height + gap, box.y - boxHeight - gap);
    for (let y = top; y <= height - bottom - boxHeight; y += boxHeight + gap) candidates.push(y);
    candidates.push(height - bottom - boxHeight);
    for (const candidate of candidates) {
      const y = Math.max(top, Math.min(height - bottom - boxHeight, candidate));
      const box = { x, y, width: boxWidth, height: boxHeight };
      if (placed.some(old => box.x < old.x + old.width + gap && box.x + box.width + gap > old.x
        && box.y < old.y + old.height + gap && box.y + box.height + gap > old.y)) continue;
      placed.push({ ...box, station, region, count: members.length });
      break;
    }
    if (placed.length === 3) break;
  }
  return placed;
}

export function createMonitorHighlights({ map, L, document = globalThis.document,
  environment = globalThis, now = () => Date.now() }) {
  const pane = 'monitorHighlightPane';
  if (!map.getPane(pane)) map.createPane(pane).style.zIndex = '430';
  const rings = L.layerGroup().addTo(map);
  const labels = document.createElement('div');
  labels.className = 'monitor-highlights';
  labels.setAttribute('aria-label', '強震モニタ画像色の変化・地震未確定');
  map.getContainer().appendChild(labels);
  const active = new Map();
  let timer = null, lastTime = -Infinity, destroyed = false;
  const cancelTimer = () => { environment.clearTimeout(timer); timer = null; };
  function drawLabels() {
    const boxes = layoutMonitorHighlights([...active.values()].map(item => item.station),
      map.getSize(), point => map.latLngToContainerPoint(point));
    labels.replaceChildren(...boxes.map(box => {
      const label = document.createElement('div');
      label.className = 'monitor-highlight-label';
      label.style.left = box.x + 'px';
      label.style.top = box.y + 'px';
      label.style.width = box.width + 'px';
      const name = document.createElement('strong');
      name.textContent = box.station.pref && box.station.pref !== '-'
        ? box.station.pref + ' ' + (box.station.name || box.station.code) : box.station.name || box.station.code;
      const count = document.createElement('span');
      count.textContent = box.count + '地点の画像色変化';
      const notice = document.createElement('small');
      notice.textContent = '地震・震源未確定';
      label.append(name, count, notice);
      return label;
    }));
    labels.dataset.activeCount = String(active.size);
  }
  function render() {
    cancelTimer();
    const time = now();
    for (const [code, item] of active) if (item.expires <= time) active.delete(code);
    rings.clearLayers();
    for (const { station } of active.values()) L.circleMarker([station.lat, station.lng], {
      pane, radius: 6, color: RING_COLOR, weight: 1.5, opacity: .95,
      fill: false, interactive: false
    }).addTo(rings);
    drawLabels();
    if (active.size) timer = environment.setTimeout(render,
      Math.max(1, Math.min(...[...active.values()].map(item => item.expires)) - time));
  }
  function clear() {
    cancelTimer(); active.clear(); lastTime = -Infinity; rings.clearLayers();
    labels.replaceChildren(); labels.dataset.activeCount = '0';
  }
  function update(result, stations) {
    if (destroyed) return;
    const time = Date.parse(result.observedAt), age = now() - time;
    if (document.hidden || !Number.isFinite(time) || age > HOLD_MS || age < -1000
      || !['changed', 'unchanged'].includes(result.phase)) { clear(); return; }
    if (time <= lastTime) return;
    lastTime = time;
    if (result.phase === 'changed') for (const code of new Set(result.codes)) {
      const station = stations.get(code)?.station;
      if (validStation(station) && station.code === code) {
        const { lat, lng, name, pref, type } = station;
        active.set(code, { station: { code, lat, lng, name, pref, type }, expires: time + HOLD_MS });
      }
    }
    render();
  }
  const onVisibility = () => { if (document.hidden) clear(); };
  map.on('move zoom resize', drawLabels);
  document.addEventListener('visibilitychange', onVisibility);
  environment.addEventListener?.('pagehide', clear);
  return { update, clear, destroy() {
    if (destroyed) return;
    destroyed = true; clear(); rings.remove(); labels.remove();
    map.off('move zoom resize', drawLabels);
    document.removeEventListener('visibilitychange', onVisibility);
    environment.removeEventListener?.('pagehide', clear);
  } };
}

