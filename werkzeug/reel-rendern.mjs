// Reel als fertiges Video rendern (MP4, 1080 x 1920, 30 Bilder/s).
//
// Warum nicht einfach den Bildschirm aufnehmen: Eine Aufnahme ruckelt, wenn
// der Rechner kurz haengt, und muss von Hand zugeschnitten werden. Hier wird
// jedes Bild einzeln gesetzt (window.__zeigeZeit in der Reel-Seite haelt alle
// Animationen an und stellt sie auf den Zeitpunkt), fotografiert und mit
// ffmpeg zusammengefuegt. Ergebnis: jedes Mal dasselbe, ruckelfreie Video.
//
// Braucht: Chromium (Playwright), playwright-core und ffmpeg.
//   cd /tmp && npm i playwright-core
//   NODE_PATH=/tmp/node_modules node werkzeug/reel-rendern.mjs reel-neuheiten.html fahrsync-neuheiten.mp4
// Optional: CHROMIUM=/pfad/zu/chrome
//
// Das Video hat keine Tonspur - Musik am besten in Instagram/TikTok selbst
// auswaehlen (dort ist sie lizenziert).

import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, extname, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');

const WURZEL = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const [seite = 'reel-neuheiten.html', ziel = 'fahrsync-neuheiten.mp4'] = process.argv.slice(2);
const FPS = 30;
const TYPEN = { '.html': 'text/html', '.css': 'text/css', '.woff2': 'font/woff2', '.jpg': 'image/jpeg', '.png': 'image/png', '.js': 'text/javascript' };

// Kleiner Webserver nur fuer die eigenen Dateien (Schriften brauchen http).
const server = createServer(async (req, res) => {
  const pfad = join(WURZEL, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!pfad.startsWith(WURZEL)) { res.writeHead(403).end(); return; }
  try {
    res.writeHead(200, { 'Content-Type': TYPEN[extname(pfad)] || 'application/octet-stream' });
    res.end(await readFile(pfad));
  } catch { res.writeHead(404).end(); }
}).listen(0, '127.0.0.1');
await new Promise(r => server.once('listening', r));
const port = server.address().port;

const ordner = await mkdtemp(join(tmpdir(), 'reel-'));
const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
try {
  const page = await browser.newPage({ viewport: { width: 540, height: 960 }, deviceScaleFactor: 2 });
  const fehler = [];
  page.on('pageerror', e => fehler.push(e.message));
  await page.goto(`http://127.0.0.1:${port}/${seite}?render`, { waitUntil: 'load' });
  await page.evaluate(() => document.fonts.ready);
  const gesamt = await page.evaluate(() => window.__gesamt);
  const bilder = Math.round(gesamt * FPS);
  for (let i = 0; i < bilder; i++) {
    await page.evaluate(t => window.__zeigeZeit(t), i / FPS);
    await page.screenshot({ path: join(ordner, `b${String(i).padStart(5, '0')}.png`),
      clip: { x: 0, y: 0, width: 540, height: 960 } });
    if (i % 150 === 0) console.log(`Bild ${i}/${bilder}`);
  }
  if (fehler.length) throw new Error('Seitenfehler: ' + fehler.join('; '));
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', String(FPS), '-i', join(ordner, 'b%05d.png'),
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
    resolve(ziel)], { stdio: 'inherit' });
  console.log(`Fertig: ${ziel} (${gesamt.toFixed(1)} s, ${bilder} Bilder)`);
} finally {
  await browser.close();
  server.close();
  await rm(ordner, { recursive: true, force: true });
}
