// Neu-Bereitstellung erzwungen (13.09.2026): erstelleRechnung entfernt - beim
// naechsten Bereitstellen wird die Funktion in Firebase mit geloescht.
// Node.js-Laufzeit auf 22 umgestellt (11.08.2026) - dieser Kommentar erzwingt ein echtes Neu-Bereitstellen
// FahrSync Push-Benachrichtigungen (Cloud Functions v2, Region Frankfurt)
// Sendet data-only Nachrichten – der Service Worker zeigt sie an
// (zuverlaessig auf iOS-PWA und Android/Chrome, keine Doppelanzeige).
const { onDocumentCreated, onDocumentUpdated } = require('firebase-functions/v2/firestore');
const { onRequest, onCall, HttpsError } = require('firebase-functions/v2/https');
const { onSchedule } = require('firebase-functions/v2/scheduler');
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
const { rechnungAnlegen, RECHNUNG_PLANS } = require('./rechnung');

// (exports.erstelleRechnung ist entfallen - zusammen mit dem Knopf
//  "Test-Rechnung erzeugen" in der App. Die Funktion war ihrem eigenen
//  Fehlertext nach nur fuer Testzwecke gedacht, hat aber eine ECHTE,
//  fortlaufend nummerierte Rechnung angelegt: dieselbe Nummernvergabe aus
//  platform/rechnungszaehler wie bei einer bezahlten Rechnung, und
//  dauerhaft aufbewahrt, weil taeglichesAufraeumen Rechnungen bewusst nie
//  loescht (§ 14b UStG, § 147 AO).
//  Echte Rechnungen entstehen ausschliesslich in den Webhooks:
//  paypalWebhook (abgesichert ueber die Sale-ID) und stripeWebhook
//  (ueber die Invoice-ID) - beide gegen Doppelanlage geschuetzt.
//  Die Bausteine dafuer liegen seit dem Zusammenfuehren beider Zweige in
//  ./rechnung.js (Nummernkreis, PDF, Ablage).

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

  const lineItems = [{
    price_data: {
      currency: 'eur',
      product_data: { name: `FahrSync – ${planInfo.label}` },
      unit_amount: Math.round(betrag * 100),
      recurring: { interval: 'month' },
    },
    quantity: 1,
  }];

  // FIX: Fuer die Stufe "Unbegrenzt" sieht die AGB (§ 4) eine einmalige,
  // nicht erstattungsfaehige Einrichtungsgebuehr vor - die war bisher NUR im
  // Client als Text angezeigt, aber in der Stripe-Checkout-Session nie als
  // tatsaechliche Position enthalten. Zahlende ueber Stripe wurden die
  // Gebuehr also nie in Rechnung gestellt. Einmalige Position (kein
  // 'recurring') zusaetzlich zum Abo hinzufuegen, wenn vorhanden.
  const setupGebuehr = planer ? planInfo.setupPlaner : planInfo.setup;
  if (setupGebuehr) {
    lineItems.push({
      price_data: {
        currency: 'eur',
        product_data: { name: `FahrSync – Einrichtungsgebühr (${planInfo.label})` },
        unit_amount: Math.round(setupGebuehr * 100),
      },
      quantity: 1,
    });
  }

  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    payment_method_types: ['card', 'sepa_debit'],
    line_items: lineItems,
    // FIX: Die AGB (§ 3) und die Preis-Uebersicht im Client versprechen fuer
    // JEDES Abonnement eine 14-taegige kostenlose Testphase ("keine
    // automatische Abbuchung waehrend der Testphase") - ohne diesen
    // Parameter haette Stripe (anders als die PayPal-Plaene, die die
    // Testphase serverseitig im PayPal-Dashboard hinterlegt haben) sofort
    // bei Checkout-Abschluss abgebucht.
    subscription_data: {
      trial_period_days: 14,
      // Wird auf das entstehende Abo (nicht nur die Checkout Session)
      // uebertragen - noetig, damit spaetere Verlaengerungs-Rechnungen
      // (invoice.paid, siehe unten) wissen, wem die Zahlung zuzuordnen ist.
      metadata: { plan, planer: planer ? '1' : '0', billingColl, billingId },
    },
    client_reference_id: `${billingColl}:${billingId}`,
    metadata: { plan, planer: planer ? '1' : '0', billingColl, billingId },
    success_url: `https://fahrsync.de/index.html?stripe=erfolg${request.data.rueckkehrZusatz === '&normal=1' ? '&normal=1' : ''}`,
    cancel_url:  `https://fahrsync.de/index.html?stripe=abgebrochen${request.data.rueckkehrZusatz === '&normal=1' ? '&normal=1' : ''}`,
  });

  return { url: session.url };
});

// Setzt nur die Abo-Felder auf dem Fahrschulen-/Users-Dokument - OHNE
// Rechnung. Wird sowohl bei sofortiger Zahlung als auch beim reinen
// Testphase-Start (0 EUR faellig) gebraucht.
async function stripeAboAktivieren(billingColl, billingId, plan, planer, subscriptionId) {
  const billingRef = admin.firestore().doc(`${billingColl}/${billingId}`);
  const billingSnap = await billingRef.get();
  if (!billingSnap.exists) return null;
  const felder = {
    abo: plan, aboPlaner: planer === '1', aboStatus: 'aktiv',
    aboZahlungsart: 'stripe', aboLetzteZahlungAm: Date.now(),
  };
  // Die Stripe-Abo-Kennung wurde bisher nirgends gespeichert - ohne sie
  // laesst sich ein laufendes Abo spaeter nicht kuendigen (z.B. wenn der
  // Kunde sein Konto loescht, siehe kuendigeLaufendesAbo).
  if (subscriptionId) felder.aboSubscriptionId = subscriptionId;
  await billingRef.update(felder);
  return billingSnap.data();
}

// Gemeinsame PDF-/Rechnungsnummern-Erzeugung, genutzt sowohl fuer die erste
// Zahlung (Checkout Session) als auch fuer jede spaetere monatliche
// Verlaengerung (Stripe-Invoice) - dieselbe Logik, nur mit unterschiedlicher
// Herkunft von Betrag/Zahlungsart/Idempotenz-Schluessel.

// Erste Zahlung (Checkout Session), genutzt von BEIDEN Webhook-Zweigen
// (sofortige Kartenzahlung und spaeter bestaetigte SEPA-Lastschrift).
async function stripeAboAktivierenUndRechnung(session, stripeEventId, zahlungsart) {
  const { billingColl, billingId, plan, planer } = session.metadata || {};
  if (!billingColl || !billingId || !plan) return;
  const planInfo = RECHNUNG_PLANS[plan];
  if (!planInfo) return;

  const b = await stripeAboAktivieren(billingColl, billingId, plan, planer, session.subscription);
  if (!b) return;
  if (!b.rechnungsStrasse || !b.rechnungsPlz || !b.rechnungsOrt) return;

  // FIX: Bei einer Testphase OHNE Einrichtungsgebuehr ist beim Checkout
  // tatsaechlich 0 EUR faellig (amount_total === 0, Stripe liefert dafuer
  // payment_status 'no_payment_required') - das Abo wurde oben trotzdem
  // schon freigeschaltet (die Testphase soll nutzbar sein), aber es wird
  // bewusst KEINE Rechnung ueber den vollen Monatspreis erzeugt, da noch
  // nichts bezahlt wurde. Die erste echte Rechnung entsteht automatisch
  // nach Ablauf der Testphase ueber invoice.paid (stripeVerlaengerungsRechnung).
  if (!session.amount_total) {
    console.log('stripeWebhook: Testphase gestartet (0 EUR faellig), Abo aktiviert ohne Rechnung fuer', billingColl, billingId);
    return;
  }

  const betrag = planer === '1' ? planInfo.pricePlaner : planInfo.price;
  const nummer = await rechnungAnlegen({
    billingId, empfaengerName: b.name || 'Kunde', b, plan,
    planer: planer === '1', planInfo, betrag, zahlungsart,
    docId: `stripe_${session.id}`,
    referenzFelder: { stripeSessionId: session.id },
    herkunft: 'stripeWebhook',
  });
  if (nummer) console.log('stripeWebhook: Rechnung', nummer, 'erzeugt fuer', billingColl, billingId, '(Ereignis', stripeEventId, ')');
}

// FIX: Bisher hoerte der Webhook NUR auf checkout.session.*-Ereignisse - das
// deckt ausschliesslich die ALLERERSTE Zahlung ab. Jede folgende monatliche
// Verlaengerung eines Stripe-Abos laeuft technisch ueber ein eigenes
// Invoice-Objekt auf dem Abo selbst (keine neue Checkout Session) und hat
// bisher NIE eine Rechnung erzeugt - anders als bei PayPal, wo genau dieses
// Problem bereits ueber PAYMENT.SALE.COMPLETED im paypalWebhook geloest
// wurde. 'invoice.paid' deckt sowohl Karten- als auch (verzoegerte)
// SEPA-Zahlungen ab.
async function stripeVerlaengerungsRechnung(invoice, stripeEventId) {
  // Nur echte Verlaengerungen - die allererste Zahlung laeuft bereits ueber
  // checkout.session.completed/stripeAboAktivierenUndRechnung; wuerde man
  // sie hier zusaetzlich verarbeiten, entstuenden doppelte Rechnungen.
  if (invoice.billing_reason !== 'subscription_cycle') return;
  if (!invoice.amount_paid) return;

  // Stripe hat mit der API-Version 2025-03-31 ("basil") umgebaut: Das
  // zugehoerige Abo steht seither nicht mehr unter invoice.subscription,
  // sondern unter invoice.parent.subscription_details.subscription. Wird nur
  // das alte Feld gelesen, ueberspringt diese Funktion auf neueren
  // API-Versionen STILLSCHWEIGEND jede Verlaengerung - es entstuende nie
  // wieder eine Rechnung. Beide Formen lesen, damit es unabhaengig von der
  // im Stripe-Konto eingestellten Version funktioniert.
  const abo = (invoice.parent &&
               invoice.parent.subscription_details &&
               invoice.parent.subscription_details.subscription)
            || invoice.subscription;
  if (!abo) return;

  const stripe = new Stripe(STRIPE_SECRET_KEY.value());
  const subId = typeof abo === 'string' ? abo : abo.id;
  const sub = await stripe.subscriptions.retrieve(subId);
  const { billingColl, billingId, plan, planer } = sub.metadata || {};
  if (!billingColl || !billingId || !plan) return;
  const planInfo = RECHNUNG_PLANS[plan];
  if (!planInfo) return;

  const billingSnap = await admin.firestore().doc(`${billingColl}/${billingId}`).get();
  if (!billingSnap.exists) return;
  const b = billingSnap.data();
  if (!b.rechnungsStrasse || !b.rechnungsPlz || !b.rechnungsOrt) return;

  await admin.firestore().doc(`${billingColl}/${billingId}`).update({ aboLetzteZahlungAm: Date.now() });

  const betrag = invoice.amount_paid / 100;
  const nummer = await rechnungAnlegen({
    billingId, empfaengerName: b.name || 'Kunde', b, plan,
    planer: planer === '1', planInfo, betrag,
    zahlungsart: 'Kreditkarte/SEPA (Verlängerung)',
    docId: `stripe_invoice_${invoice.id}`,
    referenzFelder: { stripeInvoiceId: invoice.id },
    herkunft: 'stripeWebhook',
  });
  if (nummer) console.log('stripeWebhook: Verlaengerungs-Rechnung', nummer, 'erzeugt fuer', billingColl, billingId, '(Ereignis', stripeEventId, ')');
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
        if (session.payment_status === 'paid') {
          // Sofort bezahlt (Karte, oder Testphase + Einrichtungsgebuehr).
          await stripeAboAktivierenUndRechnung(session, event.id, 'Kreditkarte');
        } else if (session.payment_status === 'no_payment_required') {
          // FIX: Testphase OHNE Einrichtungsgebuehr -> 0 EUR beim Checkout
          // faellig. Abo trotzdem sofort freischalten (die 14-taegige
          // Testphase soll nutzbar sein), aber ohne Rechnung.
          const { billingColl, billingId, plan, planer } = session.metadata || {};
          if (billingColl && billingId && plan) await stripeAboAktivieren(billingColl, billingId, plan, planer, session.subscription);
        }
        // Bei noch schwebender SEPA-Lastschrift ('unpaid') uebernimmt
        // async_payment_succeeded weiter unten.
      } else if (event.type === 'checkout.session.async_payment_succeeded') {
        // SEPA-Lastschrift wurde jetzt tatsaechlich bestaetigt.
        const session = event.data.object;
        await stripeAboAktivierenUndRechnung(session, event.id, 'SEPA-Lastschrift');
      } else if (event.type === 'invoice.paid' || event.type === 'invoice.payment_succeeded') {
        // Monatliche Abo-Verlaengerung (siehe stripeVerlaengerungsRechnung).
        // Stripe kennt zwei Ereignisse fuer dieselbe Sache; welches davon sich
        // im Dashboard auswaehlen laesst, haengt von der Oberflaeche und der
        // API-Version ab. Beide werden akzeptiert - sind versehentlich BEIDE
        // aktiviert, entsteht trotzdem nur eine Rechnung, weil die
        // Dokument-Kennung aus der Rechnungs-ID abgeleitet ist und der zweite
        // Versuch an ALREADY_EXISTS scheitert.
        await stripeVerlaengerungsRechnung(event.data.object, event.id);
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

// ══ ALTE ZUGANGSCODES: SICHERER LOGIN-FALLBACK ═══════════════════════
// Vor der Umstellung auf "Code = Dokument-ID" hatten Zugangscode-Dokumente
// eine zufaellige ID und ein eigenes 'code'-Feld. Der Login-Fallback im
// Schueler-Portal fuer solche Alt-Codes brauchte bisher ein Client-seitiges
// where('code','==',code) - also ein 'list()' auf accessCodes. Firestore-
// Regeln koennen bei 'list' aber nur pruefen, WAS zurueckkommt, nicht WELCHE
// Query gestellt wurde - ein offenes 'list' fuer diesen Zweck haette also
// das komplette Auflisten ALLER aktiven Zugangscodes (samt Schueler-
// Stammdaten/Chat) ermoeglicht, ganz ohne einen einzigen Code zu kennen.
// Diese Funktion macht dieselbe Suche stattdessen serverseitig (Admin SDK,
// umgeht Rules) und gibt NUR die Dokument-ID zurueck, wenn Code + Ablauf
// passen - der Client liest die eigentlichen Daten danach ganz normal per
// get() (bereits durch die bestehende accessCodes/get-Regel erlaubt).
// Einfache Versuchsbremse pro Absender-Adresse. Bewusst "fail-open": Geht
// beim Zaehlen selbst etwas schief, wird der Zugang NICHT verweigert - ein
// kaputter Zaehler darf keine Schueler aussperren.
async function versuchErlaubt(kennung, maxProStunde) {
  if (!kennung) return true;
  const FENSTER_MS = 60 * 60 * 1000;
  // Adresse nicht im Klartext ablegen (waere selbst wieder ein
  // personenbezogenes Datum) - eine gekuerzte Pruefsumme genuegt zum Zaehlen.
  const id = require('crypto').createHash('sha256').update(String(kennung)).digest('hex').slice(0, 32);
  try {
    return await admin.firestore().runTransaction(async (tx) => {
      const ref = admin.firestore().doc(`rateLimits/${id}`);
      const snap = await tx.get(ref);
      const jetzt = Date.now();
      const d = snap.exists ? snap.data() : null;
      if (!d || (jetzt - (d.fensterStart || 0)) > FENSTER_MS) {
        tx.set(ref, { fensterStart: jetzt, anzahl: 1 });
        return true;
      }
      if ((d.anzahl || 0) >= maxProStunde) return false;
      tx.update(ref, { anzahl: (d.anzahl || 0) + 1 });
      return true;
    });
  } catch (e) {
    console.warn('Versuchsbremse nicht auswertbar:', e.message);
    return true;
  }
}

exports.findeAltenZugangscode = onCall(async (request) => {
  const { code } = request.data || {};
  if (!code || typeof code !== 'string' || code.length < 4 || code.length > 40) {
    throw new HttpsError('invalid-argument', 'Ungueltiger Code.');
  }
  // SICHERHEITS-AUDIT (eigener Fund): Diese Funktion ist bewusst ohne
  // Anmeldung erreichbar - der Schueler hat ja kein Konto. Damit war sie
  // aber auch ein unbegrenzt oft abfragbares Orakel, um Zugangscodes
  // durchzuprobieren: ein Treffer liefert die Dokument-ID, und damit sind
  // ueber die accessCodes-Leseregel Name, Lernstand und Chatverlauf des
  // Schuelers abrufbar. 20 Versuche pro Stunde und Absender reichen fuer
  // jeden echten Schueler, machen systematisches Durchprobieren aber
  // unbrauchbar.
  const absender = request.rawRequest && (
    (request.rawRequest.headers && request.rawRequest.headers['x-forwarded-for']) ||
    request.rawRequest.ip);
  const ersteAdresse = String(absender || '').split(',')[0].trim();
  if (!(await versuchErlaubt('code:' + ersteAdresse, 20))) {
    throw new HttpsError('resource-exhausted', 'Zu viele Versuche. Bitte spaeter erneut versuchen.');
  }

  const snap = await admin.firestore().collection('accessCodes')
    .where('code', '==', code).limit(1).get();
  if (snap.empty) return { found: false };
  const doc = snap.docs[0];
  const data = doc.data();
  if (data.expiresAt && data.expiresAt < Date.now()) return { found: false };
  return { found: true, docId: doc.id };
});

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

// ═══════════════════════════════════════════════════════════════════
// SICHERHEITSFIX: Abo-Aktivierung nach PayPal-Zahlung serverseitig
//
// Bisher schrieb der Client (activateAbo() im Browser, index.html) die
// Felder abo/aboMaxLehrer/aboSubscriptionId/... DIREKT per updateDoc() in
// Firestore - im onApprove-Callback von PayPal, also OHNE jede
// serverseitige Pruefung, ob ueberhaupt eine echte Zahlung stattgefunden
// hat. Jeder eingeloggte Nutzer haette sich per Browser-Konsole (z.B.
// updateDoc(doc(db,'users',meineUid),{abo:'unbegrenzt',aboStatus:'aktiv'}))
// ein kostenloses Premium-Abo selbst freischalten koennen.
//
// Diese Funktion ersetzt den direkten Client-Schreibzugriff: Sie fragt bei
// PayPal selbst nach (Admin-API, server-zu-server), ob die genannte
// Subscription-ID wirklich existiert, aktiv ist und zum angefragten Tarif
// passt - erst DANACH aktiviert sie serverseitig (Admin SDK, umgeht die
// Firestore-Regeln). Die Firestore-Regeln selbst verbieten Clients
// zusaetzlich das direkte Schreiben dieser Felder (siehe firestore.rules,
// aboFelderUnveraendert()).
// ═══════════════════════════════════════════════════════════════════
exports.bestaetigePaypalAbo = onCall(
  { secrets: [PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET] },
  async (request) => {
    const auth = request.auth;
    if (!auth) throw new HttpsError('unauthenticated', 'Bitte anmelden.');

    const { subscriptionId, plan, planer } = request.data || {};
    const planInfo = PAYPAL_PLAN_IDS[plan];
    if (!subscriptionId || typeof subscriptionId !== 'string' || !planInfo) {
      throw new HttpsError('invalid-argument', 'Ungueltiger Tarif oder Subscription-ID.');
    }
    const erwartetePlanId = planer ? planInfo.idPlaner : planInfo.id;

    // Bei PayPal nachfragen statt dem Client zu glauben.
    const accessToken = await paypalAccessToken(PAYPAL_CLIENT_ID.value(), PAYPAL_CLIENT_SECRET.value());
    const subResp = await fetch(
      `https://api-m.paypal.com/v1/billing/subscriptions/${encodeURIComponent(subscriptionId)}`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    if (!subResp.ok) {
      throw new HttpsError('failed-precondition', 'PayPal-Abo konnte nicht geprueft werden.');
    }
    const sub = await subResp.json();
    if (sub.status !== 'ACTIVE') {
      throw new HttpsError('failed-precondition', 'PayPal-Abo ist nicht aktiv.');
    }
    if (sub.plan_id !== erwartetePlanId) {
      throw new HttpsError('failed-precondition', 'Die Subscription passt nicht zum gewaehlten Tarif.');
    }

    const uid = auth.uid;
    const userSnap = await admin.firestore().doc(`users/${uid}`).get();
    if (!userSnap.exists) throw new HttpsError('failed-precondition', 'Nutzerprofil nicht gefunden.');
    const userData = userSnap.data();

    // Dieselbe Ermittlung wie in createStripeCheckoutSession.
    let billingColl, billingId;
    if (userData.typ === 'fahrschule') {
      billingColl = 'fahrschulen'; billingId = uid;
    } else if (!userData.fahrschuleId || userData.fahrschuleId === uid) {
      billingColl = 'users'; billingId = uid;
    } else {
      throw new HttpsError('permission-denied', 'Nur der Fahrschul-Inhaber kann ein Abo aktivieren.');
    }

    // Verhindert, dass dieselbe Subscription-ID zweimal (bei zwei
    // verschiedenen Konten) verwendet wird, um sich mit einer fremden,
    // echten Zahlung selbst freizuschalten.
    for (const coll of ['fahrschulen', 'users']) {
      const belegt = await admin.firestore().collection(coll)
        .where('aboSubscriptionId', '==', subscriptionId).limit(1).get();
      if (!belegt.empty && !(coll === billingColl && belegt.docs[0].id === billingId)) {
        throw new HttpsError('failed-precondition', 'Diese Subscription ist bereits einem anderen Konto zugeordnet.');
      }
    }

    await admin.firestore().doc(`${billingColl}/${billingId}`).set({
      abo:               plan,
      aboPlaner:         !!planer,
      aboMaxLehrer:      planInfo.maxLehrer,
      aboSubscriptionId: subscriptionId,
      aboPlanId:         erwartetePlanId,
      aboAktiviertAm:    Date.now(),
      aboSetByAdmin:     false,
      aboStatus:         'aktiv',
      aboZahlungsart:    'paypal',
    }, { merge: true });

    return { success: true, maxLehrer: planInfo.maxLehrer };
  }
);

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

        const betrag = betragBezahlt || (billingData.aboPlaner ? planInfo.pricePlaner : planInfo.price);
        const nummer = await rechnungAnlegen({
          billingId, empfaengerName: billingData.name || 'Kunde', b: billingData,
          plan: billingData.abo, planer: !!billingData.aboPlaner, planInfo, betrag,
          zahlungsart: 'PayPal',
          docId: `paypal_${saleId}`,
          referenzFelder: { paypalSaleId: saleId, paypalSubscriptionId: subscriptionId },
          herkunft: 'paypalWebhook',
        });
        if (!nummer) { res.status(200).send('ok - bereits verarbeitet'); return; }

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

// ═══════════════════════════════════════════════════════════════════
// DSGVO-LOESCHKONZEPT (Art. 17 DSGVO, § 6 Nr. 7 AVV, AGB § 10)
//
// Datenschutzerklaerung, AGB und AVV versprechen seit jeher: "Nach
// Beendigung werden alle Daten innerhalb von 30 Tagen unwiderruflich
// geloescht" - technisch gab es dafuer bisher NICHTS. Weder konnte ein
// Nutzer sein Konto selbst loeschen (obwohl die Datenschutzerklaerung
// genau das als Weg zum Widerruf nennt), noch lief irgendwo ein Job, der
// die Frist umsetzt. Geloescht wurde nur, wenn der Betreiber es von Hand
// tat. Diese drei Funktionen setzen das Versprechen technisch um:
//
//   kontoLoeschungBeantragen  - Nutzer stoesst die Loeschung an (Frist laeuft)
//   kontoLoeschungWiderrufen  - Rueckzieher innerhalb der Frist
//   taeglichesAufraeumen      - loescht nach Fristablauf endgueltig und
//                               raeumt zusaetzlich alle uebrigen Daten mit
//                               abgelaufener Aufbewahrung ab
//
// WICHTIG - was NIE geloescht wird: die Rechnungen. Fuer sie gilt die
// gesetzliche Aufbewahrungspflicht (§ 14b UStG, § 147 AO), die der
// Loeschpflicht ausdruecklich vorgeht (so auch § 6 Nr. 7 AVV).
// ═══════════════════════════════════════════════════════════════════

const LOESCH_FRIST_TAGE = 30;
const TAG_MS = 24 * 60 * 60 * 1000;
// Loeschen: siehe functions/loeschen.js. Ausgelagert, damit der Umfang der
// Kontoloeschung gegen den Emulator geprueft werden kann statt nur behauptet.
const { loescheAlle, loescheZugangscodesMitBildern, loeschUmfang, loescheKontoHart,
        gehoertNochDemKonto, repariereFehlendeAblaufdaten } = require('./loeschen');

// Ein laufendes Abonnement beim Zahlungsdienstleister beenden. Ohne das
// wuerde nach der Kontoloeschung munter weiter abgebucht - der Kunde haette
// kein Konto mehr, aber weiter eine monatliche Belastung.
async function kuendigeLaufendesAbo(billingColl, billingId) {
  const snap = await admin.firestore().doc(`${billingColl}/${billingId}`).get();
  if (!snap.exists) return null;
  const b = snap.data();
  const subId = b.aboSubscriptionId;
  if (!subId) return null;
  try {
    // Stripe-Abo-Kennungen beginnen mit 'sub_', PayPal-Kennungen mit 'I-'.
    if (b.aboZahlungsart === 'stripe' || String(subId).startsWith('sub_')) {
      const stripe = new Stripe(STRIPE_SECRET_KEY.value());
      await stripe.subscriptions.cancel(subId);
      return 'stripe';
    }
    const token = await paypalAccessToken(PAYPAL_CLIENT_ID.value(), PAYPAL_CLIENT_SECRET.value());
    const resp = await fetch(
      `https://api-m.paypal.com/v1/billing/subscriptions/${encodeURIComponent(subId)}/cancel`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: 'Konto vom Nutzer geloescht' }),
      });
    if (!resp.ok) console.warn('PayPal-Kuendigung antwortete mit', resp.status);
    return 'paypal';
  } catch (e) {
    console.warn('Abo-Kuendigung fehlgeschlagen fuer', billingColl, billingId, e.message);
    return null;
  }
}

// ── Nutzer beantragt die Loeschung seines Kontos ────────────────────
exports.kontoLoeschungBeantragen = onCall(
  { secrets: [STRIPE_SECRET_KEY, PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET] },
  async (request) => {
    const auth = request.auth;
    if (!auth) throw new HttpsError('unauthenticated', 'Bitte anmelden.');
    const uid = auth.uid;
    const userSnap = await admin.firestore().doc(`users/${uid}`).get();
    if (!userSnap.exists) throw new HttpsError('failed-precondition', 'Kein Profil gefunden.');
    const userData = userSnap.data();

    // Ein Fahrschul-Admin, der NICHT Inhaber ist, kann nur sein eigenes Konto
    // loeschen - die Schuldaten gehoeren dem Inhaber.
    const { istInhaber } = loeschUmfang(uid, userData);
    const geloeschtAm = Date.now();
    const loeschungAm = geloeschtAm + LOESCH_FRIST_TAGE * TAG_MS;

    // Laufendes Abo sofort beenden (nicht erst nach Fristablauf - sonst
    // liefen bis dahin weitere Abbuchungen auf).
    // Ein Fahrlehrer, der nur Mitglied einer fremden Fahrschule ist, hat kein
    // eigenes Abo - dessen users-Dokument traegt keine Abo-Kennung, es wird
    // also nichts gekuendigt (das Abo der Schule bleibt unberuehrt).
    const gekuendigt = await kuendigeLaufendesAbo(istInhaber ? 'fahrschulen' : 'users', uid);

    await admin.firestore().doc(`users/${uid}`).update({
      geloeschtAm, loeschungAm, aboStatus: 'gekuendigt',
    });
    if (istInhaber) {
      await admin.firestore().doc(`fahrschulen/${uid}`)
        .update({ geloeschtAm, loeschungAm, aboStatus: 'gekuendigt' }).catch(() => {});
    }

    console.log('Kontoloeschung beantragt von', uid, '- faellig am',
      new Date(loeschungAm).toISOString(), '- Abo gekuendigt:', gekuendigt || 'keines');
    return { success: true, loeschungAm, fristTage: LOESCH_FRIST_TAGE, istInhaber, aboGekuendigt: gekuendigt };
  });

// ── Rueckzieher innerhalb der Frist ─────────────────────────────────
exports.kontoLoeschungWiderrufen = onCall(async (request) => {
  const auth = request.auth;
  if (!auth) throw new HttpsError('unauthenticated', 'Bitte anmelden.');
  const uid = auth.uid;
  const entfernen = {
    geloeschtAm: admin.firestore.FieldValue.delete(),
    loeschungAm: admin.firestore.FieldValue.delete(),
  };
  await admin.firestore().doc(`users/${uid}`).update(entfernen);
  await admin.firestore().doc(`fahrschulen/${uid}`).update(entfernen).catch(() => {});
  console.log('Kontoloeschung widerrufen von', uid);
  return { success: true };
});

// ── Taeglicher Aufraeum-Job ─────────────────────────────────────────
// Setzt sowohl die 30-Tage-Frist als auch alle uebrigen Aufbewahrungs-
// grenzen durch. Laeuft nachts, wenn niemand arbeitet.
exports.taeglichesAufraeumen = onSchedule(
  { schedule: 'every day 03:15', timeZone: 'Europe/Berlin', timeoutSeconds: 540, memory: '512MiB' },
  async () => {
    const db = admin.firestore();
    const jetzt = Date.now();
    const bericht = { konten: 0, codes: 0, nachgetragen: 0, mails: 0, resets: 0, buchungen: 0, oauth: 0 };

    // 1) Konten, deren 30-Tage-Frist abgelaufen ist
    try {
      const faellig = await db.collection('users')
        .where('loeschungAm', '<=', jetzt).limit(20).get();
      for (const d of faellig.docs) {
        await loescheKontoHart(d.id);
        bericht.konten++;
      }
    } catch (e) { console.error('Konto-Loeschung:', e); }

    // 2a) Zuerst die Codes einfangen, denen expiresAt ganz fehlt. Der Filter
    // unten wuerde sie stillschweigend ueberspringen - sie blieben fuer immer
    // liegen, obwohl Name, Lernstand und Chatverlauf darin stehen. Sie werden
    // NICHT geloescht (das Alter ist unbekannt, es koennte ein aktiver Zugang
    // sein), sondern bekommen ein Ablaufdatum und fallen danach normal unter
    // die 90-Tage-Regel.
    try {
      bericht.nachgetragen = await repariereFehlendeAblaufdaten(
        db, jetzt + 14 * TAG_MS);
    } catch (e) { console.error('Ablaufdatum nachtragen:', e); }

    // 2) Zugangscodes, die seit ueber 90 Tagen abgelaufen sind. Darin stecken
    // Name, Lernstand und der komplette Chatverlauf eines Schuelers - es gibt
    // keinen Grund, das ueber das Ende der Gueltigkeit hinaus aufzubewahren.
    try {
      bericht.codes = await loescheZugangscodesMitBildern(
        db.collection('accessCodes').where('expiresAt', '<=', jetzt - 90 * TAG_MS).limit(200));
    } catch (e) { console.error('Alte Zugangscodes:', e); }

    // 3) Uebrige Aufbewahrungsgrenzen
    try {
      bericht.mails = await loescheAlle(
        db.collection('mailQueue').where('createdAt', '<=',
          admin.firestore.Timestamp.fromMillis(jetzt - 90 * TAG_MS)));
    } catch (e) { console.error('mailQueue:', e); }
    try {
      bericht.resets = await loescheAlle(
        db.collection('passwordResets').where('createdAt', '<=', jetzt - 30 * TAG_MS));
    } catch (e) { console.error('passwordResets:', e); }
    // ACHTUNG Feldtypen: bookingRequests/bookingMessages schreiben createdAt
    // als serverTimestamp() (Firestore-Timestamp), passwordResets und
    // oauthStates dagegen als Date.now() (Zahl). Vergleicht man hier mit dem
    // falschen Typ, liefert Firestore stillschweigend KEINE Treffer und der
    // Aufraeum-Job laeuft wirkungslos ins Leere.
    const grenzeTimestamp = admin.firestore.Timestamp.fromMillis(jetzt - 90 * TAG_MS);
    for (const coll of ['bookingRequests', 'bookingMessages']) {
      try {
        bericht.buchungen += await loescheAlle(
          db.collection(coll).where('createdAt', '<=', grenzeTimestamp));
      } catch (e) { console.error(coll + ':', e); }
    }
    // Kurzlebige CSRF-Marken des Kalender-Logins (eine Stunde reicht)
    try {
      bericht.oauth = await loescheAlle(
        db.collection('oauthStates').where('createdAt', '<=', jetzt - 60 * 60 * 1000));
    } catch (e) { console.error('oauthStates:', e); }

    console.log('Taegliches Aufraeumen fertig:', JSON.stringify(bericht));
  }
);

// ═══════════════════════════════════════════════════════════════════
// BUCHUNGSZAEHLER (bookedCount) SERVERSEITIG FUEHREN
//
// Bisher zaehlte der CLIENT: beim Bestaetigen einer Anfrage hoch, beim
// Stornieren durch den Fahrlehrer wieder runter. Der Schueler-Selbststorno
// (kalender.html, storniereMeinen) konnte das gar nicht - er ist nicht
// angemeldet und darf das schueler-Dokument nach den Regeln nicht
// beschreiben. Folge: Storniert ein Schueler fristgerecht, bleibt sein
// Kontingent verbraucht. Nach 12 Buchungen und 6 Stornos stand 12/20,
// gefahren waren 6 - und bei 20 war der Buchungslink gesperrt, obwohl nur
// 14 Stunden stattfanden.
//
// Dieser Trigger haengt am Slot selbst und deckt damit ALLE Wege ab
// (Fahrlehrer, Schueler, Tausch). Die Zaehlung im Client wurde im Gegenzug
// entfernt - sonst wuerde doppelt gezaehlt. Die Transaktion klammert den
// Wert zusaetzlich bei 0, damit bereits entstandene Abweichungen sich mit
// der Zeit von selbst auswachsen statt ins Negative zu laufen.
// ═══════════════════════════════════════════════════════════════════
exports.syncBookedCount = onDocumentUpdated('slots/{slotId}', async (event) => {
  const vorher  = event.data.before.data();
  const nachher = event.data.after.data();
  if (!vorher || !nachher) return;
  const vonId = vorher.bookedBy || null;
  const nachId = nachher.bookedBy || null;
  if (vonId === nachId) return; // keine Buchungsaenderung

  const db = admin.firestore();
  const schritte = [];
  if (vonId)  schritte.push([vonId, -1]);
  if (nachId) schritte.push([nachId, +1]);

  for (const [schuelerId, delta] of schritte) {
    try {
      const neuerStand = await db.runTransaction(async (tx) => {
        const ref = db.doc(`schueler/${schuelerId}`);
        const snap = await tx.get(ref);
        if (!snap.exists) return null;
        const wert = Math.max(0, (snap.data().bookedCount || 0) + delta);
        tx.update(ref, { bookedCount: wert });
        return wert;
      });
      // Der Client veroeffentlicht den Zaehler direkt nach seiner Aenderung an
      // das Schueler-Portal (bookingStudents) - zu diesem Zeitpunkt ist dieser
      // Trigger aber unter Umstaenden noch gar nicht gelaufen, der Schueler
      // saehe also den alten Stand. Deshalb hier nachziehen.
      if (neuerStand !== null) {
        await db.doc(`bookingStudents/${schuelerId}`)
          .set({ bookedCount: neuerStand }, { merge: true })
          .catch(() => {});
      }
    } catch (e) {
      console.warn('bookedCount fuer', schuelerId, 'fehlgeschlagen:', e.message);
    }
  }
});

// ── SCHUELER IN DIE FAHRSCHULE UEBERNEHMEN ───────────────────────────────
// Ein Fahrlehrer, der sich zuerst allein angemeldet und spaeter per Code
// einer Fahrschule angeschlossen hat, traegt seine bisherige Kartei noch
// unter seiner EIGENEN Kennung. Die Fahrschule sieht sie deshalb nicht - und
// genau darum geht es: Planung im Kalender und der Blick auf den Lernstand.
//
// Warum serverseitig? Die Firestore-Regel fahrschuleIdUnveraendert verbietet
// dem Browser, die Fahrschul-Zuordnung eines Schuelers zu aendern. Das ist
// richtig so: Sonst koennte jeder fremde Schueler in seine eigene Schule
// ziehen oder eigene in eine fremde schieben. Der Umzug laeuft deshalb hier,
// mit Admin-Rechten und nach strenger Pruefung.
//
// Ausgeloest wird er BEWUSST vom Fahrlehrer (Kundenentscheidung), nicht
// automatisch: Mit der Uebernahme werden Schuelerdaten fuer die Fahrschule
// sichtbar, und das soll niemandem unbemerkt passieren.
//
// Beim spaeteren Austritt bleiben die Schueler bei der Fahrschule - so ist es
// in der Praxis, der Ausbildungsvertrag besteht mit der Fahrschule. Deshalb
// wird nur zur Nachvollziehbarkeit vermerkt, wer sie eingebracht hat.
exports.uebernehmeSchuelerInFahrschule = onCall(async (request) => {
  const auth = request.auth;
  if (!auth) throw new HttpsError('unauthenticated', 'Bitte anmelden.');
  if (auth.token.firebase && auth.token.firebase.sign_in_provider === 'anonymous') {
    throw new HttpsError('permission-denied', 'Nur mit echtem Konto.');
  }
  const uid = auth.uid;
  const db  = admin.firestore();

  const meinDoc = await db.doc(`users/${uid}`).get();
  if (!meinDoc.exists) throw new HttpsError('failed-precondition', 'Nutzerprofil nicht gefunden.');
  const ich = meinDoc.data();

  const schulId = ich.fahrschuleId;
  if (!schulId || schulId === uid) {
    throw new HttpsError('failed-precondition',
      'Du gehoerst zu keiner Fahrschule. Tritt zuerst mit dem Fahrschul-Code bei.');
  }
  // Erst nach der Freigabe durch einen Menschen. Sonst koennte jemand mit
  // einem erratenen Code beitreten und sofort Daten in eine fremde Schule
  // schieben - noch bevor dort jemand von ihm weiss.
  if ((ich.status || 'aktiv') !== 'aktiv') {
    throw new HttpsError('failed-precondition',
      'Deine Fahrschule muss dich zuerst freischalten.');
  }
  const schulDoc = await db.doc(`fahrschulen/${schulId}`).get();
  if (!schulDoc.exists) throw new HttpsError('failed-precondition', 'Fahrschule nicht gefunden.');

  const jetzt = Date.now();
  const ergebnis = { schueler: 0, themen: 0, protokoll: 0, termine: 0, kalenderSchueler: 0, pruefungen: 0 };

  // Jeweils nur, was WIRKLICH mir gehoert und noch unter meiner eigenen
  // Kennung laeuft. Schueler, die schon zur Schule gehoeren, bleiben
  // unberuehrt; fremde werden gar nicht erst gefunden.
  // SICHERHEITS-AUDIT (Datenverlust): Gesucht wurde vorher mit ZWEI
  // Gleichheiten - Besitzerfeld == uid UND Zuordnungsfeld == uid. Eine
  // Gleichheit findet in Firestore aber nur Dokumente, die das Feld auch
  // HABEN. Altbestand aus der Zeit vor der Fahrschul-Funktion fuehrt gar
  // keine fahrschuleId und wurde deshalb stillschweigend uebersprungen: Der
  // Fahrlehrer las "12 Schueler uebernommen", waehrend die alten bei ihm
  // liegen blieben und die Fahrschule sie nie zu sehen bekam.
  //
  // Jetzt wird nur noch nach dem Besitzerfeld gesucht und danach dieselbe
  // Besitzfrage gestellt wie beim Loeschen (functions/loeschen.js): ohne
  // Zuordnung oder Zuordnung auf mich selbst = meins, kommt mit. Was schon
  // der Schule gehoert, bleibt unberuehrt. Damit bewegt die Uebernahme
  // genau das, was die Kontoloeschung auch entfernen wuerde - eine
  // Definition von Zugehoerigkeit statt zweier.
  const umhaengen = async (sammlung, besitzerFeld, zuordnungsFeld, zaehler) => {
    const snap = await db.collection(sammlung).where(besitzerFeld, '==', uid).get();
    const meine = snap.docs.filter(gehoertNochDemKonto(uid, zuordnungsFeld));
    // In Bloecken schreiben - eine Firestore-Sammelschreibung fasst 500.
    for (let i = 0; i < meine.length; i += 400) {
      const batch = db.batch();
      meine.slice(i, i + 400).forEach(d => {
        batch.update(d.ref, {
          [zuordnungsFeld]: schulId,
          uebernommenVon:   uid,
          uebernommenAm:    jetzt,
        });
      });
      await batch.commit();
    }
    ergebnis[zaehler] = meine.length;
  };

  await umhaengen('students',     'uid',       'fahrschuleId', 'schueler');
  await umhaengen('customThemen', 'uid',       'fahrschuleId', 'themen');
  await umhaengen('protokoll',    'uid',       'fahrschuleId', 'protokoll');
  // Der Kalender ist eine eigene Welt: Er fuehrt die Schule unter 'schoolId',
  // den Lehrer unter 'lehrerUid' und hat eine EIGENE Schuelerliste in der
  // Sammlung 'schueler'. Beides muss mit, sonst sieht die Fahrschule zwar den
  // Lernstand, kann aber niemanden einplanen: Ihre Kalenderansichten fragen
  // ausschliesslich nach schoolId.
  await umhaengen('slots',        'lehrerUid', 'schoolId',     'termine');
  await umhaengen('schueler',     'lehrerUid', 'schoolId',     'kalenderSchueler');
  // pruefungen fuehrt den Erfasser als 'eingetragenVon' (kein lehrerUid) -
  // ohne diese Zeile blieben die Pruefungstermine beim Lehrer liegen und die
  // Fahrschule konnte sie nicht einplanen, obwohl der Schueler ihr gehoert.
  await umhaengen('pruefungen',   'eingetragenVon', 'schoolId', 'pruefungen');

  console.log('Uebernahme in Fahrschule', schulId, 'durch', uid, ergebnis);
  return { success: true, ...ergebnis };
});
