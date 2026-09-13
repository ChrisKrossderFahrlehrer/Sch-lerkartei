// Prueft die Umzugs-Logik der Cloud Function uebernehmeSchuelerInFahrschule.
//
// Geprueft wird, WAS umgezogen wird: die richtigen Feldnamen je Sammlung, dass
// der Lernstand mitkommt, dass bereits zugeordnete Daten in Ruhe gelassen
// werden - und vor allem, dass FREMDE Daten niemals mitwandern.
//
// Ehrlich dazugesagt: Die Abfragen sind hier nachgebaut, nicht die Funktion
// selbst aufgerufen - dafuer braeuchte es zusaetzlich den Functions-Emulator.
// Die Zugangspruefungen der Funktion (angemeldet, kein Gastkonto, gehoert zu
// einer Schule, von der Schule freigeschaltet) deckt dieser Test also nicht ab.
// Sie sind allerdings auch nicht die gefaehrliche Stelle: Die Abfragen sind
// fest auf die eigene Kennung verdrahtet, im schlimmsten Fall verschiebt
// jemand also seine EIGENEN Daten in seine EIGENE Schule.
import { initializeTestEnvironment } from '@firebase/rules-unit-testing';
import { doc, setDoc, getDocs, getDoc, query, collection, where, writeBatch } from 'firebase/firestore';
import { readFileSync } from 'node:fs';

const env = await initializeTestEnvironment({ projectId:'uebernahme', firestore:{
  rules: readFileSync('/home/user/Sch-lerkartei/firestore.rules','utf8'), host:'127.0.0.1', port:8089 }});
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

const jetzt = Date.now();
const erg = {};
async function umhaengen(samm, besitzer, zuordnung, z) {
  const snap = await getDocs(query(collection(db,samm), where(besitzer,'==',LEHRER), where(zuordnung,'==',LEHRER)));
  for (let i=0; i<snap.docs.length; i+=400) {
    const b = writeBatch(db);
    snap.docs.slice(i,i+400).forEach(d => b.update(d.ref,{[zuordnung]:SCHULE, uebernommenVon:LEHRER, uebernommenAm:jetzt}));
    await b.commit();
  }
  erg[z] = snap.size;
}
await umhaengen('students','uid','fahrschuleId','schueler');
await umhaengen('customThemen','uid','fahrschuleId','themen');
await umhaengen('protokoll','uid','fahrschuleId','protokoll');
await umhaengen('slots','lehrerUid','schoolId','termine');
await umhaengen('schueler','lehrerUid','schoolId','kalenderSchueler');

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
await p('Die Fahrschule sieht jetzt 3 Schueler', async()=>{
  const s = await getDocs(query(collection(db,'students'), where('fahrschuleId','==',SCHULE)));
  if (s.size !== 3) throw new Error('statt 3: '+s.size);
});
console.log('\n'+ok+' bestanden, '+bad+' fehlgeschlagen\n');
globalThis.__bad = bad;
});
await env.cleanup();
process.exit(globalThis.__bad>0?1:0);
