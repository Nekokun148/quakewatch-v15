import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export function generateEewChime() {
  const rate = 48000;
  const cycleFrames = Math.round(rate * 1.6);
  const repeats = 2;
  const channels = 2;
  const left = new Float64Array(cycleFrames);
  const right = new Float64Array(cycleFrames);
  const dry = new Float64Array(cycleFrames);
  const duration = .82;
  // The published score voices the first chord G4, C5, E5, Bb5, Eb6,
  // with a semitone rise for the second chord (JCSS 2022 P1-038, figure 1).
  // Reference nc354471: about 65 ms between notes and 350 ms between arpeggios.
  // This is a new synthesis, not a sampled NHK recording.
  const voicing = [67, 72, 76, 82, 87];
  // Frequency ratios, initial levels, and decay constants of a struck resonator.
  // The reference's isolated G4 has short modes near 4.11 and 6.82 kHz.
  const modes = [[1, 1, .20], [2, .28, .16], [5, .025, .09], [10.49, .30, .038], [17.4, .31, .028]];
  const noteLevels = [.60, .83, 1, 1.12, 1.20];
  for (let chord = 0; chord < 2; chord++) {
      for (let note = 0; note < voicing.length; note++) {
        const frequency = 440 * 2 ** ((voicing[note] + chord - 69) / 12);
        const start = .015 + chord * .35 + note * .065;
        for (let i = 0; i < Math.floor(duration * rate); i++) {
          const t = i / rate;
          const attack = Math.min(1, t / .004);
          const release = Math.min(1, (duration - t) / .07);
          let resonator = 0;
          for (const [ratio, level, decay] of modes) {
            const modeFrequency = frequency * ratio;
            if (modeFrequency >= rate / 2) continue;
            resonator += level * Math.exp(-t / decay) * Math.sin(2 * Math.PI * modeFrequency * t);
          }
          const value = attack * release * noteLevels[note] * resonator;
          const index = Math.round(start * rate) + i;
          if (index < dry.length) dry[index] += value;
        }
      }
  }
  // Short room reflections add weight without masking the pause or announcement.
  for (let i = 0; i < cycleFrames; i++) {
    const reflection1 = dry[i - Math.round(rate * .03)] || 0;
    const reflection2 = dry[i - Math.round(rate * .06)] || 0;
    // Fade the last reflection before speech takes over, without an abrupt cut.
    const tailFade = Math.max(0, Math.min(1, (1.55 - i / rate) / .05));
    // Mix linearly: saturating the combined chord creates new intermodulation
    // tones and aliases, even if the final PCM is normalized below full scale.
    const center = dry[i] + .08 * reflection1 + .025 * reflection2;
    // The direct attack stays centered. Quiet, positive early reflections give
    // modest width while retaining the full signal when mixed to mono.
    left[i] = (center + .02 * (dry[i - Math.round(rate * .011)] || 0)) * tailFade;
    right[i] = (center + .02 * (dry[i - Math.round(rate * .017)] || 0)) * tailFade;
  }
  let peak = 0;
  for (let i = 0; i < cycleFrames; i++) peak = Math.max(peak, Math.abs(left[i]), Math.abs(right[i]));
  const frameBytes = channels * 2;
  const cycleBytes = cycleFrames * frameBytes;
  const wav = Buffer.alloc(44 + cycleBytes * repeats);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(channels, 22);
  wav.writeUInt32LE(rate, 24);
  wav.writeUInt32LE(rate * frameBytes, 28);
  wav.writeUInt16LE(frameBytes, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(cycleBytes * repeats, 40);
  // Leave additional output headroom for small speakers and subsequent mixing.
  for (let i = 0; i < cycleFrames; i++) {
    wav.writeInt16LE(Math.round(left[i] / peak * .78 * 32767), 44 + i * frameBytes);
    wav.writeInt16LE(Math.round(right[i] / peak * .78 * 32767), 46 + i * frameBytes);
  }
  // Bake in exactly two cycles; the browser plays once and then hands off to speech.
  for (let repeat = 1; repeat < repeats; repeat++) {
    wav.copy(wav, 44 + repeat * cycleBytes, 44, 44 + cycleBytes);
  }
  return wav;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const target = new URL('../audio/eew-chime.wav', import.meta.url);
  await mkdir(new URL('../audio/', import.meta.url), { recursive: true });
  await writeFile(target, generateEewChime());
}
