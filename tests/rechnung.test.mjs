// Prueft den Rechnungs-Nummernkreis gegen den echten Firestore-Emulator.
//
// Geprueft wird das ECHTE Modul functions/rechnung.js, kein Nachbau.
//
// Der Befund, um den es geht (F4): Die Rechnungsnummer wurde vorher in einer
// eigenen Transaktion gezogen und das Rechnungsdokument erst DANACH
// geschrieben. War es schon vorhanden - der Wiederholungsfall, den beide
// Webhooks selbst abfangen - war die Nummer bereits verbraucht und tauchte
// auf keiner Rechnung auf. Jede erneut zugestellte Webhook-Meldung riss so
// still eine Luecke in den Nummernkreis, den § 14 Abs. 4 Nr. 4 UStG
// fortlaufend verlangt.
//
// Starten:  cd tests && npm run test:rechnung

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const hier = dirname(fileURLToPath(import.meta.url));

process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8089';
process.env.GCLOUD_PROJECT = 'fahrsync-rechnung';

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
initializeApp({ projectId: 'fahrsync-rechnung' });
const db = getFirestore();

const { rechnungAnlegen } = require(join(hier, '..', 'functions', 'rechnung.js'));

let bestanden = 0, fehlgeschlagen = 0;
async function pruefe(beschreibung, fn) {
  try { await fn(); bestanden++; console.log('  ✓', beschreibung); }
  catch (e) { fehlgeschlagen++; console.log('  ✗', beschreibung, '\n      ->', String(e.message).split('\n')[0]); }
}
const gleich = (ist, soll, was) => {
  if (String(ist) !== String(soll)) throw new Error(`${was}: ${ist} statt ${soll}`);
};

const zaehler = () => db.doc('platform/rechnungszaehler').get()
  .then(s => (s.exists ? s.data().naechsteNummer : 1));

const KUNDE = {
  name: 'Fahrschule Muster', rechnungsStrasse: 'Bahnhofstr. 12',
  rechnungsPlz: '73033', rechnungsOrt: 'Göppingen', rechnungsLand: 'DE',
};
const PLAN = { label: 'FahrSync Pro', price: 19.9, pricePlaner: 29.9 };

const anlegen = (docId) => rechnungAnlegen({
  billingId: 'kunde-1', empfaengerName: KUNDE.name, b: KUNDE,
  plan: 'pro', planer: false, planInfo: PLAN, betrag: 19.9,
  zahlungsart: 'Kreditkarte', docId,
  referenzFelder: { stripeSessionId: docId },
  herkunft: 'test',
});

console.log('\nRECHNUNGSNUMMERN — fortlaufend, ohne Luecken');

await pruefe('Erste Rechnung bekommt eine Nummer und ein PDF', async () => {
  const nummer = await anlegen('stripe_ereignis_1');
  const jahr = new Date().getFullYear();
  gleich(nummer, `${jahr}-00001`, 'Nummer');
  const d = await db.doc('rechnungen/stripe_ereignis_1').get();
  if (!d.exists) throw new Error('Rechnungsdokument fehlt');
  if (!(d.data().pdfBase64 || '').startsWith('JVBER')) throw new Error('Kein PDF im Dokument');
  gleich(await zaehler(), 2, 'Zaehlerstand');
});

await pruefe('Zweite Rechnung zaehlt genau um eins weiter', async () => {
  const jahr = new Date().getFullYear();
  gleich(await anlegen('stripe_ereignis_2'), `${jahr}-00002`, 'Nummer');
  gleich(await zaehler(), 3, 'Zaehlerstand');
});

await pruefe('Wiederholte Zustellung desselben Ereignisses verbraucht KEINE Nummer', async () => {
  const vorher = await zaehler();
  const nummer = await anlegen('stripe_ereignis_2');       // exakt dasselbe Ereignis
  gleich(nummer, 'null', 'Rueckgabe bei Wiederholung');
  gleich(await zaehler(), vorher, 'Zaehlerstand nach Wiederholung');
});

await pruefe('Nach der Wiederholung geht die Reihe luecklos weiter', async () => {
  const jahr = new Date().getFullYear();
  gleich(await anlegen('stripe_ereignis_3'), `${jahr}-00003`, 'Nummer');
});

await pruefe('Zehn gleichzeitige Zustellungen desselben Ereignisses: eine Rechnung, eine Nummer', async () => {
  const vorher = await zaehler();
  const ergebnisse = await Promise.all(
    Array.from({ length: 10 }, () => anlegen('stripe_gleichzeitig').catch(() => 'fehler'))
  );
  const echte = ergebnisse.filter(r => r && r !== 'null' && r !== 'fehler');
  gleich(echte.length, 1, 'Anzahl vergebener Nummern');
  gleich(await zaehler(), vorher + 1, 'Zaehler genau um eins erhoeht');
});

await pruefe('Alle vergebenen Nummern sind eindeutig und lueckenlos', async () => {
  const snap = await db.collection('rechnungen').get();
  const nummern = snap.docs.map(d => d.data().nummer).sort();
  const eindeutig = new Set(nummern);
  gleich(eindeutig.size, nummern.length, 'Doppelte Nummern');
  const laufend = nummern.map(n => parseInt(n.split('-')[1], 10));
  for (let i = 1; i < laufend.length; i++) {
    if (laufend[i] !== laufend[i - 1] + 1) {
      throw new Error(`Luecke zwischen ${laufend[i - 1]} und ${laufend[i]}`);
    }
  }
  console.log('      vergeben:', nummern.join(', '));
});

console.log(`\n${bestanden} bestanden, ${fehlgeschlagen} fehlgeschlagen\n`);
process.exit(fehlgeschlagen > 0 ? 1 : 0);
