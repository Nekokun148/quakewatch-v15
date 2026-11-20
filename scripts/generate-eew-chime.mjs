import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export function generateEewChime() {
  const rate = 44100;
  // Compress timing only: resynthesizing keeps the original note pitches.
  const pace = .6;
  const samples = new Float64Array(Math.round(rate * 3.2 * pace));
  const dry = new Float64Array(samples.length);
  const duration = .9 * pace;
  // The published score voices the first chord G4, C5, E5, Bb5, Eb6,
  // with a semitone rise for the second chord (JCSS 2022 P1-038, figure 1).
  // Keep the faster cadence, with a pitched piano-like attack rather than FM bells.
  // This is a new synthesis, not a sampled NHK recording.
  const voicing = [67, 72, 76, 82, 87];
  const partialLevels = [1, .28, .12, .065, .03, .015, .0075, .003];
  const noteLevels = [.82, .91, 1.02, 1.08, .94];
  for (let pair = 0; pair < 2; pair++) {
    for (let chord = 0; chord < 2; chord++) {
      for (let note = 0; note < voicing.length; note++) {
        const frequency = 440 * 2 ** ((voicing[note] + chord - 69) / 12);
        const start = (.025 + pair * 1.42 + chord * .63 + note * .026) * pace;
        for (let i = 0; i < Math.floor(duration * rate); i++) {
          const t = i / rate;
          const envelopeTime = t / pace;
          const attack = Math.min(1, envelopeTime / .0025);
          const release = Math.min(1, (duration - t) / (.08 * pace));
          let strings = 0;
          for (let partial = 1; partial <= partialLevels.length; partial++) {
            const partialFrequency = frequency * partial * Math.sqrt(1 + .00008 * partial * partial);
            if (partialFrequency >= rate / 2) continue;
            const phase = 2 * Math.PI * partialFrequency * t;
            const decay = Math.exp(-envelopeTime / (.26 / (1 + .36 * (partial - 1))));
            // A second, subtly detuned string gives weight without a metallic FM sweep.
            const stringPair = .78 * Math.sin(phase) + .22 * Math.sin(phase * 1.0009);
            strings += partialLevels[partial - 1] * decay * stringPair;
          }
          const value = attack * release * noteLevels[note] * strings;
          const index = Math.round(start * rate) + i;
          if (index < dry.length) dry[index] += value;
        }
      }
    }
  }
  // Short room reflections add weight without masking the pause or announcement.
  for (let i = 0; i < samples.length; i++) {
    const reflection1 = dry[i - Math.round(rate * .047 * pace)] || 0;
    const reflection2 = dry[i - Math.round(rate * .083 * pace)] || 0;
    // Fade the last reflection before speech takes over, without an abrupt cut.
    const tailFade = Math.max(0, Math.min(1, (3.1 * pace - i / rate) / (.06 * pace)));
    // Mix linearly: saturating the combined chord creates new intermodulation
    // tones and aliases, even if the final PCM is normalized below full scale.
    samples[i] = (dry[i] + .12 * reflection1 + .045 * reflection2) * tailFade;
  }
  let peak = 0;
  for (const value of samples) peak = Math.max(peak, Math.abs(value));
  const wav = Buffer.alloc(44 + samples.length * 2);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(rate, 24);
  wav.writeUInt32LE(rate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(samples.length * 2, 40);
  // Leave additional output headroom for small speakers and subsequent mixing.
  for (let i = 0; i < samples.length; i++) wav.writeInt16LE(Math.round(samples[i] / peak * .62 * 32767), 44 + i * 2);
  return wav;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const target = new URL('../audio/eew-chime.wav', import.meta.url);
  await mkdir(new URL('../audio/', import.meta.url), { recursive: true });
  await writeFile(target, generateEewChime());
}
