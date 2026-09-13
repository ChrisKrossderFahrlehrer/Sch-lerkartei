// Tests fuer firestore.rules gegen den echten Firestore-Emulator.
//
// Warum es diese Tests gibt: Die Regeln sind die EINZIGE Grenze zwischen den
// Fahrschulen. Eine Verschaerfung, die zu weit geht, sperrt echte Nutzer aus;
// eine, die nicht weit genug geht, gibt fremde Schuelerdaten frei. Beides ist
// von aussen nicht zu sehen - genau deshalb ist einmal unbemerkt die komplette
// Fahrschul-Registrierung blockiert worden.
//
// Starten:  cd tests && npm test
//
// Jeder Test beschreibt in seinem Namen, was gelten soll. "darf" heisst
// erlaubt, "darf NICHT" heisst blockiert.

import {
  initializeTestEnvironment, assertSucceeds, assertFails,
} from '@firebase/rules-unit-testing';
import { doc, getDoc, setDoc, updateDoc } from 'firebase/firestore';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Pfad zur Regeldatei ueber den Ort DIESER Datei bestimmen, damit die Tests
// unabhaengig davon laufen, aus welchem Ordner sie gestartet werden.
// Mit REGELN=<pfad> laesst sich eine andere Regeldatei pruefen - etwa die
// gerade veroeffentlichte, um einen Verdacht zu bestaetigen.
const REGELN = process.env.REGELN
  || join(dirname(fileURLToPath(import.meta.url)), '..', 'firestore.rules');

const UID_SCHULE_A = 'schule-a-uid';
const UID_SCHULE_B = 'schule-b-uid';
const UID_LEHRER_A = 'lehrer-a-uid';
const UID_FREMD    = 'fremder-uid';
const CODE_A       = 'FS-AAAA';

const testEnv = await initializeTestEnvironment({
  projectId: 'fahrsync-test',
  firestore: {
    rules: readFileSync(REGELN, 'utf8'),
    host: '127.0.0.1',
    port: 8089,
  },
});

// Ausgangslage: zwei Fahrschulen, je ein Inhaber, ein Lehrer und ein Schueler.
await testEnv.withSecurityRulesDisabled(async (ctx) => {
  const db = ctx.firestore();
  for (const [uid, name] of [[UID_SCHULE_A, 'Schule A'], [UID_SCHULE_B, 'Schule B']]) {
    await setDoc(doc(db, 'fahrschulen', uid), {
      name, adminUid: uid, typ: 'fahrschule', status: 'aktiv',
      fahrschulCode: uid === UID_SCHULE_A ? CODE_A : 'FS-BBBB', abo: 'free',
    });
    await setDoc(doc(db, 'users', uid), {
      uid, name, rolle: 'fahrschul-admin', typ: 'fahrschule',
      status: 'aktiv', fahrschuleId: uid,
    });
  }
  await setDoc(doc(db, 'schoolCodes', CODE_A), { schoolId: UID_SCHULE_A, schoolName: 'Schule A' });
  await setDoc(doc(db, 'users', UID_LEHRER_A), {
    uid: UID_LEHRER_A, name: 'Lehrer A', rolle: 'fahrlehrer', typ: 'fahrlehrer',
    status: 'aktiv', fahrschuleId: UID_SCHULE_A,
  });
  await setDoc(doc(db, 'users', UID_FREMD), {
    uid: UID_FREMD, name: 'Fremder', rolle: 'fahrlehrer', typ: 'fahrlehrer',
    status: 'aktiv', fahrschuleId: UID_FREMD,
  });
  await setDoc(doc(db, 'students', 'schueler-a'), {
    uid: UID_LEHRER_A, fahrschuleId: UID_SCHULE_A, vorname: 'Lena', nachname: 'Mertens',
  });
});

const alsNeuerNutzer = (uid) => testEnv.authenticatedContext(uid, { email: `${uid}@test.de` }).firestore();
const als            = (uid) => testEnv.authenticatedContext(uid, { email: `${uid}@test.de` }).firestore();

let bestanden = 0, fehlgeschlagen = 0;
async function pruefe(beschreibung, fn) {
  try { await fn(); bestanden++; console.log('  ✓', beschreibung); }
  catch (e) { fehlgeschlagen++; console.log('  ✗', beschreibung, '\n      ->', String(e.message).split('\n')[0]); }
}

console.log('\nREGISTRIERUNG — muss funktionieren');
await pruefe('Fahrschule anlegen mit abo:"free" darf', async () => {
  const db = alsNeuerNutzer('neu-schule');
  await assertSucceeds(setDoc(doc(db, 'fahrschulen', 'neu-schule'), {
    name: 'Neue Schule', inhaber: 'Chef', email: 'a@b.de', adminUid: 'neu-schule',
    fahrschulCode: 'FS-CCCC', typ: 'fahrschule', status: 'ausstehend',
    abo: 'free', createdAt: Date.now(),
  }));
});
await pruefe('Zugehoeriges users-Dokument anlegen darf', async () => {
  const db = alsNeuerNutzer('neu-schule');
  await assertSucceeds(setDoc(doc(db, 'users', 'neu-schule'), {
    uid: 'neu-schule', name: 'Chef', rolle: 'fahrschul-admin', typ: 'fahrschule',
    status: 'ausstehend', fahrschuleId: 'neu-schule', createdAt: Date.now(),
  }));
});
await pruefe('Fahrlehrer vom SuperAdmin angelegt (users mit abo:"free") darf', async () => {
  const db = alsNeuerNutzer('neu-lehrer');
  await assertSucceeds(setDoc(doc(db, 'users', 'neu-lehrer'), {
    uid: 'neu-lehrer', name: 'Neu', rolle: 'fahrlehrer', typ: 'fahrlehrer',
    status: 'aktiv', fahrschuleId: 'neu-lehrer', abo: 'free', createdAt: Date.now(),
  }));
});
await pruefe('Code-Eintrag fuer die eigene Schule anlegen darf', async () => {
  const db = alsNeuerNutzer('neu-schule');
  await assertSucceeds(setDoc(doc(db, 'schoolCodes', 'FS-CCCC'), {
    schoolId: 'neu-schule', schoolName: 'Neue Schule',
  }));
});

console.log('\nBEZAHLSCHRANKE — darf nicht zu umgehen sein');
await pruefe('Konto mit bezahltem Tarif anlegen darf NICHT', async () => {
  const db = alsNeuerNutzer('schummler');
  await assertFails(setDoc(doc(db, 'users', 'schummler'), {
    uid: 'schummler', name: 'X', rolle: 'fahrlehrer', typ: 'fahrlehrer',
    status: 'aktiv', fahrschuleId: 'schummler', abo: 'unbegrenzt',
  }));
});
await pruefe('Konto mit aboMaxLehrer anlegen darf NICHT', async () => {
  const db = alsNeuerNutzer('schummler2');
  await assertFails(setDoc(doc(db, 'users', 'schummler2'), {
    uid: 'schummler2', name: 'X', rolle: 'fahrlehrer', typ: 'fahrlehrer',
    status: 'aktiv', fahrschuleId: 'schummler2', aboMaxLehrer: 999,
  }));
});
await pruefe('Sich selbst nachtraeglich ein Abo setzen darf NICHT', async () => {
  const db = als(UID_LEHRER_A);
  await assertFails(updateDoc(doc(db, 'users', UID_LEHRER_A), { abo: 'unbegrenzt' }));
});
await pruefe('Sich selbst den Kalender freischalten darf NICHT', async () => {
  const db = als(UID_SCHULE_A);
  await assertFails(updateDoc(doc(db, 'fahrschulen', UID_SCHULE_A), { kalenderAktiv: true }));
});
await pruefe('Sich selbst zum SuperAdmin machen darf NICHT', async () => {
  const db = alsNeuerNutzer('moechtegern');
  await assertFails(setDoc(doc(db, 'users', 'moechtegern'), {
    uid: 'moechtegern', name: 'X', rolle: 'superadmin', status: 'aktiv',
    fahrschuleId: 'moechtegern',
  }));
});

console.log('\nMANDANTENGRENZE — fremde Daten bleiben fremd');
await pruefe('Eigene Fahrschule lesen darf', async () => {
  await assertSucceeds(getDoc(doc(als(UID_LEHRER_A), 'fahrschulen', UID_SCHULE_A)));
});
await pruefe('Fremde Fahrschule lesen darf NICHT', async () => {
  await assertFails(getDoc(doc(als(UID_FREMD), 'fahrschulen', UID_SCHULE_A)));
});
await pruefe('Eigenen Schueler lesen darf', async () => {
  await assertSucceeds(getDoc(doc(als(UID_LEHRER_A), 'students', 'schueler-a')));
});
await pruefe('Fremden Schueler lesen darf NICHT', async () => {
  await assertFails(getDoc(doc(als(UID_FREMD), 'students', 'schueler-a')));
});
await pruefe('Schueler in eine fremde Fahrschule anlegen darf NICHT', async () => {
  const db = als(UID_FREMD);
  await assertFails(setDoc(doc(db, 'students', 'eingeschmuggelt'), {
    uid: UID_FREMD, fahrschuleId: UID_SCHULE_A, vorname: 'Trojaner',
  }));
});

console.log('\nBEITRITT — nur mit Freigabe durch einen Menschen');
await pruefe('Beitritt zu fremder Schule als "ausstehend" darf', async () => {
  const db = als(UID_FREMD);
  await assertSucceeds(updateDoc(doc(db, 'users', UID_FREMD), {
    fahrschuleId: UID_SCHULE_A, fahrschuleName: 'Schule A',
    beitrittCode: CODE_A, status: 'ausstehend',
  }));
});
await pruefe('Beitritt zu fremder Schule mit Status "aktiv" darf NICHT', async () => {
  const db = als(UID_FREMD);
  await assertFails(updateDoc(doc(db, 'users', UID_FREMD), {
    fahrschuleId: UID_SCHULE_A, fahrschuleName: 'Schule A',
    beitrittCode: CODE_A, status: 'aktiv',
  }));
});
await pruefe('Ohne Code in eine fremde Schule wechseln darf NICHT', async () => {
  const db = als(UID_FREMD);
  await assertFails(updateDoc(doc(db, 'users', UID_FREMD), {
    fahrschuleId: UID_SCHULE_B, status: 'ausstehend',
  }));
});
await pruefe('Sich selbst von "ausstehend" auf "aktiv" setzen darf NICHT', async () => {
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'users', 'wartender'), {
      uid: 'wartender', name: 'W', rolle: 'fahrlehrer', typ: 'fahrlehrer',
      status: 'ausstehend', fahrschuleId: UID_SCHULE_A,
    });
  });
  await assertFails(updateDoc(doc(als('wartender'), 'users', 'wartender'), { status: 'aktiv' }));
});

await testEnv.cleanup();
console.log(`\n${bestanden} bestanden, ${fehlgeschlagen} fehlgeschlagen\n`);
process.exit(fehlgeschlagen > 0 ? 1 : 0);
