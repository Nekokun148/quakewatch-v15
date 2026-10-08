import { intensityColor, parseReportTime } from './observations.js';

export function eewInfo(data) {
  const cancelled = data.cancelled === true || data.isCancel === true;
  const final = data.isFinal === true || data.issue?.isFinal === true;
  const forecast = data.isWarning === false || data.issue?.type === 'Forecast';
  const training = data.test === true || data.isTraining === true;
  const category = forecast ? '予報' : '警報';
  const areas = (Array.isArray(data.areas) ? data.areas : []).map(area => {
    const lower = Number(area.scaleFrom);
    const upper = Number(area.scaleTo);
    const scale = upper === 99 ? lower : intensityColor(upper) ? upper : lower;
    return { ...area, scale: intensityColor(scale) ? scale : -1, above: upper === 99,
      plum: ['09', '19'].includes(String(area.kindCode).padStart(2, '0')) };
  }).sort((a, b) => b.scale - a.scale);
  const maxScale = Math.max(-1, ...areas.map(area => area.scale), intensityColor(data.earthquake?.maxScale) ? Number(data.earthquake.maxScale) : -1);
  const maxAbove = maxScale > 0 && areas.some(area => area.scale === maxScale && area.above);
  const serial = data.issue?.serial;
  const stage = cancelled ? '取消' : `${category}${final ? '・最終報' : serial ? `・第${serial}報` : ''}`;
  return { cancelled, final, forecast, training, areas, maxScale, maxAbove, color: intensityColor(maxScale) || '#aebbd0',
    stage: `${training ? '訓練 / ' : ''}${stage}`, plum: areas.some(area => area.plum),
    eventId: data.issue?.eventId || data.earthquake?.originTime || data.id || data.time || 'unknown',
    time: parseReportTime(data.issue?.time || data.time) };
}

export function createEEWTracker() {
  const events = new Map();
  return function receive(data, { silent = false, now = Date.now() } = {}) {
    const info = eewInfo(data);
    const old = events.get(info.eventId);
    const serial = Number(data.issue?.serial) || 0;
    const key = `${serial}/${info.time}/${info.cancelled}/${info.final}/${info.forecast}`;
    if (old && (old.key === key || serial < old.serial || (info.time && info.time < old.time))) return { accepted: false, info };
    events.set(info.eventId, { key, serial, time: info.time, scale: info.maxScale, warned: !info.forecast });
    if (events.size > 50) events.delete(events.keys().next().value);
    const fresh = info.time > 0 && now - info.time >= -10000 && now - info.time <= 120000;
    const escalation = !old || info.maxScale > old.scale || (!info.forecast && !old.warned);
    return { accepted: true, info, sound: !silent && fresh && !info.training && !info.cancelled && escalation };
  };
}
