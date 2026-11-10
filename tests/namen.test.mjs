// Undefinierte Namen und aehnliche Tippfehler - in allen Seiten, den Cloud
// Functions und dem Service Worker.
//
// Anlass: Zwei Fehler dieser Art standen unbemerkt im Betrieb.
//   - functions/index.js nutzte PAYPAL_PLAN_IDS, die Konstante stand aber in
//     rechnung.js und wurde nie importiert: bestaetigePaypalAbo brach bei
//     JEDEM Aufruf ab.
//   - adk-platform.html rief getFunctions()/httpsCallable() ohne Import auf:
//     "E-Mail manuell bestaetigen" konnte nie funktionieren.
// "node --check" findet so etwas nicht (die Datei ist ja gueltiges
// JavaScript) - der Fehler tritt erst auf, wenn die Zeile laeuft.
//
// Starten:  cd tests && node namen.test.mjs

import { ESLint } from 'eslint';
import globals from 'globals';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const WURZEL = join(dirname(fileURLToPath(import.meta.url)), '..');
const SEITEN = ['index.html', 'kalender.html', 'schueler-portal.html', 'adk-platform.html',
                'start.html', 'schueler.html', 'impressum.html'];

// Nur Regeln, die echte Laufzeitfehler anzeigen - keine Stilfragen.
const REGELN = {
  'no-undef': 'error', 'no-redeclare': 'error', 'no-dupe-keys': 'error', 'no-dupe-args': 'error',
  'no-dupe-else-if': 'error', 'no-duplicate-case': 'error', 'no-func-assign': 'error',
  'no-import-assign': 'error', 'no-const-assign': 'error', 'no-self-assign': 'error',
  'use-isnan': 'error', 'valid-typeof': 'error', 'no-unsafe-negation': 'error',
  'no-unsafe-optional-chaining': 'error', 'no-obj-calls': 'error', 'no-invalid-regexp': 'error',
  'getter-return': 'error', 'no-async-promise-executor': 'error', 'no-ex-assign': 'error',
  'no-global-assign': 'error', 'no-dupe-class-members': 'error', 'no-unsafe-finally': 'error',
  'for-direction': 'error', 'no-class-assign': 'error', 'no-delete-var': 'error',
};

const fehler = [];
let dateien = 0;

async function pruefe(name, code, { modul, umgebung, zusatz = {}, zeilenVersatz = 0 }) {
  const eslint = new ESLint({
    overrideConfigFile: true,
    overrideConfig: [{
      languageOptions: {
        ecmaVersion: 2023,
        sourceType: modul,
        globals: { ...umgebung, ...zusatz },
      },
      linterOptions: { reportUnusedDisableDirectives: false },
      rules: REGELN,
    }],
  });
  const [ergebnis] = await eslint.lintText(code, { filePath: 'pruefling.' + (modul === 'module' ? 'mjs' : 'js') });
  dateien++;
  for (const m of ergebnis.messages) {
    if (m.severity < 2 && !m.fatal) continue;
    fehler.push(`${name}:${m.line + zeilenVersatz}  ${m.message}`);
  }
}

console.log('\nUNDEFINIERTE NAMEN UND TIPPFEHLER');

// ── Seiten: jeden <script>-Block einzeln ─────────────────────────────
for (const seite of SEITEN) {
  let html;
  try { html = readFileSync(join(WURZEL, seite), 'utf8'); } catch (e) { continue; }
  // Global erreichbar ist, was als window.X = ... gesetzt wird oder in einem
  // klassischen Skript auf oberster Ebene steht.
  const global = new Set();
  for (const m of html.matchAll(/window\.([A-Za-z_$][\w$]*)\s*=(?!=)/g)) global.add(m[1]);
  const bloecke = [...html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)]
    .filter(m => !/\bsrc=/.test(m[1]) && m[2].trim() && !/ld\+json|importmap/.test(m[1]));
  for (const m of bloecke) {
    if (/type="module"/.test(m[1])) continue;
    for (const f of m[2].matchAll(/^\s{0,4}(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm)) global.add(f[1]);
    for (const f of m[2].matchAll(/^\s{0,4}(?:var|let|const)\s+([A-Za-z_$][\w$]*)/gm)) global.add(f[1]);
  }
  const zusatz = Object.fromEntries([...global].map(n => [n, 'writable']));
  // Eingebundene Bibliotheken (vendor/) stellen diese Namen bereit
  for (const lib of ['emailjs', 'QRCode', 'firebase', 'paypal', 'Stripe']) zusatz[lib] = 'readonly';
  for (const m of bloecke) {
    const versatz = html.slice(0, m.index + m[0].indexOf(m[2])).split('\n').length - 1;
    await pruefe(seite, m[2], {
      modul: /type="module"/.test(m[1]) ? 'module' : 'script',
      umgebung: globals.browser, zusatz, zeilenVersatz: versatz,
    });
  }
}

// ── Cloud Functions ──────────────────────────────────────────────────
for (const f of readdirSync(join(WURZEL, 'functions')).filter(n => n.endsWith('.js'))) {
  await pruefe('functions/' + f, readFileSync(join(WURZEL, 'functions', f), 'utf8'),
    { modul: 'commonjs', umgebung: globals.node });
}

// ── Service Worker ───────────────────────────────────────────────────
await pruefe('sw.js', readFileSync(join(WURZEL, 'sw.js'), 'utf8'),
  { modul: 'script', umgebung: globals.serviceworker, zusatz: { firebase: 'readonly', importScripts: 'readonly' } });

if (fehler.length) {
  for (const f of fehler) console.log('  ✗', f);
  console.log(`\n${fehler.length} Befund(e) in ${dateien} Skripten\n`);
  process.exit(1);
}
console.log(`  ✓ ${dateien} Skripte geprueft, keine undefinierten Namen\n`);
