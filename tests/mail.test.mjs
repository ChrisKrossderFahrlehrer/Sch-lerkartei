// E-Mails aus dem Kalender (functions/mail.js) - gegen den Emulator, der
// Versand selbst ist eine Attrappe (es geht nie eine echte Mail hinaus).
//
// Zwei Benachrichtigungen gibt es: ABSAGE (Fahrlehrer storniert -> der
// betroffene Schueler) und TERMIN FREI (Termin wird frei -> Warteliste).
//
// Das Wichtigste hier ist, WER eine Mail bekommt und was drinsteht:
//   - nie jemand, der nicht zum Fahrlehrer gehoert
//   - nie mit einer Adresse aus fremder Hand (Warteliste-Eintraege schreibt
//     jeder mit dem Link selbst - Adresse und Name kommen deshalb nur aus
//     dem Kalender-Schueler, den der Fahrlehrer pflegt)
//   - nie mit Namen anderer Schueler im Text
//   - nie fuer einen Termin, der gar nicht buchbar ist (Sperre, Urlaub,
//     geloescht, vergangen)
//   - nie fuer ein Konto, dessen Kalender der Betreiber nicht freigeschaltet
//     hat (sonst waere das Postfach ein Werkzeug fuer Spam an Fremde)
//
// Starten:  cd tests && npm test   (laeuft in der Emulator-Kette mit)

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const hier = dirname(fileURLToPath(import.meta.url));

process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8089';
process.env.GCLOUD_PROJECT          = 'fahrsync-mail';

const ausFunctions = createRequire(join(hier, '..', 'functions', 'package.json'));
const { initializeApp } = ausFunctions('firebase-admin/app');
const { getFirestore, Timestamp } = ausFunctions('firebase-admin/firestore');
initializeApp({ projectId: 'fahrsync-mail' });
const db = getFirestore();

const mail = require(join(hier, '..', 'functions', 'mail.js'));
const { nachStornierung, einstellungenPruefen, mailStatus, mailAdresseOk, textAbsage, textTerminFrei,
        EINSTELLUNG, STATUS, MAX_PRO_TAG, MAX_PRO_LEHRER_UND_TAG, nameSauber } = mail;

let ok = 0, schlecht = 0;
async function pruefe(text, fn) {
  try { await fn(); ok++; console.log('  ✓', text); }
  catch (e) { schlecht++; console.log('  ✗', text, '\n      ->', String(e.message).split('\n')[0]); }
}
const gleich = (a, b, was) => { if (a !== b) throw new Error(`${was}: ${JSON.stringify(a)} statt ${JSON.stringify(b)}`); };
const wahr = (x, was) => { if (!x) throw new Error(was); };
const lies = async (p) => (await db.doc(p).get()).data();

const STUNDE = 3600000, TAG = 24 * STUNDE;
const JETZT = Date.UTC(2026, 10, 10, 11, 0, 0);                 // 10.11.2026, 12:00 Uhr in Berlin
const START = Date.UTC(2026, 10, 13, 13, 0, 0);                 // Freitag 13.11.2026, 14:00 Uhr in Berlin
const ts = (ms) => Timestamp.fromMillis(ms);
const L = 'lehrerA', L2 = 'lehrerB', SCHULE = 'schuleS';
const CFG = { host: 'smtp.example.org', port: 465, benutzer: 'kontakt@example.org', passwort: 'streng-geheim',
              absender: 'kontakt@example.org', absenderName: 'FahrSync', aktiv: true };

// Attrappe statt SMTP
let post = [];
const senden = async (cfg, nachricht) => { post.push(nachricht); };
let pushes = [];
const push = async (uid, titel, text) => { pushes.push({ uid, titel, text }); };
const lauf = (slotId, vorher, nachher, mehr = {}) =>
  nachStornierung(db, slotId, vorher, nachher, { senden, push, jetzt: JETZT, ...mehr });

// Termin, wie er VOR der Stornierung aussah
const termin = (mehr = {}) => ({
  lehrerUid: L, schoolId: SCHULE, type: 'normal', bookedBy: 'mia', bookedAt: ts(JETZT - TAG),
  startTime: ts(START), endTime: ts(START + 90 * 60000), ...mehr,
});
async function frischerTermin(id, mehr = {}) {
  const vorher = termin(mehr);
  await db.doc(`slots/${id}`).set({ ...vorher, bookedBy: null, bookedAt: null });
  return vorher;
}
const vomLehrer = (vorher, mehr = {}) => ({ ...vorher, bookedBy: null, bookedAt: null, absageAm: ts(JETZT), ...mehr });
const vomSchueler = (vorher) => ({ ...vorher, bookedBy: null, bookedAt: null, storniertVonSchueler: vorher.bookedBy, storniertAt: ts(JETZT) });

// ── Bestand ──────────────────────────────────────────────────────────
// Der Betreiber hat den Kalender der Fahrschule freigeschaltet
await db.doc(`fahrschulen/${SCHULE}`).set({ name: 'Fahrschule Sonne', kalenderAktiv: true });
await db.doc(`users/${L}`).set({ uid: L, rolle: 'fahrlehrer', status: 'aktiv', fahrschuleId: SCHULE });
await db.doc(`users/${L2}`).set({ uid: L2, rolle: 'fahrlehrer', status: 'aktiv', fahrschuleId: SCHULE });
await db.doc(`kalenderUsers/${L}`).set({ fname: 'Tom', lname: 'Fahrer', schoolId: SCHULE });
await db.doc(`kalenderUsers/${L2}`).set({ fname: 'Uwe', lname: 'Anders', schoolId: SCHULE });
await db.doc(`bookingLinks/${L}`).set({ lehrerUid: L, schoolId: SCHULE, schoolName: 'Fahrschule Sonne', aktiv: true, freieSlots: [] });
await db.doc(`bookingLinks/${L2}`).set({ lehrerUid: L2, schoolId: SCHULE, schoolName: 'Fahrschule Sonne', aktiv: true, freieSlots: [] });
await db.doc('schueler/mia').set({ schoolId: SCHULE, lehrerUid: L, fname: 'Mia', lname: 'Muster', email: 'mia@example.org' });
await db.doc('schueler/ohne').set({ schoolId: SCHULE, lehrerUid: L, fname: 'Olaf', lname: 'Ohne', email: '' });
await db.doc('schueler/wanda').set({ schoolId: SCHULE, lehrerUid: L, fname: 'Wanda', lname: 'Wartet', email: 'wanda@example.org' });
await db.doc('schueler/willi').set({ schoolId: SCHULE, lehrerUid: L, fname: 'Willi', lname: 'Wartet', email: 'willi@example.org' });
await db.doc('schueler/kaputt').set({ schoolId: SCHULE, lehrerUid: L, fname: 'Kai', lname: 'Kaputt', email: 'kai@example' });
await db.doc('schueler/anderer').set({ schoolId: SCHULE, lehrerUid: L2, fname: 'Arne', lname: 'Anderer', email: 'arne@example.org' });
// Warteliste bei Fahrlehrer L
const wl = (id, lehrerUid = L, mehr = {}) => db.doc(`bookingWaitlist/${id}`)
  .set({ lehrerUid, schuelerId: id, vorname: 'egal', notiz: '', status: 'wartend', createdAt: ts(JETZT - TAG), ...mehr });
await wl('wanda'); await wl('willi'); await wl('ohne'); await wl('kaputt');
// Jemand mit dem Link von "anderer" (Schueler von L2) traegt sich bei L ein -
// die Regeln verhindern das, die Function muss es trotzdem aushalten.
await wl('anderer', L, { vorname: 'Eingeschlichen' });
await wl('gibtsnicht');
// Warteliste bei Fahrlehrer L2 - geht L nichts an
await db.doc('schueler/zoe').set({ schoolId: SCHULE, lehrerUid: L2, fname: 'Zoe', lname: 'Zweite', email: 'zoe@example.org' });
await wl('zoe', L2);

console.log('\nEINSTELLUNGEN PRUEFEN (Eingaben des Betreibers)');
await pruefe('Vollstaendige Angaben werden angenommen', async () => {
  const p = einstellungenPruefen({ host: ' SMTP.Example.org ', port: 465, benutzer: 'a@b.de', passwort: 'x', absender: 'a@b.de', absenderName: 'Test' });
  wahr(p.ok, p.fehler); gleich(p.cfg.host, 'smtp.example.org', 'host'); gleich(p.cfg.aktiv, true, 'aktiv');
});
await pruefe('Kein Servername, sondern Adresse mit Pfad / IP-Trick -> abgelehnt', async () => {
  for (const host of ['', 'localhost', 'smtp.example.org/x', 'smtp.example.org:25', 'a b.de', '169.254.169.254:80', 'http://x.de'])
    gleich(einstellungenPruefen({ ...CFG, host }).ok, false, 'host ' + host);
});
await pruefe('Nur verschluesselte Ports (465, 587) - Port 25 abgelehnt', async () => {
  gleich(einstellungenPruefen({ ...CFG, port: 25 }).ok, false, '25');
  gleich(einstellungenPruefen({ ...CFG, port: 587 }).ok, true, '587');
});
await pruefe('Leeres Passwort: das gespeicherte bleibt - aber nur fuer denselben Server und Benutzer', async () => {
  gleich(einstellungenPruefen({ ...CFG, passwort: '' }, CFG).cfg.passwort, 'streng-geheim', 'unveraendert');
  gleich(einstellungenPruefen({ ...CFG, passwort: '', host: 'boese.example.org' }, CFG).ok, false, 'anderer Server');
  gleich(einstellungenPruefen({ ...CFG, passwort: '', benutzer: 'anderer' }, CFG).ok, false, 'anderer Benutzer');
});
await pruefe('Absender muss eine E-Mail-Adresse sein; Zeilenumbruch im Namen wird entfernt', async () => {
  gleich(einstellungenPruefen({ ...CFG, absender: 'kein-at' }).ok, false, 'Absender');
  gleich(einstellungenPruefen({ ...CFG, absenderName: 'A\r\nBcc: x@y.de' }).cfg.absenderName.includes('\n'), false, 'Umbruch');
});
await pruefe('Adress-Pruefung: nichts mit Komma, Leerzeichen, Umbruch oder zweiter Adresse', async () => {
  for (const a of ['a@b.de,c@d.de', 'a@b.de c@d.de', 'a@b.de\nBcc: c@d.de', '<a@b.de>', 'a@b', '@b.de', 'a@.de', ''])
    gleich(mailAdresseOk(a), false, a);
  gleich(mailAdresseOk('vor.nach+tag@mail.example.org'), true, 'gueltig');
});

console.log('\nOHNE EINGERICHTETES POSTFACH — nichts wird verschickt, nichts bricht');
await pruefe('Fahrlehrer storniert: keine Mail', async () => {
  const v = await frischerTermin('t0');
  const e = await lauf('t0', v, vomLehrer(v));
  gleich(post.length, 0, 'Mails'); gleich(e.absage, false, 'absage'); gleich(e.warteliste, 0, 'warteliste');
});
await pruefe('Schueler storniert: Termin steht trotzdem wieder in der Terminliste, Fahrlehrer bekommt Push', async () => {
  const v = await frischerTermin('t0b');
  await lauf('t0b', v, vomSchueler(v));
  wahr((await lies(`bookingLinks/${L}`)).freieSlots.some(s => s.id === 't0b'), 'Termin nicht angeboten');
  gleich(pushes.length, 1, 'Pushes'); gleich(pushes[0].uid, L, 'Push an');
  wahr(!/Mia|Muster/.test(pushes[0].titel + pushes[0].text), 'Name des Schuelers im Push (Sperrbildschirm)');
  wahr(pushes[0].text.includes('13.11.') && pushes[0].text.includes('14:00'), 'Datum/Uhrzeit (Ortszeit) fehlen: ' + pushes[0].text);
});

// Ab hier ist das Postfach eingerichtet
await db.doc(EINSTELLUNG).set(CFG);
await db.doc(`bookingLinks/${L}`).update({ freieSlots: [] });
const neu = () => { post = []; pushes = []; };

console.log('\nABSAGE — der Fahrlehrer storniert');
await pruefe('Der betroffene Schueler bekommt GENAU EINE Mail an seine hinterlegte Adresse', async () => {
  neu();
  const v = await frischerTermin('t1');
  const e = await lauf('t1', v, vomLehrer(v, { wirdGeloescht: true }));
  gleich(e.absage, true, 'absage');
  gleich(post.length, 1, 'Mails'); gleich(post[0].an, 'mia@example.org', 'Empfaenger');
});
await pruefe('...mit Datum und Uhrzeit in deutscher Zeit, Vorname und Fahrlehrer', async () => {
  const t = post[0].text;
  wahr(t.includes('Hallo Mia'), 'Anrede'); wahr(t.includes('Freitag, 13. November 2026'), 'Datum: ' + t);
  wahr(t.includes('14:00 Uhr'), 'Uhrzeit'); wahr(t.includes('Tom Fahrer'), 'Fahrlehrer');
  wahr(post[0].betreff.includes('13.11.'), 'Betreff');
});
await pruefe('...ohne Nachnamen des Schuelers und ohne Namen anderer Schueler', async () => {
  const t = post[0].betreff + post[0].text;
  wahr(!/Muster|Wanda|Willi|Olaf|Arne|Zoe/.test(t), 'fremder Name im Text');
});
await pruefe('Stornieren UND loeschen: Absage ja, aber niemand von der Warteliste wird angeschrieben', async () => {
  gleich(post.filter(m => m.betreff.includes('frei geworden')).length, 0, 'Warteliste-Mails');
  wahr(!(await lies(`bookingLinks/${L}`)).freieSlots.some(s => s.id === 't1'), 'geloeschter Termin angeboten');
});
await pruefe('Schueler ohne E-Mail-Adresse: keine Mail, kein Fehler', async () => {
  neu();
  const v = await frischerTermin('t2', { bookedBy: 'ohne' });
  const e = await lauf('t2', v, vomLehrer(v, { wirdGeloescht: true }));
  gleich(e.absage, false, 'absage'); gleich(post.length, 0, 'Mails');
});
await pruefe('Schueler eines ANDEREN Fahrlehrers einer ANDEREN Schule auf dem Termin: keine Mail', async () => {
  neu();
  await db.doc('schueler/fremd').set({ schoolId: 'andereSchule', lehrerUid: 'andererLehrer', fname: 'Fritz', email: 'fritz@example.org' });
  const v = await frischerTermin('t3', { bookedBy: 'fremd' });
  await lauf('t3', v, vomLehrer(v, { wirdGeloescht: true }));
  gleich(post.length, 0, 'Mails');
});
await pruefe('Tausch / alte Marke: bookedBy wird leer OHNE neue Absage-Marke -> keine Absage-Mail', async () => {
  neu();
  const alt = ts(JETZT - 5 * TAG);
  const v = await frischerTermin('t4', { absageAm: alt });
  const e = await lauf('t4', v, { ...v, bookedBy: null, bookedAt: null, wirdGeloescht: true });
  gleich(e.absage, false, 'absage'); gleich(post.length, 0, 'Mails');
});
await pruefe('Vergangener Termin: niemand wird benachrichtigt', async () => {
  neu();
  const v = termin({ startTime: ts(JETZT - STUNDE), endTime: ts(JETZT) });
  await db.doc('slots/t5').set({ ...v, bookedBy: null });
  await lauf('t5', v, vomLehrer(v));
  gleich(post.length, 0, 'Mails'); gleich(pushes.length, 0, 'Pushes');
});

console.log('\nTERMIN FREI — die Warteliste erfaehrt es');
await pruefe('Schueler storniert selbst: er bekommt KEINE Absage, der Fahrlehrer einen Push', async () => {
  neu();
  const v = await frischerTermin('t6');
  const e = await lauf('t6', v, vomSchueler(v));
  gleich(e.absage, false, 'absage'); gleich(pushes.length, 1, 'Pushes');
  wahr(!post.some(m => m.an === 'mia@example.org'), 'Mail an den Stornierenden');
});
await pruefe('Wer mit Adresse auf der Warteliste DIESES Fahrlehrers steht, bekommt je eine Mail', async () => {
  gleich(post.map(m => m.an).sort().join(), 'wanda@example.org,willi@example.org', 'Empfaenger');
});
await pruefe('Jede Mail hat genau einen Empfaenger und nennt nur dessen eigenen Vornamen', async () => {
  const w = post.find(m => m.an === 'wanda@example.org');
  wahr(typeof w.an === 'string' && !/[,;\s]/.test(w.an), 'mehrere Empfaenger');
  wahr(w.text.includes('Hallo Wanda'), 'Anrede');
  wahr(!/Willi|Mia|Muster|Wartet|Olaf|Kai|Arne|Zoe|egal|Eingeschlichen/.test(w.betreff + w.text), 'fremder Name: ' + w.text);
});
await pruefe('...mit Termin in deutscher Zeit und dem EIGENEN Buchungslink', async () => {
  const w = post.find(m => m.an === 'wanda@example.org');
  wahr(w.text.includes('Freitag, 13. November 2026, 14:00–15:30 Uhr'), 'Termin: ' + w.text);
  wahr(w.text.includes(`https://fahrsync.de/kalender.html?schueler=wanda&lehrer=${L}`), 'Link');
  wahr(!w.text.includes('schueler=willi'), 'fremder Link');
});
await pruefe('Der Absender nennt die Fahrschule', async () => {
  gleich(post[0].absenderName, 'Fahrschule Sonne (FahrSync)', 'Absendername');
});
await pruefe('Kein Versand an: Schueler eines anderen Fahrlehrers, unbekannte Kennung, kaputte Adresse, ohne Adresse', async () => {
  const an = post.map(m => m.an).join();
  wahr(!/arne|kai|zoe/.test(an), 'falscher Empfaenger: ' + an);
});
await pruefe('Der Termin steht wieder in der oeffentlichen Terminliste', async () => {
  const frei = (await lies(`bookingLinks/${L}`)).freieSlots;
  gleich(frei.filter(s => s.id === 't6').length, 1, 'Eintraege');
  gleich(frei.find(s => s.id === 't6').start, new Date(START).toISOString(), 'Start');
});
await pruefe('Bremse: wird kurz darauf noch ein Termin frei, kommt KEINE zweite Mail', async () => {
  neu();
  const v = await frischerTermin('t7', { startTime: ts(START + TAG), endTime: ts(START + TAG + 90 * 60000) });
  const e = await lauf('t7', v, vomSchueler(v), { jetzt: JETZT + STUNDE });
  gleich(e.warteliste, 0, 'warteliste'); gleich(post.length, 0, 'Mails');
});
await pruefe('...nach 6 Stunden wieder', async () => {
  neu();
  const v = await frischerTermin('t8', { startTime: ts(START + 2 * TAG), endTime: ts(START + 2 * TAG + 90 * 60000) });
  const e = await lauf('t8', v, vomSchueler(v), { jetzt: JETZT + 7 * STUNDE });
  gleich(e.warteliste, 2, 'warteliste');
});
await pruefe('Fahrlehrer sagt ab (ohne Loeschen): Absage an den Schueler UND Warteliste', async () => {
  neu();
  const v = await frischerTermin('t9', { startTime: ts(START + 3 * TAG), endTime: ts(START + 3 * TAG + 90 * 60000) });
  const e = await lauf('t9', v, vomLehrer(v), { jetzt: JETZT + 2 * TAG });
  gleich(e.absage, true, 'absage'); gleich(e.warteliste, 2, 'warteliste');
  gleich(post.filter(m => m.an === 'mia@example.org').length, 1, 'Absage-Mails');
});

console.log('\nNICHT BUCHBAR — dann auch keine Nachricht');
const spaeter = JETZT + 5 * TAG;     // Bremse der Warteliste ist abgelaufen
await pruefe('Inzwischen wieder vergeben: keine Mail an die Warteliste', async () => {
  neu();
  const v = await frischerTermin('t10');
  await db.doc('slots/t10').update({ bookedBy: 'willi' });
  const e = await lauf('t10', v, vomSchueler(v), { jetzt: JETZT + TAG });
  gleich(e.warteliste, 0, 'warteliste');
});
await pruefe('Sperrzeit an dem Tag: Termin wird nicht angeboten, keine Mail', async () => {
  neu();
  const start = Date.UTC(2026, 10, 20, 13, 0, 0);          // 20.11.2026, 14:00 Uhr in Berlin
  await db.doc('blocked/b1').set({ lehrerUid: L, schoolId: SCHULE, year: 2026, month: 10, day: 20, ganztags: false, vonMin: 13 * 60, bisMin: 16 * 60 });
  const v = await frischerTermin('t11', { startTime: ts(start), endTime: ts(start + 90 * 60000) });
  const e = await lauf('t11', v, vomSchueler(v), { jetzt: spaeter });
  gleich(e.warteliste, 0, 'warteliste');
  wahr(!(await lies(`bookingLinks/${L}`)).freieSlots.some(s => s.id === 't11'), 'gesperrter Termin angeboten');
});
await pruefe('...Sperre zu anderer Uhrzeit am selben Tag stoert nicht', async () => {
  neu();
  const start = Date.UTC(2026, 10, 20, 8, 0, 0);           // 09:00 Uhr in Berlin
  const v = await frischerTermin('t12', { startTime: ts(start), endTime: ts(start + 90 * 60000) });
  const e = await lauf('t12', v, vomSchueler(v), { jetzt: spaeter });
  gleich(e.warteliste, 2, 'warteliste');
});
await pruefe('Urlaub des Fahrlehrers: keine Mail', async () => {
  neu();
  const start = Date.UTC(2026, 11, 2, 9, 0, 0);
  await db.doc('urlaub/u1').set({ lehrerUid: L, schoolId: SCHULE, von: '2026-12-01', bis: '2026-12-04', label: 'Urlaub' });
  const v = await frischerTermin('t13', { startTime: ts(start), endTime: ts(start + 90 * 60000) });
  const e = await lauf('t13', v, vomSchueler(v), { jetzt: spaeter + TAG });
  gleich(e.warteliste, 0, 'warteliste'); gleich(post.length, 0, 'Mails');
});
await pruefe('Sperrtag der Fahrschule: keine Mail', async () => {
  neu();
  const start = Date.UTC(2026, 11, 10, 9, 0, 0);
  await db.doc('globalBlocked/g1').set({ schoolId: SCHULE, year: 2026, month: 11, day: 10 });
  const v = await frischerTermin('t14', { startTime: ts(start), endTime: ts(start + 90 * 60000) });
  const e = await lauf('t14', v, vomSchueler(v), { jetzt: spaeter + TAG });
  gleich(e.warteliste, 0, 'warteliste');
});
await pruefe('Online-Buchung abgeschaltet: keine Mail', async () => {
  neu();
  await db.doc(`bookingLinks/${L}`).update({ aktiv: false });
  const start = Date.UTC(2026, 11, 14, 9, 0, 0);
  const v = await frischerTermin('t15', { startTime: ts(start), endTime: ts(start + 90 * 60000) });
  const e = await lauf('t15', v, vomSchueler(v), { jetzt: spaeter + TAG });
  gleich(e.warteliste, 0, 'warteliste');
  await db.doc(`bookingLinks/${L}`).update({ aktiv: true });
});

console.log('\nGRENZEN UND FEHLER');
await pruefe('Tagesgrenze erreicht: es geht nichts mehr hinaus', async () => {
  neu();
  const tag = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin' }).format(new Date(spaeter + 3 * TAG));
  await db.doc(STATUS).set({ tag, anzahl: MAX_PRO_TAG }, { merge: true });
  const start = Date.UTC(2026, 11, 15, 9, 0, 0);
  const v = await frischerTermin('t16', { startTime: ts(start), endTime: ts(start + 90 * 60000) });
  const e = await lauf('t16', v, vomLehrer(v), { jetzt: spaeter + 3 * TAG });
  gleich(post.length, 0, 'Mails'); gleich(e.absage, false, 'absage');
});
await pruefe('Am naechsten Tag gilt die Grenze neu', async () => {
  neu();
  const start = Date.UTC(2026, 11, 16, 9, 0, 0);
  const v = await frischerTermin('t17', { startTime: ts(start), endTime: ts(start + 90 * 60000) });
  const e = await lauf('t17', v, vomLehrer(v, { wirdGeloescht: true }), { jetzt: spaeter + 4 * TAG });
  gleich(e.absage, true, 'absage');
  gleich((await lies(STATUS)).anzahl, 1, 'Zaehler');
});
await pruefe('Mailserver lehnt ab: kein Absturz, Grund wird vermerkt - ohne Adresse und Inhalt', async () => {
  neu();
  const start = Date.UTC(2026, 11, 17, 9, 0, 0);
  const v = await frischerTermin('t18', { startTime: ts(start), endTime: ts(start + 90 * 60000) });
  const kaputt = async () => { const f = new Error('Invalid login: 535 Authentication failed'); f.code = 'EAUTH'; throw f; };
  const e = await nachStornierung(db, 't18', v, vomLehrer(v, { wirdGeloescht: true }), { senden: kaputt, push, jetzt: spaeter + 4 * TAG });
  gleich(e.absage, false, 'absage');
  const st = await lies(STATUS);
  gleich(st.letzterFehler, 'EAUTH', 'Grund'); wahr(!JSON.stringify(st).includes('mia@'), 'Adresse im Status');
});
await pruefe('Abgeschaltet (aktiv: false): keine Mail', async () => {
  neu();
  await db.doc(EINSTELLUNG).update({ aktiv: false });
  const start = Date.UTC(2026, 11, 18, 9, 0, 0);
  const v = await frischerTermin('t19', { startTime: ts(start), endTime: ts(start + 90 * 60000) });
  await lauf('t19', v, vomLehrer(v), { jetzt: spaeter + 4 * TAG });
  gleich(post.length, 0, 'Mails');
  await db.doc(EINSTELLUNG).update({ aktiv: true });
});
console.log('\nNUR FUER FREIGESCHALTETE KALENDER — das Postfach ist kein Werkzeug fuer Fremde');
// Jeder kann sich registrieren und ueber die Schnittstelle Termine und
// "Schueler" mit beliebigen Adressen anlegen. Verschickt wird deshalb nur,
// wenn der Betreiber den Kalender freigeschaltet hat.
let nr = 30;
const absageLauf = async (jetzt) => {
  neu();
  const start = Date.UTC(2027, 0, nr - 20, 9, 0, 0); nr++;
  const v = await frischerTermin('t' + nr, { startTime: ts(start), endTime: ts(start + 90 * 60000) });
  return nachStornierung(db, 't' + nr, v, vomLehrer(v, { wirdGeloescht: true }), { senden, push, jetzt });
};
const T = spaeter + 10 * TAG;
await pruefe('Kalender der Fahrschule NICHT freigeschaltet: keine Mail', async () => {
  await db.doc(`fahrschulen/${SCHULE}`).update({ kalenderAktiv: false });
  const e = await absageLauf(T);
  gleich(e.absage, false, 'absage'); gleich(post.length, 0, 'Mails');
});
await pruefe('...aber der Fahrlehrer einzeln freigeschaltet: Mail geht', async () => {
  await db.doc(`users/${L}`).update({ kalenderAktiv: true });
  const e = await absageLauf(T);
  gleich(e.absage, true, 'absage');
  await db.doc(`users/${L}`).update({ kalenderAktiv: false });
  await db.doc(`fahrschulen/${SCHULE}`).update({ kalenderAktiv: true });
});
await pruefe('Fahrlehrer gesperrt: keine Mail', async () => {
  await db.doc(`users/${L}`).update({ status: 'gesperrt' });
  const e = await absageLauf(T);
  gleich(e.absage, false, 'absage'); gleich(post.length, 0, 'Mails');
});
await pruefe('Fahrlehrer nur beigetreten, noch nicht freigeschaltet: keine Mail', async () => {
  await db.doc(`users/${L}`).update({ status: 'ausstehend' });
  const e = await absageLauf(T);
  gleich(e.absage, false, 'absage');
  await db.doc(`users/${L}`).update({ status: 'aktiv' });
});
await pruefe('Konto ohne Profil in der Kartei: keine Mail', async () => {
  const profil = await lies(`users/${L}`);
  await db.doc(`users/${L}`).delete();
  const e = await absageLauf(T);
  gleich(e.absage, false, 'absage'); gleich(post.length, 0, 'Mails');
  await db.doc(`users/${L}`).set(profil);
});
await pruefe('Link im Vornamen / Fahrlehrer- / Schulnamen kommt NICHT als Link an', async () => {
  await db.doc('schueler/mia').update({ fname: 'Mia http://boese.example/gewinn?x=1' });
  await db.doc(`kalenderUsers/${L}`).update({ lname: 'www.boese.example' });
  await db.doc(`bookingLinks/${L}`).update({ schoolName: 'Sonne https://boese.example' });
  const e = await absageLauf(T);
  gleich(e.absage, true, 'absage');
  const t = post[0].betreff + post[0].text + post[0].absenderName;
  wahr(!/:\/\/|boese\.example|www\./.test(t), 'Link im Text: ' + t);
  wahr(post[0].text.includes('Hallo Mia'), 'Vorname bleibt lesbar');
  await db.doc('schueler/mia').update({ fname: 'Mia' });
  await db.doc(`kalenderUsers/${L}`).update({ lname: 'Fahrer' });
  await db.doc(`bookingLinks/${L}`).update({ schoolName: 'Fahrschule Sonne' });
});
await pruefe('Gewoehnliche Namen bleiben unveraendert', async () => {
  for (const n of ['Jean-Luc', "O'Brien", 'Dr. Max Müller', 'Zoë', 'Fahrschule A. Beispiel & Söhne (Nord)'])
    gleich(nameSauber(n), n, 'Name');
});
await pruefe('Grenze je Fahrlehrer: ein Konto kann das Tageskontingent nicht aufbrauchen', async () => {
  const tag = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin' }).format(new Date(T + TAG));
  await db.doc(`mailZaehler/${L}`).set({ tag, anzahl: MAX_PRO_LEHRER_UND_TAG });
  const e = await absageLauf(T + TAG);
  gleich(e.absage, false, 'absage'); gleich(post.length, 0, 'Mails');
});
await pruefe('...am naechsten Tag wieder', async () => {
  const e = await absageLauf(T + 2 * TAG);
  gleich(e.absage, true, 'absage');
  gleich((await lies(`mailZaehler/${L}`)).anzahl, 1, 'Zaehler');
});

await pruefe('Der Stand fuer den Betreiber enthaelt das Passwort NICHT', async () => {
  const st = await mailStatus(db);
  gleich(st.eingerichtet, true, 'eingerichtet'); gleich(st.host, 'smtp.example.org', 'host');
  wahr(!JSON.stringify(st).includes('streng-geheim') && !('passwort' in st), 'Passwort im Stand');
});
await pruefe('Texte: kein doppelter Leerabsatz, Fusszeile vorhanden, auch ohne Namen lesbar', async () => {
  const a = textAbsage({ vorname: '', lehrerName: '', schulName: '', startMs: START });
  const f = textTerminFrei({ vorname: '', lehrerName: '', schulName: '', startMs: START, endeMs: 0, link: 'https://x' });
  for (const t of [a.text, f.text]) { wahr(!t.includes('\n\n\n'), 'Leerabsatz'); wahr(t.includes('automatisch'), 'Fusszeile'); }
  wahr(a.text.startsWith('Hallo,'), 'Anrede ohne Namen'); wahr(f.text.includes('bei deinem Fahrlehrer'), 'ohne Lehrername');
});

console.log(`\n${ok} bestanden, ${schlecht} fehlgeschlagen\n`);
process.exit(schlecht > 0 ? 1 : 0);
