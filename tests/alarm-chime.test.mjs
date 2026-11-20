import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { generateEewChime } from '../scripts/generate-eew-chime.mjs';
import { PUBLIC_FILES } from '../scripts/build.mjs';

test('shipped chime matches its original synthesis and has bounded PCM levels and silence at both ends', async () => {
  const wav = await readFile(new URL('../audio/eew-chime.wav', import.meta.url));
  assert.deepEqual(wav, generateEewChime());
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wav.readUInt32LE(4), wav.length - 8);
  assert.ok(wav.length <= 2000000, 'fit the alarm controller asset size limit');
  assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
  assert.equal(wav.readUInt16LE(22), 2);
  const rate = wav.readUInt32LE(24);
  assert.equal(rate, 48000);
  assert.equal(wav.readUInt16LE(34), 16);
  assert.equal(wav.readUInt16LE(32), 4);
  assert.equal(wav.readUInt32LE(28), rate * 4);
  assert.equal(wav.readUInt32LE(40) / 4 / rate, 3.2);
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

test('warning chime preserves chord pitches, two stepped arpeggios, and a clean speech handoff', () => {
  const wav = generateEewChime();
  const rate = wav.readUInt32LE(24);
  const sample = index => (wav.readInt16LE(44 + index * 4) + wav.readInt16LE(46 + index * 4)) / (2 * 32767);
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
    assert.ok(spectrum(frequency, .285, .345) > 4 * spectrum(frequency * 2 ** (1 / 12), .285, .345));
  }
  assert.ok(spectrum(415.305, .66, .72) > 4 * spectrum(391.995, .66, .72));
  // Higher notes should enter in sequence, not collapse into a simultaneous chord.
  assert.ok(spectrum(659.255, .085, .125) < .1 * spectrum(659.255, .165, .205));
  assert.ok(spectrum(1244.508, .165, .205) < .1 * spectrum(1244.508, .295, .335));
  // Short resonant attack modes measured in the reference's isolated first note.
  const firstNote = spectrum(391.995, .025, .07);
  for (const frequency of [4112.028, 6820.713]) {
    const relativePower = spectrum(frequency, .025, .07) / firstNote;
    assert.ok(relativePower > .002 && relativePower < .08, 'retain a short mallet-like attack');
  }
  assert.ok(energy(1.55, 1.6) < 1e-8, 'leave a clean pause between repetitions');
  assert.ok(energy(3.15, 3.2) < 1e-8, 'leave silence before handing over to speech');
  // A saturated chord previously created audible difference/mixing products
  // below the lowest played note, despite having no full-scale PCM samples.
  const fundamental = spectrum(391.995, .285, .345);
  for (const frequency of [130.739, 260.739]) {
    assert.ok(spectrum(frequency, .285, .345) / fundamental < 1e-4,
      `unexpected nonlinear mixing product at ${frequency} Hz`);
  }
});

test('warning asset repeats exactly twice with subtle stereo width and a stable mono mix', () => {
  const wav = generateEewChime();
  const pcm = wav.subarray(44);
  assert.deepEqual(pcm.subarray(0, pcm.length / 2), pcm.subarray(pcm.length / 2));
  let leftPower = 0, rightPower = 0, monoPower = 0, differencePower = 0;
  for (let offset = 0; offset < pcm.length; offset += 4) {
    const left = pcm.readInt16LE(offset) / 32767;
    const right = pcm.readInt16LE(offset + 2) / 32767;
    leftPower += left * left;
    rightPower += right * right;
    monoPower += ((left + right) / 2) ** 2;
    differencePower += (left - right) ** 2;
  }
  const averagePower = (leftPower + rightPower) / 2;
  assert.ok(differencePower > 0, 'stereo channels should have a small spatial difference');
  assert.ok(differencePower / averagePower < .01, 'keep the direct chime centered');
  assert.ok(monoPower / averagePower > .99, 'mono playback must preserve the chime level');
});
