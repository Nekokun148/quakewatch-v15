import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export function generateEewChime() {
  const rate = 22050;
  const samples = new Float64Array(rate * 3.6);
  const duration = .26;
  for (let group = 0; group < 4; group++) {
    for (let note = 0; note < 2; note++) {
      const start = .04 + group * .86 + note * .34;
      const low = note === 0 ? 920 : 1160;
      const high = note === 0 ? 1320 : 740;
      for (let i = 0; i < Math.floor(duration * rate); i++) {
        const t = i / rate;
        const phase = 2 * Math.PI * (low * t + (high - low) * t * t / (2 * duration));
        const envelope = Math.min(1, t / .008, (duration - t) / .035) * Math.exp(-2.5 * t / duration);
        const value = envelope * (.5 * Math.sin(phase) + .23 * Math.sin(phase * Math.SQRT2) + .1 * Math.sin(phase * 2));
        for (const [delay, gain] of [[0, 1], [.09, .16], [.18, .08]]) {
          const index = Math.round((start + delay) * rate) + i;
          if (index < samples.length) samples[index] += value * gain;
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
