// Gekuendigte Abos: 14 Tage Nachlauf, dann 'free' - gegen den Emulator.
//
// Vorher erfuhr die App von einer Kuendigung bei PayPal oder Stripe nichts;
// der bezahlte Tarif blieb fuer immer stehen. Jetzt merken die Webhooks die
// Kuendigung vor, und der naechtliche Job stellt nach 14 Tagen um
// (functions/abo.js).
//
// Was hier vor allem geprueft wird, ist, was NICHT passieren darf:
//   - dass Daten verloren gehen (nur der Tarif aendert sich)
//   - dass ein NEU abgeschlossenes Abo von einer alten Kuendigung erwischt wird
//   - dass eine wiederholt zugestellte Meldung das Ende nach hinten schiebt
//
// Starten:  cd tests && npm run test:abo

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const hier = dirname(fileURLToPath(import.meta.url));

process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8089';
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'fahrsync-abo';

const ausFunctions = createRequire(join(hier, '..', 'functions', 'package.json'));
const { initializeApp } = ausFunctions('firebase-admin/app');
const { getFirestore } = ausFunctions('firebase-admin/firestore');
initializeApp({ projectId: process.env.GCLOUD_PROJECT });
const db = getFirestore();

const { kuendigungVormerken, kuendigungAufheben, abgelaufeneAbosBeenden } =
  require(join(hier, '..', 'functions', 'abo.js'));

const TAG = 86400000;
const T0 = Date.UTC(2026, 9, 1, 10, 0, 0);

let ok = 0, schlecht = 0;
async function pruefe(text, fn) {
  try { await fn(); ok++; console.log('  ✓', text); }
  catch (e) { schlecht++; console.log('  ✗', text, '\n      ->', String(e.message).split('\n')[0]); }
}
const gleich = (a, b, was) => { if (a !== b) throw new Error(`${was}: ${a} statt ${b}`); };
const lies = async (p) => (await db.doc(p).get()).data();

await db.doc('users/solo').set({
  name: 'Solo', fahrschuleId: 'solo', abo: 'solo', aboMaxLehrer: 1, aboPlaner: true,
  aboStatus: 'aktiv', aboSubscriptionId: 'I-SOLO', aboZahlungsart: 'paypal',
  rechnungsStrasse: 'Bahnhofstr. 1',
});
await db.doc('fahrschulen/schule').set({
  name: 'Schule', abo: 'bis10', aboMaxLehrer: 10, aboStatus: 'aktiv',
  aboSubscriptionId: 'sub_SCHULE', aboZahlungsart: 'stripe',
});
await db.doc('students/s1').set({ uid: 'solo', fahrschuleId: 'solo', vorname: 'Lena' });

console.log('\nKUENDIGUNG VORMERKEN');
await pruefe('PayPal meldet Kuendigung -> 14 Tage Nachlauf vorgemerkt', async () => {
  const r = await kuendigungVormerken(db, 'I-SOLO', T0, 'paypal');
  gleich(r.ergebnis, 'vorgemerkt', 'Ergebnis');
  const d = await lies('users/solo');
  gleich(d.aboStatus, 'gekuendigt', 'aboStatus');
  gleich(d.aboEndetAm, T0 + 14 * TAG, 'aboEndetAm');
  gleich(d.abo, 'solo', 'Tarif bleibt waehrend des Nachlaufs');
});
await pruefe('Wiederholte Meldung 5 Tage spaeter schiebt das Ende NICHT nach hinten', async () => {
  const r = await kuendigungVormerken(db, 'I-SOLO', T0 + 5 * TAG, 'paypal');
  gleich(r.ergebnis, 'schon-vorgemerkt', 'Ergebnis');
  gleich((await lies('users/solo')).aboEndetAm, T0 + 14 * TAG, 'aboEndetAm');
});
await pruefe('Unbekannte Abo-Kennung aendert nichts', async () => {
  gleich((await kuendigungVormerken(db, 'I-GIBTSNICHT', T0)).ergebnis, 'kein-treffer', 'Ergebnis');
});
await pruefe('Stripe-Kuendigung bei einer Fahrschule wird vorgemerkt', async () => {
  gleich((await kuendigungVormerken(db, 'sub_SCHULE', T0, 'stripe')).ergebnis, 'vorgemerkt', 'Ergebnis');
});

console.log('\nNACH 14 TAGEN');
await pruefe('Nach 13 Tagen passiert noch nichts', async () => {
  const r = await abgelaufeneAbosBeenden(db, T0 + 13 * TAG);
  gleich(r.beendet, 0, 'beendet');
  gleich((await lies('users/solo')).abo, 'solo', 'Tarif');
});
await pruefe('Nach 14 Tagen: Tarif auf free', async () => {
  const r = await abgelaufeneAbosBeenden(db, T0 + 14 * TAG);
  gleich(r.beendet, 2, 'beendet');
  const d = await lies('users/solo');
  gleich(d.abo, 'free', 'abo');
  gleich(d.aboStatus, 'beendet', 'aboStatus');
  gleich(d.aboPlaner, false, 'aboPlaner');
  gleich('aboMaxLehrer' in d, false, 'aboMaxLehrer entfernt');
  gleich('aboEndetAm' in d, false, 'Vormerkung entfernt');
  gleich((await lies('fahrschulen/schule')).abo, 'free', 'Fahrschule');
});
await pruefe('...alte Abo-Kennung beiseitegelegt (keine Rechnung, keine Doppel-Kuendigung)', async () => {
  const d = await lies('users/solo');
  gleich('aboSubscriptionId' in d, false, 'aboSubscriptionId entfernt');
  gleich(d.aboVorherigeSubscriptionId, 'I-SOLO', 'aboVorherigeSubscriptionId');
});
await pruefe('...und es geht NICHTS verloren: Profil, Rechnungsadresse, Schueler', async () => {
  const d = await lies('users/solo');
  gleich(d.name, 'Solo', 'name');
  gleich(d.rechnungsStrasse, 'Bahnhofstr. 1', 'Rechnungsadresse');
  gleich((await lies('students/s1')).vorname, 'Lena', 'Schueler');
});
await pruefe('Ein zweiter Lauf aendert nichts mehr', async () => {
  gleich((await abgelaufeneAbosBeenden(db, T0 + 20 * TAG)).beendet, 0, 'beendet');
});

console.log('\nNEUES ABO NACH DER KUENDIGUNG');
await db.doc('users/wechsler').set({
  abo: 'solo', aboStatus: 'aktiv', aboSubscriptionId: 'I-ALT', fahrschuleId: 'wechsler',
});
await kuendigungVormerken(db, 'I-ALT', T0);
// Kunde schliesst innerhalb der 14 Tage ein neues Abo ab (andere Kennung).
await db.doc('users/wechsler').update({ abo: 'bis5', aboSubscriptionId: 'I-NEU', aboStatus: 'aktiv' });
await pruefe('Das neue Abo wird nach 14 Tagen NICHT auf free gestellt', async () => {
  const r = await abgelaufeneAbosBeenden(db, T0 + 15 * TAG);
  gleich(r.beendet, 0, 'beendet');
  const d = await lies('users/wechsler');
  gleich(d.abo, 'bis5', 'abo');
  gleich(d.aboSubscriptionId, 'I-NEU', 'aboSubscriptionId');
  gleich('aboEndetAm' in d, false, 'alte Vormerkung entfernt');
});

console.log('\nKUENDIGUNG ZURUECKGENOMMEN');
await db.doc('users/umentschieden').set({
  abo: 'solo', aboStatus: 'aktiv', aboSubscriptionId: 'sub_X', fahrschuleId: 'umentschieden',
});
await kuendigungVormerken(db, 'sub_X', T0);
await pruefe('Ruecknahme entfernt die Vormerkung', async () => {
  gleich((await kuendigungAufheben(db, 'sub_X')).ergebnis, 'aufgehoben', 'Ergebnis');
  const d = await lies('users/umentschieden');
  gleich(d.aboStatus, 'aktiv', 'aboStatus');
  gleich('aboEndetAm' in d, false, 'aboEndetAm');
});
await pruefe('...und der Tarif bleibt nach 14 Tagen', async () => {
  await abgelaufeneAbosBeenden(db, T0 + 30 * TAG);
  gleich((await lies('users/umentschieden')).abo, 'solo', 'abo');
});
await pruefe('Ruecknahme fuer ein nie gekuendigtes Abo aendert nichts', async () => {
  gleich((await kuendigungAufheben(db, 'sub_X')).ergebnis, 'nichts-vorgemerkt', 'Ergebnis');
});

console.log(`\n${ok} bestanden, ${schlecht} fehlgeschlagen\n`);
process.exit(schlecht > 0 ? 1 : 0);
