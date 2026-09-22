/*
 * PRUEFUNG 2: Zeigt das Pin-BILD wirklich die Pflanzen, die seine BESCHREIBUNG nennt?
 *
 *   npm run check:pins
 *   node scripts/check-pin-deckung.js --selbsttest   nur die Melder pruefen
 *
 * DER VORFALL, GEGEN DEN DIESE PRUEFUNG GESCHRIEBEN IST: Bei saison-12 nennt die
 * Beschreibung die Pfingst-Nelke, das Bild zeigt Leberbluemchen. Die Datei entstand um
 * 10:45, der Text um 13:14 desselben Tages — zwei Laeufe, zwei Auswahlen, ein Pin.
 *
 * WARUM DER NAHELIEGENDE VERGLEICH NICHTS FINDET: Beschreibung und das Feld `pflanzen[]` in
 * liste.json entstehen im selben Lauf aus derselben Auswahl. Sie stimmen per Konstruktion
 * ueberein, auch wenn beide vom Bild abweichen. Das einzige Stueck, das unabhaengig davon
 * altern kann, ist die JPG-Datei. Diese Pruefung befragt deshalb das BILD.
 *
 * DREI STUFEN, in dieser Reihenfolge:
 *   (i)   Bildkommentar. Steht im JPEG ein COM-Segment mit {guid, ids, erzeugt_am}, werden
 *         seine IDs gegen die des Textes gehalten. Das ist die einzige Stufe, die den
 *         Vorfall wirklich ausschliesst.
 *   (ii)  Ersatzweise die Zeiten: Ist die Bilddatei deutlich aelter als der Text DIESES
 *         Eintrags (Feld `text_am` in liste.json), stammen Bild und Text aus verschiedenen
 *         Laeufen — genau die Lage des Vorfalls (149 Minuten Abstand). Das ist ein FEHLER.
 *   (iii) Bleibt beides ohne Aussage, gilt der Pin als NICHT PRUEFBAR. Das zaehlt als
 *         Fehlschlag, nicht als bestanden: „Ich konnte nichts pruefen" ist kein „in Ordnung".
 *
 * WARUM STUFE (ii) GEGEN `text_am` MISST UND NICHT GEGEN DIE DATEIZEIT VON liste.json
 * (korrigiert am 21.09.2026):
 *   Bis hierher verglich Stufe (ii) die Bilddatei mit der Aenderungszeit von liste.json. Diese
 *   Zeit ist aber kein Alter des Textes, sondern das Alter des letzten SCHREIBENS der ganzen
 *   Liste — und geschrieben wird sie bei JEDEM Lauf, von pins-erzeugen.js und zusaetzlich von
 *   pin-termine.js. Die Bilddateien bleiben ohne --neu ausdruecklich stehen („alles,
 *   vorhandene Dateien bleiben stehen", Modulkopf pins-erzeugen.js). Ab dem zweiten Lauf waere
 *   also JEDE nicht neu gebaute Datei „aelter als der Textlauf" gewesen, und jede einzelne
 *   haette den Satz „Bild und Beschreibung stammen aus verschiedenen Laeufen" bekommen — eine
 *   Aussage, die die Daten nicht hergeben. Eine Pruefung, die im Normalbetrieb dauernd
 *   Fehlalarm gibt, wird abgeschaltet und ist dann schlimmer als keine.
 *   Gemessen wird deshalb gegen einen Zeitstempel JE EINTRAG. Fehlt er, sagt dieser Lauf
 *   „nicht pruefbar" — und nicht „falsch".
 *   DAS KOSTET ETWAS, UND ZWAR GENAU DIES: Solange text_am fehlt, faellt auch ein WIRKLICH
 *   veraltetes Bild nur noch unter „nicht pruefbar". Vorher waere es gemeldet worden — aber
 *   zusammen mit jedem anderen Pin, also ohne Aussagewert. Der Lauf endet weiterhin mit
 *   Exitcode 1, die Luecke bleibt also sichtbar; sie wird von (A) geschlossen, nicht von
 *   einer Zahl, die zufaellig einmal richtig liegt.
 *
 * (A) UND (B) SIND SEIT DEM 22.09.2026 GEBAUT. Bis dahin standen sie hier als Auftrag statt
 * dort als Code, und dieser Lauf meldete deshalb jeden Pin als NICHT PRUEFBAR. Was es jetzt
 * gibt und wo es steht:
 *
 * (A) FUER STUFE (ii) — das Feld text_am je Listeneintrag, gesetzt in bauen()
 *     (scripts/pins-erzeugen.js) beim Zusammensetzen des Eintrags:
 *
 *       text_am: eingefroren ? (alt.text_am || null) : new Date().toISOString(),
 *
 *     Jeder Eintrag traegt damit das Alter SEINES Textes: bei einem eingefrorenen Pin den
 *     Stand der Veroeffentlichung, sonst den laufenden Bau. Ein Pin, dessen Text nicht neu
 *     gerechnet wurde, sieht damit auch nicht neu aus. Eintraege aus der Zeit davor haben das
 *     Feld nicht; fuer sie sagt Stufe (ii) weiterhin nichts, statt zu raten.
 *
 * (B) FUER STUFE (i) — der Bildkommentar, geschrieben beim BAUEN des Bildes. Den Aufbau
 *     liefert bildKommentarArgs() in scripts/pin-layout.js, EINMAL fuer alle vier Sorten mit
 *     Pflanzenbild; die Bildbauer haengen ihn unmittelbar vor -quality an ihre
 *     ImageMagick-Argumente: scripts/pin-saison.js (die sechs IDs des Rasters),
 *     scripts/pin-kombination.js (die drei Kacheln) und scripts/pin-bild.js (die eine
 *     Pflanze, fuer pflanze wie fuer pflanze-winter). Die IDs werden dabei in derselben
 *     Schleife eingesammelt, die die Kacheln zeichnet — nicht ein zweites Mal aus der Auswahl
 *     abgeleitet.
 *
 *     DER KOMMENTAR ENTSTEHT NUR BEIM BAUEN. Ihn nachtraeglich in eine liegende Datei zu
 *     schreiben waere das Gegenteil eines Belegs: Man behauptete die heutige Auswahl ueber
 *     ein altes Bild und faerbte diese Pruefung gruen, ohne irgendetwas gesehen zu haben.
 *     Damit die rund 490 schon liegenden, aber noch nicht faelligen Dateien ihn trotzdem
 *     bekommen, hat scripts/pins-erzeugen.js den Schalter --neu-unveroeffentlicht: Er baut
 *     genau diese Bilder neu und laesst die der veroeffentlichten Pins unangetastet.
 *
 *     `guid` bleibt OPTIONAL. Steht sie im Bild, muss sie zum Eintrag passen; fehlt sie,
 *     werden nur die IDs verglichen. Gebildet wird sie in pins-erzeugen.js (bei der Sorte
 *     saison in saisonKennung()) und von dort an den Bildbauer hereingereicht — sie in den
 *     Bildskripten nachzubauen waere eine zweite Fassung der Kennungsregel.
 *
 *   WAS DIESE PRUEFUNG WEITERHIN NICHT TUT, ist die Umkehrung: aus „nicht belegt" ein
 *   „nachweislich falsch" zu machen. Ein Pin ohne Bildkommentar und ohne text_am bleibt
 *   NICHT PRUEFBAR, und der Lauf endet mit Exitcode 1 — sichtbar, aber ohne Befund gegen ihn.
 *
 * GEPRUEFT WIRD, WAS NOCH NICHT FAELLIG IST. Ein veroeffentlichter Pin ist bei Pinterest und
 * nicht mehr zurueckzuholen; die Pruefung soll VOR dem Veroeffentlichen greifen. „Faellig"
 * heisst dasselbe wie ueberall im Pin-Kanal: S.istVeroeffentlicht() aus pin-sorten.js.
 *
 * WAS DIESE PRUEFUNG NICHT FINDET, OBWOHL EIN FEHLER VORLIEGT:
 *   - Sie vergleicht Metadaten mit Text, nicht Pixel mit Text. Schreibt das Bildskript einen
 *     Kommentar mit den IDs der Auswahl, zeichnet dann aber die falsche Datei ins Raster,
 *     glaubt diese Pruefung dem Kommentar.
 *   - Veroeffentlichte Pins bleiben aussen vor. Eine Abweichung, die schon hinausgegangen
 *     ist, meldet hier niemand mehr.
 *   - Ohne Bildkommentar entscheidet die Dateizeit. Wer die Toleranz hochsetzt oder die
 *     Dateien anfasst (Kopieren, Entpacken, rsync ohne -t), macht Stufe (ii) wirkungslos —
 *     ohne dass etwas auffaellt.
 *   - Stufe (ii) misst, wann die Datei zuletzt GESCHRIEBEN wurde, nicht, wann das Bild
 *     gezeichnet wurde. pin-ki-metadaten.js schreibt die maschinenlesbare Kennzeichnung in
 *     eine bestehende Datei, ohne sie neu zu zeichnen; deren Aenderungszeit ist danach die
 *     des Kennzeichnungslaufs. Ein altes Bild sieht dadurch frisch aus. Die Stufe kann
 *     deshalb nur in EINE Richtung etwas belegen: „Datei aelter als der Text" ist ein Befund,
 *     „Datei nicht aelter" ist keine Entlastung — deshalb endet dieser Fall als NICHT
 *     PRUEFBAR und nicht als bestanden.
 *   - Nennt die Beschreibung eine Pflanze, die in der Datenbank gar nicht (mehr) steht, wird
 *     der Name nicht erkannt. Der Pin gilt dann als ungeprueft, nicht als fehlerhaft.
 *   - Die Sorten ohne Pflanzenbild (beetplan, ratgeber, pflege) werden nicht geprueft. Wenn
 *     deren Beschreibung eine Pflanze nennt, ist das kein Widerspruch zum Bild.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const S = require('./pin-sorten');
const L = require('./pin-layout');
const kiMeta = require('./pin-ki-metadaten');

const WURZEL = path.resolve(__dirname, '..');
const ZIEL = path.join(WURZEL, 'public', 'pins');
const LISTE = path.join(ZIEL, 'liste.json');
const DB_DATEI = process.env.DB_PFAD || path.join(WURZEL, 'stauden.db');
const HEUTE = new Date().toISOString().slice(0, 10);

/* Toleranz zwischen Bilddatei und dem Zeitstempel des Textes (text_am). 120 Minuten: Der
 * Vorfall lag bei 149 Minuten und faellt damit auf; ein Stapellauf, der alle Sorten baut,
 * bleibt darunter. Wer sie hochsetzt, schaltet Stufe (ii) praktisch ab — dann bleibt nur noch
 * der Bildkommentar. */
const TOLERANZ_MIN = Number(process.env.PIN_DECKUNG_TOLERANZ_MIN || 120);

/* LEERLAUFSPERRE: Auf diesem Arbeitsplatz gibt es public/pins/ gar nicht. Eine Pruefung, die
 * null Pins gesehen hat, darf nicht bestehen — sonst meldet sie „in Ordnung" und meint
 * „nichts gefunden". */
const MIN_PINS = Number(process.env.PIN_DECKUNG_MIN || 5);

let fehler = 0, ungeprueft = 0, belegt = 0, geprueft = 0;
const FEHLER = (wo, satz) => { fehler++; console.error(`FEHLER      ${wo}: ${satz}`); };
const UNGEPRUEFT = (wo, satz) => { ungeprueft++; console.warn(`UNGEPRUEFT  ${wo}: ${satz}`); };

// ─── Voraussetzungen ─────────────────────────────────────────────────────────
/* Der Selbsttest weiter unten braucht die Pins nicht — nur die Pflanzennamen. Er muss
 * deshalb an dieser Abbruchstelle vorbeikommen. */
const SELBSTTEST = process.argv.includes('--selbsttest');
if (!SELBSTTEST && !fs.existsSync(LISTE)) {
  console.error(`FEHLER: ${LISTE} fehlt.`);
  console.error('Diese Pruefung braucht die erzeugten Pins. Sie laeuft auf dem Server im');
  console.error('Deploy-Verzeichnis (oder nach einem vollstaendigen Lauf von scripts/pins-erzeugen.js).');
  process.exit(1);
}
if (!SELBSTTEST && !fs.existsSync(DB_DATEI)) {
  console.error(`FEHLER: ${DB_DATEI} fehlt — ohne die Pflanzennamen ist der Text nicht zu lesen.`);
  process.exit(1);
}

const liste = fs.existsSync(LISTE) ? JSON.parse(fs.readFileSync(LISTE, 'utf8')) : [];
/* NUR FUER DEN KOPF DER AUSGABE. Diese Zeit sagt, wann die Liste zuletzt geschrieben wurde —
 * nicht, wie alt der Text eines einzelnen Eintrags ist. Genau diese Verwechslung war der
 * Fehlalarm, den die Kopfbemerkung oben beschreibt; gemessen wird in Stufe (ii) gegen
 * e.text_am. */
const listeGeschrieben = fs.existsSync(LISTE) ? fs.statSync(LISTE).mtimeMs : 0;

/* Der Zeitstempel des Textes EINES Eintrags. Fehlt er oder ist er unlesbar, gibt es nichts zu
 * messen — dann sagt Stufe (ii) nichts, statt zu raten. Eine Stelle, damit Ausgabe und
 * Entscheidung dieselbe Antwort benutzen. */
function textAmVon(e) {
  const roh = e && e.text_am;
  if (!roh) return null;
  const ms = Date.parse(roh);
  return Number.isFinite(ms) ? ms : null;
}

let pflanzen = [];
if (fs.existsSync(DB_DATEI)) {
  const db = new Database(DB_DATEI, { readonly: true });
  pflanzen = db.prepare('SELECT id, name_deutsch, name_botanisch FROM pflanzen').all();
  db.close();
}

/* Namen laengste zuerst: Sonst gewaenne „Storchschnabel" gegen „Blut-Storchschnabel", und
 * die Beschreibung schiene eine Pflanze zu nennen, die gar nicht dasteht. Derselbe Grund wie
 * bei sorteAus() in pin-sorten.js. */
const NAMEN = [];
const nachName = new Map();
for (const p of pflanzen) {
  for (const n of [p.name_deutsch, p.name_botanisch]) {
    const name = String(n || '').trim();
    if (name.length < 4) continue;
    if (!nachName.has(name)) { nachName.set(name, []); NAMEN.push(name); }
    nachName.get(name).push(p.id);
  }
}
NAMEN.sort((a, b) => b.length - a.length);

const istBuchstabe = c => /[A-Za-zÄÖÜäöüß]/.test(c || '');

/* Welche Pflanzen nennt dieser Text? Gefunden wird ueber die Namen aus der Datenbank; jeder
 * Treffer wird im Arbeitstext ausgeblendet, damit ein darin enthaltener kuerzerer Name nicht
 * ein zweites Mal zaehlt. */
function genannt(text) {
  let rest = String(text || '');
  const treffer = [];
  for (const name of NAMEN) {
    /* ALLE Vorkommen ausblenden, nicht nur das erste.
     *
     * Ein Pflanzenname steht in einer Pin-Beschreibung regelmaessig ZWEIMAL: einmal in der
     * Aufzaehlung und einmal im Giftsatz ("Giftig: Stinkende Nieswurz, Wulfens Wolfsmilch,
     * Weinraute"). Wurde nur das erste Vorkommen geschwaerzt, blieb das zweite stehen, und
     * darin traf der kuerzere Name einer ANDEREN Art: "Wolfsmilch" (Euphorbia characias,
     * id 39) fand sich in "Wulfens Wolfsmilch" (id 295). Die Pruefung meldete daraufhin 58
     * Pins als abweichend, deren Beschreibung die Bildpflanzen exakt nennt — und eine
     * Pruefung, die Richtiges anzeigt, wird abgeschaltet.
     *
     * Die Laengensortierung oben genuegt dafuer nicht: Sie entscheidet, WER zuerst trifft,
     * nicht wie viele Vorkommen verschwinden. */
    let gefunden = false;
    for (;;) {
      const i = rest.indexOf(name);
      if (i < 0) break;
      if (istBuchstabe(rest[i - 1]) || istBuchstabe(rest[i + name.length])) {
        // Teil eines laengeren Wortes: ueberspringen, aber nicht abbrechen — weiter hinten
        // kann derselbe Name frei stehen. Ausgeblendet wird mit einem Zeichen, das
        // istBuchstabe() nicht als Buchstaben zaehlt und das in Beschreibungen nicht vorkommt.
        rest = rest.slice(0, i) + '\u0000'.repeat(name.length) + rest.slice(i + name.length);
        continue;
      }
      gefunden = true;
      rest = rest.slice(0, i) + ' '.repeat(name.length) + rest.slice(i + name.length);
    }
    if (gefunden) treffer.push({ name, ids: nachName.get(name) });
  }
  return treffer;
}

/* Der Bildkommentar. Gelesen wird mit demselben Segmentleser, der auch die KI-Kennzeichnung
 * findet (pin-ki-metadaten.js) — ein zweiter JPEG-Leser waere eine zweite Fassung derselben
 * Ableitung. COM ist Marker 0xFE. */
function bildKommentar(pfad) {
  const buf = fs.readFileSync(pfad);
  const segs = kiMeta.segmente(buf);
  if (!segs) return { fehlt: true, grund: 'keine JPEG-Datei' };
  const com = segs.filter(s => s.marker === 0xFE && s.nutz);
  if (!com.length) return { fehlt: true, grund: 'kein COM-Segment' };
  const roh = com.map(s => s.nutz.toString('utf8')).join('\n').trim();
  try {
    const o = JSON.parse(roh);
    if (!Array.isArray(o.ids)) return { fehlt: true, grund: 'COM-Segment ohne ids' };
    return { fehlt: false, guid: o.guid || null, ids: o.ids.map(Number), erzeugt_am: o.erzeugt_am || null };
  } catch {
    return { fehlt: true, grund: 'COM-Segment ist kein JSON' };
  }
}

// ─── Selbsttest ──────────────────────────────────────────────────────────────
/*
 *   node scripts/check-pin-deckung.js --selbsttest
 *
 * Belegt, dass die beiden eigenen Bausteine tun, was sie sollen: der Namensleser und der
 * Leser des Bildkommentars. Braucht keine Pins und laeuft deshalb auch auf dem Arbeitsplatz.
 * Er belegt NICHT, dass die Pins in Ordnung sind — nur, dass der Melder anschlagen kann.
 *
 * Zum Namensleser: Er verlaesst sich darauf, dass in der Beschreibung genau die Namen
 * stehen, die auch in der Datenbank stehen (pin-text.js setzt name_deutsch ein). Deshalb
 * reicht „laengster Name zuerst, Treffer ausblenden": Steht „Blut-Storchschnabel" im Text,
 * wird er als Ganzes erkannt, und „Storchschnabel" kann darin nicht noch einmal zaehlen.
 */
if (SELBSTTEST) {
  let schlecht = 0;
  const pruefe = (name, bedingung) => {
    if (!bedingung) schlecht++;
    console.log(`${bedingung ? 'ok            ' : 'FEHLGESCHLAGEN'} ${name}`);
  };
  /* Erfundene Namen statt Namen aus der Datenbank: Nur so laesst sich der Fall stellen, auf
   * den es ankommt — ein Name, der einen anderen enthaelt. Ausserdem laeuft der Selbsttest
   * damit auch ohne Datenbank, also auf einem CI-Runner. */
  for (const [name, id] of [['Blut-Storchschnabel', 9001], ['Storchschnabel', 9002], ['Pfingst-Nelke', 9003]]) {
    if (!nachName.has(name)) { nachName.set(name, []); NAMEN.push(name); }
    nachName.get(name).push(id);
  }
  NAMEN.sort((a, b) => b.length - a.length);

  const gefunden = t => genannt(t).map(x => x.name);
  pruefe('einfacher Name wird erkannt', gefunden('Sechs Stauden: Pfingst-Nelke, dazu Graeser.').includes('Pfingst-Nelke'));
  pruefe('laengerer Name gewinnt gegen den enthaltenen',
    gefunden('Im Beet: Blut-Storchschnabel und Funkien.').join() === 'Blut-Storchschnabel');
  pruefe('der kurze Name wird fuer sich erkannt', gefunden('Storchschnabel blueht lange.').includes('Storchschnabel'));
  pruefe('Name mit Buchstaben davor wird NICHT erkannt', gefunden('WortStorchschnabel blueht').length === 0);
  pruefe('leerer Text nennt niemanden', genannt('').length === 0);

  /* Kleinste denkbare JPEG-Datei mit genau diesem COM-Segment, gelesen und wieder geloescht.
   * Zweimal gebraucht: einmal mit einem von Hand geschriebenen Kommentar (belegt, dass der
   * Leser das Format versteht), einmal mit dem, den die Bildbauer wirklich schreiben. */
  const alsKommentar = inhalt => {
    const nutz = Buffer.from(inhalt, 'utf8');
    const kopf = Buffer.alloc(4);
    kopf.writeUInt16BE(0xFFFE, 0);
    kopf.writeUInt16BE(nutz.length + 2, 2);
    const probe = path.join(require('os').tmpdir(), `pin-deckung-selbsttest-${process.pid}.jpg`);
    fs.writeFileSync(probe, Buffer.concat([Buffer.from([0xFF, 0xD8]), kopf, nutz, Buffer.from([0xFF, 0xD9])]));
    try { return bildKommentar(probe); } finally { fs.unlinkSync(probe); }
  };

  const k = alsKommentar(JSON.stringify({ guid: 'saison-12', ids: [1, 2, 3], erzeugt_am: '2026-09-21T10:45:00Z' }));
  pruefe('Bildkommentar wird gelesen', !k.fehlt && k.guid === 'saison-12' && k.ids.join() === '1,2,3');

  /* SCHREIBER UND LESER, FELD FUER FELD.
   *
   * Gebaut wird mit demselben Baustein, den pin-saison.js, pin-kombination.js und pin-bild.js
   * an ihre ImageMagick-Argumente haengen: bildKommentarArgs() in pin-layout.js. Eine hier
   * nachgeschriebene Fassung belegte nur, dass dieser Selbsttest zu sich selbst passt. So
   * faellt auf, wenn dort ein Feld umbenannt wird — der Kommentar landete weiterhin in der
   * Datei, und diese Pruefung laese still nichts mehr daraus, also wieder "nicht pruefbar".
   * Der Baustein ruft ImageMagick nicht auf; der Selbsttest laeuft damit auch auf einem
   * CI-Runner ohne Bildwerkzeug. */
  const gebaut = L.bildKommentarArgs({ guid: 'saison-12', ids: [11, 22, 33] });
  pruefe('der Bildkommentar wird als ImageMagick-Argument "-set comment" gebaut',
    gebaut.length === 3 && gebaut[0] === '-set' && gebaut[1] === 'comment');
  const g = alsKommentar(gebaut[2]);
  pruefe('was die Bildbauer schreiben, liest diese Pruefung Feld fuer Feld',
    !g.fehlt && g.guid === 'saison-12' && g.ids.join() === '11,22,33'
    && Number.isFinite(Date.parse(g.erzeugt_am)));
  const ohneKennung = alsKommentar(L.bildKommentarArgs({ ids: [7] })[2]);
  pruefe('ohne Kennung bleiben die IDs lesbar — guid ist hier ausdruecklich optional',
    !ohneKennung.fehlt && ohneKennung.guid === null && ohneKennung.ids.join() === '7');
  /* Die andere Richtung: Ein Kommentar ohne ids liest sich als "COM-Segment ohne ids", also
   * wieder als nicht pruefbar. Deshalb entsteht er gar nicht erst. */
  let warfOhneIds = false;
  try { L.bildKommentarArgs({ ids: [] }); } catch { warfOhneIds = true; }
  pruefe('ohne IDs entsteht gar kein Kommentar, statt eines Kommentars ohne Aussage', warfOhneIds);

  const keinBild = path.join(require('os').tmpdir(), `pin-deckung-selbsttest-${process.pid}.txt`);
  fs.writeFileSync(keinBild, 'kein JPEG');
  const leer = bildKommentar(keinBild);
  fs.unlinkSync(keinBild);
  pruefe('Datei ohne Bildkommentar wird als fehlend gemeldet', leer.fehlt === true);

  /* Der Zeitstempel des Textes. Der wichtige Fall ist der ERSTE: Ohne text_am darf Stufe (ii)
   * nichts messen. Vorher stand dort die Schreibzeit von liste.json, und damit bekam im
   * Normalbetrieb jede nicht neu gebaute Datei einen Fehler. */
  pruefe('ohne text_am gibt es nichts zu messen',
    textAmVon({}) === null && textAmVon({ text_am: null }) === null && textAmVon({ text_am: 'kein Datum' }) === null);
  pruefe('ein gueltiges text_am wird gelesen',
    textAmVon({ text_am: '2026-09-21T13:14:00Z' }) === Date.parse('2026-09-21T13:14:00Z'));

  console.log(schlecht ? `--- Selbsttest FEHLGESCHLAGEN (${schlecht}) ---` : '--- Selbsttest bestanden ---');
  process.exit(schlecht ? 1 : 0);
}

// ─── Lauf ────────────────────────────────────────────────────────────────────
console.log('--- Pruefung: Deckung von Pin-Bild und Pin-Beschreibung ---');
console.log(`Liste: ${LISTE} (${liste.length} Eintraege, zuletzt geschrieben ${new Date(listeGeschrieben).toISOString()})`);
const mitTextAm = liste.filter(e => textAmVon(e)).length;
console.log(`Eintraege mit eigenem Textzeitstempel (text_am): ${mitTextAm} von ${liste.length}`
  + (mitTextAm ? '' : ' — Stufe (ii) kann damit nichts messen; das Feld setzt bauen() in pins-erzeugen.js'));

/* Geprueft werden die Sorten, deren Bild Pflanzen zeigt. Das sind heute genau die Sorten aus
 * KI_PIN_SORTEN (pin-layout.js): Jedes Pflanzenbild im Pin-Pool ist selbst erzeugt, die
 * uebrigen Sorten zeichnen eine Beetskizze oder sind reine Typografie. Die Liste wird von
 * dort gelesen und nicht hier nachgebaut. Bekaeme eine Sorte je ein FOTO einer Pflanze,
 * faellt sie aus KI_PIN_SORTEN heraus und muesste hier ausdruecklich aufgenommen werden —
 * deshalb steht diese Kopplung als Satz hier und nicht nur im Code. */
const SORTEN = new Set(L.KI_PIN_SORTEN);

for (const e of liste) {
  if (!e || !e.datei || !SORTEN.has(e.typ)) continue;
  if (S.istVeroeffentlicht(e, HEUTE)) continue;            // draussen, nicht mehr zu aendern
  const wo = e.guid || e.datei;
  const pfad = path.join(ZIEL, e.datei);
  if (!fs.existsSync(pfad)) { FEHLER(wo, `Bilddatei fehlt (${e.datei}).`); continue; }
  geprueft++;

  /* Die Seite des TEXTES: bei der Sorte saison stehen die IDs im Eintrag, sonst werden die
   * Namen aus der Beschreibung gelesen. Beide stammen aus dem Textlauf — das ist der Punkt:
   * Verglichen wird gegen das Bild, nicht Text gegen Text. */
  const ausEintrag = Array.isArray(e.pflanzen) && e.pflanzen.length
    ? e.pflanzen.map(x => Number(x && x.id !== undefined ? x.id : x)).filter(n => Number.isFinite(n))
    : null;
  const ausText = genannt(e.beschreibung);

  const k = bildKommentar(pfad);
  if (!k.fehlt) {
    belegt++;
    if (k.guid && e.guid && k.guid !== e.guid) {
      FEHLER(wo, `das Bild traegt die Kennung „${k.guid}", der Eintrag heisst „${e.guid}" — die Datei gehoert zu einem anderen Pin.`);
      continue;
    }
    const imBild = new Set(k.ids);
    if (ausEintrag) {
      const fehlen = ausEintrag.filter(id => !imBild.has(id));
      const zuviel = k.ids.filter(id => !ausEintrag.includes(id));
      if (fehlen.length || zuviel.length) {
        FEHLER(wo, `Text und Bild zeigen verschiedene Pflanzen — im Text und nicht im Bild: [${fehlen.join(', ')}], im Bild und nicht im Text: [${zuviel.join(', ')}].`);
        continue;
      }
    }
    const daneben = ausText.filter(t => !t.ids.some(id => imBild.has(id)));
    if (daneben.length) {
      FEHLER(wo, `die Beschreibung nennt ${daneben.map(t => `„${t.name}"`).join(', ')} — auf dem Bild ist diese Pflanze nicht zu sehen (Bild-IDs: ${k.ids.join(', ')}).`);
      continue;
    }
    if (!ausEintrag && !ausText.length) {
      UNGEPRUEFT(wo, 'die Beschreibung nennt keinen Pflanzennamen aus der Datenbank — Bildkommentar vorhanden, aber nichts zu vergleichen.');
      continue;
    }
    continue;                                              // Stufe (i) bestanden
  }

  /* Stufe (ii): ohne Bildkommentar entscheidet die Zeit — aber nur gegen einen Zeitstempel,
   * der zu DIESEM Eintrag gehoert. Ist die Datei deutlich aelter als der Text dieses Pins,
   * wurde sie in dem Lauf, der den Text gebildet hat, nicht gebaut: Text und Bild stammen
   * dann aus verschiedenen Auswahlen, und genau so ist der Vorfall entstanden.
   *
   * Ohne text_am wird NICHT ersatzweise gegen die Schreibzeit von liste.json gemessen. Die
   * Liste wird bei jedem Lauf neu geschrieben, die Bilddateien bleiben ohne --neu stehen —
   * jede nicht neu gebaute Datei waere dann „aelter als der Textlauf", ohne dass irgendetwas
   * auseinandergelaufen ist. Die Begruendung steht ausfuehrlich im Kopf dieser Datei. */
  const textAm = textAmVon(e);
  if (textAm === null) {
    UNGEPRUEFT(wo, `kein Bildkommentar (${k.grund}) und kein Textzeitstempel (text_am fehlt im Listeneintrag)`
      + ' — weder Stufe (i) noch Stufe (ii) hat hier etwas zu vergleichen.');
    continue;
  }
  const alter = (textAm - fs.statSync(pfad).mtimeMs) / 60000;
  if (alter > TOLERANZ_MIN) {
    FEHLER(wo, `Bild ${Math.round(alter)} Minuten aelter als der Text dieses Pins (text_am ${e.text_am}, Grenze ${TOLERANZ_MIN}) und ohne Bildkommentar (${k.grund}) — Bild und Beschreibung stammen aus verschiedenen Laeufen. Eine liegende Datei bekommt den Bildkommentar nur durch einen Neubau: node scripts/pins-erzeugen.js --neu-unveroeffentlicht`);
    continue;
  }
  UNGEPRUEFT(wo, `kein Bildkommentar (${k.grund}); die Zeiten passen zwar zusammen, geprueft ist damit aber nichts.`);
}

// ─── Bilanz ──────────────────────────────────────────────────────────────────
console.log('---');
console.log(`Geprueft: ${geprueft} noch nicht faellige Pins mit Pflanzenbild, davon ${belegt} mit Bildkommentar`);
console.log(`Befunde: ${fehler} Fehler, ${ungeprueft} nicht pruefbar`);
if (geprueft < MIN_PINS) {
  console.error(`FEHLER: Nur ${geprueft} Pins gesehen (Mindestzahl ${MIN_PINS}).`);
  console.error('Diese Pruefung muss dort laufen, wo public/pins/ wirklich gefuellt ist — auf dem Server');
  console.error('oder nach einem vollstaendigen Lauf von scripts/pins-erzeugen.js. Ein Lauf ohne Pins');
  console.error('belegt nichts.');
  fehler++;
}
if (ungeprueft > 0) {
  console.error(`FEHLER: ${ungeprueft} Pins sind nicht pruefbar. Ohne Bildkommentar ist die Deckung von`);
  console.error('Bild und Text nicht belegt. Geschrieben wird er beim BAUEN des Bildes; eine liegende');
  console.error('Datei bekommt ihn nur durch einen Neubau:');
  console.error('  node scripts/pins-erzeugen.js --neu-unveroeffentlicht');
  console.error('Der Schalter laesst die Bilder der veroeffentlichten Pins unangetastet. Ihn nicht zu');
  console.error('benutzen und stattdessen den Kommentar in die fertige Datei zu schreiben, faerbte diese');
  console.error('Pruefung gruen, ohne etwas zu belegen — siehe Kopf dieser Datei.');
  console.error('„Nicht pruefbar" ist der ehrliche Zustand — kein Befund gegen die gemeldeten Pins.');
  fehler++;
}
process.exit(fehler > 0 ? 1 : 0);
