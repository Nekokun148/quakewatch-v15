const validColor = color => typeof color === 'string' && /^#[0-9a-f]{6}$/i.test(color);

export function createMonitorChangeTracker({ now = () => Date.now() } = {}) {
  let previous = null;
  function reset() { previous = null; }
  function receive({ colors, metric, observedAt }) {
    const time = Date.parse(observedAt);
    const age = now() - time;
    if (!['intensity', 'acceleration'].includes(metric) || !(colors instanceof Map) || !Number.isFinite(time)) {
      throw new Error('Invalid monitor comparison');
    }
    if (age > 5000 || age < -1000) { reset(); return { phase: 'delayed', codes: [], observedAt }; }
    if (previous && previous.metric === metric && time <= previous.time) {
      return { phase: 'unchanged', codes: [], observedAt: previous.observedAt };
    }
    const current = new Map([...colors].filter(([, color]) => validColor(color)).map(([code, color]) => [code, color.toLowerCase()]));
    const baseline = !previous || previous.metric !== metric || time - previous.time > 5000;
    const codes = baseline ? [] : [...current].filter(([code, color]) => previous.colors.has(code) && previous.colors.get(code) !== color).map(([code]) => code);
    previous = { metric, time, observedAt, colors: current };
    // These are image-color differences, not measured intensities or an earthquake detector.
    return { phase: baseline ? 'baseline' : codes.length ? 'changed' : 'unchanged', codes, observedAt };
  }
  return { receive, reset };
}
