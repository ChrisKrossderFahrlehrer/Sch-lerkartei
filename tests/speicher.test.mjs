// Die Speicher-Regeln (storage.rules) fuer die Chat-Fotos des Schuelers.
//
// Warum eine eigene Datei: Die Regeln der Firestore-Seite sind laengst
// geprueft, die Speicher-Seite war bisher nur DURCHDACHT. Sie haengt aber an
// derselben Frage - darf jemand ohne Anmeldung an die Fotos? - und sie ruft
// zusaetzlich ueber firestore.get() in die andere Welt hinein. Genau solche
// Verschraenkungen gehen still kaputt.
//
// Deshalb laeuft dieser Test gegen BEIDE Emulatoren: Die Speicher-Regel liest
// das Zugangscode-Dokument aus Firestore, um Gueltigkeit und Zustaendigkeit
// zu pruefen.
//
// Starten:  cd tests && npm run test:speicher

import {
  initializeTestEnvironment, assertSucceeds, assertFails,
} from '@firebase/rules-unit-testing';
import { doc, setDoc } from 'firebase/firestore';
import { ref, uploadBytes, getBytes, deleteObject } from 'firebase/storage';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const WURZEL = join(dirname(fileURLToPath(import.meta.url)), '..');

const LEHRER      = 'lehrer-uid';      // der zustaendige Fahrlehrer
const FREMD       = 'fremd-uid';
const SUPERADMIN  = 'super-uid';
const CODE        = 'K7M4P2QXR9';      // gueltig
const CODE_ALT    = 'ABGELAUFEN1';     // abgelaufen
const BILD        = `chat-images/${CODE}/foto.jpg`;
const BILD_ALT    = `chat-images/${CODE_ALT}/foto.jpg`;

// Anders als der Firestore-Emulator bedient der Speicher-Emulator NUR das
// Projekt, unter dem er gestartet wurde - ein abweichender projectId laesst
// schon das Ablegen der Testdateien scheitern, und dann schlagen die Tests
// aus dem falschen Grund an. emulators:exec reicht den Namen als
// GCLOUD_PROJECT durch; daran richtet sich der Test aus.
const testEnv = await initializeTestEnvironment({
  projectId: process.env.GCLOUD_PROJECT || 'fahrsync-speicher',
  firestore: { rules: readFileSync(join(WURZEL, 'firestore.rules'), 'utf8'), host: '127.0.0.1', port: 8089 },
  storage:   { rules: readFileSync(join(WURZEL, 'storage.rules'),   'utf8'), host: '127.0.0.1', port: 9199 },
});

const JPEG = new Uint8Array([0xFF, 0xD8, 0xFF, 0xDB, 0x00, 0x43, 0x00, 0xFF, 0xD9]);
const ALS_JPEG = { contentType: 'image/jpeg' };

await testEnv.withSecurityRulesDisabled(async (ctx) => {
  const db = ctx.firestore();
  await setDoc(doc(db, 'users', LEHRER), {
    uid: LEHRER, rolle: 'fahrlehrer', typ: 'fahrlehrer', status: 'aktiv', fahrschuleId: LEHRER,
  });
  await setDoc(doc(db, 'users', SUPERADMIN), {
    uid: SUPERADMIN, rolle: 'superadmin', typ: 'fahrlehrer', status: 'aktiv', fahrschuleId: SUPERADMIN,
  });
  await setDoc(doc(db, 'accessCodes', CODE), {
    code: CODE, teacherUid: LEHRER, studentId: 's1', studentSnapshot: {}, messages: [],
    expiresAt: Date.now() + 365 * 24 * 3600 * 1000,
  });
  await setDoc(doc(db, 'accessCodes', CODE_ALT), {
    code: CODE_ALT, teacherUid: LEHRER, studentId: 's1', studentSnapshot: {}, messages: [],
    expiresAt: Date.now() - 1000,
  });
  // Die Bilder vorab ablegen, damit das Lesen etwas zu lesen hat.
  await uploadBytes(ref(ctx.storage(), BILD), JPEG, ALS_JPEG);
  await uploadBytes(ref(ctx.storage(), BILD_ALT), JPEG, ALS_JPEG);
});

const ohneKonto   = () => testEnv.unauthenticatedContext().storage();
// So sieht die Sitzung des Portals seit Stufe 1 aus.
const alsSchueler = () => testEnv
  .authenticatedContext('anon-schueler', { firebase: { sign_in_provider: 'anonymous' } }).storage();
const als = (uid) => testEnv.authenticatedContext(uid, { email: `${uid}@test.de` }).storage();

let ok = 0, schlecht = 0;
async function pruefe(text, fn) {
  try { await fn(); ok++; console.log('  ✓', text); }
  catch (e) { schlecht++; console.log('  ✗', text, '\n      ->', String(e.message).split('\n')[0]); }
}

// ══════════════════════════════════════════════════════════════════
console.log('\nSTUFE 2 — Chat-Fotos ohne Anmeldung sind zu');

await pruefe('OHNE Anmeldung ein Chat-Foto lesen ist GESPERRT', async () => {
  await assertFails(getBytes(ref(ohneKonto(), BILD)));
});
await pruefe('OHNE Anmeldung ein Foto hochladen ist GESPERRT', async () => {
  await assertFails(uploadBytes(ref(ohneKonto(), `chat-images/${CODE}/untergeschoben.jpg`), JPEG, ALS_JPEG));
});
await pruefe('OHNE Anmeldung ein Foto loeschen ist GESPERRT', async () => {
  await assertFails(deleteObject(ref(ohneKonto(), BILD)));
});

// ══════════════════════════════════════════════════════════════════
console.log('\nGEGENPROBE — der Schueler im Portal darf alles wie bisher');

await pruefe('Schueler liest das Chat-Foto', async () => {
  await assertSucceeds(getBytes(ref(alsSchueler(), BILD)));
});
await pruefe('Schueler laedt ein Foto hoch', async () => {
  await assertSucceeds(uploadBytes(ref(alsSchueler(), `chat-images/${CODE}/neu.jpg`), JPEG, ALS_JPEG));
});

console.log('\nGEGENPROBE — der zustaendige Fahrlehrer darf alles wie bisher');
await pruefe('Zustaendiger Fahrlehrer liest', async () => {
  await assertSucceeds(getBytes(ref(als(LEHRER), BILD)));
});
await pruefe('Zustaendiger Fahrlehrer laedt hoch', async () => {
  await assertSucceeds(uploadBytes(ref(als(LEHRER), `chat-images/${CODE}/vom-lehrer.jpg`), JPEG, ALS_JPEG));
});
await pruefe('Zustaendiger Fahrlehrer kommt auch an den ABGELAUFENEN Code heran', async () => {
  // Wichtig fuer die Loeschpflicht: Nach Ablauf darf er die Bilder noch entfernen.
  await assertSucceeds(getBytes(ref(als(LEHRER), BILD_ALT)));
});

// ══════════════════════════════════════════════════════════════════
console.log('\nWAS WEITERHIN GILT');

await pruefe('Abgelaufener Code: der Schueler kommt NICHT mehr heran', async () => {
  await assertFails(getBytes(ref(alsSchueler(), BILD_ALT)));
});
await pruefe('Fremder Fahrlehrer kommt NICHT an ein Foto eines abgelaufenen Codes', async () => {
  await assertFails(getBytes(ref(als(FREMD), BILD_ALT)));
});
await pruefe('Zu grosse Datei wird abgelehnt (> 8 MB)', async () => {
  const zuGross = new Uint8Array(8 * 1024 * 1024 + 10);
  await assertFails(uploadBytes(ref(alsSchueler(), `chat-images/${CODE}/riesig.jpg`), zuGross, ALS_JPEG));
});
await pruefe('Nicht-Bild wird abgelehnt', async () => {
  await assertFails(uploadBytes(ref(alsSchueler(), `chat-images/${CODE}/schad.pdf`), JPEG,
    { contentType: 'application/pdf' }));
});
await pruefe('Ausserhalb von chat-images geht gar nichts', async () => {
  await assertFails(uploadBytes(ref(alsSchueler(), 'woanders/datei.jpg'), JPEG, ALS_JPEG));
});

console.log(`\n${ok} bestanden, ${schlecht} fehlgeschlagen\n`);
await testEnv.cleanup();
process.exit(schlecht > 0 ? 1 : 0);
