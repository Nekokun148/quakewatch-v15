export const WAVE_LIFETIME = 10 * 60 * 1000;

export function waveDistances(origin, now, depthKm = 0) {
  const age = Math.max(0, now - origin);
  const depth = Number.isFinite(depthKm) && depthKm >= 0 ? depthKm * 1000 : 0;
  const surfaceRadius = distance => Math.sqrt(Math.max(0, distance * distance - depth * depth));
  return { age, p: surfaceRadius(age * 6), s: surfaceRadius(age * 3.5) };
}

export function animateWaves({ origin, depthKm = 0, update, finish = () => {}, environment = window }) {
  let frame;
  let stopped = false;
  function stop() {
    if (stopped) return;
    stopped = true;
    environment.cancelAnimationFrame(frame);
    finish();
  }
  function draw() {
    if (stopped) return;
    const now = environment.Date.now();
    if (!Number.isFinite(origin) || origin > now + 10000) { stop(); return; }
    const distances = waveDistances(origin, now, depthKm);
    if (distances.age >= WAVE_LIFETIME) { stop(); return; }
    update(distances);
    frame = environment.requestAnimationFrame(draw);
  }
  draw();
  return stop;
}
