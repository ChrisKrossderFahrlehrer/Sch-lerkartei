// Papierkorb im Archiv (functions/papierkorb.js) - gegen den Emulator.
//
// Geloeschte Schueler bleiben 90 Tage wiederherstellbar. Geprueft wird vor
// allem, was NICHT passieren darf:
//   - dass der Portal-Zugang offen bleibt, wenn ein KOLLEGE loescht
//   - dass Wiederherstellen einen laengst abgelaufenen Code wieder oeffnet
//   - dass vor Ablauf der 90 Tage oder nach dem Wiederherstellen etwas
//     geloescht wird
//   - dass beim endgueltigen Loeschen Chat oder Protokoll eines anderen
//     Fahrlehrers liegen bleiben, oder ein anderer Schueler etwas verliert
//
// Starten:  cd tests && npm test   (laeuft in der Emulator-Kette mit)

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const hier = dirname(fileURLToPath(import.meta.url));

// Fest auf den lokalen Rechner - ein Testlauf darf nie echte Daten anfassen.
process.env.FIRESTORE_EMULATOR_HOST        = '127.0.0.1:8089';
process.env.STORAGE_EMULATOR_HOST          = 'http://127.0.0.1:9199';
process.env.FIREBASE_STORAGE_EMULATOR_HOST = '127.0.0.1:9199';
process.env.GCLOUD_PROJECT                 = 'fahrsync-papierkorb';

const ausFunctions = createRequire(join(hier, '..', 'functions', 'package.json'));
const { initializeApp } = ausFunctions('firebase-admin/app');
const { getFirestore } = ausFunctions('firebase-admin/firestore');
initializeApp({ projectId: 'fahrsync-papierkorb' });
const db = getFirestore();

const { papierkorbAenderung, papierkorbLeeren, PAPIERKORB_TAGE } =
  require(join(hier, '..', 'functions', 'papierkorb.js'));

const TAG = 86400000;
const T0 = Date.UTC(2026, 9, 1, 10, 0, 0);

let ok = 0, schlecht = 0;
async function pruefe(text, fn) {
  try { await fn(); ok++; console.log('  ✓', text); }
  catch (e) { schlecht++; console.log('  ✗', text, '\n      ->', String(e.message).split('\n')[0]); }
}
const gleich = (a, b, was) => { if (a !== b) throw new Error(`${was}: ${a} statt ${b}`); };
const lies = async (p) => (await db.doc(p).get()).data();
const gibts = async (p) => (await db.doc(p).get()).exists;

// Hilfsfunktion wie im Trigger: Dokument aendern, dann reagieren
async function aendere(id, felder, jetzt) {
  const vorher = await lies(`students/${id}`);
  await db.doc(`students/${id}`).update(felder);
  const nachher = await lies(`students/${id}`);
  return papierkorbAenderung(db, id, vorher, nachher, jetzt);
}
const LOESCHEN = (jetzt) => ({ archiviert: true, archiviertAm: jetzt, archivGrund: 'geloescht', geloeschtAm: jetzt });

// Schueler A: Code von Lehrer B (nicht vom Loeschenden), ein zweiter, schon
// abgelaufener Code, ein Protokolleintrag. Schueler N: Nachbar, bleibt heil.
await db.doc('students/a').set({ uid: 'lehrerB', fahrschuleId: 'schule', vorname: 'Anna' });
await db.doc('students/n').set({ uid: 'lehrerB', fahrschuleId: 'schule', vorname: 'Nils' });
await db.doc('accessCodes/CODEA1').set({ studentId: 'a', teacherUid: 'lehrerB', expiresAt: T0 + 200 * TAG, messages: [{ text: 'Hallo' }] });
await db.doc('accessCodes/CODEA2').set({ studentId: 'a', teacherUid: 'lehrerB', expiresAt: T0 - 5 * TAG });
await db.doc('accessCodes/CODEN1').set({ studentId: 'n', teacherUid: 'lehrerB', expiresAt: T0 + 200 * TAG });
await db.doc('protokoll/pa').set({ studentId: 'a', uid: 'lehrerB', text: 'Stunde 1' });
await db.doc('protokoll/pn').set({ studentId: 'n', uid: 'lehrerB', text: 'Stunde 1' });

console.log('\nLOESCHEN SPERRT DAS PORTAL');
await pruefe('Gewoehnliches Speichern -> keine Reaktion', async () => {
  gleich(await aendere('a', { fahrstunden: 3 }, T0), 'nichts', 'Ergebnis');
  gleich((await lies('accessCodes/CODEA1')).expiresAt, T0 + 200 * TAG, 'Code A1');
});
await pruefe('Loeschen (durch Kollegen) -> Code von Lehrer B sofort abgelaufen', async () => {
  gleich(await aendere('a', { ...LOESCHEN(T0), geloeschtVon: 'inhaberA' }, T0), 'gesperrt', 'Ergebnis');
  gleich((await lies('accessCodes/CODEA1')).expiresAt, T0, 'Code A1');
});
await pruefe('Schon abgelaufener Code bleibt unveraendert', async () => {
  gleich((await lies('accessCodes/CODEA2')).expiresAt, T0 - 5 * TAG, 'Code A2');
});
await pruefe('Vorherige Ablaufzeiten gemerkt (nur der gueltige Code)', async () => {
  const v = (await lies('students/a')).portalAblaufVorher;
  gleich(v.CODEA1, T0 + 200 * TAG, 'A1');
  gleich('CODEA2' in v, false, 'A2 gemerkt');
});
await pruefe('Nachbar-Schueler bleibt offen', async () => {
  gleich((await lies('accessCodes/CODEN1')).expiresAt, T0 + 200 * TAG, 'Code N1');
});
await pruefe('Erneutes Speichern am Geloeschten -> keine zweite Sperre', async () => {
  gleich(await aendere('a', { notiz: 'x' }, T0 + TAG), 'nichts', 'Ergebnis');
});

console.log('\nWIEDERHERSTELLEN');
await pruefe('Wiederherstellen -> alte Ablaufzeit zurueck', async () => {
  gleich(await aendere('a', { archiviert: false, archiviertAm: null, archivGrund: null, geloeschtAm: null }, T0 + 2 * TAG), 'freigegeben', 'Ergebnis');
  gleich((await lies('accessCodes/CODEA1')).expiresAt, T0 + 200 * TAG, 'Code A1');
});
await pruefe('Vorher abgelaufener Code bleibt abgelaufen', async () => {
  gleich((await lies('accessCodes/CODEA2')).expiresAt, T0 - 5 * TAG, 'Code A2');
});
await pruefe('Merkfelder wieder entfernt', async () => {
  const d = await lies('students/a');
  gleich('portalAblaufVorher' in d, false, 'portalAblaufVorher');
  gleich('portalGesperrtAm' in d, false, 'portalGesperrtAm');
});
await pruefe('Protokoll und Chat sind noch da', async () => {
  gleich(await gibts('protokoll/pa'), true, 'Protokoll');
  gleich((await lies('accessCodes/CODEA1')).messages.length, 1, 'Chat');
});

console.log(`\nNACH ${PAPIERKORB_TAGE} TAGEN`);
await db.doc('students/alt').set({ uid: 'lehrerB', vorname: 'Alt', ...LOESCHEN(T0 - 91 * TAG) });
await db.doc('accessCodes/CODEALT').set({ studentId: 'alt', teacherUid: 'lehrerC', expiresAt: T0 - 91 * TAG });
await db.doc('protokoll/palt').set({ studentId: 'alt', uid: 'lehrerC', text: 'x' });
await db.doc('students/frisch').set({ uid: 'lehrerB', vorname: 'Frisch', ...LOESCHEN(T0 - 89 * TAG) });
await db.doc('students/ohneDatum').set({ uid: 'lehrerB', vorname: 'OhneDatum', archiviert: true, archivGrund: 'geloescht', archiviertAm: T0 - 100 * TAG });
await db.doc('students/fertig').set({ uid: 'lehrerB', vorname: 'Fertig', archiviert: true, archiviertAm: T0 - 400 * TAG });
await pruefe('Leeren: nur ueber 90 Tage Geloeschte', async () => {
  gleich(await papierkorbLeeren(db, T0), 2, 'Anzahl');
});
await pruefe('91 Tage -> weg, samt Code und Protokoll eines anderen Lehrers', async () => {
  gleich(await gibts('students/alt'), false, 'Schueler');
  gleich(await gibts('accessCodes/CODEALT'), false, 'Code');
  gleich(await gibts('protokoll/palt'), false, 'Protokoll');
});
await pruefe('Ohne geloeschtAm zaehlt archiviertAm (bleibt nicht ewig liegen)', async () => {
  gleich(await gibts('students/ohneDatum'), false, 'Schueler');
});
await pruefe('89 Tage -> bleibt', async () => { gleich(await gibts('students/frisch'), true, 'Schueler'); });
await pruefe('Fertige (bestanden) bleiben, egal wie alt', async () => { gleich(await gibts('students/fertig'), true, 'Schueler'); });
await pruefe('Wiederhergestellter Schueler bleibt', async () => { gleich(await gibts('students/a'), true, 'Schueler'); });

console.log('\nENDGUELTIG LOESCHEN AUF WUNSCH');
await pruefe('sofortLoeschen ohne Papierkorb wird ignoriert', async () => {
  gleich(await aendere('n', { sofortLoeschen: true }, T0), 'nichts', 'Ergebnis');
  gleich(await gibts('students/n'), true, 'Nachbar');
  await db.doc('students/n').update({ sofortLoeschen: false });
});
await pruefe('Loeschen + sofortLoeschen -> alles von A weg', async () => {
  await aendere('a', LOESCHEN(T0), T0);
  gleich(await aendere('a', { sofortLoeschen: true }, T0), 'endgueltig', 'Ergebnis');
  gleich(await gibts('students/a'), false, 'Schueler');
  gleich(await gibts('accessCodes/CODEA1'), false, 'Code A1');
  gleich(await gibts('accessCodes/CODEA2'), false, 'Code A2');
  gleich(await gibts('protokoll/pa'), false, 'Protokoll');
});
await pruefe('Nachbar N hat nichts verloren', async () => {
  gleich(await gibts('students/n'), true, 'Schueler');
  gleich(await gibts('accessCodes/CODEN1'), true, 'Code');
  gleich(await gibts('protokoll/pn'), true, 'Protokoll');
  gleich((await lies('accessCodes/CODEN1')).expiresAt, T0 + 200 * TAG, 'Ablauf');
});

console.log(`\n${ok} bestanden, ${schlecht} fehlgeschlagen`);
process.exit(schlecht ? 1 : 0);
