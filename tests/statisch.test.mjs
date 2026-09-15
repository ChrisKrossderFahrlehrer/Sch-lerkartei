// Vier Pruefungen, die ohne Emulator, ohne Anmeldung und ohne zusaetzliche
// Pakete auskommen - reines Node. Sie fangen genau die Fehlerart ab, die in
// einem Projekt ohne Bauschritt sonst erst beim Nutzer auffaellt:
//
//   1 Syntaxfehler in einem <script>-Block. Ohne Bauschritt merkt das niemand
//     vor dem Hochladen; im Browser bleibt die Seite dann einfach leer.
//   2 onclick="foo()" ohne dass foo definiert ist. Der Knopf tut nichts, in
//     der Konsole steht ein ReferenceError - den sieht nur, wer sie oeffnet.
//     (So gefunden: closeModal() im Schueler-Portal.)
//   3 Zweimal dieselbe id im selben Bildschirm. getElementById trifft dann
//     immer nur das erste Element, das zweite bleibt tot.
//   4 Eine Firestore-Sammlung, die der Client benutzt, fuer die firestore.rules
//     aber keinen match-Block hat - jeder Zugriff darauf wird abgelehnt.
//
// Starten:  cd tests && npm run test:statisch

import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

const WURZEL = join(dirname(fileURLToPath(import.meta.url)), '..');
const ABLAGE = mkdtempSync(join(tmpdir(), 'fahrsync-syntax-'));

const SEITEN = ['index.html', 'schueler-portal.html', 'kalender.html', 'adk-platform.html',
                'start.html', 'schueler.html', '404.html', 'agb.html', 'avv.html',
                'datenschutz.html', 'impressum.html', 'reel.html'];
const CLIENT = ['index.html', 'kalender.html', 'adk-platform.html', 'schueler-portal.html'];

const lies = (d) => { try { return readFileSync(join(WURZEL, d), 'utf8'); } catch { return null; } };
const zeileVon = (text, index) => text.slice(0, index).split('\n').length;

let befunde = 0;
const melde = (was) => { befunde++; console.log('    ✗ ' + was); };

// ══ 1 Syntax ═══════════════════════════════════════════════════════════
console.log('\n1) SYNTAX der eingebetteten Skripte');
let bloecke = 0;
for (const d of SEITEN) {
  const text = lies(d);
  if (!text) continue;
  let n = 0;
  for (const m of text.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/gi)) {
    const attr = m[1] || '', code = m[2];
    if (/\bsrc\s*=/.test(attr)) continue;                    // externes Skript
    if (/type\s*=\s*["'](?!module|text\/javascript|application\/javascript)/.test(attr)) continue;
    if (!code.trim()) continue;
    n++; bloecke++;
    const istModul = /type\s*=\s*["']module["']/.test(attr);
    const pfad = join(ABLAGE, `${d.replace(/\W/g, '_')}_${n}.${istModul ? 'mjs' : 'js'}`);
    writeFileSync(pfad, code);
    try {
      execFileSync(process.execPath, ['--check', pfad], { stdio: 'pipe' });
    } catch (e) {
      melde(`${d} Block ${n} (ab Zeile ${zeileVon(text, m.index)}): `
            + String(e.stderr).split('\n').filter(Boolean).slice(1, 3).join(' | '));
    }
  }
}
console.log(`  ${bloecke} Skriptbloecke geprueft`);

// ══ 2 Handler ══════════════════════════════════════════════════════════
// Nur Aufrufe ohne vorangehenden Punkt zaehlen - sonst faengt man jedes
// el.remove() mit ein. Schluesselwoerter und eingebaute Namen fliegen raus.
console.log('\n2) onclick & Co. verweisen auf vorhandene Funktionen');
const SCHLUESSEL = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'typeof',
  'function', 'new', 'delete', 'var', 'let', 'const', 'else', 'do', 'try', 'void']);
const EINGEBAUT = new Set(['alert', 'confirm', 'prompt', 'print', 'parseInt', 'parseFloat',
  'String', 'Number', 'Boolean', 'Array', 'Object', 'Date', 'Math', 'JSON', 'isNaN',
  'encodeURIComponent', 'decodeURIComponent', 'setTimeout', 'setInterval', 'event']);
for (const d of CLIENT) {
  const text = lies(d);
  if (!text) continue;
  const gerufen = new Map();
  for (const m of text.matchAll(/\son(?:click|change|input|submit|keyup|keydown|focus|blur)\s*=\s*"([^"]*)"/g)) {
    // Steht das Beispiel in einem Kommentar, ist es keins.
    const zeilenAnfang = text.lastIndexOf('\n', m.index) + 1;
    const anfang = text.slice(zeilenAnfang, m.index).trimStart();
    if (anfang.startsWith('//') || anfang.startsWith('*')) continue;
    for (const f of m[1].matchAll(/(?:^|[^.\w$])([A-Za-z_$][\w$]*)\s*\(/g)) {
      const name = f[1];
      if (SCHLUESSEL.has(name) || EINGEBAUT.has(name)) continue;
      if (!gerufen.has(name)) gerufen.set(name, zeileVon(text, m.index));
    }
  }
  let offen = 0;
  for (const [name, zeile] of gerufen) {
    const da = new RegExp(`(?:window\\.${name}\\s*=|function\\s+${name}\\b`
                        + `|(?:const|let|var)\\s+${name}\\s*=`
                        + `|\\b${name}\\s*[,)]|\\(\\s*${name}\\b)`).test(text);
    if (!da) { offen++; melde(`${d}:${zeile}  ${name}() ist nirgends definiert`); }
  }
  console.log(`  ${d.padEnd(22)} ${gerufen.size} Handler${offen ? '' : ' ✓'}`);
}

// ══ 3 Doppelte IDs ═════════════════════════════════════════════════════
// Geprueft wird nur das feste Markup AUSSERHALB der Skriptbloecke - also
// das, was beim Laden wirklich gleichzeitig im DOM steht. Was ein Skript
// erst erzeugt, kommt haeufig in Alternativen vor (Admin- gegen
// Lehrer-Ansicht, ternaerer Operator): dieselbe id steht dann zwar zweimal
// in der Datei, aber nie zweimal auf dem Bildschirm.
console.log('\n3) Doppelte id-Attribute im festen Markup');
for (const d of CLIENT) {
  const text = lies(d);
  if (!text) continue;
  const markup = text.replace(/<script[^>]*>[\s\S]*?<\/script>/gi,
                              (s) => s.replace(/[^\n]/g, ' '));  // Zeilen erhalten
  const stellen = new Map();
  for (const m of markup.matchAll(/\sid\s*=\s*["']([^"'${]+)["']/g)) {
    if (!stellen.has(m[1])) stellen.set(m[1], []);
    stellen.get(m[1]).push(zeileVon(markup, m.index));
  }
  let offen = 0;
  for (const [id, zeilen] of stellen) {
    if (zeilen.length < 2) continue;
    offen++; melde(`${d}  id="${id}" steht fest im Markup in Zeile ${zeilen.join(', ')}`);
  }
  console.log(`  ${d.padEnd(22)} ${stellen.size} feste IDs${offen ? '' : ' ✓'}`);
}

// ══ 4 Sammlungen gegen die Regeln ══════════════════════════════════════
console.log('\n4) Jede benutzte Firestore-Sammlung hat einen match-Block');
const benutzt = new Set();
for (const d of CLIENT) {
  const text = lies(d);
  if (!text) continue;
  for (const m of text.matchAll(/\b(?:collection|collectionGroup|doc)\s*\(\s*db\s*,\s*['"]([^'"]+)/g)) {
    benutzt.add(m[1].split('/')[0]);
  }
}
const regeln = lies('firestore.rules') || '';
const abgedeckt = new Set([...regeln.matchAll(/match\s+\/([A-Za-z0-9_]+)\//g)].map(m => m[1]));
const offen = [...benutzt].filter(s => !abgedeckt.has(s)).sort();
console.log(`  ${benutzt.size} Sammlungen im Client, ${abgedeckt.size} in den Regeln${offen.length ? '' : ' ✓'}`);
for (const s of offen) melde(`Sammlung "${s}" hat keinen match-Block in firestore.rules`);

// ══ Ergebnis ═══════════════════════════════════════════════════════════
console.log(befunde === 0
  ? '\n✓ Keine Befunde.\n'
  : `\n✗ ${befunde} Befund(e).\n`);
process.exit(befunde ? 1 : 0);
