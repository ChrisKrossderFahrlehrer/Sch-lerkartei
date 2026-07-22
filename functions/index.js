// FahrSync Push-Benachrichtigungen (Cloud Functions v2, Region Frankfurt)
// Sendet data-only Nachrichten – der Service Worker zeigt sie an
// (zuverlaessig auf iOS-PWA und Android/Chrome, keine Doppelanzeige).
const { onDocumentCreated, onDocumentUpdated } = require('firebase-functions/v2/firestore');
const { onRequest, onCall } = require('firebase-functions/v2/https');
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
