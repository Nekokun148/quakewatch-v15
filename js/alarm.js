export function createAlarmController({ environment = window, onStatus = () => {} } = {}) {
  const Context = environment.AudioContext || environment.webkitAudioContext;
  const supported = typeof Context === 'function';
  let context, active, enabled = false, played = 0, phase = supported ? 'off' : 'unsupported', error = '';
  let generation = 0;
  const report = () => onStatus({ supported, enabled, phase, played, error });

  function stop() {
    if (active) {
      const old = active;
      active = null;
      try { old.stop(); } catch {}
    }
    phase = enabled ? 'armed' : supported ? 'off' : 'unsupported';
    report();
  }

  async function enable() {
    if (!supported) return false;
    const episode = ++generation;
    try {
      context ||= new Context();
      await context.resume();
      if (episode !== generation) return false;
      enabled = context.state === 'running';
      if (!enabled) throw new Error('Audio blocked');
      error = '';
      phase = 'armed';
      report();
      return true;
    } catch {
      if (episode !== generation) return false;
      enabled = false;
      phase = 'error';
      error = '警報音を開始できません。警報音テストで再試行できます。';
      report();
      return false;
    }
  }

  function disable() {
    generation++;
    enabled = false;
    stop();
  }

  function play() {
    if (!enabled || context?.state !== 'running') return false;
    stop();
    try {
      const tone = context.createOscillator();
      const gain = context.createGain();
      const start = context.currentTime + 0.02;
      tone.type = 'sawtooth';
      tone.connect(gain);
      gain.connect(context.destination);
      // Three triplets of rising chirps; silence between pulses leaves room for speech.
      for (let group = 0; group < 3; group++) {
        for (let pulse = 0; pulse < 3; pulse++) {
          const at = start + group * 0.85 + pulse * 0.22;
          tone.frequency.setValueAtTime(780, at);
          tone.frequency.linearRampToValueAtTime(1480, at + 0.14);
          gain.gain.setValueAtTime(0, at);
          gain.gain.linearRampToValueAtTime(0.14, at + 0.012);
          gain.gain.setValueAtTime(0.14, at + 0.065);
          gain.gain.linearRampToValueAtTime(0, at + 0.18);
        }
      }
      active = tone;
      tone.onended = () => {
        tone.disconnect(); gain.disconnect();
        if (active === tone) { active = null; phase = enabled ? 'armed' : 'off'; report(); }
      };
      tone.start(start);
      tone.stop(start + 2.55);
      played++;
      phase = 'playing';
      report();
      return true;
    } catch {
      stop();
      enabled = false;
      phase = 'error';
      error = '警報音の再生に失敗しました。';
      report();
      return false;
    }
  }
  report();
  return { enable, disable, play, stop };
}
