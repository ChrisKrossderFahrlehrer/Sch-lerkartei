// Gekuendigte Abos: bis zum Ende des bezahlten Zeitraums weiter nutzbar,
// mindestens aber 14 Tage; danach kostenloser Tarif.
//
// Vorher: Kuendigte ein Kunde sein Abo bei PayPal oder Stripe, erfuhr die App
// davon nichts. Die Abo-Felder blieben auf dem bezahlten Tarif stehen - wer
// einmal bezahlt hatte, behielt den Tarif fuer immer.
//
// Jetzt (Entscheidung des Betreibers):
//   - Die Kuendigung muss 14 Tage vor Ablauf erfolgen (AGB § 5).
//   - Meldet PayPal oder Stripe die Kuendigung, laufen die bezahlten
//     Funktionen bis zum Ende des bezahlten Zeitraums weiter, mindestens
//     aber noch 14 Tage. Danach stellt taeglichesAufraeumen das Konto auf
//     'free' um.
//     Warum "mindestens" und nicht fest 14 Tage: Wer kurz nach der
//     Monatszahlung kuendigt, haette sonst zwei bezahlte Wochen verloren -
//     bezahlt, aber nicht geliefert. Wer erst kurz vor Ablauf kuendigt,
//     behaelt wie zugesagt noch 14 Tage.
//   - Es wird NICHTS geloescht. Kartei, Schueler, Protokolle bleiben, nur der
//     Tarif aendert sich. Loeschen ist ein eigener Weg (Konto loeschen, § 10).
//
// Ausgelagert, damit der Ablauf gegen den Emulator geprueft werden kann
// (tests/abo.test.mjs) statt nur behauptet.

const { FieldValue } = require('firebase-admin/firestore');

const TAG_MS = 24 * 60 * 60 * 1000;
const NACHLAUF_TAGE = 14;

// Wo liegt das Abo mit dieser Kennung? Gleiche Suche wie im paypalWebhook:
// erst Fahrschulen, dann eigenstaendige Lehrer.
async function findeAbo(db, subscriptionId) {
  if (!subscriptionId) return null;
  for (const coll of ['fahrschulen', 'users']) {
    const snap = await db.collection(coll)
      .where('aboSubscriptionId', '==', subscriptionId).limit(1).get();
    if (!snap.empty) return snap.docs[0];
  }
  return null;
}

// Kuendigung vormerken. Mehrfach-Meldungen (Webhooks werden wiederholt
// zugestellt; Stripe meldet erst "zum Periodenende gekuendigt", spaeter
// "beendet") verschieben das Ende NICHT nach hinten - es zaehlt die erste.
// bezahltBis: Ende des laufenden (bezahlten oder Test-) Zeitraums in ms,
// soweit PayPal/Stripe es mitliefern; sonst null.
function kuendigungsEnde(jetzt, bezahltBis) {
  const mindestens = jetzt + NACHLAUF_TAGE * TAG_MS;
  const bis = Number(bezahltBis) || 0;
  return bis > mindestens ? bis : mindestens;
}

async function kuendigungVormerken(db, subscriptionId, jetzt = Date.now(), quelle = '', bezahltBis = null) {
  const d = await findeAbo(db, subscriptionId);
  if (!d) return { ergebnis: 'kein-treffer' };
  const b = d.data();
  if (b.aboGekuendigteSubscriptionId === subscriptionId && b.aboEndetAm) {
    return { ergebnis: 'schon-vorgemerkt', pfad: d.ref.path, endetAm: b.aboEndetAm };
  }
  const endetAm = kuendigungsEnde(jetzt, bezahltBis);
  await d.ref.update({
    aboStatus: 'gekuendigt',
    aboGekuendigtAm: jetzt,
    aboEndetAm: endetAm,
    aboGekuendigteSubscriptionId: subscriptionId,
    aboKuendigungQuelle: quelle || null,
  });
  return { ergebnis: 'vorgemerkt', pfad: d.ref.path, endetAm };
}

// Kuendigung zurueckgenommen (Stripe: "doch nicht zum Periodenende kuendigen",
// PayPal: Abo wieder aktiviert). Nur fuer GENAU dieses Abo.
async function kuendigungAufheben(db, subscriptionId) {
  const d = await findeAbo(db, subscriptionId);
  if (!d) return { ergebnis: 'kein-treffer' };
  const b = d.data();
  if (b.aboGekuendigteSubscriptionId !== subscriptionId) return { ergebnis: 'nichts-vorgemerkt' };
  await d.ref.update(KUENDIGUNG_ENTFERNEN());
  return { ergebnis: 'aufgehoben', pfad: d.ref.path };
}

// Felder, mit denen eine Kuendigungs-Vormerkung entfernt wird - auch beim
// Abschluss eines NEUEN Abos, sonst stellte der naechtliche Job das frisch
// bezahlte Abo trotzdem um.
function KUENDIGUNG_ENTFERNEN() {
  return {
    aboStatus: 'aktiv',
    aboGekuendigtAm: FieldValue.delete(),
    aboEndetAm: FieldValue.delete(),
    aboGekuendigteSubscriptionId: FieldValue.delete(),
    aboKuendigungQuelle: FieldValue.delete(),
  };
}

// Naechtlich: alle Abos, deren Nachlauf um ist, auf 'free' stellen.
// Sicherung: Nur wenn das gekuendigte Abo noch das aktuelle ist. Hat der
// Kunde inzwischen ein neues abgeschlossen (andere Kennung), bleibt der
// Tarif und nur die alte Vormerkung wird entfernt.
async function abgelaufeneAbosBeenden(db, jetzt = Date.now(), hoechstens = 200) {
  const bericht = { beendet: 0, uebersprungen: 0 };
  for (const coll of ['fahrschulen', 'users']) {
    const snap = await db.collection(coll)
      .where('aboEndetAm', '<=', jetzt).limit(hoechstens).get();
    for (const d of snap.docs) {
      const b = d.data();
      if (!b.aboGekuendigteSubscriptionId ||
          b.aboGekuendigteSubscriptionId !== b.aboSubscriptionId) {
        await d.ref.update({
          aboGekuendigtAm: FieldValue.delete(),
          aboEndetAm: FieldValue.delete(),
          aboGekuendigteSubscriptionId: FieldValue.delete(),
          aboKuendigungQuelle: FieldValue.delete(),
        });
        bericht.uebersprungen++;
        continue;
      }
      await d.ref.update({
        abo: 'free',
        aboStatus: 'beendet',
        aboPlaner: false,
        aboMaxLehrer: FieldValue.delete(),
        aboBeendetAm: jetzt,
        // Die alte Kennung beiseitelegen: Ein abgelaufenes Abo darf weder
        // Rechnungen ausloesen noch bei einer spaeteren Kontoloeschung ein
        // zweites Mal gekuendigt werden.
        aboVorherigeSubscriptionId: b.aboSubscriptionId,
        aboSubscriptionId: FieldValue.delete(),
        aboEndetAm: FieldValue.delete(),
        aboGekuendigteSubscriptionId: FieldValue.delete(),
      });
      bericht.beendet++;
    }
  }
  return bericht;
}

// ── Kuendigen IN DER APP (Knopf "Abo kündigen") ─────────────────────
// Bisher ging Kuendigen nur bei PayPal selbst oder per E-Mail an den
// Betreiber, der das Abo dann von Hand bei Stripe beenden musste. Jetzt
// kuendigt der Inhaber selbst; der Server beendet das Abo beim
// Zahlungsdienstleister und merkt die Kuendigung vor (wie die Webhooks).
//
//   Stripe: "zum Ende des Abrechnungszeitraums kuendigen" - es wird nichts
//           mehr abgebucht, der bezahlte Zeitraum laeuft aus. Bis dahin
//           laesst sich die Kuendigung zuruecknehmen.
//   PayPal: kennt kein "zum Periodenende". Das Abo wird beendet (keine
//           weiteren Abbuchungen), der bezahlte Zeitraum bleibt nutzbar. Eine
//           Ruecknahme geht nicht - dann einfach neu abschliessen.
//
// anbieter = { stripeKuendigen(subId) -> bezahltBis (ms),
//              stripeFortsetzen(subId),
//              paypalKuendigen(subId) -> bezahltBis (ms) }
// ausgelagert, damit der Ablauf ohne echte Zahlungen pruefbar ist
// (tests/kuendigen.test.mjs).

function zahlungsartVon(b) {
  const subId = String(b.aboSubscriptionId || '');
  if (b.aboZahlungsart === 'stripe' || subId.startsWith('sub_')) return 'stripe';
  return 'paypal';
}

// Was der Knopf in der App anzeigen soll
function aboStand(b, jetzt = Date.now()) {
  const subId = b.aboSubscriptionId || null;
  const gekuendigt = !!(subId && b.aboGekuendigteSubscriptionId === subId && b.aboEndetAm);
  const zahlungsart = subId ? zahlungsartVon(b) : null;
  return {
    laufendesAbo: !!subId && b.abo && b.abo !== 'free',
    gekuendigt,
    endetAm: gekuendigt ? b.aboEndetAm : null,
    zahlungsart,
    // Zuruecknehmen nur bei Stripe und nur, solange das Abo noch laeuft
    fortsetzbar: gekuendigt && zahlungsart === 'stripe'
      && String(b.aboKuendigungQuelle || '').startsWith('stripe') && b.aboEndetAm > jetzt,
  };
}

async function aboKuendigen(db, ref, anbieter, jetzt = Date.now()) {
  const snap = await ref.get();
  if (!snap.exists) return { fehler: 'kein-abo' };
  const b = snap.data();
  const subId = b.aboSubscriptionId;
  if (!subId || !b.abo || b.abo === 'free') return { fehler: 'kein-abo' };
  if (b.aboGekuendigteSubscriptionId === subId && b.aboEndetAm) {
    return { ergebnis: 'schon-gekuendigt', ...aboStand(b, jetzt) };
  }
  const art = zahlungsartVon(b);
  const bezahltBis = art === 'stripe'
    ? await anbieter.stripeKuendigen(subId)
    : await anbieter.paypalKuendigen(subId);
  const r = await kuendigungVormerken(db, subId, jetzt, art + ':app', bezahltBis);
  const neu = (await ref.get()).data();
  return { ergebnis: r.ergebnis, ...aboStand(neu, jetzt) };
}

async function aboFortsetzen(db, ref, anbieter, jetzt = Date.now()) {
  const snap = await ref.get();
  if (!snap.exists) return { fehler: 'kein-abo' };
  const b = snap.data();
  const st = aboStand(b, jetzt);
  if (!st.gekuendigt) return { ergebnis: 'nicht-gekuendigt', ...st };
  if (!st.fortsetzbar) return { fehler: 'nicht-fortsetzbar', ...st };
  await anbieter.stripeFortsetzen(b.aboSubscriptionId);
  await kuendigungAufheben(db, b.aboSubscriptionId);
  return { ergebnis: 'fortgesetzt', ...aboStand((await ref.get()).data(), jetzt) };
}

module.exports = {
  kuendigungVormerken, kuendigungAufheben, abgelaufeneAbosBeenden,
  KUENDIGUNG_ENTFERNEN, findeAbo, NACHLAUF_TAGE, kuendigungsEnde,
  aboStand, aboKuendigen, aboFortsetzen, zahlungsartVon,
};
