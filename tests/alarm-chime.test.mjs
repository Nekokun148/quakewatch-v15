import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { generateEewChime } from '../scripts/generate-eew-chime.mjs';
import { PUBLIC_FILES } from '../scripts/build.mjs';

test('shipped chime matches its original synthesis and has bounded PCM levels and silence at both ends', async () => {
  const wav = await readFile(new URL('../audio/eew-chime.wav', import.meta.url));
  assert.deepEqual(wav, generateEewChime());
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
  assert.equal(wav.readUInt16LE(22), 1);
  const rate = wav.readUInt32LE(24);
  assert.equal(rate, 44100);
  assert.equal(wav.readUInt16LE(34), 16);
  assert.equal(wav.readUInt32LE(40) / 2 / rate, 1.92);
  let peak = 0, squares = 0;
  for (let offset = 44; offset < wav.length; offset += 2) {
    const sample = wav.readInt16LE(offset) / 32767;
    peak = Math.max(peak, Math.abs(sample));
    squares += sample * sample;
  }
  assert.ok(peak > .619 && peak <= .621);
  assert.ok(Math.sqrt(squares / ((wav.length - 44) / 2)) > .05);
  assert.equal(wav.readInt16LE(44), 0);
  assert.equal(wav.readInt16LE(wav.length - 2), 0);
  assert.ok(PUBLIC_FILES.includes('audio/eew-chime.wav'));
});

test('warning chime preserves dissonant color, rising second strike, and separated attacks', () => {
  const wav = generateEewChime();
  const rate = wav.readUInt32LE(24);
  const sample = index => wav.readInt16LE(44 + index * 2) / 32767;
  function energy(from, to) {
    let sum = 0;
    for (let i = Math.floor(from * rate); i < Math.floor(to * rate); i++) sum += sample(i) ** 2;
    return sum / ((to - from) * rate);
  }
  function spectrum(frequency, from, to) {
    const first = Math.floor(from * rate), count = Math.floor((to - from) * rate);
    let real = 0, imaginary = 0;
    for (let n = 0; n < count; n++) {
      const value = sample(first + n) * (.5 - .5 * Math.cos(2 * Math.PI * n / (count - 1)));
      const angle = 2 * Math.PI * frequency * n / rate;
      real += value * Math.cos(angle);
      imaginary += value * Math.sin(angle);
    }
    return real * real + imaginary * imaginary;
  }
  // Check the score's actual register and voicing, not just the chord's name.
  for (const frequency of [391.995, 523.251, 659.255, 932.328, 1244.508]) {
    assert.ok(spectrum(frequency, .084, .204) > 4 * spectrum(frequency * 2 ** (1 / 12), .084, .204));
  }
  assert.ok(spectrum(415.305, .456, .576) > 4 * spectrum(391.995, .456, .576));
  for (const start of [.015, .393, .867, 1.245]) {
    assert.ok(energy(start + .048, start + .138) > 8 * energy(start + .27, start + .354));
  }
  assert.ok(energy(1.86, 1.92) < 1e-8, 'leave silence before handing over to speech');
  // A saturated chord previously created audible difference/mixing products
  // below the lowest played note, despite having no full-scale PCM samples.
  const fundamental = spectrum(391.995, .084, .204);
  for (const frequency of [130.739, 260.739]) {
    assert.ok(spectrum(frequency, .084, .204) / fundamental < 1e-4,
      `unexpected nonlinear mixing product at ${frequency} Hz`);
  }
});
