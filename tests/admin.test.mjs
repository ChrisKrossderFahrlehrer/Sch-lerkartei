// Die firebase-admin-Schnittstelle, auf der die Functions aufsitzen.
//
// Warum eigens geprueft: Mit Version 14 hat firebase-admin die alte
// Namensraum-Form entfernt - admin.firestore(), admin.auth(),
// admin.storage(), admin.messaging() gibt es nicht mehr. Der Umstieg
// betraf 60 Aufrufstellen.
//
// Die Emulator-Suite deckt davon viel ab, aber nicht alles: Der Push-Versand,
// FieldValue.delete() und Timestamp.fromMillis() werden dort nie angefasst.
// Genau solche Stellen tun bei einem Namensraum-Umstieg still das Falsche -
// kein Fehler beim Laden, kein Fehler im Test, sondern erst beim Nutzer.
//
// WAS DIESER TEST NICHT LEISTET - nachgemessen, nicht vermutet:
// Ein Rueckfall auf admin.firestore() INNERHALB eines Funktionsrumpfs faellt
// hier NICHT auf. Das Laden gelingt weiterhin; der Fehler entsteht erst beim
// Aufruf. Gegengeprobt: Rueckfall in loeschen.js eingebaut -> dieser Test
// blieb gruen, tests/loeschen.test.mjs meldete "TypeError: admin.firestore
// is not a function". Die Emulator-Suite ist dafuer zustaendig, dieser Test
// fuer die Schnittstelle selbst.
//
// Dieser Test braucht keinen Emulator und laeuft in Sekunden.
//
// Starten:  cd tests && npm run test:admin

import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const hier = dirname(fileURLToPath(import.meta.url));

// Aus functions/ heraus aufloesen: Geprueft werden soll GENAU die Fassung,
// die auch deployt wird. Ueber die package.json verankert und nicht ueber
// einen zusammengesetzten Dateipfad - seit Version 14 gibt firebase-admin
// seine Unterpfade ueber die "exports"-Tabelle frei, und die greift nur bei
// Paketnamen.
const ausFunctions = createRequire(join(hier, '..', 'functions', 'package.json'));

// Nichts soll hinausgehen: Firestore auf einen toten Port, damit ein
// versehentlicher Zugriff sofort scheitert statt die echte Datenbank zu
// erreichen.
process.env.GCLOUD_PROJECT = 'fahrsync-admin-test';
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:9';

const { initializeApp } = ausFunctions('firebase-admin/app');
const { getFirestore, FieldValue, Timestamp } = ausFunctions('firebase-admin/firestore');
const { getAuth } = ausFunctions('firebase-admin/auth');
const { getStorage } = ausFunctions('firebase-admin/storage');
const { getMessaging } = ausFunctions('firebase-admin/messaging');

initializeApp({ projectId: 'fahrsync-admin-test',
                storageBucket: 'fahrschule-ebc65-eu-storage' });

let ok = 0, schlecht = 0;
const pruefe = (text, bedingung, zusatz) => {
  if (bedingung) { ok++; console.log('  ✓', text, zusatz ?? ''); }
  else { schlecht++; console.log('  ✗', text, zusatz ?? ''); }
};

// Die Versionsnummer direkt aus der Datei lesen: Die "exports"-Tabelle von
// firebase-admin gibt './package.json' nicht frei - ein require darauf
// scheitert. (Genau darueber ist dieser Test beim Schreiben selbst
// gestolpert.)
const fassung = JSON.parse(readFileSync(
  join(hier, '..', 'functions', 'node_modules', 'firebase-admin', 'package.json'), 'utf8'));

console.log('\nZUGRIFFSFUNKTIONEN — gibt es sie, und liefern sie das Richtige?');

pruefe('getFirestore() liefert eine Datenbank',
  typeof getFirestore().collection === 'function');
pruefe('getAuth() liefert deleteUser und listUsers',
  typeof getAuth().deleteUser === 'function' && typeof getAuth().listUsers === 'function');
pruefe('getStorage().bucket() liefert deleteFiles',
  typeof getStorage().bucket('fahrschule-ebc65-eu-storage').deleteFiles === 'function');
pruefe('getMessaging() liefert send',
  typeof getMessaging().send === 'function');

console.log('\nWERT-HILFEN — die von der Emulator-Suite nicht beruehrt werden');

// Wird beim Aufraeumen entfernter ADK-Themen gebraucht. Ein falscher Wert
// hier wuerde das Feld nicht loeschen, sondern ueberschreiben.
const loeschAnweisung = FieldValue.delete();
pruefe('FieldValue.delete() liefert eine Loesch-Anweisung',
  loeschAnweisung != null && typeof loeschAnweisung === 'object',
  '(' + (loeschAnweisung?.constructor?.name ?? typeof loeschAnweisung) + ')');
pruefe('...und keine schlichte Zeichenkette oder Zahl',
  typeof loeschAnweisung !== 'string' && typeof loeschAnweisung !== 'number');

// Wird beim taeglichen Aufraeumen gebraucht. Vergleicht man mit dem
// falschen Typ, liefert Firestore stillschweigend KEINE Treffer.
const millis = Date.UTC(2026, 0, 15, 12, 0, 0);
const ts = Timestamp.fromMillis(millis);
pruefe('Timestamp.fromMillis() rechnet richtig',
  ts.toMillis() === millis, ts.toDate().toISOString());
pruefe('Timestamp hat toDate()', typeof ts.toDate === 'function');
pruefe('Timestamp.now() liefert einen Timestamp',
  typeof Timestamp.now().toMillis === 'function');

console.log('\nDIE ALTE FORM IST WIRKLICH WEG');
// Absicherung gegen ein Zurueckrutschen: Sollte jemand wieder
// admin.firestore() schreiben, faellt es hier auf und nicht erst im Deploy.
const admin = ausFunctions('firebase-admin');
pruefe('admin.firestore() gibt es nicht mehr', typeof admin.firestore !== 'function');
pruefe('admin.auth() gibt es nicht mehr', typeof admin.auth !== 'function');
pruefe('admin.storage() gibt es nicht mehr', typeof admin.storage !== 'function');
pruefe('admin.messaging() gibt es nicht mehr', typeof admin.messaging !== 'function');
pruefe('initializeApp gibt es weiterhin am Standard-Export',
  typeof admin.initializeApp === 'function');

console.log('\nDIE FUNCTIONS LADEN — wie beim Deployen');
// firebase-tools laedt beim Deployen das Modul, um die enthaltenen Functions
// zu ermitteln. Scheitert das, scheitert der Deploy.
//
// Bewusst in einem EIGENEN Prozess: index.js ruft selbst initializeApp(),
// und zweimal initialisieren mit unterschiedlicher Konfiguration wirft
// ("app named [DEFAULT] already exists"). Der eigene Prozess bildet
// ausserdem genauer ab, was beim Deployen wirklich passiert.
let gefunden = [], ladeFehler = null;
try {
  const ausgabe = execFileSync(process.execPath, ['-e', `
    const m = require('./index.js');
    process.stdout.write(JSON.stringify(Object.keys(m)));
  `], {
    cwd: join(hier, '..', 'functions'),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env,
      GCLOUD_PROJECT: 'fahrsync-admin-test',
      FIREBASE_CONFIG: JSON.stringify({
        projectId: 'fahrsync-admin-test',
        storageBucket: 'fahrschule-ebc65-eu-storage',
      }),
      // Toter Port: Ein versehentlicher Zugriff scheitert sofort, statt
      // die echte Datenbank zu erreichen.
      FIRESTORE_EMULATOR_HOST: '127.0.0.1:9',
    },
  });
  gefunden = JSON.parse(ausgabe);
} catch (e) {
  ladeFehler = String((e.stderr || e.message) || '').split('\n').filter(Boolean).slice(-2).join(' | ');
}
pruefe('index.js laedt und gibt die Functions frei',
  gefunden.length >= 17, ladeFehler ? '-> ' + ladeFehler.slice(0, 120) : `(${gefunden.length} gefunden)`);

console.log(`\n${ok} bestanden, ${schlecht} fehlgeschlagen`);
console.log(`(firebase-admin ${fassung.version})\n`);
process.exit(schlecht > 0 ? 1 : 0);
