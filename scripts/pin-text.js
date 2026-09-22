/*
 * Erzeugt Titel, Beschreibung und Ziellink zu einem Pin.
 *
 *   node scripts/pin-text.js --probe        Beispieltexte der Pin-Sorten (sechs von sieben,
 *                                           siehe „WAS --probe ZEIGT" weiter unten)
 *
 * KEINE SPRACHMODELL-TEXTE. Das ist eine bewusste Entscheidung, kein Sparzwang: Ein
 * unbeaufsichtigtes Skript, das täglich frei formulierte Pflanzenaussagen im Namen der
 * Gartenschmiede GmbH veröffentlicht, lässt sich nicht wie eine Webseite per Deploy
 * zurücknehmen — ein Pin ist draußen, sobald er draußen ist. Alles hier steht in Vorlagen,
 * gefüllt aus geprüften Datenbankfeldern. Jede Aussage im Text ist damit nachprüfbar. Eine
 * Vorschau im Adminbereich gibt es nicht; wo sie hier einmal stand, war sie eine Ortsangabe
 * ohne Route.
 *
 * ── WAS --probe ZEIGT, UND WAS NICHT (Stand 21.09.2026) ──────────────────────
 * Hier stand bis zum 21.09.2026 der Satz, --probe zeige „vorab exakt das, was veröffentlicht
 * wird". Der Zweig zeigte aber nur fünf der sieben Sorten. Die Zusage gilt jetzt für sechs,
 * und die siebte ist ausdrücklich benannt statt stillschweigend ausgelassen:
 *
 *   gezeigt:      pflanze, pflanze-winter, beetplan, kombi, saison, ratgeber
 *   nicht gezeigt: pflege
 *
 * Warum pflege fehlt: textPflege() braucht das Objekt `seite` (Titel, Hinweis, ausgezählter
 * Inhaltssatz). Dieses Objekt wird in scripts/pins-erzeugen.js aus der Pflegeauswertung
 * gebaut und von dort nicht herausgereicht. Es hier nachzubauen hieße, zwei Fassungen desselben
 * Textes zu führen — und eine Vorschau, die etwas anderes zeigt als die Veröffentlichung, ist
 * keine (dieselbe Lehre wie beim Beetplan, siehe unten im --probe-Zweig).
 * Der eine Schritt, der noch fehlt: in scripts/pins-erzeugen.js den Aufbau von `seite` in eine
 * Funktion `pflegeSeite(db)` fassen und exportieren; dann holt --probe sie dort und zeigt
 * Zeichen für Zeichen denselben Text. Das ist ein eigener, kleiner Schritt in einer Datei,
 * die diese Runde nicht anfasst.
 *
 * Die Abwechslung kommt aus den Daten, nicht aus der Formulierung: Bei 287 Pflanzen,
 * 151634 Kombinationen und zwölf Monaten wiederholt sich der Satzbau, aber nie der Inhalt.
 * Zusätzlich gibt es je Sorte mehrere Vorlagen, die fest aus den Daten ausgewählt werden —
 * derselbe Pin ergibt immer denselben Text, was für die Vorschau nötig ist.
 *
 * Pinterest ist eine Suchmaschine, keine Zeitleiste: Die Beschreibung enthält deshalb die
 * Begriffe, nach denen dort tatsächlich gesucht wird („Beetplan", „Bepflanzungsplan",
 * „Staudenbeet", „Schattenbeet"), in ganzen Sätzen statt als Schlagwortliste.
 */
const L = require('./pin-layout');
const saison = require('./pin-saison');   // THEMA und saisonPfad: eine Quelle für Bild, Text und Seite
const S = require('./pin-sorten');        // Sortennamen und slugify: dieselben wie im Terminlauf

const BASIS = 'https://www.staudenplan.de';
const HERKUNFT = '?utm_source=pinterest&utm_medium=pin';

// Pinterest kappt hart. Lieber selbst an einer Wortgrenze kürzen als mitten im Wort.
const TITEL_MAX = 100, BESCHREIBUNG_MAX = 500;

function kuerzen(text, max) {
  const t = String(text).replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  const schnitt = t.slice(0, max - 1);
  return schnitt.slice(0, schnitt.lastIndexOf(' ')).replace(/[,;–-]$/, '').trim() + '…';
}

/* Derselbe Slug wie im Terminplan. Stand bis zum 21.09.2026 hier und noch einmal wortgleich
 * in pin-termine.js — siehe die Begründung in pin-sorten.js. Weiter unten exportiert, weil
 * pins-erzeugen.js ihn als txt.slugify aufruft. */
const slugify = S.slugify;

// Feste Auswahl aus den Daten statt Zufall — die Vorschau muss zeigen, was später kommt.
const wahl = (liste, zahl) => liste[Math.abs(Math.round(zahl)) % liste.length];

// Die Pinnwand für alles, was den Winter trägt: die Sechser-Raster und seit 21.09.2026 die
// Winterfassung der Einzelpflanzen. Einmal benannt, weil zwei Textsorten darauf zeigen.
const WINTERBRETT = 'Winterbeet';

const LICHT_ORT = { sonne: 'sonnige Beete', halbschatten: 'den Halbschatten', schatten: 'schattige Ecken' };
// Die Standortwerte stehen kleingeschrieben in der Datenbank. Ungefiltert stand im Text
// „für schatten" und „Standort: halbschatten" — in einem Fließtext ist das schlicht falsch.
const LICHT_DATIV = { sonne: 'sonnige Standorte', halbschatten: 'den Halbschatten', schatten: 'den Schatten' };
const gross = s => { const t = String(s || '').trim(); return t.charAt(0).toUpperCase() + t.slice(1); };

/* Giftbefund als ganzer Satz. Steht im Text, nicht nur im Bild: Wer den Pin teilt, gibt oft
 * nur die Beschreibung weiter, und die Warnung darf dabei nicht verloren gehen. */
function giftSatz(pflanzen, giftigkeit) {
  const treffer = pflanzen.map(p => ({ p, g: giftigkeit(p.name_botanisch) })).filter(x => x.g);
  if (!treffer.length) return '';
  treffer.sort((a, b) => (L.GIFT_RANG[a.g.stufe] ?? 9) - (L.GIFT_RANG[b.g.stufe] ?? 9));
  if (treffer.length === 1) {
    const { p, g } = treffer[0];
    return g.stufe === 'stark'
      ? `Achtung: ${p.name_deutsch} ist stark giftig — in Gärten mit kleinen Kindern besser weglassen.`
      : `Hinweis: ${L.GIFT_LABEL[g.stufe]} — ${p.name_deutsch}.`;
  }
  const stark = treffer.filter(x => x.g.stufe === 'stark').map(x => x.p.name_deutsch);
  const rest = treffer.filter(x => x.g.stufe !== 'stark').map(x => x.p.name_deutsch);
  return (stark.length ? `Achtung, stark giftig: ${stark.join(', ')}. ` : '')
       + (rest.length ? `Giftig: ${rest.join(', ')}.` : '').trim();
}

/*
 * Bei „stark giftig" gehört die Warnung an den Anfang, sonst ans Ende. Grund: Pinterest
 * zeigt in der Vorschau nur die ersten Zeilen der Beschreibung. Ein Hinweis auf Eisenhut,
 * der erst hinter Standort und Blütezeit steht, wird von den meisten nie gelesen. Bei den
 * schwächeren Stufen bleibt er hinten — sonst wirkt jede zweite Staude wie eine Warnung
 * und die ernsten Fälle gehen im Rauschen unter.
 */
function vornAnstellen(teile, satz) {
  if (!satz) return teile;
  if (/^Achtung/.test(satz)) teile.unshift(satz); else teile.splice(teile.length - 1, 0, satz);
  return teile;
}

/* ── Einzelpflanze ───────────────────────────────────────────────────────────── */
function textPflanze(p, giftigkeit) {
  const licht = [...L.mengeAus(p.licht)][0] || 'sonne';
  const hoehe = p.hoehe_cm_max ? `${p.hoehe_cm_max} cm` : null;
  const bluehzeit = L.spanne(p.bluehzeit) ? String(p.bluehzeit).replace(/\s*-\s*/, ' bis ') : null;

  const titel = wahl([
    `${p.name_deutsch} pflanzen: Standort, Blütezeit und Pflege`,
    bluehzeit ? `${p.name_deutsch}: blüht ${bluehzeit}${hoehe ? `, ${hoehe} hoch` : ''}` : `${p.name_deutsch} im Staudenbeet`,
    `${p.name_deutsch} für ${LICHT_ORT[licht] || 'das Staudenbeet'}`,
  ], p.id);

  const teile = [
    `${p.name_deutsch} (${p.name_botanisch})${bluehzeit ? ` blüht ${bluehzeit}` : ''}${hoehe ? ` und wird ${hoehe} hoch` : ''}.`,
    p.licht ? `Standort: ${String(p.licht).replace(/\|/g, ' oder ')}${p.feuchtigkeit ? `, ${String(p.feuchtigkeit).split('|')[0]}er Boden` : ''}.` : '',
    p.bienen_freundlich ? 'Bienenfreundlich.' : '',
    p.heimisch ? 'Heimische Art.' : '',
    'Passendes Staudenbeet dazu planen: kostenlos auf staudenplan.de, mit Pflanzplan zum Ausdrucken.',
  ].filter(Boolean);
  vornAnstellen(teile, giftSatz([p], giftigkeit));

  return fertig({
    titel, beschreibung: teile.join(' '),
    pfad: `/pflanze/${slugify(p.name_botanisch)}`,
    alt: `${p.name_deutsch}, ${p.name_botanisch} — Illustration`,
    board: brett(licht),
    typ: S.TYP.pflanze,
  });
}

/* ── Einzelpflanze im Winter ─────────────────────────────────────────────────── */
/*
 * ZWEITER PIN JE PFLANZE, seit 21.09.2026 — dieselbe Pflanze, dieselbe Landeseite, aber der
 * Winteraspekt statt der Blühzeit.
 *
 * WARUM: Die Einzelpflanzen-Pins bringen die Klicks — 33 von 37 gemessenen echten Ankünften.
 * Und genau diese Sorte schweigt von November bis Februar: Von 210 wartenden Einzelpflanzen-
 * Pins liegen 0 im November, 1 im Dezember, 2 im Januar, 8 im Februar, aber 49 im Mai. Das ist
 * kein Terminfehler, sondern der Blühkalender selbst — der Wunschtermin folgt dem Blühbeginn,
 * und im Winter blüht nichts. Ein Pin über den Winteraspekt hat dagegen im Winter seinen Platz.
 *
 * Die Pflanze BEHÄLT ihren Blühzeit-Pin; das hier ist ein zweiter, kein Ersatz. Beide zeigen
 * auf /pflanze/<slug>, unterscheidbar bleiben sie über utm_content (die guid, gesetzt in
 * pins-erzeugen.js) — sonst wüsste man hinterher nicht, welche Fassung die Ankunft gebracht hat.
 *
 * Die Beschriftung des Aspekts und der Pflegehinweis kommen aus pin-saison.js (WINTER_WERT und
 * THEMA): dieselben Worte wie unter der Kachel im Sechser-Raster und auf der Landeseite.
 */
function textPflanzeWinter(p, giftigkeit) {
  const aspekt = saison.winterAspekt(p);
  // Keine Zusage ohne Regel: Der Titel sagt „im Winterbeet" und die Faktenzeile im Bild nennt
  // den Aspekt. Fehlt er, gibt es diesen Pin nicht — lieber keiner als einer, der nichts sagt.
  if (!aspekt) throw new Error('Kein Winteraspekt aus der Werteliste (WINTER_WERT): '
    + `${p.name_botanisch} — winteraspekt="${p.winteraspekt || ''}"`);

  // Kein `licht` und kein brett(): Dieser Pin geht auf die Winterbeet-Pinnwand, nicht auf die
  // Standort-Pinnwand der Blühfassung. Die beiden Fassungen einer Pflanze liegen damit auf
  // verschiedenen Pinnwänden — zwei fast gleiche Pins nebeneinander wertet Pinterest als
  // Dublette, und „Winterbeet" ist die Pinnwand, auf der dieser Inhalt gesucht wird.
  //
  // DIESE ZUORDNUNG SETZT VORAUS, DASS DER FEED NACH `geplant_am` AUSWÄHLT. Alle Pins der
  // Sorte liegen auf dieser einen Pinnwand, und der Feed je Pinnwand ist auf 25 Einträge
  // gedeckelt (FEED_MAX in stauden-server.js). Nimmt der Deckel die zuletzt fällig gewordenen,
  // kommt jeder Pin an seinem Termin durch — die Terminvergabe legt höchstens drei Pins auf
  // einen Tag. Schneidet er dagegen nach der Dateireihenfolge (liste.json ist nach guid
  // sortiert), entscheidet das Alphabet, und der größere Teil dieser Sorte erreicht den Feed
  // nie, ohne dass irgendwo ein Fehler stünde. Die Rechnung dazu steht bei winterVerteilung()
  // in pin-sorten.js. Wer den Feed zurückbaut, muss diese Sorte auf mehrere Pinnwände
  // verteilen oder deckeln.
  const hoehe = p.hoehe_cm_max ? `${p.hoehe_cm_max} cm` : null;
  const bluehzeit = L.spanne(p.bluehzeit) ? String(p.bluehzeit).replace(/\s*-\s*/, ' bis ') : null;
  // Pflegehinweis nur, wenn er zu diesem Aspekt gehört. „blätter halbimmergrün" trägt keinen —
  // dann steht dort nichts, statt einer Pflegeanweisung, die für die Pflanze nicht stimmt.
  const hinweis = saison.winterHinweis(p);

  const titel = wahl([
    `${p.name_deutsch} im Winterbeet: ${aspekt}`,
    `${gross(aspekt)} — ${p.name_deutsch} im Winterbeet`,
    `${p.name_deutsch}: ${aspekt}${hoehe ? `, ${hoehe} hoch` : ''}`,
  ], p.id);

  const teile = [
    `${p.name_deutsch} (${p.name_botanisch}) im Winterbeet: ${aspekt}${hoehe ? `, ${hoehe} hoch` : ''}.`,
    hinweis || '',
    p.licht ? `Standort: ${String(p.licht).replace(/\|/g, ' oder ')}${p.feuchtigkeit ? `, ${String(p.feuchtigkeit).split('|')[0]}er Boden` : ''}.` : '',
    // Die Blühzeit gehört trotzdem dazu: Wer im Winter nach Struktur sucht, will wissen, was
    // die Pflanze im Sommer tut. Weggelassen wird sie nur, wenn sie sich nicht lesen lässt —
    // dieselbe Prüfung wie im Bild (ersteFakt() in pin-bild.js).
    bluehzeit ? `Blüht ${bluehzeit}.` : '',
    // Wortgleich mit der Blühfassung und mit textSaison(): Der Planer plant Staudenbeete,
    // kein eigenes Winterbeet. „Winterbeet planen" wäre eine Zusage, die keine Oberfläche
    // einlöst — die Seite dahinter kennt den Unterschied nicht.
    'Eigenes Staudenbeet planen: kostenlos auf staudenplan.de, mit Pflanzplan zum Ausdrucken.',
  ].filter(Boolean);
  vornAnstellen(teile, giftSatz([p], giftigkeit));

  return fertig({
    titel, beschreibung: teile.join(' '),
    pfad: `/pflanze/${slugify(p.name_botanisch)}`,
    alt: `${p.name_deutsch}, ${p.name_botanisch} im Winterbeet — ${aspekt}, Illustration`,
    board: WINTERBRETT,
    typ: S.TYP.pflanzeWinter,
  });
}

/* Derselbe Befund wie in giftSatz(), aber aus den Gruppen, die pin-beetplan.js aus der Seite
 * liest. Der Beetplan kennt nur deutsche Namen — die Legende der Beispielseite führt keine
 * botanischen —, deshalb kann giftigkeit() hier nicht angewandt werden. Die Einstufung hat die
 * Seite bereits vorgenommen; hier wird sie nur noch in einen Satz gegossen.
 */
function giftSatzAusGruppen(gift) {
  if (!gift || !gift.length) return '';
  const sortiert = [...gift].sort((a, b) => (L.GIFT_RANG[a.stufe] ?? 9) - (L.GIFT_RANG[b.stufe] ?? 9));
  const stark = sortiert.filter(g => g.stufe === 'stark');
  const rest = sortiert.filter(g => g.stufe !== 'stark');
  // Einzelfall wie in giftSatz() ausformuliert: "Eisenhut ist stark giftig" liest sich als
  // Warnung, "Stark giftig: Eisenhut" eher wie eine Rubrik.
  if (stark.length === 1 && !rest.length && !stark[0].namen.includes(',')) {
    return `Achtung: ${stark[0].namen} ist stark giftig — in Gärten mit kleinen Kindern besser weglassen.`;
  }
  return ((stark.length ? `Achtung, stark giftig: ${stark.map(g => g.namen).join(', ')}. ` : '')
       + rest.map(g => `${g.beschriftung}: ${g.namen}.`).join(' ')).trim();
}

/* ── Beetplan ────────────────────────────────────────────────────────────────── */
function textBeetplan(b, arten, gift) {
  const titel = wahl([
    `${b.h1 || b.title}`,
    `${b.title}: fertiger Bepflanzungsplan mit ${arten} Stauden`,
    `Beetplan zum Nachpflanzen: ${b.title}`,
  ], (b.slug || '').length);

  const teile = [
    `Fertiger Bepflanzungsplan mit ${arten} Stauden${b.flaeche ? ` auf ${b.flaeche} m²` : ''}${b.licht ? ` für ${LICHT_DATIV[String(b.licht).toLowerCase()] || String(b.licht).toLowerCase()}` : ''}.`,
    'Alle Pflanzen mit Namen, Blütezeit und Stückzahl — zum Nachpflanzen oder als Anregung fürs eigene Beet.',
    'Den kompletten Plan mit Skizze gibt es kostenlos auf staudenplan.de.',
  ];

  // Bis zum 18.08.2026 war der Beetplan die einzige der vier Textsorten ohne Giftsatz — die
  // Signatur bekam nur eine ANZAHL statt der Pflanzen, es gab schlicht nichts zu prüfen.
  const teileMitGift = vornAnstellen(teile, giftSatzAusGruppen(gift));

  return fertig({
    titel, beschreibung: teileMitGift.join(' '),
    pfad: `/beispiel/${b.slug}`,
    alt: `Bepflanzungsplan ${b.title} mit ${arten} Stauden — Skizze mit nummerierten Pflanzen`,
    board: 'Bepflanzungspläne',
    typ: S.TYP.beetplan,
  });
}

/* ── Ratgeber ────────────────────────────────────────────────────────────────── */
/*
 * Der Ratgeber-Pin ist die einzige Sorte ohne Pflanze — er trägt die Monate, in denen nichts
 * blüht. Deshalb auch kein KI-Hinweis: Die Karte ist rein typografisch, es gibt kein erzeugtes
 * Bild, über das aufzuklären wäre.
 *
 * Beschreibung = erster VOLLSTÄNDIGER Satz des Artikels plus Aufruf. Keine Zusammenfassung:
 * Was im Pin steht, steht wortgleich auf der Seite.
 */
function textRatgeber(artikel, teaser) {
  const teile = [
    teaser || `${artikel.titel} — der ganze Ratgeber auf staudenplan.de.`,
    'Kostenlos lesen, ohne Anmeldung.',
    'Passenden Beetplan gleich dazu erstellen: staudenplan.de.',
  ];
  return fertig({
    titel: artikel.titel,
    beschreibung: teile.join(' '),
    pfad: `/ratgeber/${slugify(artikel.titel)}`,
    alt: `${artikel.titel} — Ratgeber von Staudenplan.de, Kategorie ${artikel.kategorie}`,
    board: 'Staudenwissen',
    typ: S.TYP.ratgeber,
  });
}

/* ── Pflegethema ─────────────────────────────────────────────────────────────── */
/*
 * Der Pflege-Pin ist wie der Ratgeber-Pin reine Typografie auf farbigem Grund — kein
 * erzeugtes Bild, also kein KI-Hinweis (pflege steht nicht in KI_PIN_SORTEN).
 *
 * Der Text stand bis zum 21.09.2026 als Objektliteral in pins-erzeugen.js und lief damit an
 * fertig() vorbei: Als einzige der sieben Sorten wurde er weder gekürzt (TITEL_MAX/
 * BESCHREIBUNG_MAX) noch gegen KI_PIN_SORTEN gehalten. Käme die Sorte je in diese Liste —
 * etwa weil die Karte ein erzeugtes Bild bekommt —, schriebe bauen() die maschinenlesbare
 * Kennzeichnung in die Datei, während die Beschreibung dazu schwiege. Genau das
 * Auseinanderlaufen, das die eine Ableitung ausschließen soll.
 *
 * Der Ziellink ist Zeichen für Zeichen derselbe wie vorher (BASIS + Pfad + HERKUNFT): Die
 * URL eines veröffentlichten Pins zu ändern, wäre bei Pinterest ein neuer Eintrag.
 */
function textPflege(seite) {
  return fertig({
    titel: seite.titel,
    beschreibung: seite.inhalt + ' Kostenlos lesen auf staudenplan.de.',
    pfad: '/pflege/haeufige-fehler',
    alt: 'Die häufigsten Pflegefehler bei Stauden — Auswertung über den ganzen Bestand',
    board: 'Staudenwissen',
    typ: S.TYP.pflege,
  });
}

/* ── Kombination ─────────────────────────────────────────────────────────────── */
function textKombination(k, giftigkeit) {
  const d = k.pflanzen;
  const von = L.MON_NAME[k.von - 1], bis = L.MON_NAME[k.bis - 1];
  const ort = LICHT_ORT[k.licht] || 'das Staudenbeet';

  const titel = wahl([
    `3 Stauden, die von ${von} bis ${bis} blühen`,
    `Staudenkombination für ${ort}: ${von} bis ${bis} in Blüte`,
    `${von} bis ${bis} durchgehend Blüte — 3 Stauden, die zusammenpassen`,
  ], d[0].id + k.monate);

  const teile = [
    `${d.map(p => p.name_deutsch).join(', ')} — drei Stauden für ${ort}, die nacheinander blühen.`,
    `Erst ${d[0].name_deutsch}, dann ${d[1].name_deutsch}, ab ${L.MON_NAME[L.spanne(d[2].bluehzeit)[0] - 1]} ${d[2].name_deutsch}. So steht das Beet von ${von} bis ${bis} nie leer.`,
    `Alle drei wollen denselben Standort: ${gross(k.licht)}, ${k.feuchte}er Boden.`,
    'Eigenen Beetplan mit passenden Stauden erstellen: kostenlos auf staudenplan.de.',
  ].filter(Boolean);
  vornAnstellen(teile, giftSatz(d, giftigkeit));

  return fertig({
    titel, beschreibung: teile.join(' '),
    pfad: '/stauden-kombinieren',
    alt: `Staudenkombination ${d.map(p => p.name_deutsch).join(', ')} mit Blühkalender von ${von} bis ${bis}`,
    board: brett(k.licht),
    typ: S.TYP.kombi,
  });
}

/* ── Saison ──────────────────────────────────────────────────────────────────── */
/*
 * Vier Spielarten: Blühmonat, Blühmonat je Standort, Winter allgemein, Winter je Blattform
 * (THEMA in pin-saison.js). Die Winterthemen bringen ihre Sätze selbst mit — dieselben, die
 * auf dem Bild und auf der Landeseite stehen. Der Ziellink ist seit 08.09.2026 die Seite mit
 * genau diesen sechs Pflanzen (saisonPfad), nicht mehr die allgemeine Planer-Anleitung.
 */
function textSaison(s, giftigkeit) {
  const monat = L.MON_NAME[s.monat - 1];
  const pflanzen = s.auswahl.map(x => x.p);
  const namen = pflanzen.map(p => p.name_deutsch).join(', ');
  const th = s.thema ? saison.THEMA[s.thema] : null;
  const ort = s.standort ? ` für ${LICHT_ORT[s.standort]}` : '';

  const titel = th
    ? wahl(th.pinTitel(ort), s.thema.length)
    : s.winter
      ? wahl([`Struktur im Winterbeet: 6 Stauden${ort}, die nach der Blüte stehen bleiben`,
              `Winterbeet: 6 Stauden${ort} mit Samenständen und Gräserstruktur`], s.monat)
      : s.standort
        ? wahl([`Was im ${monat} blüht: 6 Stauden${ort}`,
                `${monat}: 6 Stauden${ort}, die jetzt blühen`], s.monat)
        : wahl([`Was im ${monat} blüht: 6 Stauden fürs Beet`,
                `${monat}: 6 Stauden, die jetzt blühen`,
                `Blüht im ${monat} — 6 Stauden mit Höhe und Standort`], s.monat);

  const teile = th ? [
    `${namen} — ${th.satz}`,
    th.hinweis,
    'Eigenes Staudenbeet planen: kostenlos auf staudenplan.de.',
  ] : s.winter ? [
    `${namen} — sechs Stauden, die auch nach der Blüte etwas hermachen.`,
    'Samenstände und Gräser erst im Frühjahr zurückschneiden: Sie halten den Winter über Struktur und bieten Insekten Quartier.',
    'Eigenes Staudenbeet planen: kostenlos auf staudenplan.de.',
  ] : [
    s.standort
      ? `Sechs Stauden${ort}, die im ${monat} blühen: ${namen}.`
      : `Sechs Stauden, die im ${monat} blühen: ${namen}.`,
    'Mit Höhe und Standort, damit sie sich direkt einplanen lassen.',
    `Passendes Staudenbeet zusammenstellen: kostenlos auf staudenplan.de, mit Pflanzplan zum Ausdrucken.`,
  ];
  vornAnstellen(teile, giftSatz(pflanzen, giftigkeit));

  return fertig({
    titel, beschreibung: teile.filter(Boolean).join(' '),
    pfad: saison.saisonPfad(s),
    alt: th ? `Sechs Stauden fürs Winterbeet: ${th.titel}${ort}`
       : s.winter ? `Sechs Stauden mit Winterstruktur${ort}` : `Sechs Stauden${ort}, die im ${monat} blühen`,
    // Standortfassungen gehen auf die Standort-Pinnwände: Die Schatten-Pinnwand hat zwölf
    // Pins, die Sechser-Raster sind die stärkste Sorte — dort fehlen sie am meisten.
    board: s.winter ? WINTERBRETT : s.standort ? brett(s.standort) : `Was blüht wann`,
    typ: S.TYP.saison,
  });
}

const brett = licht => ({ sonne: 'Stauden für sonnige Beete', halbschatten: 'Stauden für den Halbschatten',
                          schatten: 'Stauden für den Schatten' })[licht] || 'Staudenbeet planen';

/* Der KI-Hinweis wird VOR dem Kuerzen vom Budget abgezogen, nicht hinterher angehaengt.
 * Sonst faellt genau die Kennzeichnung als Erstes weg, wenn eine Beschreibung ans Limit
 * stoesst — und zwar unbemerkt, weil kuerzen() still arbeitet. Betroffen sind die Sorten in
 * KI_PIN_SORTEN (pin-layout.js); der Beetplan-Pin zeigt eine gezeichnete Beetskizze und keine
 * Illustration, dort waere der Satz schlicht falsch. */
const KI_HINWEIS = ' Bild: KI-erzeugte Illustration.';

/*
 * WELCHE SORTE EINEN KI-HINWEIS BEKOMMT, WIRD HIER NICHT ENTSCHIEDEN.
 *
 * Bis zum 21.09.2026 stand „kiBild: true" dreimal einzeln in dieser Datei — einmal je Sorte,
 * von Hand gepflegt. Jetzt kommt jede Sorte mit ihrem Namen herein, und L.istKiPin()
 * entscheidet. Dieselbe Liste steuert die maschinenlesbare Kennzeichnung im JPEG
 * (pin-ki-metadaten.js). Die ENTSCHEIDUNG steht damit an einer Stelle.
 *
 * Der SORTENNAME wird allerdings weiterhin zweimal hereingereicht — einmal hier an fertig(),
 * einmal an bauen() in pins-erzeugen.js. Beide Male kommt er aus S.TYP, und dass beide
 * dasselbe sagen, nimmt bauen() nicht an, sondern prüft es (siehe unten). Ein Satz wie „es
 * gibt keine zwei Stellen mehr" wäre an dieser Datei vorbeigeschrieben: Es gibt sie, sie
 * werden nur nicht mehr unbeaufsichtigt gelassen.
 *
 * `typ` UND `kiBild` WERDEN ZURÜCKGEGEBEN, DAMIT bauen() SIE GEGENPRÜFT. Die Sorte erreicht
 * die beiden Kennzeichnungen auf zwei Wegen: als Argument an fertig() (Satz in der
 * Beschreibung) und als Argument an bauen() in pins-erzeugen.js (IPTC-Feld in der Datei).
 * Beide kommen seit dem 21.09.2026 aus S.TYP, ein Tippfehler ist also nicht mehr möglich —
 * eine Umbenennung auf nur einer Seite aber schon. Deshalb vergleicht bauen() das hier
 * zurückgegebene `typ` mit seinem eigenen und `kiBild` mit L.istKiPin(typ) und lässt den Pin
 * bei einer Abweichung aus. pins-erzeugen.js schreibt `kiBild` zusätzlich in liste.json, damit
 * derselbe Vergleich auch für einen eingefrorenen Pin möglich ist, dessen Text nicht neu
 * gerechnet wird.
 *
 * Weiter liest es niemand: Eine Vorschau unter /admin/pins gibt es nicht, und der Feed in
 * stauden-server.js liest aus liste.json nur die Felder, die in den RSS-Eintrag gehören.
 */
function fertig({ titel, beschreibung, pfad, alt, board, typ }) {
  const kiBild = L.istKiPin(typ);
  const hinweis = kiBild ? KI_HINWEIS : '';
  return {
    titel: kuerzen(titel, TITEL_MAX),
    beschreibung: kuerzen(beschreibung, BESCHREIBUNG_MAX - hinweis.length) + hinweis,
    link: BASIS + pfad + HERKUNFT,
    alt: kuerzen(alt, 500),
    board,
    typ,
    kiBild,
  };
}

if (require.main === module) {
  const Database = require('better-sqlite3');
  const path = require('path');
  const { giftigkeit } = require('./pflanzen-giftigkeit');
  const db = new Database(process.env.DB_PFAD || path.join(__dirname, '..', 'stauden.db'), { readonly: true });

  const zeig = (was, t) => {
    console.log(`\n── ${was} ──`);
    console.log(`Titel (${t.titel.length}/${TITEL_MAX}):  ${t.titel}`);
    console.log(`Beschreibung (${t.beschreibung.length}/${BESCHREIBUNG_MAX}):\n  ${t.beschreibung}`);
    console.log(`Link:  ${t.link}`);
    console.log(`Pinnwand:  ${t.board}`);
  };

  const kombiModul = require('./pin-kombination');
  const saisonModul = require('./pin-saison');
  const beetModul = require('./pin-beetplan');
  const ratgeberModul = require('./pin-ratgeber');

  (async () => {
    const p = db.prepare("SELECT * FROM pflanzen WHERE name_botanisch = 'Aconitum napellus'").get()
           || db.prepare('SELECT * FROM pflanzen WHERE bild_ki = 1 LIMIT 1').get();
    zeig('Einzelpflanze', textPflanze(p, giftigkeit));

    // Die Winterfassung braucht eine Pflanze mit einem Winteraspekt aus WINTER_WERT — sonst
    // wirft sie, und das ist richtig so. Für die Vorschau wird deshalb eine gesucht.
    const pw = saisonModul.ladePflanzen(db).find(x => saisonModul.winterAspekt(x));
    if (pw) zeig('Einzelpflanze (Winter)', textPflanzeWinter(pw, giftigkeit));
    else console.log('  Einzelpflanze (Winter) uebersprungen: keine Pflanze mit Winteraspekt im Pool.');

    // Der Beetplan-Text wird aus der LAUFENDEN SEITE gebaut, nicht aus Beispielwerten. Bis zum
    // 18.08.2026 standen hier feste Zahlen (8 m², Schatten) — das echte Schattenbeet hat 6 m²
    // und Halbschatten. Die Vorschau widersprach also dem Bild, das daneben erzeugt wurde.
    // Eine Vorschau, die etwas anderes zeigt als die Veröffentlichung, ist keine.
    try {
      const html = await beetModul.holeSeite('/beispiel/schattenbeet');
      const { namen, gift } = beetModul.ausSeiteLesen(html);
      const beispiel = {
        slug: 'schattenbeet',
        h1: (html.match(/<h1[^>]*>([^<]+)/) || [])[1],
        title: (html.match(/<title>([^<|]+)/) || [])[1] || '',
        flaeche: (html.match(/Fläche<\/div>\s*<div[^>]*>([\d.,]+) m²/) || [])[1],
        licht: (html.match(/Licht<\/div>\s*<div[^>]*>([^<]+)/) || [])[1],
      };
      beispiel.title = beispiel.title.trim();
      zeig('Beetplan', textBeetplan(beispiel, namen.length, gift));
    } catch (e) {
      console.log('\n── Beetplan ──');
      console.log('  übersprungen: ' + e.message);
      console.log('  (braucht den laufenden Server — PIN_PORT setzen, wenn er nicht auf 3003 läuft.');
      console.log('   Feste Beispielwerte gibt es hier bewusst nicht mehr: Sie widersprachen dem Pin.)');
    }

    /* Ausgelassen wird LAUT, nicht still. Auf einem unvollständigen Datenstand findet
     * findeKombinationen() oder saisonAuswahl() nichts, und der Zweig sprang bis zum
     * 21.09.2026 wortlos darüber hinweg: Die Vorschau sah dann vollständig aus und hatte
     * zwei Sorten weniger. Wer sich auf sie verlässt, muss sehen, was sie nicht zeigt. */
    const k = kombiModul.findeKombinationen(kombiModul.ladePflanzen(db), { anzahl: 1 })[0];
    if (k) zeig('Kombination', textKombination(k, giftigkeit));
    else console.log('\n── Kombination ──\n  übersprungen: findeKombinationen() findet in dieser Datenbank keine.');

    const sp = saisonModul.ladePflanzen(db);
    for (const m of [8, 12]) {
      const s = saisonModul.saisonAuswahl(sp, { monat: m });
      if (s) zeig(`Saison (${L.MON_NAME[m - 1]})`, textSaison(s, giftigkeit));
      else console.log(`\n── Saison (${L.MON_NAME[m - 1]}) ──\n  übersprungen: saisonAuswahl() findet für diesen Monat keine sechs Stauden.`);
    }

    // Ratgeber: derselbe Weg wie in pins-erzeugen.js — ladeArtikel() liefert die Auswahl,
    // ersterSatz() mit denselben Grenzen (60/480) den Teaser. Keine Beispielwerte: Ein fest
    // getippter Artikel zeigte einen Text, den so nie ein Pin trägt.
    const artikel = ratgeberModul.ladeArtikel(db);
    if (artikel.length) zeig('Ratgeber', textRatgeber(artikel[0], ratgeberModul.ersterSatz(artikel[0].inhalt, 60, 480)));
    else {
      console.log('\n── Ratgeber ──');
      console.log('  übersprungen: ladeArtikel() findet in dieser Datenbank keinen Artikel (Tabelle `wissen`).');
    }

    // Pflege: bewusst NICHT gezeigt, statt mit nachgebauten Werten so zu tun. Begründung und
    // der eine Schritt, der noch fehlt, stehen im Kopf dieser Datei unter „WAS --probe ZEIGT".
    console.log('\n── Pflege ──');
    console.log('  nicht vorschaubar: textPflege() braucht das Objekt `seite` (Titel, Hinweis, ausgezählter');
    console.log('  Inhaltssatz), das scripts/pins-erzeugen.js aus der Pflegeauswertung baut und nicht');
    console.log('  herausreicht. Hier nachgebaut wäre es eine zweite Fassung desselben Textes — dann');
    console.log('  zeigte die Vorschau nicht mehr, was veröffentlicht wird.');
  })().catch(e => { console.error('Fehler:', e.message); process.exit(1); });
}

module.exports = { textPflanze, textPflanzeWinter, textBeetplan, textKombination, textSaison,
                   textRatgeber, textPflege, kuerzen, slugify };
