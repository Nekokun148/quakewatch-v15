import { parseReportTime, quakeReportTime } from './observations.js';

export function createEpicenterFocus({ getMap = () => null, getLocalMap = () => null,
  project = () => null, viewBox = { width: 1000, height: 1000 }, now = () => Date.now() } = {}) {
  const positions = new Map();
  let latestIssued = -Infinity, latestOrigin = 0, activeKeys = new Set();

  return function focus(report, position, { silent = false, manual = false } = {}) {
    if (!report || typeof report !== 'object') return false;
    if (!position || typeof position.lat !== 'number' || typeof position.lng !== 'number'
        || !Number.isFinite(position.lat) || !Number.isFinite(position.lng)
        || Math.abs(position.lat) > 90 || Math.abs(position.lng) > 180
        || (position.lat === 0 && position.lng === 0)) return false;
    const quake = report?.earthquake || {};
    if (report?.cancelled || report?.isCancel || quake.assumed || quake.levelMethod) return false;
    const issued = quakeReportTime(report);
    const origin = parseReportTime(quake.originTime || quake.time || report?.issue?.originTime);
    const keys = [report?.issue?.eventId ? `event/${report.source}/${report.issue.eventId}` : null,
      origin ? `origin/${origin}` : null].filter(Boolean);
    if (!keys.length) keys.push(`report/${report?.id || issued}`);
    const currentEvent = keys.some(key => activeKeys.has(key));
    if (!manual) {
      const age = now() - issued;
      if (silent || report?.test || report?.isTraining || !issued || age < -10000 || age > 120000
          || issued < latestIssued || (origin && latestOrigin && origin < latestOrigin && !currentEvent)) return false;
      const old = keys.map(key => positions.get(key)).find(Boolean);
      if (old && old.lat === position.lat && old.lng === position.lng) {
        latestIssued = Math.max(latestIssued, issued);
        for (const key of keys) { positions.set(key, old); activeKeys.add(key); }
        return false;
      }
    }

    const map = getMap();
    if (map && typeof map.setView === 'function') {
      const zoom = map.getZoom?.();
      map.stop?.();
      // The initial Japan-only bounds must not clamp a real offshore epicenter.
      map.setMaxBounds?.(null);
      map.setView([position.lat, position.lng], Number.isFinite(zoom) ? Math.max(6, Math.min(8, zoom)) : 6,
        { animate: false });
    } else {
      const local = getLocalMap(), point = project(position);
      if (!local?.svg || !point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return false;
      const width = viewBox.width * .55, height = viewBox.height * .55;
      local.svg.setAttribute('viewBox', `${point.x - width / 2} ${point.y - height / 2} ${width} ${height}`);
    }
    if (!manual) {
      latestIssued = Math.max(latestIssued, issued);
      latestOrigin = Math.max(latestOrigin, origin);
      activeKeys = new Set(currentEvent ? [...activeKeys, ...keys] : keys);
      for (const key of keys) positions.set(key, { ...position });
      while (positions.size > 100) positions.delete(positions.keys().next().value);
    }
    return true;
  };
}
