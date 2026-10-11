import { intensityColor, parseReportTime } from './observations.js';

export function eewInfo(data) {
  const cancelled = data.cancelled === true || data.isCancel === true;
  const final = data.isFinal === true || data.issue?.isFinal === true;
  const last = data.isLast === true;
  const forecast = data.isWarning === false || data.issue?.type === 'Forecast';
  const training = data.test === true || data.isTraining === true;
  const category = forecast ? '予報' : '警報';
  const areas = (Array.isArray(data.areas) ? data.areas : []).map(area => {
    const lower = Number(area.scaleFrom);
    const upper = Number(area.scaleTo);
    const scale = upper === 99 ? lower : intensityColor(upper) ? upper : lower;
    return { ...area, scale: intensityColor(scale) ? scale : -1, above: upper === 99,
      plum: area.isPlum === true || ['09', '19'].includes(String(area.kindCode).padStart(2, '0')) };
  }).sort((a, b) => b.scale - a.scale);
  const maxScale = Math.max(-1, ...areas.map(area => area.scale),
    ['YDITS', 'Wolfx', 'DMDATA'].includes(data.source) && data.earthquake?.maxScale === 0 ? 0 : intensityColor(data.earthquake?.maxScale) ? Number(data.earthquake.maxScale) : -1);
  const maxAbove = maxScale > 0 && (data.earthquake?.maxAbove === true || areas.some(area => area.scale === maxScale && area.above));
  const serial = data.issue?.serial;
  const stage = cancelled ? '取消' : `${category}${final ? '・最終報' : last ? '・更新終了' : serial ? `・第${serial}報` : ''}`;
  return { cancelled, final, last, forecast, training, areas, maxScale, maxAbove, color: intensityColor(maxScale) || '#aebbd0',
    stage: `${training ? '訓練 / ' : ''}${stage}`, plum: areas.some(area => area.plum),
    eventId: data.issue?.eventId || data.earthquake?.originTime || data.id || data.time || 'unknown',
    time: parseReportTime(data.issue?.time || data.time) };
}

export function createEEWTracker() {
  const events = new Map();
  const aliases = new Map();
  return function receive(data, { silent = false, now = Date.now() } = {}) {
    const info = eewInfo(data);
    const alias = `${data.source}/${info.eventId}/${info.training ? 'training' : 'normal'}`;
    const network = ['YDITS', 'Wolfx', 'DMDATA'].includes(data.source);
    const origin = parseReportTime(data.earthquake?.originTime || data.issue?.originTime);
    const eventKey = network && origin ? `origin/${origin}/${info.training ? 'training' : 'normal'}` : aliases.get(alias) || `${info.eventId}/${info.training ? 'training' : 'normal'}`;
    if (network) { aliases.set(alias, eventKey); if (aliases.size > 100) aliases.delete(aliases.keys().next().value); }
    const old = events.get(eventKey);
    const serial = Number(data.issue?.serial) || 0;
    const key = `${serial}/${info.time}/${info.cancelled}/${info.final}/${info.forecast}/${info.last}/${info.maxScale}`;
    if (old && (old.key === key || (old.source === data.source && serial < old.serial) || (info.time && info.time < old.time))) return { accepted: false, info };
    events.set(eventKey, { key, serial, source: data.source, time: info.time, scale: info.maxScale, warned: !info.forecast });
    if (events.size > 50) events.delete(events.keys().next().value);
    const fresh = info.time > 0 && now - info.time >= -10000 && now - info.time <= 120000;
    const escalation = !old || info.maxScale > old.scale || (!info.forecast && !old.warned);
    return { accepted: true, info, sound: !silent && fresh && !info.training && !info.cancelled && escalation };
  };
}
