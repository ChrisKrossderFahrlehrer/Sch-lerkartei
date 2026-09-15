// Nachweis fuer drei Befunde aus dem Sicherheits-Audit.
//
// Diese Datei behauptet nichts, sie PROBIERT es aus. Jeder Test beschreibt
// das Verhalten, das der Angreifer haette - laeuft er durch, existiert die
// Luecke wirklich. Nach dem Schliessen muessen diese Tests umschlagen; die
// erwartete Richtung steht jeweils im Namen.
//
// Starten:  cd tests && npm run test:audit

import {
  initializeTestEnvironment, assertSucceeds, assertFails,
} from '@firebase/rules-unit-testing';
import { doc, getDoc, setDoc, updateDoc, deleteDoc } from 'firebase/firestore';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const REGELN = process.env.REGELN
  || join(dirname(fileURLToPath(import.meta.url)), '..', 'firestore.rules');

const SCHULE  = 'schule-uid';
const LEHRER  = 'lehrer-uid';
const FREMD   = 'fremder-uid';
const CODE     = 'K7M4PQ';              // 6 Zeichen - so lang sind die echten
const IN_EINEM_JAHR = Date.now() + 365 * 24 * 3600 * 1000;

const testEnv = await initializeTestEnvironment({
  projectId: 'fahrsync-audit',
  firestore: {
    rules: readFileSync(REGELN, 'utf8'),
    host: '127.0.0.1',
    port: 8089,
  },
});

await testEnv.withSecurityRulesDisabled(async (ctx) => {
  const db = ctx.firestore();
  await setDoc(doc(db, 'fahrschulen', SCHULE), {
    name: 'Schule', adminUid: SCHULE, typ: 'fahrschule', status: 'aktiv',
    fahrschulCode: 'FS-AAAA', abo: 'free',
  });
  await setDoc(doc(db, 'users', SCHULE), {
    uid: SCHULE, rolle: 'fahrschul-admin', typ: 'fahrschule',
    status: 'aktiv', fahrschuleId: SCHULE,
  });
  // Der Lehrer ist AUSGETRETEN: seine fahrschuleId zeigt wieder auf ihn selbst.
  await setDoc(doc(db, 'users', LEHRER), {
    uid: LEHRER, rolle: 'fahrlehrer', typ: 'fahrlehrer',
    status: 'aktiv', fahrschuleId: LEHRER,
  });
  await setDoc(doc(db, 'users', FREMD), {
    uid: FREMD, rolle: 'fahrlehrer', typ: 'fahrlehrer',
    status: 'aktiv', fahrschuleId: FREMD,
  });
  // Schueler wurde per uebernehmeSchuelerInFahrschule an die Schule uebergeben:
  // fahrschuleId zeigt auf die Schule, uid steht noch auf dem alten Lehrer.
  await setDoc(doc(db, 'students', 'uebernommener-schueler'), {
    uid: LEHRER, fahrschuleId: SCHULE,
    vorname: 'Lena', nachname: 'Mertens', fahrstunden: 24,
    uebernommenVon: LEHRER, uebernommenAm: Date.now(),
  });
  // Ein gueltiger Zugangscode, Dokument-ID = Code (so legt die App ihn an)
  await setDoc(doc(db, 'accessCodes', CODE), {
    code: CODE, studentId: 'uebernommener-schueler', teacherUid: LEHRER,
    vorname: 'Lena', nachname: 'Mertens', klasse: 'B', fahrstunden: 24,
    themen: { 'Einparken längs (rückwärts)': 4 },
    messages: [{ text: 'Bis Mittwoch!', sender: 'schueler', timestamp: Date.now() }],
    expiresAt: IN_EINEM_JAHR,
  });
});

const ohneAnmeldung = () => testEnv.unauthenticatedContext().firestore();
const als = (uid) => testEnv.authenticatedContext(uid, { email: `${uid}@test.de` }).firestore();

let bestanden = 0, fehlgeschlagen = 0;
async function pruefe(beschreibung, fn) {
  try { await fn(); bestanden++; console.log('  ✓', beschreibung); }
  catch (e) { fehlgeschlagen++; console.log('  ✗', beschreibung, '\n      ->', String(e.message).split('\n')[0]); }
}

// ══════════════════════════════════════════════════════════════════
console.log('\nBEFUND 1 — Zugangscode-Dokument ohne jede Anmeldung lesbar');
console.log('  (Dokument-ID = 6-stelliger Code, Leseregel verlangt nur "nicht abgelaufen")');

await pruefe('OHNE Anmeldung die komplette Schuelerakte lesen ist MOEGLICH', async () => {
  const db = ohneAnmeldung();
  const snap = await assertSucceeds(getDoc(doc(db, 'accessCodes', CODE)));
  const d = snap.data();
  if (!d || d.nachname !== 'Mertens') throw new Error('Daten kamen nicht durch');
  console.log('      gelesen:', d.vorname, d.nachname,
              '· Stunden', d.fahrstunden,
              '· Nachrichten', (d.messages || []).length);
});

await pruefe('OHNE Anmeldung in den Chat schreiben ist MOEGLICH', async () => {
  const db = ohneAnmeldung();
  await assertSucceeds(updateDoc(doc(db, 'accessCodes', CODE), {
    messages: [{ text: 'Untergeschobene Nachricht', sender: 'schueler', timestamp: Date.now() }],
  }));
});

await pruefe('Ein FREMDER Fahrlehrer kann das Code-Dokument ebenfalls lesen', async () => {
  const db = als(FREMD);
  await assertSucceeds(getDoc(doc(db, 'accessCodes', CODE)));
});

// ══════════════════════════════════════════════════════════════════
console.log('\nBEFUND 2 — Ausgetretener Lehrer behaelt Zugriff auf Schueler der Schule');
console.log('  (docBelongsToUser erlaubt alles, sobald resource.data.uid == eigene uid)');

await pruefe('Ausgetretener Lehrer kann den Schueler der Schule noch LESEN', async () => {
  const db = als(LEHRER);
  const snap = await assertSucceeds(getDoc(doc(db, 'students', 'uebernommener-schueler')));
  if (!snap.exists()) throw new Error('Dokument kam nicht zurueck');
});

await pruefe('Ausgetretener Lehrer kann den Schueler der Schule noch AENDERN', async () => {
  const db = als(LEHRER);
  await assertSucceeds(updateDoc(doc(db, 'students', 'uebernommener-schueler'), { fahrstunden: 99 }));
});

await pruefe('Ausgetretener Lehrer kann den Schueler der Schule LOESCHEN', async () => {
  const db = als(LEHRER);
  await assertSucceeds(deleteDoc(doc(db, 'students', 'uebernommener-schueler')));
});

// ══════════════════════════════════════════════════════════════════
console.log('\nGEGENPROBE — was korrekt blockiert ist');

await pruefe('Ein voellig Fremder kommt NICHT an die Schuelerakte (students)', async () => {
  const db = als(FREMD);
  await assertFails(getDoc(doc(db, 'students', 'uebernommener-schueler')));
});

await pruefe('Ohne Anmeldung NICHT an die Schuelerakte (students)', async () => {
  const db = ohneAnmeldung();
  await assertFails(getDoc(doc(db, 'students', 'uebernommener-schueler')));
});

console.log(`\n${bestanden} nachgewiesen, ${fehlgeschlagen} nicht nachweisbar\n`);
await testEnv.cleanup();
process.exit(fehlgeschlagen > 0 ? 1 : 0);
