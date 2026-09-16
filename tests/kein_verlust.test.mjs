// Verliert ein AKTIVER Fahrlehrer durch die Regeln irgendwo Zugriff auf
// Daten, die er angelegt hat?
//
// Hintergrund: Die Zustaendigkeit haengt an zwei Feldern - einem Besitzerfeld
// (uid bzw. lehrerUid) und einem Zuordnungsfeld (fahrschuleId bzw. schoolId).
// Im Laufe der Zeit sind dadurch mehrere Datenformen entstanden: aus der Zeit
// vor der Fahrschul-Funktion (gar keine Zuordnung), nach dem Beitritt zu
// einer Schule (Zuordnung zeigt noch auf den Lehrer) und nach der Uebergabe
// (Zuordnung zeigt auf die Schule). Dieser Test legt von JEDER Form einen
// Datensatz an und prueft, dass der Lehrer ihn weiterhin sieht UND aendern
// kann - Kartei wie Kalender.
//
// Starten:  cd tests && npm run test:kein-verlust

import {
  initializeTestEnvironment, assertSucceeds, assertFails,
} from '@firebase/rules-unit-testing';
import { doc, getDoc, setDoc, updateDoc } from 'firebase/firestore';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const REGELN = process.env.REGELN
  || join(dirname(fileURLToPath(import.meta.url)), '..', 'firestore.rules');

const SCHULE = 'schule-uid';    // Fahrschule (Inhaber)
const SOLO   = 'solo-uid';      // eigenstaendiger Fahrlehrer, nie in einer Schule
const NEU    = 'neu-uid';       // in der Schule, Daten NOCH NICHT uebergeben
const UEBER  = 'ueber-uid';     // in der Schule, Daten uebergeben
const ALT    = 'alt-uid';       // Altbestand: Daten ganz OHNE Zuordnungsfeld
const RAUS   = 'raus-uid';      // hat die Schule wieder VERLASSEN

const testEnv = await initializeTestEnvironment({
  projectId: 'fahrsync-kein-verlust',
  firestore: { rules: readFileSync(REGELN, 'utf8'), host: '127.0.0.1', port: 8089 },
});

// ── Datenlage: von jeder Form ein Satz ───────────────────────────────
await testEnv.withSecurityRulesDisabled(async (ctx) => {
  const db = ctx.firestore();
  const s = (p, d) => setDoc(doc(db, ...p.split('/')), d);

  await s(`fahrschulen/${SCHULE}`, { name: 'Schule', adminUid: SCHULE, typ: 'fahrschule', status: 'aktiv', fahrschulCode: 'FS-AAAA' });
  await s(`users/${SCHULE}`, { uid: SCHULE, rolle: 'fahrschul-admin', typ: 'fahrschule', status: 'aktiv', fahrschuleId: SCHULE });
  await s(`users/${SOLO}`,   { uid: SOLO,  rolle: 'fahrlehrer', typ: 'fahrlehrer', status: 'aktiv', fahrschuleId: SOLO });
  await s(`users/${NEU}`,    { uid: NEU,   rolle: 'fahrlehrer', typ: 'fahrlehrer', status: 'aktiv', fahrschuleId: SCHULE });
  await s(`users/${UEBER}`,  { uid: UEBER, rolle: 'fahrlehrer', typ: 'fahrlehrer', status: 'aktiv', fahrschuleId: SCHULE });
  await s(`users/${ALT}`,    { uid: ALT,   rolle: 'fahrlehrer', typ: 'fahrlehrer', status: 'aktiv', fahrschuleId: ALT });
  await s(`users/${RAUS}`,   { uid: RAUS,  rolle: 'fahrlehrer', typ: 'fahrlehrer', status: 'aktiv', fahrschuleId: RAUS });

  // Kalender-Profile (fuer die Kalender-Regeln)
  for (const [uid, schoolId] of [[SCHULE, SCHULE], [SOLO, SOLO], [NEU, SCHULE],
                                 [UEBER, SCHULE], [ALT, ALT], [RAUS, RAUS]]) {
    await s(`kalenderUsers/${uid}`, { uid, schoolId, role: uid === SCHULE ? 'admin' : 'lehrer', approved: true });
  }

  const ADK = ['students', 'protokoll', 'customThemen', 'customGruppen'];
  // ADK-Kartei, je Lage
  for (const c of ADK) {
    await s(`${c}/${c}-solo`,  { uid: SOLO,  fahrschuleId: SOLO,   name: 'Solo',  vorname: 'Solo' });
    await s(`${c}/${c}-neu`,   { uid: NEU,   fahrschuleId: NEU,    name: 'Neu',   vorname: 'Neu' });
    await s(`${c}/${c}-ueber`, { uid: UEBER, fahrschuleId: SCHULE, name: 'Ueber', vorname: 'Ueber' });
    await s(`${c}/${c}-alt`,   { uid: ALT,                         name: 'Alt',   vorname: 'Alt' });   // OHNE Zuordnung
  }
  // customFields fuehrt laut Regeldatei NUR uid - gar keine fahrschuleId.
  for (const uid of [SOLO, NEU, UEBER, ALT]) {
    await s(`customFields/cf-${uid}`, { uid, name: 'Fuehrerscheinstelle' });
  }

  // Kalender-Modul
  const KAL = ['schueler', 'slots', 'theorieStunden'];
  for (const c of KAL) {
    await s(`${c}/${c}-solo`,  { lehrerUid: SOLO,  schoolId: SOLO,   fname: 'Solo' });
    await s(`${c}/${c}-neu`,   { lehrerUid: NEU,   schoolId: NEU,    fname: 'Neu' });
    await s(`${c}/${c}-ueber`, { lehrerUid: UEBER, schoolId: SCHULE, fname: 'Ueber' });
    await s(`${c}/${c}-alt`,   { lehrerUid: ALT,                     fname: 'Alt' });  // OHNE schoolId
  }
  // pruefungen fuehrt KEIN lehrerUid - nur schoolId und eingetragenVon.
  await s('pruefungen/pr-ueber', { schuelerId: 'x', schoolId: SCHULE, eingetragenVon: UEBER, datum: '2026-05-01' });
  await s('pruefungen/pr-solo',  { schuelerId: 'y', schoolId: SOLO,   eingetragenVon: SOLO,  datum: '2026-05-02' });
  // Der heikle Fall: angelegt, BEVOR der Lehrer der Schule beigetreten ist -
  // schoolId zeigt daher noch auf seine eigene uid, sein Kalender-Profil
  // laengst auf die Schule.
  await s('pruefungen/pr-vor-beitritt', { schuelerId: 'z', schoolId: UEBER, eingetragenVon: UEBER, datum: '2026-01-10' });

  // Zugangscodes haengen an teacherUid
  for (const uid of [SOLO, NEU, UEBER, ALT]) {
    await s(`accessCodes/CODE${uid.slice(0, 4).toUpperCase()}`, {
      code: 'X', teacherUid: uid, studentId: 's', studentSnapshot: {}, messages: [],
      expiresAt: Date.now() + 9e8,
    });
  }

  // Der ausgetretene Lehrer: seine Schueler gehoeren jetzt der Schule.
  await s('students/students-raus', { uid: RAUS, fahrschuleId: SCHULE, vorname: 'Raus' });
});

const als = (uid) => testEnv.authenticatedContext(uid, { email: `${uid}@test.de` }).firestore();
let ok = 0, schlecht = 0;
async function pruefe(text, fn) {
  try { await fn(); ok++; console.log('  ✓', text); }
  catch (e) { schlecht++; console.log('  ✗', text, '\n      ->', String(e.message).split('\n')[0]); }
}

// lesen UND aendern - "nichts verloren" heisst auch weiterarbeiten koennen
async function sehenUndAendern(uid, pfad, feld = 'notiz') {
  const db = als(uid);
  const ref = doc(db, ...pfad.split('/'));
  await assertSucceeds(getDoc(ref));
  await assertSucceeds(updateDoc(ref, { [feld]: 'geaendert-' + Date.now() }));
}

const LAGEN = [
  [SOLO,  'solo',  'Eigenstaendiger Fahrlehrer (nie in einer Schule)'],
  [NEU,   'neu',   'In einer Schule, Daten NOCH NICHT uebergeben'],
  [UEBER, 'ueber', 'In einer Schule, Daten uebergeben'],
  [ALT,   'alt',   'Altbestand ganz OHNE Zuordnungsfeld'],
];

console.log('\nADK-KARTEI — sieht der Lehrer seine Daten und kann er sie aendern?');
for (const [uid, kuerzel, titel] of LAGEN) {
  console.log(`\n  ${titel}`);
  for (const c of ['students', 'protokoll', 'customThemen', 'customGruppen']) {
    await pruefe(`    ${c}`, () => sehenUndAendern(uid, `${c}/${c}-${kuerzel}`));
  }
  await pruefe('    customFields (fuehrt gar keine fahrschuleId)',
    () => sehenUndAendern(uid, `customFields/cf-${uid}`));
  await pruefe('    accessCodes (Portal-Zugang des Schuelers)',
    () => sehenUndAendern(uid, `accessCodes/CODE${uid.slice(0, 4).toUpperCase()}`, 'teacherLastRead'));
}

console.log('\nKALENDER-MODUL — dasselbe fuer Termine und Kalender-Schueler');
for (const [uid, kuerzel, titel] of LAGEN) {
  console.log(`\n  ${titel}`);
  for (const c of ['schueler', 'slots', 'theorieStunden']) {
    await pruefe(`    ${c}`, () => sehenUndAendern(uid, `${c}/${c}-${kuerzel}`));
  }
}
await pruefe('  pruefungen (fuehrt KEIN lehrerUid) - Lehrer der Schule sieht sie',
  () => sehenUndAendern(UEBER, 'pruefungen/pr-ueber', 'notiz'));
await pruefe('  pruefungen - eigenstaendiger Lehrer sieht seine',
  () => sehenUndAendern(SOLO, 'pruefungen/pr-solo', 'notiz'));
await pruefe('  pruefungen VOM ZEITRAUM VOR dem Schulbeitritt bleiben sichtbar',
  () => sehenUndAendern(UEBER, 'pruefungen/pr-vor-beitritt', 'notiz'));

console.log('\nDIE FAHRSCHULE SELBST — sieht sie, was ihr uebergeben wurde?');
await pruefe('  Uebergebener Schueler',        () => sehenUndAendern(SCHULE, 'students/students-ueber'));
await pruefe('  Uebergebenes Protokoll',       () => sehenUndAendern(SCHULE, 'protokoll/protokoll-ueber'));
await pruefe('  Uebergebener Kalender-Schueler', () => sehenUndAendern(SCHULE, 'schueler/schueler-ueber'));
await pruefe('  Uebergebener Termin',          () => sehenUndAendern(SCHULE, 'slots/slots-ueber'));

console.log('\nKOLLEGE IN DERSELBEN SCHULE — sieht er die uebergebenen Daten?');
await pruefe('  Anderer Lehrer der Schule sieht den uebergebenen Schueler',
  () => sehenUndAendern(NEU, 'students/students-ueber'));

console.log('\nDIE EINE ABSICHTLICHE GRENZE');
await pruefe('Wer die Schule VERLASSEN hat, sieht die uebergebenen Schueler NICHT mehr', async () => {
  await assertFails(getDoc(doc(als(RAUS), 'students', 'students-raus')));
});
await pruefe('...die Fahrschule aber sehr wohl - der Datensatz ist NICHT verloren', async () => {
  await assertSucceeds(getDoc(doc(als(SCHULE), 'students', 'students-raus')));
});

console.log(`\n${ok} bestanden, ${schlecht} fehlgeschlagen\n`);
await testEnv.cleanup();
process.exit(schlecht > 0 ? 1 : 0);
