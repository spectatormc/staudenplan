/*
 * Erzeugt einen Pinterest-Pin (1000 × 1500) zur Jahreszeit: sechs Pflanzen als Bildraster
 * mit Namen und Giftmarkierung.
 *
 *   node scripts/pin-saison.js                          aktueller Monat
 *   node scripts/pin-saison.js --monat 10 --standort sonne [ziel.jpg]
 *   node scripts/pin-saison.js --monat 12               Winterfassung
 *   node scripts/pin-saison.js --thema graeser          Winterfassung zu einer Blattform
 *   node scripts/pin-saison.js --liste                  alle Pins dieser Sorte zeigen, nichts erzeugen
 *
 * WARUM ZWEI FASSUNGEN — und warum das VOR dem Bauen geprüft gehört:
 * Ein reiner „Was blüht jetzt"-Pin fällt vier Monate im Jahr aus. Gezählt über alle
 * Pflanzen mit eigenem Bild und echtem deutschen Namen:
 *
 *   Jan 1   Feb 3   Mär 11   Apr 34   Mai 74   Jun 144
 *   Jul 172 Aug 155 Sep 99   Okt 32   Nov 0    Dez 0
 *
 * November und Dezember haben KEINE blühende Art. Ein Zeitplan, der stur jeden Monat
 * „Was blüht jetzt" postet, läuft im November ins Leere — und zwar unbeaufsichtigt.
 * Deshalb übernimmt von November bis Februar der `winteraspekt`: 131 Pflanzen mit
 * dekorativem Samenstand, Gräserstruktur, immergrünem oder wintergrünem Laub. Das ist
 * gärtnerisch der richtige Inhalt für die Zeit — im Winterbeet zählt Struktur, nicht Blüte.
 *
 * WARUM MEHRERE PINS JE MONAT (seit 08.09.2026): Die Sechser-Raster sind mit Abstand die
 * reichweitenstärksten Pins des Kontos — drei Winterbeet-Raster hatten nach drei Wochen
 * 1000, 727 und 709 Aufrufe, die Einzelpflanzen einen Bruchteil davon. Es gab aber nur zwölf.
 * alleSaisonPins() baut deshalb je Blühmonat zusätzlich eine Fassung je Standort und für den
 * Winter je Blattform (Samenstände, Gräser, Immergrün, wintergrüne Rosetten). Zwei Regeln
 * halten das ehrlich: Eine Fassung bevorzugt Pflanzen, die in den Pins derselben Gruppe noch
 * nicht vorkommen (`meiden`), und wird verworfen, wenn sie trotzdem vier der sechs Kacheln
 * mit einem schon gebauten Pin teilt — Pinterest wertet Fast-Dubletten als Spam.
 *
 * Bewusst KEINE „aktuellen Trends": Ein unbeaufsichtigtes Skript, das auf Trends reagiert
 * und dazu Pflanzenaussagen im Namen der Gartenschmiede veröffentlicht, lässt sich nicht
 * wie eine Webseite per Deploy zurücknehmen. Der Kalender ist die belegbare Fassung
 * derselben Idee: Er wiederholt sich jedes Jahr und braucht keine externe Quelle.
 *
 * Nur selbst erzeugte KI-Bilder (bild_ki = 1), daher „Illustrationen" in der Fußzeile.
 */
const Database = require('better-sqlite3');
const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const { giftigkeit } = require('./pflanzen-giftigkeit');
const L = require('./pin-layout');

const WURZEL = path.join(__dirname, '..');
const { B, H, FONT, FONT_B, GRUEN, MON_NAME } = L;
const KOPF = 240, SPALTE = B / 2, ZEILE = 310, RASTER = 6;

// Winteraspekt-Werte, die tatsächlich etwas hermachen. „unauffällig" (140 Pflanzen) und die
// Prosa-Varianten über Einziehen und Wiederaustrieb gehören nicht dazu — die beschreiben,
// dass im Winter nichts zu sehen ist.
const WINTER_WERT = {
  'samenstand dekorativ': 'Samenstände bleiben stehen',
  'gräser struktur':      'Gräserstruktur im Winter',
  'blätter immergrün':    'immergrünes Laub',
  'rosetten wintergrün':  'wintergrüne Rosetten',
  'blätter halbimmergrün':'halbimmergrünes Laub',
  'struktur':             'Struktur im Winterbeet',
};

/*
 * Winterthemen: ein Pin je Blattform statt „irgendwas mit Winteraspekt". `werte` sind die
 * Schlüssel aus WINTER_WERT. „halbimmergrün" (13 Pflanzen) trägt kein eigenes Thema — unter der
 * Überschrift „immergrün" wäre ein Laub, das nur in milden Wintern bleibt, eine Übertreibung.
 *
 * Die Sätze stehen hier fest und gelten für Bild, Pin-Beschreibung UND Landeseite — eine
 * Quelle, damit die drei nicht auseinanderlaufen. Keine Sprachmodell-Texte (siehe pin-text.js).
 */
const THEMA = {
  samenstaende: {
    werte: ['samenstand dekorativ'],
    titel: 'Samenstände im Winterbeet',
    unter: ort => `6 Stauden${ort}, deren Samenstände stehen bleiben`,
    hinweis: 'Samenstände erst im Frühjahr zurückschneiden: Sie halten den Winter über Struktur und bieten Insekten Quartier.',
    pinTitel: ort => [`Samenstände im Winterbeet: 6 Stauden${ort}, die stehen bleiben dürfen`,
                      `Winterbeet: 6 Stauden${ort} mit dekorativen Samenständen`],
    satz: 'sechs Stauden, deren Samenstände den Winter über stehen bleiben.',
  },
  graeser: {
    werte: ['gräser struktur'],
    titel: 'Gräser im Winterbeet',
    unter: ort => `6 Gräser${ort}, die im Winter Struktur halten`,
    hinweis: 'Gräser erst im Frühjahr zurückschneiden: Die Halme halten den Winter über Struktur und schützen die Pflanze vor Nässe und Frost.',
    pinTitel: ort => [`Gräser im Winterbeet: 6 Ziergräser${ort}, die im Winter Struktur halten`,
                      `Winterbeet: 6 Gräser${ort} mit Winterstruktur`],
    satz: 'sechs Gräser, die den Winter über stehen bleiben.',
  },
  immergruen: {
    werte: ['blätter immergrün'],
    titel: 'Immergrün im Winterbeet',
    unter: ort => `6 Stauden${ort}, die ihr Laub im Winter behalten`,
    hinweis: 'Immergrüne Stauden nicht im Herbst schneiden — im Frühjahr nur die abgestorbenen Blätter entfernen.',
    pinTitel: ort => [`Immergrüne Stauden fürs Winterbeet: 6 Arten${ort}, die ihr Laub behalten`,
                      `Winterbeet: 6 immergrüne Stauden${ort}`],
    satz: 'sechs Stauden, die ihr Laub im Winter behalten.',
  },
  wintergruen: {
    werte: ['rosetten wintergrün'],
    titel: 'Wintergrüne Rosetten',
    unter: ort => `6 Stauden${ort}, die im Winter grün bleiben`,
    hinweis: 'Wintergrüne Rosetten nicht abschneiden: Sie bleiben den Winter über grün und werden im Frühjahr vom neuen Laub abgelöst.',
    pinTitel: ort => [`Wintergrüne Stauden: 6 Arten${ort}, die im Winter grün bleiben`,
                      `Winterbeet: 6 Stauden${ort} mit wintergrünen Rosetten`],
    satz: 'sechs Stauden mit wintergrünen Blattrosetten.',
  },
};

/*
 * DIE EINE ABLEITUNG „WAS MACHT DIESE PFLANZE IM WINTER".
 *
 * ZWEI Ausgabepfade stellen dieselbe Frage und bekommen hier dieselbe Antwort: das
 * Sechser-Raster (zweite Zeile unter der Kachel) und der Winter-Pin der Einzelpflanze
 * (Faktenzeile im Bild UND Titel plus Beschreibung im Text). Liefen sie auseinander,
 * behauptete ein Ausgabepfad etwas, das der andere nicht sagt.
 *
 * DIE LANDESEITE GEHÖRT NICHT DAZU — OFFENER BEFUND, NICHT ERLEDIGT. Die Saison-Winterpins
 * zeigen auf /winterbeet/<thema> und tragen ihre Zeilen aus liste.json mit; dort stimmt es.
 * Die Winterfassung der Einzelpflanze zeigt dagegen auf /pflanze/<slug> (pin-text.js), und
 * diese Route gibt `winteraspekt` an keiner Stelle aus — nachgesehen, kein Treffer im ganzen
 * Routenkörper. Sie zeigt stattdessen einen Fließtext-Abschnitt „Überwinterung" aus
 * inhalt_lang, der mit WINTER_WERT nichts zu tun hat. Der Pin-Titel „<Pflanze> im Winterbeet:
 * Samenstände bleiben stehen" verspricht damit etwas, das die verlinkte Seite an keiner Stelle
 * einlöst. Geschlossen wird das in stauden-server.js (ein Abschnitt aus WINTER_WERT auf der
 * Pflanzenseite); bis dahin steht es hier, damit es niemand für erledigt hält.
 *
 * `winteraspekt` wird dabei NUR über die exakten Schlüssel aus WINTER_WERT gelesen. Die Spalte
 * enthält daneben „unauffällig" (128 Pflanzen) und rund 22 frei formulierte Sätze („die
 * Pflanze zieht sich im Winter zurück …"). Diese Prosa wird NICHT nach Stichwörtern
 * durchsucht: Genau so ist im Projekt schon einmal eine Gruppierung von Pflegetexten über
 * Schlagwörter entstanden, die Arten falsch einsortiert hat. Was nicht exakt in der Liste
 * steht, fällt weg — eine Pflanze ohne Winterpin ist harmlos, ein falscher Winterpin nicht.
 */
const winterSchluessel = p => String((p && p.winteraspekt) || '').trim().toLowerCase();
const winterAspekt = p => WINTER_WERT[winterSchluessel(p)] || null;

/* Das Winterthema einer Pflanze (Schlüssel von THEMA) — oder null. Die Zuordnung steht in
 * THEMA[..].werte und wird hier nur umgedreht, damit sie auch für eine einzelne Pflanze
 * gilt. „blätter halbimmergrün" trägt bewusst kein Thema; solche Pflanzen bekommen einen
 * Winter-Pin, aber keinen Pflegehinweis, statt einen, der für sie nicht stimmt. */
const winterThema = p => Object.keys(THEMA).find(k => THEMA[k].werte.includes(winterSchluessel(p))) || null;
const winterHinweis = p => { const t = winterThema(p); return t ? THEMA[t].hinweis : null; };

const STANDORTE = ['sonne', 'halbschatten', 'schatten'];
const ORT     = { sonne: 'für die Sonne', halbschatten: 'für den Halbschatten', schatten: 'für den Schatten' };
const ORT_IN  = { sonne: 'in der Sonne',  halbschatten: 'im Halbschatten',      schatten: 'im Schatten' };
const MON_SLUG = ['januar', 'februar', 'maerz', 'april', 'mai', 'juni', 'juli', 'august',
                  'september', 'oktober', 'november', 'dezember'];

// Ab so vielen gemeinsamen Kacheln gilt eine Fassung als Dublette eines anderen Pins.
const DOPPEL_AB = 4;

/*
 * `bild_ki` steht in der WHERE-Bedingung UND in der Spaltenliste. Das ist keine Doppelung:
 * Die Bedingung wählt aus, die Spalte belegt die Auswahl für spätere Schritte. Aus diesem
 * Lader stammen die Bilder der Saison-Raster UND der Einzelpflanzen-Pins (pins-erzeugen.js),
 * und beide bekommen danach eine maschinenlesbare KI-Kennzeichnung ins JPEG geschrieben.
 * Wer diese Kennzeichnung setzt, muss sie belegen können, statt sie aus dem Sortennamen zu
 * schließen — siehe kiHerkunftFehler() in pin-layout.js.
 *
 * Die Bildspalten kommen als BILD_SPALTEN_SQL aus scripts/bild-herkunft.js, damit diese
 * Abfrage keines der Herkunftsfelder vergessen kann. `bild_lizenz` gehört dazu: Ohne sie
 * liefe die Gegenprobe ins Leere — sie prüft bild_ki gegen Lizenz und Dateinamen und kann
 * einen Widerspruch nur melden, wenn das Feld überhaupt geladen ist (id 698).
 */
function ladePflanzen(db) {
  /* Das Winterbild (bild_winter_url) gehört in DIESE Spaltenliste, weil aus diesem Lader die
   * Pflanzen der Winter-Pins stammen (pins-erzeugen.js, Sorte pflanze-winter). Fehlte die
   * Spalte hier, sähe in pin-bild.js jede Pflanze aus wie eine ohne Winterbild: Der Rückfall
   * auf bild_url griffe bei allen 163 Winter-Pins, ohne eine einzige Meldung, und die
   * bezahlten Bilder lägen ungenutzt auf der Platte. Genau deshalb unterscheidet
   * winterBildQuelle() „Feld nicht geladen" von „Feld leer" und wirft im ersten Fall.
   *
   * Der Name der Spalte kommt aus winterbild-auftrag.js — erst HIER geholt, nicht am
   * Dateianfang: Jenes Modul requirt dieses (für WINTER_WERT), ein Require am Kopf wäre ein
   * Ring. Beim Aufruf ist es fertig geladen.
   *
   * NICHT in BILD_SPALTEN_SQL aufgenommen: Das ist die Spaltenliste der Bildherkunft für die
   * WEBSITE-Ausgabepfade (scripts/bild-herkunft.js). Das Winterbild erscheint dort nirgends,
   * nur im Pin. Die Begründung steht ausführlich bei der Migration in stauden-server.js. */
  const { WINTERBILD_SPALTE } = require('./winterbild-auftrag');
  return db.prepare(`SELECT id, name_deutsch, name_botanisch, farbe, licht, feuchtigkeit, bluehzeit,
                            hoehe_cm_max, winteraspekt, bienen_freundlich, heimisch, winterhart_zone, lebensdauer,
                            lebensbereich, ${L.BILD_SPALTEN_SQL}, ${WINTERBILD_SPALTE}
                     FROM pflanzen WHERE bild_ki = 1 AND bild_url IS NOT NULL`).all()
           .filter(L.hatDeutschenNamen)
           .filter(L.istBeetpflanze)
           .filter(L.istWinterhartHier)
           .filter(p => fs.existsSync(path.join(WURZEL, 'public', p.bild_url.replace(/^\//, ''))));
}

/*
 * Adresse der Landeseite. Seit 08.09.2026 zeigt jeder Saison-Pin auf eine eigene Seite mit genau
 * seinen sechs Pflanzen (stauden-server.js: /blueht-im/… und /winterbeet/…) statt auf die
 * allgemeine Planer-Anleitung. Wer „Struktur im Winterbeet" antippt, will die sechs Stauden
 * sehen — und bekam sieben Schritte zur Beetplanung.
 */
function saisonPfad(s) {
  const st = s.standort ? `-${s.standort}` : '';
  return s.winter
    ? `/winterbeet/${s.thema || MON_SLUG[s.monat - 1]}${st}`
    : `/blueht-im/${MON_SLUG[s.monat - 1]}${st}`;
}

/*
 * Kennung und Dateiname. Die zwölf Grundpins behalten ihre alten Namen (saison-9, saison-09.jpg):
 * Die Kennung ist die guid im Feed, und was Pinterest einmal kennt, darf nicht umbenannt werden.
 */
function saisonKennung(s) {
  const st = s.standort ? `-${s.standort}` : '';
  if (s.thema) return { guid: `saison-winter-${s.thema}${st}`, datei: `saison-winter-${s.thema}${st}.jpg` };
  return { guid: `saison-${s.monat}${st}`, datei: `saison-${String(s.monat).padStart(2, '0')}${st}.jpg` };
}

/*
 * Überschrift, Unterzeile und Einordnungssatz — dieselben Worte auf dem Bild, im Feed-Text und
 * auf der Landeseite. Das Bild zeigt die Pflanzen blühend; deshalb sagt die Winter-Unterzeile,
 * was die Pflanze NACH der Blüte tut, nicht „ohne Blüte".
 *
 * DER ZWEITE AUSGABEPFAD DESSELBEN PROBLEMS — OFFENER BEFUND, NICHT ERLEDIGT (22.09.2026):
 * „denn andere Bilder gibt es nicht" stimmt seit diesem Tag nicht mehr. Ein Teil der Pflanzen
 * hat ein eigenes Winterbild (Spalte bild_winter_url, scripts/winterbilder-erzeugen.js). Die
 * EINZELPFLANZEN-Winterpins benutzen es (pin-bild.js, Wintermodus); die Sechser-Raster hier
 * NICHT — saisonPin() zeichnet weiterhin x.p.bild_url in jede Kachel. Das ist bewusst so
 * gelassen und kein Versehen: Ein Winterraster wäre sonst gemischt, solange nicht alle sechs
 * Pflanzen ein Winterbild haben, und mehrere dieser Raster sind bereits veröffentlicht — ihr
 * Bild liegt bei Pinterest, ihre Landeseite zeigt genau diese Auswahl. Wer das nachzieht,
 * muss beides zugleich lösen (Deckung des Winterbild-Bestands je Raster, und nur
 * unveröffentlichte Raster anfassen). Bis dahin bleibt die Unterzeile richtig, weil sie vom
 * Zustand NACH der Blüte spricht und nicht behauptet, das Bild zeige ihn.
 */
function saisonKopf(s) {
  const th = s.thema ? THEMA[s.thema] : null;
  const ort = s.standort ? ` ${ORT[s.standort]}` : '';
  const monat = MON_NAME[s.monat - 1];
  if (th) return { titel: th.titel, unter: th.unter(ort), hinweis: th.hinweis };
  if (s.winter) return {
    titel: 'Struktur im Winterbeet',
    unter: `6 Stauden${ort}, die nach der Blüte Struktur halten`,
    hinweis: 'Samenstände und Gräser erst im Frühjahr zurückschneiden: Sie halten den Winter über Struktur und bieten Insekten Quartier.',
  };
  return {
    titel: `Was im ${monat} blüht`,
    unter: `6 Stauden ${s.standort ? ORT[s.standort] : 'für Beet und Rabatte'}`,
    hinweis: s.standort
      ? `Alle sechs blühen im ${monat} und gedeihen ${ORT_IN[s.standort]} — Höhe und Standort stehen dabei, damit sie sich einplanen lassen.`
      : `Alle sechs blühen im ${monat} — Höhe und Standort stehen dabei, damit sie sich einplanen lassen.`,
  };
}

/*
 * Stellt die Auswahl für einen Monat zusammen. `versatz` verschiebt die Auswahl, damit
 * derselbe Monat im nächsten Jahr — oder ein zweiter Pin im selben Monat — andere Pflanzen
 * zeigt, ohne dass dafür ein Zufallsgenerator nötig wäre.
 *
 * `thema` schränkt die Winterfassung auf eine Blattform ein (Schlüssel von THEMA).
 * `meiden` (Set aus Pflanzen-IDs) rückt Pflanzen ans Ende der Rangfolge, ohne sie
 * auszuschließen: Eine Standortfassung soll andere Arten zeigen als der Grundpin des Monats,
 * aber lieber eine Wiederholung als ein leeres Feld.
 */
function saisonAuswahl(pflanzen, { monat, standort, versatz = 0, thema = null, meiden = null } = {}) {
  const winter = monat >= 11 || monat <= 2;
  const th = thema ? THEMA[thema] : null;
  if (thema && !th) throw new Error(`Unbekanntes Winterthema: ${thema}`);
  if (thema && !winter) throw new Error(`Thema ${thema} gibt es nur in der Winterfassung, nicht für Monat ${monat}`);

  let kandidaten;
  if (winter) {
    kandidaten = pflanzen
      .map(p => ({ p, wert: winterSchluessel(p), aspekt: winterAspekt(p) }))
      .filter(x => x.aspekt && (!th || th.werte.includes(x.wert)))
      .map(x => ({ p: x.p, zeile2: x.aspekt }));
  } else {
    kandidaten = pflanzen
      .filter(p => L.bluehtIm(p.bluehzeit, monat))
      .map(p => ({ p, zeile2: String(p.bluehzeit).replace(/\s*-\s*/, ' – ') }));
  }
  if (standort) kandidaten = kandidaten.filter(x => L.mengeAus(x.p.licht).has(standort));
  if (kandidaten.length < RASTER) return null;

  // Bewertung: heimisch und bienenfreundlich bevorzugt, im Blühmonat zusätzlich die Arten,
  // die GERADE ERST aufblühen — das ist die Nachricht, nicht „blüht schon seit Juni".
  const bewertet = kandidaten.map(x => {
    let punkte = (x.p.heimisch ? 2 : 0) + (x.p.bienen_freundlich ? 2 : 0);
    if (!winter) {
      const s = L.spanne(x.p.bluehzeit);
      if (s[0] === monat) punkte += 4;                      // beginnt jetzt
      if (s[1] === monat) punkte += 1;                      // letzter Monat
      // L.dauer() statt s[1] - s[0]: Für jede Spanne innerhalb des Jahres dasselbe Ergebnis
      // wie bisher, für „Dezember - März" 3 statt -9. Ohne das bekäme die Christrose im März
      // Minuspunkte dafür, dass sie lange blüht.
      punkte += Math.min(L.dauer(s), 4) * 0.3;              // lange Blüher sind nützlich
    }
    return { ...x, punkte };
  }).sort((a, b) => b.punkte - a.punkte || a.p.id - b.p.id);

  // Gemiedene ans Ende, in ihrer bisherigen Reihenfolge — stabil, damit derselbe Aufruf
  // dieselbe Auswahl ergibt.
  const rangfolge = meiden && meiden.size
    ? bewertet.filter(x => !meiden.has(x.p.id)).concat(bewertet.filter(x => meiden.has(x.p.id)))
    : bewertet;

  // Im Winter hängt die Auswahl an keinem Monat — ohne Verschiebung zeigten November,
  // Dezember, Januar und Februar viermal hintereinander exakt dieselben sechs Pflanzen.
  // Aus dem Monat abgeleitet statt zufällig, damit ein Pin reproduzierbar bleibt. Die
  // Themenfassungen brauchen das nicht: Sie unterscheiden sich durch die Blattform.
  const versch = (versatz || (winter && !thema ? (monat * 11) % rangfolge.length : 0)) % rangfolge.length;

  // Sechs auswählen, aber keine Gattung doppelt — sonst stehen sechs Storchschnäbel im Raster.
  // Und höchstens zwei Gräser: Unter „Was im August blüht" standen vier davon. Botanisch
  // richtig, aber wer die Überschrift liest, erwartet Blüten. Im Winterbeet sind Gräser
  // dagegen der Punkt, dort sind drei erlaubt — und im Gräser-Thema natürlich alle sechs.
  const grasGrenze = thema === 'graeser' ? RASTER : (winter ? 3 : 2);
  const gewaehlt = [], gattungen = new Set();
  let graeser = 0;
  const reihe = rangfolge.slice(versch).concat(rangfolge.slice(0, versch));
  for (const durchgang of [0, 1]) {                    // zweiter Durchgang hebt die Grenze auf
    for (const x of reihe) {
      if (gewaehlt.length === RASTER) break;
      if (gewaehlt.includes(x)) continue;
      const gattung = x.p.name_botanisch.split(' ')[0];
      if (gattungen.has(gattung)) continue;
      const gras = L.istGras(x.p);
      if (!durchgang && gras && graeser >= grasGrenze) continue;
      if (gras) graeser++;
      gattungen.add(gattung); gewaehlt.push(x);
    }
    if (gewaehlt.length === RASTER) break;             // sonst lieber Gräser als ein leeres Feld
  }
  if (gewaehlt.length < RASTER) return null;

  return { monat, winter, standort: standort || null, thema: thema || null, auswahl: gewaehlt };
}

/*
 * Alle Saison-Pins in fester Reihenfolge: zwölf Grundpins, dann je Blühmonat eine Fassung je
 * Standort, dann die Winterthemen mit ihren Standortfassungen. Fest, weil die Kennungen die
 * guids im Feed sind und sich zwischen zwei Läufen nicht ändern dürfen.
 *
 * Verworfen wird, was keine sechs Gattungen zusammenbringt oder vier Kacheln mit einem Pin
 * derselben Gruppe teilt (Gruppe = ein Blühmonat bzw. der ganze Winter). Verworfenes wird
 * zurückgegeben, nicht verschluckt — ein stiller Ausfall sähe im Feed genauso aus wie
 * „gab es nie".
 *
 * `fest` (guid → [{id, zeile2}]) sind die Pflanzen der bereits VERÖFFENTLICHTEN Pins aus der
 * alten Liste. Für die gilt: nicht neu berechnen, sondern aus diesen IDs wieder aufbauen, und
 * die Dublettenregel darf sie nicht mehr verwerfen. Der Pin ist draußen, sein Bild liegt bei
 * Pinterest und sein Link zeigt auf die Seite mit genau diesen sechs — kommt ein neues Bild in
 * den Pool oder ändert sich eine Winterhärte, darf die Seite nicht plötzlich andere zeigen.
 * Fehlt eine der sechs inzwischen im Pool, bleibt die Neuberechnung; pins-erzeugen.js hält
 * dann die alten IDs für die Seite fest und baut kein neues Bild.
 */
function alleSaisonPins(pool, { fest = new Map() } = {}) {
  const pins = [], verworfen = [], hinweise = [];
  const nachId = new Map(pool.map(p => [p.id, p]));
  const ids = s => s.auswahl.map(x => x.p.id);
  const gemieden = gruppe => new Set(gruppe.flatMap(e => e.ids));

  const hole = (opts) => {
    const s = saisonAuswahl(pool, opts);
    const grund = { monat: opts.monat, winter: opts.monat >= 11 || opts.monat <= 2, standort: opts.standort || null, thema: opts.thema || null };
    const alte = fest.get(saisonKennung(grund).guid);
    if (!alte) return s;
    const auswahl = alte.map(x => nachId.has(Number(x.id)) ? { p: nachId.get(Number(x.id)), zeile2: String(x.zeile2 || '') } : null);
    if (auswahl.length >= RASTER && auswahl.every(Boolean)) return { ...grund, auswahl, veroeffentlicht: true };
    return s ? { ...s, veroeffentlicht: true } : null;
  };

  const nimm = (s, gruppe, pruefen = true) => {
    const { guid, datei } = saisonKennung(s);
    const meine = ids(s);
    const doppel = pruefen && gruppe.find(g => meine.filter(id => g.ids.includes(id)).length >= DOPPEL_AB);
    if (doppel && s.veroeffentlicht) {
      hinweise.push({ guid, grund: `veröffentlicht, teilt ${DOPPEL_AB} oder mehr Pflanzen mit ${doppel.guid} — bleibt trotzdem` });
    } else if (doppel) {
      verworfen.push({ guid, grund: `teilt ${DOPPEL_AB} oder mehr Pflanzen mit ${doppel.guid}` });
      return null;
    }
    const eintrag = { guid, datei, s, ids: meine };
    pins.push(eintrag); gruppe.push(eintrag);
    return eintrag;
  };
  const fehlt = (teil, grund) => verworfen.push({ guid: saisonKennung(teil).guid, grund });

  // Grundpins: die bestehenden zwölf, ohne Meiden und ohne Dublettenprüfung — sie sind
  // veröffentlicht und bleiben, wie sie sind.
  const gruppen = {};
  const winterGruppe = [];
  for (let m = 1; m <= 12; m++) {
    const s = hole({ monat: m });
    if (!s) { fehlt({ monat: m }, 'zu wenige Kandidaten'); continue; }
    gruppen[m] = s.winter ? winterGruppe : [];
    nimm(s, gruppen[m], false);
  }

  // Standortfassungen der Blühmonate. Winter hat Themen statt Standorte.
  for (let m = 3; m <= 10; m++) {
    const gruppe = gruppen[m];
    if (!gruppe) continue;
    for (const standort of STANDORTE) {
      const s = hole({ monat: m, standort, meiden: gemieden(gruppe) });
      if (!s) { fehlt({ monat: m, standort }, 'zu wenige Kandidaten'); continue; }
      nimm(s, gruppe);
    }
  }

  // Winterthemen, je Thema zuerst die allgemeine Fassung, dann die Standorte.
  for (const thema of Object.keys(THEMA)) {
    const s = hole({ monat: 11, thema, meiden: gemieden(winterGruppe) });
    if (!s) { fehlt({ monat: 11, thema }, 'zu wenige Kandidaten'); continue; }
    if (!nimm(s, winterGruppe)) continue;              // Dublette des Grundpins: dann auch keine Standorte
    for (const standort of STANDORTE) {
      const sv = hole({ monat: 11, thema, standort, meiden: gemieden(winterGruppe) });
      if (!sv) { fehlt({ monat: 11, thema, standort }, 'zu wenige Kandidaten'); continue; }
      nimm(sv, winterGruppe);
    }
  }

  return { pins, verworfen, hinweise };
}

/*
 * 'guid' NUR ZUM MITSCHREIBEN IN DEN BILDKOMMENTAR (siehe bildKommentarArgs() in
 * pin-layout.js). Die Vorgabe ruft saisonKennung() auf — dieselbe und einzige Fassung der
 * Kennungsregel, die auch pins-erzeugen.js benutzt, kein Nachbau. Der Stapellauf reicht
 * trotzdem die Kennung des Listeneintrags herein: Dann steht im Bild genau die Kennung, unter
 * der es in liste.json gefuehrt wird, und eine vertauschte Datei faellt der Pruefung auf.
 */
function saisonPin(s, ziel, { guid = saisonKennung(s).guid } = {}) {
  const tmp = [];
  // Was wirklich ins Raster gezeichnet wird — eingesammelt in der Schleife, die es zeichnet,
  // nicht ein zweites Mal aus s.auswahl abgeleitet.
  const gezeichnet = [];
  const args = ['-size', `${B}x${H}`, `xc:${GRUEN}`, '-gravity', 'northwest'];
  const innen = B - 120;
  const kopf = saisonKopf(s);

  const titelGr = L.passendeGroesse(kopf.titel, FONT_B, 58, 38, innen);
  args.push('-font', FONT_B, '-pointsize', String(titelGr), '-fill', 'white');
  args.push('-annotate', `+60+68`, kopf.titel);

  args.push('-font', FONT, '-pointsize', String(L.passendeGroesse(kopf.unter, FONT, 32, 22, innen)), '-fill', '#95d5b2');
  args.push('-annotate', `+60+${68 + titelGr + 22}`, kopf.unter);

  // Bildraster, zwei Spalten. Die Namen liegen als Leiste auf dem Bild statt darunter —
  // so bleibt bei sechs Pflanzen genug Platz für die Bilder selbst.
  s.auswahl.forEach((x, i) => {
    const sx = (i % 2) * SPALTE, sy = KOPF + Math.floor(i / 2) * ZEILE;
    const quelle = path.join(WURZEL, 'public', x.p.bild_url.replace(/^\//, ''));
    const datei = `/tmp/pin-saison-${x.p.id}-${i}.png`;
    execFileSync(L.MAGICK, [quelle, '-resize', `${SPALTE}x${ZEILE}^`, '-gravity', 'center',
                             '-extent', `${SPALTE}x${ZEILE}`, datei], { stdio: 'pipe' });
    tmp.push(datei);
    args.push('-draw', `image over ${sx},${sy} 0,0 "${datei}"`);
    gezeichnet.push(x.p.id);
  });

  s.auswahl.forEach((x, i) => {
    const sx = (i % 2) * SPALTE, sy = KOPF + Math.floor(i / 2) * ZEILE;
    const leiste = sy + ZEILE - 84;
    args.push('-fill', 'rgba(27,67,50,0.86)', '-draw', `rectangle ${sx},${leiste} ${sx + SPALTE},${sy + ZEILE}`);

    const name = x.p.name_deutsch;
    args.push('-font', FONT_B, '-pointsize', String(L.passendeGroesse(name, FONT_B, 27, 17, SPALTE - 36)), '-fill', 'white');
    args.push('-annotate', `+${sx + 18}+${leiste + 12}`, name);
    const zwei = `${x.zeile2}   ·   ${x.p.hoehe_cm_max} cm`;
    args.push('-font', FONT, '-pointsize', String(L.passendeGroesse(zwei, FONT, 22, 15, SPALTE - 36)), '-fill', '#95d5b2');
    args.push('-annotate', `+${sx + 18}+${leiste + 48}`, zwei);

    // Giftmarkierung direkt auf der betroffenen Kachel. In einem Raster aus sechs Pflanzen
    // wäre eine Sammelwarnung am Fuß nicht zuzuordnen — man wüsste nicht, welche gemeint ist.
    const g = giftigkeit(x.p.name_botanisch);
    if (g) {
      const stark = g.stufe === 'stark';
      const text = L.GIFT_LABEL[g.stufe] || 'Giftig';
      const br = L.textBreite(text, FONT_B, 20) + 24;
      args.push('-fill', stark ? 'rgba(178,58,58,0.94)' : 'rgba(217,164,65,0.94)');
      args.push('-draw', `roundrectangle ${sx + 14},${sy + 14} ${sx + 14 + br},${sy + 48} 6,6`);
      args.push('-font', FONT_B, '-pointsize', '20', '-fill', stark ? 'white' : '#3d2c00');
      args.push('-annotate', `+${sx + 26}+${sy + 21}`, text);
    }
  });

  let y = KOPF + 3 * ZEILE + 34;

  // Ein Satz, der die Auswahl einordnet. Im Winter ist der Pflegehinweis der eigentliche
  // Nutzen — wer die Samenstände im Herbst abschneidet, hat den ganzen Effekt nicht.
  args.push('-font', FONT, '-pointsize', '27', '-fill', '#b7e4c7');
  for (const z of L.umbrechenBreit(kopf.hinweis, FONT, 27, innen)) { args.push('-annotate', `+60+${y}`, z); y += 38; }

  args.push('-font', FONT_B, '-pointsize', '31', '-fill', '#95d5b2');
  args.push('-annotate', `+60+${H - 120}`, 'Eigenen Beetplan erstellen — kostenlos');
  args.push('-font', FONT, '-pointsize', '25', '-fill', '#74c69d');
  args.push('-annotate', `+60+${H - 40}`, 'staudenplan.de   ·   Illustrationen');

  /* Die sechs IDs in die Datei selbst. Damit kann check-pin-deckung.js das Bild befragen,
   * statt Text gegen Text zu halten — die Begruendung steht bei bildKommentarArgs() in
   * pin-layout.js. */
  args.push(...L.bildKommentarArgs({ guid, ids: gezeichnet }));

  args.push('-quality', '88', ziel);
  execFileSync(L.MAGICK, args, { stdio: 'pipe' });
  tmp.forEach(f => { try { fs.unlinkSync(f); } catch {} });
  return ziel;
}

/* module.exports steht VOR dem CLI-Block, nicht dahinter.
 *
 * scripts/winterbild-auftrag.js requirt diese Datei zurueck (um die Aspektliste gegen
 * WINTER_WERT zu pruefen), und ladePflanzen() requirt es seinerseits. Stand die Zuweisung
 * hinter dem CLI-Block, bekam der Rueckweg ein noch leeres Exportobjekt — und ein direkter
 * Aufruf von "node scripts/pin-saison.js --liste" brach mit TypeError ab, waehrend derselbe
 * Code ueber pins-erzeugen.js lief. Wer den Block wieder nach unten schiebt, bricht das CLI. */
module.exports = { ladePflanzen, saisonAuswahl, saisonPin, alleSaisonPins, saisonPfad,
                   saisonKennung, saisonKopf, THEMA, ORT, WINTER_WERT,
                   winterSchluessel, winterAspekt, winterThema, winterHinweis };

if (require.main === module) {
  const argv = process.argv.slice(2);
  const opt = n => { const i = argv.indexOf('--' + n); return i < 0 ? null : argv[i + 1]; };
  const db = new Database(process.env.DB_PFAD || path.join(WURZEL, 'stauden.db'), { readonly: true });
  const pflanzen = ladePflanzen(db);

  if (argv.includes('--liste')) {
    const { pins, verworfen } = alleSaisonPins(pflanzen);
    for (const { guid, s } of pins) {
      console.log(guid.padEnd(34) + (s.winter ? '[Winter] ' : '[Blüte]  ') + saisonPfad(s).padEnd(34)
        + s.auswahl.map(x => x.p.name_deutsch).join(', '));
    }
    console.log(`\n${pins.length} Pins`);
    for (const v of verworfen) console.log(`  verworfen: ${v.guid} — ${v.grund}`);
    process.exit(0);
  }

  const thema = opt('thema');
  const monat = Number(opt('monat')) || (thema ? 11 : new Date().getMonth() + 1);
  const s = saisonAuswahl(pflanzen, { monat, standort: opt('standort'), versatz: Number(opt('versatz')) || 0, thema });
  if (!s) {
    console.error(`zu wenige Kandidaten für ${thema || MON_NAME[monat - 1]}${opt('standort') ? ' / ' + opt('standort') : ''}`);
    process.exit(1);
  }
  const ziel = argv.find(a => a.endsWith('.jpg')) || `/tmp/${saisonKennung(s).datei}`;
  saisonPin(s, ziel);
  console.log('erzeugt:', ziel, '·', s.winter ? 'Winterfassung' : 'Blühfassung', '·', s.auswahl.map(x => x.p.name_deutsch).join(', '));
}

