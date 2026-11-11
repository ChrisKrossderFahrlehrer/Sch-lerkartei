'use strict';
// Zaehler "gebuchte Fahrstunden" eines Kalender-Schuelers (schueler.bookedCount).
//
// Der Zaehler steht im Kontingent ("3 / 10") und entscheidet auf der
// Buchungsseite, ob ein Schueler noch Termine anfragen darf.
//
// Bis 11/2026 wurde er nur mitgefuehrt, wenn sich an einem BESTEHENDEN Termin
// die Buchung aenderte (+1 / -1). Zwei Luecken:
//   - Wurde ein gebuchter Termin GELOESCHT, zaehlte er nie zurueck. Der
//     Schueler stand irgendwann bei "10 / 10" und konnte nichts mehr anfragen,
//     obwohl Stunden frei waren.
//   - Termine, die gleich MIT Schueler angelegt wurden (so legt die Kartei
//     geplante Fahrstunden in den Kalender), zaehlten gar nicht.
// Ein einmal falscher Stand blieb ausserdem fuer immer falsch.
//
// Jetzt wird nicht mehr mitgerechnet, sondern nachgezaehlt: Der Zaehler ist
// die Anzahl der Termine, die auf den Schueler gebucht sind. Jede Aenderung
// (anlegen, buchen, stornieren, loeschen) zaehlt neu - ein falscher Stand
// heilt damit von selbst.

const ID_OK = /^[A-Za-z0-9_-]{1,64}$/;

// Zaehlt nur Termine, die zum Schueler gehoeren (gleiche Schule oder gleicher
// Fahrlehrer). Sonst koennte jemand mit Terminen im EIGENEN Kalender den
// Zaehler eines fremden Schuelers hochtreiben und ihn so aussperren.
function terminPasst(schueler, termin) {
  return (!schueler.schoolId && !schueler.lehrerUid)
    || (!!schueler.schoolId && schueler.schoolId === termin.schoolId)
    || (!!schueler.lehrerUid && schueler.lehrerUid === termin.lehrerUid);
}

// Zaehlt die Buchungen eines Schuelers neu und schreibt den Stand.
// Rueckgabe: der neue Stand, oder null (Schueler gibt es nicht / ungueltige ID).
async function buchungenNeuZaehlen(db, schuelerId) {
  if (typeof schuelerId !== 'string' || !ID_OK.test(schuelerId)) return null;
  const ref = db.doc(`schueler/${schuelerId}`);
  const stand = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return null;
    const sc = snap.data();
    // In der Transaktion gelesen: Aendert sich waehrenddessen eine Buchung
    // dieses Schuelers, wird neu gezaehlt statt einen alten Stand zu schreiben.
    const termine = await tx.get(
      db.collection('slots').where('bookedBy', '==', schuelerId).select('schoolId', 'lehrerUid'));
    let n = 0;
    termine.forEach(d => { if (terminPasst(sc, d.data())) n++; });
    if (sc.bookedCount !== n) tx.update(ref, { bookedCount: n });
    return n;
  });
  if (stand !== null) {
    // Die Buchungsseite liest den Stand aus bookingStudents. update statt
    // set(merge): Gibt es das Dokument noch nicht, darf es hier NICHT
    // entstehen (ein Dokument nur mit dem Zaehler, ohne lehrerUid, konnte der
    // Fahrlehrer nie mehr beschreiben).
    await db.doc(`bookingStudents/${schuelerId}`).update({ bookedCount: stand }).catch(() => {});
  }
  return stand;
}

// Naechtliche Nachzaehlung fuer alle Schueler MIT Kontingent - nur bei ihnen
// sperrt ein falscher Stand etwas. Bringt auch Altbestand in Ordnung, an dem
// sich nichts mehr aendert.
async function kontingenteNachzaehlen(db, hoechstens = 400) {
  const snap = await db.collection('schueler').where('maxFahrstunden', '>', 0).limit(hoechstens).get();
  let korrigiert = 0;
  for (const d of snap.docs) {
    try {
      const alt = d.get('bookedCount');
      const neu = await buchungenNeuZaehlen(db, d.id);
      if (neu !== null && neu !== alt) korrigiert++;
    } catch (e) { console.warn('Nachzaehlen', d.id, e.message); }
  }
  return korrigiert;
}

module.exports = { buchungenNeuZaehlen, kontingenteNachzaehlen, terminPasst };
