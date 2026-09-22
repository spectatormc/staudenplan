/*
 * Erzeugt alle Pinterest-Pins als Dateien unter public/pins/ und schreibt daneben
 * public/pins/liste.json mit Titel, Beschreibung, Ziellink und Pinnwand je Pin.
 *
 *   node scripts/pins-erzeugen.js                 alles, vorhandene Dateien bleiben stehen
 *   node scripts/pins-erzeugen.js --neu           vorhandene überschreiben
 *   node scripts/pins-erzeugen.js --neu-unveroeffentlicht
 *                                                 vorhandene überschreiben, aber NUR bei Pins,
 *                                                 die noch nicht veröffentlicht sind
 *   node scripts/pins-erzeugen.js --nur pflanze   nur eine Sorte
 *                                                 (pflanze|pflanze-winter|beetplan|saison|kombi|ratgeber|pflege)
 *   node scripts/pins-erzeugen.js --limit 5       höchstens N je Sorte, für Probeläufe
 *
 * WARUM DATEIEN UND NICHT AUF ZURUF: Pinterest lädt das Bild selbst von einer öffentlichen
 * Adresse — beim RSS-Weg wie über die API. Eine Route, die den Pin erst beim Abruf rendert,
 * hieße ImageMagick im Anfragepfad, und ein Pin braucht ein bis zwei Sekunden. Erzeugen ist
 * ein Stapellauf, Ausliefern macht express.static.
 *
 * DIE LISTE IST DIE QUELLE FÜR DEN FEED. Sie entsteht im selben Lauf wie die Bilder, damit
 * Bild und Text nicht auseinanderlaufen können — genau der Fehler, der am 18.08.2026 auffiel,
 * als die Vorschau 8 m² behauptete und der Pin daneben 6 m² zeigte.
 *
 * pubDate WIRD ÜBERNOMMEN, NICHT NEU GESETZT: Pinterest veröffentlicht aus einem Feed das
 * Älteste zuerst. Wer die Bilder neu erzeugt, darf die Reihenfolge nicht durcheinanderbringen
 * und schon veröffentlichte Pins nicht wieder nach vorn holen.
 *
 * REIHENFOLGE IM LAUF: Was den laufenden Server braucht — die Beetplan-Seiten —, wird GANZ AM
 * ANFANG geholt, vor der ersten Datei. Seit die Kennzeichnung auch liegende Dateien anfasst,
 * ist ein Abbruch in der Mitte nicht mehr folgenlos: Die Dateien sind dann um rund 530 Byte
 * gewachsen, waehrend liste.json die alten enclosure-Laengen truege — und die liest Pinterest
 * aus dem Feed. Bricht der Lauf trotzdem ab, schreibt der Abbruchzweig liste.json und misst
 * fuer die noch nicht bearbeiteten Pins die Dateigroesse frisch.
 *
 * --neu-unveroeffentlicht: WOFÜR ES DEN DRITTEN SCHALTER GIBT.
 *
 * Seit dem 22.09.2026 schreiben die Bildbauer beim Zeichnen die IDs der abgebildeten Pflanzen
 * in die JPEG-Datei (bildKommentarArgs() in pin-layout.js). Nur damit kann
 * scripts/check-pin-deckung.js belegen, dass die Beschreibung eines Pins dieselben Pflanzen
 * nennt, die auf seinem Bild zu sehen sind. Den Kommentar bekommt aber nur ein NEU gebautes
 * Bild — die rund 490 schon liegenden, noch nicht fälligen Dateien hätten ihn nie, und die
 * Prüfung bliebe auf Dauer rot. Eine Prüfung, die nie grün wird, schaltet man ab.
 *
 * "--neu" löst das nicht: Es baut auch die Bilder der bereits veröffentlichten Pins neu. Deren
 * Datei darf sich nicht ändern — ihre Adresse steht bei Pinterest, und die Landeseiten zeigen
 * genau diese Auswahl. Deshalb der eigene Schalter, der den Neubau erzwingt und dabei die
 * Unterscheidung benutzt, die bauen() ohnehin trifft: S.istVeroeffentlicht(). Was fällig ist,
 * bleibt unangetastet; ob eine Datei neu gebaut wird, entscheidet sich damit an derselben
 * Regel wie das Einfrieren des Textes und wie der Termin in pin-termine.js.
 *
 * Mit "--nur <sorte>" lässt er sich eingrenzen, etwa auf die vier Sorten mit Pflanzenbild.
 * Zusammen mit "--neu" bricht der Lauf ab: Die beiden Schalter sagen Gegenteiliges.
 *
 * KI-KENNZEICHNUNG: Jeder Pin mit KI-erzeugtem Bild bekommt in bauen() das IPTC-Feld
 * DigitalSourceType in die JPEG-Datei geschrieben (pin-ki-metadaten.js). Das geschieht
 * ABSICHTLICH auch für Dateien, die in diesem Lauf nicht neu gebaut werden — sonst blieben
 * die bereits liegenden Pins für immer ungekennzeichnet. Welche Sorten das betrifft, steht
 * als KI_PIN_SORTEN in pin-layout.js und steuert von dort aus auch den Satz „Bild:
 * KI-erzeugte Illustration." in der Beschreibung.
 */
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const WURZEL = path.join(__dirname, '..');
const ZIEL = path.join(WURZEL, 'public', 'pins');
const LISTE = path.join(ZIEL, 'liste.json');
const BASIS = 'https://www.staudenplan.de';

const argv = process.argv.slice(2);
const wert = name => {
  const gleich = argv.find(x => x.startsWith(`--${name}=`));
  if (gleich) return gleich.split('=').slice(1).join('=');
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : null;
};
const NEU = argv.includes('--neu');
/* Neubau nur für das, was noch nicht draußen ist — Begründung im Modulkopf. Geprüft wird mit
 * argv.includes(), also auf genaue Gleichheit: '--neu' bleibt '--neu', auch wenn der zweite
 * Schalter damit anfängt. */
const NEU_UNVEROEFFENTLICHT = argv.includes('--neu-unveroeffentlicht');
const NUR = wert('nur');

/* Die beiden Schalter zusammen wären eine Zusage, die der Lauf nicht einhält:
 * --neu-unveroeffentlicht verspricht, die veröffentlichten Bilder nicht anzufassen, --neu
 * baut genau sie mit. Ein stilles "--neu gewinnt" hieße, dass jemand mit dem Vorsatz, die
 * Pinterest-Bilder zu schonen, sie gerade überschreibt. */
if (NEU && NEU_UNVEROEFFENTLICHT) {
  console.error('--neu und --neu-unveroeffentlicht schliessen sich aus: --neu baut auch die Bilder der');
  console.error('bereits veroeffentlichten Pins neu, --neu-unveroeffentlicht sagt zu, genau das nicht zu tun.');
  process.exit(1);
}
const LIMIT = Number(wert('limit')) || 0;

const db = new Database(process.env.DB_PFAD || path.join(WURZEL, 'stauden.db'), { readonly: true });
const { giftigkeit } = require('./pflanzen-giftigkeit');
const L = require('./pin-layout');
const S = require('./pin-sorten');        // Sortennamen und „veröffentlicht": dieselben wie im Terminlauf
const WA = require('./winterbild-auftrag'); // Aspektliste, Spaltenname, winterBildQuelle()
const kiMeta = require('./pin-ki-metadaten');
const txt = require('./pin-text');
const bildModul = require('./pin-bild');
const beetModul = require('./pin-beetplan');
const kombiModul = require('./pin-kombination');
const saisonModul = require('./pin-saison');
const ratgeberModul = require('./pin-ratgeber');

// Dieselbe Regel wie PLANBAR in stauden-server.js. Doppelt formuliert, weil der Stapellauf
// den Server nicht laedt — bei einer Aenderung dort muss sie hier nachgezogen werden.
const PLANBAR_SQL = `(wuchs IS NULL OR wuchs != 'invasiv')
  AND (status IS NULL OR status = 'live')
  AND (winterhart_zone IS NULL OR winterhart_zone <= 7)
  AND (lebensdauer IS NULL OR lebensdauer != 'einjaehrig')`;

fs.mkdirSync(ZIEL, { recursive: true });
const vorher = fs.existsSync(LISTE) ? JSON.parse(fs.readFileSync(LISTE, 'utf8')) : [];
const frueher = Object.fromEntries(vorher.map(e => [e.guid, e]));

/* DIE ZUSAGE DES SCHALTERS HAENGT AN DIESER LISTE. --neu-unveroeffentlicht unterscheidet
 * veroeffentlicht von unveroeffentlicht ausschliesslich ueber frueher[guid].geplant_am.
 * Fehlt liste.json oder ist sie leer, ist istVeroeffentlicht() fuer JEDEN Pin false — der
 * Schalter wuerde dann genau die Bilder neu bauen, die er schonen soll, und die Bilanzzeile
 * meldete brav "0 veroeffentlichte unangetastet". Eine Zusage, deren Grundlage fehlt, wird
 * nicht abgeleitet, sondern abgelehnt. */
if (NEU_UNVEROEFFENTLICHT && !vorher.length) {
  console.error('--neu-unveroeffentlicht braucht eine gefuellte ' + LISTE + ':');
  console.error('Ohne sie gilt jeder Pin als unveroeffentlicht, und der Schalter wuerde genau');
  console.error('die Bilder neu bauen, die er schonen soll. Erst einen normalen Lauf machen.');
  process.exit(1);
}

const liste = [];
let erzeugt = 0, vorhanden = 0, fehler = 0;
let kiNeu = 0, kiSchon = 0, kiUnmoeglich = 0;
// Nur fuer --neu-unveroeffentlicht: was der Schalter wirklich angefasst und was er
// ausgelassen hat. Eine Zusage, die man nicht nachzaehlen kann, ist keine.
let neuUnveroeffentlicht = 0, geschontVeroeffentlicht = 0;

/*
 * Ein Eintrag entsteht nur, wenn die Bilddatei danach wirklich existiert. Ein Feed, der auf
 * ein fehlendes Bild zeigt, wird von Pinterest stillschweigend übergangen — der Pin fehlt
 * dann einfach, ohne dass irgendwo ein Fehler steht.
 */
const HEUTE = new Date().toISOString().slice(0, 10);

/*
 * Ankunft je Pin messbar machen: utm_content traegt die Kennung. Bis zum 08.09.2026 trugen alle
 * Pins denselben Link — Pinterest meldete 108 ausgehende Klicks auf fuenf Pins, Plausible zaehlte
 * fuenf Besucher, und im Server-Log liess sich keiner einem Pin zuordnen.
 */
function mitKennung(link, guid) {
  if (/[?&]utm_content=/.test(link)) return link;
  return link + (link.includes('?') ? '&' : '?') + 'utm_content=' + encodeURIComponent(guid);
}

/*
 * Was ausser dem Feed noch an einem Listeneintrag haengt. Wird beim Auslassen eines Pins
 * mitgemeldet: Bei der Sorte saison baut stauden-server.js aus genau diesem Eintrag die
 * Landeseite /blueht-im/<slug> bzw. /winterbeet/<slug>, und dieselbe Liste speist den
 * Sitemap-Block. Ein ausgelassener Saison-Pin nimmt also eine indexierte Adresse mit.
 */
const FOLGE_AUSLASSEN = {
  saison: '    Damit verschwindet auch die Landeseite (/blueht-im/... bzw. /winterbeet/...): '
        + 'Die Route antwortet danach mit 404, und die Adresse faellt aus der Sitemap.',
};

// Veroeffentlicht = Termin erreicht. Die Regel steht in pin-sorten.js, weil der Terminlauf
// dieselbe braucht: Dort entscheidet sie, welcher Pin auch mit --neu seinen Termin behaelt,
// hier, welcher Text eingefroren bleibt. Zwei Auslegungen waeren ein Pin, dessen Text
// feststeht, waehrend sein Termin in die Zukunft rutscht.
const istVeroeffentlicht = e => S.istVeroeffentlicht(e, HEUTE);

/*
 * liste.json schreiben — am Ende des Laufs UND im Abbruchzweig. Die beiden Faelle
 * unterscheiden sich in dem, was mit den NICHT bearbeiteten Eintraegen geschieht:
 *
 *   vollstaendig=true   Regellauf. Alte Eintraege fallen weg, wenn sie nicht neu entstanden
 *                       sind — genau so verschwindet ein Pin, dessen Pflanze aus dem Pool
 *                       gefallen ist. Bei --nur <sorte> werden die uebrigen Sorten aus der
 *                       alten Liste uebernommen; ohne das loeschte ein "--nur ratgeber" die
 *                       306 anderen Eintraege, und der Feed lieferte nichts mehr.
 *   vollstaendig=false  Abbruch. Alles noch nicht Bearbeitete wird unveraendert uebernommen,
 *                       aber mit frisch gemessener Dateigroesse: Die KI-Kennzeichnung hat die
 *                       Dateien bis dahin schon verlaengert, und eine zu kleine
 *                       enclosure-Laenge im Feed ist genau der Schaden, gegen den die
 *                       Reihenfolge in bauen() geschrieben ist. Ein Eintrag ohne Datei faellt
 *                       weg — ein Feed-Eintrag ohne Bild wird von Pinterest still uebergangen.
 */
function listeSchreiben(vollstaendig) {
  const drin = new Set(liste.map(e => e.guid));
  const uebrig = vollstaendig
    ? (NUR ? vorher.filter(e => e.typ !== NUR) : [])
    : vorher;
  let uebernommen = 0;
  for (const e of uebrig) {
    if (!e || !e.datei || !e.guid || drin.has(e.guid)) continue;
    const p = path.join(ZIEL, e.datei);
    if (!fs.existsSync(p)) continue;
    liste.push(vollstaendig ? e : { ...e, bytes: fs.statSync(p).size });
    drin.add(e.guid);
    uebernommen++;
  }
  if (vollstaendig && NUR) console.log(`--nur ${NUR}: ${uebernommen} Eintraege anderer Sorten uebernommen`);
  if (!vollstaendig) console.error(`Abbruch: ${uebernommen} noch nicht bearbeitete Eintraege aus der alten Liste uebernommen, Dateigroessen neu gemessen.`);
  liste.sort((a, b) => a.guid.localeCompare(b.guid));
  fs.writeFileSync(LISTE, JSON.stringify(liste, null, 1));
}

/*
 * machen(pfad, guid): DIE KENNUNG WIRD HEREINGEREICHT, NICHT ZWEIMAL GEBILDET.
 *
 * Die Bildbauer schreiben die IDs der abgebildeten Pflanzen in die Datei und legen die
 * Kennung dazu (bildKommentarArgs() in pin-layout.js). Gebildet wird sie an den
 * Aufrufstellen weiter unten — 'pflanze-<slug>', 'kombi-<slug>', saisonKennung(s) —, und
 * zwar genau einmal, als Feld 'guid' dieses Aufrufs. bauen() gibt dieselbe Zeichenkette an
 * machen() weiter. Würde pin-bild.js oder pin-kombination.js sie selbst zusammensetzen, gäbe
 * es eine zweite Fassung der Kennungsregel, die beim nächsten Umbenennen auseinanderliefe —
 * und im Bild stünde dann eine Kennung, unter der der Pin nirgends geführt wird.
 * Die Sorten ohne Pflanzenbild ignorieren das zweite Argument; sie schreiben keinen
 * Bildkommentar, weil auf ihrem Bild keine Pflanze zu sehen ist.
 */
/* WANN IST EIN TEXT "NEU"? Nicht: wann wurde er berechnet, sondern wann hat er sich geaendert.
 *
 * Ein frischer Zeitstempel bei jedem Lauf haette Stufe (ii) von check-pin-deckung.js wieder
 * wertlos gemacht: Geprueft werden dort genau die unveroeffentlichten Eintraege, und deren Text
 * wird bei JEDEM Lauf neu gerechnet. Die Pruefung haette also gemessen "Bild aelter als der
 * letzte Lauf" statt "Bild aelter als sein Text" — und nach dem zweiten Lauf jede liegende
 * Datei angezeigt. Genau diese Falschmeldung hat die Pruefung schon einmal gekostet.
 *
 * Deshalb: Stimmt der neu gerechnete Text in allen ausgelieferten Feldern mit dem alten
 * ueberein, behaelt der Eintrag seinen alten Zeitstempel. Erst eine echte Aenderung setzt ihn. */
const TEXTFELDER = ['titel', 'beschreibung', 'link', 'alt', 'board'];
function textZeitstempel(alt, t, eingefroren) {
  if (eingefroren) return alt.text_am || null;
  const gleich = alt && TEXTFELDER.every(f => String(alt[f] ?? '') === String(t[f] ?? ''));
  if (gleich && alt.text_am) return alt.text_am;
  return new Date().toISOString();
}

async function bauen({ guid, datei, typ, machen, text, extra = {}, erzwingen = false, quellen = null }) {
  const pfad = path.join(ZIEL, datei);
  const dawar = fs.existsSync(pfad);

  /* ── Der alte Eintrag wird HIER geholt, nicht erst beim Text ─────────────────────────
   *
   * Beide Zeilen standen bis zum 22.09.2026 unter dem Bau-Zweig, beim Einfrieren des Textes.
   * Dort sind sie zu spät: --neu-unveroeffentlicht muss VOR dem Bau wissen, ob dieser Pin
   * schon draußen ist. Es sind reine Nachschlagevorgänge ohne Nebenwirkung — der TEXT wird
   * weiterhin erst unten gerechnet, die Reihenfolge Text-vor-KI-Block bleibt unberührt.
   * Gefragt wird mit derselben Regel wie überall im Pin-Kanal (S.istVeroeffentlicht).
   */
  const alt = frueher[guid];
  const veroeffentlicht = istVeroeffentlicht(alt);

  /* Der Neubau, den --neu-unveroeffentlicht erzwingt — und die Grenze, die ihn von --neu
   * unterscheidet. Ein veröffentlichter Pin behält seine Datei Byte für Byte: Seine Adresse
   * steht bei Pinterest, und die Landeseite zeigt genau die Auswahl, die auf diesem Bild
   * ist. Neu gebaut wird also nur, was noch niemand gesehen hat. */
  /* alt MUSS dastehen: Eine Datei ohne Listeneintrag ist nicht "noch nicht veroeffentlicht",
   * sondern unbekannter Herkunft — etwa die verwaiste pflanze-artemisia-arborescens.jpg vom
   * 18.08.2026, deren Pflanze noch am selben Tag aus dem Bestand fiel. Schweigen der Liste
   * ist kein Beleg. */
  const neuWeilUnveroeffentlicht = NEU_UNVEROEFFENTLICHT && Boolean(alt) && !veroeffentlicht;

  if (!dawar || NEU || erzwingen || neuWeilUnveroeffentlicht) {
    try {
      await machen(pfad, guid);
      erzeugt++;
      if (neuWeilUnveroeffentlicht && dawar) neuUnveroeffentlicht++;
    } catch (e) {
      console.error(`  ! ${datei}: ${e.message}`);
      fehler++;
      return;
    }
  } else {
    vorhanden++;
    // In diesem Zweig und bei gesetztem Schalter kann der Pin nur veröffentlicht sein:
    // Wäre er es nicht, hätte neuWeilUnveroeffentlicht ihn oben in den Neubau geschickt.
    if (NEU_UNVEROEFFENTLICHT) geschontVeroeffentlicht++;
  }
  if (!fs.existsSync(pfad)) {
    console.error(`  ! Datei fehlt nach dem Erzeugen: ${datei}`);
    fehler++;
    return;
  }

  /* ── Text und Gegenprobe ZUERST ─────────────────────────────────────────────────────
   *
   * Der Text stand bis zum 21.09.2026 hinter dem KI-Block. Er gehoert davor: Er bringt die
   * Sorte und die KI-Entscheidung mit, gegen die die Kennzeichnung der Datei geprueft wird.
   * Stand er dahinter, prueft der KI-Block nur seinen eigenen Parameter gegen sich selbst.
   *
   * Was schon draussen ist, bleibt wie es ist: Titel, Beschreibung, Pinnwand und vor allem der
   * Link kommen aus der alten Liste. Pinterest friert den Pin beim Veroeffentlichen ein — ein
   * geaenderter Text im Feed aendert dort nichts mehr, eine geaenderte URL koennte aber als
   * neuer Eintrag gelesen werden, und ein neu berechneter Text kann vom liegenden Bild
   * abweichen. Faellig heisst veroeffentlicht: Der Feed liefert ab dem Tag, Pinterest liest
   * taeglich.
   */
  // `alt` und `veroeffentlicht` stehen seit dem 22.09.2026 am Anfang der Funktion — die
  // Bauentscheidung braucht sie schon dort (--neu-unveroeffentlicht). Hier wird nur noch
  // gefragt, ob der Text dieses Eintrags eingefroren ist.
  const eingefroren = veroeffentlicht && typeof alt.titel === 'string' && typeof alt.link === 'string';
  const t = eingefroren ? alt : text();
  const kiSorte = L.istKiPin(typ);

  /* EIN BEFUND NIMMT EINEN UNVEROEFFENTLICHTEN PIN AUS DER LISTE — EINEN VEROEFFENTLICHTEN
   * NICHT.
   *
   * Ohne Listeneintrag gibt es keinen Feed-Eintrag, und bei der Sorte saison haengen zwei
   * weitere Ausgabepfade an demselben Eintrag (FOLGE_AUSLASSEN). Einen bereits
   * veroeffentlichten Pin zu streichen hiesse, eine indexierte Adresse abzureissen, waehrend
   * sein Bild bei Pinterest weiter darauf zeigt. Ein Pin ohne maschinenlesbares Feld ist eine
   * Luecke; eine tote Landeseite ist ein Schaden. Gemeldet wird beides, ausgelassen nur das
   * Erste — und der Lauf endet so oder so mit Exitcode 1.
   */
  let verwerfen = false;
  const befund = grund => {
    fehler++;
    if (veroeffentlicht) {
      console.error(`  ! ${datei}: ${grund} Bereits veroeffentlicht — der Eintrag bleibt in der Liste.`);
      return;
    }
    console.error(`  ! ${datei}: ${grund} Pin ausgelassen.`);
    if (FOLGE_AUSLASSEN[typ]) console.error(FOLGE_AUSLASSEN[typ]);
    verwerfen = true;
  };

  /* Die Sorte erreicht die beiden Kennzeichnungen auf zwei Wegen: einmal als `typ` an fertig()
   * (Satz in der Beschreibung), einmal als `typ` an bauen() (Feld in der Datei). Beide kommen
   * aus S.TYP, ein Tippfehler ist damit ausgeschlossen — eine Umbenennung auf nur einer Seite
   * aber nicht. Deshalb wird hier verglichen, statt sich darauf zu verlassen.
   * Bei einem eingefrorenen Pin stammt `t` aus liste.json: `typ` steht dort seit je, `kiBild`
   * seit dem 21.09.2026. Fehlt es in einem alten Eintrag, entfaellt dieser eine Vergleich. */
  if (typeof t.typ === 'string' && t.typ !== typ) {
    befund(`Sorte im Text ("${t.typ}") und Sorte der Datei ("${typ}") stimmen nicht ueberein.`);
    if (verwerfen) return;
  }
  if (typeof t.kiBild === 'boolean' && t.kiBild !== kiSorte) {
    befund(`Der Text sagt "${t.kiBild ? 'KI-Bild' : 'kein KI-Bild'}", die Sorte "${typ}" sagt das Gegenteil.`);
    if (verwerfen) return;
  }

  /* ── Maschinenlesbare KI-Kennzeichnung ──────────────────────────────────────────────
   *
   * DIE STELLE IST NICHT BELIEBIG, DESHALB STEHT DAS HIER:
   *
   * (a) AUSSERHALB des Zweigs `if (!dawar || NEU || erzwingen || neuWeilUnveroeffentlicht)` weiter oben. Der läuft nur,
   *     wenn das Bild NEU gebaut wird. Stünde die Kennzeichnung dort, bekämen die bereits
   *     liegenden Dateien sie NIE — im Normallauf sind das fast alle, darunter sämtliche
   *     Saison-Raster, die nur bei geänderter Auswahl neu gebaut werden. So werden sie beim
   *     nächsten Lauf nebenbei nachgerüstet, ohne `--neu` und ohne ein einziges Bild neu zu
   *     rendern.
   *
   * (b) VOR `bytes: fs.statSync(pfad).size` weiter unten. Das Einfügen verlängert die Datei
   *     um rund 530 Byte. Erst messen und dann schreiben hieße, dass in liste.json eine zu
   *     kleine enclosure-Länge steht — und die liest Pinterest aus dem Feed.
   *
   * (c) NACH der Existenzprüfung, weil kennzeichnen() eine fertige Datei voraussetzt.
   *
   * Die Operation ist idempotent (siehe pin-ki-metadaten.js): Ein zweiter Lauf findet das
   * Feld und rührt die Datei nicht an. Täglich laufen lassen ändert also nach dem ersten Mal
   * nichts mehr.
   */
  if (kiSorte) {
    // Erst belegen, dann behaupten. Der Sortenname reicht nicht — die Garantie steckt im
    // Lader (`bild_ki = 1`), nicht im Wort „pflanze". Fehlt der Beleg, geht der Pin gar
    // nicht erst hinaus: Seine Beschreibung sagt „Bild: KI-erzeugte Illustration.", und ein
    // Pin, dessen Text etwas behauptet, was wir nicht belegen können, ist schlimmer als ein
    // fehlender Pin. Ein bereits veroeffentlichter bleibt dagegen in der Liste — dort ist der
    // Schaden groesser (siehe befund() oben). Der Lauf endet so oder so mit Exitcode 1.
    const unbelegt = L.kiHerkunftFehler(quellen);
    if (unbelegt) {
      befund(`KI-Kennzeichnung nicht belegbar — ${unbelegt}.`);
      if (verwerfen) return;
      kiUnmoeglich++;                    // veroeffentlicht: Eintrag bleibt, Feld fehlt
    } else {
      /* Ein WIDERSPRUCH verwirft den Pin nicht. Das verlaessliche Feld ist bild_ki, die Lizenz
       * ist es nicht: id 698 (Bergenia 'Silberlicht') traegt bild_ki=1 und dazu
       * "Pixabay License" und steht im Pin-Pool. Solche Zeilen gehoeren ins Log und in die
       * Datenpflege — verworfen wird nur, was UNBELEGT ist. */
      for (const w of L.kiHerkunftWidersprueche(quellen)) {
        console.error(`  ~ ${datei}: Bildherkunft widerspruechlich — ${w}`);
      }
      try {
        const r = kiMeta.kennzeichnen(pfad);
        if (r.status === 'geschrieben') kiNeu++;
        else if (r.status === 'vorhanden') kiSchon++;
        else {
          // Datei bleibt in der Liste: Der Hinweis in der Beschreibung stimmt weiterhin, nur
          // die maschinenlesbare Fassung fehlt. Das ist eine Lücke, keine Falschaussage —
          // aber eine, die sichtbar werden muss.
          console.error(`  ! ${datei}: KI-Kennzeichnung nicht geschrieben (${r.status})`);
          kiUnmoeglich++;
          fehler++;
        }
      } catch (e) {
        console.error(`  ! ${datei}: KI-Kennzeichnung: ${e.message}`);
        kiUnmoeglich++;
        fehler++;
      }
    }
  } else {
    /* Die andere Richtung, und sie ist genauso wichtig: Eine KI-Kennzeichnung auf einem Pin,
     * der keine Illustration zeigt, ist kein überflüssiger Hinweis, sondern eine neue
     * Falschaussage — maschinenlesbar und damit an Pinterest, Meta und Google gerichtet.
     * Betrifft Beetplan (gezeichnete Skizze), Ratgeber und Pflege (reine Typografie).
     * Gefunden wird sie gemeldet, nicht automatisch entfernt: Warum sie dasteht, weiß dieses
     * Skript nicht, und blind Metadaten aus einer Bilddatei zu schneiden ist genau das
     * Vorgehen, das wir bei den C2PA-Manifesten ausdrücklich ablehnen. */
    try {
      if (kiMeta.lesen(fs.readFileSync(pfad)) === 'ja') {
        console.error(`  ! ${datei}: trägt eine KI-Kennzeichnung, obwohl die Sorte "${typ}" kein KI-Bild zeigt.`);
        fehler++;
      }
    } catch (e) {
      console.error(`  ! ${datei}: Prüfung auf falsche KI-Kennzeichnung fehlgeschlagen: ${e.message}`);
      fehler++;
    }

    /* Und die Richtung, die Hausregel 2 zuerst nennt: ein KI-Bild OHNE Kennzeichnung. Eine
     * neue Sorte, die Bilder mit bild_ki=1 zeigt und beim Eintragen in KI_PIN_SORTEN vergessen
     * wird, ginge sonst ohne BEIDE Kennzeichnungen hinaus — ohne den Satz in der Beschreibung
     * und ohne das Feld in der Datei —, und kein Lauf meldete etwas. Gefragt wird am Beleg,
     * nicht am Namen: Sind Quellpflanzen uebergeben und loest keine davon einen Befund aus
     * (alle bild_ki=1), dann fehlt die Sorte in der Liste.
     * Die heutigen Nicht-KI-Sorten haben kein Pflanzenbild — der Beetplan zeichnet eine Skizze,
     * Ratgeber und Pflege sind reine Typografie —, sie uebergeben deshalb begruendet kein
     * `quellen`, und die Pruefung entfaellt. Sie greift bei der ersten Sorte, die eines hat. */
    if (quellen && !L.kiHerkunftFehler(quellen)) {
      console.error(`  ! ${datei}: Alle Quellbilder sind KI-erzeugt (bild_ki=1), aber die Sorte "${typ}" steht nicht in KI_PIN_SORTEN — der Pin ginge ohne beide Kennzeichnungen hinaus.`);
      fehler++;
    }
  }

  liste.push({
    guid, typ, datei,
    bild: `${BASIS}/pins/${datei}`,
    titel: t.titel,
    beschreibung: t.beschreibung,
    link: eingefroren ? alt.link : mitKennung(t.link, guid),
    alt: t.alt,
    board: t.board,
    // Steht in der Liste, damit der naechste Lauf auch einen eingefrorenen Pin gegenpruefen
    // kann, ohne seinen Text neu zu rechnen (siehe die Gegenprobe oben).
    kiBild: typeof t.kiBild === 'boolean' ? t.kiBild : kiSorte,
    bytes: fs.statSync(pfad).size,
    pubDate: alt?.pubDate || new Date().toUTCString(),
    /* WANN DER TEXT DIESES EINTRAGS ENTSTANDEN IST — je Eintrag, nicht je Lauf.
     *
     * Gelesen wird das Feld von scripts/check-pin-deckung.js, Stufe (ii): Ist die Bilddatei
     * deutlich älter als der Text DIESES Pins, stammen Bild und Beschreibung aus
     * verschiedenen Läufen — genau die Lage des Vorfalls bei saison-12 (Bild 10:45, Text
     * 13:14). Gegen die Änderungszeit von liste.json ließe sich das nicht messen: Die wird
     * bei jedem Lauf neu geschrieben, die Bilddateien bleiben ohne --neu stehen, und damit
     * wäre ab dem zweiten Lauf jede nicht neu gebaute Datei "älter als der Text".
     *
     * Ein eingefrorener Pin behält den Zeitstempel seiner Veröffentlichung. Sein Text wurde
     * nicht neu gerechnet (er kommt aus alt), also darf er auch nicht frisch aussehen — sonst
     * behauptete die Liste einen Text von heute über ein Bild von damals. Fehlt das Feld in
     * einem alten Eintrag, bleibt es null: Die Prüfung sagt dann "nicht prüfbar" statt zu
     * raten. Veröffentlichte Pins prüft sie ohnehin nicht mehr. */
    text_am: textZeitstempel(alt, t, eingefroren),
    // Einmal vergebener Termin bleibt. Ein Neulauf der Bilder darf einen Pin nicht
    // umterminieren — und schon veroeffentlichte schon gar nicht.
    ...(alt?.geplant_am ? { geplant_am: alt.geplant_am } : {}),
    ...extra,
  });
}

(async () => {
  /* ── ZUERST ALLES, WAS DEN LAUFENDEN SERVER BRAUCHT ────────────────────────
   *
   * Der Beetplan-Pin ist der einzige Inhalt, der nicht aus der Datenbank kommt: Seine Zahlen
   * stehen auf /beispiele und /beispiel/<slug>, und der Lauf holt sie ueber HTTP. Faellt der
   * Abruf aus (Server nicht gestartet, anderer Port), wirft holeSeite, und der aeussere catch
   * beendet den Lauf. Das darf er nur, solange noch keine Datei angefasst ist: Seit die
   * KI-Kennzeichnung auch liegende Dateien verlaengert, hinterliesse ein Abbruch mittendrin
   * gewachsene Bilder und eine liste.json mit den alten enclosure-Laengen — genau das, was
   * die Reihenfolge in bauen() verhindern soll. Deshalb steht der Abruf hier oben, vor der
   * ersten bauen()-Aufrufstelle.
   */
  let beetSeiten = null;
  if (!NUR || NUR === S.TYP.beetplan) {
    const uebersicht = await beetModul.holeSeite('/beispiele');
    let slugs = [...new Set([...uebersicht.matchAll(/href="\/beispiel\/([a-z-]+)"/g)].map(m => m[1]))];
    if (LIMIT) slugs = slugs.slice(0, LIMIT);
    beetSeiten = [];
    for (const slug of slugs) {
      const html = await beetModul.holeSeite(`/beispiel/${slug}`);
      const gelesen = beetModul.ausSeiteLesen(html);
      const b = {
        slug,
        h1: (html.match(/<h1[^>]*>([^<]+)/) || [])[1],
        title: ((html.match(/<title>([^<|]+)/) || [])[1] || '').trim(),
        flaeche: (html.match(/Fläche<\/div>\s*<div[^>]*>([\d.,]+) m²/) || [])[1],
        licht: (html.match(/Licht<\/div>\s*<div[^>]*>([^<]+)/) || [])[1],
      };
      beetSeiten.push({ b, gelesen });
    }
    console.log(`Beetplaene vorbereitet: ${beetSeiten.length} Seite(n) gelesen`);
  }

  // ── Einzelpflanzen ─────────────────────────────────────────────────────────
  // ladePflanzen aus pin-saison bringt die vollständige Auswahlkette mit: bild_ki, eigener
  // deutscher Name, Beetstaude, hier winterhart, Bilddatei vorhanden.
  if (!NUR || NUR === S.TYP.pflanze) {
    let pflanzen = saisonModul.ladePflanzen(db);
    if (LIMIT) pflanzen = pflanzen.slice(0, LIMIT);
    console.log(`Einzelpflanzen: ${pflanzen.length}`);
    for (const p of pflanzen) {
      const slug = txt.slugify(p.name_botanisch);
      await bauen({
        guid: `pflanze-${slug}`, datei: `pflanze-${slug}.jpg`, typ: S.TYP.pflanze,
        machen: (z, kennung) => bildModul.pinBild(p, z, { guid: kennung }),
        text: () => txt.textPflanze(p, giftigkeit),
        quellen: [p],
      });
    }
  }

  /* ── Einzelpflanzen im Winter ───────────────────────────────────────────────
   *
   * Zweiter Pin je Pflanze, mit eigenem Bild und eigener Kennung (pflanze-winter-<slug>).
   * Derselbe Pool, dieselbe Auswahlkette, dieselbe Landeseite — nur zeigt die Faktenzeile
   * statt der Bluehzeit den Winteraspekt. Die Bluehzeit-Fassung bleibt bestehen.
   *
   * Gebaut wird nur fuer Pflanzen, deren `winteraspekt` EXAKT einem Schluessel aus
   * WINTER_WERT entspricht (pin-saison.js). Wer keinen hat — „unauffaellig" oder ein frei
   * formulierter Satz ueber das Einziehen —, bekommt keinen: In der Produktion sind das
   * 126 von 277 Pflanzen des Pools. Die Prosa wird NICHT nach Stichwoertern durchsucht.
   *
   * Die Sorte traegt ein KI-Bild und steht deshalb in KI_PIN_SORTEN (pin-layout.js). Ohne
   * diesen Eintrag ginge sie ohne Kennzeichnung hinaus — weder der Satz in der Beschreibung
   * noch das Feld in der Datei. Die Gegenprobe darauf laeuft in bauen().
   */
  if (!NUR || NUR === S.TYP.pflanzeWinter) {
    let pflanzen = saisonModul.ladePflanzen(db).filter(p => saisonModul.winterAspekt(p));
    if (LIMIT) pflanzen = pflanzen.slice(0, LIMIT);
    /* NACHGEZAEHLT, NICHT ANGENOMMEN: Wie viele dieser Pins zeigen wirklich ein Winterbild?
     * Der Rueckfall auf das Bluehbild ist erlaubt (nicht jede Pflanze hat schon eines), aber
     * er darf nicht unbemerkt die Regel werden — etwa wenn winterbilder-erzeugen.js mit
     * --limit lief oder auf halber Strecke abbrach. Ohne diese Zahl saehe ein Lauf mit 12
     * Winterbildern genauso aus wie einer mit 163. */
    let mitWinterbild = 0;
    for (const p of pflanzen) { try { if (WA.winterBildQuelle(p).eigen) mitWinterbild++; } catch { /* Spalte nicht geladen — meldet winterBildQuelle an der Bildstelle */ } }
    console.log(`Einzelpflanzen im Winter: ${pflanzen.length}` + ` · davon mit eigenem Winterbild: ${mitWinterbild}` + (mitWinterbild < pflanzen.length ? ` · ${pflanzen.length - mitWinterbild} noch mit Bluehbild` : ''));
    const winterDateien = [];
    for (const p of pflanzen) {
      const slug = txt.slugify(p.name_botanisch);
      const datei = `${S.TYP.pflanzeWinter}-${slug}.jpg`;
      const guid = `${S.TYP.pflanzeWinter}-${slug}`;
      winterDateien.push({ p, datei, guid });
      await bauen({
        guid, datei,
        typ: S.TYP.pflanzeWinter,
        machen: (z, kennung) => bildModul.pinBild(p, z, { winter: true, guid: kennung }),
        text: () => txt.textPflanzeWinter(p, giftigkeit),
        quellen: [p],
      });
    }

    /* DIE LUECKE, DIE SONST STILL BLIEBE: Ein Winterbild in der Datenbank wandert nicht von
     * selbst in die Pin-Datei. Die JPEGs sind fertige Dateien, keine Ansicht auf die
     * Datenbank, und ohne --neu-unveroeffentlicht bleibt eine liegende Datei stehen. Wer also
     * scripts/winterbilder-erzeugen.js laufen laesst und danach nur den gewoehnlichen Lauf
     * macht, hat 163 bezahlte Bilder auf der Platte und unveraenderte Pins — ohne eine
     * einzige Meldung.
     *
     * Gemessen wird am Ende des Laufs, also am Ergebnis: Ist die Pin-Datei aelter als das
     * Winterbild, ist sie vor ihm gebaut worden und zeigt das Bluehbild.
     *
     * KEIN Fehler und kein Exitcode 1: Der Pin ist dadurch nicht falsch — er sagt ueber das
     * Bild nichts, was nicht stimmt, und zeigt genau das, was er vor dieser Pipeline gezeigt
     * hat. Er ist nur nicht besser geworden. Gemeldet gehoert es trotzdem, laut und mit dem
     * Befehl dazu. */
    const veraltet = winterDateien.filter(({ p, datei, guid }) => {
      /* Veroeffentlichte Pins bleiben aussen vor: Ihre Datei liegt bei Pinterest, sie wird
       * bewusst nicht mehr angefasst — sie hier zu melden hiesse, einen Befehl zu empfehlen,
       * der genau sie auslaesst. Heute betrifft das keinen einzigen (fruehester Wintertermin
       * 01.11.2026), spaeter schon. */
      if (istVeroeffentlicht(frueher[guid])) return false;
      // Spaltenname aus der gemeinsamen Quelle: Wird sie je umbenannt, ziehen pin-saison.js,
      // winterbilder-erzeugen.js und check-plant-images.js automatisch mit — diese Zeile laese
      // dann still undefined, und die Meldung verstummte, statt zu melden.
      const winterUrl = String(p[WA.WINTERBILD_SPALTE] || '').trim();
      if (!winterUrl) return false;
      const bild = path.join(WURZEL, 'public', winterUrl.replace(/^\//, ''));
      const pin = path.join(ZIEL, datei);
      if (!fs.existsSync(bild) || !fs.existsSync(pin)) return false;
      return fs.statSync(pin).mtimeMs < fs.statSync(bild).mtimeMs;
    });
    if (veraltet.length) {
      console.error(`  ~ ${veraltet.length} Winter-Pin(s) sind aelter als das Winterbild ihrer Pflanze und zeigen`);
      console.error('    deshalb weiterhin das Bluehbild. Neu bauen (laesst veroeffentlichte Pins unangetastet):');
      console.error('      node scripts/pins-erzeugen.js --nur pflanze-winter --neu-unveroeffentlicht');
      console.error(`    Betroffen: ${veraltet.slice(0, 5).map(x => x.p.name_deutsch).join(', ')}${veraltet.length > 5 ? ', …' : ''}`);
    }
  }

  // ── Beetpläne ──────────────────────────────────────────────────────────────
  // Die Seiten sind oben geholt; hier wird nur noch gebaut.
  if (beetSeiten) {
    console.log(`Beetplaene: ${beetSeiten.length}`);
    for (const { b, gelesen } of beetSeiten) {
      await bauen({
        guid: `beetplan-${b.slug}`, datei: `beetplan-${b.slug}.jpg`, typ: S.TYP.beetplan,
        machen: z => beetModul.beetPin(b, z),
        text: () => txt.textBeetplan(b, gelesen.namen.length, gelesen.gift),
      });
    }
  }

  // ── Saison ─────────────────────────────────────────────────────────────────
  // Zwoelf Grundpins plus Standort- und Winterfassungen (alleSaisonPins in pin-saison.js).
  // Der Listeneintrag traegt die sechs Pflanzen und die Adresse der Landeseite: Die Seite
  // unter /blueht-im bzw. /winterbeet liest genau diese IDs, damit sie dieselben sechs zeigt
  // wie das Bild — neu berechnen wuerde bei jeder Datenaenderung stillschweigend abweichen.
  if (!NUR || NUR === S.TYP.saison) {
    const pool = saisonModul.ladePflanzen(db);
    // Veroeffentlichte Saison-Pins werden aus ihren alten IDs wieder aufgebaut, nicht neu
    // berechnet (siehe alleSaisonPins): Ihr Bild liegt bei Pinterest, ihr Link zeigt auf die
    // Seite mit genau diesen sechs.
    const fest = new Map(vorher
      .filter(e => e.typ === S.TYP.saison && istVeroeffentlicht(e) && Array.isArray(e.pflanzen) && e.pflanzen.length)
      .map(e => [e.guid, e.pflanzen]));
    let { pins, verworfen, hinweise } = saisonModul.alleSaisonPins(pool, { fest });
    if (LIMIT) pins = pins.slice(0, LIMIT);
    console.log(`Saison: ${pins.length} Pins (${fest.size} davon veroeffentlicht und eingefroren)`);
    for (const v of verworfen) console.log(`  – ${v.guid}: ${v.grund}`);
    for (const h of hinweise) console.log(`  ! ${h.guid}: ${h.grund}`);
    for (const { guid, datei, s, ids } of pins) {
      const alt = frueher[guid];
      const vorherige = Array.isArray(alt?.pflanzen) ? alt.pflanzen.map(x => Number(x.id)) : null;
      const geaendert = Boolean(vorherige && vorherige.join() !== ids.join());
      const veroeffentlicht = istVeroeffentlicht(alt);
      /* Liegt das Bild schon, hat sich die Auswahl aber geaendert (Pflanze rausgefallen, Bild
       * dazugekommen, Winterhaerte korrigiert), wird das Bild neu gebaut. Sonst schriebe die
       * Liste sechs Namen, von denen das Bild daneben andere zeigt.
       * Bei einem VEROEFFENTLICHTEN Pin heisst „anders" nur noch: Eine der sechs fehlt im Pool.
       * Dann bleiben Bild und Seite beim Stand der Veroeffentlichung — der Pin bei Pinterest
       * zeigt die alten sechs weiter, und die Seite sagt selbst, wenn eine fehlt. */
      if (geaendert && veroeffentlicht) console.log(`  ! ${guid}: veroeffentlicht, eine Pflanze fehlt im Pool — Bild und Seite bleiben wie veroeffentlicht`);
      else if (geaendert) console.log(`  ~ ${guid}: Auswahl geaendert, Bild wird neu gebaut`);
      const neu = {
        seite: saisonModul.saisonPfad(s),
        monat: s.monat, winter: s.winter, standort: s.standort, thema: s.thema,
        kopf: saisonModul.saisonKopf(s),
        pflanzen: s.auswahl.map(x => ({ id: x.p.id, zeile2: x.zeile2 })),
      };
      const extra = geaendert && veroeffentlicht
        ? { seite: alt.seite || neu.seite, monat: alt.monat ?? neu.monat, winter: alt.winter ?? neu.winter,
            standort: alt.standort ?? neu.standort, thema: alt.thema ?? neu.thema, kopf: alt.kopf || neu.kopf, pflanzen: alt.pflanzen }
        : neu;
      await bauen({
        guid, datei, typ: S.TYP.saison, erzwingen: geaendert && !veroeffentlicht,
        machen: (z, kennung) => saisonModul.saisonPin(s, z, { guid: kennung }),
        text: () => txt.textSaison(s, giftigkeit),
        quellen: s.auswahl.map(x => x.p),
        extra,
      });
    }
  }

  // ── Kombinationen ──────────────────────────────────────────────────────────
  // Je Standort die bestbewertete statt der besten N insgesamt: Sonst entstünden zwanzig
  // Varianten derselben Schattenpflanzung, und Pinterest wertet Fast-Dubletten als Spam.
  if (!NUR || NUR === S.TYP.kombi) {
    const pool = kombiModul.ladePflanzen(db);
    const jeStandort = {};
    for (const k of kombiModul.findeKombinationen(pool, { anzahl: 200 })) {
      const s = `${k.licht}/${k.feuchte}`;
      if (!jeStandort[s]) jeStandort[s] = k;
    }
    let kombis = Object.entries(jeStandort);
    if (LIMIT) kombis = kombis.slice(0, LIMIT);
    console.log(`Kombinationen: ${kombis.length} (eine je Standort)`);
    for (const [standort, k] of kombis) {
      const slug = txt.slugify(standort);
      await bauen({
        guid: `kombi-${slug}`, datei: `kombi-${slug}.jpg`, typ: S.TYP.kombi,
        machen: (z, kennung) => kombiModul.kombiPin(k, z, { guid: kennung }),
        text: () => txt.textKombination(k, giftigkeit),
        quellen: k.pflanzen,
      });
    }
  }

  // ── Pflegethemen ───────────────────────────────────────────────────────────
  // Eine Auswertung über den ganzen Bestand, kein Einzelinhalt: "Zu viel Wasser trifft 270 von
  // 692 Stauden" ist eine Zahl, die sonst nirgends steht. Das ist der stärkste Pinterest-Haken,
  // den die Pflegedaten hergeben — und er funktioniert ganzjährig.
  if (!NUR || NUR === S.TYP.pflege) {
    const { themenMitPflanzen } = require('./pflege-themen');
    const kandidaten = db.prepare(`SELECT name_deutsch, name_botanisch, inhalt_lang FROM pflanzen
      WHERE inhalt_lang IS NOT NULL AND ${PLANBAR_SQL}`).all();
    const { themen } = themenMitPflanzen(kandidaten);
    const erstes = themen[0];
    console.log('Pflege: 1');
    const seite = {
      titel: 'Die häufigsten Pflegefehler bei Stauden',
      kategorie: 'Pflege',
      hinweis: '7 Fehler · 692 Stauden ausgewertet',
      fuss: 'Pflegewissen',
      inhalt: `${erstes.titel} trifft ${erstes.pflanzen.length} von ${kandidaten.length} winterharten Stauden `
            + `und ist damit der häufigste Pflegefehler überhaupt. Sieben Fehler, ausgewertet über den `
            + `ganzen Bestand — mit den Arten, bei denen du besonders darauf achten musst.`,
    };
    await bauen({
      guid: 'pflege-haeufige-fehler', datei: 'pflege-haeufige-fehler.jpg', typ: S.TYP.pflege,
      machen: z => ratgeberModul.ratgeberPin(seite, z),
      // Der Text stand hier bis zum 21.09.2026 als Objektliteral und lief damit an fertig()
      // vorbei: als einzige Sorte ohne Kuerzung und ohne die gemeinsame KI-Entscheidung.
      // Titel, Beschreibung, Link, alt und Pinnwand sind Zeichen fuer Zeichen dieselben.
      text: () => txt.textPflege(seite),
    });
  }

  // ── Ratgeber ───────────────────────────────────────────────────────────────
  // Trägt November bis Februar: Der Blühbeginn der 278 pinnbaren Stauden ballt sich im Juni,
  // im Winter gäbe es aus der Pflanzentabelle fast nichts zu zeigen.
  if (!NUR || NUR === S.TYP.ratgeber) {
    let artikel = ratgeberModul.ladeArtikel(db);
    if (LIMIT) artikel = artikel.slice(0, LIMIT);
    console.log(`Ratgeber: ${artikel.length}`);
    for (const a of artikel) {
      const slug = txt.slugify(a.titel);
      const teaser = ratgeberModul.ersterSatz(a.inhalt, 60, 480);
      await bauen({
        guid: `ratgeber-${slug}`, datei: `ratgeber-${slug}.jpg`, typ: S.TYP.ratgeber,
        machen: z => ratgeberModul.ratgeberPin(a, z),
        text: () => txt.textRatgeber(a, teaser),
      });
    }
  }

  listeSchreiben(true);

  const jeBrett = {};
  for (const e of liste) jeBrett[e.board] = (jeBrett[e.board] || 0) + 1;
  const zuGross = liste.filter(e => e.bytes > 20 * 1024 * 1024);

  console.log(`\n${liste.length} Pins in der Liste · ${erzeugt} neu · ${vorhanden} unverändert · ${fehler} Fehler`);
  // Die KI-Kennzeichnung getrennt ausweisen: "0 neu" ist beim zweiten Lauf das erwartete
  // Ergebnis, beim ersten dagegen der Hinweis, dass nichts geschrieben wurde.
  console.log(`KI-Kennzeichnung: ${kiNeu} neu geschrieben · ${kiSchon} bereits vorhanden`
    + (kiUnmoeglich ? ` · ${kiUnmoeglich} NICHT MÖGLICH` : ''));
  // Der Schalter sagt zu, die veröffentlichten Bilder nicht anzufassen. Die Zusage steht
  // damit als Zahl im Protokoll und nicht nur in diesem Kommentar.
  if (NEU_UNVEROEFFENTLICHT) {
    /* Soll gegen Ist. Die Ist-Zahl allein kann nur gelingen: Ein faelschlich neu gebauter
     * veroeffentlichter Pin erhoeht den einen Zaehler und fehlt im anderen, ohne dass es
     * auffiele. Gezaehlt wird deshalb aus derselben Liste, aus der die Entscheidung kam. */
    const sollGeschont = vorher.filter(e => istVeroeffentlicht(e) && e.datei
      && (!NUR || e.typ === NUR)).length;
    console.log(`--neu-unveroeffentlicht: ${neuUnveroeffentlicht} vorhandene Bilder neu gebaut`
      + ` · ${geschontVeroeffentlicht} von ${sollGeschont} veroeffentlichten unangetastet`);
    if (geschontVeroeffentlicht !== sollGeschont) {
      console.error(`  ! Erwartet waren ${sollGeschont} geschonte veroeffentlichte Pins.`
        + ' Die Zusage des Schalters ist damit NICHT belegt.');
      fehler++;
    }
  }
  for (const [b, n] of Object.entries(jeBrett).sort((x, y) => y[1] - x[1])) {
    console.log(`  ${String(n).padStart(4)}  ${b}`);
  }
  // Pinterest nimmt Bilder bis 20 MB. Die Pins liegen bei 150-300 kB, aber eine stille
  // Überschreitung wäre ein Pin, der ohne Meldung nie erscheint.
  if (zuGross.length) console.log(`\n! ${zuGross.length} Pin(s) über 20 MB — Pinterest lehnt die ab.`);
  console.log(`\nListe: ${LISTE}`);
  if (fehler) process.exitCode = 1;
})().catch(e => {
  console.error('Abbruch:', e.stack || e.message);
  // Die Liste muss auch jetzt geschrieben werden: Die bis hierher bearbeiteten Dateien sind um
  // rund 530 Byte gewachsen, und liste.json traege sonst weiter deren alte Laengen.
  try { listeSchreiben(false); } catch (schreibfehler) {
    console.error('Abbruch: liste.json konnte nicht geschrieben werden:', schreibfehler.message);
  }
  process.exit(1);
});
