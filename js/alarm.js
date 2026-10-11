export function createAlarmController({ environment = window, onStatus = () => {}, soundUrl = null } = {}) {
  const Context = environment.AudioContext || environment.webkitAudioContext;
  const supported = typeof Context === 'function';
  let context, active, enabled = false, played = 0, phase = supported ? 'off' : 'unsupported', error = '';
  let generation = 0;
  let buffer = null, loadController = null;
  let assetPhase = soundUrl ? 'unloaded' : 'none', assetWarning = '';
  const report = () => onStatus({ supported, enabled, phase, played, error, assetPhase, assetWarning,
    source: buffer ? 'file' : 'tone', duration: buffer?.duration || 0 });

  async function loadSound(episode) {
    loadController?.abort();
    const controller = new AbortController();
    loadController = controller;
    assetPhase = 'loading';
    assetWarning = '';
    report();
    let timer;
    try {
      const loading = (async () => {
        const response = await environment.fetch(soundUrl, { signal: controller.signal, redirect: 'error' });
        if (!response.ok) throw new Error('Alarm asset unavailable');
        const bytes = await response.arrayBuffer();
        if (!bytes.byteLength || bytes.byteLength > 2000000) throw new Error('Invalid alarm asset');
        const decoded = await context.decodeAudioData(bytes);
        if (!Number.isFinite(decoded.duration) || decoded.duration <= 0 || decoded.duration > 30) throw new Error('Invalid alarm duration');
        return decoded;
      })();
      const timeout = new Promise((_, reject) => {
        controller.signal.addEventListener('abort', () => reject(new Error('Alarm loading cancelled')), { once: true });
        timer = environment.setTimeout(() => {
          controller.abort();
          reject(new Error('Alarm loading timeout'));
        }, 5000);
      });
      const decoded = await Promise.race([loading, timeout]);
      if (episode !== generation || controller.signal.aborted) return;
      buffer = decoded;
      assetPhase = 'ready';
    } catch {
      if (episode !== generation) return;
      assetPhase = 'error';
      assetWarning = '指定MP3を読み込めません。既存の警報音を使用します。';
    } finally {
      environment.clearTimeout(timer);
      if (loadController === controller) loadController = null;
      if (episode === generation) report();
    }
  }

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
      phase = active ? 'playing' : 'armed';
      report();
      if (soundUrl && !buffer) await loadSound(episode);
      return episode === generation && enabled;
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
    loadController?.abort();
    loadController = null;
    if (assetPhase === 'loading') assetPhase = buffer ? 'ready' : 'unloaded';
    enabled = false;
    stop();
  }

  function play({ onComplete = () => {} } = {}) {
    if (!enabled || context?.state !== 'running') return false;
    stop();
    const useFile = Boolean(buffer);
    let tone, gain;
    try {
      tone = useFile ? context.createBufferSource() : context.createOscillator();
      gain = context.createGain();
      const start = context.currentTime + 0.02;
      tone.connect(gain);
      gain.connect(context.destination);
      if (useFile) {
        tone.buffer = buffer;
        tone.loop = false;
        gain.gain.setValueAtTime(0, start);
        gain.gain.linearRampToValueAtTime(0.14, start + Math.min(0.01, buffer.duration / 4));
        gain.gain.setValueAtTime(0.14, start + Math.max(buffer.duration / 2, buffer.duration - 0.02));
        gain.gain.linearRampToValueAtTime(0, start + buffer.duration);
      } else {
        tone.type = 'sawtooth';
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
      }
      active = tone;
      tone.onended = () => {
        tone.disconnect(); gain.disconnect();
        if (active === tone) {
          active = null;
          phase = enabled ? 'armed' : 'off';
          report();
          onComplete();
        }
      };
      tone.start(start);
      if (!useFile) tone.stop(start + 2.55);
      played++;
      phase = 'playing';
      report();
      return true;
    } catch {
      stop();
      try { tone?.disconnect(); } catch {}
      try { gain?.disconnect(); } catch {}
      if (useFile) {
        buffer = null;
        assetPhase = 'error';
        assetWarning = '指定MP3を再生できません。既存の警報音を使用します。';
        return play({ onComplete });
      }
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

export function createAlarmAnnouncer({ alarm, speech }) {
  let pending = null;
  function announce(text = '', { sound = false } = {}) {
    if (sound) {
      speech.hold();
      pending = text;
      if (alarm.play({ onComplete() {
        const latest = pending;
        pending = null;
        if (latest !== null) speech.say(`強い揺れに警戒してください。${latest}`, { interrupt: true });
        speech.release();
      } })) return true;
      pending = null;
      speech.release();
    } else if (pending !== null) {
      pending = text;
      return true;
    }
    return speech.say(text, { interrupt: true });
  }
  function cancel() {
    if (pending !== null) {
      pending = null;
      speech.stop();
    }
    alarm.stop();
    speech.release();
  }
  return { announce, cancel };
}
