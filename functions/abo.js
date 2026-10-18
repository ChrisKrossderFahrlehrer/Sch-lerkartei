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

module.exports = {
  kuendigungVormerken, kuendigungAufheben, abgelaufeneAbosBeenden,
  KUENDIGUNG_ENTFERNEN, findeAbo, NACHLAUF_TAGE, kuendigungsEnde,
};
