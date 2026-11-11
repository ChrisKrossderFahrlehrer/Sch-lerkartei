'use strict';
// E-Mails aus dem Kalender.
//
// Bis 11/2026 legte der Kalender bei einer Stornierung einen Eintrag in
// 'mailQueue' ab - verschickt hat ihn nie jemand. Jetzt gibt es zwei echte
// Benachrichtigungen, beide ausgeloest durch eine Aenderung am Termin selbst
// (nicht durch einen Auftrag aus dem Browser - dem Browser wird weder
// Empfaenger noch Inhalt geglaubt):
//
//   1. ABSAGE: Der Fahrlehrer storniert eine gebuchte Fahrstunde
//      -> der betroffene Schueler bekommt eine Mail.
//   2. TERMIN FREI: Eine gebuchte Fahrstunde wird wieder frei (Fahrlehrer
//      oder Schueler storniert) -> wer beim Fahrlehrer auf der Warteliste
//      steht, bekommt eine Mail mit seinem Buchungslink.
//
// Grundsaetze:
//   - Empfaenger ist ausschliesslich die E-Mail-Adresse, die der Fahrlehrer
//     oder die Fahrschule beim Kalender-Schueler hinterlegt hat. Ohne Adresse
//     keine Mail.
//   - Jede Mail geht an GENAU EINEN Empfaenger. Im Text stehen nur sein
//     eigener Vorname, der Name seines Fahrlehrers und der Termin - nie Daten
//     anderer Schueler.
//   - Die Zugangsdaten des Postfachs stehen in 'serverEinstellungen/mail'.
//     Diese Sammlung hat in den Firestore-Regeln keinen Eintrag: Kein Browser
//     kann sie lesen oder schreiben, auch der Betreiber nicht. Gesetzt werden
//     sie ueber die Function mailEinstellungen (nur Betreiber), das Passwort
//     wird nie wieder herausgegeben.
//   - Ohne eingerichtetes Postfach passiert nichts (kein Fehler).
//   - Versendet wird nur fuer Fahrlehrer, deren Kalender der Betreiber
//     freigeschaltet hat (kalenderAktiv - von niemandem selbst setzbar). Ein
//     Konto kann sich kostenlos registrieren und ueber die Schnittstelle
//     Termine und "Schueler" mit beliebigen Adressen anlegen: Ohne diese
//     Schranke liessen sich ueber das Postfach des Betreibers Nachrichten an
//     Fremde verschicken.
//   - Namen im Text (Vorname, Fahrlehrer, Fahrschule) werden auf Buchstaben,
//     Ziffern und wenige Zeichen beschraenkt - kein Platz fuer Links.
//   - Bremsen: je Warteliste-Eintrag hoechstens eine Mail in 6 Stunden, je
//     Fahrlehrer hoechstens MAX_PRO_LEHRER_UND_TAG, insgesamt hoechstens
//     MAX_PRO_TAG Mails am Tag.

const nodemailer = require('nodemailer');

const EINSTELLUNG = 'serverEinstellungen/mail';
const STATUS = 'serverEinstellungen/mailStatus';
const APP_URL = 'https://fahrsync.de/kalender.html';
const MAX_PRO_TAG = 300;
const MAX_PRO_LEHRER_UND_TAG = 40;
const WARTELISTE_PAUSE_MS = 6 * 60 * 60 * 1000;
const MAX_WARTELISTE_JE_TERMIN = 20;   // haelt die Laufzeit der Function im Rahmen
const ERLAUBTE_PORTS = [465, 587, 2525];
const ID_OK = /^[A-Za-z0-9_-]{1,64}$/;

// ── Pruefungen ───────────────────────────────────────────────────────
function mailAdresseOk(a) {
  return typeof a === 'string' && a.length <= 254
    && /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/.test(a);
}
function hostOk(h) {
  return typeof h === 'string' && h.length <= 253
    && /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/.test(h);
}
// Eine Zeile, keine Steuerzeichen - fuer Namen, die in Betreff/Absender/Text landen
function eineZeile(s, max = 80) {
  return String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

// Namen, die in einer Mail an Dritte landen: nur Buchstaben, Ziffern,
// Leerzeichen und wenige Satzzeichen. Punkte bleiben nur vor einem Leerzeichen
// oder am Ende ("Dr. Max", "Fahrschule A. Beispiel") - aus "seite.example/x"
// wird "seite example x", kein Mailprogramm macht daraus einen Link.
function nameSauber(s, max = 60) {
  return String(s == null ? '' : s).normalize('NFC')
    .replace(/[^\p{L}\p{M}\p{N} .,'&()+-]/gu, ' ')
    .replace(/\.(?=\S)/g, ' ')
    .replace(/\s+/g, ' ').trim().slice(0, max);
}

// Hat der Betreiber den Kalender fuer diesen Fahrlehrer freigeschaltet?
// Dieselbe Frage stellt kalender.html beim Anmelden - dort schuetzt sie nur
// die Oberflaeche, hier den Versand.
async function kalenderFreigeschaltet(db, lehrerUid) {
  const u = await db.doc(`users/${lehrerUid}`).get();
  if (!u.exists) return false;
  const d = u.data();
  if (d.rolle === 'superadmin') return true;
  const schule = (typeof d.fahrschuleId === 'string' && d.fahrschuleId) ? d.fahrschuleId : lehrerUid;
  if (d.status === 'gesperrt') return false;
  if (d.status === 'ausstehend' && schule !== lehrerUid) return false;
  if (d.kalenderAktiv === true) return true;
  if (!ID_OK.test(schule)) return false;
  const fs = await db.doc(`fahrschulen/${schule}`).get();
  return fs.exists && fs.get('kalenderAktiv') === true;
}

// Eingaben des Betreibers pruefen. bisher = gespeicherte Einstellungen (fuer
// "Passwort unveraendert lassen"). Rueckgabe: { ok, fehler, cfg }
function einstellungenPruefen(roh, bisher) {
  const r = roh || {};
  const host = String(r.host || '').trim().toLowerCase();
  const port = Number(r.port);
  const benutzer = String(r.benutzer || '').trim();
  const absender = String(r.absender || '').trim();
  const absenderName = eineZeile(r.absenderName || 'FahrSync', 60);
  let passwort = typeof r.passwort === 'string' ? r.passwort : '';
  if (!passwort && bisher && bisher.passwort && bisher.host === host && bisher.benutzer === benutzer) {
    passwort = bisher.passwort;
  }
  if (!hostOk(host)) return { ok: false, fehler: 'Der Mailserver (SMTP) ist kein gültiger Servername.' };
  if (!ERLAUBTE_PORTS.includes(port)) return { ok: false, fehler: 'Port muss 465 oder 587 sein.' };
  if (!benutzer || benutzer.length > 200 || /[\r\n]/.test(benutzer)) return { ok: false, fehler: 'Benutzername fehlt.' };
  if (!passwort || passwort.length > 500) return { ok: false, fehler: 'Passwort fehlt.' };
  if (!mailAdresseOk(absender)) return { ok: false, fehler: 'Die Absender-Adresse ist keine gültige E-Mail-Adresse.' };
  return { ok: true, cfg: { host, port, benutzer, passwort, absender, absenderName, aktiv: true } };
}

// ── Einstellungen ────────────────────────────────────────────────────
async function mailEinstellungenLaden(db) {
  const snap = await db.doc(EINSTELLUNG).get();
  if (!snap.exists) return null;
  const c = snap.data();
  if (c.aktiv !== true || !hostOk(c.host) || !ERLAUBTE_PORTS.includes(c.port)
      || !c.benutzer || !c.passwort || !mailAdresseOk(c.absender)) return null;
  return c;
}

// Was der Betreiber sehen darf - OHNE Passwort.
async function mailStatus(db) {
  const [e, s] = await Promise.all([db.doc(EINSTELLUNG).get(), db.doc(STATUS).get()]);
  const c = e.exists ? e.data() : {};
  const st = s.exists ? s.data() : {};
  return {
    eingerichtet: !!(e.exists && c.host && c.passwort),
    aktiv: c.aktiv === true,
    host: c.host || '', port: c.port || 465, benutzer: c.benutzer || '',
    absender: c.absender || '', absenderName: c.absenderName || '',
    geaendertAm: c.geaendertAm || null,
    letzterVersand: st.letzterVersand || null,
    letzterFehler: st.letzterFehler || null,
    letzterFehlerAm: st.letzterFehlerAm || null,
    heute: st.tag === berlinTag(Date.now()) ? (st.anzahl || 0) : 0,
    maxProTag: MAX_PRO_TAG,
  };
}

function transportBauen(cfg) {
  return nodemailer.createTransport({
    host: cfg.host, port: cfg.port,
    secure: cfg.port === 465,          // 465 = sofort verschluesselt
    requireTLS: cfg.port !== 465,      // 587/2525 = STARTTLS erzwingen, nie Klartext
    auth: { user: cfg.benutzer, pass: cfg.passwort },
    connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 20000,
    disableFileAccess: true, disableUrlAccess: true,
  });
}

// Meldet sich am Mailserver an, ohne etwas zu senden.
async function verbindungPruefen(cfg) {
  const t = transportBauen(cfg);
  try { await t.verify(); } finally { try { t.close(); } catch (e) { /* egal */ } }
}

// Der eigentliche Versand. nachricht = { an, betreff, text, absenderName }
async function smtpSenden(cfg, nachricht) {
  const t = transportBauen(cfg);
  try {
    await t.sendMail({
      from: { name: eineZeile(nachricht.absenderName || cfg.absenderName || 'FahrSync', 70), address: cfg.absender },
      to: nachricht.an,
      subject: eineZeile(nachricht.betreff, 150),
      text: nachricht.text,
      headers: { 'Auto-Submitted': 'auto-generated', 'X-Auto-Response-Suppress': 'All' },
    });
  } finally { try { t.close(); } catch (e) { /* egal */ } }
}

// ── Tagesgrenze ──────────────────────────────────────────────────────
const berlinTagFormat = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit' });
function berlinTag(ms) { return berlinTagFormat.format(new Date(ms)); }

// Reserviert einen Platz im Tageskontingent - insgesamt und (wenn angegeben)
// fuer den Fahrlehrer, damit ein einzelnes Konto nicht das ganze Kontingent
// verbraucht. false = eine der Grenzen ist erreicht.
async function tagesgrenzeBelegen(db, jetzt, lehrerUid) {
  const ref = db.doc(STATUS);
  const lRef = (typeof lehrerUid === 'string' && ID_OK.test(lehrerUid)) ? db.doc(`mailZaehler/${lehrerUid}`) : null;
  const tag = berlinTag(jetzt);
  return db.runTransaction(async (tx) => {
    const s = await tx.get(ref);
    const l = lRef ? await tx.get(lRef) : null;
    const d = s.exists ? s.data() : {};
    const ld = l && l.exists ? l.data() : {};
    const anzahl = d.tag === tag ? (Number(d.anzahl) || 0) : 0;
    const lAnzahl = ld.tag === tag ? (Number(ld.anzahl) || 0) : 0;
    if (anzahl >= MAX_PRO_TAG) return false;
    if (lRef && lAnzahl >= MAX_PRO_LEHRER_UND_TAG) return false;
    tx.set(ref, { tag, anzahl: anzahl + 1 }, { merge: true });
    if (lRef) tx.set(lRef, { tag, anzahl: lAnzahl + 1 });
    return true;
  });
}

// Sendet EINE Mail mit Tagesgrenze und Statusvermerk. Wirft nie.
// senden(cfg, nachricht) ist austauschbar (Tests).
async function mailVerschicken(db, cfg, nachricht, senden, jetzt) {
  if (!mailAdresseOk(nachricht.an)) return false;
  try {
    if (!(await tagesgrenzeBelegen(db, jetzt, nachricht.lehrerUid))) {
      console.warn('Mail: Tagesgrenze erreicht - nicht gesendet');
      return false;
    }
    await senden(cfg, nachricht);
    await db.doc(STATUS).set({ letzterVersand: jetzt }, { merge: true }).catch(() => {});
    return true;
  } catch (e) {
    // Keine Adresse und kein Inhalt ins Protokoll - nur der Grund
    const grund = eineZeile((e && (e.code || e.message)) || 'Fehler', 200);
    console.warn('Mail: Versand fehlgeschlagen -', grund);
    await db.doc(STATUS).set({ letzterFehler: grund, letzterFehlerAm: jetzt }, { merge: true }).catch(() => {});
    return false;
  }
}

// ── Texte ────────────────────────────────────────────────────────────
const datumFormat = new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
const kurzFormat = new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin', day: '2-digit', month: '2-digit' });
const zeitFormat = new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

const FUSS = 'Diese E-Mail wurde automatisch über FahrSync versendet. Bitte antworte nicht darauf – '
  + 'Fragen beantwortet dir dein Fahrlehrer.';

function textAbsage({ vorname, lehrerName, schulName, startMs }) {
  const d = new Date(startMs);
  return {
    betreff: `Deine Fahrstunde am ${kurzFormat.format(d)} wurde abgesagt`,
    text: [
      `Hallo${vorname ? ' ' + vorname : ''},`,
      '',
      `deine Fahrstunde am ${datumFormat.format(d)} um ${zeitFormat.format(d)} Uhr`
        + (lehrerName ? ` bei ${lehrerName}` : '') + ' wurde abgesagt.',
      '',
      'Für einen neuen Termin melde dich bitte bei deinem Fahrlehrer oder nutze deinen Buchungslink.',
      '',
      schulName || '',
      FUSS,
    ].filter((z, i, a) => !(z === '' && a[i - 1] === '')).join('\n'),
  };
}

function textTerminFrei({ vorname, lehrerName, schulName, startMs, endeMs, link }) {
  const d = new Date(startMs);
  const bis = endeMs ? '–' + zeitFormat.format(new Date(endeMs)) : '';
  return {
    betreff: 'Ein Termin ist frei geworden',
    text: [
      `Hallo${vorname ? ' ' + vorname : ''},`,
      '',
      (lehrerName ? `bei ${lehrerName}` : 'bei deinem Fahrlehrer') + ' ist ein Termin frei geworden:',
      '',
      `   ${datumFormat.format(d)}, ${zeitFormat.format(d)}${bis} Uhr`,
      '',
      'Du stehst auf der Warteliste. Über deinen Buchungslink kannst du den Termin anfragen – '
        + 'wer zuerst anfragt, bekommt ihn:',
      link,
      '',
      'Keine Nachrichten mehr? Trag dich über denselben Link einfach von der Warteliste aus.',
      '',
      schulName || '',
      FUSS,
    ].filter((z, i, a) => !(z === '' && a[i - 1] === '')).join('\n'),
  };
}

// ── Reaktion auf eine Stornierung ────────────────────────────────────
function ms(t) { return t && typeof t.toMillis === 'function' ? t.toMillis() : (typeof t === 'number' ? t : 0); }

// Ortszeit (Europe/Berlin) eines Zeitpunkts - so legt die App Sperren ab:
// Jahr, Monat (0 = Januar), Tag, Minuten seit Mitternacht.
const teileFormat = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Berlin', hourCycle: 'h23',
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
});
function berlinTeile(msWert) {
  const t = teileFormat.formatToParts(new Date(msWert)).reduce((o, p) => (o[p.type] = p.value, o), {});
  return { jahr: +t.year, monat: +t.month - 1, tag: +t.day, minuten: +t.hour * 60 + +t.minute,
           datum: `${t.year}-${t.month}-${t.day}` };
}

// Liegt der Termin in einer Sperrzeit / im Urlaub / an einem Sperrtag?
// Im Zweifel (Abfrage scheitert): ja - lieber nicht anbieten.
async function terminGesperrt(db, lehrerUid, schoolId, startMs, endeMs) {
  try {
    const a = berlinTeile(startMs), e = berlinTeile(endeMs || startMs);
    const tagFilter = (q) => q.where('year', '==', a.jahr).where('month', '==', a.monat).where('day', '==', a.tag);
    const [sperren, urlaub, schule] = await Promise.all([
      tagFilter(db.collection('blocked').where('lehrerUid', '==', lehrerUid)).get(),
      db.collection('urlaub').where('lehrerUid', '==', lehrerUid).get(),
      (typeof schoolId === 'string' && schoolId)
        ? tagFilter(db.collection('globalBlocked').where('schoolId', '==', schoolId)).get()
        : Promise.resolve({ empty: true }),
    ]);
    if (!schule.empty) return true;
    if (urlaub.docs.some(d => {
      const von = String(d.get('von') || ''), bis = String(d.get('bis') || '');
      return von && bis && a.datum >= von && a.datum <= bis;
    })) return true;
    return sperren.docs.some(d => {
      const b = d.data();
      if (b.ganztags !== false || b.vonMin == null || b.bisMin == null) return true;
      return a.minuten < b.bisMin && e.minuten > b.vonMin;
    });
  } catch (err) {
    console.warn('Sperrzeit pruefen:', err.message);
    return true;
  }
}

// Der frei gewordene Termin gehoert wieder in die oeffentliche Terminliste
// des Fahrlehrers (bookingLinks.freieSlots). Bisher trug ihn nur die App des
// Fahrlehrers dort ein: Stornierte ein SCHUELER, blieb der Termin unsichtbar,
// bis der Fahrlehrer den Kalender das naechste Mal oeffnete.
async function terminWiederAnbieten(db, lehrerUid, slotId, slot) {
  // Nie einen Termin anbieten, der in einer Sperrzeit, im Urlaub oder an
  // einem Sperrtag der Fahrschule liegt (so filtert auch die App).
  if (await terminGesperrt(db, lehrerUid, slot.schoolId, ms(slot.startTime), ms(slot.endTime))) return false;
  const ref = db.doc(`bookingLinks/${lehrerUid}`);
  return db.runTransaction(async (tx) => {
    const s = await tx.get(ref);
    if (!s.exists || s.get('aktiv') === false) return false;
    const liste = Array.isArray(s.get('freieSlots')) ? s.get('freieSlots') : [];
    if (liste.some(x => x && x.id === slotId)) return true;
    if (liste.length >= 500) return true;
    liste.push({
      id: slotId,
      start: new Date(ms(slot.startTime)).toISOString(),
      ende: new Date(ms(slot.endTime)).toISOString(),
      type: typeof slot.type === 'string' ? slot.type : 'fahrstunde',
    });
    tx.update(ref, { freieSlots: liste });
    return true;
  });
}

// vorher/nachher: Termin vor und nach der Aenderung (bookedBy: X -> leer).
// opt.senden(cfg, nachricht): Versand (Standard: SMTP)
// opt.push(lehrerUid, titel, text): Mitteilung an den Fahrlehrer
async function nachStornierung(db, slotId, vorher, nachher, opt = {}) {
  const jetzt = opt.jetzt || Date.now();
  const senden = opt.senden || smtpSenden;
  const erg = { absage: false, warteliste: 0, push: false };
  const schuelerId = vorher && vorher.bookedBy;
  if (!schuelerId || (nachher && nachher.bookedBy)) return erg;
  const startMs = ms(vorher.startTime), endeMs = ms(vorher.endTime);
  const lehrerUid = vorher.lehrerUid;
  // Vergangenes interessiert niemanden mehr
  if (!startMs || startMs <= jetzt || typeof lehrerUid !== 'string' || !ID_OK.test(lehrerUid)) return erg;
  if (typeof schuelerId !== 'string' || !ID_OK.test(schuelerId)) return erg;

  // Wer hat storniert? Der Schueler setzt storniertVonSchueler + storniertAt,
  // der Fahrlehrer absageAm - jeweils in GENAU dieser Aenderung (alte Marken
  // einer frueheren Stornierung zaehlen nicht).
  const selbst = nachher.storniertVonSchueler === schuelerId && ms(nachher.storniertAt) !== ms(vorher.storniertAt);
  const absage = !selbst && !!nachher.absageAm && ms(nachher.absageAm) !== ms(vorher.absageAm);
  const wirdGeloescht = nachher.wirdGeloescht === true;

  // 1) Schueler hat selbst storniert -> Fahrlehrer erfaehrt es sofort.
  //    Kein Name im Text: Er stuende auf dem Sperrbildschirm.
  if (selbst && opt.push) {
    try {
      const d = new Date(startMs);
      await opt.push(lehrerUid, '📅 Termin storniert',
        `${kurzFormat.format(d)} um ${zeitFormat.format(d)} Uhr wurde vom Schüler storniert – der Termin ist wieder frei.`);
      erg.push = true;
    } catch (e) { console.warn('Storno-Push:', e.message); }
  }

  // 2) Termin wieder anbieten (nicht, wenn er gleich geloescht wird)
  let angeboten = false;
  if (!wirdGeloescht) {
    try { angeboten = await terminWiederAnbieten(db, lehrerUid, slotId, vorher); }
    catch (e) { console.warn('Termin wieder anbieten:', e.message); }
  }

  const cfg = await mailEinstellungenLaden(db);
  if (!cfg) return erg;
  // Nur fuer Fahrlehrer, deren Kalender der Betreiber freigeschaltet hat
  if (!(await kalenderFreigeschaltet(db, lehrerUid))) return erg;

  const [lehrerSnap, linkSnap] = await Promise.all([
    db.doc(`kalenderUsers/${lehrerUid}`).get(), db.doc(`bookingLinks/${lehrerUid}`).get()]);
  const lehrerName = lehrerSnap.exists
    ? nameSauber(((lehrerSnap.get('fname') || '') + ' ' + (lehrerSnap.get('lname') || '')), 60) : '';
  const schulName = linkSnap.exists ? nameSauber(linkSnap.get('schoolName') || '', 60) : '';
  const absenderName = schulName ? `${schulName} (FahrSync)` : undefined;

  // 3) Absage an den betroffenen Schueler
  if (absage) {
    const sc = await db.doc(`schueler/${schuelerId}`).get();
    if (sc.exists && (sc.get('lehrerUid') === lehrerUid || (sc.get('schoolId') && sc.get('schoolId') === vorher.schoolId))) {
      const t = textAbsage({ vorname: nameSauber(sc.get('fname'), 40), lehrerName, schulName, startMs });
      erg.absage = await mailVerschicken(db, cfg,
        { an: String(sc.get('email') || '').trim(), betreff: t.betreff, text: t.text, absenderName, lehrerUid }, senden, jetzt);
    }
  }

  // 4) Warteliste: nur wenn der Termin wirklich wieder buchbar ist
  if (!angeboten) return erg;
  const slotJetzt = await db.doc(`slots/${slotId}`).get();
  if (!slotJetzt.exists || slotJetzt.get('bookedBy')) return erg;
  const wl = await db.collection('bookingWaitlist').where('lehrerUid', '==', lehrerUid).limit(50).get();
  for (const w of wl.docs) {
    if (erg.warteliste >= MAX_WARTELISTE_JE_TERMIN) break;
    if (w.id === schuelerId || !ID_OK.test(w.id)) continue;   // nicht an den, der gerade storniert hat
    if (w.get('status') !== 'wartend') continue;
    if (jetzt - (Number(w.get('mailAm')) || 0) < WARTELISTE_PAUSE_MS) continue;
    // Adresse und Vorname kommen aus dem Kalender-Schueler (vom Fahrlehrer
    // gepflegt) - NICHT aus dem Warteliste-Eintrag, den jeder mit dem Link
    // selbst schreibt.
    const sc = await db.doc(`schueler/${w.id}`).get();
    if (!sc.exists || sc.get('lehrerUid') !== lehrerUid) continue;
    const an = String(sc.get('email') || '').trim();
    if (!mailAdresseOk(an)) continue;
    const t = textTerminFrei({
      vorname: nameSauber(sc.get('fname'), 40), lehrerName, schulName, startMs, endeMs,
      link: `${APP_URL}?schueler=${w.id}&lehrer=${lehrerUid}`,
    });
    if (await mailVerschicken(db, cfg, { an, betreff: t.betreff, text: t.text, absenderName, lehrerUid }, senden, jetzt)) {
      erg.warteliste++;
      await w.ref.update({ mailAm: jetzt }).catch(() => {});
    }
  }
  return erg;
}

module.exports = {
  nachStornierung, terminWiederAnbieten, terminGesperrt, berlinTeile, mailEinstellungenLaden, mailStatus, einstellungenPruefen,
  verbindungPruefen, smtpSenden, mailVerschicken, textAbsage, textTerminFrei,
  mailAdresseOk, hostOk, eineZeile, nameSauber, kalenderFreigeschaltet,
  EINSTELLUNG, STATUS, MAX_PRO_TAG, MAX_PRO_LEHRER_UND_TAG, WARTELISTE_PAUSE_MS,
};
