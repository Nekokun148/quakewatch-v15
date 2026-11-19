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
  assert.equal(rate, 22050);
  assert.equal(wav.readUInt16LE(34), 16);
  assert.equal(wav.readUInt32LE(40) / 2 / rate, 3);
  let peak = 0, squares = 0;
  for (let offset = 44; offset < wav.length; offset += 2) {
    const sample = wav.readInt16LE(offset) / 32767;
    peak = Math.max(peak, Math.abs(sample));
    squares += sample * sample;
  }
  assert.ok(peak > .79 && peak <= .801);
  assert.ok(Math.sqrt(squares / ((wav.length - 44) / 2)) > .05);
  assert.equal(wav.readInt16LE(44), 0);
  assert.equal(wav.readInt16LE(wav.length - 2), 0);
  assert.ok(PUBLIC_FILES.includes('audio/eew-chime.wav'));
});
