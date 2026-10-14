import { mkdir, copyFile, writeFile, readFile, stat, lstat, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PUBLIC_FILES = [
  'js/wolfx.js',
  'index.html', 'manifest.json', 'sw.js', 'css/style.css', 'icons/icon.svg',
  'js/app.js', 'js/observations.js', 'js/observation-ui.js', 'js/strong-motion.js', 'js/monitor-map.js', 'js/monitor-changes.js', 'js/ydits.js', 'js/waves.js', 'js/eew.js', 'js/alarm.js', 'js/speech.js', 'js/voicevox.js', 'js/location.js', 'js/dmdata.js', 'js/dmdata-ui.js',
  'js/data.js', 'js/stations.js', 'js/seafloor-stations.js', 'js/sensing-areas.js',
  'data/basemap.geojson', 'data/monitor-points.json', 'THIRD_PARTY_NOTICES.md'
];

export async function build({ monitorApiBase = process.env.KMONI_API_BASE || '' } = {}) {
  let monitorUrl;
  if (monitorApiBase) {
    monitorUrl = new URL(monitorApiBase);
    if (monitorUrl.protocol !== 'https:' || monitorUrl.username || monitorUrl.password || monitorUrl.search || monitorUrl.hash ||
        monitorUrl.pathname !== '/api/strong-motion/') throw new Error('Monitor API must be a public HTTPS relay URL');
  }
  const root = new URL('../', import.meta.url);
  const destination = new URL('dist/', root);
  const targetRoot = fileURLToPath(destination);
  if (resolve(targetRoot) !== resolve(fileURLToPath(root), 'dist')) throw new Error('Invalid build directory');
  const previous = await lstat(targetRoot).catch(error => {
    if (error.code !== 'ENOENT') throw error;
  });
  if (previous?.isSymbolicLink()) throw new Error('Build directory must not be a link');
  // Recreate only our verified generated directory so stale files cannot ship.
  await rm(targetRoot, { recursive: true, force: true });
  await mkdir(destination, { recursive: true });
  for (const path of PUBLIC_FILES) {
    const source = new URL(path, root);
    if (!(await stat(source)).isFile()) throw new Error(`Missing asset: ${path}`);
    const target = new URL(path, destination);
    await mkdir(dirname(fileURLToPath(target)), { recursive: true });
    await copyFile(source, target);
  }
  const manifest = JSON.parse(await readFile(new URL('manifest.json', destination), 'utf8'));
  if (manifest.start_url !== './' || manifest.scope !== './') throw new Error('Manifest must be project-relative');
  if (monitorUrl) {
    const htmlPath = new URL('index.html', destination);
    const html = await readFile(htmlPath, 'utf8');
    if (!html.includes('<body>')) throw new Error('Missing monitor configuration target');
    await writeFile(htmlPath, html.replace('<body>', `<body data-kmoni-api-base="${monitorUrl.href}">`));
  }
  await writeFile(new URL('.nojekyll', destination), '');
  console.log(`Pages build: ${PUBLIC_FILES.length + 1} public files`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await build();
