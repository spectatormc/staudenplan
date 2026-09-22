/*
 * PRUEFUNG 3: Traegt jede Pin-Datei mit KI-Inhalt die maschinenlesbare Kennzeichnung — und
 * traegt sie keine andere?
 *
 *   npm run check:pin-meta
 *   node scripts/check-pin-metadaten.js --selbsttest   nur die Melder pruefen
 *
 * WAS GEPRUEFT WIRD, UND WARUM IN BEIDE RICHTUNGEN:
 *   (1) Sorte mit KI-Bild, Datei OHNE das IPTC-Feld DigitalSourceType -> FEHLER. Der Pin
 *       geht dann als menschengemachtes Bild zu Pinterest, Meta und Google.
 *   (2) Sorte ohne KI-Bild, Datei MIT dem Feld -> FEHLER. Das ist kein ueberfluessiger
 *       Hinweis, sondern eine maschinenlesbare Falschaussage ueber eine gezeichnete
 *       Beetskizze oder reine Typografie.
 * Nur eine der beiden Richtungen zu pruefen waere der halbe Rueckbau, den dieses Projekt
 * schon einmal bezahlt hat.
 *
 * DIE KREUZPROBE GEGEN DEN TEXT gehoert dazu: Die Beschreibung in liste.json traegt den Satz
 * ueber die Illustration genau dann, wenn die Datei das Feld traegt. Beide stammen aus
 * derselben Liste KI_PIN_SORTEN — laufen sie auseinander, sagt der Pin dem Menschen etwas
 * anderes als der Maschine.
 *
 * DIE KREUZPROBE GILT NUR FUER NOCH NICHT VEROEFFENTLICHTE PINS (seit 21.09.2026).
 * Die Beschreibung eines faelligen Pins ist eingefroren: pins-erzeugen.js uebernimmt Titel und
 * Beschreibung dann unveraendert aus der alten Liste, weil Pinterest den Pin beim
 * Veroeffentlichen festhaelt. Jeder Pin, der vor der Einfuehrung von KI_HINWEIS (pin-text.js,
 * 18.08.2026) hinausgegangen ist, traegt den Satz deshalb nicht — die DATEI kann und soll die
 * Kennzeichnung trotzdem bekommen, denn sie liegt unter /pins/ weiter oeffentlich aus. Ein
 * FEHLER waere hier eine Forderung ohne zulaessige Korrektur: Einen Pin holt kein Deploy
 * zurueck, und seinen Text nachtraeglich zu aendern wuerde nur den Feed vom Veroeffentlichten
 * entfernen. Gemeldet wird der Fall deshalb als HINWEIS, ohne Fehlerwertung — und zwar in
 * BEIDE Richtungen, weil ein eingefrorener Text auch dann nicht mehr zu aendern ist, wenn er
 * die Illustration nennt und die Sorte keine hat.
 * Dieselbe Unterscheidung trifft check-pin-deckung.js, mit derselben Begruendung und aus
 * derselben Quelle: S.istVeroeffentlicht() in pin-sorten.js.
 * Die Pruefung der DATEI (oben, beide Richtungen) bleibt fuer veroeffentlichte Pins in vollem
 * Umfang bestehen — sie ist jederzeit nachzuholen.
 *
 * WOHER DIE REGELN KOMMEN — nichts davon wird hier nachgebaut:
 *   - welche Sorte ein KI-Bild zeigt: L.istKiPin() / L.KI_PIN_SORTEN (pin-layout.js)
 *   - welche Sorte eine Datei hat:    S.sorteAus() (pin-sorten.js)
 *   - was in der Datei steht:         kiMeta.lesen() (pin-ki-metadaten.js)
 *   - der Wortlaut im Text:           BH.KI_TEXT (bild-herkunft.js)
 * Der Satz in pin-text.js (KI_HINWEIS) wiederholt diesen Wortlaut heute als eigenes Literal.
 * Weicht er je von BH.KI_TEXT ab, schlaegt diese Pruefung an — das ist beabsichtigt: Die
 * Kennzeichnung soll an einer Stelle gepflegt werden, nicht an zweien.
 *
 * GEPRUEFT WIRD JEDE JPG-DATEI UNTER public/pins/, nicht nur die Eintraege aus liste.json.
 * Die Dateien liegen unter /pins/<datei> oeffentlich aus (express.static); eine Datei ohne
 * Listeneintrag ist deshalb ein eigener Ausgabepfad und keine Karteileiche.
 *
 * WAS DIESE PRUEFUNG NICHT FINDET, OBWOHL EIN FEHLER VORLIEGT:
 *   - Sie glaubt der Sorte im Dateinamen. Zeigt ein Pin der Sorte „beetplan" eines Tages ein
 *     erzeugtes Bild, ohne dass die Sorte in KI_PIN_SORTEN aufgenommen wird, dann ist hier
 *     alles „richtig" — Datei ohne Feld, Text ohne Satz, und beide falsch. Diese Richtung
 *     faengt pins-erzeugen.js beim Bauen ab (Gegenprobe an bild_ki der Quellpflanzen), nicht
 *     dieser Lauf.
 *   - Sie prueft das Vorhandensein des Feldes, nicht seine Wirkung. Ob Pinterest es liest
 *     und den Pin als KI-Bild markiert, sagt nur Pinterest.
 *   - Sie sieht nur Dateien, die hier liegen. Was auf dem Server liegt, muss auf dem Server
 *     geprueft werden — deshalb die Leerlaufsperre unten.
 *   - Ein Pin, dessen Beschreibung bei Pinterest schon steht, aendert sich durch einen
 *     spaeteren Fund hier nicht mehr. Die Pruefung gehoert vor das Veroeffentlichen.
 */
'use strict';

const fs = require('fs');
const path = require('path');

/* Fehlt das Werkzeug zum Lesen, wird abgebrochen — nicht still durchgewunken. Ein Lauf, der
 * die Segmente nicht lesen kann, weiss ueber jede Datei nichts; „keine Befunde" waere dann
 * die gefaehrlichste aller Antworten. */
let S, L, kiMeta, BH;
try {
  S = require('./pin-sorten');
  L = require('./pin-layout');
  kiMeta = require('./pin-ki-metadaten');
  BH = require('./bild-herkunft');
  if (typeof kiMeta.lesen !== 'function' || typeof kiMeta.segmente !== 'function') {
    throw new Error('pin-ki-metadaten.js liefert keinen Leser (lesen/segmente).');
  }
} catch (e) {
  console.error(`FEHLER: Das Werkzeug zum Lesen der Bildmetadaten fehlt — ${e.message}`);
  process.exit(1);
}

const WURZEL = path.resolve(__dirname, '..');
const ZIEL = path.join(WURZEL, 'public', 'pins');
const LISTE = path.join(ZIEL, 'liste.json');

/* LEERLAUFSPERRE, dieselbe Ueberlegung wie in check-ki-kennzeichnung.js: public/pins/ gibt es
 * auf dem Arbeitsplatz gar nicht. Ein Lauf ohne Dateien hat nichts gesehen und darf nicht
 * bestehen — und er muss BEIDE Richtungen gesehen haben, sonst belegt er nur eine. */
const MIN_KI = Number(process.env.PIN_META_MIN_KI || 5);
const MIN_ANDERE = Number(process.env.PIN_META_MIN_ANDERE || 3);

/* „Veroeffentlicht" heisst hier dasselbe wie im Terminlauf, beim Erzeugen und in
 * check-pin-deckung.js: Termin erreicht. Die Regel steht in pin-sorten.js und wird nicht
 * nachgebaut. */
const HEUTE = new Date().toISOString().slice(0, 10);

let fehler = 0, ungeprueft = 0, zaehlKi = 0, zaehlAndere = 0, eingefroren = 0, eingefrorenAbweichend = 0;
const FEHLER = (wo, satz) => { fehler++; console.error(`FEHLER      ${wo}: ${satz}`); };
const UNGEPRUEFT = (wo, satz) => { ungeprueft++; console.warn(`UNGEPRUEFT  ${wo}: ${satz}`); };
/* Weder Fehler noch „ungeprueft": Der Fall IST geprueft, nur ist das Ergebnis nicht mehr zu
 * aendern. Er wird gezaehlt und benannt, damit er nicht unsichtbar wird. */
const HINWEIS = (wo, satz) => { eingefrorenAbweichend++; console.log(`HINWEIS     ${wo}: ${satz}`); };

// ─── Selbsttest ──────────────────────────────────────────────────────────────
/*
 *   node scripts/check-pin-metadaten.js --selbsttest
 *
 * Belegt die drei Annahmen, auf denen diese Pruefung steht: dass die Sorte aus dem
 * Dateinamen herauszulesen ist, dass die Liste der KI-Sorten die erwarteten Antworten gibt,
 * und dass Schreiber und Leser der Kennzeichnung dasselbe meinen. Braucht keine Pins und
 * laeuft deshalb auch auf dem Arbeitsplatz. Er belegt NICHT, dass die Pin-Dateien in Ordnung
 * sind — nur, dass die Pruefung urteilsfaehig ist.
 */
if (process.argv.includes('--selbsttest')) {
  let schlecht = 0;
  const pruefe = (name, bedingung) => {
    if (!bedingung) schlecht++;
    console.log(`${bedingung ? 'ok            ' : 'FEHLGESCHLAGEN'} ${name}`);
  };
  pruefe('pflanze-winter-astilbe.jpg -> pflanze-winter (laengster Treffer zuerst)',
    S.sorteAus('pflanze-winter-astilbe.jpg') === S.TYP.pflanzeWinter);
  pruefe('pflanze-astilbe.jpg -> pflanze', S.sorteAus('pflanze-astilbe.jpg') === S.TYP.pflanze);
  pruefe('saison-12.jpg -> saison', S.sorteAus('saison-12.jpg') === S.TYP.saison);
  pruefe('fremd.jpg -> keine Sorte', S.sorteAus('fremd.jpg') === null);
  pruefe('pflanze-winter zeigt ein KI-Bild', L.istKiPin(S.TYP.pflanzeWinter) === true);
  pruefe('beetplan zeigt keines', L.istKiPin(S.TYP.beetplan) === false);
  pruefe('ratgeber zeigt keines', L.istKiPin(S.TYP.ratgeber) === false);
  /* Die Ausnahme fuer eingefrorene Texte haengt an genau dieser Frage. Sie wird hier belegt,
   * damit die Ausnahme nicht stillschweigend auf alles oder auf nichts zutrifft. */
  pruefe('Termin erreicht heisst veroeffentlicht', S.istVeroeffentlicht({ geplant_am: HEUTE }, HEUTE) === true);
  pruefe('Termin in der Zukunft heisst nicht veroeffentlicht', S.istVeroeffentlicht({ geplant_am: '2999-01-01' }, HEUTE) === false);
  pruefe('ohne Termin nicht veroeffentlicht', S.istVeroeffentlicht({}, HEUTE) === false);

  const probe = path.join(require('os').tmpdir(), `pin-meta-selbsttest-${process.pid}.jpg`);
  fs.writeFileSync(probe, Buffer.from([0xFF, 0xD8, 0xFF, 0xD9]));
  const vorher = kiMeta.lesen(fs.readFileSync(probe));
  const geschrieben = kiMeta.kennzeichnen(probe).status;
  const nachher = kiMeta.lesen(fs.readFileSync(probe));
  const zweimal = kiMeta.kennzeichnen(probe).status;
  fs.unlinkSync(probe);
  pruefe('ungekennzeichnete Datei wird als solche gelesen', vorher === 'nein');
  pruefe('Kennzeichnung wird geschrieben und wiedergefunden', geschrieben === 'geschrieben' && nachher === 'ja');
  pruefe('zweiter Lauf schreibt nicht noch einmal', zweimal === 'vorhanden');

  console.log(schlecht ? `--- Selbsttest FEHLGESCHLAGEN (${schlecht}) ---` : '--- Selbsttest bestanden ---');
  process.exit(schlecht ? 1 : 0);
}

if (!fs.existsSync(ZIEL)) {
  console.error(`FEHLER: ${ZIEL} fehlt.`);
  console.error('Diese Pruefung braucht die erzeugten Pin-Dateien. Sie laeuft auf dem Server im');
  console.error('Deploy-Verzeichnis (oder nach einem vollstaendigen Lauf von scripts/pins-erzeugen.js).');
  process.exit(1);
}

const dateien = fs.readdirSync(ZIEL).filter(d => /\.jpe?g$/i.test(d)).sort();
const liste = fs.existsSync(LISTE) ? JSON.parse(fs.readFileSync(LISTE, 'utf8')) : [];
if (!fs.existsSync(LISTE)) UNGEPRUEFT('liste.json', 'fehlt — die Kreuzprobe gegen die Beschreibungen entfaellt.');
const nachDatei = new Map(liste.filter(e => e && e.datei).map(e => [e.datei, e]));

console.log('--- Pruefung: maschinenlesbare KI-Kennzeichnung der Pin-Dateien ---');
console.log(`Verzeichnis: ${ZIEL} (${dateien.length} Bilddateien, ${liste.length} Listeneintraege)`);
console.log(`Sorten mit KI-Bild (KI_PIN_SORTEN): ${L.KI_PIN_SORTEN.join(', ')}`);

for (const datei of dateien) {
  const pfad = path.join(ZIEL, datei);
  const sorte = S.sorteAus(datei);
  if (!sorte) {
    UNGEPRUEFT(datei, 'die Sorte laesst sich aus dem Dateinamen nicht ableiten — ueber die Kennzeichnung ist damit nichts zu sagen.');
    continue;
  }
  const sollKi = L.istKiPin(sorte);

  let zustand;
  try {
    zustand = kiMeta.lesen(fs.readFileSync(pfad));
  } catch (e) {
    FEHLER(datei, `nicht lesbar — ${e.message}`);
    continue;
  }
  if (zustand === 'kein-jpeg') { FEHLER(datei, 'keine JPEG-Datei, liegt aber unter /pins/ aus.'); continue; }
  if (zustand === 'xmp-fremd') { FEHLER(datei, 'traegt ein fremdes XMP-Paket ohne unser Feld — der Zustand ist nicht eindeutig.'); continue; }

  const hatFeld = zustand === 'ja';
  if (sollKi && !hatFeld) {
    FEHLER(datei, `Sorte „${sorte}" zeigt ein KI-Bild, die Datei traegt das Feld DigitalSourceType aber nicht.`);
  } else if (!sollKi && hatFeld) {
    FEHLER(datei, `Sorte „${sorte}" zeigt kein KI-Bild, die Datei behauptet mit DigitalSourceType das Gegenteil.`);
  } else if (sollKi) zaehlKi++;
  else zaehlAndere++;

  // ── Kreuzprobe gegen den Text ───────────────────────────────────────────────
  const e = nachDatei.get(datei);
  if (!e) {
    /* Kein Listeneintrag heisst: kein Feed-Eintrag, aber die Datei liegt trotzdem unter
     * /pins/<datei>. Die Kennzeichnung oben gilt also weiter, der Textvergleich entfaellt. */
    UNGEPRUEFT(datei, 'liegt unter /pins/ aus, steht aber in keinem Listeneintrag — die Beschreibung ist nicht zu vergleichen.');
    continue;
  }
  if (e.typ && e.typ !== sorte) {
    FEHLER(datei, `der Listeneintrag fuehrt die Sorte „${e.typ}", der Dateiname sagt „${sorte}".`);
  }
  if (typeof e.kiBild === 'boolean' && e.kiBild !== sollKi) {
    FEHLER(datei, `der Listeneintrag sagt kiBild=${e.kiBild}, die Sorte „${sorte}" sagt ${sollKi}.`);
  }
  /* Ab hier geht es um die BESCHREIBUNG. Sie ist bei einem veroeffentlichten Pin eingefroren
   * (pins-erzeugen.js uebernimmt sie unveraendert aus der alten Liste), also nicht mehr zu
   * korrigieren — die Begruendung steht im Kopf dieser Datei. Gemeldet wird trotzdem, aber
   * ohne Fehlerwertung und mit dem Zusatz, warum nichts zu tun ist. */
  const satzDa = String(e.beschreibung || '').includes(BH.KI_TEXT);
  const veroeffentlicht = S.istVeroeffentlicht(e, HEUTE);
  if (veroeffentlicht) eingefroren++;
  const melden = veroeffentlicht
    ? (satz) => HINWEIS(datei, `${satz} Veroeffentlicht am ${e.geplant_am}, Text eingefroren — nur die Datei geprueft, die Beschreibung ist nicht mehr zu aendern.`)
    : (satz) => FEHLER(datei, satz);
  if (sollKi && !satzDa) {
    melden(`die Beschreibung nennt die Illustration nicht („${BH.KI_TEXT}" fehlt), die Datei ist aber als KI-Bild gekennzeichnet.`);
  } else if (!sollKi && satzDa) {
    melden(`die Beschreibung nennt eine KI-Illustration, die Sorte „${sorte}" zeigt aber keine.`);
  }
}

/* Die Gegenrichtung der Liste: Ein Eintrag, dessen Datei fehlt, zeigt im Feed auf ein Bild,
 * das es nicht gibt — Pinterest uebergeht ihn stillschweigend. */
for (const e of liste) {
  if (!e || !e.datei) continue;
  if (!fs.existsSync(path.join(ZIEL, e.datei))) FEHLER(e.guid || e.datei, `Listeneintrag ohne Bilddatei (${e.datei}).`);
}

// ─── Bilanz ──────────────────────────────────────────────────────────────────
console.log('---');
console.log(`Geprueft: ${zaehlKi} Dateien mit KI-Bild, ${zaehlAndere} ohne`);
console.log(`Davon veroeffentlicht (Stand ${HEUTE}): ${eingefroren} — Datei geprueft, Beschreibung eingefroren`);
console.log(`Befunde: ${fehler} Fehler, ${ungeprueft} ungeprueft, ${eingefrorenAbweichend} Hinweis(e) zu eingefrorenem Text`);
if (zaehlKi < MIN_KI || zaehlAndere < MIN_ANDERE) {
  console.error(`FEHLER: Zu wenig gesehen (KI ${zaehlKi}/${MIN_KI}, ohne KI ${zaehlAndere}/${MIN_ANDERE}).`);
  console.error('Beide Richtungen brauchen Dateien, sonst belegt der Lauf nur eine Haelfte. Diese Pruefung');
  console.error('gehoert dorthin, wo public/pins/ wirklich gefuellt ist: auf den Server im');
  console.error('Deploy-Verzeichnis oder hinter einen vollstaendigen Lauf von scripts/pins-erzeugen.js.');
  fehler++;
}
process.exit(fehler > 0 ? 1 : 0);
