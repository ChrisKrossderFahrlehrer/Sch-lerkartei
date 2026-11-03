'use strict';
// Erinnerung an den Fahrschueler vor einer geplanten Fahrstunde.
//
// Quelle: accessCodes.plannedLessons (vom Fahrlehrer in der Kartei geplant,
// Datum + Uhrzeit in deutscher Ortszeit). Empfaenger: alle Geraete, auf
// denen der Schueler im Portal Benachrichtigungen erlaubt hat (fcmTokens mit
// rolle 'schueler'). Ohne Uhrzeit oder bei abgesagten Stunden: keine
// Erinnerung. Jede Erinnerung wird in 'erinnerungen' vermerkt, damit sie
// nie doppelt kommt, auch wenn der Zeitplan oefter laeuft.

const VORLAUF_MIN = 120;   // Ziel: etwa zwei Stunden vorher
const FENSTER_MIN = 30;    // Laufabstand des Zeitplans

// 'YYYY-MM-DD' + 'HH:MM' (Europe/Berlin) -> Millisekunden (UTC)
function berlinZuMs(datum, uhrzeit) {
  const m1 = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(datum || ''));
  const m2 = /^(\d{1,2}):(\d{2})$/.exec(String(uhrzeit || ''));
  if (!m1 || !m2) return null;
  const roh = Date.UTC(+m1[1], +m1[2] - 1, +m1[3], +m2[1], +m2[2]);
  const teile = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Berlin', hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).formatToParts(new Date(roh)).reduce((o, p) => (o[p.type] = p.value, o), {});
  const wand = Date.UTC(+teile.year, +teile.month - 1, +teile.day, +teile.hour, +teile.minute);
  return roh - (wand - roh);
}

// Stunden, die jetzt erinnert werden sollen: Beginn zwischen
// VORLAUF - FENSTER und VORLAUF Minuten ab jetzt (bei jedem Lauf genau ein Fenster).
function faelligeStunden(plannedLessons, jetzt) {
  const von = jetzt + (VORLAUF_MIN - FENSTER_MIN) * 60000;
  const bis = jetzt + VORLAUF_MIN * 60000;
  return (plannedLessons || []).filter(l => {
    if (!l || !l.id || !l.uhrzeit) return false;
    if (l.status === 'abgesagt') return false;
    const t = berlinZuMs(l.datum, l.uhrzeit);
    return t !== null && t > von && t <= bis;
  });
}

function erinnerungsText(l) {
  const ort = String(l.ort || '').trim();
  return {
    title: '🚗 Gleich Fahrstunde',
    body: `Heute um ${l.uhrzeit} Uhr` + (ort ? ` · Treffpunkt: ${ort.slice(0, 60)}` : '') + '. Bis gleich!',
  };
}

// Ein Lauf. pushFn(codeId, title, body) schickt die Nachricht.
async function erinnerungenSenden(db, pushFn, jetzt = Date.now()) {
  const tokSnap = await db.collection('fcmTokens').where('rolle', '==', 'schueler').get();
  const codeIds = [...new Set(tokSnap.docs.map(d => d.get('codeId')).filter(Boolean))];
  let gesendet = 0;
  for (const codeId of codeIds) {
    try {
      const code = await db.collection('accessCodes').doc(codeId).get();
      if (!code.exists) continue;
      const ablauf = code.get('expiresAt');
      if (typeof ablauf === 'number' && ablauf < jetzt) continue;
      for (const l of faelligeStunden(code.get('plannedLessons'), jetzt)) {
        const marke = db.collection('erinnerungen').doc(`${codeId}_${l.id}`);
        // create() schlaegt fehl, wenn es die Marke schon gibt -> nie doppelt
        try { await marke.create({ codeId, lessonId: l.id, gesendetAm: jetzt, loeschenAb: jetzt + 30 * 86400000 }); }
        catch (e) { continue; }
        const t = erinnerungsText(l);
        await pushFn(codeId, t.title, t.body);
        gesendet++;
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

module.exports = { berlinZuMs, faelligeStunden, erinnerungsText, erinnerungenSenden, VORLAUF_MIN, FENSTER_MIN };
