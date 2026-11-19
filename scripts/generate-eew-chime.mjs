import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export function generateEewChime() {
  const rate = 22050;
  const samples = new Float64Array(rate * 3);
  const duration = .58;
  // Two bell-like chords form a pair, with a pause before repeating the pair.
  for (let pair = 0; pair < 2; pair++) {
    for (let chord = 0; chord < 2; chord++) {
      const root = chord === 0 ? 523.25 : 493.88;
      for (let note = 0; note < 3; note++) {
        const frequency = root * [1, 1.25, 1.5][note];
        const start = .04 + pair * 1.35 + chord * .48 + note * .055;
        for (let i = 0; i < Math.floor(duration * rate); i++) {
          const t = i / rate;
          const phase = 2 * Math.PI * frequency * t;
          const envelope = Math.min(1, t / .004, (duration - t) / .06) * Math.exp(-4 * t / duration);
          const value = envelope * (.5 * Math.sin(phase) + .24 * Math.sin(phase * 2) + .08 * Math.sin(phase * 3));
          const index = Math.round(start * rate) + i;
          if (index < samples.length) samples[index] += value;
        }
      }
    }
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
