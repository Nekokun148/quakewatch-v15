export function createLocationController({ environment = window, onStatus = () => {}, onPosition = () => {}, onClear = () => {} } = {}) {
  const geo = environment.navigator?.geolocation;
  let enabled = false;
  let watch = null;
  let generation = 0;
  const report = (phase, message) => onStatus({ supported: Boolean(geo), enabled, phase, message });
  function stop() {
    generation++;
    enabled = false;
    if (watch !== null) geo.clearWatch(watch);
    watch = null;
    onClear();
    report(geo ? 'off' : 'unsupported', geo ? '現在地 OFF' : '位置情報未対応');
  }
  function start() {
    if (!geo) {
      report('unsupported', '位置情報未対応');
      return false;
    }
    if (enabled) return true;
    enabled = true;
    const token = ++generation;
    report('requesting', '現在地を取得中');
    try {
      watch = geo.watchPosition(position => {
        if (!enabled || token !== generation) return;
        const { latitude, longitude, accuracy } = position.coords;
        if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) return;
        onPosition({ lat: latitude, lng: longitude, accuracy: Number.isFinite(accuracy) ? Math.max(0, accuracy) : 0 });
        report('ready', `現在地取得済み / 精度 約${Math.round(accuracy || 0)}m`);
      }, error => {
        if (!enabled || token !== generation) return;
        if (error.code === 1) {
          stop();
          report('denied', '位置情報の許可が必要です');
        } else {
          report('unavailable', error.code === 3 ? '現在地の取得がタイムアウト' : '現在地を取得できません');
        }
      }, { enableHighAccuracy: false, timeout: 12000, maximumAge: 60000 });
    } catch {
      stop();
      report('unavailable', '現在地を取得できません');
      return false;
    }
    return true;
  }
  report(geo ? 'off' : 'unsupported', geo ? '現在地 OFF' : '位置情報未対応');
  return { start, stop };
}
