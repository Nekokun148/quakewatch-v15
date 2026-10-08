export const WAVE_LIFETIME = 10 * 60 * 1000;

export function waveDistances(origin, now) {
  const age = Math.max(0, now - origin);
  return { age, p: age * 6, s: age * 3.5 };
}

export function animateWaves({ origin, update, finish = () => {}, environment = window }) {
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
    const distances = waveDistances(origin, environment.Date.now());
    if (distances.age >= WAVE_LIFETIME) { stop(); return; }
    update(distances);
    frame = environment.requestAnimationFrame(draw);
  }
  draw();
  return stop;
}
