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
// Auth zwingend auf den Emulator: loescheAlteAnonymeKonten ruft
// deleteUser(). Ohne diese Zeile wuerde ein Testlauf ECHTE Konten treffen.
process.env.FIREBASE_AUTH_EMULATOR_HOST = '127.0.0.1:9099';
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'fahrsync-aufraeumen';

// Bewusst aus functions/: Der Test soll GENAU die firebase-admin-Fassung
// benutzen, die auch deployt wird - nicht eine andere aus tests/.
//
// Verankert ueber die package.json von functions/, NICHT ueber einen
// zusammengesetzten Dateipfad: Seit Version 14 gibt firebase-admin seine
// Unterpfade ueber die "exports"-Tabelle frei, und die greift nur bei
// Paketnamen. Ein Pfad wie '<...>/firebase-admin/app' laeuft daran vorbei
// und findet nichts.
const ausFunctions = createRequire(join(hier, '..', 'functions', 'package.json'));
const { initializeApp } = ausFunctions('firebase-admin/app');
const { getFirestore } = ausFunctions('firebase-admin/firestore');
const { getAuth } = ausFunctions('firebase-admin/auth');
initializeApp({ projectId: process.env.GCLOUD_PROJECT });
const db = getFirestore();

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

// ══════════════════════════════════════════════════════════════════
// ANONYME SITZUNGEN DES SCHUELER-PORTALS
//
// Das Portal meldet sich bei jedem Besuch anonym an - und bisher wurde nie
// ein solches Konto wieder entfernt. Die eigentliche Gefahr beim Beheben ist
// nicht, zu wenig zu loeschen, sondern ZU VIEL: Ein versehentlich geloeschtes
// Fahrlehrer-Konto waere nicht wiederherstellbar. Darauf zielen die meisten
// Pruefungen hier.
console.log('\nANONYME SITZUNGEN — aufraeumen, aber nur die richtigen');

const auth = getAuth();
const { loescheAlteAnonymeKonten, istAnonymesKonto } =
  require(join(hier, '..', 'functions', 'loeschen.js'));

const TAG_MS = 86400000;

async function leereAuth() {
  let marke;
  do {
    const s = await auth.listUsers(1000, marke);
    for (const u of s.users) await auth.deleteUser(u.uid).catch(() => {});
    marke = s.pageToken;
  } while (marke);
}
await leereAuth();

// Der Emulator setzt creationTime/lastSignInTime auf JETZT. Ein wirklich
// altes Konto laesst sich darueber nicht erzeugen - deshalb wird die Zeit
// stattdessen ueber den 'jetzt'-Parameter vorgespult. Das prueft dieselbe
// Rechnung und kommt ohne Zeitreise aus.
const spaeter = Date.now() + 100 * TAG_MS;

await auth.createUser({ uid: 'anon-alt-1' });
await auth.createUser({ uid: 'anon-alt-2' });
await auth.createUser({ uid: 'lehrer-1', email: 'lehrer@fahrschule.de', password: 'geheim123' });
await auth.createUser({ uid: 'lehrer-2', email: 'zweiter@fahrschule.de', password: 'geheim123' });
await auth.createUser({ uid: 'mit-telefon', phoneNumber: '+4915112345678' });

await pruefe('Ein Konto ohne Anbieter/E-Mail/Telefon gilt als anonym', async () => {
  const n = await auth.getUser('anon-alt-1');
  if (!istAnonymesKonto(n)) throw new Error('wurde nicht als anonym erkannt');
});

await pruefe('Ein Fahrlehrer-Konto gilt NICHT als anonym', async () => {
  for (const uid of ['lehrer-1', 'lehrer-2']) {
    const n = await auth.getUser(uid);
    if (istAnonymesKonto(n)) throw new Error(uid + ' faelschlich als anonym erkannt');
  }
});

await pruefe('Ein Konto mit Telefonnummer gilt NICHT als anonym', async () => {
  const n = await auth.getUser('mit-telefon');
  if (istAnonymesKonto(n)) throw new Error('faelschlich als anonym erkannt');
});

await pruefe('Frische anonyme Sitzungen werden NICHT angefasst', async () => {
  const weg = await loescheAlteAnonymeKonten(auth, 60 * TAG_MS, 500, Date.now());
  gleich(weg, 0, 'geloeschte Konten');
  await auth.getUser('anon-alt-1');   // wirft, wenn geloescht
});

await pruefe('Nach 100 Tagen ohne Aktivitaet sind die anonymen Sitzungen weg', async () => {
  const weg = await loescheAlteAnonymeKonten(auth, 60 * TAG_MS, 500, spaeter);
  gleich(weg, 2, 'geloeschte Konten');
});

await pruefe('GEGENPROBE: die Fahrlehrer-Konten stehen noch', async () => {
  for (const uid of ['lehrer-1', 'lehrer-2', 'mit-telefon']) {
    const n = await auth.getUser(uid);         // wirft, wenn geloescht
    if (!n) throw new Error(uid + ' fehlt');
  }
});

await pruefe('Die Obergrenze je Lauf wird eingehalten', async () => {
  for (let i = 0; i < 7; i++) await auth.createUser({ uid: 'anon-menge-' + i });
  const weg = await loescheAlteAnonymeKonten(auth, 60 * TAG_MS, 3, spaeter);
  if (weg > 3) throw new Error(`${weg} geloescht, erlaubt waren 3`);
});

await pruefe('Ein zweiter Lauf raeumt den Rest ab', async () => {
  const weg = await loescheAlteAnonymeKonten(auth, 60 * TAG_MS, 500, spaeter);
  const uebrig = (await auth.listUsers(1000)).users.filter(istAnonymesKonto);
  gleich(uebrig.length, 0, 'uebrige anonyme Konten');
  if (weg < 1) throw new Error('zweiter Lauf hat nichts getan');
});

await pruefe('Am Ende sind GENAU die drei echten Konten uebrig', async () => {
  const alle = (await auth.listUsers(1000)).users.map(u => u.uid).sort();
  gleich(alle.join(','), 'lehrer-1,lehrer-2,mit-telefon', 'verbliebene Konten');
});

console.log(`\n${ok} bestanden, ${schlecht} fehlgeschlagen\n`);
process.exit(schlecht > 0 ? 1 : 0);
