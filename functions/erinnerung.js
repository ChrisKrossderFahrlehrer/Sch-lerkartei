'use strict';
// Erinnerung an den Fahrschueler vor einer geplanten Fahrstunde.
//
// Quelle: accessCodes.plannedLessons (vom Fahrlehrer in der Kartei geplant,
// Datum + Uhrzeit in deutscher Ortszeit). Empfaenger: alle Geraete, auf
// denen der Schueler im Portal Benachrichtigungen erlaubt hat (fcmTokens mit
// rolle 'schueler'). Ohne Uhrzeit oder bei abgesagten Stunden: keine
// Erinnerung. Jede Erinnerung wird in 'erinnerungen' vermerkt, damit sie
// nie doppelt kommt, auch wenn der Zeitplan oefter laeuft.
//
// Ueberarbeitet nach der unabhaengigen Pruefung (11/2026):
// - Das Zeitfenster reicht von 30 bis 120 Minuten vor Beginn. Faellt ein
//   Lauf aus (Deploy, Fehler, Zeitueberschreitung), holt der naechste die
//   Erinnerung nach; die Marke verhindert Doppel.
// - Die Marke enthaelt Datum und Uhrzeit: Wird eine Stunde verschoben, gibt
//   es fuer den neuen Termin wieder eine Erinnerung.
// - Kein Treffpunkt mehr im Text: Er steht auf dem Sperrbildschirm und ist
//   oft die Wohnadresse.
// - Zeitumstellung: Der Versatz wird zweimal bestimmt (richtig auch in der
//   Stunde der Umstellung).

const VORLAUF_MIN = 120;   // fruehestens zwei Stunden vorher
const SPAETESTENS_MIN = 30; // spaetestens eine halbe Stunde vorher
const MAX_JE_CODE = 3;     // Schutz vor ueberlangen Listen

const berlinFormat = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Berlin', hourCycle: 'h23',
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
});
function wanduhr(ms) {
  const t = berlinFormat.formatToParts(new Date(ms)).reduce((o, p) => (o[p.type] = p.value, o), {});
  return Date.UTC(+t.year, +t.month - 1, +t.day, +t.hour, +t.minute);
}

// 'YYYY-MM-DD' + 'HH:MM' (Europe/Berlin) -> Millisekunden (UTC)
function berlinZuMs(datum, uhrzeit) {
  const m1 = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(datum || ''));
  const m2 = /^(\d{1,2}):(\d{2})$/.exec(String(uhrzeit || ''));
  if (!m1 || !m2) return null;
  const roh = Date.UTC(+m1[1], +m1[2] - 1, +m1[3], +m2[1], +m2[2]);
  let t = roh - (wanduhr(roh) - roh);
  t = roh - (wanduhr(t) - t);   // zweiter Schritt: Versatz am Zielzeitpunkt
  return t;
}

// Berliner Kalenderdatum 'YYYY-MM-DD' eines Zeitpunkts
function berlinDatum(ms) {
  const w = new Date(wanduhr(ms));
  return w.toISOString().slice(0, 10);
}

// Stunden, die jetzt erinnert werden sollen: Beginn zwischen 30 und 120
// Minuten ab jetzt.
function faelligeStunden(plannedLessons, jetzt) {
  const von = jetzt + SPAETESTENS_MIN * 60000;
  const bis = jetzt + VORLAUF_MIN * 60000;
  return (plannedLessons || []).filter(l => {
    if (!l || !l.uhrzeit || !/^[A-Za-z0-9_-]{1,40}$/.test(String(l.id || ''))) return false;
    if (l.status === 'abgesagt') return false;
    const t = berlinZuMs(l.datum, l.uhrzeit);
    return t !== null && t > von && t <= bis;
  }).slice(0, MAX_JE_CODE);
}

function erinnerungsText(l, jetzt = Date.now()) {
  const tag = l.datum === berlinDatum(jetzt) ? 'Heute' : 'Morgen';
  return {
    title: '🚗 Gleich Fahrstunde',
    body: `${tag} um ${l.uhrzeit} Uhr. Bis gleich!`,
  };
}

function markenId(codeId, l) {
  return `${codeId}_${l.id}_${l.datum}_${String(l.uhrzeit).replace(':', '')}`;
}

// Ein Lauf. pushFn(codeId, title, body) schickt die Nachricht.
async function erinnerungenSenden(db, pushFn, jetzt = Date.now()) {
  const tokSnap = await db.collection('fcmTokens').where('rolle', '==', 'schueler').get();
  const codeIds = [...new Set(tokSnap.docs.map(d => d.get('codeId')).filter(c => typeof c === 'string' && c))];
  let gesendet = 0;
  for (const codeId of codeIds) {
    try {
      const code = await db.collection('accessCodes').doc(codeId).get();
      if (!code.exists) continue;
      const ablauf = code.get('expiresAt');
      if (typeof ablauf === 'number' && ablauf < jetzt) continue;
      for (const l of faelligeStunden(code.get('plannedLessons'), jetzt)) {
        const marke = db.collection('erinnerungen').doc(markenId(codeId, l));
        // create() schlaegt fehl, wenn es die Marke schon gibt -> nie doppelt
        try {
          await marke.create({ codeId, lessonId: String(l.id), gesendetAm: jetzt, loeschenAb: jetzt + 30 * 86400000 });
        } catch (e) {
          if (e && e.code !== 6) console.warn('Erinnerung: Marke', codeId, e.message); // 6 = ALREADY_EXISTS
          continue;
        }
        const t = erinnerungsText(l, jetzt);
        try {
          await pushFn(codeId, t.title, t.body);
          gesendet++;
        } catch (e) {
          // Push gescheitert: Marke wieder entfernen, der naechste Lauf versucht es erneut
          console.warn('Erinnerung: Push', codeId, e.message);
          await marke.delete().catch(() => {});
        }
      }
    } catch (e) { console.warn('Erinnerung', codeId, e.message); }
  }
  // Alte Marken aufraeumen (nach 30 Tagen)
  try {
    const alt = await db.collection('erinnerungen').where('loeschenAb', '<=', jetzt).limit(300).get();
    if (!alt.empty) { const b = db.batch(); alt.docs.forEach(d => b.delete(d.ref)); await b.commit(); }
  } catch (e) { console.warn('Erinnerungen aufraeumen', e.message); }
  return gesendet;
}

module.exports = {
  berlinZuMs, berlinDatum, faelligeStunden, erinnerungsText, erinnerungenSenden, markenId,
  VORLAUF_MIN, SPAETESTENS_MIN,
};
