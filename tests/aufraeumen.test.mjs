// Das taegliche Aufraeumen - und die Luecke, die kein Fehler MELDET.
//
// Befund: Der Job loescht abgelaufene Zugangscodes ueber
//   .where('expiresAt', '<=', jetzt - 90 Tage)
// Ein Firestore-Gleichheits- oder Vergleichsfilter ueberspringt aber jedes
// Dokument, dem das Feld GANZ FEHLT. Solche Dokumente gibt es: Der Client
// faengt sie an mehreren Stellen mit `data.expiresAt || (Date.now()+…)` ab,
// und die Speicher-Regeln haben einen eigenen Zweig fuer `!('expiresAt' in …)`.
//
// In so einem Dokument stecken Name, Lernstand und der vollstaendige
// Chatverlauf eines Schuelers. Es wuerde fuer immer liegen bleiben, ohne dass
// irgendwo ein Fehler auftaucht - der Job meldet brav "fertig".
//
// Starten:  cd tests && npm run test:aufraeumen

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const hier = dirname(fileURLToPath(import.meta.url));

process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8089';
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'fahrsync-aufraeumen';

const admin = require(join(hier, '..', 'functions', 'node_modules', 'firebase-admin'));
admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT });
const db = admin.firestore();

const { repariereFehlendeAblaufdaten } = require(join(hier, '..', 'functions', 'loeschen.js'));

const TAG = 86400000;
const jetzt = Date.now();

let ok = 0, schlecht = 0;
async function pruefe(text, fn) {
  try { await fn(); ok++; console.log('  ✓', text); }
  catch (e) { schlecht++; console.log('  ✗', text, '\n      ->', String(e.message).split('\n')[0]); }
}
const gleich = (a, b, was) => { if (a !== b) throw new Error(`${was}: ${a} statt ${b}`); };

async function leere(coll) {
  const s = await db.collection(coll).get();
  for (const d of s.docs) await d.ref.delete();
}

// ══════════════════════════════════════════════════════════════════
console.log('\nDER BEFUND — ein Code ohne expiresAt wird uebersehen');
await leere('accessCodes');

await db.collection('accessCodes').doc('MIT-DATUM-ALT').set({
  code: 'MITALT', teacherUid: 't1', studentId: 's1',
  expiresAt: jetzt - 200 * TAG,            // laengst abgelaufen
  studentSnapshot: { vorname: 'Alt' }, messages: [{ text: 'privat' }],
});
await db.collection('accessCodes').doc('OHNE-DATUM').set({
  code: 'OHNE', teacherUid: 't1', studentId: 's2',
  // KEIN expiresAt - genau der Fall
  studentSnapshot: { vorname: 'Ohne' }, messages: [{ text: 'auch privat' }],
});
await db.collection('accessCodes').doc('MIT-DATUM-FRISCH').set({
  code: 'FRISCH', teacherUid: 't1', studentId: 's3',
  expiresAt: jetzt + 30 * TAG,
  studentSnapshot: { vorname: 'Frisch' }, messages: [],
});

await pruefe('Die bisherige Abfrage findet den Code OHNE expiresAt nicht', async () => {
  const snap = await db.collection('accessCodes')
    .where('expiresAt', '<=', jetzt - 90 * TAG).get();
  const ids = snap.docs.map(d => d.id).sort();
  gleich(ids.join(','), 'MIT-DATUM-ALT', 'gefundene Dokumente');
});

// ══════════════════════════════════════════════════════════════════
console.log('\nDIE BEHEBUNG — Ablaufdatum nachtragen statt loeschen');
// Bewusst NICHT loeschen: Ein Dokument ohne expiresAt hat ein unbekanntes
// Alter. Es koennte ein aktiver Zugang sein, an dem gerade ein Schueler
// haengt. Es bekommt deshalb ein Ablaufdatum und faellt danach ganz normal
// unter die 90-Tage-Regel - niemand wird ausgesperrt, nichts geht verloren.

await pruefe('repariereFehlendeAblaufdaten traegt genau dort nach, wo es fehlt', async () => {
  const anzahl = await repariereFehlendeAblaufdaten(db, jetzt + 14 * TAG);
  gleich(anzahl, 1, 'nachgetragene Dokumente');
});

await pruefe('Der Code ohne Datum hat jetzt eines', async () => {
  const d = await db.collection('accessCodes').doc('OHNE-DATUM').get();
  const v = d.data().expiresAt;
  if (typeof v !== 'number') throw new Error('expiresAt fehlt weiterhin');
  if (v < jetzt) throw new Error('Datum liegt in der Vergangenheit - Schueler waere sofort ausgesperrt');
});

await pruefe('Die Nutzdaten sind unveraendert - nichts ging verloren', async () => {
  const d = (await db.collection('accessCodes').doc('OHNE-DATUM').get()).data();
  gleich(d.code, 'OHNE', 'code');
  gleich(d.studentSnapshot.vorname, 'Ohne', 'Vorname');
  gleich(d.messages.length, 1, 'Nachrichten');
  gleich(d.messages[0].text, 'auch privat', 'Nachrichtentext');
});

await pruefe('Vorhandene Ablaufdaten bleiben unangetastet', async () => {
  const alt = (await db.collection('accessCodes').doc('MIT-DATUM-ALT').get()).data();
  gleich(alt.expiresAt, jetzt - 200 * TAG, 'altes Datum');
  const frisch = (await db.collection('accessCodes').doc('MIT-DATUM-FRISCH').get()).data();
  gleich(frisch.expiresAt, jetzt + 30 * TAG, 'frisches Datum');
});

await pruefe('Ein zweiter Lauf tut nichts mehr (nicht doppelt nachtragen)', async () => {
  const anzahl = await repariereFehlendeAblaufdaten(db, jetzt + 14 * TAG);
  gleich(anzahl, 0, 'beim zweiten Lauf nachgetragen');
});

await pruefe('Nach dem Nachtragen greift die normale 90-Tage-Regel wieder', async () => {
  // Datum kuenstlich in die Vergangenheit setzen, als waere die Frist um.
  await db.collection('accessCodes').doc('OHNE-DATUM')
    .update({ expiresAt: jetzt - 100 * TAG });
  const snap = await db.collection('accessCodes')
    .where('expiresAt', '<=', jetzt - 90 * TAG).get();
  const ids = snap.docs.map(d => d.id).sort();
  gleich(ids.join(','), 'MIT-DATUM-ALT,OHNE-DATUM', 'jetzt gefunden');
});

// ══════════════════════════════════════════════════════════════════
console.log('\nGRENZFAELLE');
await leere('accessCodes');

await pruefe('Leere Sammlung: kein Fehler, nichts nachgetragen', async () => {
  gleich(await repariereFehlendeAblaufdaten(db, jetzt + 14 * TAG), 0, 'Anzahl');
});

await pruefe('expiresAt mit falschem Typ (Text) gilt als fehlend', async () => {
  await db.collection('accessCodes').doc('TEXT-DATUM').set({
    code: 'TXT', teacherUid: 't1', expiresAt: '2026-01-01',
  });
  gleich(await repariereFehlendeAblaufdaten(db, jetzt + 14 * TAG), 1, 'Anzahl');
  const v = (await db.collection('accessCodes').doc('TEXT-DATUM').get()).data().expiresAt;
  if (typeof v !== 'number') throw new Error('immer noch kein Zahlenwert');
});

await pruefe('expiresAt = null gilt als fehlend', async () => {
  await leere('accessCodes');
  await db.collection('accessCodes').doc('NULL-DATUM').set({
    code: 'NUL', teacherUid: 't1', expiresAt: null,
  });
  gleich(await repariereFehlendeAblaufdaten(db, jetzt + 14 * TAG), 1, 'Anzahl');
});

console.log(`\n${ok} bestanden, ${schlecht} fehlgeschlagen\n`);
process.exit(schlecht > 0 ? 1 : 0);
