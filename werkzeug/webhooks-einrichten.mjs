// Webhook-Ereignisse bei PayPal und Stripe ergaenzen.
//
// Warum: Gekuendigte Abos laufen 14 Tage nach und gehen dann auf Free
// (functions/abo.js). Davon erfaehrt das Backend nur, wenn PayPal und Stripe
// die Kuendigung auch MELDEN - also wenn die passenden Ereignisse am
// jeweiligen Webhook eingeschaltet sind. Das laesst sich in beiden
// Dashboards von Hand anklicken; dieses Skript erledigt es ueber die
// Schnittstellen, damit niemand dafuer am Rechner sitzen muss.
//
// Was es tut - und was nicht:
//   - Es FUEGT nur hinzu. Ereignisse, die schon eingeschaltet sind, bleiben
//     es; nichts wird entfernt, keine Adresse und keine Signatur geaendert.
//   - Ohne "--einrichten" zeigt es nur an, was es tun wuerde.
//   - Es arbeitet nur an DEM Webhook, den das Backend auch prueft:
//     PayPal: die ID aus dem Secret PAYPAL_WEBHOOK_ID.
//     Stripe: der Endpunkt, dessen Adresse auf stripeWebhook zeigt.
//
// Die Zugangsdaten kommen aus dem Secret Manager des Firebase-Projekts
// (dieselben, die die Functions benutzen). Sie werden nie ausgegeben.
//
// Aufruf: ueber GitHub Actions, "Webhooks einrichten" (siehe
// .github/workflows/webhooks-einrichten.yml). Lokal:
//   GOOGLE_APPLICATION_CREDENTIALS=dienstkonto.json node werkzeug/webhooks-einrichten.mjs [--einrichten]

import { readFileSync } from 'node:fs';
import { createSign } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export const PROJEKT = 'fahrschule-ebc65';

// Was functions/index.js (paypalWebhook / stripeWebhook) auswertet.
// PFLICHT wird ergaenzt; die uebrigen werden nur als Hinweis gemeldet,
// falls sie fehlen - an ihnen haengt der bestehende Zahlungsablauf, und der
// funktioniert nachweislich (Rechnungen entstehen).
export const PAYPAL_PFLICHT = [
  'BILLING.SUBSCRIPTION.CANCELLED',
  'BILLING.SUBSCRIPTION.SUSPENDED',
  'BILLING.SUBSCRIPTION.EXPIRED',
  'BILLING.SUBSCRIPTION.ACTIVATED',
  'BILLING.SUBSCRIPTION.RE-ACTIVATED',
];
export const PAYPAL_BISHER = ['PAYMENT.SALE.COMPLETED'];
export const STRIPE_PFLICHT = [
  'customer.subscription.deleted',
  'customer.subscription.updated',
];
export const STRIPE_BISHER = [
  'checkout.session.completed',
  'checkout.session.async_payment_succeeded',
  'checkout.session.async_payment_failed',
  'invoice.paid',
];

// Neue Liste = alte Liste + fehlende Pflicht-Ereignisse, Reihenfolge der
// alten bleibt. "*" heisst "alle Ereignisse" - dann fehlt nichts.
export function ergaenzen(vorhanden, pflicht) {
  if (vorhanden.includes('*')) return { neu: [...vorhanden], fehlend: [] };
  const fehlend = pflicht.filter(e => !vorhanden.includes(e));
  return { neu: [...vorhanden, ...fehlend], fehlend };
}

// ── Google: Zugriffstoken aus dem Dienstkonto-Schluessel ─────────────
async function googleToken(schluessel) {
  const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
  const jetzt = Math.floor(Date.now() / 1000);
  const kopf = b64({ alg: 'RS256', typ: 'JWT' });
  const inhalt = b64({
    iss: schluessel.client_email,
    scope: 'https://www.googleapis.com/auth/cloud-platform',
    aud: 'https://oauth2.googleapis.com/token',
    iat: jetzt, exp: jetzt + 600,
  });
  const sig = createSign('RSA-SHA256').update(`${kopf}.${inhalt}`).sign(schluessel.private_key, 'base64url');
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${kopf}.${inhalt}.${sig}`,
    }),
  });
  const d = await r.json();
  if (!d.access_token) throw new Error(`Google-Anmeldung fehlgeschlagen (${r.status}).`);
  return d.access_token;
}

async function secretLesen(token, name) {
  const r = await fetch(
    `https://secretmanager.googleapis.com/v1/projects/${PROJEKT}/secrets/${name}/versions/latest:access`,
    { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) {
    // Googles eigene Begruendung mit ausgeben (enthaelt keine Geheimnisse,
    // nur Rechte-/Projektangaben) - "fehlt die Rolle" ist nur die haeufigste
    // Ursache, nicht die einzige.
    const grund = await r.json().then(d => d.error && d.error.message).catch(() => '');
    if (grund) console.log(`Antwort von Google (${r.status}): ${grund}`);
    if (r.status === 403) {
      throw new Error(`Kein Lesezugriff auf das Secret ${name}. Dem Dienstkonto oben fehlt die Rolle ` +
        `"Secret Manager-Zugriffsberechtigter" (Secret Manager Secret Accessor) - ` +
        `siehe .github/workflows/README.md, Abschnitt "Webhooks einrichten".`);
    }
    throw new Error(`Secret ${name} nicht lesbar (${r.status}).`);
  }
  const wert = Buffer.from((await r.json()).payload.data, 'base64').toString('utf8').trim();
  // GitHub schwaerzt den Wert in allen folgenden Protokollzeilen.
  if (process.env.GITHUB_ACTIONS) console.log(`::add-mask::${wert}`);
  return wert;
}

// ── PayPal ───────────────────────────────────────────────────────────
async function paypal(secrets, einrichten) {
  console.log('\n── PayPal ──');
  const basis = 'https://api-m.paypal.com';
  const tr = await fetch(`${basis}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${secrets.PAYPAL_CLIENT_ID}:${secrets.PAYPAL_CLIENT_SECRET}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  const token = (await tr.json()).access_token;
  if (!token) throw new Error(`PayPal-Anmeldung fehlgeschlagen (${tr.status}).`);
  const auth = { Authorization: `Bearer ${token}` };

  const id = secrets.PAYPAL_WEBHOOK_ID;
  const lesen = async () => {
    const r = await fetch(`${basis}/v1/notifications/webhooks/${encodeURIComponent(id)}`, { headers: auth });
    if (!r.ok) throw new Error(`PayPal-Webhook aus PAYPAL_WEBHOOK_ID nicht gefunden (${r.status}).`);
    return r.json();
  };
  const hook = await lesen();
  const vorhanden = (hook.event_types || []).map(e => e.name);
  console.log(`Webhook: ${hook.url}`);
  console.log(`Eingeschaltet (${vorhanden.length}): ${vorhanden.join(', ') || '-'}`);
  const fehltBisher = PAYPAL_BISHER.filter(e => !vorhanden.includes(e) && !vorhanden.includes('*'));
  if (fehltBisher.length) console.log(`HINWEIS: Auch nicht eingeschaltet: ${fehltBisher.join(', ')}`);

  const { neu, fehlend } = ergaenzen(vorhanden, PAYPAL_PFLICHT);
  if (!fehlend.length) { console.log('OK: Alle Abo-Ereignisse sind bereits eingeschaltet.'); return 'ok'; }
  console.log(`Fehlen: ${fehlend.join(', ')}`);
  if (!einrichten) { console.log('-> Wuerde ergaenzt (nur geprueft, nichts geaendert).'); return 'fehlt'; }

  const r = await fetch(`${basis}/v1/notifications/webhooks/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify([{ op: 'replace', path: '/event_types', value: neu.map(name => ({ name })) }]),
  });
  if (!r.ok) throw new Error(`PayPal hat die Aenderung abgelehnt (${r.status}): ${await r.text()}`);
  const danach = (await lesen()).event_types.map(e => e.name);
  const nochFehlend = PAYPAL_PFLICHT.filter(e => !danach.includes(e) && !danach.includes('*'));
  const verloren = vorhanden.filter(e => !danach.includes(e));
  if (nochFehlend.length || verloren.length) {
    throw new Error(`PayPal: Stand nach der Aenderung stimmt nicht. Fehlend: ${nochFehlend.join(', ') || '-'}; ` +
      `verloren: ${verloren.join(', ') || '-'}`);
  }
  console.log(`ERLEDIGT: Ergaenzt. Jetzt eingeschaltet (${danach.length}): ${danach.join(', ')}`);
  return 'eingerichtet';
}

// ── Stripe ───────────────────────────────────────────────────────────
async function stripe(secrets, einrichten) {
  console.log('\n── Stripe ──');
  const auth = { Authorization: `Bearer ${secrets.STRIPE_SECRET_KEY}` };
  const r = await fetch('https://api.stripe.com/v1/webhook_endpoints?limit=100', { headers: auth });
  if (!r.ok) throw new Error(`Stripe-Webhooks nicht lesbar (${r.status}): ${(await r.json()).error?.message || ''}`);
  const alle = (await r.json()).data || [];
  const passend = alle.filter(w => /stripewebhook/i.test(w.url));
  if (!passend.length) {
    console.log(`Vorhandene Endpunkte: ${alle.map(w => w.url).join(', ') || 'keine'}`);
    throw new Error('Stripe: Kein Endpunkt zeigt auf stripeWebhook.');
  }
  let ergebnis = 'ok';
  for (const w of passend) {
    const vorhanden = w.enabled_events || [];
    console.log(`Endpunkt: ${w.url} (${w.status}${w.livemode ? ', live' : ', Test'})`);
    console.log(`Eingeschaltet (${vorhanden.length}): ${vorhanden.join(', ') || '-'}`);
    const fehltBisher = STRIPE_BISHER.filter(e => !vorhanden.includes(e) && !vorhanden.includes('*'));
    if (fehltBisher.length) console.log(`HINWEIS: Auch nicht eingeschaltet: ${fehltBisher.join(', ')}`);

    const { neu, fehlend } = ergaenzen(vorhanden, STRIPE_PFLICHT);
    if (!fehlend.length) { console.log('OK: Alle Abo-Ereignisse sind bereits eingeschaltet.'); continue; }
    console.log(`Fehlen: ${fehlend.join(', ')}`);
    if (!einrichten) { console.log('-> Wuerde ergaenzt (nur geprueft, nichts geaendert).'); ergebnis = 'fehlt'; continue; }

    const body = new URLSearchParams();
    for (const e of neu) body.append('enabled_events[]', e);
    const u = await fetch(`https://api.stripe.com/v1/webhook_endpoints/${w.id}`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    const d = await u.json();
    if (!u.ok) throw new Error(`Stripe hat die Aenderung abgelehnt (${u.status}): ${d.error?.message || ''}`);
    const danach = d.enabled_events || [];
    const nochFehlend = STRIPE_PFLICHT.filter(e => !danach.includes(e) && !danach.includes('*'));
    const verloren = vorhanden.filter(e => !danach.includes(e));
    if (nochFehlend.length || verloren.length) {
      throw new Error(`Stripe: Stand nach der Aenderung stimmt nicht. Fehlend: ${nochFehlend.join(', ') || '-'}; ` +
        `verloren: ${verloren.join(', ') || '-'}`);
    }
    console.log(`ERLEDIGT: Ergaenzt. Jetzt eingeschaltet (${danach.length}): ${danach.join(', ')}`);
    ergebnis = 'eingerichtet';
  }
  return ergebnis;
}

async function main() {
  const einrichten = process.argv.includes('--einrichten');
  console.log(einrichten ? 'Modus: EINRICHTEN (fehlende Ereignisse werden ergaenzt)'
                         : 'Modus: NUR PRUEFEN (es wird nichts geaendert)');
  const pfad = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (!pfad) throw new Error('GOOGLE_APPLICATION_CREDENTIALS fehlt.');
  const schluessel = JSON.parse(readFileSync(pfad, 'utf8'));
  // Welches Dienstkonto hinter dem GitHub-Secret steckt - genau diesem muss
  // die Rolle gegeben werden. Die Adresse ist kein Geheimnis.
  console.log(`Dienstkonto: ${schluessel.client_email} (Projekt ${schluessel.project_id})`);
  const gToken = await googleToken(schluessel);

  const secrets = {};
  for (const n of ['PAYPAL_CLIENT_ID', 'PAYPAL_CLIENT_SECRET', 'PAYPAL_WEBHOOK_ID', 'STRIPE_SECRET_KEY']) {
    secrets[n] = await secretLesen(gToken, n);
  }

  // Beide unabhaengig: Scheitert einer, wird der andere trotzdem erledigt.
  const fehler = [];
  for (const [name, f] of [['PayPal', paypal], ['Stripe', stripe]]) {
    try { await f(secrets, einrichten); }
    catch (e) { console.log(`FEHLER (${name}): ${e.message}`); fehler.push(name); }
  }
  if (fehler.length) { console.log(`\nNicht erledigt: ${fehler.join(', ')}`); process.exit(1); }
  console.log('\nFertig.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(e => { console.log(`FEHLER: ${e.message}`); process.exit(1); });
}
