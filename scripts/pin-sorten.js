/*
 * Sortennamen, Kennungen und Terminregeln der Pins — die Entscheidungen, die BEIDE Läufe
 * brauchen: scripts/pins-erzeugen.js (Bild, Text, liste.json) und scripts/pin-termine.js
 * (geplant_am).
 *
 * WARUM EIN EIGENES MODUL UND NICHT pin-layout.js:
 * pin-layout.js sucht beim Import ImageMagick und die Schriften — zwei Prozessaufrufe und im
 * Zweifel drei Warnzeilen. Der Terminlauf braucht davon nichts, er rechnet nur mit Daten. Ein
 * Modul ohne jede Abhängigkeit lässt sich außerdem von Hand nachrechnen (node -e), ohne
 * Datenbank und ohne Bildwerkzeug — und genau das ist bei Terminregeln nötig: Im Projekt gilt,
 * dass man sich bei einer Terminänderung die Verteilung ansieht und nicht nur den Code.
 *
 * WARUM ÜBERHAUPT GETEILT: Die Sorte „pflanze-winter" muss an zwei Stellen dieselbe sein.
 * Stünde der Name links als Zeichenkette im Erzeugen und rechts als Zeichenkette im
 * Terminplan, entstünde beim ersten Tippfehler ein Wintertermin ohne Winterbild — oder ein
 * Winterbild, das im Terminplan wie eine beliebige Einzelpflanze behandelt und mitten in den
 * Juni gelegt wird. Beides fiele erst auf Pinterest auf.
 */

/*
 * Die Sortennamen. `typ` steht so in public/pins/liste.json und steuert von dort aus die
 * KI-Kennzeichnung (KI_PIN_SORTEN in pin-layout.js), den Terminwunsch und den Startschub.
 */
const TYP = {
  pflanze:       'pflanze',
  pflanzeWinter: 'pflanze-winter',
  saison:        'saison',
  kombi:         'kombi',
  beetplan:      'beetplan',
  ratgeber:      'ratgeber',
  pflege:        'pflege',
};

/*
 * Sorte aus einer Kennung oder einem Dateinamen: 'pflanze-winter-astilbe.jpg' → 'pflanze-winter',
 * 'saison-winter-graeser.jpg' → 'saison', 'pflege-haeufige-fehler.jpg' → 'pflege'.
 *
 * Gebraucht wird das überall dort, wo nur die Datei vorliegt und trotzdem über die
 * KI-Kennzeichnung entschieden werden muss — im CLI von pin-ki-metadaten.js, das sonst jede
 * übergebene Datei kennzeichnet, auch eine Beetskizze.
 *
 * Der längste Treffer zuerst: Sonst gewänne 'pflanze' gegen 'pflanze-winter', und die
 * Winterfassung liefe als gewöhnliche Einzelpflanze durch. Genau diese Verwechslung ist in
 * pin-termine.js schon einmal begründet worden (wunsch(), Vergleich bewusst exakt).
 */
const SORTEN_LAENGSTE_ZUERST = Object.values(TYP).sort((a, b) => b.length - a.length);
function sorteAus(name) {
  const b = String(name || '').replace(/^.*[\/]/, '').replace(/.[a-z0-9]+$/i, '');
  return SORTEN_LAENGSTE_ZUERST.find(t => b === t || b.startsWith(t + '-')) || null;
}

/*
 * Slug für Kennung und Ziellink.
 *
 * Bis zum 21.09.2026 stand diese Fassung zweimal im Projekt: in pin-text.js (baut die guid
 * `pflanze-<slug>` und den Pfad /pflanze/<slug>) und in pin-termine.js (sucht über denselben
 * Slug die Blühzeit der Pflanze). Beide waren wirkungsgleich — und genau das ist die Falle:
 * Wer eine davon anfasst, bricht die Zuordnung zwischen Pin und Termin, ohne dass irgendwo
 * ein Fehler entsteht. Der Pin bekäme still den Lückenfüller-Termin statt des Termins aus
 * seiner Blühzeit, und im Kalender sähe das aus wie eine Pflanze ohne lesbare Blühzeit.
 *
 * Die Ratgeber-Fassungen in pin-ratgeber.js und og-ratgeber.js bleiben ABSICHTLICH stehen:
 * Sie entfernen den Apostroph nicht, erzeugen also für „Rittersporn 'Völkerfrieden'" einen
 * anderen Slug. Sie hier einzuschmelzen wäre kein Zusammenführen, sondern eine stille
 * Änderung vorhandener Ratgeber-Adressen.
 *
 * Der Rumpf ist Zeichen für Zeichen übernommen — auch die Klasse mit dem zweimal genannten
 * geraden Apostroph. Sie um das typografische zu erweitern wäre eine Verbesserung und
 * zugleich ein Fehler: Jeder Slug, der sich dadurch ändert, ist eine neue guid und ein toter
 * Link auf einen bereits veröffentlichten Pin.
 */
const slugify = s => String(s).toLowerCase()
  .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
  .replace(/['']/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/*
 * Veröffentlicht = Termin erreicht. Dieselbe Regel wie pinsLesen() in stauden-server.js: Der
 * Feed liefert ab dem Tag, Pinterest liest täglich. Steht hier, weil zwei Läufe sie brauchen
 * und beide dieselbe Antwort geben müssen — pins-erzeugen.js friert den TEXT eines
 * veröffentlichten Pins ein, pin-termine.js darf seinen TERMIN nicht mehr verschieben. Zwei
 * Auslegungen desselben Wortes wären ein Pin, dessen Text feststeht, aber dessen Termin in
 * die Zukunft rutscht: Er verschwände aus dem Feed, während er bei Pinterest steht.
 */
const istVeroeffentlicht = (e, heute) => Boolean(e && e.geplant_am && e.geplant_am <= heute);

/*
 * Die vier Monate ohne Blüte. Gezählt über die 278 pinnbaren Stauden: November und Dezember
 * haben keine einzige blühende Art, Januar eine, Februar drei.
 */
const WINTER_MONATE = [11, 12, 1, 2];

/*
 * Ist der Pin Winterinhalt? Gefragt vom Startschub in pin-termine.js, der je Pinnwand die drei
 * frühesten künftigen Pins auf den Starttag zieht. Im August 2026 sind so die Winter-Pins
 * mitten im Sommer hinausgegangen — der Startschub kennt nur das Datum, nicht den Inhalt.
 *
 * Drei Fälle, und alle drei stehen hier statt verstreut: die neue Sorte pflanze-winter,
 * die Winterthemen-Raster (saison-winter-…) und die Monatsraster der Wintermonate
 * (saison-11, saison-12, saison-1, saison-2 samt Standortfassungen).
 */
function istWinterinhalt(e) {
  if (!e) return false;
  if (e.typ === TYP.pflanzeWinter) return true;
  if (e.typ === TYP.saison) {
    const g = String(e.guid || '');
    if (/^saison-winter-/.test(g)) return true;
    const m = Number((g.match(/^saison-(\d+)/) || [])[1]);
    return WINTER_MONATE.includes(m);
  }
  return false;
}

/*
 * Wie viele Tage eines Monats die Winterrunde benutzt. 28, weil das der kürzeste Monat ist:
 * So liegt jeder Termin sicher IM Wunschmonat und rutscht nicht in den nächsten.
 */
const WINTER_TAGE = 28;

/*
 * TERMINE DER WINTERPINS: REIHUM, NICHT NACH STREUWERT.
 *
 * Die Kennungen werden sortiert und der Reihe nach auf November, Dezember, Januar, Februar
 * verteilt; jede vierte Kennung beginnt eine neue Runde und rückt einen Tag weiter in den
 * Monat hinein. Ergebnis bei 126 Pins: 32/32/31/31 auf die vier Monate, höchstens zwei am
 * selben Tag.
 *
 * KEIN HASH. Zwei Anläufe damit sind im Projekt belegt schiefgegangen: einmal waren „h % 2"
 * und „h % 4" aus demselben Streuwert gekoppelt, einmal streute der Hash über vier Monate
 * schlicht ungleich (Januar blieb bei drei Pins). Reihum ist deterministisch UND gleichmäßig.
 * Dieselbe Eingabe ergibt immer dieselbe Ausgabe — das ist Bedingung, weil der Lauf wiederholt
 * wird und ein Pin nicht bei jedem Lauf woanders landen darf.
 *
 * Die Deckelung `% WINTER_TAGE` ist die Antwort auf die Frage „und wenn es einmal 400 sind":
 * Dann beginnt die Staffelung wieder am Monatsersten, statt in den Folgemonat zu laufen. Voll
 * belegte Tage schiebt freierTag() in pin-termine.js ohnehin weiter.
 *
 * Gibt [{ guid, monat, versatz }] zurück — ohne Datum, damit die Regel ohne Kalender,
 * Datenbank und Startdatum nachgerechnet werden kann.
 *
 * ── VORAUSSETZUNG DIESER SORTE: DER FEED WÄHLT NACH `geplant_am` AUS ─────────
 *
 * Alle Pins dieser Sorte liegen auf der EINEN Pinnwand „Winterbeet" (board in
 * textPflanzeWinter, pin-text.js). Der Feed je Pinnwand ist auf 25 Einträge gedeckelt
 * (FEED_MAX in stauden-server.js). Solange dieser Deckel die 25 ZULETZT FÄLLIG GEWORDENEN
 * nimmt, erreicht jeder Pin an seinem Termin den Feed: Die Terminvergabe legt höchstens drei
 * Pins auf denselben Tag, an keinem Tag stehen also annähernd 25 Winterbeet-Pins mit
 * demselben Datum in der Liste.
 *
 * Nachgerechnet mit dieser Verteilung, der Terminvergabe aus pin-termine.js (Start 22.09.2026)
 * und einer nachgestellten Liste in Produktionsgröße — 126 Winterfassungen und 32
 * Saison-Winterfassungen auf derselben Pinnwand, 458 Pins insgesamt: An keinem Tag werden mehr
 * als VIER Winterbeet-Pins fällig, und alle 126 erreichen den Feed (die ganze Pinnwand 158 von
 * 158). Mit der Auswahl nach Dateireihenfolge sind es 15 von 126.
 *
 * Schneidet der Deckel dagegen nach der DATEIREIHENFOLGE — liste.json ist nach guid sortiert
 * (pins-erzeugen.js) —, dann entscheidet das Alphabet, wer ausgeliefert wird: Ein Pin, der
 * fällig wird, während schon 25 alphabetisch spätere Winterbeet-Pins fällig sind, erscheint
 * NIE, und weil die Menge des Fälligen nur wächst, kommt er auch nie wieder herein. Drei
 * unabhängige Nachrechnungen kamen bei 126 Pins dieser Sorte auf 68 bis 111 Stück, die so
 * niemals ausgeliefert würden — ohne Fehlermeldung, ohne Exitcode, mit vollständig
 * aussehender liste.json.
 *
 * Die Auswahl trifft feedSortiert()/feedAuswahl() in stauden-server.js. Wer sie wieder auf die
 * Dateireihenfolge zurückbaut, muss diese Sorte gleichzeitig auf mehrere Pinnwände verteilen
 * oder deckeln. Sonst kehrt der Schaden still zurück — ohne Fehlermeldung und ohne Exitcode.
 */
function winterVerteilung(guids) {
  return [...guids].sort().map((guid, i) => ({
    guid,
    monat: WINTER_MONATE[i % WINTER_MONATE.length],
    versatz: Math.floor(i / WINTER_MONATE.length) % WINTER_TAGE,
  }));
}

module.exports = { TYP, sorteAus, slugify, istVeroeffentlicht, WINTER_MONATE, WINTER_TAGE,
                   istWinterinhalt, winterVerteilung };
