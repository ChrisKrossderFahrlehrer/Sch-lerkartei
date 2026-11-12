// Abo in der App kuendigen (functions/abo.js) - gegen den Emulator.
// Stripe und PayPal sind Attrappen: es wird nie ein echtes Abo angefasst.
//
// Geprueft wird vor allem:
//   - das Abo wird beim RICHTIGEN Anbieter gekuendigt, genau einmal
//   - der bezahlte Zeitraum bleibt nutzbar (mindestens 14 Tage, AGB § 5)
//   - Daten und Tarif bleiben bis zum Ende unangetastet
//   - zweimal tippen kuendigt nicht zweimal und verschiebt das Ende nicht
//   - zuruecknehmen geht nur bei Stripe
//   - ohne laufendes Abo passiert nichts
//
// Starten:  cd tests && npm test   (laeuft in der Emulator-Kette mit)

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const hier = dirname(fileURLToPath(import.meta.url));

process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8089';
process.env.GCLOUD_PROJECT = 'fahrsync-kuendigen';

const ausFunctions = createRequire(join(hier, '..', 'functions', 'package.json'));
const { initializeApp } = ausFunctions('firebase-admin/app');
const { getFirestore } = ausFunctions('firebase-admin/firestore');
initializeApp({ projectId: 'fahrsync-kuendigen' });
const db = getFirestore();

const { aboKuendigen, aboFortsetzen, aboStand, abgelaufeneAbosBeenden } = require(join(hier, '..', 'functions', 'abo.js'));

let ok = 0, schlecht = 0;
async function pruefe(text, fn) {
  try { await fn(); ok++; console.log('  ✓', text); }
  catch (e) { schlecht++; console.log('  ✗', text, '\n      ->', String(e.message).split('\n')[0]); }
}
const gleich = (a, b, was) => { if (a !== b) throw new Error(`${was}: ${JSON.stringify(a)} statt ${JSON.stringify(b)}`); };
const lies = async (p) => (await db.doc(p).get()).data();

const TAG = 86400000;
const JETZT = Date.UTC(2026, 10, 12, 10, 0, 0);

let aufrufe = [];
const anbieter = (bezahltBis) => ({
  async stripeKuendigen(id) { aufrufe.push('stripe-kuendigen:' + id); return bezahltBis; },
  async stripeFortsetzen(id) { aufrufe.push('stripe-fortsetzen:' + id); },
  async paypalKuendigen(id) { aufrufe.push('paypal-kuendigen:' + id); return bezahltBis; },
});

await db.doc('fahrschulen/stripeSchule').set({ name: 'A', abo: 'team', aboStatus: 'aktiv', aboSubscriptionId: 'sub_123', aboZahlungsart: 'stripe', aboMaxLehrer: 5 });
await db.doc('users/paypalSolo').set({ name: 'B', abo: 'solo', aboStatus: 'aktiv', aboSubscriptionId: 'I-ABC', aboZahlungsart: 'paypal', aboMaxLehrer: 1 });
await db.doc('fahrschulen/kurz').set({ name: 'C', abo: 'solo', aboStatus: 'aktiv', aboSubscriptionId: 'sub_kurz', aboZahlungsart: 'stripe' });
await db.doc('fahrschulen/frei').set({ name: 'D', abo: 'free' });
await db.doc('users/angestellt').set({ name: 'E', fahrschuleId: 'stripeSchule' });

console.log('\nSTRIPE — zum Ende des bezahlten Zeitraums');
await pruefe('Kuendigen: Stripe wird genau einmal beauftragt', async () => {
  aufrufe = [];
  const r = await aboKuendigen(db, db.doc('fahrschulen/stripeSchule'), anbieter(JETZT + 20 * TAG), JETZT);
  gleich(aufrufe.join(), 'stripe-kuendigen:sub_123', 'Aufrufe');
  gleich(r.gekuendigt, true, 'gekuendigt'); gleich(r.endetAm, JETZT + 20 * TAG, 'Ende = bezahlt bis');
  gleich(r.fortsetzbar, true, 'fortsetzbar');
});
await pruefe('Tarif und Daten bleiben bis zum Ende', async () => {
  const d = await lies('fahrschulen/stripeSchule');
  gleich(d.abo, 'team', 'Tarif'); gleich(d.aboMaxLehrer, 5, 'Lehrer'); gleich(d.name, 'A', 'Name');
  gleich(d.aboStatus, 'gekuendigt', 'Status'); gleich(d.aboKuendigungQuelle, 'stripe:app', 'Quelle');
});
await pruefe('Zweimal tippen: kein zweiter Auftrag, Ende bleibt', async () => {
  aufrufe = [];
  const r = await aboKuendigen(db, db.doc('fahrschulen/stripeSchule'), anbieter(JETZT + 60 * TAG), JETZT + TAG);
  gleich(aufrufe.length, 0, 'Aufrufe'); gleich(r.ergebnis, 'schon-gekuendigt', 'Ergebnis'); gleich(r.endetAm, JETZT + 20 * TAG, 'Ende');
});
await pruefe('Die spaeter eintreffende Webhook-Meldung verschiebt das Ende nicht', async () => {
  const { kuendigungVormerken } = require(join(hier, '..', 'functions', 'abo.js'));
  const r = await kuendigungVormerken(db, 'sub_123', JETZT + 2 * TAG, 'stripe', JETZT + 50 * TAG);
  gleich(r.ergebnis, 'schon-vorgemerkt', 'Ergebnis');
  gleich((await lies('fahrschulen/stripeSchule')).aboEndetAm, JETZT + 20 * TAG, 'Ende');
});
await pruefe('Zuruecknehmen: Stripe wird beauftragt, Abo laeuft weiter', async () => {
  aufrufe = [];
  const r = await aboFortsetzen(db, db.doc('fahrschulen/stripeSchule'), anbieter(0), JETZT + 3 * TAG);
  gleich(aufrufe.join(), 'stripe-fortsetzen:sub_123', 'Aufrufe'); gleich(r.ergebnis, 'fortgesetzt', 'Ergebnis');
  const d = await lies('fahrschulen/stripeSchule');
  gleich(d.aboStatus, 'aktiv', 'Status'); gleich(d.aboEndetAm, undefined, 'Ende entfernt'); gleich(d.abo, 'team', 'Tarif');
});
await pruefe('Kurz vor Monatsende gekuendigt: noch mindestens 14 Tage', async () => {
  const r = await aboKuendigen(db, db.doc('fahrschulen/kurz'), anbieter(JETZT + 3 * TAG), JETZT);
  gleich(r.endetAm, JETZT + 14 * TAG, 'Ende');
});
await pruefe('Nach dem Ende stellt die Nacht auf den kostenlosen Tarif - Daten bleiben', async () => {
  await abgelaufeneAbosBeenden(db, JETZT + 15 * TAG);
  const d = await lies('fahrschulen/kurz');
  gleich(d.abo, 'free', 'Tarif'); gleich(d.name, 'C', 'Name'); gleich(d.aboSubscriptionId, undefined, 'Kennung');
  gleich(aboStand(d).laufendesAbo, false, 'laufend');
});

console.log('\nPAYPAL — beendet, bezahlter Zeitraum bleibt');
await pruefe('Kuendigen: PayPal wird beauftragt, Ende = naechste Abbuchung', async () => {
  aufrufe = [];
  const r = await aboKuendigen(db, db.doc('users/paypalSolo'), anbieter(JETZT + 25 * TAG), JETZT);
  gleich(aufrufe.join(), 'paypal-kuendigen:I-ABC', 'Aufrufe');
  gleich(r.endetAm, JETZT + 25 * TAG, 'Ende'); gleich(r.fortsetzbar, false, 'fortsetzbar');
});
await pruefe('Zuruecknehmen geht bei PayPal NICHT (auch kein Auftrag)', async () => {
  aufrufe = [];
  const r = await aboFortsetzen(db, db.doc('users/paypalSolo'), anbieter(0), JETZT + TAG);
  gleich(r.fehler, 'nicht-fortsetzbar', 'Fehler'); gleich(aufrufe.length, 0, 'Aufrufe');
  gleich((await lies('users/paypalSolo')).aboStatus, 'gekuendigt', 'Status');
});
await pruefe('PayPal liefert kein Datum: trotzdem 14 Tage', async () => {
  await db.doc('users/paypalOhne').set({ abo: 'solo', aboSubscriptionId: 'I-OHNE', aboZahlungsart: 'paypal' });
  const r = await aboKuendigen(db, db.doc('users/paypalOhne'), anbieter(0), JETZT);
  gleich(r.endetAm, JETZT + 14 * TAG, 'Ende');
});

console.log('\nNICHTS ZU KUENDIGEN');
await pruefe('Kostenloser Tarif: kein Auftrag', async () => {
  aufrufe = [];
  const r = await aboKuendigen(db, db.doc('fahrschulen/frei'), anbieter(JETZT), JETZT);
  gleich(r.fehler, 'kein-abo', 'Fehler'); gleich(aufrufe.length, 0, 'Aufrufe');
});
await pruefe('Angestellter Fahrlehrer (kein eigenes Abo): kein Auftrag, Schul-Abo unberuehrt', async () => {
  aufrufe = [];
  const r = await aboKuendigen(db, db.doc('users/angestellt'), anbieter(JETZT), JETZT);
  gleich(r.fehler, 'kein-abo', 'Fehler'); gleich(aufrufe.length, 0, 'Aufrufe');
  gleich((await lies('fahrschulen/stripeSchule')).aboStatus, 'aktiv', 'Schul-Abo');
});
await pruefe('Unbekanntes Konto: kein Auftrag', async () => {
  const r = await aboKuendigen(db, db.doc('users/gibtsnicht'), anbieter(JETZT), JETZT);
  gleich(r.fehler, 'kein-abo', 'Fehler');
});
await pruefe('Anbieter scheitert: nichts wird vorgemerkt (der Kunde zahlt sonst weiter, ohne es zu merken)', async () => {
  await db.doc('fahrschulen/kaputt').set({ abo: 'team', aboSubscriptionId: 'sub_kaputt', aboZahlungsart: 'stripe', aboStatus: 'aktiv' });
  const kaputt = { ...anbieter(0), async stripeKuendigen() { throw new Error('Stripe nicht erreichbar'); } };
  let geworfen = false;
  try { await aboKuendigen(db, db.doc('fahrschulen/kaputt'), kaputt, JETZT); } catch (e) { geworfen = true; }
  gleich(geworfen, true, 'Fehler weitergereicht');
  gleich((await lies('fahrschulen/kaputt')).aboStatus, 'aktiv', 'Status');
});

console.log(`\n${ok} bestanden, ${schlecht} fehlgeschlagen\n`);
process.exit(schlecht > 0 ? 1 : 0);
