// Umfang der Kontoloeschung - gegen den Emulator, mit dem ECHTEN Modul.
//
// Hier wird functions/loeschen.js wirklich ausgefuehrt, kein Nachbau. Das ist
// Absicht: Ein Fehler faellt an dieser Stelle nicht auf, er vernichtet Daten,
// und zwar unwiederbringlich.
//
// Der Befund, um den es geht: uebernehmeSchuelerInFahrschule setzt beim
// Uebergeben nur das Zuordnungsfeld (fahrschuleId bzw. schoolId) auf die
// Fahrschule um. Das Besitzerfeld (uid bzw. lehrerUid) zeigt weiterhin auf den
// Fahrlehrer, der den Datensatz angelegt hat. Geloescht wurde bisher aber
// allein ueber das Besitzerfeld - ein Fahrlehrer, der seine Schueler an die
// Fahrschule uebergeben hatte und danach sein Konto loeschte, nahm Schueler,
// Protokoll, eigene Themen und die Kalenderdaten der FAHRSCHULE mit.
//
// Starten:  cd tests && npm run test:loeschen

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const hier = dirname(fileURLToPath(import.meta.url));

// SICHERHEIT: loescheKontoHart ruft getAuth().deleteUser() und
// admin.storage().deleteFiles() auf. Ohne diese beiden Zeilen wuerde das Modul
// versuchen, die ECHTE Firebase-Instanz zu erreichen. Beides wird hier fest
// auf den lokalen Rechner gelenkt, damit ein Testlauf unter keinen Umstaenden
// echte Konten oder Dateien anfassen kann.
process.env.FIRESTORE_EMULATOR_HOST       = '127.0.0.1:8089';
process.env.FIREBASE_AUTH_EMULATOR_HOST   = '127.0.0.1:9099';
process.env.STORAGE_EMULATOR_HOST         = '127.0.0.1:9199';
process.env.FIREBASE_STORAGE_EMULATOR_HOST = '127.0.0.1:9199';
process.env.GCLOUD_PROJECT                = 'fahrsync-loeschen';

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
initializeApp({ projectId: 'fahrsync-loeschen' });
const db = getFirestore();

const { loescheKontoHart, gehoertNochDemKonto } = require(join(hier, '..', 'functions', 'loeschen.js'));

const SCHULE = 'schule-uid';
const LEHRER = 'lehrer-uid';    // Mitglied der Schule
const SOLO   = 'solo-uid';      // eigenstaendiger Fahrlehrer, keine Schule

let bestanden = 0, fehlgeschlagen = 0;
async function pruefe(text, fn) {
  try { await fn(); bestanden++; console.log('  ✓', text); }
  catch (e) { fehlgeschlagen++; console.log('  ✗', text, '\n      ->', String(e.message).split('\n')[0]); }
}
const da    = async (pfad) => (await db.doc(pfad).get()).exists;
const muss  = async (pfad) => { if (!(await da(pfad))) throw new Error(pfad + ' wurde GELOESCHT, haette bleiben muessen'); };
const wegSein = async (pfad) => { if (await da(pfad)) throw new Error(pfad + ' steht noch da, haette geloescht werden muessen'); };

async function lageAufbauen() {
  const b = db.batch();
  b.set(db.doc(`users/${SCHULE}`), { uid: SCHULE, rolle: 'fahrschul-admin', typ: 'fahrschule', fahrschuleId: SCHULE });
  b.set(db.doc(`users/${LEHRER}`), { uid: LEHRER, rolle: 'fahrlehrer', typ: 'fahrlehrer', fahrschuleId: SCHULE });
  b.set(db.doc(`users/${SOLO}`),   { uid: SOLO,   rolle: 'fahrlehrer', typ: 'fahrlehrer', fahrschuleId: SOLO });

  // ── An die Fahrschule UEBERGEBEN: uid bleibt beim Lehrer, fahrschuleId zeigt
  //    auf die Schule. Das muss die Loeschung in Ruhe lassen.
  b.set(db.doc('students/uebergeben-1'), { uid: LEHRER, fahrschuleId: SCHULE, vorname: 'Lena', fahrstunden: 24 });
  b.set(db.doc('students/uebergeben-2'), { uid: LEHRER, fahrschuleId: SCHULE, vorname: 'Jonas' });
  b.set(db.doc('protokoll/prot-schule'), { uid: LEHRER, fahrschuleId: SCHULE, notiz: 'Autobahn geuebt.' });
  b.set(db.doc('customThemen/ct-schule'), { uid: LEHRER, fahrschuleId: SCHULE, name: 'Anhaenger rangieren' });
  b.set(db.doc('schueler/kal-schule'),   { lehrerUid: LEHRER, schoolId: SCHULE, fname: 'Lena' });
  b.set(db.doc('slots/slot-schule'),     { lehrerUid: LEHRER, schoolId: SCHULE, bookedBy: 'kal-schule' });

  // ── NOCH NICHT uebergeben: gehoert weiterhin dem Lehrer selbst.
  b.set(db.doc('students/eigen-1'),      { uid: LEHRER, fahrschuleId: LEHRER, vorname: 'Mia' });
  b.set(db.doc('schueler/kal-eigen'),    { lehrerUid: LEHRER, schoolId: LEHRER, fname: 'Mia' });
  // customFields fuehrt gar keine fahrschuleId - muss trotzdem mitgehen.
  b.set(db.doc('customFields/feld-eigen'), { uid: LEHRER, name: 'Fuehrerscheinstelle' });

  // ── Daten der Fahrschule, die ein ANDERER angelegt hat.
  b.set(db.doc('students/schul-eigen'),  { uid: SCHULE, fahrschuleId: SCHULE, vorname: 'Tom' });

  // ── Eigenstaendiger Fahrlehrer: bei ihm muss WEITERHIN alles verschwinden.
  b.set(db.doc('students/solo-1'),       { uid: SOLO, fahrschuleId: SOLO, vorname: 'Ben' });
  b.set(db.doc('protokoll/prot-solo'),   { uid: SOLO, fahrschuleId: SOLO, notiz: 'Erste Stunde' });
  b.set(db.doc('customFields/feld-solo'), { uid: SOLO, name: 'Notizfeld' });
  b.set(db.doc('schueler/kal-solo'),     { lehrerUid: SOLO, schoolId: SOLO, fname: 'Ben' });
  await b.commit();
}

await lageAufbauen();

// ══════════════════════════════════════════════════════════════════
console.log('\nEIN MITGLIED LOESCHT SEIN KONTO — die Fahrschule behaelt ihre Daten');
const bericht = await loescheKontoHart(LEHRER);
console.log('  Bericht:', JSON.stringify(bericht));

await pruefe('Uebergebener Schueler "Lena" bleibt bei der Fahrschule',   () => muss('students/uebergeben-1'));
await pruefe('Uebergebener Schueler "Jonas" bleibt bei der Fahrschule',  () => muss('students/uebergeben-2'));
await pruefe('Protokoll der Fahrschule bleibt',                          () => muss('protokoll/prot-schule'));
await pruefe('Eigenes Thema der Fahrschule bleibt',                      () => muss('customThemen/ct-schule'));
await pruefe('Kalender-Schueler der Fahrschule bleibt',                  () => muss('schueler/kal-schule'));
await pruefe('Kalender-Termin der Fahrschule bleibt',                    () => muss('slots/slot-schule'));
await pruefe('Schueler eines anderen Kollegen bleibt unberuehrt',        () => muss('students/schul-eigen'));

await pruefe('NICHT uebergebener eigener Schueler geht mit',             () => wegSein('students/eigen-1'));
await pruefe('NICHT uebergebener Kalender-Schueler geht mit',            () => wegSein('schueler/kal-eigen'));
await pruefe('Eigenes Zusatzfeld OHNE fahrschuleId geht mit',            () => wegSein('customFields/feld-eigen'));
await pruefe('Das Nutzerprofil des Lehrers ist weg',                     () => wegSein(`users/${LEHRER}`));

// ══════════════════════════════════════════════════════════════════
console.log('\nEIN EIGENSTAENDIGER FAHRLEHRER LOESCHT — bei ihm geht ALLES');
await loescheKontoHart(SOLO);

await pruefe('Sein Schueler ist weg',        () => wegSein('students/solo-1'));
await pruefe('Sein Protokoll ist weg',       () => wegSein('protokoll/prot-solo'));
await pruefe('Sein Zusatzfeld ist weg',      () => wegSein('customFields/feld-solo'));
await pruefe('Sein Kalender-Schueler ist weg', () => wegSein('schueler/kal-solo'));
await pruefe('Sein Nutzerprofil ist weg',    () => wegSein(`users/${SOLO}`));

// ══════════════════════════════════════════════════════════════════
console.log('\nDIE FAHRSCHULE SELBST LOESCHT — dann geht die ganze Schule');
await loescheKontoHart(SCHULE);

await pruefe('Uebergebener Schueler geht jetzt mit',   () => wegSein('students/uebergeben-1'));
await pruefe('Protokoll der Fahrschule geht jetzt mit', () => wegSein('protokoll/prot-schule'));
await pruefe('Kalender-Schueler geht jetzt mit',       () => wegSein('schueler/kal-schule'));
await pruefe('Kalender-Termin geht jetzt mit',         () => wegSein('slots/slot-schule'));
await pruefe('Nutzerprofil der Fahrschule ist weg',    () => wegSein(`users/${SCHULE}`));

// ══════════════════════════════════════════════════════════════════
// Bis hierher hatte KEINE Sammlung mehr als 400 Dokumente - die
// Blaetter-Schleife in loescheAlle lief also immer nur einen Durchgang und
// startAfter() wurde nie ausgefuehrt. Genau dort sitzt aber die Gefahr:
// Bleibt etwas stehen (gehoert der Fahrschule) und wuerde immer wieder der
// ERSTE Block geholt, saehe der gleich aus und die Schleife liefe endlos,
// bis die Cloud Function nach 540 s abgeschossen wird. Eine grosse
// Fahrschule loest das aus, eine kleine nie.
// ══════════════════════════════════════════════════════════════════
console.log('\nGROSSE MENGEN — mehr als ein Block (400), mit und ohne Rest');

const GROSS = 'gross-uid', GROSS_SCHULE = 'gross-schule-uid';
await pruefe('450 eigene + 450 uebergebene Schueler: nur die eigenen gehen', async () => {
  const anlegen = async (von, bis, machen) => {
    for (let i = von; i < bis; i += 400) {
      const b = db.batch();
      for (let j = i; j < Math.min(i + 400, bis); j++) machen(b, j);
      await b.commit();
    }
  };
  await db.doc(`users/${GROSS}`).set({ uid: GROSS, rolle: 'fahrlehrer', typ: 'fahrlehrer', fahrschuleId: GROSS_SCHULE });
  await anlegen(0, 450, (b, j) => b.set(db.doc(`students/gross-eigen-${j}`),
    { uid: GROSS, fahrschuleId: GROSS, vorname: 'Eigen' + j }));
  await anlegen(0, 450, (b, j) => b.set(db.doc(`students/gross-schule-${j}`),
    { uid: GROSS, fahrschuleId: GROSS_SCHULE, vorname: 'Schule' + j }));

  // Laeuft das hier nicht durch, haengt die Schleife - der Test wuerde
  // hier stehenbleiben statt durchzufallen. Deshalb eine harte Zeitgrenze.
  const abbruch = new Promise((_, nein) =>
    setTimeout(() => nein(new Error('loescheKontoHart haengt (Endlosschleife?)')), 60000));
  await Promise.race([loescheKontoHart(GROSS), abbruch]);

  const eigen  = await db.collection('students').where('uid', '==', GROSS)
                         .where('fahrschuleId', '==', GROSS).get();
  const schule = await db.collection('students').where('uid', '==', GROSS)
                         .where('fahrschuleId', '==', GROSS_SCHULE).get();
  if (eigen.size !== 0)    throw new Error(`${eigen.size} eigene Schueler blieben stehen`);
  if (schule.size !== 450) throw new Error(`nur noch ${schule.size} von 450 Schuelern der Fahrschule`);
});

// Der naechtliche Job raeumt ueber UNGLEICHHEITEN auf ("aelter als 90 Tage").
// Dabei sortiert Firestore implizit erst nach dem Ungleichheitsfeld und dann
// erst nach der Dokument-Kennung - startAfter() muss beides bedienen. Geht es
// schief, faellt das nicht als Ausfall auf: taeglichesAufraeumen faengt jeden
// Abschnitt einzeln ab, der Job laeuft weiter und raeumt nur still nicht mehr
// auf. Deshalb hier mit mehr als einem Block nachgestellt.
await pruefe('Aufraeumen ueber eine Ungleichheit blaettert korrekt (450 Eintraege)', async () => {
  const { loescheAlle } = require(join(hier, '..', 'functions', 'loeschen.js'));
  const alt = Date.now() - 100 * 24 * 3600 * 1000;
  for (let i = 0; i < 450; i += 400) {
    const b = db.batch();
    for (let j = i; j < Math.min(i + 400, 450); j++) {
      b.set(db.doc(`passwordResets/alt-${j}`), { createdAt: alt + j, email: `a${j}@test.de` });
    }
    await b.commit();
  }
  await db.doc('passwordResets/frisch').set({ createdAt: Date.now(), email: 'neu@test.de' });

  const abbruch = new Promise((_, nein) =>
    setTimeout(() => nein(new Error('loescheAlle haengt bei der Ungleichheit')), 60000));
  const anzahl = await Promise.race([
    loescheAlle(db.collection('passwordResets').where('createdAt', '<=', Date.now() - 30 * 24 * 3600 * 1000)),
    abbruch,
  ]);
  if (anzahl !== 450) throw new Error(`${anzahl} statt 450 geloescht`);
  if (!(await da('passwordResets/frisch'))) throw new Error('der frische Eintrag wurde mitgeloescht');
});

// ══════════════════════════════════════════════════════════════════
console.log('\nDIE BESITZFRAGE FUER SICH GENOMMEN');
const gehoert = (doc, feld, uid) => gehoertNochDemKonto(uid, feld)({ get: (f) => doc[f] });
await pruefe('Ohne Zuordnungsfeld gehoert der Datensatz dem Konto', async () => {
  if (!gehoert({ uid: 'a' }, 'fahrschuleId', 'a')) throw new Error('haette "ja" sein muessen');
});
await pruefe('Zuordnung auf das Konto selbst = gehoert dem Konto', async () => {
  if (!gehoert({ fahrschuleId: 'a' }, 'fahrschuleId', 'a')) throw new Error('haette "ja" sein muessen');
});
await pruefe('Zuordnung auf eine Fahrschule = gehoert NICHT mehr dem Konto', async () => {
  if (gehoert({ fahrschuleId: 'schule' }, 'fahrschuleId', 'a')) throw new Error('haette "nein" sein muessen');
});

console.log(`\n${bestanden} bestanden, ${fehlgeschlagen} fehlgeschlagen\n`);
process.exit(fehlgeschlagen > 0 ? 1 : 0);
