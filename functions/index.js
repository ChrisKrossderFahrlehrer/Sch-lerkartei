// FahrSync Push-Benachrichtigungen (Cloud Functions v2, Region Frankfurt)
// Sendet data-only Nachrichten – der Service Worker zeigt sie an
// (zuverlaessig auf iOS-PWA und Android/Chrome, keine Doppelanzeige).
const { onDocumentCreated, onDocumentUpdated } = require('firebase-functions/v2/firestore');
const { onRequest, onCall, HttpsError } = require('firebase-functions/v2/https');
const { setGlobalOptions } = require('firebase-functions/v2');
const { defineSecret } = require('firebase-functions/params');
const admin = require('firebase-admin');
admin.initializeApp();
setGlobalOptions({ region: 'europe-west3', maxInstances: 5 });

// Google-Kalender-Sync: Client-Secret liegt NICHT im Code (Repo ist oeffentlich
// einsehbar), sondern im Firebase Secret Manager - siehe Deploy-Hinweis.
const GOOGLE_CLIENT_SECRET = defineSecret('GOOGLE_CLIENT_SECRET');
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
  if (!reqCtx.auth) throw new Error('Nicht angemeldet.');
  const uid = reqCtx.auth.uid;
  await admin.firestore().collection('calendarTokens').doc(uid).delete().catch(() => {});
  await admin.firestore().collection('calendarStatus').doc(uid).set({ connected: false }, { merge: true });
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

function baueRechnungsPdf({ nummer, datum, steller, empfaenger, planLabel, betrag }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 56 });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.fontSize(9).fillColor('#555').text(
      `${steller.name} · ${steller.strasse} · ${steller.plz} ${steller.ort}`, { align: 'left' }
    );
    doc.moveDown(2);

    doc.fontSize(11).fillColor('#000').text(empfaenger.name);
    doc.text(empfaenger.strasse);
    doc.text(`${empfaenger.plz} ${empfaenger.ort}`);
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
    doc.text('Bezahlt per PayPal – bereits vollständig beglichen.');
    doc.moveDown(2);
    doc.fontSize(8).fillColor('#888').text(`${steller.name} · ${steller.email} · ${steller.web}`, { align: 'left' });

    doc.end();
  });
}

exports.erstelleRechnung = onCall(async (request) => {
  const auth = request.auth;
  if (!auth) throw new HttpsError('unauthenticated', 'Bitte anmelden.');
  const uid = auth.uid;
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
    plz: '', ort: platImp.ort || 'Deutschland',
    email: platImp.email || 'kontakt@fahrsync.de',
    web: platImp.web || 'fahrsync.de',
  };
  const empfaenger = {
    name: b.name || userData.name || 'Kunde',
    strasse: b.rechnungsStrasse, plz: b.rechnungsPlz, ort: b.rechnungsOrt,
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
