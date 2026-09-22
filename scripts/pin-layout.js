/*
 * Geteilte Bausteine der Pin-Erzeugung: Maße, Schriften, Monatsrechnung, Textumbruch — und
 * der Bildkommentar, der festhält, welche Pflanzen wirklich ins Bild gezeichnet wurden.
 *
 * Herausgezogen, nachdem `umbrechen` in der dritten Datei stand und die Schätzung der
 * Textbreite zweimal zu abgeschnittenen Überschriften geführt hat. Wer hier etwas ändert,
 * ändert es für alle Pin-Sorten — das ist der Zweck.
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
// Sortennamen und Kennungen stehen in pin-sorten.js — dem einzigen Modul, das auch der
// Terminlauf lädt. Von dort kommt der Name der Sorte, deren Bild hier gekennzeichnet wird.
const { TYP } = require('./pin-sorten');
// Die Bildherkunft wird NICHT ein zweites Mal abgeleitet. scripts/bild-herkunft.js ist die
// eine Ableitung für alle Ausgabepfade (Lexikon, Planer, Quiz, Landeseiten) — der Pin-Kanal
// ist ein weiterer und bekommt deshalb dieselbe, nicht eine eigene, schwächere Fassung.
// Das Modul hat keine Abhängigkeiten und lädt weder ImageMagick noch die Datenbank.
const BH = require('./bild-herkunft');

/*
 * Werkzeug und Schriften werden GESUCHT, nicht angenommen.
 *
 * Der Server läuft auf ImageMagick 6, wo das Programm "convert" heißt. In Version 7 heißt es
 * "magick"; die Debian-Pakete für 7 legen "convert" nicht mehr an. Ein einziges apt upgrade
 * hätte damit alle fünf Pin-Sorten und die Ratgeber-Vorschaubilder gleichzeitig stillgelegt —
 * und zwar in einem Stapellauf, wo es niemandem sofort auffällt. Dasselbe gilt für die
 * Schriftpfade: /usr/share/fonts/truetype/dejavu ist Debian-Konvention, kein Standard.
 *
 * Beim Import wird BEWUSST NICHT geworfen, nur gewarnt: pin-text.js lädt dieses Modul auch
 * für die reine Textvorschau, die weder ImageMagick noch Schriften braucht. Ein harter Abbruch
 * hier würde die Vorschau auf jedem Rechner ohne ImageMagick unbenutzbar machen. Fehlt das
 * Werkzeug wirklich, scheitert der Aufruf später — dann aber mit dieser Warnung davor.
 */
function findeWerkzeug() {
  // PIN_MAGICK ist nicht nur ein Pfad-Notausgang, sondern auch der Schalter gegen die
  // Zeitbombe eine Zeile tiefer: PIN_MAGICK=/usr/bin/convert erzwingt ImageMagick 6.
  if (process.env.PIN_MAGICK) return process.env.PIN_MAGICK;
  /*
   * STILLE ZEITBOMBE, HIER NUR FESTGEHALTEN — NICHT GELÖST (Stand 21.09.2026):
   *
   * 278 der Einzelpflanzen-Pins tragen ein APP11/JUMBF-Segment mit C2PA-Manifest, das sie
   * von der OpenAI-Quelldatei geerbt haben. Geerbt wird es nur, weil pin-bild.js das
   * Quellbild als ERSTES Argument an convert gibt und ImageMagick 6 die Profile des ersten
   * Bildes übernimmt. Die Raster-Sorten (pin-saison, pin-kombination) beginnen mit einer
   * frischen Leinwand und haben es deshalb nie bekommen — dort ist nichts verloren gegangen,
   * es ist nie angekommen.
   *
   * Unter ImageMagick 7 geht das Segment auf BEIDEN Wegen verloren: `magick` übernimmt
   * APP11 nicht als Profil. Würde auf dem Server je ImageMagick 7 installiert, griffe die
   * Suche hier sofort zu „magick" — und die 278 Pins verlören bei der nächsten Erzeugung
   * still ihr Manifest, ohne dass irgendwo ein Fehler stünde.
   *
   * Für die maschinenlesbare KI-Kennzeichnung ist das folgenlos: Die schreibt
   * pin-ki-metadaten.js nach dem Bildbau direkt in die fertige Datei und ist von ImageMagick
   * unabhängig. Betroffen wäre allein die geerbte Provenienz — die als Signatur ohnehin tot
   * ist (der Hash gilt für die unbeschnittenen Originalbytes), aber nicht von uns entfernt
   * wird.
   */
  for (const kandidat of ['magick', 'convert']) {          // 7 vor 6: magick ist die Zukunft
    try { execFileSync(kandidat, ['-version'], { stdio: 'ignore' }); return kandidat; } catch { /* weiter */ }
  }
  console.warn('WARNUNG: Weder "magick" noch "convert" aufrufbar — ImageMagick fehlt. '
    + 'Bildbefehle werden scheitern. Pfad notfalls über PIN_MAGICK vorgeben.');
  return 'convert';
}

const SCHRIFT_ORDNER = [
  '/usr/share/fonts/truetype/dejavu',   // Debian, Ubuntu
  '/usr/share/fonts/dejavu',            // Fedora, RHEL
  '/usr/share/fonts/TTF',               // Arch
  '/usr/local/share/fonts/dejavu',
  '/opt/homebrew/share/fonts',
];
function findeSchrift(umgebungsname, ...dateinamen) {
  if (process.env[umgebungsname]) return process.env[umgebungsname];
  for (const ordner of SCHRIFT_ORDNER) {
    for (const name of dateinamen) {
      const p = path.join(ordner, name);
      try { if (fs.existsSync(p)) return p; } catch { /* weiter */ }
    }
  }
  console.warn(`WARNUNG: Schrift ${dateinamen[0]} in keinem bekannten Ordner gefunden. `
    + `Notfalls über ${umgebungsname} einen Pfad vorgeben.`);
  return path.join(SCHRIFT_ORDNER[0], dateinamen[0]);   // Debian-Pfad als letzte Annahme
}

const MAGICK = findeWerkzeug();

const B = 1000, H = 1500;                       // Pinterest: hochkant 2:3
const FONT = findeSchrift('PIN_FONT', 'DejaVuSans.ttf');
const FONT_B = findeSchrift('PIN_FONT_BOLD', 'DejaVuSans-Bold.ttf');
const GRUEN = '#1b4332';

const MONATE = { Januar:1, Februar:2, 'März':3, April:4, Mai:5, Juni:6,
                 Juli:7, August:8, September:9, Oktober:10, November:11, Dezember:12 };
const MON_KURZ = ['J','F','M','A','M','J','J','A','S','O','N','D'];
const MON_NAME = ['Januar','Februar','März','April','Mai','Juni','Juli','August','September','Oktober','November','Dezember'];

// Blütenfarbe als Balken- und Punktfarbe. Ohne Zuordnung wäre alles dreimal dasselbe Grün.
const FARBTON = {
  'weiß':'#f8f9fa', 'gelb':'#ffd166', 'rosa':'#f4a3c0', 'grün':'#74c69d', 'blau':'#6ba3d6',
  'rot':'#e5544b', 'lila':'#b18ad4', 'violett':'#a17ac9', 'orange':'#f79154', 'purpur':'#c264a0',
  'braun':'#b08968', 'silbrig':'#ced4da', 'beige':'#e6d9b8', 'rotbraun':'#a9564b',
  'silbrig-grün':'#c2d5c0', 'dunkelviolett':'#8b6bb1', 'karamell':'#d49a5c',
  'blauviolett':'#8a8ad0', 'schwarz':'#6c757d', 'lachs':'#f0917c', 'dunkelrot':'#b23a3a',
  'burgunderrot':'#9d3b52', 'lavendel':'#c3b1e1', 'silber':'#dee2e6',
};

const GIFT_LABEL = { stark:'Stark giftig', giftig:'Giftig', katzen:'Für Katzen lebensgefährlich',
                     haustiere:'Für Haustiere giftig', reizend:'Hautreizend' };
const GIFT_RANG = { stark:0, giftig:1, katzen:2, haustiere:3, reizend:4 };

/*
 * Blühzeit „Juli - September" → [7, 9]; null, wenn nicht lesbar („keine Blüte").
 *
 * JAHRESWECHSEL: [12, 3] für „Dezember - März" ist eine gültige Spanne, keine kaputte.
 * Bis zum 21.09.2026 stand als Bedingung `e >= a` in der Rückgabe. Damit galt die Blühzeit
 * der Christrose (Helleborus niger, „Dezember - März") als nicht lesbar: Sie zählte in KEINEM
 * Monat als blühend — nicht im Dezember, nicht im Januar, nicht im März. Sie fiel aus jedem
 * Saison-Raster heraus, ihr eigener Pin nannte keine Blühzeit im Text (während das Bild sie
 * druckte), und die Zählung „Nov 0 Dez 0" im Kopf von pin-saison.js war gegen sie blind.
 *
 * WIE VIELE ZEILEN UMBRECHEN, SAGT DIESER CODE NICHT. Im lokalen Datenstand ist Helleborus
 * niger der einzige Treffer, aber der ist ein Teilstand (226 von 711 Zeilen) — das ist eine
 * Aussage über den Teilstand, nicht über die Produktion. Die Zahl liefert der Lauf von
 * scripts/daten-widersprueche.js auf dem Server, Prüfung „Blühzeit läuft über den
 * Jahreswechsel".
 *
 * MIT `e >= a` IST AUCH DIE SPERRE GEGEN VERDREHTE SPANNEN WEGGEFALLEN: „September - Juli"
 * ergibt jetzt [9, 7] und damit elf Monate Blüte, wo vorher die Zeile still aus allen
 * Pin-Sorten herausfiel. Ein Zahlendreher und ein gewollter Jahreswechsel sehen in den Feldern
 * gleich aus; der Unterschied steckt in der Absicht, nicht in den Daten. Deshalb wird hier
 * nichts mehr stumm verworfen, sondern jede Umbruchspanne einmal aufgelistet und einzeln
 * eingestuft (dieselbe Prüfung in daten-widersprueche.js).
 *
 * WER SPANNEN LIEST, MUSS DEN UMBRUCH BEHANDELN — sonst wird aus einem stillen Ausfall ein
 * stiller Unsinn: `for (let m = a; m <= e; m++)` läuft bei [12, 3] kein einziges Mal, `e - a`
 * wird negativ, und ein Balken von Spalte a bis Spalte e wird rückwärts gezeichnet. Deshalb
 * stehen hier zwei Helfer dafür, und jede Verwendung von spanne() im Projekt benutzt einen
 * davon oder schließt Umbruchspannen ausdrücklich aus (pin-kombination.js).
 */
function spanne(bluehzeit) {
  const t = String(bluehzeit || '').split(/\s*(?:–|—|-|bis)\s*/).map(s => s.trim());
  const a = MONATE[t[0]], e = MONATE[t[1]] || MONATE[t[0]];
  return (a && e) ? [a, e] : null;
}

/* Läuft die Spanne über den Jahreswechsel? */
const ueberJahreswechsel = s => Array.isArray(s) && s[1] < s[0];

/* Länge in Monaten, vom ersten an gezählt: [7,9] → 2, [5,5] → 0, [12,3] → 3. Für alles, was
 * nicht umbricht, genau das bisherige `e - a`. */
const dauer = s => Array.isArray(s) ? (s[1] - s[0] + 12) % 12 : 0;

const bluehtIm = (bluehzeit, monat) => {
  const s = spanne(bluehzeit);
  if (!s) return false;
  return ueberJahreswechsel(s) ? (monat >= s[0] || monat <= s[1]) : (s[0] <= monat && monat <= s[1]);
};
const farbeVon = p => String(p.farbe || '').split(/[|,]/)[0].trim().toLowerCase();
const mengeAus = s => new Set(String(s || '').split('|').map(x => x.trim().toLowerCase()).filter(Boolean));
const schnitt = (a, b) => [...mengeAus(a)].filter(x => mengeAus(b).has(x));

/*
 * Neun Arten tragen als deutschen Namen nur ihre Gattung („Muhlenbergia"). Auf einem Pin
 * liest sich das als „Muhlenbergia · Muhlenbergia capillaris". Sie werden ausgelassen;
 * einen deutschen Namen zu erfinden wäre schlimmer, als sie wegzulassen. Sobald die Namen
 * gepflegt sind, fallen sie von selbst wieder herein.
 */
function hatDeutschenNamen(p) {
  const d = String(p.name_deutsch || '').trim().toLowerCase();
  const b = String(p.name_botanisch || '').toLowerCase();
  return !!d && d !== b.split(' ')[0] && d !== b;
}

/*
 * Echte Wasserpflanzen aussortieren. Sie stehen völlig zu Recht in der Datenbank, aber ein
 * Pin mit der Überschrift „6 Stauden für Beet und Rabatte" hatte im Juni die Weiße Seerose
 * und die Seekanne im Raster — die wachsen in der Wasserfläche, nicht im Beet.
 *
 * Zwei Merkmale, weil eines nicht reicht: Der Lebensbereich „Wasserfläche" fängt Seerose,
 * Froschbiss und Wasserlinse; „nass" fängt zusätzlich die Flachwasserarten wie das
 * Pfeilkraut, die nur als „Quellflur" geführt sind. Betrifft 14 der 299 Arten mit eigenem
 * Bild. Feuchte Beetränder („feucht") bleiben ausdrücklich drin.
 */
const istBeetpflanze = p => !/wasserfläche/i.test(String(p.lebensbereich || ''))
                         && !mengeAus(p.feuchtigkeit).has('nass');

/*
 * Was ein Pin zeigen darf: winterhart in Deutschland und mehrjährig.
 *
 * Bis zum 09.08.2026 stand hier eine hartcodierte Liste von fünf Arten, weil das Feld
 * `winterhart_zone` unbrauchbar war — 223 von 299 Pflanzen mit Bild standen auf exakt
 * Zone 5, keine über Zone 7, und Salvia elegans aus Mexiko trug dieselbe Zone 6 wie der
 * heimische Buschklee. Seit der Datenkorrektur stimmen die Felder, und die Regel liest
 * sie, statt sie zu umgehen. Dieselbe Bedingung wie PLANBAR in stauden-server.js.
 */
const istWinterhartHier = p => (p.winterhart_zone == null || p.winterhart_zone <= 7)
                            && (p.lebensdauer == null || p.lebensdauer !== 'einjaehrig');

/*
 * Gräser, Seggen und Binsen erkennen. Nötig, weil sie unter „Was im August blüht" zwar
 * korrekt, aber irreführend sind: Vier Gräser in einem Sechserraster sehen aus, als hätte
 * die Auswahl versagt — wer die Überschrift liest, erwartet Blüten. Im Winterbeet sind sie
 * dagegen genau der Punkt, dort gilt eine höhere Grenze.
 *
 * Zwei Wege, weil keiner allein reicht: Der deutsche Name erkennt 39 der 42 Gräser in der
 * Datenbank, die Gattungsliste holt Riesenschwingel, Riesen-Chinaschilf und Muhlenbergia
 * nach. Die Liste enthält auch Gattungen, die noch nicht vorkommen — dann greift sie eben
 * später.
 */
const GRAS_GATTUNG = new Set(['Achnatherum','Andropogon','Anemanthele','Arrhenatherum','Bouteloua',
  'Briza','Bromus','Calamagrostis','Carex','Chasmanthium','Cortaderia','Deschampsia','Elymus',
  'Eragrostis','Festuca','Glyceria','Hakonechloa','Helictotrichon','Imperata','Juncus','Koeleria',
  'Luzula','Melica','Melinis','Milium','Miscanthus','Molinia','Muhlenbergia','Nassella','Panicum',
  'Pennisetum','Phalaris','Phragmites','Poa','Schizachyrium','Schoenoplectus','Scirpus','Sesleria',
  'Sorghastrum','Spartina','Spodiopogon','Sporobolus','Stipa','Typha']);
const GRAS_WORT = /gras|schmiele|hirse|segge|binse|quecke|trespe|rohrkolben|lampenputzer|schwaden|zwenke|riedgras|marbel|simse|hafer|schilf|schwingel/i;
// „Gras" im deutschen Namen heißt nicht Gras: Die Grasnelke ist ein Bleiwurzgewächs, das
// Blauäugige Gras ein Schwertliliengewächs. Beide blühen und sind Bienenweiden — sie über
// den Namen zu Gräsern zu erklären, wäre genau der Fehler, den diese Prüfung finden soll.
const KEIN_GRAS = new Set(['Armeria', 'Sisyrinchium']);
const istGras = p => {
  const gattung = String(p.name_botanisch || '').split(' ')[0];
  if (KEIN_GRAS.has(gattung)) return false;
  return GRAS_GATTUNG.has(gattung) || GRAS_WORT.test(String(p.name_deutsch || ''));
};

/*
 * WELCHE PIN-SORTEN EIN KI-ERZEUGTES BILD ZEIGEN — EINE LISTE FÜR ALLES.
 *
 * Aus ihr folgen beide Kennzeichnungen: der Satz „Bild: KI-erzeugte Illustration." in der
 * Beschreibung (fertig() in pin-text.js) und das maschinenlesbare IPTC-Feld
 * DigitalSourceType in der JPEG-Datei (pin-ki-metadaten.js, eingehängt in bauen() in
 * pins-erzeugen.js). Vorher stand „kiBild: true" dreimal einzeln in pin-text.js; eine vierte
 * Pin-Sorte mit KI-Bild hätte man an drei Stellen nachtragen müssen, und ob die Datei dazu
 * passt, prüfte niemand.
 *
 * Die Sorten hier zeigen Fotos aus der Bilddatenbank, und die sind dort ausnahmslos selbst
 * erzeugt: Alle Lader filtern `WHERE bild_ki = 1` (pin-saison.js, das auch beide
 * Einzelpflanzen-Sorten versorgt, und pin-kombination.js).
 *
 * `pflanze-winter` (seit 21.09.2026) steht hier, weil es dieselbe Bilddatei derselben Pflanze
 * zeigt wie `pflanze` — nur mit dem Winteraspekt statt der Blühzeit in der Faktenzeile. Eine
 * neue Sorte mit KI-Bild MUSS in diese Liste, sonst ginge sie ohne beide Kennzeichnungen
 * hinaus: ohne den Satz in der Beschreibung und ohne das Feld in der Datei.
 *
 * BEETPLAN, RATGEBER UND PFLEGE STEHEN BEWUSST NICHT HIER. Der Beetplan-Pin zeigt eine aus
 * Rechtecken gezeichnete Beetskizze, Ratgeber und Pflege sind reine Typografie auf farbigem
 * Grund — nichts davon ist ein KI-Bild. Sie zu kennzeichnen wäre kein überflüssiger Hinweis,
 * sondern eine neue Falschaussage, und zwar eine maschinenlesbare.
 */
const KI_PIN_SORTEN = [TYP.pflanze, TYP.kombi, TYP.saison, TYP.pflanzeWinter];
const istKiPin = typ => KI_PIN_SORTEN.includes(typ);

/*
 * DER BILDKOMMENTAR: WELCHE PFLANZEN STEHEN WIRKLICH IM BILD?
 *
 * Er entsteht beim BAUEN des Bildes als COM-Segment der JPEG-Datei ('-set comment') und wird
 * von scripts/check-pin-deckung.js gelesen, Stufe (i). Der Vorfall, gegen den er geschrieben
 * ist: Bei saison-12 nannte die Beschreibung die Pfingst-Nelke, das Bild zeigte
 * Leberbluemchen — die Datei entstand um 10:45, der Text um 13:14 desselben Tages, zwei
 * Laeufe, zwei Auswahlen, ein Pin.
 *
 * WARUM DIE DATEI GEFRAGT WIRD UND NICHT liste.json: Beschreibung und das Feld 'pflanzen[]'
 * entstehen im selben Lauf aus derselben Auswahl und stimmen deshalb per Konstruktion
 * ueberein — auch dann, wenn beide vom Bild abweichen. Das einzige Stueck, das unabhaengig
 * davon altern kann, ist die JPG-Datei.
 *
 * DESHALB NUR HIER UND NIRGENDWO SONST. Den Kommentar nachtraeglich in eine bestehende Datei
 * zu schreiben waere das Gegenteil eines Belegs: Man behauptete die HEUTIGE Auswahl ueber ein
 * ALTES Bild und faerbte die Pruefung gruen, ohne irgendetwas gesehen zu haben. Die IDs
 * muessen aus derselben Schleife stammen, die die Kacheln zeichnet; die drei Bildbauer
 * sammeln sie deshalb beim Zeichnen ein und reichen sie hier herein, statt die Auswahl ein
 * zweites Mal abzuleiten.
 *
 * EINE FASSUNG FUER ALLE SORTEN MIT PFLANZENBILD — pflanze und pflanze-winter (beide
 * pin-bild.js), kombi (pin-kombination.js) und saison (pin-saison.js), also genau
 * KI_PIN_SORTEN eine Zeile hoeher. Stuende der Aufbau dreimal einzeln, muesste ein
 * geaendertes Feld dreimal nachgezogen werden, und an der vergessenen Stelle laese die
 * Pruefung stillschweigend nichts.
 *
 * 'guid' IST OPTIONAL UND WIRD HEREINGEREICHT, NIE HIER GEBILDET. Die Kennung entsteht in
 * pins-erzeugen.js (bei der Sorte saison in saisonKennung(), pin-saison.js); sie hier
 * nachzubauen waere eine zweite Fassung der Kennungsregel. Fehlt sie, vergleicht die Pruefung
 * nur die IDs; steht sie im Bild, muss sie zum Eintrag passen — damit faellt auch eine Datei
 * auf, die zum falschen Pin gehoert.
 *
 * KEINE IDS, KEIN BILD: Ohne lesbare IDs wird geworfen statt ein Kommentar ohne 'ids'
 * geschrieben. Den liest die Pruefung als "COM-Segment ohne ids", also wieder als
 * "nicht pruefbar" — ein stiller Rueckfall genau in den Zustand, den dieser Kommentar
 * beenden soll. Ein Bild, von dem niemand sagen kann, was darauf ist, soll gar nicht erst
 * entstehen.
 *
 * KEIN PROZENTZEICHEN IN DER KENNUNG: ImageMagick deutet '%' im Wert von -set als Platzhalter
 * und ersetzte ihn still. Alle heutigen Kennungen kommen aus slugify() und bestehen aus
 * [a-z0-9-]; eine, die das verlaesst, bricht hier ab, statt einen verstuemmelten Kommentar in
 * die Datei zu schreiben.
 */
function bildKommentarArgs({ guid = null, ids }) {
  const gezeichnet = (Array.isArray(ids) ? ids : []).map(Number);
  if (!gezeichnet.length || gezeichnet.some(n => !Number.isFinite(n))) {
    throw new Error('Bildkommentar ohne lesbare Pflanzen-IDs: ' + JSON.stringify(ids));
  }
  if (guid !== null && guid !== undefined && !/^[A-Za-z0-9._-]+$/.test(String(guid))) {
    throw new Error('Bildkommentar: Kennung enthaelt Zeichen, die ImageMagick deutet: ' + guid);
  }
  return ['-set', 'comment', JSON.stringify({
    ...(guid === null || guid === undefined ? {} : { guid: String(guid) }),
    ids: gezeichnet,
    erzeugt_am: new Date().toISOString(),
  })];
}

/*
 * Gegenprobe zum Sortennamen: Zeigt dieser Pin wirklich ein KI-Bild?
 *
 * Der Sortenname allein ist kein Beleg. Die Garantie kommt aus dem Lader (`bild_ki = 1`),
 * nicht aus dem Wort „pflanze" — die Prüfung in pin-bild.js steht in dessen
 * `require.main === module`-Zweig und läuft im Stapellauf nie mit. Baut jemand später einen
 * eigenen Lader ein, der die Bedingung vergisst, liefe die Kennzeichnung stillschweigend
 * weiter und behauptete über ein Pixabay-Foto, es sei KI-erzeugt.
 *
 * GEFRAGT WIRD MIT DERSELBEN ABLEITUNG WIE AUF DER WEBSITE: bildHerkunft() aus
 * scripts/bild-herkunft.js. Dort entscheidet bild_ki, und bild_lizenz sowie der Dateiname
 * sind die Gegenprobe. Eine eigene Fassung hier hätte denselben Fall auf zwei Wegen
 * beantwortet — die Kachel im Lexikon anders als den Pin aus demselben Bild.
 *
 * Damit die Gegenprobe überhaupt etwas prüfen kann, laden pin-saison.js und
 * pin-kombination.js `bild_lizenz` mit (BILD_SPALTEN_SQL). Ein Widerspruch VERWIRFT den Pin
 * nicht: id 698 (Bergenia 'Silberlicht') trägt bild_ki=1 und dazu „Pixabay License" — das
 * Lizenzfeld ist dort falsch, nicht bild_ki, und die Pflanze steht im Pin-Pool. Ein solcher
 * Fall gehört ins Log, nicht in die Ablage; verworfen wird nur, was unbelegt ist.
 */
function kiHerkunftFehler(pflanzen) {
  if (!Array.isArray(pflanzen) || !pflanzen.length) return 'keine Quellpflanzen übergeben — Herkunft des Bildes unbelegt';
  const ohneFeld = pflanzen.filter(p => !BH.bildHerkunft(p).bekannt);
  if (ohneFeld.length) return `der Lader liefert die Spalte bild_ki nicht mit (${ohneFeld.length} von ${pflanzen.length}) — Herkunft unbelegt`;
  const fremd = pflanzen.filter(p => !BH.bildHerkunft(p).ki);
  if (fremd.length) return `kein KI-Bild (bild_ki=0): ${fremd.map(p => p.name_botanisch || p.id).join(', ')}`;
  return null;
}

/*
 * Die Widersprüche derselben Ableitung, als Zeilen fürs Log. Getrennt von kiHerkunftFehler(),
 * weil sie etwas anderes bedeuten: „unbelegt" hält den Pin zurück, „widersprüchlich" wird
 * gemeldet und nachgepflegt (siehe oben, id 698).
 */
function kiHerkunftWidersprueche(pflanzen) {
  if (!Array.isArray(pflanzen)) return [];
  return pflanzen
    .map(p => { const h = BH.bildHerkunft(p); return h.widerspruch ? `${(p && (p.name_botanisch || p.id)) || '?'}: ${h.widerspruch}` : null; })
    .filter(Boolean);
}

/*
 * Textbreite bei ImageMagick erfragen statt aus der Zeichenzahl schätzen. Eine geschätzte
 * Breite hat den Titel schon rechts aus dem Bild laufen lassen — Monatsnamen und
 * Pflanzennamen sind zu unterschiedlich lang für eine Faustregel.
 */
function textBreite(text, font, size) {
  const out = execFileSync(MAGICK, ['-font', font, '-pointsize', String(size),
                                       `label:${text}`, '-format', '%w', 'info:'], { encoding: 'utf8' });
  return Number(String(out).trim()) || 0;
}

/* Größte Schriftgröße, bei der der Text noch in die Breite passt. */
function passendeGroesse(text, font, start, min, maxBreite) {
  let s = start;
  while (s > min && textBreite(text, font, s) > maxBreite) s -= 2;
  return s;
}

/* Zeichen pro Zeile aus einer echten Messung ableiten (ein Aufruf statt einer je Wort). */
function zeichenProZeile(text, font, size, maxBreite) {
  const b = textBreite(text, font, size);
  return b ? Math.max(8, Math.floor(String(text).length * maxBreite / b)) : 40;
}

function umbrechen(text, max) {
  const worte = String(text).split(/\s+/); const zeilen = []; let z = '';
  for (const w of worte) {
    if ((z + ' ' + w).trim().length > max) { if (z) zeilen.push(z.trim()); z = w; } else z = (z + ' ' + w).trim();
  }
  if (z) zeilen.push(z); return zeilen;
}

/* Umbruch mit gemessener statt geratener Breite. */
function umbrechenBreit(text, font, size, maxBreite) {
  return umbrechen(text, zeichenProZeile(text, font, size, maxBreite));
}

module.exports = { B, H, MAGICK, FONT, FONT_B, GRUEN, MONATE, MON_KURZ, MON_NAME, FARBTON,
                   GIFT_LABEL, GIFT_RANG, spanne, ueberJahreswechsel, dauer, bluehtIm,
                   farbeVon, mengeAus, schnitt,
                   hatDeutschenNamen, istBeetpflanze, istGras, istWinterhartHier,
                   KI_PIN_SORTEN, istKiPin, kiHerkunftFehler, kiHerkunftWidersprueche,
                   bildKommentarArgs,
                   BILD_SPALTEN_SQL: BH.BILD_SPALTEN_SQL, textBreite, passendeGroesse,
                   zeichenProZeile, umbrechen, umbrechenBreit };
