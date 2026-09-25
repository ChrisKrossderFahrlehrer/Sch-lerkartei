// Loeschen von Konten und Altdaten - der gefaehrlichste Teil des Projekts.
//
// Eigenes Modul aus einem Grund: Hier faellt ein Fehler nicht auf, er
// vernichtet Daten. Als Modul laesst sich der Umfang gegen den Emulator
// pruefen (tests/loeschen.test.mjs fuehrt loescheKontoHart WIRKLICH aus),
// statt ihn nur zu behaupten. Die Deploy-Oberflaeche von index.js bleibt
// unveraendert - dort steht weiterhin genau dasselbe zur Verfuegung.
// firebase-admin 14: Die alte Namensraum-Form - admin.firestore(),
// admin.auth(), admin.storage(), admin.messaging() - gibt es nicht mehr.
// Jeder Bereich hat jetzt einen eigenen Unterpfad mit einer eigenen
// Zugriffsfunktion. Beim Umstieg wurden nur diese Zeilen und die Aufrufe
// geaendert, an der Logik nichts.
const { getFirestore } = require('firebase-admin/firestore');
const { getAuth } = require('firebase-admin/auth');
const { getStorage } = require('firebase-admin/storage');
const CHAT_BUCKET = 'fahrschule-ebc65-eu-storage';

// Loescht alle Dokumente einer Abfrage in Bloecken (Firestore erlaubt
// hoechstens 500 Schreibvorgaenge pro Stapel).
// 'nurWenn' entscheidet dokumentweise, was wirklich geloescht wird. Sobald
// etwas stehen BLEIBT, darf nicht mehr immer der erste Block geholt werden -
// der saehe ja gleich aus und die Schleife liefe endlos. Deshalb wird in
// jedem Fall mit startAfter() weitergeblaettert statt neu von vorn zu lesen.
async function loescheAlle(abfrage, nurWenn = null) {
  let geloescht = 0;
  let marke = null;
  while (true) {
    let block = abfrage.limit(400);
    if (marke) block = block.startAfter(marke);
    const snap = await block.get();
    if (snap.empty) break;
    marke = snap.docs[snap.docs.length - 1];
    const zuLoeschen = nurWenn ? snap.docs.filter(nurWenn) : snap.docs;
    if (zuLoeschen.length) {
      const stapel = getFirestore().batch();
      zuLoeschen.forEach(d => stapel.delete(d.ref));
      await stapel.commit();
      geloescht += zuLoeschen.length;
    }
    if (snap.size < 400) break;
  }
  return geloescht;
}

// SICHERHEITS-AUDIT (Loeschumfang): Gehoert dieser Datensatz dem Konto noch
// SELBST - oder inzwischen der Fahrschule?
//
// Der Hintergrund: uebernehmeSchuelerInFahrschule setzt beim Uebergeben nur
// das Zuordnungsfeld (fahrschuleId bzw. schoolId) auf die Fahrschule um. Das
// Besitzerfeld (uid bzw. lehrerUid) zeigt weiterhin auf den Fahrlehrer, der
// den Datensatz ANGELEGT hat - so ist der Lernstand nachvollziehbar.
//
// Geloescht wurde bisher aber allein ueber das Besitzerfeld. Loescht also ein
// Fahrlehrer, der seine Schueler an die Fahrschule uebergeben hat, sein
// Konto, nahm er die Schueler, das Protokoll und die eigenen Themen der
// FAHRSCHULE mit - genau das Gegenteil dessen, was kontoLoeschungBeantragen
// eine Ebene hoeher zusichert ("die Schuldaten gehoeren dem Inhaber").
//
// Ohne Zuordnungsfeld gehoert der Datensatz dem Konto (customFields fuehrt
// gar keine fahrschuleId). Zeigt es auf das Konto selbst, ebenso - so sieht
// ein eigenstaendiger Fahrlehrer aus, bei dem weiterhin alles geloescht wird.
// Was der Fahrschule gehoert, faengt der Inhaber-Durchlauf ab.
const gehoertNochDemKonto = (einUid, zuordnungsFeld) => (d) => {
  const zuordnung = d.get(zuordnungsFeld);
  return zuordnung === undefined || zuordnung === null || zuordnung === einUid;
};

// Chat-Fotos eines Zugangscodes im Speicher entfernen. Serverseitig (Admin
// SDK) - die Speicher-Regeln greifen hier nicht, deshalb funktioniert das
// auch bei laengst abgelaufenen Codes.
async function loescheChatBilderServer(codeId) {
  try {
    await getStorage().bucket(CHAT_BUCKET).deleteFiles({ prefix: `chat-images/${codeId}/` });
  } catch (e) {
    console.warn('Chat-Bilder loeschen fehlgeschlagen fuer', codeId, e.message);
  }
}

// Alle Zugangscodes einer Abfrage samt zugehoeriger Chat-Fotos loeschen.
// Reihenfolge egal, da serverseitig keine Regelpruefung stattfindet.
async function loescheZugangscodesMitBildern(abfrage) {
  const snap = await abfrage.get();
  for (const d of snap.docs) {
    await loescheChatBilderServer(d.id);
    await d.ref.delete();
  }
  return snap.size;
}

// Ermittelt, was zu einem Konto gehoert. Ein Fahrschul-Inhaber nimmt die
// ganze Fahrschule mit (er ist der Verantwortliche i.S.d. DSGVO), ein
// einzelner Fahrlehrer nur seine eigenen Daten.
function loeschUmfang(uid, userData) {
  const istInhaber = userData.typ === 'fahrschule';
  return {
    istInhaber,
    fahrschuleId: istInhaber ? uid : (userData.fahrschuleId || uid),
  };
}

// Harte, endgueltige Loeschung eines Kontos samt aller Daten.
async function loescheKontoHart(uid) {
  const db = getFirestore();
  const userSnap = await db.doc(`users/${uid}`).get();
  const userData = userSnap.exists ? userSnap.data() : {};
  const { istInhaber, fahrschuleId } = loeschUmfang(uid, userData);
  const bericht = { uid, istInhaber, schueler: 0, codes: 0 };

  // Betroffene Konten: bei einem Fahrschul-Inhaber alle Mitglieder mit.
  let betroffeneUids = [uid];
  if (istInhaber) {
    const mitglieder = await db.collection('users').where('fahrschuleId', '==', fahrschuleId).get();
    betroffeneUids = [...new Set([uid, ...mitglieder.docs.map(d => d.id)])];
  }

  // 1) Zugangscodes samt Chat-Fotos - zuerst, weil an ihnen die Bilder haengen
  for (const einUid of betroffeneUids) {
    bericht.codes += await loescheZugangscodesMitBildern(
      db.collection('accessCodes').where('teacherUid', '==', einUid));
  }
  if (istInhaber) {
    bericht.codes += await loescheZugangscodesMitBildern(
      db.collection('accessCodes').where('fahrschuleId', '==', fahrschuleId));
  }

  // 2) Kartei-Daten (Schueler, Protokoll, eigene Listen)
  for (const coll of ['students', 'protokoll', 'customFields', 'customThemen', 'customGruppen']) {
    for (const einUid of betroffeneUids) {
      const anzahl = await loescheAlle(
        db.collection(coll).where('uid', '==', einUid),
        gehoertNochDemKonto(einUid, 'fahrschuleId'));
      if (coll === 'students') bericht.schueler += anzahl;
    }
    if (istInhaber) {
      const anzahl = await loescheAlle(db.collection(coll).where('fahrschuleId', '==', fahrschuleId));
      if (coll === 'students') bericht.schueler += anzahl;
    }
  }
  // Der Team-Chat fuehrt den Absender als 'senderUid' (nicht 'uid') - mit dem
  // falschen Feldnamen bliebe er stehen.
  for (const einUid of betroffeneUids) {
    await loescheAlle(db.collection('chat').where('senderUid', '==', einUid));
  }
  if (istInhaber) {
    await loescheAlle(db.collection('chat').where('fahrschuleId', '==', fahrschuleId));
  }

  // 3) Kalender-Modul (eigener Namensraum, haengt an lehrerUid bzw. schoolId)
  for (const coll of ['schueler', 'slots', 'autos', 'blocked', 'globalBlocked', 'urlaub',
                      'notizen', 'warteliste', 'pruefungen', 'theorieStunden',
                      'bookingStudents', 'bookingRequests', 'bookingMessages', 'bookingWaitlist']) {
    for (const einUid of betroffeneUids) {
      // Dieselbe Besitzfrage wie oben, nur heissen die Felder im Kalender
      // 'lehrerUid' und 'schoolId'. Ohne das nahm ein austretender Fahrlehrer
      // die Kalender-Schueler und Termine der Fahrschule mit.
      await loescheAlle(
        db.collection(coll).where('lehrerUid', '==', einUid),
        gehoertNochDemKonto(einUid, 'schoolId'));
    }
    if (istInhaber) {
      await loescheAlle(db.collection(coll).where('schoolId', '==', fahrschuleId));
    }
  }

  // 4) Konto-gebundene Einzeldokumente
  for (const einUid of betroffeneUids) {
    for (const pfad of [`calendarTokens/${einUid}`, `calendarStatus/${einUid}`,
                        `kalenderUsers/${einUid}`, `bookingLinks/${einUid}`,
                        `studentSessions/${einUid}`]) {
      await db.doc(pfad).delete().catch(() => {});
    }
    await loescheAlle(db.collection('fcmTokens').where('uid', '==', einUid));
    await loescheAlle(db.collection('usernames').where('uid', '==', einUid));
  }

  // 5) Fahrschul-Ebene
  if (istInhaber) {
    await loescheAlle(db.collection('schoolCodes').where('schoolId', '==', fahrschuleId));
    await loescheAlle(db.collection('invites').where('fahrschuleId', '==', fahrschuleId));
    await db.doc(`schools/${fahrschuleId}`).delete().catch(() => {});
    await db.doc(`fahrschulen/${fahrschuleId}`).delete().catch(() => {});
  }

  // 6) Nutzerprofile und Anmeldekonten zuletzt
  for (const einUid of betroffeneUids) {
    await db.doc(`users/${einUid}`).delete().catch(() => {});
    await getAuth().deleteUser(einUid).catch(e => {
      if (e.code !== 'auth/user-not-found') console.warn('Auth-Konto loeschen:', einUid, e.message);
    });
  }

  // Die Rechnungen bleiben bewusst erhalten (§ 14b UStG, § 147 AO).
  console.log('Konto endgueltig geloescht:', JSON.stringify(bericht));
  return bericht;
}
// ═══════════════════════════════════════════════════════════════════
// ABLAUFDATUM NACHTRAGEN
//
// Das taegliche Aufraeumen findet alte Zugangscodes ueber
//   .where('expiresAt', '<=', jetzt - 90 Tage)
// Ein Firestore-Filter ueberspringt aber JEDES Dokument, dem das Feld ganz
// fehlt - und solche gibt es: Der Client faengt sie an mehreren Stellen mit
// `data.expiresAt || (Date.now()+…)` ab, und die Speicher-Regeln haben einen
// eigenen Zweig fuer `!('expiresAt' in codeDoc().data)`.
//
// Ein solcher Code bliebe fuer immer liegen, ohne dass irgendwo ein Fehler
// auftaucht - der Job meldet "fertig". Darin stecken Name, Lernstand und der
// vollstaendige Chatverlauf eines Schuelers.
//
// BEWUSST wird hier NICHT geloescht. Ein Dokument ohne Ablaufdatum hat ein
// unbekanntes Alter; es koennte ein aktiver Zugang sein, an dem gerade ein
// Schueler haengt. Es bekommt deshalb ein Datum in der ZUKUNFT und faellt
// danach ganz normal unter die 90-Tage-Regel. Niemand wird ausgesperrt,
// nichts geht verloren - die Luecke schliesst sich trotzdem.
//
// Ohne Filter durchgesehen wird die Sammlung seitenweise, weil Firestore
// nicht nach einem fehlenden Feld fragen kann.
async function repariereFehlendeAblaufdaten(db, neuesDatum, hoechstens = 500) {
  let letzter = null, geprueft = 0, nachgetragen = 0;
  while (geprueft < hoechstens) {
    let abfrage = db.collection('accessCodes').orderBy('__name__').limit(200);
    if (letzter) abfrage = abfrage.startAfter(letzter);
    const seite = await abfrage.get();
    if (seite.empty) break;
    for (const d of seite.docs) {
      geprueft++;
      const wert = d.get('expiresAt');
      // Auch ein Textdatum oder null zaehlt als fehlend: Der Vergleich im
      // Aufraeum-Job trifft nur Zahlen, alles andere wuerde ebenso
      // stillschweigend durchrutschen.
      if (typeof wert === 'number' && Number.isFinite(wert)) continue;
      await d.ref.update({ expiresAt: neuesDatum });
      nachgetragen++;
    }
    letzter = seite.docs[seite.docs.length - 1];
    if (seite.size < 200) break;
  }
  if (nachgetragen) {
    console.log(`Ablaufdatum nachgetragen bei ${nachgetragen} Zugangscode(s) von ${geprueft} geprueften.`);
  }
  return nachgetragen;
}

// ═══════════════════════════════════════════════════════════════════
// ALTE ANONYME SITZUNGEN AUFRAEUMEN
//
// Das Schueler-Portal meldet sich bei JEDEM Besuch anonym an (der Schueler
// hat kein eigenes Konto). Jeder Besuch legt damit ein Anmeldekonto an -
// und bisher wurde davon nie eines wieder entfernt. Bei einer Fahrschule mit
// 60 Schuelern, die zweimal die Woche nachsehen, sind das ueber 6000 Konten
// im Jahr, die nichts mehr tun.
//
// Loeschen ist hier gefahrlos: An der anonymen Kennung haengt NICHTS. Die
// Chat-Bilder liegen unter der Code-Kennung, der Lernstand im Zugangscode,
// und das Portal meldet sich beim naechsten Aufruf einfach neu an. Wer
// zwischendurch vorbeischaut, bekommt eine neue Kennung und merkt nichts.
//
// Die Frist ist trotzdem bewusst grosszuegig (Vorgabe: 60 Tage ohne jede
// Aktivitaet), und geprueft wird die LETZTE Anmeldung, nicht das Anlegedatum.
// Ein Konto, das noch benutzt wird, kann damit nicht erwischt werden.
//
// Nur echte anonyme Konten kommen in Frage: kein Anmeldeanbieter, keine
// E-Mail, keine Telefonnummer. Ein Fahrlehrer-Konto kann so nie getroffen
// werden - genau das waere der Schaden, den es zu vermeiden gilt.
function istAnonymesKonto(nutzer) {
  return (!nutzer.providerData || nutzer.providerData.length === 0)
         && !nutzer.email && !nutzer.phoneNumber
         && !(nutzer.customClaims && Object.keys(nutzer.customClaims).length);
}

async function loescheAlteAnonymeKonten(auth, maxAlterMs, hoechstens = 500, jetzt = Date.now()) {
  let seite, geprueft = 0, geloescht = 0;
  let marke;
  do {
    seite = await auth.listUsers(1000, marke);
    const faellig = [];
    for (const n of seite.users) {
      geprueft++;
      if (!istAnonymesKonto(n)) continue;
      const m = n.metadata || {};
      // lastRefreshTime kann fehlen; dann zaehlt die letzte Anmeldung, sonst
      // das Anlegedatum. Im Zweifel gilt der JUENGSTE Zeitpunkt - lieber ein
      // Konto zu lange behalten als eine laufende Sitzung abschneiden.
      const zeiten = [m.lastRefreshTime, m.lastSignInTime, m.creationTime]
        .filter(Boolean).map(t => new Date(t).getTime()).filter(Number.isFinite);
      if (!zeiten.length) continue;
      if (jetzt - Math.max(...zeiten) < maxAlterMs) continue;
      faellig.push(n.uid);
      if (faellig.length + geloescht >= hoechstens) break;
    }
    for (const uid of faellig) {
      await auth.deleteUser(uid).catch(e => {
        if (e.code !== 'auth/user-not-found') console.warn('Anonymes Konto:', uid, e.message);
      });
      geloescht++;
    }
    marke = seite.pageToken;
  } while (marke && geloescht < hoechstens);
  if (geloescht) {
    console.log(`Alte anonyme Sitzungen entfernt: ${geloescht} von ${geprueft} geprueften Konten.`);
  }
  return geloescht;
}

module.exports = {
  loescheAlle, gehoertNochDemKonto, loescheChatBilderServer,
  loescheZugangscodesMitBildern, loeschUmfang, loescheKontoHart, CHAT_BUCKET,
  repariereFehlendeAblaufdaten, loescheAlteAnonymeKonten, istAnonymesKonto,
};
