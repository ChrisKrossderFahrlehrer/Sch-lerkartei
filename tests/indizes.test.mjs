// Prueft, ob eine Abfrage im Code einen zusammengesetzten Firestore-Index
// braucht, der nicht in firestore.indexes.json steht.
//
// Warum: Firestore beantwortet einfache Abfragen aus den automatischen
// Einzelfeld-Indizes. Sobald aber ein Filter mit einer Sortierung auf einem
// ANDEREN Feld kombiniert wird, oder eine Ungleichheit mit weiteren Filtern,
// braucht es einen zusammengesetzten Index. Fehlt er, scheitert die Abfrage
// zur Laufzeit mit "failed-precondition" - und zwar erst beim Nutzer, nicht
// beim Entwickeln, weil der Emulator diese Pflicht nicht durchsetzt.
//
// Dieser Test braucht keinen Emulator und keine Anmeldung.
//
// Starten:  cd tests && npm run test:indizes

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const wurzel = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATEIEN = [
  'index.html', 'kalender.html', 'adk-platform.html',
  'schueler-portal.html', 'functions/index.js', 'functions/rechnung.js',
];

// ── Abfragen einsammeln ─────────────────────────────────────────────────
// query(...) kann ueber mehrere Zeilen gehen, darum wird die Klammer
// gezaehlt statt zeilenweise gesucht.
function klammerInhalt(text, ab) {
  let i = ab, tiefe = 1;
  while (i < text.length && tiefe > 0) {
    if (text[i] === '(') tiefe++;
    else if (text[i] === ')') tiefe--;
    i++;
  }
  return text.slice(ab, i - 1);
}

function abfragen(text, datei) {
  const raus = [];
  // Client-SDK:  query(collection(db,'x'), where(...), orderBy(...))
  for (const m of text.matchAll(/\bquery\s*\(/g)) {
    const inhalt = klammerInhalt(text, m.index + m[0].length);
    const coll = inhalt.match(/collection\s*\([^,]+,\s*'([^']+)'/);
    if (!coll) continue;
    raus.push({
      datei, sammlung: coll[1],
      filter:   [...inhalt.matchAll(/where\s*\(\s*'([^']+)'\s*,\s*'([^']+)'/g)].map(x => [x[1], x[2]]),
      sortier:  [...inhalt.matchAll(/orderBy\s*\(\s*'([^']+)'/g)].map(x => x[1]),
      zeile: text.slice(0, m.index).split('\n').length,
    });
  }
  // Admin-SDK:  .collection('x').where(...).orderBy(...)
  for (const m of text.matchAll(/\.collection\(\s*'([^']+)'\s*\)((?:\s*\.\s*(?:where|orderBy|limit)\([^)]*\))+)/g)) {
    const kette = m[2];
    const filter  = [...kette.matchAll(/where\(\s*'([^']+)'\s*,\s*'([^']+)'/g)].map(x => [x[1], x[2]]);
    const sortier = [...kette.matchAll(/orderBy\(\s*'([^']+)'/g)].map(x => x[1]);
    if (!filter.length && !sortier.length) continue;
    raus.push({
      datei, sammlung: m[1], filter, sortier,
      zeile: text.slice(0, m.index).split('\n').length,
    });
  }
  return raus;
}

// ── Braucht die Abfrage einen zusammengesetzten Index? ──────────────────
const GLEICHHEIT = new Set(['==', 'in', 'array-contains', 'array-contains-any']);

function brauchtIndex(a) {
  const felder = a.filter.map(([f]) => f);
  const ungleich = a.filter.filter(([, op]) => !GLEICHHEIT.has(op));
  // Sortierung auf einem Feld, nach dem nicht ohnehin schon gefiltert wird
  if (a.sortier.length && a.filter.length &&
      !a.sortier.every(s => felder.includes(s))) return 'Filter + Sortierung auf anderem Feld';
  // Mehr als ein Sortierfeld
  if (a.sortier.length > 1) return 'Sortierung ueber mehrere Felder';
  // Ungleichheit zusammen mit weiteren Filtern
  if (ungleich.length && a.filter.length > 1) return 'Ungleichheit plus weitere Filter';
  // Ungleichheiten auf verschiedenen Feldern
  if (new Set(ungleich.map(([f]) => f)).size > 1) return 'Ungleichheit auf mehreren Feldern';
  return null;
}

// ── Hinterlegte Indizes lesen ───────────────────────────────────────────
const indexDatei = join(wurzel, 'firestore.indexes.json');
let hinterlegt = [];
if (existsSync(indexDatei)) {
  const j = JSON.parse(readFileSync(indexDatei, 'utf8'));
  hinterlegt = (j.indexes || []).map(i =>
    i.collectionGroup + ':' + (i.fields || []).map(f => f.fieldPath).sort().join(','));
}

// ── Auswerten ───────────────────────────────────────────────────────────
let alle = [];
for (const d of DATEIEN) {
  const pfad = join(wurzel, d);
  if (existsSync(pfad)) alle = alle.concat(abfragen(readFileSync(pfad, 'utf8'), d));
}

const eindeutig = new Map();
for (const a of alle) {
  const s = a.sammlung + ':' + a.filter.map(f => f.join(' ')).join('|') + ':' + a.sortier.join('|');
  if (!eindeutig.has(s)) eindeutig.set(s, a);
}

const fehlend = [];
for (const a of eindeutig.values()) {
  const grund = brauchtIndex(a);
  if (!grund) continue;
  const schluessel = a.sammlung + ':' +
    [...a.filter.map(([f]) => f), ...a.sortier].sort().join(',');
  if (!hinterlegt.includes(schluessel)) fehlend.push({ ...a, grund, schluessel });
}

console.log(`\nFIRESTORE-INDIZES — ${alle.length} Abfragen im Code, ${eindeutig.size} verschieden`);
console.log(`  hinterlegt in firestore.indexes.json: ${hinterlegt.length}`);

if (fehlend.length === 0) {
  console.log('  ✓ Keine Abfrage braucht einen zusammengesetzten Index, der fehlt\n');
  process.exit(0);
}

console.log(`\n  ✗ ${fehlend.length} Abfrage(n) brauchen einen Index, der nicht hinterlegt ist:\n`);
for (const f of fehlend) {
  console.log(`    ${f.datei}:${f.zeile}  ${f.sammlung}`);
  console.log(`      where[${f.filter.map(x => x.join(' ')).join(', ') || '-'}]  orderBy[${f.sortier.join(', ') || '-'}]`);
  console.log(`      Grund: ${f.grund}\n`);
}
console.log('  Fehlende Indizes ergaenzen und mit "firebase deploy --only firestore:indexes"');
console.log('  veroeffentlichen. ACHTUNG: Dieser Befehl LOESCHT Indizes, die im Projekt');
console.log('  existieren, aber nicht in der Datei stehen - vorher mit');
console.log('  "firebase firestore:indexes" den Ist-Stand abgleichen.\n');
process.exit(1);
