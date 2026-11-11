// Buchungslink, Inhaber als Fahrlehrer, Mail-Einstellungen - gegen den
// Firestore-Emulator.
//
// Anlass (11/2026), vier Dinge standen sich im Weg:
//   1. Der Inhaber hatte im Kalender nur Verwaltungs-Seiten. Jetzt nutzt er
//      zusaetzlich die Fahrlehrer-Seiten - die Regeln muessen das tragen.
//   2. Der 🔗-Knopf in der Schuelerliste des Inhabers kopierte nur die
//      Adresse. Die Buchungsseite braucht aber bookingStudents (Vorname,
//      Fahrlehrer) und bookingLinks (freie Termine) - beides durfte nur der
//      Fahrlehrer selbst anlegen. Warteliste und Nachrichten wurden deshalb
//      abgelehnt.
//   3. Nach einem Wechsel des Fahrlehrers gehoerte bookingStudents weiter dem
//      alten - der neue konnte den Link nie mehr teilen.
//   4. Die Mail-Warteschlange wird nicht mehr beschrieben; die Zugangsdaten
//      des Postfachs darf KEIN Browser lesen, auch der Betreiber nicht.
//
// Wie immer zaehlen die Gegenproben genauso wie die Verbote.
//
// Starten:  cd tests && npm test

import {
  initializeTestEnvironment, assertSucceeds, assertFails,
} from '@firebase/rules-unit-testing';
import {
  doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc, addDoc, collection, query, where, serverTimestamp,
} from 'firebase/firestore';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const REGELN = process.env.REGELN
  || join(dirname(fileURLToPath(import.meta.url)), '..', 'firestore.rules');

const SCHULE = 'inhaber-uid';     // Inhaber = Fahrschul-ID, faehrt selbst
const LEHRER = 'lehrer-eins';     // freigeschaltetes Mitglied
const NEU    = 'lehrer-zwei';     // freigeschaltetes Mitglied (uebernimmt einen Schueler)
const WARTET = 'lehrer-wartet';   // beigetreten, nicht freigeschaltet
const EX     = 'lehrer-ex';       // ausgetreten (Kalender-Profil zeigt noch auf die Schule)
const FREMD  = 'fremde-schule';   // Inhaber einer ANDEREN Fahrschule

const testEnv = await initializeTestEnvironment({
  projectId: 'fahrsync-buchungslink',
  firestore: { rules: readFileSync(REGELN, 'utf8'), host: '127.0.0.1', port: 8089 },
});

await testEnv.withSecurityRulesDisabled(async (ctx) => {
  const db = ctx.firestore();
  const s = (p, d) => setDoc(doc(db, p), d);
  for (const id of [SCHULE, FREMD]) {
    await s(`fahrschulen/${id}`, { name: 'Schule ' + id, adminUid: id, status: 'aktiv', abo: 'free', kalenderAktiv: true });
    await s(`users/${id}`, { uid: id, rolle: 'fahrschul-admin', status: 'aktiv', fahrschuleId: id });
    await s(`kalenderUsers/${id}`, { uid: id, role: 'admin', approved: true, schoolId: id, fname: 'Inhaber', lname: id });
  }
  await s(`users/${LEHRER}`, { uid: LEHRER, rolle: 'fahrlehrer', status: 'aktiv', fahrschuleId: SCHULE });
  await s(`users/${NEU}`,    { uid: NEU,    rolle: 'fahrlehrer', status: 'aktiv', fahrschuleId: SCHULE });
  await s(`users/${WARTET}`, { uid: WARTET, rolle: 'fahrlehrer', status: 'ausstehend', fahrschuleId: SCHULE });
  await s(`users/${EX}`,     { uid: EX,     rolle: 'fahrlehrer', status: 'aktiv', fahrschuleId: EX });
  for (const id of [LEHRER, NEU, WARTET, EX]) {
    await s(`kalenderUsers/${id}`, { uid: id, role: 'lehrer', approved: true, schoolId: SCHULE, fname: 'Lehrer', lname: id });
  }
  // Kalender-Schueler
  await s('schueler/sch1', { schoolId: SCHULE, lehrerUid: LEHRER, fname: 'Mia', lname: 'M', email: 'mia@example.org' });
  await s('schueler/sch2', { schoolId: SCHULE, lehrerUid: NEU, fname: 'Noah', lname: 'N' });   // frueher bei LEHRER
  await s('schueler/sch3', { schoolId: SCHULE, lehrerUid: null, fname: 'Ole', lname: 'O' });   // ohne Fahrlehrer
  await s('schueler/sch4', { schoolId: SCHULE, lehrerUid: LEHRER, fname: 'Pia', lname: 'P' });
  await s('schueler/sch5', { schoolId: SCHULE, lehrerUid: SCHULE, fname: 'Quin', lname: 'Q' }); // Schueler des Inhabers
  await s('schueler/schFremd', { schoolId: FREMD, lehrerUid: FREMD, fname: 'Rosa', lname: 'R' });
  // Buchungsseiten-Dokumente im Altzustand
  await s('bookingStudents/sch2', { lehrerUid: LEHRER, vorname: 'Noah', meineTermine: [] });  // gehoert noch dem alten Lehrer
  await s('bookingStudents/sch4', { bookedCount: 2 });                                        // nur Zaehler, ohne lehrerUid
  await s(`bookingLinks/${NEU}`, { lehrerUid: NEU, schoolId: SCHULE, aktiv: false, freieSlots: [] });
  // Termine
  await s('slots/t-lehrer', { schoolId: SCHULE, lehrerUid: LEHRER, bookedBy: 'sch1', bookedAt: 1 });
  await s('slots/t-inhaber', { schoolId: SCHULE, lehrerUid: SCHULE, bookedBy: 'sch5', bookedAt: 1 });
  await s('urlaub/u-lehrer', { schoolId: SCHULE, lehrerUid: LEHRER, von: '2026-12-01', bis: '2026-12-05' });
  await s('blocked/b-lehrer', { schoolId: SCHULE, lehrerUid: LEHRER, year: 2026, month: 11, day: 3 });
  await s('settings/kalenderMail', { aktiv: true });
  await s('serverEinstellungen/mail', { host: 'smtp.example.org', port: 465, benutzer: 'x', passwort: 'geheim', absender: 'a@example.org', aktiv: true });
  await s('mailQueue/alt1', { type: 'stornierung_freigeworden', status: 'pending' });
});

const als = (uid) => testEnv.authenticatedContext(uid, {
  email: `${uid}@test.de`, firebase: { sign_in_provider: 'password' },
}).firestore();
const ohneAnmeldung = () => testEnv.unauthenticatedContext().firestore();
const betreiber = () => testEnv.authenticatedContext('chef', {
  email: 'chriskoo@mail.de', firebase: { sign_in_provider: 'password' },
}).firestore();

let bestanden = 0, fehlgeschlagen = 0;
async function pruefe(beschreibung, fn) {
  try { await fn(); bestanden++; console.log('  ✓', beschreibung); }
  catch (e) { fehlgeschlagen++; console.log('  ✗', beschreibung, '\n      ->', String(e.message).split('\n')[0]); }
}
const bs = (lehrerUid, vorname = 'Mia') => ({ vorname, lehrerUid, aktiv: true, updatedAt: Date.now() });
const link = (lehrerUid, schoolId = SCHULE) => ({
  lehrerUid, lehrerName: 'Lehrer', schoolName: 'Schule', schoolId, freieSlots: [], aktiv: true, updatedAt: Date.now(),
});

// ─────────────────────────────────────────────────────────────────────
console.log('\nBUCHUNGSLINK DURCH DEN INHABER — 🔗 in der Schuelerliste');
await pruefe('Inhaber legt die Buchungsseite fuer den Schueler seines Fahrlehrers an', async () => {
  await assertSucceeds(setDoc(doc(als(SCHULE), 'bookingStudents', 'sch1'), bs(LEHRER), { merge: true }));
});
await pruefe('...und traegt dessen gebuchte Termine nach', async () => {
  await assertSucceeds(setDoc(doc(als(SCHULE), 'bookingStudents', 'sch1'),
    { lehrerUid: LEHRER, meineTermine: [{ id: 't-lehrer', start: '2026-12-01T09:00:00.000Z', ende: '2026-12-01T10:30:00.000Z', type: 'normal' }],
      maxAktiveTermine: 0, maxFahrstunden: 0, bookedCount: 1, updatedAt: Date.now(), vorname: 'Mia' }, { merge: true }));
});
await pruefe('Inhaber veroeffentlicht die freien Termine seines Fahrlehrers', async () => {
  await assertSucceeds(setDoc(doc(als(SCHULE), 'bookingLinks', LEHRER), link(LEHRER), { merge: true }));
});
await pruefe('...liest dafuer dessen Termine (lehrerUid + schoolId)', async () => {
  const snap = await assertSucceeds(getDocs(query(collection(als(SCHULE), 'slots'), where('lehrerUid', '==', LEHRER), where('schoolId', '==', SCHULE))));
  if (snap.size < 1) throw new Error('kein Termin gefunden');
});
await pruefe('...dessen Urlaub (lehrerUid + schoolId)', async () => {
  const snap = await assertSucceeds(getDocs(query(collection(als(SCHULE), 'urlaub'), where('lehrerUid', '==', LEHRER), where('schoolId', '==', SCHULE))));
  if (snap.size < 1) throw new Error('kein Urlaub gefunden');
});
await pruefe('...und dessen Sperrzeiten (lehrerUid)', async () => {
  const snap = await assertSucceeds(getDocs(query(collection(als(SCHULE), 'blocked'), where('lehrerUid', '==', LEHRER))));
  if (snap.size < 1) throw new Error('keine Sperre gefunden');
});
await pruefe('Danach geht die Warteliste des Schuelers (ohne Login)', async () => {
  await assertSucceeds(setDoc(doc(ohneAnmeldung(), 'bookingWaitlist', 'sch1'),
    { lehrerUid: LEHRER, schuelerId: 'sch1', vorname: 'Mia', notiz: '', status: 'wartend', createdAt: Date.now() }));
});
await pruefe('...und seine Nachricht an den Fahrlehrer (ohne Login)', async () => {
  await assertSucceeds(setDoc(doc(ohneAnmeldung(), 'bookingMessages', 'Nn1oOp2qQr3sSt4uUv5w'),
    { lehrerUid: LEHRER, schuelerId: 'sch1', vorname: 'Mia', text: 'Hallo', status: 'neu', createdAt: Date.now() }));
});
await pruefe('Schueler (ohne Login) passt weiter nur seine Terminliste an', async () => {
  await assertSucceeds(updateDoc(doc(ohneAnmeldung(), 'bookingStudents', 'sch1'), { meineTermine: [], updatedAt: Date.now() }));
});
await pruefe('Inhaber teilt den Link fuer seinen EIGENEN Schueler wie jeder Fahrlehrer', async () => {
  await assertSucceeds(setDoc(doc(als(SCHULE), 'bookingStudents', 'sch5'), bs(SCHULE, 'Quin'), { merge: true }));
  await assertSucceeds(setDoc(doc(als(SCHULE), 'bookingLinks', SCHULE), link(SCHULE), { merge: true }));
});

console.log('\n...UND WAS DABEI NICHT GEHEN DARF');
await pruefe('Inhaber haengt den Schueler an einen ANDEREN als den zugeordneten Fahrlehrer NICHT', async () => {
  await assertFails(setDoc(doc(als(SCHULE), 'bookingStudents', 'sch4'), bs(NEU, 'Pia'), { merge: true }));
});
await pruefe('Inhaber legt fuer einen Schueler OHNE Fahrlehrer nichts an', async () => {
  await assertFails(setDoc(doc(als(SCHULE), 'bookingStudents', 'sch3'), { vorname: 'Ole', lehrerUid: null, aktiv: true }, { merge: true }));
});
await pruefe('Inhaber einer FREMDEN Schule legt fuer diesen Schueler nichts an', async () => {
  await assertFails(setDoc(doc(als(FREMD), 'bookingStudents', 'sch4'), bs(LEHRER, 'Pia'), { merge: true }));
});
await pruefe('...und aendert die Buchungsseite des Schuelers NICHT', async () => {
  await assertFails(setDoc(doc(als(FREMD), 'bookingStudents', 'sch1'), bs(LEHRER, 'Boese'), { merge: true }));
});
await pruefe('Kollege (kein Inhaber) veroeffentlicht die Termine eines anderen NICHT', async () => {
  await assertFails(setDoc(doc(als(LEHRER), 'bookingLinks', NEU), link(NEU), { merge: true }));
});
await pruefe('Inhaber veroeffentlicht NICHT fuer einen ausgetretenen Fahrlehrer', async () => {
  await assertFails(setDoc(doc(als(SCHULE), 'bookingLinks', EX), link(EX), { merge: true }));
});
await pruefe('...NICHT fuer einen noch nicht freigeschalteten', async () => {
  await assertFails(setDoc(doc(als(SCHULE), 'bookingLinks', WARTET), link(WARTET), { merge: true }));
});
await pruefe('...NICHT fuer den Inhaber einer fremden Schule', async () => {
  await assertFails(setDoc(doc(als(SCHULE), 'bookingLinks', FREMD), link(FREMD), { merge: true }));
});
await pruefe('Fremder Inhaber veroeffentlicht NICHT fuer den Fahrlehrer dieser Schule', async () => {
  await assertFails(setDoc(doc(als(FREMD), 'bookingLinks', LEHRER), link(LEHRER, FREMD), { merge: true }));
});
await pruefe('Inhaber schreibt den Link nicht unter einer fremden Schul-Kennung', async () => {
  await assertFails(setDoc(doc(als(SCHULE), 'bookingLinks', LEHRER), link(LEHRER, FREMD), { merge: true }));
});
await pruefe('Inhaber loescht den Buchungslink seines Fahrlehrers NICHT', async () => {
  await assertFails(deleteDoc(doc(als(SCHULE), 'bookingLinks', LEHRER)));
});

console.log('\nFAHRLEHRER-WECHSEL — der neue Fahrlehrer uebernimmt die Buchungsseite');
await pruefe('Neuer Fahrlehrer uebernimmt das Dokument des alten', async () => {
  await assertSucceeds(setDoc(doc(als(NEU), 'bookingStudents', 'sch2'), bs(NEU, 'Noah'), { merge: true }));
});
await pruefe('Alter Fahrlehrer holt es sich NICHT zurueck', async () => {
  await assertFails(setDoc(doc(als(LEHRER), 'bookingStudents', 'sch2'), bs(LEHRER, 'Noah'), { merge: true }));
});
await pruefe('Ausgetretener uebernimmt die Buchungsseite eines Schul-Schuelers NICHT', async () => {
  await assertFails(setDoc(doc(als(EX), 'bookingStudents', 'sch1'), bs(EX), { merge: true }));
});
await pruefe('Dokument nur mit Zaehler (ohne lehrerUid): zugeordneter Fahrlehrer uebernimmt', async () => {
  await assertSucceeds(setDoc(doc(als(LEHRER), 'bookingStudents', 'sch4'), bs(LEHRER, 'Pia'), { merge: true }));
});
await pruefe('Inhaber zieht nach dem Wechsel die Buchungsseite auf den neuen Fahrlehrer nach', async () => {
  await assertSucceeds(setDoc(doc(als(SCHULE), 'bookingStudents', 'sch2'), { vorname: 'Noah', lehrerUid: NEU, updatedAt: Date.now() }, { merge: true }));
});

console.log('\nINHABER ALS FAHRLEHRER — die Fahrlehrer-Seiten mit dem Konto des Inhabers');
await pruefe('Eigenen Zeitslot anlegen', async () => {
  await assertSucceeds(addDoc(collection(als(SCHULE), 'slots'),
    { lehrerUid: SCHULE, type: 'normal', bookedBy: null, schoolId: SCHULE, auto: true, createdAt: Date.now() }));
});
await pruefe('Eigene Termine listen (nur lehrerUid)', async () => {
  const snap = await assertSucceeds(getDocs(query(collection(als(SCHULE), 'slots'), where('lehrerUid', '==', SCHULE))));
  if (snap.size < 1) throw new Error('kein Termin gefunden');
});
await pruefe('Eigene Schueler listen (nur lehrerUid)', async () => {
  const snap = await assertSucceeds(getDocs(query(collection(als(SCHULE), 'schueler'), where('lehrerUid', '==', SCHULE))));
  if (snap.size < 1) throw new Error('kein Schueler gefunden');
});
await pruefe('Eigene Buchungsanfragen, Nachrichten und Warteliste listen', async () => {
  for (const c of ['bookingRequests', 'bookingMessages', 'bookingWaitlist']) {
    await assertSucceeds(getDocs(query(collection(als(SCHULE), c), where('lehrerUid', '==', SCHULE))));
  }
});
await pruefe('Eigenen Schueler anlegen (immer erlaubt, er ist der Inhaber)', async () => {
  await assertSucceeds(addDoc(collection(als(SCHULE), 'schueler'),
    { fname: 'Sam', lname: 'S', email: '', tel: '', lehrerUid: SCHULE, maxFahrstunden: 0, maxAktiveTermine: 0, bookedCount: 0, schoolId: SCHULE, createdAt: Date.now() }));
});
await pruefe('Theorie: alle Schueler der Schule listen und Unterricht eintragen', async () => {
  const snap = await assertSucceeds(getDocs(query(collection(als(SCHULE), 'schueler'), where('schoolId', '==', SCHULE))));
  if (snap.size < 5) throw new Error('zu wenige Schueler: ' + snap.size);
  await assertSucceeds(addDoc(collection(als(SCHULE), 'theorieStunden'),
    { schuelerId: 'sch1', lehrerUid: SCHULE, schoolId: SCHULE, art: 'grund', datum: '2026-11-11', thema: '1', themaTitel: 'x', minuten: 90, createdAt: Date.now() }));
});

console.log('\nSTORNIEREN — Marken fuer die Benachrichtigung');
await pruefe('Inhaber sagt eigenen Termin ab (absageAm)', async () => {
  await assertSucceeds(updateDoc(doc(als(SCHULE), 'slots', 't-inhaber'), { bookedBy: null, bookedAt: null, absageAm: serverTimestamp() }));
});
await pruefe('Fahrlehrer storniert und loescht (absageAm + wirdGeloescht)', async () => {
  await assertSucceeds(updateDoc(doc(als(LEHRER), 'slots', 't-lehrer'),
    { bookedBy: null, bookedAt: null, absageAm: serverTimestamp(), wirdGeloescht: true }));
  await assertSucceeds(deleteDoc(doc(als(LEHRER), 'slots', 't-lehrer')));
});

console.log('\nE-MAIL — nichts davon gehoert in einen Browser');
await pruefe('Mail-Warteschlange: Fahrlehrer legt NICHTS mehr ab', async () => {
  await assertFails(addDoc(collection(als(LEHRER), 'mailQueue'), { type: 'stornierung_freigeworden', payload: {}, status: 'pending', createdAt: Date.now() }));
});
await pruefe('...und liest den Altbestand NICHT', async () => {
  await assertFails(getDoc(doc(als(LEHRER), 'mailQueue', 'alt1')));
});
await pruefe('Postfach-Zugangsdaten: Inhaber liest NICHT', async () => {
  await assertFails(getDoc(doc(als(SCHULE), 'serverEinstellungen', 'mail')));
});
await pruefe('...der BETREIBER liest sie im Browser auch NICHT', async () => {
  await assertFails(getDoc(doc(betreiber(), 'serverEinstellungen', 'mail')));
});
await pruefe('...niemand listet die Sammlung', async () => {
  await assertFails(getDocs(collection(betreiber(), 'serverEinstellungen')));
});
await pruefe('...und niemand schreibt sie aus dem Browser', async () => {
  await assertFails(setDoc(doc(betreiber(), 'serverEinstellungen', 'mail'), { host: 'boese.example.org' }, { merge: true }));
  await assertFails(setDoc(doc(als(SCHULE), 'serverEinstellungen', 'mail'), { aktiv: false }, { merge: true }));
});
await pruefe('Marke "Versand ist an": Fahrlehrer liest', async () => {
  await assertSucceeds(getDoc(doc(als(LEHRER), 'settings', 'kalenderMail')));
});
await pruefe('...schreibt sie aber NICHT', async () => {
  await assertFails(setDoc(doc(als(LEHRER), 'settings', 'kalenderMail'), { aktiv: false }));
});

await testEnv.cleanup();
console.log(`\n${bestanden} bestanden, ${fehlgeschlagen} fehlgeschlagen\n`);
process.exit(fehlgeschlagen > 0 ? 1 : 0);
