// Nachweis fuer drei Befunde aus dem Sicherheits-Audit.
//
// Diese Datei behauptet nichts, sie PROBIERT es aus. Jeder Test beschreibt
// das Verhalten, das der Angreifer haette - laeuft er durch, existiert die
// Luecke wirklich. Nach dem Schliessen muessen diese Tests umschlagen; die
// erwartete Richtung steht jeweils im Namen.
//
// Starten:  cd tests && npm run test:audit

import {
  initializeTestEnvironment, assertSucceeds, assertFails,
} from '@firebase/rules-unit-testing';
import { doc, getDoc, setDoc, updateDoc, deleteDoc } from 'firebase/firestore';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const REGELN = process.env.REGELN
  || join(dirname(fileURLToPath(import.meta.url)), '..', 'firestore.rules');

const SCHULE  = 'schule-uid';
const LEHRER  = 'lehrer-uid';            // AUSGETRETEN aus der Schule
const LEHRER_IN_SCHULE = 'lehrer2-uid';  // gehoert der Schule weiterhin an
const FREMD   = 'fremder-uid';
const FREMDER_ADMIN = 'fremdadmin-uid';  // Fahrschul-Admin einer ANDEREN Schule
const FREMDE_SCHULE = 'fremdschule-uid';
const CODE     = 'K7M4PQ';              // 6 Zeichen - so lang sind die echten
const IN_EINEM_JAHR = Date.now() + 365 * 24 * 3600 * 1000;

const testEnv = await initializeTestEnvironment({
  projectId: 'fahrsync-audit',
  firestore: {
    rules: readFileSync(REGELN, 'utf8'),
    host: '127.0.0.1',
    port: 8089,
  },
});

await testEnv.withSecurityRulesDisabled(async (ctx) => {
  const db = ctx.firestore();
  await setDoc(doc(db, 'fahrschulen', SCHULE), {
    name: 'Schule', adminUid: SCHULE, typ: 'fahrschule', status: 'aktiv',
    fahrschulCode: 'FS-AAAA', abo: 'free',
  });
  await setDoc(doc(db, 'users', SCHULE), {
    uid: SCHULE, rolle: 'fahrschul-admin', typ: 'fahrschule',
    status: 'aktiv', fahrschuleId: SCHULE,
  });
  // Der Lehrer ist AUSGETRETEN: seine fahrschuleId zeigt wieder auf ihn selbst.
  await setDoc(doc(db, 'users', LEHRER), {
    uid: LEHRER, rolle: 'fahrlehrer', typ: 'fahrlehrer',
    status: 'aktiv', fahrschuleId: LEHRER,
  });
  await setDoc(doc(db, 'users', FREMD), {
    uid: FREMD, rolle: 'fahrlehrer', typ: 'fahrlehrer',
    status: 'aktiv', fahrschuleId: FREMD,
  });
  // Ein zweiter Lehrer, der der Schule weiterhin angehoert
  await setDoc(doc(db, 'users', LEHRER_IN_SCHULE), {
    uid: LEHRER_IN_SCHULE, rolle: 'fahrlehrer', typ: 'fahrlehrer',
    status: 'aktiv', fahrschuleId: SCHULE,
  });
  // Ein Fahrschul-Admin einer VOELLIG ANDEREN Fahrschule
  await setDoc(doc(db, 'fahrschulen', FREMDE_SCHULE), {
    name: 'Andere Schule', adminUid: FREMDER_ADMIN, typ: 'fahrschule', status: 'aktiv',
  });
  await setDoc(doc(db, 'users', FREMDER_ADMIN), {
    uid: FREMDER_ADMIN, rolle: 'fahrschul-admin', typ: 'fahrschule',
    status: 'aktiv', fahrschuleId: FREMDE_SCHULE,
  });
  // Eigener Schueler eines eigenstaendigen Lehrers: fahrschuleId == eigene uid
  await setDoc(doc(db, 'students', 'eigener-schueler'), {
    uid: LEHRER, fahrschuleId: LEHRER, vorname: 'Jonas', nachname: 'Klein',
  });
  // Schueler eines Lehrers, der einer Schule beigetreten ist, aber noch nicht
  // uebernommen hat: fahrschuleId zeigt weiter auf den Lehrer selbst.
  await setDoc(doc(db, 'students', 'noch-nicht-uebernommen'), {
    uid: LEHRER_IN_SCHULE, fahrschuleId: LEHRER_IN_SCHULE,
    vorname: 'Mia', nachname: 'Schulz',
  });
  // Schueler wurde per uebernehmeSchuelerInFahrschule an die Schule uebergeben:
  // fahrschuleId zeigt auf die Schule, uid steht noch auf dem alten Lehrer.
  await setDoc(doc(db, 'students', 'uebernommener-schueler'), {
    uid: LEHRER, fahrschuleId: SCHULE,
    vorname: 'Lena', nachname: 'Mertens', fahrstunden: 24,
    uebernommenVon: LEHRER, uebernommenAm: Date.now(),
  });
  // customFields fuehrt laut Regeldatei NUR 'uid', keine fahrschuleId.
  await setDoc(doc(db, 'customFields', 'feld-ohne-fsid'), {
    uid: LEHRER, name: 'Fuehrerscheinstelle', wert: 'Göppingen',
  });
  await setDoc(doc(db, 'customThemen', 'thema-ohne-fsid'), {
    uid: LEHRER_IN_SCHULE, name: 'Anhaenger rangieren',
  });
  // Protokolleintrag, der bereits der Schule gehoert
  await setDoc(doc(db, 'protokoll', 'eintrag-schule'), {
    uid: LEHRER_IN_SCHULE, fahrschuleId: SCHULE,
    studentId: 'uebernommener-schueler', notiz: 'Autobahn geuebt.',
  });
  // Ein gueltiger Zugangscode, Dokument-ID = Code (so legt die App ihn an)
  await setDoc(doc(db, 'accessCodes', CODE), {
    code: CODE, studentId: 'uebernommener-schueler', teacherUid: LEHRER,
    vorname: 'Lena', nachname: 'Mertens', klasse: 'B', fahrstunden: 24,
    themen: { 'Einparken längs (rückwärts)': 4 },
    messages: [{ text: 'Bis Mittwoch!', sender: 'schueler', timestamp: Date.now() }],
    expiresAt: IN_EINEM_JAHR,
  });
});

const ohneAnmeldung = () => testEnv.unauthenticatedContext().firestore();
const als = (uid) => testEnv.authenticatedContext(uid, { email: `${uid}@test.de` }).firestore();

let bestanden = 0, fehlgeschlagen = 0;
async function pruefe(beschreibung, fn) {
  try { await fn(); bestanden++; console.log('  ✓', beschreibung); }
  catch (e) { fehlgeschlagen++; console.log('  ✗', beschreibung, '\n      ->', String(e.message).split('\n')[0]); }
}

// Das Schueler-Portal meldet sich seit Stufe 1 still an, bevor es liest.
// So sieht seine Sitzung aus: angemeldet, aber ohne Nutzerdokument.
const alsSchuelerSitzung = () => testEnv
  .authenticatedContext('anon-schueler', { firebase: { sign_in_provider: 'anonymous' } })
  .firestore();

// ══════════════════════════════════════════════════════════════════
// BEFUND 1 (behoben, Stufe 2) — Der Zugriff ganz OHNE Anmeldung ist zu.
//
// Bis hierher waren diese beiden Tests umgekehrt formuliert: Sie wiesen nach,
// dass das Lesen und Schreiben OHNE jedes Konto moeglich war. Genau das war
// der Befund. Schliessen liess er sich erst, nachdem das Portal sich in
// Stufe 1 anmeldet, bevor es zugreift - vorher waere jeder Schueler
// ausgesperrt gewesen.
console.log('\nBEFUND 1 (behoben) — Zugangscode-Dokument braucht jetzt eine Anmeldung');

await pruefe('OHNE Anmeldung die Schuelerakte lesen ist GESPERRT', async () => {
  await assertFails(getDoc(doc(ohneAnmeldung(), 'accessCodes', CODE)));
});

await pruefe('OHNE Anmeldung in den Chat schreiben ist GESPERRT', async () => {
  await assertFails(updateDoc(doc(ohneAnmeldung(), 'accessCodes', CODE), {
    messages: [{ text: 'Untergeschobene Nachricht', sender: 'schueler', timestamp: Date.now() }],
  }));
});

// ── Die Gegenprobe: der Schueler darf weiterhin ALLES, was er braucht ──
console.log('\n  Gegenprobe - die Sitzung des Portals (angemeldet, ohne Nutzerdokument)');

await pruefe('  Schueler liest seine Akte', async () => {
  const snap = await assertSucceeds(getDoc(doc(alsSchuelerSitzung(), 'accessCodes', CODE)));
  if (snap.data().nachname !== 'Mertens') throw new Error('Daten kamen nicht durch');
});
await pruefe('  Schueler schreibt eine Chatnachricht', async () => {
  await assertSucceeds(updateDoc(doc(alsSchuelerSitzung(), 'accessCodes', CODE), {
    messages: [{ text: 'Bin da!', sender: 'schueler', timestamp: Date.now() }],
  }));
});
await pruefe('  Schueler setzt seinen Lesestand', async () => {
  await assertSucceeds(updateDoc(doc(alsSchuelerSitzung(), 'accessCodes', CODE), { studentLastRead: Date.now() }));
});
await pruefe('  Schueler hakt ein Lernziel ab', async () => {
  await assertSucceeds(updateDoc(doc(alsSchuelerSitzung(), 'accessCodes', CODE), {
    lernziele: [{ text: 'Einparken üben', erledigt: true }],
  }));
});
await pruefe('  Schueler sagt eine geplante Fahrstunde zu', async () => {
  await assertSucceeds(updateDoc(doc(alsSchuelerSitzung(), 'accessCodes', CODE), {
    plannedLessons: [{ id: '1', status: 'bestaetigt', respondedAt: Date.now() }],
  }));
});
await pruefe('  Schueler kann NICHT die Laufzeit verlaengern', async () => {
  await assertFails(updateDoc(doc(alsSchuelerSitzung(), 'accessCodes', CODE), { expiresAt: IN_EINEM_JAHR * 2 }));
});
await pruefe('  Schueler kann die Akte NICHT loeschen', async () => {
  await assertFails(deleteDoc(doc(alsSchuelerSitzung(), 'accessCodes', CODE)));
});

// Ehrlich benannt, statt verschwiegen: isAuth() haelt niemanden auf, der sich
// selbst eine anonyme Sitzung besorgt - der oeffentliche API-Schluessel steht
// im HTML, das ist normal. Die eigentliche Huerde bleibt die Code-Laenge
// (32^10) samt Bremse auf findeAltenZugangscode; App Check kann jetzt
// zusaetzlich greifen.
await pruefe('BEKANNTE GRENZE: ein fremder ANGEMELDETER Fahrlehrer kommt weiter durch,'
           + '\n      wenn er die Kennung kennt', async () => {
  await assertSucceeds(getDoc(doc(als(FREMD), 'accessCodes', CODE)));
});

// ══════════════════════════════════════════════════════════════════
// BEHOBEN: der uid-Zweig in docBelongsToUser gilt nur noch, solange der
// Datensatz dem Lehrer selbst oder seiner AKTUELLEN Fahrschule gehoert.
console.log('\nBEFUND 2 (behoben) — Ausgetretener Lehrer ist ausgesperrt');

await pruefe('Ausgetretener Lehrer darf den Schueler der Schule NICHT mehr lesen', async () => {
  const db = als(LEHRER);
  await assertFails(getDoc(doc(db, 'students', 'uebernommener-schueler')));
});

await pruefe('Ausgetretener Lehrer darf den Schueler der Schule NICHT mehr aendern', async () => {
  const db = als(LEHRER);
  await assertFails(updateDoc(doc(db, 'students', 'uebernommener-schueler'), { fahrstunden: 99 }));
});

await pruefe('Ausgetretener Lehrer darf den Schueler der Schule NICHT loeschen', async () => {
  const db = als(LEHRER);
  await assertFails(deleteDoc(doc(db, 'students', 'uebernommener-schueler')));
});

// ══════════════════════════════════════════════════════════════════
// Die Gegenprobe zur Verschaerfung: Sie darf niemanden aussperren, der
// rechtmaessig zugreift. Besonders heikel ist der Lehrer, der einer Schule
// beigetreten ist, dessen Schueler aber noch NICHT uebernommen wurden -
// deren fahrschuleId zeigt weiter auf ihn selbst.
console.log('\nGEGENPROBE zur Verschaerfung — niemand darf ausgesperrt werden');

await pruefe('Eigenstaendiger Lehrer sieht seinen eigenen Schueler', async () => {
  const db = als(LEHRER);
  await assertSucceeds(getDoc(doc(db, 'students', 'eigener-schueler')));
});

await pruefe('Lehrer IN einer Schule sieht seinen noch nicht uebernommenen Schueler', async () => {
  const db = als(LEHRER_IN_SCHULE);
  await assertSucceeds(getDoc(doc(db, 'students', 'noch-nicht-uebernommen')));
});

await pruefe('Lehrer IN einer Schule sieht den uebernommenen Schueler der Schule', async () => {
  const db = als(LEHRER_IN_SCHULE);
  await assertSucceeds(getDoc(doc(db, 'students', 'uebernommener-schueler')));
});

await pruefe('Die Fahrschule selbst sieht den uebernommenen Schueler', async () => {
  const db = als(SCHULE);
  await assertSucceeds(getDoc(doc(db, 'students', 'uebernommener-schueler')));
});

// docBelongsToUser gilt auch fuer customFields/customThemen/customGruppen.
// customFields fuehrt laut Regeldatei NUR ein uid-Feld, gar keine
// fahrschuleId - ohne den Vorgabewert in eigenerDatensatz() waeren damit
// alle eigenen Felder unsichtbar geworden.
await pruefe('Eigenes Zusatzfeld OHNE fahrschuleId bleibt lesbar', async () => {
  const db = als(LEHRER);
  await assertSucceeds(getDoc(doc(db, 'customFields', 'feld-ohne-fsid')));
});

await pruefe('Eigenes Thema OHNE fahrschuleId bleibt lesbar', async () => {
  const db = als(LEHRER_IN_SCHULE);
  await assertSucceeds(getDoc(doc(db, 'customThemen', 'thema-ohne-fsid')));
});

await pruefe('Eigener Protokolleintrag der aktuellen Schule bleibt lesbar', async () => {
  const db = als(LEHRER_IN_SCHULE);
  await assertSucceeds(getDoc(doc(db, 'protokoll', 'eintrag-schule')));
});

// ══════════════════════════════════════════════════════════════════
console.log('\nGEGENPROBE — was korrekt blockiert ist');

await pruefe('Ein voellig Fremder kommt NICHT an die Schuelerakte (students)', async () => {
  const db = als(FREMD);
  await assertFails(getDoc(doc(db, 'students', 'uebernommener-schueler')));
});

await pruefe('Ohne Anmeldung NICHT an die Schuelerakte (students)', async () => {
  const db = ohneAnmeldung();
  await assertFails(getDoc(doc(db, 'students', 'uebernommener-schueler')));
});

// ══════════════════════════════════════════════════════════════════
// BEFUND 3 (behoben) — Beim Loeschen von users fehlte die Zugehoerigkeit.
// "isFsAdmin()" prueft allein "ist irgendein Fahrschul-Admin". Lesen und
// Aendern verlangen zusaetzlich resource.data.fahrschuleId == userFsId(),
// beim Loeschen fehlte das - jeder Fahrschul-Admin konnte das Nutzerprofil
// JEDES Kontos im System loeschen. Wer sein users-Dokument verliert, kommt
// an nichts mehr heran: eine Aussperrung per Mausklick, aus einer fremden
// Fahrschule heraus.
console.log('\nBEFUND 3 (behoben) — Fremder Fahrschul-Admin sperrt niemanden aus');

await pruefe('Fremder Fahrschul-Admin darf ein fremdes Nutzerprofil NICHT loeschen', async () => {
  const db = als(FREMDER_ADMIN);
  await assertFails(deleteDoc(doc(db, 'users', LEHRER_IN_SCHULE)));
});

await pruefe('Fremder Fahrschul-Admin darf das Profil der fremden Schule NICHT loeschen', async () => {
  const db = als(FREMDER_ADMIN);
  await assertFails(deleteDoc(doc(db, 'users', SCHULE)));
});

await pruefe('Der EIGENE Fahrschul-Admin darf sein Mitglied weiterhin loeschen', async () => {
  const db = als(SCHULE);
  await assertSucceeds(deleteDoc(doc(db, 'users', LEHRER_IN_SCHULE)));
});

console.log(`\n${bestanden} nachgewiesen, ${fehlgeschlagen} nicht nachweisbar\n`);
await testEnv.cleanup();
process.exit(fehlgeschlagen > 0 ? 1 : 0);
