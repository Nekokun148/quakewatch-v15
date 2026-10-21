import { decodeDmdata, dmdataReport } from '../js/dmdata.js';

export const SHARED_CLASSES = Object.freeze(['eew.warning', 'telegram.earthquake']);
export const SHARED_TYPES = Object.freeze(['VXSE43', 'VXSE52', 'VXSE53']);
const scales = { '1': 10, '2': 20, '3': 30, '4': 40, '5-': 45, '5+': 50, '6-': 55, '6+': 60, '7': 70 };
const text = (value, limit = 160) => typeof value === 'string' && value.length > 0 && value.length <= limit ? value : null;
const numeric = value => typeof value === 'string' && /^[+-]?\d+(?:\.\d+)?$/.test(value) && Number.isFinite(Number(value)) ? Number(value) : null;
const timestamp = value => typeof value === 'string' && /(?:Z|[+-]\d{2}:\d{2})$/.test(value) ? Date.parse(value) : NaN;

// Gate both independent identifiers before decoding; never forward an upstream envelope.
export async function sharedTelegram(message, now = Date.now()) {
  const type = message?.head?.type;
  if (!SHARED_TYPES.includes(type) || message.classification !== (type === 'VXSE43' ? 'eew.warning' : 'telegram.earthquake')
    || message.head.test !== false || message.xmlReport?.control?.status !== '通常') return null;
  const data = await decodeDmdata(message, SHARED_TYPES);
  const issued = timestamp(data.reportDateTime);
  if (data.status !== '通常' || !Number.isFinite(issued) || now - issued > 120000 || issued - now > 10000
    || !text(data.eventId, 64) || !['発表', '訂正', '遅延', '取消'].includes(data.infoType)) return null;
  if (type === 'VXSE43') {
    const parsed = dmdataReport(data, now, { warningOnly: true });
    if (!parsed.report.cancelled && !parsed.report.isWarning) return null;
    const report = parsed.report;
    if (report.areas.length > 200 || report.areas.some(area => !text(area.name)) ||
      (!report.cancelled && !text(report.earthquake.hypocenter.name))) return null;
    return { type: 'report', version: 1, kind: 'warning', report };
  }
  if (data._schema?.type !== 'earthquake-information' || data._schema.version !== '1.1.0') return null;
  const issue = { time: data.reportDateTime, eventId: data.eventId, source: 'DMDATA', type: type === 'VXSE53' ? 'DetailScale' : 'Destination' };
  if (data.infoType === '取消') return { type: 'report', version: 1, kind: 'earthquake', report: {
    code: 551, source: 'DMDATA', time: data.reportDateTime, cancelled: true, issue
  } };
  const e = data.body?.earthquake, h = e?.hypocenter;
  if (!h || !text(h.name) || !Number.isFinite(timestamp(e.originTime))) return null;
  const lat = numeric(h.coordinate?.latitude?.value), lng = numeric(h.coordinate?.longitude?.value);
  const coordinates = h.coordinate?.geodeticSystem !== '日本測地系' && lat !== null && lng !== null
    && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && (lat !== 0 || lng !== 0);
  const depth = h.depth?.unit === 'km' && !h.depth.condition ? numeric(h.depth.value) : null;
  const magnitude = numeric(e.magnitude?.value);
  const prefectures = data.body.intensity?.prefectures ?? [];
  if (!Array.isArray(prefectures) || prefectures.length > 60) return null;
  const points = prefectures.filter(pref => text(pref.name) && scales[pref.maxInt]).map(pref => ({
    pref: pref.name, addr: pref.name, scale: scales[pref.maxInt], isArea: true
  }));
  return { type: 'report', version: 1, kind: 'earthquake', report: {
    id: `dmdata-${data.eventId}-${type}-${issued}`, code: 551, source: 'DMDATA', time: data.reportDateTime, issue,
    earthquake: { time: e.originTime, maxScale: scales[data.body.intensity?.maxInt] ?? -1,
      hypocenter: { name: h.name, magnitude: magnitude !== null && magnitude >= 0 ? magnitude : null,
        depth: depth !== null && depth >= 0 ? depth : null, ...(coordinates ? { latitude: lat, longitude: lng } : {}) } },
    points, observationSource: '気象庁 発表震度（DMDATA経由・都道府県）'
  } };
}
