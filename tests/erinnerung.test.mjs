// Fahrstunden-Erinnerung (functions/erinnerung.js) - ohne Emulator, mit
// einer kleinen Firestore-Attrappe.
//
// Starten:  cd tests && node erinnerung.test.mjs

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const e = require('../functions/erinnerung.js');

let ok = 0, schlecht = 0;
function pruefe(name, fn) {
  return Promise.resolve().then(fn)
    .then(() => { ok++; console.log('  ✓', name); })
    .catch(err => { schlecht++; console.log('  ✗', name, '\n      ->', err.message); });
}
const gleich = (ist, soll, was) => {
  if (JSON.stringify(ist) !== JSON.stringify(soll)) throw new Error(`${was}: ${JSON.stringify(ist)} statt ${JSON.stringify(soll)}`);
};
const iso = (ms) => new Date(ms).toISOString();

console.log('\nZEITUMRECHNUNG (Europe/Berlin)');
await pruefe('Winterzeit', () => gleich(iso(e.berlinZuMs('2026-11-03', '14:30')), '2026-11-03T13:30:00.000Z', '14:30'));
await pruefe('Sommerzeit', () => gleich(iso(e.berlinZuMs('2026-07-03', '14:30')), '2026-07-03T12:30:00.000Z', '14:30'));
await pruefe('Tag der Umstellung im Herbst, vor 2 Uhr', () => gleich(iso(e.berlinZuMs('2026-10-25', '01:30')), '2026-10-24T23:30:00.000Z', '01:30'));
await pruefe('Tag der Umstellung im Fruehjahr, vor 2 Uhr', () => gleich(iso(e.berlinZuMs('2027-03-28', '01:30')), '2027-03-28T00:30:00.000Z', '01:30'));
await pruefe('Ungueltige Eingaben -> null', () => {
  gleich(e.berlinZuMs('3.11.2026', '14:30'), null, 'Datum');
  gleich(e.berlinZuMs('2026-11-03', ''), null, 'Uhrzeit');
});

console.log('\nZEITFENSTER (30 bis 120 Minuten vorher)');
const T = Date.UTC(2026, 10, 3, 11, 40); // 12:40 Berlin
const L = [
  { id: 'a', datum: '2026-11-03', uhrzeit: '14:30' },                     // 110 min -> ja
  { id: 'b', datum: '2026-11-03', uhrzeit: '15:00' },                     // 140 min -> noch nicht
  { id: 'c', datum: '2026-11-03', uhrzeit: '13:30' },                     // 50 min (Lauf verpasst) -> ja
  { id: 'd', datum: '2026-11-03', uhrzeit: '13:05' },                     // 25 min -> zu knapp
  { id: 'e', datum: '2026-11-03', uhrzeit: '14:30', status: 'abgesagt' }, // abgesagt
  { id: 'f', datum: '2026-11-03' },                                       // ohne Uhrzeit
  { id: 'x"<', datum: '2026-11-03', uhrzeit: '14:00' },                   // kaputte ID
];
await pruefe('nur passende Stunden', () => gleich(e.faelligeStunden(L, T).map(x => x.id), ['a', 'c'], 'faellig'));
await pruefe('kein Treffpunkt im Text (Sperrbildschirm)', () => {
  const t = e.erinnerungsText({ datum: '2026-11-03', uhrzeit: '14:30', ort: 'Musterweg 5' }, T);
  gleich(t.body.includes('Musterweg'), false, 'Adresse im Text');
  gleich(t.body, 'Heute um 14:30 Uhr. Bis gleich!', 'Text');
});
await pruefe('Marke enthaelt Datum und Uhrzeit (Verschieben -> neue Erinnerung)', () => {
  const a = e.markenId('C', { id: '1', datum: '2026-11-03', uhrzeit: '14:30' });
  const b = e.markenId('C', { id: '1', datum: '2026-11-03', uhrzeit: '16:00' });
  if (a === b) throw new Error('gleiche Marke');
});

console.log('\nLAUF MIT ATTRAPPE');
function attrappe(codes, tokens) {
  const marken = new Map();
  const db = {
    collection(name) {
      return {
        where(feld, op, wert) {
          return {
            async get() {
              if (name === 'fcmTokens') return { docs: tokens.filter(t => t[feld] === wert).map(t => ({ get: (k) => t[k] })) };
              return { empty: true, docs: [] };
            },
            limit() { return this; },
          };
        },
        doc(id) {
          if (name === 'accessCodes') {
            const c = codes[id];
            return { async get() { return { exists: !!c, get: (k) => c && c[k] }; } };
          }
          return {
            async create(daten) {
              if (marken.has(id)) { const err = new Error('ALREADY_EXISTS'); err.code = 6; throw err; }
              marken.set(id, daten);
            },
            async delete() { marken.delete(id); },
          };
        },
      };
    },
    batch() { return { delete() {}, async commit() {} }; },
  };
  return { db, marken };
}
const codes = {
  C1: { expiresAt: T + 86400000, plannedLessons: [{ id: '1', datum: '2026-11-03', uhrzeit: '14:30' }] },
  C2: { expiresAt: T - 1, plannedLessons: [{ id: '1', datum: '2026-11-03', uhrzeit: '14:30' }] },   // abgelaufen
};
const tokens = [
  { rolle: 'schueler', codeId: 'C1' }, { rolle: 'schueler', codeId: 'C1' }, // zwei Geraete
  { rolle: 'schueler', codeId: 'C2' }, { rolle: 'fahrlehrer' },
];
await pruefe('ein Push je Stunde, abgelaufene Codes nicht', async () => {
  const { db } = attrappe(codes, tokens);
  const gesendet = [];
  const n = await e.erinnerungenSenden(db, async (c) => gesendet.push(c), T);
  gleich(n, 1, 'Anzahl');
  gleich(gesendet, ['C1'], 'Empfaenger');
});
await pruefe('zweiter Lauf schickt nichts doppelt', async () => {
  const { db } = attrappe(codes, tokens);
  await e.erinnerungenSenden(db, async () => {}, T);
  const n = await e.erinnerungenSenden(db, async () => {}, T + 30 * 60000);
  gleich(n, 0, 'Anzahl im zweiten Lauf');
});
await pruefe('gescheiterter Push wird im naechsten Lauf wiederholt', async () => {
  const { db } = attrappe(codes, tokens);
  await e.erinnerungenSenden(db, async () => { throw new Error('Netz weg'); }, T);
  const n = await e.erinnerungenSenden(db, async () => {}, T + 30 * 60000);
  gleich(n, 1, 'Anzahl im zweiten Lauf');
});

console.log(`\n${ok} bestanden, ${schlecht} fehlgeschlagen\n`);
process.exit(schlecht ? 1 : 0);
