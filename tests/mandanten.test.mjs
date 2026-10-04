// Mandantengrenze, zweite Runde - gegen den echten Firestore-Emulator.
//
// Jeder Angriff hier wurde VOR der Korrektur gegen die damals gueltigen
// Regeln ausgefuehrt und kam durch. Die schwerste Kette brauchte nur ein
// kostenloses Konto und die Kennung einer fremden Fahrschule:
//
//   1. sich als Fahrschule registrieren (Rolle 'fahrschul-admin')
//   2. im eigenen Profil fahrschuleId = fremde Schule, status = 'aktiv'
//   3. die komplette Kartei der fremden Schule lesen, aendern, loeschen
//
// Die Kennung einer Schule ist die UID ihres Inhabers - und die steht in
// jedem Buchungslink, den der Inhaber an Schueler verschickt.
//
// Mindestens so wichtig wie die Angriffe sind die GEGENPROBEN: Jeder Weg, den
// die App wirklich geht, muss weiter funktionieren. Niemand darf
// ausgesperrt werden.
//
// Starten:  cd tests && npm test

import {
  initializeTestEnvironment, assertSucceeds, assertFails,
} from '@firebase/rules-unit-testing';
import {
  doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc, collection, query, where, writeBatch,
} from 'firebase/firestore';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const REGELN = process.env.REGELN
  || join(dirname(fileURLToPath(import.meta.url)), '..', 'firestore.rules');

const SCHULE   = 'schule-uid';          // Inhaber = Fahrschul-ID
const CODE     = 'FS-SCHL';
const LEHRER   = 'lehrer-aktiv';        // freigegebenes Mitglied
const ALT      = 'lehrer-alt';          // Altkonto ohne status-Feld
const WARTET   = 'lehrer-wartet';       // beigetreten, noch nicht freigegeben
const GESPERRT = 'lehrer-gesperrt';
const SOLO     = 'solo-lehrer';         // eigenstaendig, KEIN fahrschulen-Dokument
const ANGREIFER = 'angreifer';

const testEnv = await initializeTestEnvironment({
  projectId: 'fahrsync-mandanten',
  firestore: { rules: readFileSync(REGELN, 'utf8'), host: '127.0.0.1', port: 8089 },
});

await testEnv.withSecurityRulesDisabled(async (ctx) => {
  const db = ctx.firestore();
  const s = (p, d) => setDoc(doc(db, p), d);
  await s(`fahrschulen/${SCHULE}`, { name: 'Schule', adminUid: SCHULE, status: 'aktiv', fahrschulCode: CODE, abo: 'free' });
  await s(`users/${SCHULE}`, { uid: SCHULE, rolle: 'fahrschul-admin', typ: 'fahrschule', status: 'aktiv', fahrschuleId: SCHULE });
  await s(`schoolCodes/${CODE}`, { schoolId: SCHULE, schoolName: 'Schule' });
  await s(`users/${LEHRER}`,   { uid: LEHRER,   rolle: 'fahrlehrer', status: 'aktiv',      fahrschuleId: SCHULE });
  await s(`users/${ALT}`,      { uid: ALT,      rolle: 'fahrlehrer',                       fahrschuleId: SCHULE });
  await s(`users/${WARTET}`,   { uid: WARTET,   rolle: 'fahrlehrer', status: 'ausstehend', fahrschuleId: SCHULE });
  await s(`users/${GESPERRT}`, { uid: GESPERRT, rolle: 'fahrlehrer', status: 'gesperrt',   fahrschuleId: SCHULE });
  await s(`users/${SOLO}`,     { uid: SOLO,     rolle: 'fahrlehrer', status: 'aktiv',      fahrschuleId: SOLO });
  await s('students/s-schule', { uid: SCHULE, fahrschuleId: SCHULE, vorname: 'Lena' });
  await s('chat/c1', { fahrschuleId: SCHULE, senderUid: SCHULE, text: 'intern' });
  await s('platform/rechnungszaehler', { naechste: 4711 });
  await s('platform/impressum', { text: 'Impressum' });
  for (const uid of [SCHULE, LEHRER, ALT, WARTET, GESPERRT]) {
    await s(`kalenderUsers/${uid}`, { uid, schoolId: SCHULE });
  }
  await s('slots/slot-schule', { schoolId: SCHULE, lehrerUid: SCHULE, schuelerName: 'Lena' });
  await s('slots/slot-wartet', { schoolId: SCHULE, lehrerUid: WARTET });
  await s('invites/einladung1', { fahrschuleId: SCHULE, fahrschulCode: CODE, used: false });
});

const als = (uid) => testEnv.authenticatedContext(uid, {
  email: `${uid}@test.de`, firebase: { sign_in_provider: 'password' },
}).firestore();
const anonym = (uid) => testEnv.authenticatedContext(uid, {
  firebase: { sign_in_provider: 'anonymous' },
}).firestore();
const ohneAnmeldung = () => testEnv.unauthenticatedContext().firestore();
const superAdmin = () => testEnv.authenticatedContext('chef', {
  email: 'chriskoo@mail.de', firebase: { sign_in_provider: 'password' },
}).firestore();

let bestanden = 0, fehlgeschlagen = 0;
async function pruefe(beschreibung, fn) {
  try { await fn(); bestanden++; console.log('  ✓', beschreibung); }
  catch (e) { fehlgeschlagen++; console.log('  ✗', beschreibung, '\n      ->', String(e.message).split('\n')[0]); }
}

// ─────────────────────────────────────────────────────────────────────────
console.log('\nKETTE 1 — selbst registrierter "Inhaber" zieht sich in eine fremde Schule');
await pruefe('Konto als Fahrschule registrieren darf (ist kostenlos, jeder darf)', async () => {
  await assertSucceeds(setDoc(doc(als(ANGREIFER), 'users', ANGREIFER), {
    uid: ANGREIFER, rolle: 'fahrschul-admin', typ: 'fahrschule',
    status: 'ausstehend', fahrschuleId: ANGREIFER,
  }));
});
await pruefe('...eigene fahrschuleId auf die fremde Schule + "aktiv" darf NICHT', async () => {
  await assertFails(updateDoc(doc(als(ANGREIFER), 'users', ANGREIFER), {
    fahrschuleId: SCHULE, status: 'aktiv',
  }));
});
await pruefe('...eigene fahrschuleId auf die fremde Schule (ohne Code) darf NICHT', async () => {
  await assertFails(updateDoc(doc(als(ANGREIFER), 'users', ANGREIFER), { fahrschuleId: SCHULE }));
});
await pruefe('...sich selbst freischalten darf NICHT', async () => {
  await assertFails(updateDoc(doc(als(ANGREIFER), 'users', ANGREIFER), { status: 'aktiv' }));
});
await pruefe('...die Kartei der fremden Schule bleibt zu', async () => {
  await assertFails(getDoc(doc(als(ANGREIFER), 'students', 's-schule')));
});

console.log('\nKETTE 2 — mit dem Fahrschul-Code als "Admin" beitreten und selbst freischalten');
await pruefe('Beitritt mit Code als "fahrschul-admin" darf NICHT', async () => {
  await assertFails(setDoc(doc(als('beitritt-admin'), 'users', 'beitritt-admin'), {
    uid: 'beitritt-admin', rolle: 'fahrschul-admin', status: 'ausstehend',
    fahrschuleId: SCHULE, beitrittCode: CODE,
  }));
});
// Falls es solche Konten schon gibt (vor der Korrektur angelegt):
await testEnv.withSecurityRulesDisabled(async (ctx) => {
  await setDoc(doc(ctx.firestore(), 'users', 'alt-admin-wartet'), {
    uid: 'alt-admin-wartet', rolle: 'fahrschul-admin', status: 'ausstehend', fahrschuleId: SCHULE,
  });
});
await pruefe('Bestehender wartender "Admin" schaltet ein anderes Mitglied NICHT frei', async () => {
  await assertFails(updateDoc(doc(als('alt-admin-wartet'), 'users', WARTET), { status: 'aktiv' }));
});
await pruefe('...und liest die Profile der Schule NICHT', async () => {
  await assertFails(getDoc(doc(als('alt-admin-wartet'), 'users', SCHULE)));
});

console.log('\nKETTE 3 — Code-Tabelle, Kalender, Team-Chat, Plattform');
await pruefe('Fremden Code-Eintrag auf sich umbiegen darf NICHT', async () => {
  await assertFails(setDoc(doc(als(ANGREIFER), 'schoolCodes', CODE), { schoolId: ANGREIFER }));
});
await pruefe('Wartendes Mitglied liest Termine der Schule NICHT', async () => {
  await assertFails(getDoc(doc(als(WARTET), 'slots', 'slot-schule')));
});
await pruefe('Gesperrtes Mitglied liest Termine der Schule NICHT', async () => {
  await assertFails(getDoc(doc(als(GESPERRT), 'slots', 'slot-schule')));
});
await pruefe('Wartendes Mitglied listet die Kalenderprofile der Schule NICHT', async () => {
  await assertFails(getDocs(query(collection(als(WARTET), 'kalenderUsers'), where('schoolId', '==', SCHULE))));
});
await pruefe('Gesperrtes Mitglied liest den Team-Chat NICHT', async () => {
  await assertFails(getDoc(doc(als(GESPERRT), 'chat', 'c1')));
});
await pruefe('Wartendes Mitglied schreibt in den Team-Chat NICHT', async () => {
  await assertFails(setDoc(doc(als(WARTET), 'chat', 'c-neu'), { fahrschuleId: SCHULE, senderUid: WARTET, text: 'x' }));
});
await pruefe('Gesperrtes Mitglied schiebt der Schule KEINEN Schueler unter', async () => {
  await assertFails(setDoc(doc(als(GESPERRT), 'students', 's-gesperrt'), { uid: GESPERRT, fahrschuleId: SCHULE }));
});
await pruefe('Wartendes Mitglied sieht die Einladungs-Links der Schule NICHT', async () => {
  await assertFails(getDocs(query(collection(als(WARTET), 'invites'), where('fahrschuleId', '==', SCHULE))));
});
await pruefe('Anonyme Sitzung listet die Plattform-Sammlung NICHT (Rechnungszaehler)', async () => {
  await assertFails(getDocs(collection(anonym('anon-1'), 'platform')));
});
await pruefe('Anonyme Sitzung belegt KEINEN Benutzernamen', async () => {
  await assertFails(setDoc(doc(anonym('anon-2'), 'usernames', 'besetzt'), { username: 'besetzt', uid: 'anon-2' }));
});

console.log('\nKETTE 4 — fremde Kennungen besetzen, Status selbst setzen');
await pruefe('fahrschulen-Dokument unter der Kennung eines FREMDEN Solo-Lehrers anlegen darf NICHT', async () => {
  await assertFails(setDoc(doc(als(ANGREIFER), 'fahrschulen', SOLO), {
    adminUid: ANGREIFER, status: 'gesperrt', abo: 'free',
  }));
});
await pruefe('Neue Fahrschule gleich als "aktiv" anlegen darf NICHT', async () => {
  await assertFails(setDoc(doc(als('ungeduldig'), 'fahrschulen', 'ungeduldig'), {
    adminUid: 'ungeduldig', status: 'aktiv', abo: 'free',
  }));
});
await pruefe('Kalender-Schulprofil unter fremder Kennung anlegen darf NICHT', async () => {
  await assertFails(setDoc(doc(als(ANGREIFER), 'schools', SOLO), { adminUid: ANGREIFER, name: 'Falsch' }));
});
await testEnv.withSecurityRulesDisabled(async (ctx) => {
  const db = ctx.firestore();
  await setDoc(doc(db, 'fahrschulen', 'gesperrte-schule'), { adminUid: 'gesperrte-schule', status: 'zahlung_offen' });
  await setDoc(doc(db, 'users', 'gesperrte-schule'), { uid: 'gesperrte-schule', rolle: 'fahrschul-admin', status: 'aktiv', fahrschuleId: 'gesperrte-schule' });
});
await pruefe('Inhaber hebt die Zahlungssperre seiner Schule NICHT selbst auf', async () => {
  await assertFails(updateDoc(doc(als('gesperrte-schule'), 'fahrschulen', 'gesperrte-schule'), { status: 'aktiv' }));
});
await pruefe('Inhaber setzt seinen eigenen Status NICHT selbst', async () => {
  await assertFails(updateDoc(doc(als(SCHULE), 'users', SCHULE), { status: 'gesperrt' }));
});
await pruefe('Inhaber schickt ein Mitglied NICHT in eine andere Schule', async () => {
  await assertFails(updateDoc(doc(als(SCHULE), 'users', LEHRER), { fahrschuleId: ANGREIFER }));
});

// ─────────────────────────────────────────────────────────────────────────
console.log('\nGEGENPROBE — Registrierung, wie index.html und adk-platform.html sie machen');
await pruefe('Fahrschule: fahrschulen-Dokument (ausstehend) anlegen darf', async () => {
  await assertSucceeds(setDoc(doc(als('neue-schule'), 'fahrschulen', 'neue-schule'), {
    name: 'Neu', inhaber: 'Neu', adminUid: 'neue-schule', fahrschulCode: 'FS-NEU1',
    typ: 'fahrschule', status: 'ausstehend', abo: 'free', createdAt: 1,
  }));
});
await pruefe('Fahrschule: Code-Eintrag anlegen darf', async () => {
  await assertSucceeds(setDoc(doc(als('neue-schule'), 'schoolCodes', 'FS-NEU1'), { schoolId: 'neue-schule', schoolName: 'Neu' }));
});
await pruefe('Fahrschule: eigenes Profil als fahrschul-admin anlegen darf', async () => {
  await assertSucceeds(setDoc(doc(als('neue-schule'), 'users', 'neue-schule'), {
    uid: 'neue-schule', rolle: 'fahrschul-admin', typ: 'fahrschule', status: 'ausstehend', fahrschuleId: 'neue-schule',
  }));
});
await pruefe('Benutzername MIT uid speichern darf (Registrierung, korrigiert)', async () => {
  await assertSucceeds(setDoc(doc(als('neue-schule'), 'usernames', 'neueschule'), {
    username: 'neueschule', email: 'neue-schule@test.de', uid: 'neue-schule', createdAt: 1,
  }));
});
await pruefe('Benutzername OHNE uid wird abgewiesen (so war es bis zur Korrektur)', async () => {
  await assertFails(setDoc(doc(als('neue-schule2'), 'usernames', 'neueschule2'), {
    username: 'neueschule2', email: 'x@test.de', createdAt: 1,
  }));
});
await pruefe('E-Mail-Aenderung: eigenen Benutzernamen per merge aktualisieren darf', async () => {
  await assertSucceeds(setDoc(doc(als('neue-schule'), 'usernames', 'neueschule'), {
    username: 'neueschule', email: 'neu@test.de', uid: 'neue-schule', emailVorher: 'neue-schule@test.de', updatedAt: 2,
  }, { merge: true }));
});
await pruefe('Fahrlehrer: Beitritt mit Code als "fahrlehrer" (ausstehend) darf', async () => {
  await assertSucceeds(setDoc(doc(als('neuer-lehrer'), 'users', 'neuer-lehrer'), {
    uid: 'neuer-lehrer', rolle: 'fahrlehrer', typ: 'fahrlehrer', status: 'ausstehend',
    fahrschuleId: SCHULE, beitrittCode: CODE,
  }));
});
await pruefe('Fahrlehrer: eigenstaendig registrieren darf', async () => {
  await assertSucceeds(setDoc(doc(als('solo-neu'), 'users', 'solo-neu'), {
    uid: 'solo-neu', rolle: 'fahrlehrer', typ: 'fahrlehrer', status: 'ausstehend', fahrschuleId: 'solo-neu',
  }));
});
await pruefe('Einladungslink als benutzt markieren darf', async () => {
  await assertSucceeds(updateDoc(doc(als('neuer-lehrer'), 'invites', 'einladung1'), {
    used: true, usedBy: 'neuer-lehrer', usedAt: 1,
  }));
});

console.log('\nGEGENPROBE — Beitreten und Verlassen aus den Einstellungen');
await pruefe('Solo-Lehrer tritt mit Code bei (ausstehend) darf', async () => {
  await assertSucceeds(updateDoc(doc(als(SOLO), 'users', SOLO), {
    fahrschuleId: SCHULE, fahrschuleName: 'Schule', beitrittCode: CODE, status: 'ausstehend',
  }));
});
await pruefe('...und verlaesst die Schule wieder darf', async () => {
  await assertSucceeds(updateDoc(doc(als(SOLO), 'users', SOLO), { fahrschuleId: SOLO, fahrschuleName: null }));
});
await pruefe('Inhaber, der selbst einer anderen Schule beitritt (ausstehend) darf', async () => {
  await assertSucceeds(updateDoc(doc(als('gesperrte-schule'), 'users', 'gesperrte-schule'), {
    fahrschuleId: SCHULE, beitrittCode: CODE, status: 'ausstehend',
  }));
});

console.log('\nGEGENPROBE — der Inhaber verwaltet seine Schule');
await pruefe('Inhaber zaehlt seine Lehrer (users nach fahrschuleId)', async () => {
  await assertSucceeds(getDocs(query(collection(als(SCHULE), 'users'), where('fahrschuleId', '==', SCHULE))));
});
await pruefe('Inhaber listet seine offenen Einladungen', async () => {
  await assertSucceeds(getDocs(query(collection(als(SCHULE), 'invites'),
    where('fahrschuleId', '==', SCHULE), where('used', '==', false))));
});
await pruefe('Inhaber legt eine Einladung an', async () => {
  await assertSucceeds(setDoc(doc(als(SCHULE), 'invites', 'einladung2'), {
    fahrschuleId: SCHULE, fahrschulCode: CODE, used: false, createdAt: 1,
  }));
});
await pruefe('Inhaber loescht eine Einladung', async () => {
  await assertSucceeds(deleteDoc(doc(als(SCHULE), 'invites', 'einladung2')));
});
await pruefe('Inhaber aendert eigene Einstellungen (Bundesland)', async () => {
  await assertSucceeds(updateDoc(doc(als(SCHULE), 'users', SCHULE), { bundesland: 'NW' }));
});
await pruefe('Automatische Zahlungssperre (Inhaber setzt zahlung_offen) darf', async () => {
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'fahrschulen', 'abgelaufen'), { adminUid: 'abgelaufen', status: 'aktiv', abo: 'basis' });
    await setDoc(doc(db, 'users', 'abgelaufen'), { uid: 'abgelaufen', rolle: 'fahrschul-admin', status: 'aktiv', fahrschuleId: 'abgelaufen' });
  });
  await assertSucceeds(updateDoc(doc(als('abgelaufen'), 'fahrschulen', 'abgelaufen'), {
    status: 'zahlung_offen', statusUpdatedAt: 1, autoLocked: true,
  }));
});
await pruefe('Inhaber schaltet ein wartendes Mitglied frei darf', async () => {
  await assertSucceeds(updateDoc(doc(als(SCHULE), 'users', WARTET), { status: 'aktiv' }));
});
await testEnv.withSecurityRulesDisabled(async (ctx) => {
  await updateDoc(doc(ctx.firestore(), 'users', WARTET), { status: 'ausstehend' });
});
await pruefe('Inhaber nimmt ein Mitglied aus der Schule darf', async () => {
  await assertSucceeds(updateDoc(doc(als(SCHULE), 'users', GESPERRT), { fahrschuleId: GESPERRT }));
});
await testEnv.withSecurityRulesDisabled(async (ctx) => {
  await updateDoc(doc(ctx.firestore(), 'users', GESPERRT), { fahrschuleId: SCHULE });
});

console.log('\nGEGENPROBE — freigegebene Mitglieder arbeiten normal');
for (const [wer, uid] of [['Freigegebenes Mitglied', LEHRER], ['Altkonto ohne status-Feld', ALT], ['Inhaber', SCHULE]]) {
  await pruefe(`${wer} liest den Schueler der Schule`, async () => {
    await assertSucceeds(getDoc(doc(als(uid), 'students', 's-schule')));
  });
  await pruefe(`${wer} liest die Termine der Schule`, async () => {
    await assertSucceeds(getDoc(doc(als(uid), 'slots', 'slot-schule')));
  });
  await pruefe(`${wer} liest den Team-Chat`, async () => {
    await assertSucceeds(getDoc(doc(als(uid), 'chat', 'c1')));
  });
  await pruefe(`${wer} listet die Kalenderprofile der Schule`, async () => {
    await assertSucceeds(getDocs(query(collection(als(uid), 'kalenderUsers'), where('schoolId', '==', SCHULE))));
  });
}
await pruefe('Freigegebenes Mitglied legt einen Schueler fuer die Schule an', async () => {
  await assertSucceeds(setDoc(doc(als(LEHRER), 'students', 's-neu'), { uid: LEHRER, fahrschuleId: SCHULE, vorname: 'Max' }));
});
await pruefe('Freigegebenes Mitglied legt sein Kalenderprofil an', async () => {
  await testEnv.withSecurityRulesDisabled(async (ctx) => { await deleteDoc(doc(ctx.firestore(), 'kalenderUsers', LEHRER)); });
  await assertSucceeds(setDoc(doc(als(LEHRER), 'kalenderUsers', LEHRER), { uid: LEHRER, schoolId: SCHULE, role: 'lehrer', approved: true }));
});
// Die Freigabe-Pruefung liest ein Dokument mehr (users/{ich}). Firestore
// begrenzt die nachgeschlagenen Dokumente pro Anfrage - kalender.html loescht
// Termine aber in Sammelschreibungen von bis zu 450 Stueck. Wiederholte
// Zugriffe auf dasselbe Dokument zaehlen nur einmal; das hier belegt es.
await pruefe('Freigegebenes Mitglied loescht 120 Termine der Schule in EINER Sammelschreibung', async () => {
  const ids = Array.from({ length: 120 }, (_, i) => `massen-${i}`);
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    const b = writeBatch(db);
    ids.forEach(id => b.set(doc(db, 'slots', id), { schoolId: SCHULE, lehrerUid: SCHULE }));
    await b.commit();
  });
  const db = als(LEHRER);
  const b = writeBatch(db);
  ids.forEach(id => b.delete(doc(db, 'slots', id)));
  await assertSucceeds(b.commit());
});
console.log('\nGEGENPROBE — Schueler an einen Kollegen uebertragen (index.html, transferStudent)');
// Die Suche lief vorher ueber users (Abfrage ueber alle Profile) und
// scheiterte fuer jeden Fahrlehrer. Jetzt ueber usernames/{name}.
await testEnv.withSecurityRulesDisabled(async (ctx) => {
  await setDoc(doc(ctx.firestore(), 'usernames', 'kollege.alt'), { username: 'kollege.alt', uid: ALT, email: 'alt@test.de' });
});
await pruefe('Benutzernamen eines Kollegen nachschlagen darf', async () => {
  await assertSucceeds(getDoc(doc(als(LEHRER), 'usernames', 'kollege.alt')));
});
await pruefe('Schueler der Schule an den Kollegen uebertragen darf', async () => {
  await assertSucceeds(updateDoc(doc(als(LEHRER), 'students', 's-neu'), { uid: ALT }));
});
await pruefe('...der Kollege sieht ihn danach', async () => {
  await assertSucceeds(getDoc(doc(als(ALT), 'students', 's-neu')));
});
await pruefe('...und der bisherige Lehrer weiterhin (gehoert ja der Schule)', async () => {
  await assertSucceeds(getDoc(doc(als(LEHRER), 'students', 's-neu')));
});
await pruefe('Wartendes Mitglied behaelt seine EIGENEN Termine', async () => {
  await assertSucceeds(getDoc(doc(als(WARTET), 'slots', 'slot-wartet')));
});
await pruefe('Solo-Lehrer legt eigene Schueler an', async () => {
  await assertSucceeds(setDoc(doc(als('solo-neu'), 'students', 's-solo'), { uid: 'solo-neu', fahrschuleId: 'solo-neu' }));
});

console.log('\nGEGENPROBE — oeffentliche und Betreiber-Zugriffe');
await pruefe('Impressum ohne Anmeldung lesbar', async () => {
  await assertSucceeds(getDoc(doc(ohneAnmeldung(), 'platform', 'impressum')));
});
await pruefe('Betreiber listet die Plattform-Sammlung', async () => {
  await assertSucceeds(getDocs(collection(superAdmin(), 'platform')));
});
await pruefe('Betreiber schaltet eine Schule frei', async () => {
  await assertSucceeds(updateDoc(doc(superAdmin(), 'fahrschulen', 'neue-schule'), { status: 'aktiv' }));
});
await pruefe('Betreiber listet alle Kalender-Schulprofile', async () => {
  await assertSucceeds(getDocs(collection(superAdmin(), 'schools')));
});

await testEnv.cleanup();
console.log(`\n${bestanden} bestanden, ${fehlgeschlagen} fehlgeschlagen\n`);
process.exit(fehlgeschlagen > 0 ? 1 : 0);
