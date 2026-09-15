// Rechnungen: Nummernkreis, PDF und Ablage - fuer Stripe wie fuer PayPal.
//
// Eigenes Modul, weil dieser Ablauf vorher ZWEIMAL im Projekt stand, Zeile
// fuer Zeile gleich (Befund F5): einmal im Stripe-Zweig, einmal im
// PayPal-Zweig. Eine Korrektur an einer Stelle erreichte die andere nicht.
// Als eigenes Modul laesst er sich ausserdem gegen den Emulator pruefen,
// ohne die Deploy-Oberflaeche von index.js anzufassen.
const admin = require('firebase-admin');

const PDFDocument = require('pdfkit');

const RECHNUNG_PLANS = {
  solo:       { label: 'Solo (eigenstaendiger Fahrlehrer)', price: 9.99,  pricePlaner: 13.99 },
  bis5:       { label: 'Fahrschule bis 5 Fahrlehrer',       price: 12.99, pricePlaner: 16.99 },
  bis10:      { label: 'Fahrschule bis 10 Fahrlehrer',      price: 20.99, pricePlaner: 25.99 },
  bis15:      { label: 'Fahrschule bis 15 Fahrlehrer',      price: 26.99, pricePlaner: 34.99 },
  // setup/setupPlaner: einmalige Einrichtungsgebuehr fuer diese Stufe (siehe
  // agb.html § 4) - dieselben Betraege wie im Client (index.html, PLANS.unbegrenzt).
  unbegrenzt: { label: 'Fahrschule unbegrenzt',             price: 34.99, pricePlaner: 40.99, setup: 42.99, setupPlaner: 45.99 },
};

// Echte PayPal-Plan-IDs je Tarif (Standard/mit Planer) - dieselben wie im
// Client (index.html, Konstante PLANS). Dient NUR der serverseitigen
// Verifikation in bestaetigePaypalAbo: eine PayPal-Subscription-ID muss zu
// GENAU diesem Plan gehoeren, sonst wird kein Abo aktiviert.
const PAYPAL_PLAN_IDS = {
  solo:       { id: 'P-4NU22633BD298162DNJFEWLI', idPlaner: 'P-5WR5028990092335YNJFEXYA', maxLehrer: 1 },
  bis5:       { id: 'P-6MT978804E871203DNJFEY6I', idPlaner: 'P-62X57828ND5677308NJFEZVA', maxLehrer: 5 },
  bis10:      { id: 'P-6PU84465TJ206253SNJFE2GI', idPlaner: 'P-0R339159LA0608445NJFE2ZQ', maxLehrer: 10 },
  bis15:      { id: 'P-73W48950B2092742VNJFE3KY', idPlaner: 'P-3P20164845621960ANJFE35A', maxLehrer: 15 },
  unbegrenzt: { id: 'P-22Y05276M00023207NJFE4ZA', idPlaner: 'P-4SF532859T7264908NJFE5PQ', maxLehrer: null },
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

// Rechnungsdaten des Ausstellers - einmal an einer Stelle, nicht je Zahlweg.
async function rechnungsSteller() {
  const platDoc = await admin.firestore().doc('platform/impressum').get();
  const p = platDoc.exists ? platDoc.data() : {};
  return {
    name: p.name || 'Chriskoo', strasse: p.strasse || '',
    plz: p.plz || '', ort: p.ort || '',
    email: p.email || 'kontakt@fahrsync.de', web: p.web || 'fahrsync.de',
    steuernummer: p.steuernummer || '050/240/09485',
  };
}

const RECHNUNG_LAENDER = { DE: '', AT: 'Österreich', CH: 'Schweiz', XX: '' };

// Legt EINE Rechnung an - fuer Stripe wie fuer PayPal, fuer Erstzahlung wie
// fuer Verlaengerung. Vorher stand dieser Ablauf zweimal im Projekt, Zeile
// fuer Zeile gleich; eine Korrektur an einer Stelle erreichte die andere
// nicht (Befund F5).
//
// SICHERHEITS-/BUCHHALTUNGS-AUDIT (Befund F4): Die Rechnungsnummer wurde
// vorher in einer eigenen Transaktion gezogen und das Rechnungsdokument erst
// DANACH geschrieben. War es schon vorhanden - genau der Wiederholungsfall,
// den der Code selbst abfaengt - war die Nummer bereits verbraucht und tauchte
// auf keiner Rechnung auf. Jede erneut zugestellte Webhook-Meldung riss so
// still eine Luecke in den Nummernkreis, den § 14 Abs. 4 Nr. 4 UStG
// fortlaufend verlangt.
//
// Jetzt liegen Pruefung, Nummernvergabe und Rechnungsdokument in EINER
// Transaktion. Existiert die Rechnung bereits, bricht sie ab, ohne den
// Zaehler anzufassen. Das PDF wird zwischen Lesen und Schreiben gebaut - die
// Reihenfolge, die Firestore verlangt (erst alle Lesevorgaenge, dann alle
// Schreibvorgaenge). Bei einem Wiederholungslauf der Transaktion wird es neu
// gebaut; das kostet Rechenzeit, aber nie eine Nummer.
async function rechnungAnlegen({
  billingId, empfaengerName, b, plan, planer, planInfo,
  betrag, zahlungsart, docId, referenzFelder, herkunft,
}) {
  const db = admin.firestore();
  const counterRef = db.doc('platform/rechnungszaehler');
  const rechnungRef = db.collection('rechnungen').doc(docId);

  const steller = await rechnungsSteller();
  const empfaenger = {
    name: empfaengerName,
    strasse: b.rechnungsStrasse, plz: b.rechnungsPlz, ort: b.rechnungsOrt,
    land: RECHNUNG_LAENDER[b.rechnungsLand || 'DE'] || '',
  };

  return await db.runTransaction(async (tx) => {
    // Erst lesen: gibt es die Rechnung zu diesem Ereignis schon?
    const vorhanden = await tx.get(rechnungRef);
    if (vorhanden.exists) {
      console.log(herkunft + ': Rechnung bereits vorhanden (Retry), ignoriert');
      return null;                       // Zaehler bleibt unberuehrt
    }
    const c = await tx.get(counterRef);
    const jahr = new Date().getFullYear();
    const bisher = c.exists ? (c.data().naechsteNummer || 1) : 1;
    const nummer = `${jahr}-${String(bisher).padStart(5, '0')}`;

    const datum = new Date().toLocaleDateString('de-DE');
    const pdfBuffer = await baueRechnungsPdf({
      nummer, datum, steller, empfaenger, planLabel: planInfo.label, betrag, zahlungsart,
    });

    // Jetzt schreiben: Zaehler und Rechnung gehen gemeinsam durch oder gar nicht.
    tx.set(counterRef, { naechsteNummer: bisher + 1 }, { merge: true });
    tx.create(rechnungRef, {
      nummer, empfaengerId: billingId, empfaengerName: empfaenger.name,
      plan, planer: !!planer, betrag, datum, erstelltAm: Date.now(),
      pdfBase64: pdfBuffer.toString('base64'),
      ...referenzFelder,
    });
    return nummer;
  });
}

module.exports = { rechnungAnlegen, baueRechnungsPdf, rechnungsSteller, RECHNUNG_PLANS };
