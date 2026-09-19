// Vier Pruefungen, die ohne Emulator, ohne Anmeldung und ohne zusaetzliche
// Pakete auskommen - reines Node. Sie fangen genau die Fehlerart ab, die in
// einem Projekt ohne Bauschritt sonst erst beim Nutzer auffaellt:
//
//   1 Syntaxfehler in einem <script>-Block. Ohne Bauschritt merkt das niemand
//     vor dem Hochladen; im Browser bleibt die Seite dann einfach leer.
//   2 onclick="foo()" ohne dass foo definiert ist. Der Knopf tut nichts, in
//     der Konsole steht ein ReferenceError - den sieht nur, wer sie oeffnet.
//     (So gefunden: closeModal() im Schueler-Portal.)
//   3 Zweimal dieselbe id im selben Bildschirm. getElementById trifft dann
//     immer nur das erste Element, das zweite bleibt tot.
//   4 Eine Firestore-Sammlung, die der Client benutzt, fuer die firestore.rules
//     aber keinen match-Block hat - jeder Zugriff darauf wird abgelehnt.
//
// Starten:  cd tests && npm run test:statisch

import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

const WURZEL = join(dirname(fileURLToPath(import.meta.url)), '..');
const ABLAGE = mkdtempSync(join(tmpdir(), 'fahrsync-syntax-'));

const SEITEN = ['index.html', 'schueler-portal.html', 'kalender.html', 'adk-platform.html',
                'start.html', 'schueler.html', '404.html', 'agb.html', 'avv.html',
                'datenschutz.html', 'impressum.html', 'reel.html'];
const CLIENT = ['index.html', 'kalender.html', 'adk-platform.html', 'schueler-portal.html'];

const lies = (d) => { try { return readFileSync(join(WURZEL, d), 'utf8'); } catch { return null; } };
const zeileVon = (text, index) => text.slice(0, index).split('\n').length;

let befunde = 0;
const melde = (was) => { befunde++; console.log('    ✗ ' + was); };

// ══ 1 Syntax ═══════════════════════════════════════════════════════════
console.log('\n1) SYNTAX der eingebetteten Skripte');
let bloecke = 0;
for (const d of SEITEN) {
  const text = lies(d);
  if (!text) continue;
  let n = 0;
  for (const m of text.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/gi)) {
    const attr = m[1] || '', code = m[2];
    if (/\bsrc\s*=/.test(attr)) continue;                    // externes Skript
    if (/type\s*=\s*["'](?!module|text\/javascript|application\/javascript)/.test(attr)) continue;
    if (!code.trim()) continue;
    n++; bloecke++;
    const istModul = /type\s*=\s*["']module["']/.test(attr);
    const pfad = join(ABLAGE, `${d.replace(/\W/g, '_')}_${n}.${istModul ? 'mjs' : 'js'}`);
    writeFileSync(pfad, code);
    try {
      execFileSync(process.execPath, ['--check', pfad], { stdio: 'pipe' });
    } catch (e) {
      melde(`${d} Block ${n} (ab Zeile ${zeileVon(text, m.index)}): `
            + String(e.stderr).split('\n').filter(Boolean).slice(1, 3).join(' | '));
    }
  }
}
// Eigenstaendige .js-Dateien gehoeren genauso geprueft. Sie fielen bisher
// durchs Raster, weil dieser Test nur in HTML hineinsah - ein Syntaxfehler im
// Service Worker faellt sonst erst beim Nutzer auf.
const EIGENE_JS = ['sw.js'];
let dateien = 0;
for (const d of EIGENE_JS) {
  const text = lies(d);
  if (text === null) continue;
  dateien++;
  // Modul oder klassisches Skript? Ein 'export'/'import' am Zeilenanfang
  // entscheidet - node --check ist da streng.
  const istModul = /^\s*(export|import)\s/m.test(text);
  const pfad = join(ABLAGE, d.replace(/\W/g, '_') + (istModul ? '.mjs' : '.js'));
  writeFileSync(pfad, text);
  try {
    execFileSync(process.execPath, ['--check', pfad], { stdio: 'pipe' });
  } catch (e) {
    melde(`${d}: ` + String(e.stderr).split('\n').filter(Boolean).slice(1, 3).join(' | '));
  }
}
console.log(`  ${bloecke} Skriptbloecke und ${dateien} eigene .js-Dateien geprueft`);

// ══ 2 Handler ══════════════════════════════════════════════════════════
// Nur Aufrufe ohne vorangehenden Punkt zaehlen - sonst faengt man jedes
// el.remove() mit ein. Schluesselwoerter und eingebaute Namen fliegen raus.
console.log('\n2) onclick & Co. verweisen auf vorhandene Funktionen');
const SCHLUESSEL = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'typeof',
  'function', 'new', 'delete', 'var', 'let', 'const', 'else', 'do', 'try', 'void']);
const EINGEBAUT = new Set(['alert', 'confirm', 'prompt', 'print', 'parseInt', 'parseFloat',
  'String', 'Number', 'Boolean', 'Array', 'Object', 'Date', 'Math', 'JSON', 'isNaN',
  'encodeURIComponent', 'decodeURIComponent', 'setTimeout', 'setInterval', 'event']);
for (const d of CLIENT) {
  const text = lies(d);
  if (!text) continue;
  const gerufen = new Map();
  for (const m of text.matchAll(/\son(?:click|change|input|submit|keyup|keydown|focus|blur)\s*=\s*"([^"]*)"/g)) {
    // Steht das Beispiel in einem Kommentar, ist es keins.
    const zeilenAnfang = text.lastIndexOf('\n', m.index) + 1;
    const anfang = text.slice(zeilenAnfang, m.index).trimStart();
    if (anfang.startsWith('//') || anfang.startsWith('*')) continue;
    for (const f of m[1].matchAll(/(?:^|[^.\w$])([A-Za-z_$][\w$]*)\s*\(/g)) {
      const name = f[1];
      if (SCHLUESSEL.has(name) || EINGEBAUT.has(name)) continue;
      if (!gerufen.has(name)) gerufen.set(name, zeileVon(text, m.index));
    }
  }
  let offen = 0;
  for (const [name, zeile] of gerufen) {
    const da = new RegExp(`(?:window\\.${name}\\s*=|function\\s+${name}\\b`
                        + `|(?:const|let|var)\\s+${name}\\s*=`
                        + `|\\b${name}\\s*[,)]|\\(\\s*${name}\\b)`).test(text);
    if (!da) { offen++; melde(`${d}:${zeile}  ${name}() ist nirgends definiert`); }
  }
  console.log(`  ${d.padEnd(22)} ${gerufen.size} Handler${offen ? '' : ' ✓'}`);
}

// ══ 3 Doppelte IDs ═════════════════════════════════════════════════════
// Geprueft wird nur das feste Markup AUSSERHALB der Skriptbloecke - also
// das, was beim Laden wirklich gleichzeitig im DOM steht. Was ein Skript
// erst erzeugt, kommt haeufig in Alternativen vor (Admin- gegen
// Lehrer-Ansicht, ternaerer Operator): dieselbe id steht dann zwar zweimal
// in der Datei, aber nie zweimal auf dem Bildschirm.
console.log('\n3) Doppelte id-Attribute im festen Markup');
for (const d of CLIENT) {
  const text = lies(d);
  if (!text) continue;
  const markup = text.replace(/<script[^>]*>[\s\S]*?<\/script>/gi,
                              (s) => s.replace(/[^\n]/g, ' '));  // Zeilen erhalten
  const stellen = new Map();
  for (const m of markup.matchAll(/\sid\s*=\s*["']([^"'${]+)["']/g)) {
    if (!stellen.has(m[1])) stellen.set(m[1], []);
    stellen.get(m[1]).push(zeileVon(markup, m.index));
  }
  let offen = 0;
  for (const [id, zeilen] of stellen) {
    if (zeilen.length < 2) continue;
    offen++; melde(`${d}  id="${id}" steht fest im Markup in Zeile ${zeilen.join(', ')}`);
  }
  console.log(`  ${d.padEnd(22)} ${stellen.size} feste IDs${offen ? '' : ' ✓'}`);
}

// ══ 4 Sammlungen gegen die Regeln ══════════════════════════════════════
console.log('\n4) Jede benutzte Firestore-Sammlung hat einen match-Block');
const benutzt = new Set();
for (const d of CLIENT) {
  const text = lies(d);
  if (!text) continue;
  for (const m of text.matchAll(/\b(?:collection|collectionGroup|doc)\s*\(\s*db\s*,\s*['"]([^'"]+)/g)) {
    benutzt.add(m[1].split('/')[0]);
  }
}
const regeln = lies('firestore.rules') || '';
const abgedeckt = new Set([...regeln.matchAll(/match\s+\/([A-Za-z0-9_]+)\//g)].map(m => m[1]));
const offen = [...benutzt].filter(s => !abgedeckt.has(s)).sort();
console.log(`  ${benutzt.size} Sammlungen im Client, ${abgedeckt.size} in den Regeln${offen.length ? '' : ' ✓'}`);
for (const s of offen) melde(`Sammlung "${s}" hat keinen match-Block in firestore.rules`);

// ══ 5 Die doppelte Zeichenliste ════════════════════════════════════════
// Die Liste der amtlichen Verkehrszeichen steht bewusst zweimal im Projekt:
// einmal in der Fahrlehrer-App, einmal im Schueler-Portal. Der Grund steht
// als Kommentar an beiden Stellen - kurz: ein gemeinsames Modul waere eine
// zweite Datei, von der die GANZE Seite abhinge; faellt sie aus, bleibt die
// App leer. Der Preis dafuer ist die Gefahr, dass jemand ein Zeichen nur an
// einer Stelle ergaenzt. Genau das faengt diese Pruefung ab.
console.log('\n5) Die doppelte Zeichenliste ist in beiden Dateien gleich');
const ZEICHEN_IN = ['index.html', 'schueler-portal.html'];
const MARKE = /\/\/ ── ZEICHENLISTE ANFANG[^\n]*\n([\s\S]*?)\/\/ ── ZEICHENLISTE ENDE/;
const bloeckeZeichen = new Map();
for (const d of ZEICHEN_IN) {
  const text = lies(d);
  if (!text) { melde(`${d} fehlt - die Zeichenliste kann nicht verglichen werden`); continue; }
  const treffer = text.match(MARKE);
  if (!treffer) { melde(`${d} hat keinen Block "ZEICHENLISTE ANFANG/ENDE" mehr`); continue; }
  // Den Kommentarkopf zwischen den Marken ueberspringen; verglichen wird
  // ab der ersten Datenzeile, damit unterschiedliche Erklaerungen erlaubt
  // bleiben - die Daten aber nicht.
  const ab = treffer[1].indexOf('const ZEICHEN_KATALOG');
  if (ab < 0) { melde(`${d}: im Block steht kein "const ZEICHEN_KATALOG"`); continue; }
  bloeckeZeichen.set(d, treffer[1].slice(ab).trim());
}
if (bloeckeZeichen.size === ZEICHEN_IN.length) {
  const [[dA, a], [dB, bText]] = [...bloeckeZeichen];
  if (a === bText) {
    const anzahl = (a.match(/^\s*'[^']+'\s*:\s*\[/gm) || []).length;
    console.log(`  ${anzahl} Zeichen, in beiden Dateien wortgleich ✓`);
  } else {
    // Nicht nur "ungleich" melden, sondern die erste abweichende Zeile -
    // sonst sucht man in 90 Zeilen von Hand.
    const zA = a.split('\n'), zB = bText.split('\n');
    let i = 0;
    while (i < zA.length && i < zB.length && zA[i] === zB[i]) i++;
    melde(`Die Zeichenliste laeuft auseinander, erste Abweichung in Zeile ${i + 1} des Blocks:\n`
        + `        ${dA}: ${(zA[i] ?? '<Datei zu Ende>').trim()}\n`
        + `        ${dB}: ${(zB[i] ?? '<Datei zu Ende>').trim()}`);
  }
}

// ══ 6 Eingesetzte Werte in HTML-Attributen ═════════════════════════════
// Der Fund, der diese Pruefung ausgeloest hat:
//
//   onclick="deleteSchool('${d.id}','${s.name}')"
//
// Ein Fahrschulname "Fahrschule O'Brien" machte den Loeschen-Knopf damit
// wirkungslos - das Anfuehrungszeichen beendete die Zeichenkette mitten
// drin. Ein absichtlich gesetzter Name fuehrte in der SuperAdmin-Ansicht
// fremden Code aus und konnte deleteSchool() auf eine FREMDE Fahrschule
// rufen, die daraufhin samt Lehrern, Schuelern und Terminen verschwand.
//
// Regel deshalb: Was in einem on...-Attribut in einer JS-Zeichenkette
// landet, muss durch attrJs(); was in einem sonstigen Attributwert landet,
// durch eine Escape-Funktion - oder es ist erkennbar eine Zahl, eine feste
// Zeichenkette oder ein Farb-/Stil-Ausdruck.
console.log('\n6) Eingesetzte Werte in HTML-Attributen sind entwertet');

// Backtick-Strings heraustrennen (mit verschachtelten ${} umgehen).
function templateLiterale(text) {
  const aus = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '`') continue;
    const start = i; i++;
    let tiefe = 0;
    for (; i < text.length; i++) {
      const c = text[i];
      if (c === '\\') { i++; continue; }
      if (c === '$' && text[i + 1] === '{') { tiefe++; i++; continue; }
      if (c === '}' && tiefe) { tiefe--; continue; }
      if (c === '`' && !tiefe) break;
    }
    aus.push([start, text.slice(start, i + 1)]);
  }
  return aus;
}

// Steht die Stelle in einem quotierten Attributwert? Wenn ja: welches?
function attributAn(lit, pos) {
  const davor = lit.slice(0, pos);
  const lt = davor.lastIndexOf('<'), gt = davor.lastIndexOf('>');
  if (lt < 0 || lt < gt) return null;                 // Textinhalt, nicht Attribut
  const imTag = davor.slice(lt);
  for (const q of ['"', "'"]) {
    if ((imTag.split(q).length - 1) % 2 !== 1) continue;
    const m = imTag.match(new RegExp(`([\\w-]+)\\s*=\\s*${q}[^${q}]*$`));
    return m ? m[1].toLowerCase() : '?';
  }
  return null;
}

const ENTWERTET = /\b(esc|escHtml|escape|escapeHtmlEigen|esc2|attrJs|encodeURIComponent)\s*\(/;

// Gemeldet wird nur, was ueberhaupt freien Text tragen KANN. Ein erster
// Entwurf schlug bei jeder eingesetzten Dokument-ID, Zahl und Schleifen-
// Zaehler an - 237 Meldungen, von denen keine ein Fehler war. Eine Pruefung,
// die man wegklickt, ist schlechter als keine. Ausschlaggebend ist deshalb
// der Feldname: Wer '.name', '.notiz' oder '.email' einsetzt, setzt etwas
// ein, das ein Mensch getippt hat; wer '.id' oder 'i' einsetzt, nicht.
const TEXTFELD = new RegExp(
  '(?:^|[.\\[\'"\\w])(' +
  'name|titel|title|text|notiz|kommentar|beschreibung|bemerkung|betreff|nachricht|inhalt|' +
  'ort|adresse|strasse|plz|vorname|nachname|fname|lname|email|mail|firma|schule|grund|anlass|' +
  'modell|kennzeichen|displayName|fahrschuleName|instagram|steuernummer|' +
  'url|Url|link|bild|Bild|logo|Logo|unterschrift|Unterschrift|pfad|Pfad' +
  ')\\b', '');

let attrGesamt = 0;
for (const d of CLIENT) {
  const text = lies(d);
  if (!text) continue;
  let offenHier = 0, geprueft = 0, beobachtet = 0;
  for (const [start, lit] of templateLiterale(text)) {
    for (const m of lit.matchAll(/\$\{/g)) {
      const attr = attributAn(lit, m.index);
      if (!attr) continue;
      // Ausdruck zwischen ${ und passendem }
      let i = m.index + 2, tiefe = 1;
      for (; i < lit.length && tiefe; i++) {
        if (lit[i] === '{') tiefe++;
        else if (lit[i] === '}') tiefe--;
      }
      const ausdruck = lit.slice(m.index + 2, i - 1).trim();
      geprueft++;
      const traegtText = TEXTFELD.test(ausdruck);
      const entwertet  = ENTWERTET.test(ausdruck);

      // In on...-Attributen reicht escHtml NICHT: Der Browser dreht die
      // Entities zurueck, BEVOR JavaScript laeuft - aus &#39; wird wieder
      // ein echtes ' und beendet die Zeichenkette mitten im Aufruf.
      if (attr.startsWith('on') && traegtText && !/\battrJs\s*\(/.test(ausdruck)) {
        offenHier++;
        melde(`${d}:${zeileVon(text, start + m.index)}  ${attr}="…\${${ausdruck.slice(0, 50)}}"`
            + `\n        In einem ${attr} braucht es attrJs() - escHtml() allein reicht dort nicht.`);
        continue;
      }
      if (!traegtText || entwertet) { if (traegtText) beobachtet++; continue; }
      if (attr === 'style' || attr === 'class') continue;
      offenHier++;
      melde(`${d}:${zeileVon(text, start + m.index)}  ${attr}="…\${${ausdruck.slice(0, 55)}}"`
          + `\n        Freier Text ohne Entwertung in einem Attribut.`);
    }
  }
  attrGesamt += geprueft;
  console.log(`  ${d.padEnd(22)} ${geprueft} Einsetzungen, davon ${beobachtet} mit freiem Text`
            + `${offenHier ? '' : ' ✓'}`);
}

// ══ 7 Datum immer in Ortszeit ══════════════════════════════════════════
// toISOString() rechnet nach UTC um. In deutscher Sommerzeit (UTC+2) ist
// zwischen 00:00 und 02:00 Ortszeit in UTC noch der VORTAG - genau die
// Stunden, in denen nach dem letzten Fahrschueler noch Papierkram gemacht
// wird. Nachgemessen am 17.07.2026 um 00:30 Berliner Zeit: Das vorbelegte
// Pruefungsdatum stand auf dem 16.07.
//
// kalender.html und das Schueler-Portal hatten dafuer laengst einen Helfer,
// index.html nicht - die Korrektur war damals nur halb angekommen. Diese
// Pruefung sorgt dafuer, dass sie nicht wieder halb zurueckkommt.
console.log('\n7) Kein Datum wird ueber UTC gebildet');
const DATEI_ALLE = [...CLIENT, 'sw.js', 'functions/index.js', 'functions/loeschen.js',
                    'functions/rechnung.js'];
let datumOffen = 0, datumGeprueft = 0;
for (const d of DATEI_ALLE) {
  const text = lies(d);
  if (!text) continue;
  datumGeprueft++;
  for (const m of text.matchAll(/toISOString\(\)\s*\.\s*(?:slice\(\s*0\s*,\s*10\s*\)|split\(\s*['"]T['"]\s*\)\s*\[\s*0\s*\]|substr\(\s*0\s*,\s*10\s*\))/g)) {
    datumOffen++;
    melde(`${d}:${zeileVon(text, m.index)}  toISOString() als Datum`
        + `\n        Ergibt in deutscher Nacht den Vortag. alsLokalesDatum()/heuteLokal() benutzen.`);
  }
}
console.log(`  ${datumGeprueft} Dateien durchgesehen${datumOffen ? '' : ' ✓'}`);

// ══ Ergebnis ═══════════════════════════════════════════════════════════
console.log(befunde === 0
  ? '\n✓ Keine Befunde.\n'
  : `\n✗ ${befunde} Befund(e).\n`);
process.exit(befunde ? 1 : 0);
