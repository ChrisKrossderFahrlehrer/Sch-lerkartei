// Papierkorb im Archiv: geloeschte Schueler (students.archivGrund ==
// 'geloescht') bleiben PAPIERKORB_TAGE lang wiederherstellbar.
//
// Warum serverseitig: Die App kann Zugangscodes und Protokoll nur fuer den
// Fahrlehrer anfassen, der sie angelegt hat (Regeln: teacherUid/uid ==
// eigene UID). Loeschte ein Kollege oder der Fahrschul-Inhaber den Schueler,
// blieb dessen Portal offen, und beim endgueltigen Loeschen blieben Chat,
// Fotos und Protokoll des anderen Fahrlehrers liegen. Auch ein Geraet ohne
// Netz oder eine App, die nie wieder geoeffnet wird, verhinderte Sperre bzw.
// Loeschung. Hier laeuft beides mit dem Admin SDK - unabhaengig davon, wer
// geloescht hat und ob dessen App je wieder startet.

const { FieldValue } = require('firebase-admin/firestore');
const { loescheAlle, loescheZugangscodesMitBildern } = require('./loeschen');

const PAPIERKORB_TAGE = 90;
const TAG_MS = 24 * 60 * 60 * 1000;

const istGeloescht = (d) => !!d && d.archivGrund === 'geloescht';

// Alle noch gueltigen Portal-Codes des Schuelers sofort ablaufen lassen.
// Liefert die bisherigen Ablaufzeiten (codeId -> expiresAt), damit das
// Wiederherstellen genau den vorherigen Zustand zurueckbringt - ein Code,
// der schon vorher abgelaufen war, bleibt abgelaufen.
async function portalSperren(db, studentId, jetzt = Date.now()) {
  const snap = await db.collection('accessCodes').where('studentId', '==', studentId).get();
  const vorher = {};
  for (const d of snap.docs) {
    const bis = d.get('expiresAt');
    if (typeof bis === 'number' && bis <= jetzt) continue;
    vorher[d.id] = typeof bis === 'number' ? bis : null;
    await d.ref.update({ expiresAt: jetzt });
  }
  return vorher;
}

async function portalFreigeben(db, studentId, vorher, jetzt = Date.now()) {
  let n = 0;
  for (const [codeId, bis] of Object.entries(vorher || {})) {
    const ref = db.collection('accessCodes').doc(codeId);
    const d = await ref.get();
    if (!d.exists || d.get('studentId') !== studentId) continue;
    // Ohne frueheres Datum: ein Jahr, wie beim Anlegen eines Codes.
    await ref.update({ expiresAt: bis === null ? jetzt + 365 * TAG_MS : bis });
    n++;
  }
  return n;
}

// Uebergang: Schueler, die geloescht wurden, bevor es diesen Trigger gab,
// haben keine gemerkten Ablaufzeiten - die App hatte ihre Codes beim
// Loeschen selbst auf "jetzt" gesetzt. Wieder geoeffnet werden genau die
// Codes, die zum Loeschzeitpunkt abgelaufen sind (Spielraum fuer
// Uhrabweichung); frueher abgelaufene bleiben zu.
async function portalFreigebenAlt(db, studentId, geloeschtAm, jetzt = Date.now()) {
  if (!geloeschtAm) return 0;
  const snap = await db.collection('accessCodes').where('studentId', '==', studentId).get();
  let n = 0;
  for (const d of snap.docs) {
    const bis = d.get('expiresAt');
    if (typeof bis !== 'number' || bis > jetzt) continue;
    if (Math.abs(bis - geloeschtAm) > 10 * 60 * 1000) continue;
    await d.ref.update({ expiresAt: jetzt + 365 * TAG_MS });
    n++;
  }
  return n;
}

// Schueler samt Begleitdaten endgueltig entfernen: Zugangscodes (Chat,
// Name, Planung) mit Chat-Fotos, Protokoll, zuletzt das Schueler-Dokument.
async function schuelerEndgueltigLoeschen(db, studentId) {
  const codes = await loescheZugangscodesMitBildern(
    db.collection('accessCodes').where('studentId', '==', studentId));
  const protokoll = await loescheAlle(
    db.collection('protokoll').where('studentId', '==', studentId));
  // Verknuepfte Kalender-Daten (Kalender-Schueler mit adkStudentId) samt
  // Theorie-Eintraegen. Termine bleiben stehen; sie tragen nur die ID des
  // Kalender-Schuelers, die danach ins Leere zeigt.
  let kalender = 0;
  const kalSnap = await db.collection('schueler').where('adkStudentId', '==', studentId).get();
  for (const k of kalSnap.docs) {
    kalender += await loescheAlle(db.collection('theorieStunden').where('schuelerId', '==', k.id));
    await k.ref.delete();
    kalender++;
  }
  await db.collection('students').doc(studentId).delete();
  return { codes, protokoll, kalender };
}

// Reaktion auf eine Aenderung am Schueler-Dokument (Trigger in index.js).
async function papierkorbAenderung(db, studentId, vorher, nachher, jetzt = Date.now()) {
  if (!nachher) return 'entfernt';
  const warGeloescht = istGeloescht(vorher);
  const istJetzt = istGeloescht(nachher);
  const ref = db.collection('students').doc(studentId);

  if (istJetzt && nachher.sofortLoeschen === true) {
    await schuelerEndgueltigLoeschen(db, studentId);
    return 'endgueltig';
  }
  if (!warGeloescht && istJetzt) {
    const codes = await portalSperren(db, studentId, jetzt);
    await ref.update({ portalAblaufVorher: codes, portalGesperrtAm: jetzt });
    return 'gesperrt';
  }
  if (warGeloescht && !istJetzt) {
    const gemerkt = nachher.portalAblaufVorher || vorher.portalAblaufVorher;
    if (gemerkt) await portalFreigeben(db, studentId, gemerkt, jetzt);
    else await portalFreigebenAlt(db, studentId, vorher.geloeschtAm, jetzt);
    await ref.update({ portalAblaufVorher: FieldValue.delete(), portalGesperrtAm: FieldValue.delete() });
    return 'freigegeben';
  }
  return 'nichts';
}

// Naechtlich: alles, was laenger als PAPIERKORB_TAGE im Papierkorb liegt.
// Gefiltert wird ueber archivGrund (Gleichheit, kein Zusatz-Index noetig);
// fehlt geloeschtAm, zaehlt archiviertAm - sonst bliebe so ein Datensatz
// fuer immer liegen.
async function papierkorbLeeren(db, jetzt = Date.now(), hoechstens = 200) {
  const grenze = jetzt - PAPIERKORB_TAGE * TAG_MS;
  const snap = await db.collection('students').where('archivGrund', '==', 'geloescht').get();
  let n = 0;
  for (const d of snap.docs) {
    if (n >= hoechstens) break;
    const seit = d.get('geloeschtAm') || d.get('archiviertAm') || 0;
    if (seit > grenze) continue;
    await schuelerEndgueltigLoeschen(db, d.id);
    n++;
  }
  return n;
}

module.exports = {
  PAPIERKORB_TAGE, istGeloescht, portalSperren, portalFreigeben,
  schuelerEndgueltigLoeschen, papierkorbAenderung, papierkorbLeeren,
};
