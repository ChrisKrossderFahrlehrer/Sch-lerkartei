// Prueft die Umzugs-Logik der Cloud Function uebernehmeSchuelerInFahrschule.
//
// Geprueft wird, WAS umgezogen wird: die richtigen Feldnamen je Sammlung, dass
// der Lernstand mitkommt, dass bereits zugeordnete Daten in Ruhe gelassen
// werden - und vor allem, dass FREMDE Daten niemals mitwandern.
//
// Ehrlich dazugesagt: Die Abfragen sind hier nachgebaut, nicht die Funktion
// selbst aufgerufen - dafuer braeuchte es zusaetzlich den Functions-Emulator.
// Die entscheidende Frage "gehoert das noch mir?" beantwortet aber das ECHTE
// Modul (functions/loeschen.js), und die Form der Abfrage wird unten gegen den
// Quelltext geprueft - der Nachbau kann also nicht unbemerkt auseinanderlaufen.
// Die Zugangspruefungen der Funktion (angemeldet, kein Gastkonto, gehoert zu
// einer Schule, von der Schule freigeschaltet) deckt dieser Test also nicht ab.
// Sie sind allerdings auch nicht die gefaehrliche Stelle: Die Abfragen sind
// fest auf die eigene Kennung verdrahtet, im schlimmsten Fall verschiebt
// jemand also seine EIGENEN Daten in seine EIGENE Schule.
import { initializeTestEnvironment } from '@firebase/rules-unit-testing';
import { doc, setDoc, getDocs, getDoc, query, collection, where, writeBatch } from 'firebase/firestore';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const require = createRequire(import.meta.url);
// Pfade relativ zu DIESER Datei, nicht fest eingetragen. Hier standen drei
// absolute Pfade des Rechners, auf dem der Test entstanden ist. Auf jedem
// anderen Rechner - und im Ablauf unter .github/workflows - bricht das mit
// "Cannot find module" ab. Aufgefallen ist es erst im ersten CI-Lauf: Auf
// dem Ursprungsrechner gibt es das Verzeichnis ja.
const hier = dirname(fileURLToPath(import.meta.url));
const WURZEL = join(hier, '..');

const { gehoertNochDemKonto } = require(join(WURZEL, 'functions', 'loeschen.js'));
const QUELLE = readFileSync(join(WURZEL, 'functions', 'index.js'), 'utf8');

const env = await initializeTestEnvironment({ projectId:'uebernahme', firestore:{
  rules: readFileSync(join(WURZEL, 'firestore.rules'), 'utf8'), host:'127.0.0.1', port:8089 }});
const SCHULE='schule-uid', LEHRER='lehrer-uid', FREMD='fremd-uid';
// Alles in EINEM Block: Der Admin-Zugang wird geschlossen, sobald der
// Rueckruf endet - danach ist die Verbindung tot.
await env.withSecurityRulesDisabled(async (ctx)=>{
const db = ctx.firestore();
  await setDoc(doc(db,'users',LEHRER),{uid:LEHRER,rolle:'fahrlehrer',status:'aktiv',fahrschuleId:SCHULE});
  await setDoc(doc(db,'fahrschulen',SCHULE),{name:'Schule',adminUid:SCHULE,status:'aktiv'});
  await setDoc(doc(db,'students','a1'),{uid:LEHRER,fahrschuleId:LEHRER,vorname:'Alt',themen:{Anfahren:4}});
  await setDoc(doc(db,'students','a2'),{uid:LEHRER,fahrschuleId:LEHRER,vorname:'Alt2'});
  await setDoc(doc(db,'customThemen','ct1'),{uid:LEHRER,fahrschuleId:LEHRER,name:'Kreisverkehr'});
  await setDoc(doc(db,'protokoll','p1'),{uid:LEHRER,fahrschuleId:LEHRER,text:'Notiz'});
  await setDoc(doc(db,'slots','sl1'),{lehrerUid:LEHRER,schoolId:LEHRER,start:'10:00'});
  await setDoc(doc(db,'schueler','ks1'),{lehrerUid:LEHRER,schoolId:LEHRER,name:'Kalender-Schueler'});
  await setDoc(doc(db,'students','neu1'),{uid:LEHRER,fahrschuleId:SCHULE,vorname:'Neu'});
  await setDoc(doc(db,'students','f1'),{uid:FREMD,fahrschuleId:FREMD,vorname:'Fremd'});
  await setDoc(doc(db,'slots','fsl1'),{lehrerUid:FREMD,schoolId:FREMD,start:'12:00'});
  // Altbestand aus der Zeit vor der Fahrschul-Funktion: GAR KEINE
  // fahrschuleId. Eine Gleichheitsabfrage findet so etwas nicht - genau
  // daran ist die alte Fassung vorbeigelaufen.
  await setDoc(doc(db,'students','alt-ohne-feld'),{uid:LEHRER,vorname:'Altbestand'});
  await setDoc(doc(db,'protokoll','p-ohne-feld'),{uid:LEHRER,text:'Alte Notiz'});
  // pruefungen fuehrt den Erfasser als 'eingetragenVon', nicht als lehrerUid.
  await setDoc(doc(db,'pruefungen','pr1'),{schuelerId:'a1',eingetragenVon:LEHRER,schoolId:LEHRER,datum:'2026-03-01'});
  await setDoc(doc(db,'pruefungen','pr-fremd'),{schuelerId:'f1',eingetragenVon:FREMD,schoolId:FREMD,datum:'2026-03-02'});

const jetzt = Date.now();
const erg = {};
async function umhaengen(samm, besitzer, zuordnung, z) {
  const snap = await getDocs(query(collection(db,samm), where(besitzer,'==',LEHRER)));
  const meine = snap.docs.filter(gehoertNochDemKonto(LEHRER, zuordnung));
  for (let i=0; i<meine.length; i+=400) {
    const b = writeBatch(db);
    meine.slice(i,i+400).forEach(d => b.update(d.ref,{[zuordnung]:SCHULE, uebernommenVon:LEHRER, uebernommenAm:jetzt}));
    await b.commit();
  }
  erg[z] = meine.length;
}
await umhaengen('students','uid','fahrschuleId','schueler');
await umhaengen('customThemen','uid','fahrschuleId','themen');
await umhaengen('protokoll','uid','fahrschuleId','protokoll');
await umhaengen('slots','lehrerUid','schoolId','termine');
await umhaengen('schueler','lehrerUid','schoolId','kalenderSchueler');
await umhaengen('pruefungen','eingetragenVon','schoolId','pruefungen');

let ok=0, bad=0;
async function p(t,f){ try{ await f(); ok++; console.log('  OK  ',t); } catch(e){ bad++; console.log('  FEHL',t,'->',e.message); } }

console.log('\nUEBERNAHME IN DIE FAHRSCHULE');
console.log('  gezaehlt:', JSON.stringify(erg));
await p('Beide Alt-Schueler gehoeren jetzt der Schule', async()=>{
  for (const id of ['a1','a2']) {
    const d = await getDoc(doc(db,'students',id));
    if (d.data().fahrschuleId !== SCHULE) throw new Error(id+' nicht umgehaengt');
  }
});
await p('Der Lernstand (ADK) ist unveraendert mitgekommen', async()=>{
  const d = await getDoc(doc(db,'students','a1'));
  if (!d.data().themen || d.data().themen.Anfahren !== 4) throw new Error('themen verloren');
});
await p('Herkunft ist vermerkt (uebernommenVon)', async()=>{
  const d = await getDoc(doc(db,'students','a1'));
  if (d.data().uebernommenVon !== LEHRER) throw new Error('kein Vermerk');
});
await p('Kalender-Termin und Kalender-Schueler sind mitgewandert', async()=>{
  const s = await getDoc(doc(db,'slots','sl1'));
  if (s.data().schoolId !== SCHULE) throw new Error('slot nicht umgehaengt');
  const k = await getDoc(doc(db,'schueler','ks1'));
  if (k.data().schoolId !== SCHULE) throw new Error('kalender-schueler nicht umgehaengt');
});
await p('Schon zugeordneter Schueler wurde NICHT erneut angefasst', async()=>{
  const d = await getDoc(doc(db,'students','neu1'));
  if (d.data().uebernommenVon) throw new Error('unnoetig angefasst');
});
await p('FREMDE Daten blieben unberuehrt', async()=>{
  const f = await getDoc(doc(db,'students','f1'));
  if (f.data().fahrschuleId !== FREMD) throw new Error('fremder Schueler verschoben!');
  const fs = await getDoc(doc(db,'slots','fsl1'));
  if (fs.data().schoolId !== FREMD) throw new Error('fremder Termin verschoben!');
});
await p('Die Fahrschule sieht jetzt 4 Schueler (inkl. Altbestand)', async()=>{
  const s = await getDocs(query(collection(db,'students'), where('fahrschuleId','==',SCHULE)));
  if (s.size !== 4) throw new Error('statt 4: '+s.size);
});
await p('Altbestand OHNE fahrschuleId kommt MIT', async()=>{
  const d = await getDoc(doc(db,'students','alt-ohne-feld'));
  if (d.data().fahrschuleId !== SCHULE) throw new Error('Altbestand blieb liegen - die Schule bekaeme ihn nie');
  const pr = await getDoc(doc(db,'protokoll','p-ohne-feld'));
  if (pr.data().fahrschuleId !== SCHULE) throw new Error('altes Protokoll blieb liegen');
});
await p('Pruefungstermine wandern mit (eingetragenVon statt lehrerUid)', async()=>{
  const d = await getDoc(doc(db,'pruefungen','pr1'));
  if (d.data().schoolId !== SCHULE) throw new Error('Pruefung blieb beim Lehrer liegen');
});
await p('FREMDE Pruefung blieb unberuehrt', async()=>{
  const d = await getDoc(doc(db,'pruefungen','pr-fremd'));
  if (d.data().schoolId !== FREMD) throw new Error('fremde Pruefung verschoben!');
});
await p('Der Nachbau hier passt noch zur echten Funktion', async()=>{
  if (!/where\(besitzerFeld, '==', uid\)\.get\(\)/.test(QUELLE))
    throw new Error('umhaengen() sucht nicht mehr allein ueber das Besitzerfeld');
  if (!/gehoertNochDemKonto\(uid, zuordnungsFeld\)/.test(QUELLE))
    throw new Error('umhaengen() benutzt die Besitzfrage nicht mehr');
  for (const z of ["'students',     'uid',       'fahrschuleId'", "'pruefungen',   'eingetragenVon', 'schoolId'"])
    if (!QUELLE.includes(z)) throw new Error('Aufruf fehlt: '+z);
});
console.log('\n'+ok+' bestanden, '+bad+' fehlgeschlagen\n');
globalThis.__bad = bad;
});
await env.cleanup();
process.exit(globalThis.__bad>0?1:0);
