import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export function generateEewChime() {
  const rate = 22050;
  const samples = new Float64Array(rate * 3.2);
  const dry = new Float64Array(samples.length);
  const duration = .9;
  // A fast five-note upward rake, including the minor seventh and sharp ninth.
  // The second strike rises a semitone rather than resolving to a major triad.
  // This is synthesized electric-piano-like timbre, not a sampled NHK recording.
  const voicing = [60, 64, 70, 75, 79];
  for (let pair = 0; pair < 2; pair++) {
    for (let chord = 0; chord < 2; chord++) {
      for (let note = 0; note < voicing.length; note++) {
        const frequency = 440 * 2 ** ((voicing[note] + chord - 69) / 12);
        const start = .025 + pair * 1.42 + chord * .63 + note * .019;
        for (let i = 0; i < Math.floor(duration * rate); i++) {
          const t = i / rate;
          const phase = 2 * Math.PI * frequency * t;
          const attack = Math.min(1, t / .0025);
          const release = Math.min(1, (duration - t) / .08);
          const body = Math.exp(-t / .245) * (.57 * Math.sin(phase) + .12 * Math.sin(phase * 2));
          const brightness = Math.exp(-t / .105) * (.23 * Math.sin(phase * 3) + .10 * Math.sin(phase * 4) + .04 * Math.sin(phase * 5));
          // The transient decays rapidly, leaving a short, clear pitched tail.
          const tine = .19 * Math.exp(-t / .045) * Math.sin(phase + 1.8 * Math.exp(-t / .025) * Math.sin(phase * 2));
          const value = attack * release * (body + brightness + tine);
          const index = Math.round(start * rate) + i;
          if (index < dry.length) dry[index] += value;
        }
      }
    }
  }
  // Short room reflections add weight without masking the pause or announcement.
  for (let i = 0; i < samples.length; i++) {
    const reflection1 = dry[i - Math.round(rate * .047)] || 0;
    const reflection2 = dry[i - Math.round(rate * .083)] || 0;
    samples[i] = Math.tanh(1.2 * (dry[i] + .12 * reflection1 + .045 * reflection2));
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
  for (let i = 0; i < samples.length; i++) wav.writeInt16LE(Math.round(samples[i] / peak * .8 * 32767), 44 + i * 2);
  return wav;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const target = new URL('../audio/eew-chime.wav', import.meta.url);
  await mkdir(new URL('../audio/', import.meta.url), { recursive: true });
  await writeFile(target, generateEewChime());
}
