// Jede ABFRAGE, die die App wirklich stellt, gegen die Regeln.
//
// Hintergrund: Bei Abfragen prueft Firestore nicht jedes Dokument einzeln,
// sondern ob die Abfrage ueberhaupt etwas Unerlaubtes liefern KOENNTE
// ("Regeln sind keine Filter"). Eine Regel kann fuer das einzelne Dokument
// stimmen (getDoc geht) und die Liste trotzdem komplett verweigern - dann
// bleibt in der App eine Liste leer oder es erscheint ein Rechtefehler.
// Die uebrigen Tests lesen fast nur einzelne Dokumente; dieser hier stellt
// die Abfragen so, wie index.html und kalender.html sie stellen.
//
// Der Betreiber (SuperAdmin) merkt solche Fehler selbst nie: Fuer ihn sind
// alle Lesezugriffe erlaubt. Deshalb laufen alle Proben mit normalen Konten.
//
// Starten:  cd tests && npm run test:abfragen

import {
  initializeTestEnvironment, assertSucceeds, assertFails,
} from '@firebase/rules-unit-testing';
import { doc, getDocs, setDoc, collection, query, where } from 'firebase/firestore';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const REGELN = process.env.REGELN
  || join(dirname(fileURLToPath(import.meta.url)), '..', 'firestore.rules');

const SCHULE = 'schule-uid';     // Inhaber = Fahrschul-ID
const LEHRER = 'lehrer-uid';     // freigegebenes Mitglied, hat eigene Altdaten mitgebracht
const KOLLEGE = 'kollege-uid';   // zweites Mitglied
const SOLO   = 'solo-uid';       // eigenstaendiger Fahrlehrer
const FREMD  = 'fremd-uid';      // andere Fahrschule

const testEnv = await initializeTestEnvironment({
  projectId: 'fahrsync-abfragen',
  firestore: { rules: readFileSync(REGELN, 'utf8'), host: '127.0.0.1', port: 8089 },
});

await testEnv.withSecurityRulesDisabled(async (ctx) => {
  const db = ctx.firestore();
  const s = (p, d) => setDoc(doc(db, p), d);
  await s(`fahrschulen/${SCHULE}`, { name: 'Schule', adminUid: SCHULE, status: 'aktiv', fahrschulCode: 'FS-AAAA' });
  await s(`fahrschulen/${FREMD}`,  { name: 'Fremd',  adminUid: FREMD,  status: 'aktiv', fahrschulCode: 'FS-BBBB' });
  await s(`users/${SCHULE}`,  { uid: SCHULE,  rolle: 'fahrschul-admin', typ: 'fahrschule', status: 'aktiv', fahrschuleId: SCHULE });
  await s(`users/${FREMD}`,   { uid: FREMD,   rolle: 'fahrschul-admin', typ: 'fahrschule', status: 'aktiv', fahrschuleId: FREMD });
  await s(`users/${LEHRER}`,  { uid: LEHRER,  rolle: 'fahrlehrer', status: 'aktiv', fahrschuleId: SCHULE });
  await s(`users/${KOLLEGE}`, { uid: KOLLEGE, rolle: 'fahrlehrer', status: 'aktiv', fahrschuleId: SCHULE });
  await s(`users/${SOLO}`,    { uid: SOLO,    rolle: 'fahrlehrer', status: 'aktiv', fahrschuleId: SOLO });
  await s(`kalenderUsers/${SCHULE}`,  { uid: SCHULE,  schoolId: SCHULE, role: 'admin',  approved: true });
  await s(`kalenderUsers/${LEHRER}`,  { uid: LEHRER,  schoolId: SCHULE, role: 'lehrer', approved: true });
  await s(`kalenderUsers/${KOLLEGE}`, { uid: KOLLEGE, schoolId: SCHULE, role: 'lehrer', approved: true });
  await s(`kalenderUsers/${SOLO}`,    { uid: SOLO,    schoolId: SOLO,   role: 'lehrer', approved: true });
  await s(`kalenderUsers/${FREMD}`,   { uid: FREMD,   schoolId: FREMD,  role: 'admin',  approved: true });

  // Kartei: von jeder Datenform ein Satz
  await s('students/s1', { uid: LEHRER,  fahrschuleId: SCHULE, vorname: 'Anna' });
  await s('students/s2', { uid: LEHRER,  fahrschuleId: LEHRER, vorname: 'Mitgebracht' });   // noch nicht uebergeben
  await s('students/s3', { uid: SOLO,    fahrschuleId: SOLO,   vorname: 'Solo' });
  await s('students/s4', { uid: SOLO,                          vorname: 'Altbestand' });     // ohne fahrschuleId
  await s('students/s5', { uid: KOLLEGE, fahrschuleId: SCHULE, vorname: 'Vom Kollegen' });
  await s('students/s9', { uid: FREMD,   fahrschuleId: FREMD,  vorname: 'Fremd' });
  for (const c of ['customFields', 'customThemen', 'customGruppen']) {
    await s(`${c}/l1`, { uid: LEHRER, fahrschuleId: SCHULE, name: 'mit Schule' });
    await s(`${c}/l2`, { uid: LEHRER, name: 'ohne Zuordnung' });
    await s(`${c}/l3`, { uid: LEHRER, fahrschuleId: LEHRER, name: 'von frueher' });
    await s(`${c}/o1`, { uid: SOLO, fahrschuleId: SOLO, name: 'solo' });
    await s(`${c}/o2`, { uid: SOLO, name: 'solo ohne Zuordnung' });
  }
  await s('protokoll/p1', { uid: LEHRER, fahrschuleId: SCHULE, studentId: 's1', notiz: 'x' });
  await s('protokoll/p2', { uid: LEHRER, studentId: 's2', notiz: 'alt' });
  await s('protokoll/p3', { uid: SOLO, fahrschuleId: SOLO, studentId: 's3', notiz: 'x' });
  await s('protokoll/p4', { uid: SOLO, studentId: 's4', notiz: 'alt' });
  await s('accessCodes/CODELEHRER', { code: 'CODELEHRER', teacherUid: LEHRER, studentId: 's1', expiresAt: Date.now() + 9e8, messages: [] });
  await s('accessCodes/CODESOLO',   { code: 'CODESOLO',   teacherUid: SOLO,   studentId: 's3', expiresAt: Date.now() + 9e8, messages: [] });
  await s('invites/inv1', { fahrschuleId: SCHULE, fahrschulCode: 'FS-AAAA', used: false });
  await s('rechnungen/r1', { empfaengerId: SCHULE, nummer: 'RE-1' });

  // Kalender
  await s('slots/sl1', { lehrerUid: LEHRER,  schoolId: SCHULE, bookedBy: 'k1' });
  await s('slots/sl2', { lehrerUid: LEHRER,  schoolId: LEHRER });      // aus der Zeit vor dem Beitritt
  await s('slots/sl3', { lehrerUid: SCHULE,  schoolId: SCHULE });
  await s('slots/sl4', { lehrerUid: SOLO,    schoolId: SOLO });
  await s('slots/sl5', { lehrerUid: SOLO });                           // Altbestand ohne schoolId
  await s('slots/sl6', { lehrerUid: KOLLEGE, schoolId: SCHULE });
  await s('slots/sl9', { lehrerUid: FREMD,   schoolId: FREMD });
  await s('schueler/k1', { lehrerUid: LEHRER,  schoolId: SCHULE, fname: 'Anna' });
  await s('schueler/k2', { lehrerUid: LEHRER,  schoolId: LEHRER, fname: 'Mitgebracht' });
  await s('schueler/k3', { lehrerUid: SOLO,    schoolId: SOLO,   fname: 'Solo' });
  await s('schueler/k4', { lehrerUid: null,    schoolId: SCHULE, fname: 'Ohne Lehrer' });
  await s('schueler/k5', { lehrerUid: KOLLEGE, schoolId: SCHULE, fname: 'Vom Kollegen' });
  await s('schueler/k9', { lehrerUid: FREMD,   schoolId: FREMD,  fname: 'Fremd' });
  await s('autos/a1', { schoolId: SCHULE, modell: 'Golf' });
  await s('autos/a2', { schoolId: SOLO, modell: 'Polo' });
  await s('urlaub/u1', { lehrerUid: LEHRER, schoolId: SCHULE, von: '2026-12-01', bis: '2026-12-05' });
  await s('urlaub/u2', { lehrerUid: SOLO, schoolId: SOLO, von: '2026-12-01', bis: '2026-12-05' });
  await s('blocked/b1', { lehrerUid: LEHRER, schoolId: SCHULE, year: 2026, month: 11, day: 1 });
  await s('blocked/b2', { lehrerUid: SOLO, schoolId: SOLO, year: 2026, month: 11, day: 1 });
  await s('globalBlocked/g1', { schoolId: SCHULE, year: 2026, month: 11, day: 24 });
  await s('notizen/n1', { schuelerId: 'k1', lehrerUid: LEHRER, schoolId: SCHULE, text: 'x' });
  await s('pruefungen/pr1', { schuelerId: 'k1', schoolId: SCHULE, eingetragenVon: LEHRER });
  await s('theorieStunden/t1', { schuelerId: 'k1', lehrerUid: LEHRER, schoolId: SCHULE, thema: '1' });
  await s('theorieStunden/t2', { schuelerId: 'k3', lehrerUid: SOLO, schoolId: SOLO, thema: '1' });
  await s('warteliste/w1', { lehrerUid: LEHRER, schoolId: SCHULE });
  await s('bookingRequests/br1', { lehrerUid: LEHRER, schuelerId: 'k1', status: 'angefragt' });
  await s('bookingMessages/bm1', { lehrerUid: LEHRER, schuelerId: 'k1', status: 'neu', text: 'x' });
  await s('bookingWaitlist/k1', { lehrerUid: LEHRER, schuelerId: 'k1', status: 'wartend' });
});

const als = (uid) => testEnv.authenticatedContext(uid, {
  email: `${uid}@test.de`, firebase: { sign_in_provider: 'password' },
}).firestore();

let bestanden = 0, fehlgeschlagen = 0;
async function pruefe(beschreibung, fn) {
  try { await fn(); bestanden++; console.log('  ✓', beschreibung); }
  catch (e) { fehlgeschlagen++; console.log('  ✗', beschreibung, '\n      ->', String(e.message).split('\n')[0]); }
}
// Abfrage muss durchgehen und (mindestens) die erwartete Zahl liefern
const liste = (uid, sammlung, ...filter) =>
  getDocs(query(collection(als(uid), sammlung), ...filter.map(([f, w]) => where(f, '==', w))));
async function geht(text, uid, sammlung, filter, mindestens = 1) {
  await pruefe(text, async () => {
    const snap = await assertSucceeds(liste(uid, sammlung, ...filter));
    if (snap.size < mindestens) throw new Error(`nur ${snap.size} statt mindestens ${mindestens} Treffer`);
  });
}
async function gehtNicht(text, uid, sammlung, filter) {
  await pruefe(text, () => assertFails(liste(uid, sammlung, ...filter)));
}

console.log('\nKARTEI — Mitglied einer Fahrschule (index.html)');
await geht('Schuelerliste der Schule (fahrschuleId)',            LEHRER, 'students', [['fahrschuleId', SCHULE]], 2);
await geht('eigene, mitgebrachte Schueler (uid)',                LEHRER, 'students', [['uid', LEHRER]], 2);
await geht('eigene Felder (customFields nach uid)',              LEHRER, 'customFields', [['uid', LEHRER]], 3);
await geht('eigene Themen (customThemen nach uid)',              LEHRER, 'customThemen', [['uid', LEHRER]], 3);
await geht('eigene Gruppen (customGruppen nach uid)',            LEHRER, 'customGruppen', [['uid', LEHRER]], 3);
await geht('Protokoll eines Schuelers (studentId + uid)',        LEHRER, 'protokoll', [['studentId', 's1'], ['uid', LEHRER]]);
await geht('Protokoll eines Altschuelers (studentId + uid)',     LEHRER, 'protokoll', [['studentId', 's2'], ['uid', LEHRER]]);
await geht('Zugangscodes eines Schuelers',                       LEHRER, 'accessCodes', [['studentId', 's1'], ['teacherUid', LEHRER]]);
await geht('alle eigenen Zugangscodes (Ungelesen-Zaehler)',      LEHRER, 'accessCodes', [['teacherUid', LEHRER]]);
await geht('eigene Termine fuers Heute-Feld (slots)',            LEHRER, 'slots', [['lehrerUid', LEHRER]], 2);
await geht('eigene Kalender-Schueler',                           LEHRER, 'schueler', [['lehrerUid', LEHRER]], 2);
await geht('eigene Theorie-Eintraege (Sicherung)',               LEHRER, 'theorieStunden', [['lehrerUid', LEHRER]]);

console.log('\nKARTEI — eigenstaendiger Fahrlehrer');
await geht('Schuelerliste (fahrschuleId = eigene Kennung)',      SOLO, 'students', [['fahrschuleId', SOLO]]);
await geht('eigene Felder',                                      SOLO, 'customFields', [['uid', SOLO]], 2);
await geht('eigene Themen',                                      SOLO, 'customThemen', [['uid', SOLO]], 2);
await geht('eigene Gruppen',                                     SOLO, 'customGruppen', [['uid', SOLO]], 2);
await geht('Protokoll eines Schuelers',                          SOLO, 'protokoll', [['studentId', 's3'], ['uid', SOLO]]);
await geht('Protokoll eines Altschuelers (ohne fahrschuleId)',   SOLO, 'protokoll', [['studentId', 's4'], ['uid', SOLO]]);
await geht('Zugangscodes eines Schuelers',                       SOLO, 'accessCodes', [['studentId', 's3'], ['teacherUid', SOLO]]);
await geht('eigene Termine',                                     SOLO, 'slots', [['lehrerUid', SOLO]], 2);
await geht('eigene Kalender-Schueler',                           SOLO, 'schueler', [['lehrerUid', SOLO]]);

console.log('\nKARTEI — Inhaber');
await geht('Team zaehlen (users nach fahrschuleId)',             SCHULE, 'users', [['fahrschuleId', SCHULE]], 3);
await geht('offene Einladungen',                                 SCHULE, 'invites', [['fahrschuleId', SCHULE], ['used', false]]);
await geht('eigene Rechnungen',                                  SCHULE, 'rechnungen', [['empfaengerId', SCHULE]]);
await geht('Schuelerliste der Schule',                           SCHULE, 'students', [['fahrschuleId', SCHULE]], 2);

console.log('\nKALENDER — Mitglied (kalender.html)');
await geht('eigene Termine',                                     LEHRER, 'slots', [['lehrerUid', LEHRER]], 2);
await geht('eigene Termine eines Schuelers',                     LEHRER, 'slots', [['lehrerUid', LEHRER], ['bookedBy', 'k1']]);
await geht('eigene Schueler',                                    LEHRER, 'schueler', [['lehrerUid', LEHRER]], 2);
await geht('eigener Urlaub',                                     LEHRER, 'urlaub', [['lehrerUid', LEHRER]]);
await geht('eigene Sperrzeiten',                                 LEHRER, 'blocked', [['lehrerUid', LEHRER]]);
await geht('eigene Sperrzeiten eines Tages',                     LEHRER, 'blocked', [['lehrerUid', LEHRER], ['year', 2026], ['month', 11], ['day', 1]]);
await geht('Sperrtage der Schule',                               LEHRER, 'globalBlocked', [['schoolId', SCHULE]]);
await geht('Sperrtage der Schule an einem Tag',                  LEHRER, 'globalBlocked', [['schoolId', SCHULE], ['year', 2026], ['month', 11], ['day', 24]]);
await geht('Fuhrpark der Schule',                                LEHRER, 'autos', [['schoolId', SCHULE]]);
await geht('Notizen zu einem Schueler',                          LEHRER, 'notizen', [['schuelerId', 'k1'], ['lehrerUid', LEHRER]]);
await geht('Pruefungen eines Schuelers',                         LEHRER, 'pruefungen', [['schuelerId', 'k1'], ['schoolId', SCHULE]]);
await geht('Theorie eines Schuelers',                            LEHRER, 'theorieStunden', [['lehrerUid', LEHRER], ['schuelerId', 'k1']]);
await geht('Warteliste',                                         LEHRER, 'warteliste', [['lehrerUid', LEHRER]]);
await geht('Buchungsanfragen',                                   LEHRER, 'bookingRequests', [['lehrerUid', LEHRER]]);
await geht('Nachrichten der Buchungsseite',                      LEHRER, 'bookingMessages', [['lehrerUid', LEHRER]]);
await geht('Warteliste der Buchungsseite',                       LEHRER, 'bookingWaitlist', [['lehrerUid', LEHRER]]);

console.log('\nKALENDER — Inhaber');
await geht('Fahrlehrer der Schule',                              SCHULE, 'kalenderUsers', [['schoolId', SCHULE], ['role', 'lehrer'], ['approved', true]], 2);
await geht('alle Kalenderprofile der Schule',                    SCHULE, 'kalenderUsers', [['schoolId', SCHULE]], 3);
await geht('alle Schueler der Schule',                           SCHULE, 'schueler', [['schoolId', SCHULE]], 3);
await geht('alle Termine der Schule (Auslastung)',               SCHULE, 'slots', [['schoolId', SCHULE]], 3);
await geht('Termine eines Schuelers (Nachweis)',                 SCHULE, 'slots', [['schoolId', SCHULE], ['bookedBy', 'k1']]);
await geht('Kalender eines Fahrlehrers ansehen (lehrerUid + schoolId)', SCHULE, 'slots', [['lehrerUid', KOLLEGE], ['schoolId', SCHULE]]);
// Ohne schoolId lehnen die Regeln ab - so stellte kalender.html die Abfrage
// bis 11/2026, der Kalender eines Fahrlehrers liess sich nie oeffnen.
await gehtNicht('...ohne schoolId (alte Abfrage) wird abgelehnt', SCHULE, 'slots', [['lehrerUid', KOLLEGE]]);
await geht('Schueler eines Fahrlehrers (lehrerUid + schoolId)',  SCHULE, 'schueler', [['lehrerUid', LEHRER], ['schoolId', SCHULE]]);
await geht('Schueler eines Kollegen (lehrerUid + schoolId)',     SCHULE, 'schueler', [['lehrerUid', KOLLEGE], ['schoolId', SCHULE]]);
await geht('Sperrzeiten eines Fahrlehrers',                      SCHULE, 'blocked', [['lehrerUid', LEHRER]]);
await geht('Urlaub der Schule',                                  SCHULE, 'urlaub', [['schoolId', SCHULE]]);
await geht('Urlaub eines Fahrlehrers (lehrerUid + schoolId)',    SCHULE, 'urlaub', [['lehrerUid', LEHRER], ['schoolId', SCHULE]]);
await geht('Pruefungen der Schule',                              SCHULE, 'pruefungen', [['schoolId', SCHULE]]);
await geht('Theorie eines Schuelers (Nachweis)',                 SCHULE, 'theorieStunden', [['schoolId', SCHULE], ['schuelerId', 'k1']]);
await geht('Kartei-Akten fuer den Nachweis',                     SCHULE, 'students', [['fahrschuleId', SCHULE]], 2);

console.log('\nKALENDER — eigenstaendiger Fahrlehrer');
await geht('eigene Termine',                                     SOLO, 'slots', [['lehrerUid', SOLO]], 2);
await geht('eigene Schueler',                                    SOLO, 'schueler', [['lehrerUid', SOLO]]);
await geht('eigener Fuhrpark',                                   SOLO, 'autos', [['schoolId', SOLO]]);
await geht('eigener Urlaub',                                     SOLO, 'urlaub', [['lehrerUid', SOLO]]);
await geht('eigene Sperrzeiten',                                 SOLO, 'blocked', [['lehrerUid', SOLO]]);
await geht('Theorie eines Schuelers (Nachweis)',                 SOLO, 'theorieStunden', [['lehrerUid', SOLO], ['schuelerId', 'k3']]);

console.log('\nGEGENPROBE — fremde Schule bleibt zu');
await gehtNicht('fremde Schuelerliste',                          LEHRER, 'students', [['fahrschuleId', FREMD]]);
await gehtNicht('fremde Kalender-Schueler',                      LEHRER, 'schueler', [['schoolId', FREMD]]);
await gehtNicht('fremde Termine ueber die Schule',               SCHULE, 'slots', [['schoolId', FREMD]]);
await gehtNicht('fremde Termine ueber den Lehrer',               SCHULE, 'slots', [['lehrerUid', FREMD]]);
await gehtNicht('fremde Kalenderprofile',                        SOLO, 'kalenderUsers', [['schoolId', SCHULE]]);
await gehtNicht('fremdes Protokoll',                             SOLO, 'protokoll', [['studentId', 's1'], ['uid', LEHRER]]);
await gehtNicht('fremde Zugangscodes',                           SOLO, 'accessCodes', [['teacherUid', LEHRER]]);

await testEnv.cleanup();
console.log(`\n${bestanden} bestanden, ${fehlgeschlagen} fehlgeschlagen\n`);
process.exit(fehlgeschlagen > 0 ? 1 : 0);
