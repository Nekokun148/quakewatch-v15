export const JMA_QUAKE_BASE = 'https://www.jma.go.jp/bosai/quake/data/';
export const INTENSITY_COLORS = {
  10: '#7dd3fc', 20: '#4ade80', 30: '#facc15', 40: '#fb923c',
  45: '#f87171', 50: '#ef4444', 55: '#e879f9', 60: '#c026d3', 70: '#ffffff'
};

const JMA_SCALES = { '1': 10, '2': 20, '3': 30, '4': 40, '5-': 45, '5+': 50, '6-': 55, '6+': 60, '7': 70 };
export const intensityColor = scale => INTENSITY_COLORS[Number(scale)] || null;

export function parseReportTime(value) {
  if (!value) return 0;
  let text = String(value).trim();
  if (/^\d{4}\/\d{2}\/\d{2} /.test(text)) text = text.replaceAll('/', '-').replace(' ', 'T') + '+09:00';
  const time = Date.parse(text);
  return Number.isFinite(time) ? time : 0;
}

export function pointPosition(point) {
  const lat = point?.latitude ?? point?.lat;
  const lng = point?.longitude ?? point?.lng;
  if (lat == null || lng == null || lat === '' || lng === '') return null;
  const y = Number(lat);
  const x = Number(lng);
  return Number.isFinite(y) && Number.isFinite(x) && y >= -90 && y <= 90 && x >= -180 && x <= 180 ? { lat: y, lng: x } : null;
}

export function measuredPoints(points = []) {
  const unique = new Map();
  for (const point of points) {
    const position = pointPosition(point);
    if (point.isArea || !position || !intensityColor(point.scale)) continue;
    const key = point.code || `${point.pref || ''}/${point.addr || ''}/${position.lat}/${position.lng}`;
    const old = unique.get(key);
    if (!old || Number(point.scale) > Number(old.scale)) unique.set(key, { ...point, ...position, color: intensityColor(point.scale) });
  }
  return [...unique.values()].sort((a, b) => Number(b.scale) - Number(a.scale));
}

export function observedRegions(points = []) {
  const regions = new Map();
  const unique = new Map();
  for (const point of points) {
    if (!intensityColor(point.scale)) continue;
    const pref = point.pref || '地域不明';
    const key = `${pref}/${point.code || point.addr}`;
    if (!unique.has(key) || Number(point.scale) > Number(unique.get(key).scale)) unique.set(key, point);
  }
  for (const point of unique.values()) {
    const pref = point.pref || '地域不明';
    const region = regions.get(pref) || { name: pref, count: 0, areaCount: 0, scale: 0 };
    if (point.isArea) region.areaCount++;
    else region.count++;
    region.scale = Math.max(region.scale, Number(point.scale));
    regions.set(pref, region);
  }
  return [...regions.values()].sort((a, b) => b.scale - a.scale);
}

export function selectObservationReport(current, incoming) {
  if (!current || incoming.points?.length) return incoming;
  const a = current.earthquake || {};
  const b = incoming.earthquake || {};
  const time = parseReportTime(a.time);
  const sameEvent = time && time === parseReportTime(b.time)
    && (!b.hypocenter?.name || !a.hypocenter?.name || a.hypocenter.name === b.hypocenter.name);
  return sameEvent ? current : incoming;
}

export function quakeReportTime(data) {
  return parseReportTime(data.issue?.time || data.time || data.earthquake?.time);
}

export function sameQuakeReport(current, incoming) {
  if (!current || !quakeReportTime(current) || quakeReportTime(current) !== quakeReportTime(incoming)) return false;
  const a = current.earthquake || {};
  const b = incoming.earthquake || {};
  return parseReportTime(a.time) === parseReportTime(b.time) && a.hypocenter?.name === b.hypocenter?.name && Number(a.maxScale) === Number(b.maxScale);
}

export function displayObservationTime(value) {
  const time = parseReportTime(value);
  return time ? new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
  }).format(time) : '時刻不明';
}

export function acceptsQuakeReport(current, incoming) {
  if (!current) return true;
  const difference = quakeReportTime(incoming) - quakeReportTime(current);
  if (difference > 0) return true;
  if (difference < 0) return false;
  // Preserve exact station coordinates when the same report arrives over P2P.
  return measuredPoints(incoming.points).length >= measuredPoints(current.points).length;
}

export function parseJmaQuake(document) {
  const head = document?.Head;
  const earthquake = document?.Body?.Earthquake;
  const observation = document?.Body?.Intensity?.Observation;
  if (!head || !earthquake || !observation || head.InfoType === '取消' || document.Control?.Status !== '通常') return null;
  const points = [];
  for (const pref of observation.Pref || []) {
    for (const area of pref.Area || []) {
      for (const city of area.City || []) {
        for (const station of city.IntensityStation || []) {
          const scale = JMA_SCALES[station.Int];
          if (!scale) continue;
          points.push({
            code: station.Code, pref: pref.Name, addr: station.Name, scale, isArea: false,
            latitude: station.latlon?.lat, longitude: station.latlon?.lon
          });
        }
      }
    }
  }
  const area = earthquake.Hypocenter?.Area || {};
  const coordinate = /^([+-]\d+(?:\.\d+)?)([+-]\d+(?:\.\d+)?)([+-]\d+(?:\.\d+)?)?\/$/.exec(area.Coordinate || '');
  const reported = document.Control.DateTime || head.ReportDateTime;
  return {
    id: `jma-${head.EventID}-${reported}`, code: 551, time: reported,
    issue: { time: reported, source: '気象庁', type: 'DetailScale' },
    earthquake: {
      time: earthquake.ArrivalTime || earthquake.OriginTime,
      maxScale: JMA_SCALES[observation.MaxInt] ?? -1,
      hypocenter: {
        name: area.Name,
        latitude: coordinate ? Number(coordinate[1]) : null,
        longitude: coordinate ? Number(coordinate[2]) : null,
        depth: coordinate?.[3] ? Math.max(0, -Number(coordinate[3]) / 1000) : -1,
        magnitude: earthquake.Magnitude != null && earthquake.Magnitude !== '' && Number.isFinite(Number(earthquake.Magnitude)) ? Number(earthquake.Magnitude) : -1
      }
    },
    points,
    observationSource: '気象庁 観測震度'
  };
}

export function createObservationFeed({ fetcher = fetch, onData = () => {}, onStatus = () => {} } = {}) {
  let busy = false;
  let lastFile = '';
  let initialized = false;
  async function poll() {
    if (busy) return;
    busy = true;
    onStatus('loading', '観測震度を取得中');
    try {
      const listResponse = await fetcher(JMA_QUAKE_BASE + 'list.json', { cache: 'no-store', signal: AbortSignal.timeout(12000) });
      if (!listResponse.ok) throw new Error('list');
      const list = await listResponse.json();
      if (!Array.isArray(list)) throw new Error('format');
      const item = list.filter(entry => entry.ttl === '震源・震度情報' && entry.ift !== '取消' && /^\d+_\d+_VXSE[\w]+_\d+\.json$/.test(entry.json || ''))
        .sort((a, b) => parseReportTime(b.rdt) - parseReportTime(a.rdt))[0];
      if (!item) { onStatus('empty', '観測震度の発表なし'); return; }
      if (item.json !== lastFile) {
        const response = await fetcher(JMA_QUAKE_BASE + item.json, { cache: 'no-store', signal: AbortSignal.timeout(12000) });
        if (!response.ok) throw new Error('detail');
        const quake = parseJmaQuake(await response.json());
        if (!quake) throw new Error('format');
        onData(quake, { silent: !initialized });
        lastFile = item.json;
      }
      initialized = true;
      onStatus('ready', '気象庁 観測震度');
    } catch {
      onStatus('error', '観測震度の取得に失敗・再試行待ち');
    } finally {
      busy = false;
    }
  }
  return { poll };
}
