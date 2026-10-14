// werkzeug/webhooks-einrichten.mjs: Die Ereignis-Liste darf nur WACHSEN.
//
// Das Skript ersetzt bei PayPal die komplette Ereignis-Liste des Webhooks
// (die Schnittstelle kennt nur "replace"). Ginge dabei ein bestehendes
// Ereignis verloren - etwa PAYMENT.SALE.COMPLETED -, entstuenden still keine
// Folgerechnungen mehr. Deshalb hier ohne Netz geprueft: Alles Vorhandene
// bleibt, in derselben Reihenfolge, und es kommt nur das Fehlende dazu.
// Ausserdem: Was das Skript ergaenzt, muss das Backend auch auswerten.
//
// Starten:  cd tests && node webhooks.test.mjs

import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import {
  ergaenzen, PAYPAL_PFLICHT, PAYPAL_BISHER, STRIPE_PFLICHT, STRIPE_BISHER,
} from '../werkzeug/webhooks-einrichten.mjs';

let n = 0;
const ok = (name, f) => { f(); n++; console.log('  ✓', name); };

console.log('webhooks.test.mjs');

ok('nichts vorhanden -> alle Pflicht-Ereignisse', () => {
  const r = ergaenzen([], PAYPAL_PFLICHT);
  assert.deepEqual(r.neu, PAYPAL_PFLICHT);
  assert.deepEqual(r.fehlend, PAYPAL_PFLICHT);
});

ok('Vorhandenes bleibt vollstaendig und vorne', () => {
  const vorher = ['PAYMENT.SALE.COMPLETED', 'BILLING.SUBSCRIPTION.CANCELLED', 'IRGENDWAS.ANDERES'];
  const r = ergaenzen(vorher, PAYPAL_PFLICHT);
  assert.deepEqual(r.neu.slice(0, vorher.length), vorher);
  assert.ok(!r.fehlend.includes('BILLING.SUBSCRIPTION.CANCELLED'));
  for (const e of PAYPAL_PFLICHT) assert.ok(r.neu.includes(e), e);
  assert.equal(new Set(r.neu).size, r.neu.length, 'keine Doppelten');
});

ok('alles da -> nichts fehlt, Liste unveraendert', () => {
  const vorher = [...STRIPE_BISHER, ...STRIPE_PFLICHT];
  const r = ergaenzen(vorher, STRIPE_PFLICHT);
  assert.deepEqual(r.fehlend, []);
  assert.deepEqual(r.neu, vorher);
});

ok('"*" (alle Ereignisse) -> nichts ergaenzen', () => {
  const r = ergaenzen(['*'], STRIPE_PFLICHT);
  assert.deepEqual(r.fehlend, []);
  assert.deepEqual(r.neu, ['*']);
});

ok('jedes Ereignis, das das Skript kennt, wertet das Backend aus', () => {
  const index = readFileSync(new URL('../functions/index.js', import.meta.url), 'utf8');
  for (const e of [...PAYPAL_PFLICHT, ...PAYPAL_BISHER, ...STRIPE_PFLICHT, ...STRIPE_BISHER]) {
    assert.ok(index.includes(`'${e}'`), `${e} kommt in functions/index.js nicht vor`);
  }
});

console.log(`${n} Pruefungen bestanden`);
