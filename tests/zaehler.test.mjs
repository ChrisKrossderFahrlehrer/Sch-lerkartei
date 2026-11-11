// Zaehler "gebuchte Fahrstunden" (functions/zaehler.js) - gegen den Emulator.
//
// Der Zaehler steht im Kontingent ("3 / 10") und sperrt bei Erreichen der
// Grenze weitere Terminanfragen. Bis 11/2026 wurde er nur mitgerechnet
// (+1 / -1), wenn sich an einem bestehenden Termin die Buchung aenderte:
//   - ein GELOESCHTER gebuchter Termin zaehlte nie zurueck
//   - ein Termin, der gleich MIT Schueler angelegt wurde (Kartei), zaehlte nie
// Jetzt wird nachgezaehlt. Geprueft wird vor allem, dass der Stand danach
// STIMMT - egal wie falsch er vorher war - und dass fremde Termine den
// Zaehler eines Schuelers nicht hochtreiben koennen.
//
// Starten:  cd tests && npm test   (laeuft in der Emulator-Kette mit)

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const hier = dirname(fileURLToPath(import.meta.url));

// Fest auf den lokalen Rechner - ein Testlauf darf nie echte Daten anfassen.
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8089';
process.env.GCLOUD_PROJECT          = 'fahrsync-zaehler';

const ausFunctions = createRequire(join(hier, '..', 'functions', 'package.json'));
const { initializeApp } = ausFunctions('firebase-admin/app');
const { getFirestore } = ausFunctions('firebase-admin/firestore');
initializeApp({ projectId: 'fahrsync-zaehler' });
const db = getFirestore();

const { buchungenNeuZaehlen, kontingenteNachzaehlen } = require(join(hier, '..', 'functions', 'zaehler.js'));

let ok = 0, schlecht = 0;
async function pruefe(text, fn) {
  try { await fn(); ok++; console.log('  ✓', text); }
  catch (e) { schlecht++; console.log('  ✗', text, '\n      ->', String(e.message).split('\n')[0]); }
}
const gleich = (a, b, was) => { if (a !== b) throw new Error(`${was}: ${a} statt ${b}`); };
const lies = async (p) => (await db.doc(p).get()).data();
const gibts = async (p) => (await db.doc(p).get()).exists;

// Schueler A (Schule S, Fahrlehrer L1): Zaehler steht falsch auf 7.
await db.doc('schueler/a').set({ schoolId: 'S', lehrerUid: 'L1', fname: 'Anna', bookedCount: 7, maxFahrstunden: 10 });
await db.doc('bookingStudents/a').set({ lehrerUid: 'L1', vorname: 'Anna', bookedCount: 7 });
await db.doc('slots/a1').set({ schoolId: 'S', lehrerUid: 'L1', bookedBy: 'a' });
await db.doc('slots/a2').set({ schoolId: 'S', lehrerUid: 'L1', bookedBy: 'a' });
await db.doc('slots/a3').set({ schoolId: 'S', lehrerUid: 'L2', bookedBy: 'a' });        // Kollege, gleiche Schule
await db.doc('slots/frei').set({ schoolId: 'S', lehrerUid: 'L1', bookedBy: null });
// Ein FREMDER traegt in seinem Kalender Termine auf Annas Kennung ein
await db.doc('slots/boese1').set({ schoolId: 'X', lehrerUid: 'boese', bookedBy: 'a' });
await db.doc('slots/boese2').set({ schoolId: 'X', lehrerUid: 'boese', bookedBy: 'a' });
// Schueler B: Solo-Fahrlehrer ohne Schule
await db.doc('schueler/b').set({ schoolId: null, lehrerUid: 'solo', fname: 'Ben', bookedCount: 0, maxFahrstunden: 0 });
await db.doc('slots/b1').set({ schoolId: null, lehrerUid: 'solo', bookedBy: 'b' });
// Schueler C: mit Kontingent, Stand zu hoch (zwei geloeschte Termine)
await db.doc('schueler/c').set({ schoolId: 'S', lehrerUid: 'L1', fname: 'Cem', bookedCount: 5, maxFahrstunden: 5 });
await db.doc('slots/c1').set({ schoolId: 'S', lehrerUid: 'L1', bookedBy: 'c' });
await db.doc('slots/c2').set({ schoolId: 'S', lehrerUid: 'L1', bookedBy: 'c' });
await db.doc('slots/c3').set({ schoolId: 'S', lehrerUid: 'L1', bookedBy: 'c' });
// Schueler D: ohne Kontingent, Stand falsch - die Nacht laesst ihn in Ruhe
await db.doc('schueler/d').set({ schoolId: 'S', lehrerUid: 'L1', fname: 'Dana', bookedCount: 9, maxFahrstunden: 0 });

console.log('\nNACHZAEHLEN — der Stand ist die Zahl der gebuchten Termine');
await pruefe('Falscher Stand (7) wird zur Wahrheit (3)', async () => {
  gleich(await buchungenNeuZaehlen(db, 'a'), 3, 'Rueckgabe');
  gleich((await lies('schueler/a')).bookedCount, 3, 'schueler.bookedCount');
});
await pruefe('Die Buchungsseite bekommt denselben Stand', async () => {
  gleich((await lies('bookingStudents/a')).bookedCount, 3, 'bookingStudents.bookedCount');
});
await pruefe('Termine eines FREMDEN auf diese Kennung zaehlen nicht', async () => {
  await db.doc('slots/boese3').set({ schoolId: 'X', lehrerUid: 'boese', bookedBy: 'a' });
  gleich(await buchungenNeuZaehlen(db, 'a'), 3, 'Stand');
});
await pruefe('Gebuchter Termin GELOESCHT -> zaehlt zurueck', async () => {
  await db.doc('slots/a2').delete();
  gleich(await buchungenNeuZaehlen(db, 'a'), 2, 'Stand');
});
await pruefe('Termin gleich MIT Schueler angelegt (Kartei) -> zaehlt mit', async () => {
  await db.doc('slots/a4').set({ schoolId: 'S', lehrerUid: 'L1', bookedBy: 'a' });
  gleich(await buchungenNeuZaehlen(db, 'a'), 3, 'Stand');
});
await pruefe('Storniert (bookedBy leer) -> zaehlt zurueck', async () => {
  await db.doc('slots/a1').update({ bookedBy: null });
  gleich(await buchungenNeuZaehlen(db, 'a'), 2, 'Stand');
});
await pruefe('Solo-Fahrlehrer ohne Schule: zaehlt ueber den Fahrlehrer', async () => {
  gleich(await buchungenNeuZaehlen(db, 'b'), 1, 'Stand');
});
await pruefe('Stimmt der Stand schon, wird nichts geschrieben', async () => {
  const vorher = (await db.doc('schueler/b').get()).updateTime.toMillis();
  await buchungenNeuZaehlen(db, 'b');
  gleich((await db.doc('schueler/b').get()).updateTime.toMillis(), vorher, 'updateTime');
});

console.log('\nWAS NICHT ENTSTEHEN DARF');
await pruefe('Unbekannter Schueler: kein Dokument wird angelegt', async () => {
  gleich(await buchungenNeuZaehlen(db, 'gibtsnicht'), null, 'Rueckgabe');
  gleich(await gibts('schueler/gibtsnicht'), false, 'schueler angelegt');
  gleich(await gibts('bookingStudents/gibtsnicht'), false, 'bookingStudents angelegt');
});
await pruefe('Schueler ohne Buchungsseite: es entsteht keine (nur mit Zaehler)', async () => {
  gleich(await buchungenNeuZaehlen(db, 'b'), 1, 'Stand');
  gleich(await gibts('bookingStudents/b'), false, 'bookingStudents angelegt');
});
await pruefe('Ungueltige Kennung wird abgewiesen', async () => {
  gleich(await buchungenNeuZaehlen(db, 'a/../b'), null, 'Pfad');
  gleich(await buchungenNeuZaehlen(db, ''), null, 'leer');
  gleich(await buchungenNeuZaehlen(db, null), null, 'null');
});

console.log('\nNAECHTLICHES NACHZAEHLEN — Altbestand mit Kontingent');
await pruefe('Schueler mit Kontingent 5/5, aber nur 3 Terminen -> 3/5 (kann wieder buchen)', async () => {
  const korrigiert = await kontingenteNachzaehlen(db);
  gleich((await lies('schueler/c')).bookedCount, 3, 'Stand');
  if (korrigiert < 1) throw new Error('nichts korrigiert');
});
await pruefe('Schueler OHNE Kontingent bleibt unberuehrt (sperrt nichts)', async () => {
  gleich((await lies('schueler/d')).bookedCount, 9, 'Stand');
});
await pruefe('Zweiter Lauf korrigiert nichts mehr', async () => {
  gleich(await kontingenteNachzaehlen(db), 0, 'korrigiert');
});

console.log(`\n${ok} bestanden, ${schlecht} fehlgeschlagen\n`);
process.exit(schlecht > 0 ? 1 : 0);
