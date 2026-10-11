import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const css = await readFile(new URL('../css/style.css', import.meta.url), 'utf8');
const app = await readFile(new URL('../js/app.js', import.meta.url), 'utf8');
test('epicenter icon remains centered at compact fixed size with a white outline', () => {
  assert.match(app, /iconSize: \[20, 20\]/);
  assert.match(app, /iconAnchor: \[10, 10\]/);
  assert.match(css, /\.quake-cross-icon\s*\{[^}]*width: 20px;[^}]*height: 20px;/);
  assert.match(css, /border: 1px solid #fff;/);
  const fallback = app.slice(app.indexOf('function addLocalMarker('), app.indexOf('function buildObservationStations('));
  assert.match(fallback, /p\.x - 6/);
  assert.doesNotMatch(fallback, /class: 'quake-marker'/);
});
test('responsive layouts include tablet orientation, safe areas and touch targets without disabling zoom', async () => {
  assert.match(css, /max-width: 1100px\) and \(orientation: portrait\)/);
  assert.match(css, /orientation: landscape/);
  assert.match(css, /@media \(pointer: coarse\)/);
  assert.match(css, /min-height: 44px/);
  assert.match(css, /env\(safe-area-inset-bottom\)/);
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(html, /width=device-width,initial-scale=1,viewport-fit=cover/);
  assert.doesNotMatch(html, /user-scalable=no|maximum-scale=1/);
});
