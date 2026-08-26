// Neu-Bereitstellung erzwungen (13.08.2026): Sicherheitsfix erstelleRechnung (nur SuperAdmin)
// Node.js-Laufzeit auf 22 umgestellt (11.08.2026) - dieser Kommentar erzwingt ein echtes Neu-Bereitstellen
// FahrSync Push-Benachrichtigungen (Cloud Functions v2, Region Frankfurt)
// Sendet data-only Nachrichten – der Service Worker zeigt sie an
// (zuverlaessig auf iOS-PWA und Android/Chrome, keine Doppelanzeige).
const { onDocumentCreated, onDocumentUpdated } = require('firebase-functions/v2/firestore');
const { onRequest, onCall, HttpsError } = require('firebase-functions/v2/https');
const { setGlobalOptions } = require('firebase-functions/v2');
const { defineSecret } = require('firebase-functions/params');
const Stripe = require('stripe');
const admin = require('firebase-admin');
admin.initializeApp();
setGlobalOptions({ region: 'europe-west3', maxInstances: 5 });

// Google-Kalender-Sync: Client-Secret liegt NICHT im Code (Repo ist oeffentlich
// einsehbar), sondern im Firebase Secret Manager - siehe Deploy-Hinweis.
const GOOGLE_CLIENT_SECRET = defineSecret('GOOGLE_CLIENT_SECRET');

// PayPal-Webhook: Zugangsdaten liegen NICHT im Code (Repo ist oeffentlich),
// sondern im Firebase Secret Manager. PAYPAL_WEBHOOK_ID kommt aus dem
// PayPal-Entwicklerportal beim Anlegen des Webhooks (siehe Deploy-Hinweis).
const PAYPAL_CLIENT_ID     = defineSecret('PAYPAL_CLIENT_ID');
const PAYPAL_CLIENT_SECRET = defineSecret('PAYPAL_CLIENT_SECRET');
const PAYPAL_WEBHOOK_ID    = defineSecret('PAYPAL_WEBHOOK_ID');
const STRIPE_SECRET_KEY     = defineSecret('STRIPE_SECRET_KEY');
const STRIPE_WEBHOOK_SECRET = defineSecret('STRIPE_WEBHOOK_SECRET');
const GOOGLE_CLIENT_ID     = '140641089306-iovtr6gnoggkg6me8k2tk0c522o4oh0e.apps.googleusercontent.com';
const GOOGLE_REDIRECT_URI  = 'https://europe-west3-fahrschule-ebc65.cloudfunctions.net/kalenderOAuthCallback';
const APP_URL              = 'https://fahrsync.de/kalender.html';

async function pushToLehrer(lehrerUid, title, body, link) {
  const snap = await admin.firestore().collection('fcmTokens')
    .where('uid', '==', lehrerUid).get();
  if (snap.empty) return;
  const tokens = snap.docs.map(d => d.id);
  const res = await admin.messaging().sendEachForMulticast({
    tokens,
    data: {
      title: title,
      body: body,
      link: link || 'https://fahrsync.de/kalender.html'
    },
    webpush: { headers: { Urgency: 'high', TTL: '86400' } }
  });
  const dels = [];
  res.responses.forEach((r, i) => {
    if (!r.success) {
      const c = (r.error && r.error.code) || '';
      if (c.includes('registration-token-not-registered') ||
          c.includes('invalid-registration-token') ||
          c.includes('invalid-argument')) {
        dels.push(admin.firestore().collection('fcmTokens').doc(tokens[i]).delete());
      }
    }
  });
  await Promise.all(dels);
}

exports.pushNeueAnfrage = onDocumentCreated('bookingRequests/{id}', async (event) => {
  const r = event.data && event.data.data();
  if (!r || r.status !== 'angefragt' || !r.lehrerUid) return;
  let wann = '';
  try {
    const d = new Date(r.start);
    if (!isNaN(d)) wann = d.toLocaleString('de-DE', { timeZone: 'Europe/Berlin', weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) + ' Uhr';
  } catch (e) {}
  await pushToLehrer(r.lehrerUid, '📥 Neue Terminanfrage',
    `${r.vorname || 'Ein Schüler'} möchte ${wann || 'einen Termin'} buchen – jetzt bestätigen.`);
});

exports.pushNeueNachricht = onDocumentCreated('bookingMessages/{id}', async (event) => {
  const m = event.data && event.data.data();
  if (!m || !m.lehrerUid) return;
  await pushToLehrer(m.lehrerUid,
    `✉️ ${m.vorname || 'Schüler'}: Neue Nachricht`,
    (m.text || '').slice(0, 90));
});

// ══════════════════════════════════════════════════════════════════
// PUSH FUER DEN ADK-SCHUELERCHAT
//
// Der bestehende pushNeueNachricht horcht auf 'bookingMessages' - das ist
// AUSSCHLIESSLICH der Buchungs-Chat im Kalender. Der eigentliche Chat
// zwischen Fahrlehrer und Fahrschueler laeuft dagegen ueber das Feld
// 'messages' im accessCodes-Dokument. Fuer diesen Chat gab es deshalb noch
// NIE eine Benachrichtigung - genau die Kundenmeldung.
//
// Erkennung ueber die ID der letzten Nachricht statt ueber die Laenge:
// beide Seiten kappen die Liste auf 50 Eintraege, ab dann bliebe die
// Laenge gleich und ein Laengenvergleich wuerde neue Nachrichten uebersehen.
// ══════════════════════════════════════════════════════════════════
// Geraete-Token eines Fahrschuelers werden ueber die Code-Kennung
// gefunden (der Schueler hat kein eigenes Konto, nur eine anonyme Sitzung).
async function pushToSchueler(codeId, title, body) {
  const snap = await admin.firestore().collection('fcmTokens')
    .where('codeId', '==', codeId).get();
  if (snap.empty) return;
  const tokens = snap.docs.map(d => d.id);
  const res = await admin.messaging().sendEachForMulticast({
    tokens,
    data: { title, body, link: 'https://fahrsync.de/schueler-portal.html' },
    webpush: { headers: { Urgency: 'high', TTL: '86400' } }
  });
  const dels = [];
  res.responses.forEach((r, i) => {
    if (!r.success) {
      const c = (r.error && r.error.code) || '';
      if (c.includes('registration-token-not-registered') ||
          c.includes('invalid-registration-token') ||
          c.includes('invalid-argument')) {
        dels.push(admin.firestore().collection('fcmTokens').doc(tokens[i]).delete());
      }
    }
  });
  await Promise.all(dels);
}

exports.pushNeueChatNachricht = onDocumentUpdated('accessCodes/{codeId}', async (event) => {
  try {
    const before = (event.data && event.data.before && event.data.before.data()) || {};
    const after  = (event.data && event.data.after  && event.data.after.data())  || {};

    const vor  = Array.isArray(before.messages) ? before.messages : [];
    const nach = Array.isArray(after.messages)  ? after.messages  : [];
    if (!nach.length) return;

    const letzteVor  = vor.length ? vor[vor.length - 1] : null;
    const letzteNach = nach[nach.length - 1];
    if (letzteVor && letzteNach && letzteVor.id === letzteNach.id) return; // nichts Neues

    if (!letzteNach) return;
    const text = String(letzteNach.text || '').slice(0, 90);

    if (letzteNach.sender === 'schueler') {
      // Schueler -> Fahrlehrer
      if (!after.teacherUid) return;
      await pushToLehrer(
        after.teacherUid,
        `✉️ ${letzteNach.senderName || 'Fahrschüler'}: Neue Nachricht`,
        text,
        'https://fahrsync.de/'
      );
    } else if (letzteNach.sender === 'fahrlehrer') {
      // Fahrlehrer -> Schueler (Token ueber die Code-Kennung)
      await pushToSchueler(
        event.params.codeId,
        `✉️ ${letzteNach.senderName || 'Dein Fahrlehrer'}: Neue Nachricht`,
        text
      );
    }
  } catch (e) {
    console.error('pushNeueChatNachricht:', e);
  }
});

// ══════════ GOOGLE-KALENDER-SYNC (Phase 1: Fahrlehrer, FahrSync -> Google) ══════════

async function refreshAccessTokenIfNeeded(uid, secretValue) {
  const ref = admin.firestore().collection('calendarTokens').doc(uid);
  const snap = await ref.get();
  if (!snap.exists) return null;
  const data = snap.data();
  if (data.expiry && data.expiry > Date.now() + 60000) return data.access_token;
  if (!data.refresh_token) return null;
  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      client_secret: secretValue,
      refresh_token: data.refresh_token,
      grant_type: 'refresh_token'
    })
  });
  const tok = await resp.json();
  if (!tok.access_token) { console.warn('Token-Refresh fehlgeschlagen:', tok); return null; }
  await ref.set({ access_token: tok.access_token, expiry: Date.now() + (tok.expires_in * 1000) }, { merge: true });
  return tok.access_token;
}

async function googleCalendarRequest(uid, secretValue, method, path, body) {
  const accessToken = await refreshAccessTokenIfNeeded(uid, secretValue);
  if (!accessToken) return null;
  const resp = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/${path}`, {
    method,
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  if (resp.status === 204) return {};
  return resp.json().catch(() => ({}));
}

// Schritt 1: Google leitet hierher zurueck (nach Zustimmung des Nutzers)
exports.kalenderOAuthCallback = onRequest({ secrets: [GOOGLE_CLIENT_SECRET] }, async (req, res) => {
  try {
    const { code, state, error } = req.query;
    if (error || !code || !state) return res.redirect(`${APP_URL}?calsync=error`);

    const stateRef = admin.firestore().collection('oauthStates').doc(String(state));
    const stateSnap = await stateRef.get();
    if (!stateSnap.exists) return res.redirect(`${APP_URL}?calsync=invalid_state`);
    const { uid } = stateSnap.data();
    await stateRef.delete();

    const tokenResp = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code: String(code),
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET.value(),
        redirect_uri: GOOGLE_REDIRECT_URI,
        grant_type: 'authorization_code'
      })
    });
    const tokens = await tokenResp.json();
    if (!tokens.access_token) { console.error('Token-Austausch fehlgeschlagen:', tokens); return res.redirect(`${APP_URL}?calsync=error`); }

    const tokenRef = admin.firestore().collection('calendarTokens').doc(uid);
    await tokenRef.set({
      refresh_token: tokens.refresh_token || admin.firestore.FieldValue.delete(),
      access_token: tokens.access_token,
      expiry: Date.now() + (tokens.expires_in * 1000),
      connectedAt: Date.now()
    }, { merge: true });

    const check = (await tokenRef.get()).data();
    if (!check || !check.refresh_token) {
      await admin.firestore().collection('calendarStatus').doc(uid).set({ connected: false, error: 'no_refresh_token' }, { merge: true });
      return res.redirect(`${APP_URL}?calsync=no_refresh`);
    }
    await admin.firestore().collection('calendarStatus').doc(uid).set({ connected: true, connectedAt: Date.now() }, { merge: true });
    res.redirect(`${APP_URL}?calsync=success`);
  } catch (e) {
    console.error('kalenderOAuthCallback', e);
    res.redirect(`${APP_URL}?calsync=error`);
  }
});

// Verbindung trennen (vom Client aufrufbar)
exports.trennKalenderVerbindung = onCall({ region: 'europe-west3' }, async (reqCtx) => {
  if (!reqCtx.auth) {
    throw new HttpsError('unauthenticated', 'Bitte zuerst anmelden.');
  }
  const uid = reqCtx.auth.uid;
  try {
    await admin.firestore().collection('calendarTokens').doc(uid).delete();
  } catch (e) {
    console.warn('trennKalenderVerbindung: Token loeschen fehlgeschlagen', e);
  }
  try {
    await admin.firestore().collection('calendarStatus').doc(uid)
      .set({ connected: false, getrenntAm: Date.now() }, { merge: true });
  } catch (e) {
    console.error('trennKalenderVerbindung: Status setzen fehlgeschlagen', e);
    throw new HttpsError('internal', 'Status konnte nicht gesetzt werden: ' + (e.message || String(e)));
  }
  return { ok: true };
});

// Schritt 2: Termin bestaetigt/freigegeben -> Google-Kalender-Ereignis anlegen/loeschen
// (Phase 1: nur Fahrlehrer-Seite. Schueler-seitiger Abgleich folgt separat.)
// ══ RECHNUNGS-ERZEUGUNG (PDF) ═══════════════════════════════════════
// Wird vom Client direkt nach erfolgreicher PayPal-Aktivierung aufgerufen.
// WICHTIG (bekannte Einschraenkung): Es existiert noch kein PayPal-Webhook.
// Diese Funktion erzeugt daher nur bei der Erstaktivierung/einem Tarif-
// wechsel eine Rechnung - spaetere automatische Verlaengerungen ueber
// PayPal loesen aktuell KEINE neue Rechnung aus. Fuer laufende monatliche
// Rechnungen braeuchte es zusaetzlich einen PayPal-Webhook.
const PDFDocument = require('pdfkit');

const RECHNUNG_PLANS = {
  solo:       { label: 'Solo (eigenstaendiger Fahrlehrer)', price: 9.99,  pricePlaner: 13.99 },
  bis5:       { label: 'Fahrschule bis 5 Fahrlehrer',       price: 12.99, pricePlaner: 16.99 },
  bis10:      { label: 'Fahrschule bis 10 Fahrlehrer',      price: 20.99, pricePlaner: 25.99 },
  bis15:      { label: 'Fahrschule bis 15 Fahrlehrer',      price: 26.99, pricePlaner: 34.99 },
  unbegrenzt: { label: 'Fahrschule unbegrenzt',             price: 34.99, pricePlaner: 40.99 },
};

function baueRechnungsPdf({ nummer, datum, steller, empfaenger, planLabel, betrag, zahlungsart }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 56 });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    // Absenderzeile aus den tatsaechlich gefuellten Feldern bauen - vorher
    // erzeugten leere Felder (v.a. die nie befuellte PLZ) Luecken wie
    // "Name ·  ·  Ort" auf der Rechnung.
    const stellerZeile = [
      steller.name,
      steller.strasse,
      [steller.plz, steller.ort].filter(Boolean).join(' '),
      steller.steuernummer ? `St-Nr. ${steller.steuernummer}` : null
    ].map(t => String(t || '').trim()).filter(Boolean).join(' · ');
    doc.fontSize(9).fillColor('#555').text(stellerZeile, { align: 'left' });
    doc.moveDown(2);

    doc.fontSize(11).fillColor('#000').text(empfaenger.name);
    doc.text(empfaenger.strasse);
    doc.text(`${empfaenger.plz} ${empfaenger.ort}`);
    if (empfaenger.land) doc.text(empfaenger.land);
    doc.moveDown(2);

    doc.fontSize(18).fillColor('#000').text(`Rechnung Nr. ${nummer}`, { align: 'left' });
    doc.moveDown(0.3);
    doc.fontSize(10).fillColor('#555').text(`Rechnungsdatum: ${datum}`);
    doc.moveDown(1.5);

    const top = doc.y;
    doc.fontSize(10).fillColor('#000');
    doc.text('Beschreibung', 56, top, { width: 300 });
    doc.text('Betrag', 400, top, { width: 140, align: 'right' });
    doc.moveTo(56, top + 16).lineTo(539, top + 16).strokeColor('#ccc').stroke();

    const rowY = top + 26;
    doc.text(`${planLabel} – monatliches Abonnement`, 56, rowY, { width: 300 });
    doc.text(`${betrag.toFixed(2).replace('.', ',')} €`, 400, rowY, { width: 140, align: 'right' });
    doc.moveTo(56, rowY + 20).lineTo(539, rowY + 20).strokeColor('#ccc').stroke();

    doc.fontSize(11).text('Gesamtbetrag', 56, rowY + 32, { width: 300 });
    doc.font('Helvetica-Bold').text(`${betrag.toFixed(2).replace('.', ',')} €`, 400, rowY + 32, { width: 140, align: 'right' });
    doc.font('Helvetica');

    doc.moveDown(4);
    doc.fontSize(9).fillColor('#333').text('Gemäß § 19 UStG wird keine Umsatzsteuer berechnet.');
    doc.moveDown(0.5);
    doc.text(`Bezahlt per ${zahlungsart || 'PayPal'} – bereits vollständig beglichen.`);
    doc.moveDown(2);
    doc.fontSize(8).fillColor('#888').text(`${steller.name} · ${steller.email} · ${steller.web}`, { align: 'left' });

    doc.end();
  });
}

exports.erstelleRechnung = onCall(async (request) => {
  const auth = request.auth;
  if (!auth) throw new HttpsError('unauthenticated', 'Bitte anmelden.');
  const uid = auth.uid;

  // SuperAdmin-Pruefung: entweder per E-Mail, oder per Firestore-Rolle -
  // dieselben zwei Wege, die auch die Firestore-Regeln selbst nutzen.
  const istSuperAdminEmail = auth.token.email === 'chriskoo@mail.de';
  let istSuperAdminRolle = false;
  if (!istSuperAdminEmail) {
    const eigenesDoc = await admin.firestore().doc(`users/${uid}`).get();
    istSuperAdminRolle = eigenesDoc.exists && eigenesDoc.data().rolle === 'superadmin';
  }
  if (!istSuperAdminEmail && !istSuperAdminRolle) {
    throw new HttpsError('permission-denied', 'Echte Rechnungen entstehen automatisch bei der Zahlung. Diese Funktion ist nur fuer Testzwecke.');
  }
  const { plan, planer } = request.data || {};
  if (!plan || !RECHNUNG_PLANS[plan]) {
    throw new HttpsError('invalid-argument', 'Unbekannter Tarif.');
  }

  const userSnap = await admin.firestore().doc(`users/${uid}`).get();
  if (!userSnap.exists) throw new HttpsError('failed-precondition', 'Nutzerprofil nicht gefunden.');
  const userData = userSnap.data();

  // Dieselbe Ermittlung wie im Client (window.__billingDocRef): Fahrschule
  // oder eigenstaendiger Fahrlehrer sind jeweils selbst der Rechnungsempfaenger.
  let billingColl, billingId;
  if (userData.typ === 'fahrschule') {
    billingColl = 'fahrschulen'; billingId = uid;
  } else if (!userData.fahrschuleId || userData.fahrschuleId === uid) {
    billingColl = 'users'; billingId = uid;
  } else {
    throw new HttpsError('permission-denied', 'Nur der Fahrschul-Inhaber kann eine Rechnung anfordern.');
  }

  const billingSnap = await admin.firestore().doc(`${billingColl}/${billingId}`).get();
  const b = billingSnap.exists ? billingSnap.data() : {};
  if (!b.rechnungsStrasse || !b.rechnungsPlz || !b.rechnungsOrt) {
    throw new HttpsError('failed-precondition', 'Bitte zuerst die Rechnungsadresse ausfüllen.');
  }

  const planInfo = RECHNUNG_PLANS[plan];
  const betrag = planer ? planInfo.pricePlaner : planInfo.price;

  // Fortlaufende, luecken- und ueberschneidungsfreie Rechnungsnummer per
  // Transaktion - Pflicht nach § 14 UStG.
  const counterRef = admin.firestore().doc('platform/rechnungszaehler');
  const nummer = await admin.firestore().runTransaction(async (tx) => {
    const c = await tx.get(counterRef);
    const jahr = new Date().getFullYear();
    const bisher = c.exists ? (c.data().naechsteNummer || 1) : 1;
    tx.set(counterRef, { naechsteNummer: bisher + 1 }, { merge: true });
    return `${jahr}-${String(bisher).padStart(5, '0')}`;
  });

  const platDoc = await admin.firestore().doc('platform/impressum').get();
  const platImp = platDoc.exists ? platDoc.data() : {};
  const steller = {
    name: platImp.name || 'Chriskoo',
    strasse: platImp.strasse || '',
    plz: platImp.plz || '',
    ort: platImp.ort || '',
    email: platImp.email || 'kontakt@fahrsync.de',
    web: platImp.web || 'fahrsync.de',
    // Pflichtangabe nach §14 Abs.4 UStG (gilt auch fuer Kleinunternehmer):
    // Steuernummer, seit 24.08.2026 vom Finanzamt Luckenwalde vorliegend.
    steuernummer: platImp.steuernummer || '050/240/09485',
  };
  const LAENDER = { DE: '', AT: 'Österreich', CH: 'Schweiz', XX: '' };
  const empfaenger = {
    name: b.name || userData.name || 'Kunde',
    strasse: b.rechnungsStrasse, plz: b.rechnungsPlz, ort: b.rechnungsOrt,
    land: LAENDER[b.rechnungsLand || 'DE'] || '',
  };
  const datum = new Date().toLocaleDateString('de-DE');

  const pdfBuffer = await baueRechnungsPdf({ nummer, datum, steller, empfaenger, planLabel: planInfo.label, betrag });
  const pdfBase64 = pdfBuffer.toString('base64');

  const rechnungRef = admin.firestore().collection('rechnungen').doc();
  await rechnungRef.set({
    nummer, empfaengerId: uid, empfaengerName: empfaenger.name,
    plan, planer: !!planer, betrag, datum, erstelltAm: Date.now(),
    pdfBase64,
  });

  return { success: true, nummer, invoiceId: rechnungRef.id };
});

exports.syncSlotToGoogleCalendar = onDocumentUpdated({ document: 'slots/{slotId}', secrets: [GOOGLE_CLIENT_SECRET] }, async (event) => {
  const before = event.data.before.data();
  const after  = event.data.after.data();
  if (!before || !after || !after.lehrerUid) return;
  const secretValue = GOOGLE_CLIENT_SECRET.value();

  const wurdeGebucht     = !before.bookedBy && after.bookedBy;
  const wurdeFreigegeben = before.bookedBy && !after.bookedBy;
  if (!wurdeGebucht && !wurdeFreigegeben) return;

  try {
    const tokenSnap = await admin.firestore().collection('calendarTokens').doc(after.lehrerUid).get();
    if (!tokenSnap.exists) return; // Fahrlehrer hat keinen Kalender verbunden

    if (wurdeGebucht) {
      let titel = 'Fahrstunde';
      try {
        // FIX: 'schueler' (Kalender-eigene Liste) speichert fname/lname,
        // nicht vorname/nachname (das ist nur in der ADK-Kartei so) -
        // dadurch blieb der Name im Google-Kalender-Titel bisher leer.
        const scSnap = await admin.firestore().collection('schueler').doc(after.bookedBy).get();
        if (scSnap.exists) {
          const name = `${(scSnap.data().fname || '')} ${(scSnap.data().lname || '')}`.trim();
          if (name) titel = `Fahrstunde – ${name}`;
        }
      } catch (e) { /* Titel-Fallback reicht */ }
      const ev = await googleCalendarRequest(after.lehrerUid, secretValue, 'POST', 'events', {
        summary: titel,
        start: { dateTime: after.startTime.toDate().toISOString(), timeZone: 'Europe/Berlin' },
        end:   { dateTime: after.endTime.toDate().toISOString(),   timeZone: 'Europe/Berlin' },
        description: 'Automatisch synchronisiert von FahrSync'
      });
      if (ev && ev.id) await event.data.after.ref.set({ googleEventId: ev.id }, { merge: true });
    } else if (wurdeFreigegeben && before.googleEventId) {
      await googleCalendarRequest(after.lehrerUid, secretValue, 'DELETE', `events/${before.googleEventId}`);
    }
  } catch (e) { console.warn('syncSlotToGoogleCalendar', e.message); }
});

// ══════════════════════════════════════════════════════════════════
// STRIPE: Kreditkarte + SEPA-Lastschrift (zusaetzlich zu PayPal)
//
// Kundenwunsch: Kreditkarte schaltet sofort frei, SEPA-Lastschrift erst
// nach tatsaechlicher Bestaetigung (dauert mehrere Werktage, kann
// zurueckgehen). Stripe unterscheidet dafuer klar zwischen zwei
// Ereignissen: checkout.session.completed (sofort, mit payment_status
// 'paid' bei Karte / 'unpaid' bei noch schwebender SEPA-Lastschrift) und
// checkout.session.async_payment_succeeded (feuert SEPARAT, erst wenn eine
// verzoegerte Zahlung wie SEPA tatsaechlich durchgegangen ist). Aktivierung
// und Rechnung entstehen deshalb an ZWEI Stellen, aber ueber dieselbe
// gemeinsame Funktion, damit beide Wege exakt gleich behandelt werden.
// ══════════════════════════════════════════════════════════════════

exports.createStripeCheckoutSession = onCall({ secrets: [STRIPE_SECRET_KEY] }, async (request) => {
  const auth = request.auth;
  if (!auth) throw new HttpsError('unauthenticated', 'Bitte anmelden.');
  const uid = auth.uid;
  const { plan, planer } = request.data || {};
  if (!plan || !RECHNUNG_PLANS[plan]) {
    throw new HttpsError('invalid-argument', 'Ungueltiger Tarif.');
  }

  // Dieselbe Zuordnung wie bei PayPal: Fahrschule ODER Solo-Nutzer
  const userDoc = await admin.firestore().doc(`users/${uid}`).get();
  if (!userDoc.exists) throw new HttpsError('failed-precondition', 'Kein Profil gefunden.');
  const userData = userDoc.data();
  const billingColl = userData.fahrschuleId ? 'fahrschulen' : 'users';
  const billingId   = userData.fahrschuleId || uid;
  const billingDoc  = await admin.firestore().doc(`${billingColl}/${billingId}`).get();
  const b = billingDoc.exists ? billingDoc.data() : {};
  if (!b.rechnungsStrasse || !b.rechnungsPlz || !b.rechnungsOrt) {
    throw new HttpsError('failed-precondition', 'Bitte zuerst eine Rechnungsadresse hinterlegen.');
  }

  const planInfo = RECHNUNG_PLANS[plan];
  const betrag = planer ? planInfo.pricePlaner : planInfo.price;
  const stripe = new Stripe(STRIPE_SECRET_KEY.value());

  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    payment_method_types: ['card', 'sepa_debit'],
    line_items: [{
      price_data: {
        currency: 'eur',
        product_data: { name: `FahrSync – ${planInfo.label}` },
        unit_amount: Math.round(betrag * 100),
        recurring: { interval: 'month' },
      },
      quantity: 1,
    }],
    client_reference_id: `${billingColl}:${billingId}`,
    metadata: { plan, planer: planer ? '1' : '0', billingColl, billingId },
    success_url: `https://fahrsync.de/index.html?stripe=erfolg${request.data.rueckkehrZusatz || ''}`,
    cancel_url:  `https://fahrsync.de/index.html?stripe=abgebrochen${request.data.rueckkehrZusatz || ''}`,
  });

  return { url: session.url };
});

// Gemeinsame Aktivierung + Rechnung, genutzt von BEIDEN Webhook-Zweigen
// (sofortige Kartenzahlung und spaeter bestaetigte SEPA-Lastschrift).
async function stripeAboAktivierenUndRechnung(session, stripeEventId, zahlungsart) {
  const { billingColl, billingId, plan, planer } = session.metadata || {};
  if (!billingColl || !billingId || !plan) return;

  // Idempotenz: dasselbe Stripe-Ereignis darf nicht zweimal verarbeitet werden
  const bereits = await admin.firestore().collection('rechnungen')
    .where('stripeSessionId', '==', session.id).limit(1).get();
  if (!bereits.empty) return;

  const planInfo = RECHNUNG_PLANS[plan];
  if (!planInfo) return;

  const billingRef = admin.firestore().doc(`${billingColl}/${billingId}`);
  const billingSnap = await billingRef.get();
  if (!billingSnap.exists) return;
  const b = billingSnap.data();
  if (!b.rechnungsStrasse || !b.rechnungsPlz || !b.rechnungsOrt) return;

  await billingRef.update({
    abo: plan, aboPlaner: planer === '1', aboStatus: 'aktiv',
    aboZahlungsart: 'stripe', aboLetzteZahlungAm: Date.now(),
  });

  const betrag = planer === '1' ? planInfo.pricePlaner : planInfo.price;
  const counterRef = admin.firestore().doc('platform/rechnungszaehler');
  const nummer = await admin.firestore().runTransaction(async (tx) => {
    const c = await tx.get(counterRef);
    const jahr = new Date().getFullYear();
    const bisher = c.exists ? (c.data().naechsteNummer || 1) : 1;
    tx.set(counterRef, { naechsteNummer: bisher + 1 }, { merge: true });
    return `${jahr}-${String(bisher).padStart(5, '0')}`;
  });

  const platDoc = await admin.firestore().doc('platform/impressum').get();
  const platImp = platDoc.exists ? platDoc.data() : {};
  const steller = {
    name: platImp.name || 'Chriskoo', strasse: platImp.strasse || '',
    plz: platImp.plz || '', ort: platImp.ort || '',
    email: platImp.email || 'kontakt@fahrsync.de', web: platImp.web || 'fahrsync.de',
    steuernummer: platImp.steuernummer || '050/240/09485',
  };
  const LAENDER = { DE: '', AT: 'Österreich', CH: 'Schweiz', XX: '' };
  const empfaenger = {
    name: b.name || 'Kunde',
    strasse: b.rechnungsStrasse, plz: b.rechnungsPlz, ort: b.rechnungsOrt,
    land: LAENDER[b.rechnungsLand || 'DE'] || '',
  };
  const datum = new Date().toLocaleDateString('de-DE');
  const pdfBuffer = await baueRechnungsPdf({ nummer, datum, steller, empfaenger, planLabel: planInfo.label, betrag, zahlungsart });

  await admin.firestore().collection('rechnungen').add({
    nummer, empfaengerId: billingId, empfaengerName: empfaenger.name,
    plan, planer: planer === '1', betrag, datum, erstelltAm: Date.now(),
    pdfBase64: pdfBuffer.toString('base64'),
    stripeSessionId: session.id,
  });
  console.log('stripeWebhook: Rechnung', nummer, 'erzeugt fuer', billingColl, billingId, '(Ereignis', stripeEventId, ')');
}

exports.stripeWebhook = onRequest(
  { secrets: [STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET], rawBody: true },
  async (req, res) => {
    const stripe = new Stripe(STRIPE_SECRET_KEY.value());
    let event;
    try {
      event = stripe.webhooks.constructEvent(
        req.rawBody, req.headers['stripe-signature'], STRIPE_WEBHOOK_SECRET.value()
      );
    } catch (e) {
      console.warn('stripeWebhook: Signatur ungueltig', e.message);
      res.status(400).send('invalid signature');
      return;
    }

    try {
      if (event.type === 'checkout.session.completed') {
        const session = event.data.object;
        // Nur bei SOFORT bezahlt (Karte) hier aktivieren. Bei noch
        // schwebender SEPA-Lastschrift ('unpaid'/'no_payment_required'
        // greift hier nicht) uebernimmt async_payment_succeeded weiter unten.
        if (session.payment_status === 'paid') {
          await stripeAboAktivierenUndRechnung(session, event.id, 'Kreditkarte');
        }
      } else if (event.type === 'checkout.session.async_payment_succeeded') {
        // SEPA-Lastschrift wurde jetzt tatsaechlich bestaetigt.
        const session = event.data.object;
        await stripeAboAktivierenUndRechnung(session, event.id, 'SEPA-Lastschrift');
      } else if (event.type === 'checkout.session.async_payment_failed') {
        const session = event.data.object;
        const { billingColl, billingId } = session.metadata || {};
        if (billingColl && billingId) {
          console.warn('stripeWebhook: SEPA-Lastschrift fehlgeschlagen fuer', billingColl, billingId);
        }
      }
      res.status(200).send('ok');
    } catch (e) {
      console.error('stripeWebhook Fehler:', e);
      // 200 statt 500: verhindert, dass Stripe denselben fehlerhaften
      // Vorgang endlos wiederholt zustellt.
      res.status(200).send('ok - Fehler geloggt');
    }
  }
);

// ══ ADMIN: E-Mail manuell bestaetigen (SuperAdmin-only) ═════════
// Fuer Testkonten, bei denen die Bestaetigungs-Mail nicht ankommt (Spam-
// Filter, Zustellverzoegerung). Nutzt die Admin-SDK, die das direkt
// setzen kann, ohne den eigentlichen Mail-Link zu brauchen.
exports.adminEmailBestaetigen = onCall(async (request) => {
  const auth = request.auth;
  if (!auth) throw new HttpsError('unauthenticated', 'Bitte anmelden.');
  const istSuperAdminEmail = auth.token.email === 'chriskoo@mail.de';
  let istSuperAdminRolle = false;
  if (!istSuperAdminEmail) {
    const eigenesDoc = await admin.firestore().doc(`users/${auth.uid}`).get();
    istSuperAdminRolle = eigenesDoc.exists && eigenesDoc.data().rolle === 'superadmin';
  }
  if (!istSuperAdminEmail && !istSuperAdminRolle) {
    throw new HttpsError('permission-denied', 'Nur fuer SuperAdmin.');
  }
  const { email } = request.data || {};
  if (!email) throw new HttpsError('invalid-argument', 'E-Mail fehlt.');
  const user = await admin.auth().getUserByEmail(email);
  await admin.auth().updateUser(user.uid, { emailVerified: true });
  return { success: true, uid: user.uid };
});




// ═══════════════════════════════════════════════════════════════════
// PAYPAL WEBHOOK - server-zu-server, unabhaengig vom Browser
//
// Bisher lief die Abo-Aktivierung UND Rechnungserzeugung ausschliesslich
// im Browser (onApprove-Callback von PayPal). Das hatte zwei Probleme:
//  1) Sicherheit: Der Aufruf liess sich theoretisch auch ohne echte
//     Zahlung aus der Browser-Konsole heraus auslösen.
//  2) Wiederkehrende Zahlungen: Bei der monatlichen Verlaengerung ist
//     niemand im Browser eingeloggt, der onApprove-Callback feuert nie
//     wieder - es entstand also nie eine Folge-Rechnung.
//
// Dieser Webhook loest beides: PayPal ruft ihn bei JEDER erfolgreichen
// Zahlung (Erst- UND Folgezahlung) direkt server-seitig auf. Die Signatur
// wird geprueft, damit niemand gefaelschte Anfragen schicken kann.
// ═══════════════════════════════════════════════════════════════════

async function paypalAccessToken(clientId, clientSecret) {
  const resp = await fetch('https://api-m.paypal.com/v1/oauth2/token', {
    method: 'POST',
    headers: {
      'Authorization': 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  const data = await resp.json();
  if (!data.access_token) throw new Error('PayPal-Zugriffstoken nicht erhalten');
  return data.access_token;
}

exports.paypalWebhook = onRequest(
  { secrets: [PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, PAYPAL_WEBHOOK_ID] },
  async (req, res) => {
    try {
      const clientId     = PAYPAL_CLIENT_ID.value();
      const clientSecret = PAYPAL_CLIENT_SECRET.value();
      const webhookId    = PAYPAL_WEBHOOK_ID.value();

      // 1) Signatur pruefen - bestaetigt, dass die Anfrage wirklich von
      // PayPal kommt und nicht gefaelscht ist.
      const accessToken = await paypalAccessToken(clientId, clientSecret);
      const verifyResp = await fetch('https://api-m.paypal.com/v1/notifications/verify-webhook-signature', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          auth_algo:         req.headers['paypal-auth-algo'],
          cert_url:          req.headers['paypal-cert-url'],
          transmission_id:   req.headers['paypal-transmission-id'],
          transmission_sig:  req.headers['paypal-transmission-sig'],
          transmission_time: req.headers['paypal-transmission-time'],
          webhook_id:        webhookId,
          webhook_event:     req.body,
        }),
      });
      const verifyData = await verifyResp.json();
      if (verifyData.verification_status !== 'SUCCESS') {
        console.warn('paypalWebhook: Signatur ungueltig', verifyData);
        res.status(400).send('invalid signature');
        return;
      }

      const event = req.body || {};

      // ── Erfolgreiche Zahlung (Erst- ODER Folgezahlung) ──
      if (event.event_type === 'PAYMENT.SALE.COMPLETED') {
        const resource = event.resource || {};
        const subscriptionId = resource.billing_agreement_id;
        const saleId = resource.id;
        const betragBezahlt = parseFloat((resource.amount || {}).total || '0');

        if (!subscriptionId || !saleId) { res.status(200).send('ok - kein Abo-Bezug'); return; }

        // Idempotenz: PayPal kann denselben Webhook mehrfach zustellen -
        // pro Zahlung darf nur eine Rechnung entstehen.
        const bereits = await admin.firestore().collection('rechnungen')
          .where('paypalSaleId', '==', saleId).limit(1).get();
        if (!bereits.empty) { res.status(200).send('ok - bereits verarbeitet'); return; }

        // Zugehoerige Fahrschule/Nutzer anhand der Subscription-ID finden
        let billingColl = null, billingId = null, billingData = null;
        for (const coll of ['fahrschulen', 'users']) {
          const snap = await admin.firestore().collection(coll)
            .where('aboSubscriptionId', '==', subscriptionId).limit(1).get();
          if (!snap.empty) {
            billingColl = coll; billingId = snap.docs[0].id; billingData = snap.docs[0].data();
            break;
          }
        }
        if (!billingColl) {
          console.warn('paypalWebhook: keine Fahrschule/Nutzer zu Subscription', subscriptionId);
          res.status(200).send('ok - kein Treffer'); return;
        }

        const planInfo = RECHNUNG_PLANS[billingData.abo];
        if (!planInfo) { res.status(200).send('ok - unbekannter Tarif'); return; }
        if (!billingData.rechnungsStrasse || !billingData.rechnungsPlz || !billingData.rechnungsOrt) {
          console.warn('paypalWebhook: Rechnungsadresse fehlt fuer', billingColl, billingId);
          res.status(200).send('ok - keine Rechnungsadresse hinterlegt'); return;
        }

        const counterRef = admin.firestore().doc('platform/rechnungszaehler');
        const nummer = await admin.firestore().runTransaction(async (tx) => {
          const c = await tx.get(counterRef);
          const jahr = new Date().getFullYear();
          const bisher = c.exists ? (c.data().naechsteNummer || 1) : 1;
          tx.set(counterRef, { naechsteNummer: bisher + 1 }, { merge: true });
          return `${jahr}-${String(bisher).padStart(5, '0')}`;
        });

        const platDoc = await admin.firestore().doc('platform/impressum').get();
        const platImp = platDoc.exists ? platDoc.data() : {};
        const steller = {
          name: platImp.name || 'Chriskoo', strasse: platImp.strasse || '',
          plz: platImp.plz || '', ort: platImp.ort || '',
          email: platImp.email || 'kontakt@fahrsync.de', web: platImp.web || 'fahrsync.de',
          steuernummer: platImp.steuernummer || '050/240/09485',
        };
        const LAENDER = { DE: '', AT: 'Österreich', CH: 'Schweiz', XX: '' };
        const empfaenger = {
          name: billingData.name || 'Kunde',
          strasse: billingData.rechnungsStrasse, plz: billingData.rechnungsPlz, ort: billingData.rechnungsOrt,
          land: LAENDER[billingData.rechnungsLand || 'DE'] || '',
        };
        const datum = new Date().toLocaleDateString('de-DE');
        const betrag = betragBezahlt || (billingData.aboPlaner ? planInfo.pricePlaner : planInfo.price);
        const pdfBuffer = await baueRechnungsPdf({ nummer, datum, steller, empfaenger, planLabel: planInfo.label, betrag, zahlungsart: 'PayPal' });

        await admin.firestore().collection('rechnungen').add({
          nummer, empfaengerId: billingId, empfaengerName: empfaenger.name,
          plan: billingData.abo, planer: !!billingData.aboPlaner, betrag, datum,
          erstelltAm: Date.now(),
          pdfBase64: pdfBuffer.toString('base64'),
          paypalSaleId: saleId, paypalSubscriptionId: subscriptionId,
        });
        await admin.firestore().doc(`${billingColl}/${billingId}`).update({ aboLetzteZahlungAm: Date.now() });
        console.log('paypalWebhook: Rechnung', nummer, 'erzeugt fuer', billingColl, billingId);
      }

      res.status(200).send('ok');
    } catch (e) {
      console.error('paypalWebhook Fehler:', e);
      // 200 statt 500: verhindert, dass PayPal denselben (evtl. defekten)
      // Event minutenlang wiederholt zustellt, waehrend der Fehler im Log
      // trotzdem sichtbar bleibt.
      res.status(200).send('error geloggt');
    }
  }
);
