// E-Mail-Versand einrichten (Function, nur Betreiber) - gegen den Emulator.
//
// Die Plattform ruft das ueber adminEmailBestaetigen mit { bereich: 'mail' }
// auf (Begruendung in functions/index.js). Geprueft wird:
//   - niemand ausser dem Betreiber kommt hinein
//   - das Passwort kommt nie zurueck
//   - falsche Angaben werden gar nicht erst gespeichert
//   - der bisherige Zweck von adminEmailBestaetigen bleibt unberuehrt
//
// Es wird KEIN Mailserver gebraucht: Die Tests arbeiten mit ungueltigen
// Angaben und mit der Endung ".invalid", die es garantiert nicht gibt.
//
// Starten:  cd tests && npm test   (laeuft in der Emulator-Kette mit)

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const hier = dirname(fileURLToPath(import.meta.url));

// Fest auf den lokalen Rechner - ein Testlauf darf nie echte Daten anfassen.
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8089';
process.env.GCLOUD_PROJECT          = 'fahrsync-maileinst';
process.env.GCP_PROJECT             = 'fahrsync-maileinst';

const ausFunctions = createRequire(join(hier, '..', 'functions', 'package.json'));
// index.js ruft selbst initializeApp() - hier also NICHT noch einmal.
const fn = ausFunctions('./index.js');
const { getFirestore } = ausFunctions('firebase-admin/firestore');
const db = getFirestore();

let ok = 0, schlecht = 0;
async function pruefe(text, f) {
  try { await f(); ok++; console.log('  ✓', text); }
  catch (e) { schlecht++; console.log('  ✗', text, '\n      ->', String(e.message).split('\n')[0]); }
}
const gleich = (a, b, was) => { if (a !== b) throw new Error(`${was}: ${JSON.stringify(a)} statt ${JSON.stringify(b)}`); };
const wahr = (x, was) => { if (!x) throw new Error(was); };
async function scheitert(code, lauf) {
  try { await lauf(); } catch (e) { gleich(e.code, code, 'Fehlercode'); return e; }
  throw new Error('haette scheitern muessen (' + code + ')');
}

const BETREIBER = { uid: 'chef', token: { email: 'chriskoo@mail.de' } };
const INHABER   = { uid: 'inhaber', token: { email: 'inhaber@test.de' } };
const mail = (auth, daten) => fn.adminEmailBestaetigen.run({ auth, data: { bereich: 'mail', ...daten } });
const GUT = { aktion: 'speichern', host: 'smtp.fahrsync-test.invalid', port: 465, benutzer: 'kontakt@fahrsync-test.invalid',
              passwort: 'streng-geheim', absender: 'kontakt@fahrsync-test.invalid', absenderName: 'FahrSync' };

await db.doc('users/inhaber').set({ uid: 'inhaber', rolle: 'fahrschul-admin', status: 'aktiv', fahrschuleId: 'inhaber' });

console.log('\nWER DARF');
await pruefe('Ohne Anmeldung: abgewiesen', async () => {
  await scheitert('unauthenticated', () => mail(undefined, { aktion: 'status' }));
});
await pruefe('Inhaber einer Fahrschule: abgewiesen (auch nur fuer den Stand)', async () => {
  await scheitert('permission-denied', () => mail(INHABER, { aktion: 'status' }));
  await scheitert('permission-denied', () => mail(INHABER, GUT));
});
await pruefe('Konto ohne Profil: abgewiesen', async () => {
  await scheitert('permission-denied', () => mail({ uid: 'niemand', token: { email: 'x@test.de' } }, { aktion: 'status' }));
});
await pruefe('Der eigene Name der Function (mailEinstellungen) prueft genauso', async () => {
  await scheitert('permission-denied', () => fn.mailEinstellungen.run({ auth: INHABER, data: { aktion: 'status' } }));
});
await pruefe('Betreiber liest den Stand: noch nichts eingerichtet', async () => {
  const st = await mail(BETREIBER, { aktion: 'status' });
  gleich(st.eingerichtet, false, 'eingerichtet'); gleich(st.aktiv, false, 'aktiv');
});

console.log('\nFALSCHE ANGABEN WERDEN NICHT GESPEICHERT');
await pruefe('Kein gueltiger Servername', async () => {
  await scheitert('invalid-argument', () => mail(BETREIBER, { ...GUT, host: 'smtp.example.org/x' }));
});
await pruefe('Unverschluesselter Port 25', async () => {
  await scheitert('invalid-argument', () => mail(BETREIBER, { ...GUT, port: 25 }));
});
await pruefe('Mailserver nicht erreichbar: verstaendliche Meldung, nichts gespeichert', async () => {
  const e = await scheitert('failed-precondition', () => mail(BETREIBER, GUT));
  wahr(/Mailserver/.test(e.message), 'Meldung: ' + e.message);
  wahr(!e.message.includes('streng-geheim'), 'Passwort in der Fehlermeldung');
  gleich((await db.doc('serverEinstellungen/mail').get()).exists, false, 'gespeichert');
  gleich((await db.doc('settings/kalenderMail').get()).exists, false, 'Marke gesetzt');
});
await pruefe('Unbekannte Aktion', async () => {
  await scheitert('invalid-argument', () => mail(BETREIBER, { aktion: 'loeschen' }));
});

console.log('\nEINGERICHTET');
// Einstellungen wie nach einem erfolgreichen Speichern
await db.doc('serverEinstellungen/mail').set({ host: GUT.host, port: 465, benutzer: GUT.benutzer, passwort: 'streng-geheim',
  absender: GUT.absender, absenderName: 'FahrSync', aktiv: true, geaendertAm: Date.now() });
await pruefe('Der Stand nennt Server und Absender, aber NIE das Passwort', async () => {
  const st = await mail(BETREIBER, { aktion: 'status' });
  gleich(st.eingerichtet, true, 'eingerichtet'); gleich(st.aktiv, true, 'aktiv'); gleich(st.host, GUT.host, 'host');
  wahr(!JSON.stringify(st).includes('streng-geheim') && !('passwort' in st), 'Passwort im Stand');
});
await pruefe('Testnachricht bei nicht erreichbarem Server: Meldung statt Absturz', async () => {
  const e = await scheitert('unavailable', () => mail(BETREIBER, { aktion: 'test' }));
  wahr(!e.message.includes('streng-geheim'), 'Passwort in der Fehlermeldung');
});
await pruefe('Abschalten: Versand aus, Marke fuer die App aus, Zugangsdaten bleiben', async () => {
  const st = await mail(BETREIBER, { aktion: 'abschalten' });
  gleich(st.aktiv, false, 'aktiv'); gleich(st.eingerichtet, true, 'eingerichtet');
  gleich((await db.doc('settings/kalenderMail').get()).get('aktiv'), false, 'Marke');
  gleich((await db.doc('serverEinstellungen/mail').get()).get('passwort'), 'streng-geheim', 'Passwort');
});
await pruefe('Abgeschaltet: Testnachricht wird abgelehnt', async () => {
  await scheitert('failed-precondition', () => mail(BETREIBER, { aktion: 'test' }));
});

console.log('\nDER BISHERIGE ZWECK BLEIBT');
await pruefe('adminEmailBestaetigen ohne bereich verlangt weiter eine E-Mail', async () => {
  await scheitert('invalid-argument', () => fn.adminEmailBestaetigen.run({ auth: BETREIBER, data: {} }));
});
await pruefe('...und laesst weiter nur den Betreiber hinein', async () => {
  await scheitert('permission-denied', () => fn.adminEmailBestaetigen.run({ auth: INHABER, data: { email: 'x@test.de' } }));
});

console.log(`\n${ok} bestanden, ${schlecht} fehlgeschlagen\n`);
process.exit(schlecht > 0 ? 1 : 0);
