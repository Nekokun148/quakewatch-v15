export const MONITOR_SIZE = { width: 352, height: 400 };
export const UNRECEIVED_COLOR = '#69717c';

export function matchMonitorPoints(catalog, stations) {
  const codes = new Map(stations.map(station => [station.code, station]));
  const pixelCounts = new Map();
  const codeCounts = new Map();
  for (const point of catalog.points || []) {
    const key = `${point.x}/${point.y}`;
    pixelCounts.set(key, (pixelCounts.get(key) || 0) + 1);
    codeCounts.set(point.code, (codeCounts.get(point.code) || 0) + 1);
  }
  const seen = new Set();
  return (catalog.points || []).filter(point => {
    const station = codes.get(point.code);
    if (!station || seen.has(point.code) || codeCounts.get(point.code) !== 1 || pixelCounts.get(`${point.x}/${point.y}`) !== 1) return false;
    if (![station.lat, station.lng, point.lat, point.lng].every(Number.isFinite)) return false;
    if (!Number.isInteger(point.x) || !Number.isInteger(point.y) || point.x < 0 || point.x >= 352 || point.y < 0 || point.y >= 400) return false;
    // A moved station cannot inherit an old raster location just by sharing its ID.
    if (Math.abs(station.lat - point.lat) > .002 || Math.abs(station.lng - point.lng) > .002) return false;
    seen.add(point.code);
    return true;
  });
}

export function frameColors(imageData, points) {
  if (imageData.width !== 352 || imageData.height !== 400 || imageData.data.length !== 352 * 400 * 4) {
    throw new Error('Observation image size changed');
  }
  const colors = new Map();
  for (const point of points) {
    const offset = (point.y * 352 + point.x) * 4;
    const [r, g, b, a] = imageData.data.subarray(offset, offset + 4);
    // Reproduce only visible colored pixels; never convert colors into measurements.
    const visible = a >= 128 && Math.max(r, g, b) - Math.min(r, g, b) > 32;
    colors.set(point.code, visible ? `#${[r, g, b].map(v => v.toString(16).padStart(2, '0')).join('')}` : null);
  }
  return colors;
}
