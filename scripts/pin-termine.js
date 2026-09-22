/*
 * Vergibt jedem Pin ein Veröffentlichungsdatum (`geplant_am`) in public/pins/liste.json.
 *
 *   node scripts/pin-termine.js --dry-run              Kalender zeigen, nichts schreiben
 *   node scripts/pin-termine.js                        Termine vergeben und schreiben
 *   node scripts/pin-termine.js --pro-tag 3            Pins pro Tag (Vorgabe 3)
 *   node scripts/pin-termine.js --ab 2026-08-19        Startdatum (Vorgabe: morgen)
 *   node scripts/pin-termine.js --neu                  auch bereits vergebene Termine neu setzen
 *                                                      (Veroeffentlichtes ausgenommen)
 *   node scripts/pin-termine.js --startschub 3         je Pinnwand N Pins auf den Starttag ziehen
 *   node scripts/pin-termine.js --termin saison-10=2026-09-09   einen Termin ausdrücklich setzen
 *
 * ── WARUM ÜBERHAUPT EIN TERMINPLAN ───────────────────────────────────────────
 * Pinterests RSS-Anschluss veröffentlicht bis zu 200 Pins am Tag, älteste zuerst. Ein Feed mit
 * 188 Einträgen wäre also in einem Tag durch. Gebremst wird nicht Pinterest, sondern der Feed:
 * `/pinterest/<pinnwand>.xml` liefert nur Einträge, deren Termin erreicht ist. Pinterest liest
 * täglich und findet jedes Mal eine Handvoll Neues.
 *
 * ── WARUM NACH DEM GARTENJAHR UND NICHT GLEICHMÄSSIG ─────────────────────────
 * Pinterest ist eine Suchmaschine. „Was im Mai blüht" wird im April gesucht, Beetpläne in der
 * Planungszeit Februar bis Mai. Ein gleichmäßiger Tropf würde die Hälfte der Pins in das Loch
 * zwischen den Saisons werfen. Jeder Pin bekommt deshalb ein Wunschdatum aus seinem Inhalt:
 *
 *   saison-N     drei Wochen vor Monatsbeginn — der Vorlauf, in dem geplant wird
 *   beetplan     Februar bis Mai, die Planungszeit
 *   kombi        März/April und September, die beiden Pflanzzeiten
 *   pflanze      drei Wochen vor dem Beginn der eigenen Blühzeit
 *   pflanze-winter  reihum über November, Dezember, Januar, Februar
 *   ratgeber     ganzjährig, füllt die Lücken
 *
 * Wunschdaten sind Wünsche: Ist der Tag voll, rückt der Pin auf den nächsten freien. Was in
 * dieser Saison nicht mehr geht, wandert ins nächste Jahr. Übrig bleibende Pins verteilen sich
 * gleichmäßig auf die freien Plätze, damit die Frequenz nie abreißt.
 *
 * ── EINMAL VERGEBEN, BLEIBT VERGEBEN ─────────────────────────────────────────
 * Ein Termin wird nur neu gesetzt, wenn er noch nicht existiert (oder --neu). Sonst würde ein
 * Neulauf bereits veröffentlichte Pins verschieben — und was einmal bei Pinterest ist, holt
 * kein Terminplan zurück.
 *
 * VERÖFFENTLICHTES IST AUCH VON --neu AUSGENOMMEN (seit 21.09.2026). Vorher setzte --neu ohne
 * jede Ausnahme alle Termine neu. Rutschte dabei ein bereits erreichtes `geplant_am` in die
 * Zukunft, verschwand der Pin aus dem Feed — bei Pinterest blieb er stehen, im Feed war er
 * weg, und pins-erzeugen.js hätte seinen Text nicht mehr als eingefroren behandelt. Die Regel
 * dafür steht in pin-sorten.js, weil beide Läufe dasselbe Wort gleich auslegen müssen.
 */
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
// Sortennamen, Slug, „veröffentlicht" und die Winterrunde stehen in EINEM Modul, das auch
// pins-erzeugen.js lädt. Sonst entschiede hier eine Zeichenkette über den Termin und dort
// eine zweite über das Bild — und niemand merkt, wenn sie auseinanderlaufen.
const S = require('./pin-sorten');

const WURZEL = path.join(__dirname, '..');
const LISTE = path.join(WURZEL, 'public', 'pins', 'liste.json');

const argv = process.argv.slice(2);
const wert = n => {
  const g = argv.find(x => x.startsWith(`--${n}=`));
  if (g) return g.split('=').slice(1).join('=');
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : null;
};
const DRY = argv.includes('--dry-run');
const NEU = argv.includes('--neu');
/*
 * Pins pro Tag. Diese Zahl ist nicht nur eine Frequenz, sie ist eine VORAUSSETZUNG DES FEEDS:
 * stauden-server.js liefert je Pinnwand hoechstens FEED_MAX Eintraege, und zwar die zuletzt
 * faellig gewordenen (feedAuswahl()). Solange an einem Tag weniger als FEED_MAX Pins DERSELBEN
 * Pinnwand faellig werden, erreicht jeder Pin an seinem Termin den Feed. Werden es mehr,
 * entscheidet innerhalb dieses Tages wieder die Dateireihenfolge — also das Alphabet der
 * guid —, und die alphabetisch fruehen fallen dauerhaft heraus, weil die Menge des Faelligen
 * nur waechst. Drei je Tag halten diese Bedingung mit grossem Abstand ein; die Rechnung dazu
 * steht bei winterVerteilung() in scripts/pin-sorten.js. Wer hier deutlich hochgeht, muss
 * vorher in stauden-server.js nachsehen.
 */
const PRO_TAG = Number(wert('pro-tag')) || 3;

const tag = d => d.toISOString().slice(0, 10);
const ausTag = s => new Date(s + 'T12:00:00Z');
const plus = (d, n) => new Date(d.getTime() + n * 86400000);

const START = wert('ab') ? ausTag(wert('ab')) : plus(new Date(), 1);
const HEUTE = tag(new Date());
const istVeroeffentlicht = e => S.istVeroeffentlicht(e, HEUTE);

const db = new Database(process.env.DB_PFAD || path.join(WURZEL, 'stauden.db'), { readonly: true });
const liste = JSON.parse(fs.readFileSync(LISTE, 'utf8'));

// ── Blühzeit je Pflanzen-Slug, für das Wunschdatum der Einzelpflanzen ────────
const MONATE = { januar: 1, februar: 2, 'märz': 3, april: 4, mai: 5, juni: 6,
                 juli: 7, august: 8, september: 9, oktober: 10, november: 11, dezember: 12 };
// Derselbe Slug, mit dem pin-text.js die Kennung pflanze-<slug> baut. Bis zum 21.09.2026 stand
// er hier ein zweites Mal, wortgleich. Wer eine der beiden Fassungen angefasst hätte, hätte
// die Zuordnung zwischen Pin und Blühzeit stillschweigend gekappt: Der Pin bekäme dann den
// Lückenfüller-Termin, und im Kalender sähe das aus wie eine Pflanze ohne lesbare Blühzeit.
const slugify = S.slugify;

const bluehStart = {};
for (const p of db.prepare('SELECT name_botanisch, bluehzeit FROM pflanzen').all()) {
  const ersterMonat = String(p.bluehzeit || '').toLowerCase().match(/[a-zäöü]+/);
  const m = ersterMonat ? MONATE[ersterMonat[0]] : null;
  if (m) bluehStart[slugify(p.name_botanisch)] = m;
}

/*
 * Das nächste Vorkommen eines Monats ab dem Startdatum, mit Vorlauf. Der Vorlauf ist der Kern
 * der Sache: Wer im Mai ein blühendes Beet sehen will, sucht im April danach.
 *
 * `versatzTage` verschiebt den Zieltag INNERHALB des Monats und gehört deshalb in die
 * Fensterwahl, nicht dahinter. Bis zum 21.09.2026 addierte die Winterrunde ihren Versatz erst
 * auf das Ergebnis: Über „schon vorbei?" entschied damit immer der Monatserste, nie der
 * tatsächlich gewünschte Tag. Ein Lauf am 10.12. schob deshalb auch die Dezember-Pins um ein
 * volles Jahr, deren Tag (12. bis 28.12.) noch bevorstand — rund 17 von 30 warteten ohne Not.
 */
function naechstesFenster(monat, vorlaufTage = 21, nachlaufTage = 75, versatzTage = 0) {
  for (let jahr = START.getUTCFullYear() - 1; jahr <= START.getUTCFullYear() + 1; jahr++) {
    const ziel = plus(new Date(Date.UTC(jahr, monat - 1, 1, 12)), versatzTage - vorlaufTage);
    if (ziel >= START) return ziel;
    /* Fenster gerade erst verpasst? Dann sofort statt in einem Jahr. Beim Start mitten in der
     * Saison ist das der Normalfall: Eine Staude, die JETZT blüht, hatte ihren Vorlauf im Juli.
     * Sie ein Jahr liegen zu lassen wäre absurd — sie ist heute am besten zu zeigen. Grenze bei
     * gut zwei Monaten nach Blühbeginn, danach ist die Blüte wirklich vorbei. */
    const seither = (START - ziel) / 86400000;
    if (seither > 0 && seither <= nachlaufTage) return new Date(START);
  }
  return START;
}

/* Ein Monatsraster taugt nur, solange der Monat läuft: „Was im August blüht" am 9. September
 * ist vorbei, auch wenn einzelne Arten noch blühen. Deshalb Vorlauf plus Monatslänge statt
 * der 75 Tage der Einzelpflanzen — genau das hätte am 08.09.2026 drei August-Fassungen in den
 * September gesetzt. */
const NACHLAUF_MONATSRASTER = 21 + 30;

/*
 * Ratgeber tragen die blütenlose Zeit: November bis Februar bekommt aus der Pflanzentabelle
 * fast nichts — 85 der 278 Stauden beginnen im Juni zu blühen, im Winter keine einzige.
 *
 * Verteilt wird REIHUM über eine sortierte Liste, nicht über einen Streuwert. Zwei Anläufe mit
 * hash() gingen schief: Beim ersten waren "h % 2" und "h % 4" gekoppelt (bei geradem h kann
 * h % 4 nur 0 oder 2 sein), beim zweiten streute der Hash über vier Monate schlicht ungleich —
 * Januar blieb bei drei Pins. Reihum ist deterministisch UND gleichmäßig; dieselbe Eingabe
 * ergibt immer dieselbe Verteilung, ohne dass man einer Zahlenfolge vertrauen muss.
 *
 * Die Hälfte geht in den Winter, die andere bleibt Lückenfüller fürs ganze Jahr.
 */
/* Die vier Wintermonate kommen aus pin-sorten.js — dieselbe Liste, die auch die Winterrunde
 * der Einzelpflanzen und den Startschub steuert. Hier stand sie bis zum 21.09.2026 ein zweites
 * Mal: Wer sie im Modul geändert hätte, hätte Startschub und Winterrunde verschoben, die
 * Ratgeber aber nicht — und nichts hätte das gemeldet. */
const ratgeberWunsch = new Map();
{
  const alleRatgeber = liste.filter(x => x.typ === S.TYP.ratgeber).map(x => x.guid).sort();
  alleRatgeber.forEach((guid, i) => {
    if (i % 2 === 0) {
      ratgeberWunsch.set(guid, naechstesFenster(S.WINTER_MONATE[(i / 2) % S.WINTER_MONATE.length], 0));
    }
  });
}

/*
 * Winterthemen (seit 08.09.2026, Kennung saison-winter-<thema>[-<standort>]): reihum auf die
 * Fenster für November und Dezember, nicht auf alle vier Wintermonate. Die Winterbeet-Raster
 * sind die reichweitenstärksten Pins des Kontos, und „Winterbeet" wird im Oktober und
 * November gesucht — im Februar sucht das niemand mehr.
 */
const winterWunsch = new Map();
liste.filter(x => x.typ === S.TYP.saison && /^saison-winter-/.test(String(x.guid))).map(x => x.guid).sort()
  .forEach((guid, i) => winterWunsch.set(guid, naechstesFenster([11, 12][i % 2], 21)));

/*
 * WINTERFASSUNG DER EINZELPFLANZEN (Sorte pflanze-winter, seit 21.09.2026).
 *
 * Der Grund, warum es diese Sorte gibt, ist genau dieser Terminplan: Die Einzelpflanzen-Pins
 * bringen die Klicks (33 von 37 gemessenen echten Ankünften) und schweigen von November bis
 * Februar — 0 Pins im November, 1 im Dezember, 2 im Januar, 8 im Februar, aber 49 im Mai. Das
 * ist kein Fehler der Verteilung, sondern ihr Inhalt: Der Wunsch folgt dem Blühbeginn.
 *
 * Verteilt wird REIHUM über die vier Wintermonate und innerhalb des Monats gestaffelt; die
 * Regel steht als winterVerteilung() in pin-sorten.js und lässt sich dort ohne Datenbank
 * nachrechnen. Kein Streuwert — die beiden Hash-Anläufe bei den Ratgebern sind oben
 * beschrieben.
 *
 * `nachlaufTage` ist hier 0, anders als bei jeder anderen Sorte: Die Regel „Fenster gerade
 * verpasst? Dann sofort statt in einem Jahr" ist für eine blühende Staude richtig und für
 * einen Winterpin falsch. Sie würde einen Novemberpin noch Mitte April auf den Starttag legen.
 */
const winterPflanzeWunsch = new Map();
for (const { guid, monat, versatz } of
     S.winterVerteilung(liste.filter(e => e.typ === S.TYP.pflanzeWinter).map(e => e.guid))) {
  winterPflanzeWunsch.set(guid, naechstesFenster(monat, 0, 0, versatz));
}

// Wunschdatum je Pin. null heißt „egal, verteile mich".
function wunsch(e) {
  if (e.typ === S.TYP.saison) {
    const g = String(e.guid);
    if (winterWunsch.has(g)) return winterWunsch.get(g);
    const m = Number((g.match(/^saison-(\d+)/) || [])[1]);     // saison-9 und saison-9-sonne
    return m ? naechstesFenster(m, 21, NACHLAUF_MONATSRASTER) : null;
  }
  if (e.typ === S.TYP.beetplan) {
    // Planungszeit Februar bis Mai, über die vier Monate gestreut
    const i = Math.abs(hash(e.guid)) % 4;
    return naechstesFenster(2 + i, 0);
  }
  if (e.typ === S.TYP.kombi) {
    // Die beiden Pflanzzeiten: Frühjahr und Frühherbst
    return naechstesFenster(hash(e.guid) % 2 === 0 ? 3 : 9, 14);
  }
  // Vor der Blühfassung, und der Vergleich ist bewusst exakt: „pflanze-winter" ist eine eigene
  // Sorte, keine Unterart von „pflanze". Sie darf nicht in den Zweig darunter fallen — dort
  // würde aus der Kennung ein Slug gelesen („winter-anemone-hupehensis"), der zu keiner
  // Pflanze gehört, und der Pin landete als Lückenfüller irgendwo im Jahr.
  if (e.typ === S.TYP.pflanzeWinter) return winterPflanzeWunsch.get(e.guid) || null;
  if (e.typ === S.TYP.pflanze) {
    const m = bluehStart[String(e.guid).replace('pflanze-', '')];
    return m ? naechstesFenster(m, 21) : null;
  }
  if (e.typ === S.TYP.ratgeber) return ratgeberWunsch.get(e.guid) || null;
  return null;   // alles Künftige: Lückenfüller
}

// Stabiler Streuwert aus der Kennung — gleiche Eingabe, gleiche Verteilung.
function hash(s) {
  let h = 0;
  for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) | 0;
  return h;
}

// ── Belegung ────────────────────────────────────────────────────────────────
const belegt = new Map();                       // 'YYYY-MM-DD' -> Anzahl
const vergeben = [];

/*
 * Einzelnen Termin setzen, auch einen schon vergebenen:  --termin saison-10=2026-09-09
 * Der Regelfall bleibt „einmal vergeben, bleibt vergeben"; das hier ist der ausdrückliche
 * Eingriff des Betreibers — etwa um einen Pin vorzuziehen, dessen Vorlauf schon verpasst ist.
 * Mehrfach angebbar.
 */
const TERMINE = argv
  .map((a, i) => a.startsWith('--termin=') ? a.slice('--termin='.length) : argv[i - 1] === '--termin' ? a : null)
  .filter(Boolean);
for (const angabe of TERMINE) {
  const [guid, datum] = angabe.split('=');
  const e = liste.find(x => x.guid === guid);
  if (!e) { console.error(`--termin: Pin ${guid} gibt es nicht.`); process.exit(1); }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(datum || '')) { console.error(`--termin: ${angabe} — Datum als JJJJ-MM-TT angeben.`); process.exit(1); }
  console.log(`--termin: ${guid} ${e.geplant_am ? `von ${e.geplant_am} ` : ''}auf ${datum}`);
  e.geplant_am = datum;
}

/*
 * WAS NEU TERMINIERT WIRD — UND WAS AUF KEINEN FALL.
 *
 * Drei Ausnahmen, und jede einzelne hat einen Schaden dahinter, den man nicht sieht:
 *
 * 1. Veröffentlichtes. Auch mit --neu. Ein Pin, dessen Termin erreicht ist, steht bei
 *    Pinterest und im Feed. Ein neu gesetzter Termin in der Zukunft nähme ihn aus dem Feed,
 *    ohne ihn bei Pinterest zu entfernen — und pins-erzeugen.js hielte seinen Text nicht mehr
 *    fest, könnte ihn also neu berechnen, während das Bild draußen unverändert bleibt.
 *    Dieselbe Regel, dasselbe Modul: S.istVeroeffentlicht.
 * 2. Was gerade mit --termin ausdrücklich gesetzt wurde. Sonst überschriebe --neu im selben
 *    Aufruf genau die Angabe, für die der Schalter da ist.
 * 3. Ohne --neu wie bisher alles, was schon einen Termin hat.
 */
const festgesetzt = new Set(TERMINE.map(a => String(a).split('=')[0]));
const offen = liste.filter(e => !istVeroeffentlicht(e) && !festgesetzt.has(e.guid) && (NEU || !e.geplant_am));
const wirdVergeben = new Set(offen);

// Belegt ist jeder Tag, der einen Pin trägt, der NICHT neu vergeben wird. Vorher hing das an
// `!NEU` — mit --neu galt dadurch auch der Tag eines veröffentlichten Pins als frei, obwohl er
// besetzt bleibt.
for (const e of liste) {
  if (e.geplant_am && !wirdVergeben.has(e)) belegt.set(e.geplant_am, (belegt.get(e.geplant_am) || 0) + 1);
}

function freierTag(ab, grenze = PRO_TAG, maxSuche = 400) {
  let d = ab < START ? new Date(START) : new Date(ab);
  for (let i = 0; i < maxSuche; i++) {
    const t = tag(d);
    if ((belegt.get(t) || 0) < grenze) return t;
    d = plus(d, 1);
  }
  return tag(d);
}

/*
 * Saison-Pins dürfen als Vierter auf ihren Wunschtag. Ohne das landete „Was im Oktober blüht"
 * am 03.10. statt am 10.09.: Der September war mit Einzelpflanzen voll, und ausgerechnet die
 * Sorte mit der größten Reichweite rückte als Letzte nach — hinter ihren eigenen Monatsanfang.
 */
const grenzeFuer = e => e.typ === S.TYP.saison ? PRO_TAG + 1 : PRO_TAG;

const mitWunsch = [], ohneWunsch = [];
for (const e of offen) (wunsch(e) ? mitWunsch : ohneWunsch).push(e);

// Zuerst die terminierten, nach Wunschdatum
mitWunsch.sort((a, b) => wunsch(a) - wunsch(b));
for (const e of mitWunsch) {
  const t = freierTag(wunsch(e), grenzeFuer(e));
  e.geplant_am = t;
  belegt.set(t, (belegt.get(t) || 0) + 1);
  vergeben.push(e);
}

/*
 * Lückenfüller auf die LEERSTEN Tage verteilen, nicht der Reihe nach ab Start. Die erste
 * Fassung hat sie stur von vorn eingekippt — Ergebnis waren acht Tage am Stück nur Farne und
 * Gräser, während September bis Januar fast leer blieben. Genau umgekehrt ist es richtig:
 * Farne, Gräser und Blattschmuck sind der Herbst- und Winterinhalt, sie gehören dorthin, wo
 * keine Blüte etwas zu melden hat.
 */
const HORIZONT = 365;
const alleTage = [];
for (let i = 0; i < HORIZONT; i++) alleTage.push(tag(plus(START, i)));

for (const e of ohneWunsch) {
  // Immer der Tag mit der geringsten Belegung; bei Gleichstand der frühere.
  let besterTag = null, besteZahl = Infinity;
  for (const t of alleTage) {
    const n = belegt.get(t) || 0;
    if (n < besteZahl) { besteZahl = n; besterTag = t; if (n === 0) break; }
  }
  const t = besteZahl < PRO_TAG ? besterTag : freierTag(ausTag(besterTag));
  e.geplant_am = t;
  belegt.set(t, (belegt.get(t) || 0) + 1);
  vergeben.push(e);
}

/*
 * Startschub: Jede Pinnwand braucht am ersten Tag Inhalt, sonst laesst sich ihr Feed gar nicht
 * anschliessen — Pinterest prueft beim Verbinden und lehnt mit "Dieser RSS-Feed weist keine
 * Elemente auf" ab. Danach laeuft der normale Takt weiter.
 *
 * Genommen wird je Pinnwand das, was ohnehin als Naechstes drankaeme. Der Terminplan wird damit
 * nicht durcheinandergebracht, nur sein Anfang zusammengezogen.
 */
/*
 * WINTERINHALT WIRD NICHT VORGEZOGEN (seit 21.09.2026).
 *
 * Der Startschub kennt nur das Datum, nicht den Inhalt: Er nimmt je Pinnwand die drei
 * fruehesten kuenftigen Pins, und im August 2026 waren das die Winter-Pins. So sind
 * Winterbeet-Raster mitten im Sommer hinausgegangen. Bei der neuen Sorte pflanze-winter waere
 * derselbe Fehler schlimmer: „Samenstaende bleiben stehen" am 22. September ist kein
 * unpassender Zeitpunkt, sondern eine falsche Aussage ueber den Zustand der Pflanze.
 *
 * Welche Pins Winterinhalt sind, entscheidet S.istWinterinhalt() — dieselbe Stelle, an der
 * auch pins-erzeugen.js die Sorte kennt. Betroffen sind die neue Sorte, die Winterthemen-
 * Raster und die Monatsraster der vier Wintermonate.
 *
 * Die Pinnwand „Winterbeet" bekommt dadurch keinen Startschub mehr. Das ist die richtige
 * Folge und kein Verlust: Ihr Feed ist nicht leer, er fuehrt die bereits veroeffentlichten
 * Pins weiter (stauden-server.js liefert je Pinnwand hoechstens FEED_MAX Eintraege, und zwar
 * die zuletzt faellig gewordenen — feedAuswahl(); nicht „alles Faellige"). Muss dort doch
 * einmal etwas sofort hinaus, ist --termin der Weg — ein ausdruecklicher Eingriff statt eines
 * Nebeneffekts.
 */
// „--startschub 0" muss 0 bleiben — mit `Number(x) || 3` wurde daraus stillschweigend 3.
const SCHUB = wert('startschub') == null ? 3 : (Number(wert('startschub')) || 0);
if (SCHUB > 0) {
  const jeBrett = {};
  for (const e of liste) (jeBrett[e.board] = jeBrett[e.board] || []).push(e);
  let vorgezogen = 0, zurueckgehalten = 0;
  for (const eintraege of Object.values(jeBrett)) {
    eintraege.sort((a, b) => String(a.geplant_am).localeCompare(String(b.geplant_am)));
    /* ERST SCHNEIDEN, DANN FILTERN. Andersherum nähme der Startschub immer die drei frühesten
     * NICHT-Winter-Pins, auch wenn deren Monate weit entfernt liegen: Gemessen landeten so
     * zwei Mai-Pins auf dem 22. September. Winterinhalt zurückzuhalten heißt nicht, Ersatz aus
     * der Zukunft nachzuziehen — eine im Mai blühende Staude im September ist dieselbe Art
     * Falschaussage, gegen die die Regel geschrieben ist. So bleibt `zurueckgehalten` auch die
     * Zahl dessen, was an dieser Stelle wirklich zurückgehalten wurde. */
    const vorne = eintraege.slice(0, SCHUB);
    zurueckgehalten += vorne.filter(S.istWinterinhalt).length;
    /* Dieselben Ausnahmen wie bei der Terminvergabe weiter oben, und aus denselben Gründen:
     * Veröffentlichtes bleibt, wo es ist, und was gerade mit --termin gesetzt wurde, wird
     * nicht im selben Aufruf wieder überschrieben. `festgesetzt` wirkte bis zum 21.09.2026
     * nur auf `offen`; der Startschub lief danach über ALLE Einträge und hat eine ausdrückliche
     * Angabe still überschrieben — gemessen: --termin pflanze-juni=2027-06-15 landete auf dem
     * Starttag und wäre am nächsten Tag hinausgegangen. */
    for (const e of vorne) {
      if (S.istWinterinhalt(e) || festgesetzt.has(e.guid) || istVeroeffentlicht(e)) continue;
      if (e.geplant_am > tag(START)) { e.geplant_am = tag(START); vorgezogen++; }
    }
  }
  if (vorgezogen) console.log(`Startschub: ${vorgezogen} Pins auf ${tag(START)} vorgezogen (${SCHUB} je Pinnwand)`);
  if (zurueckgehalten) console.log(`Startschub: ${zurueckgehalten} Winter-Pin(s) nicht vorgezogen — sie bleiben in ihrem Monat`);
}

// ── Ausgabe ─────────────────────────────────────────────────────────────────
const tage = [...belegt.keys()].sort();
const heute = tag(new Date());

/*
 * FAELLIG IST NICHT DASSELBE WIE IM FEED.
 *
 * Bis zum 21.09.2026 stand hier „faellig und im Feed" ueber der blossen Zahl aller Eintraege
 * mit erreichtem Termin. Der Feed liefert aber je Pinnwand hoechstens FEED_MAX Eintraege, und
 * zwar die ZULETZT faellig gewordenen (stauden-server.js, feedAuswahl()); ausserdem faellt
 * dort jeder Eintrag heraus, dessen Bilddatei fehlt (pinsLesen()). Gemessen in der Produktion:
 * 58 faellig auf einer Pinnwand, 25 davon im Feed. Genau diesen zu hohen Wert hat die
 * Uebersicht unter /pinterest gerade korrigiert bekommen — eine zweite Ausgabestelle mit
 * derselben Annahme waere die Rueckkehr des Fehlers durch die Hintertuer.
 *
 * Der Deckel wird hier NICHT nachgebaut, auch nicht als Konstante: FEED_MAX steht in
 * stauden-server.js, und eine zweite Fassung der Zahl liefe bei der ersten Aenderung still
 * auseinander — dieses Skript koennte sie nicht durchsetzen und wuerde trotzdem eine Zahl
 * behaupten. Es sagt deshalb, was es selbst weiss (faellig, je Pinnwand aufgeschluesselt), und
 * nennt fuer den Rest die Stelle, die es wirklich entscheidet.
 */
const faelligJeBrett = new Map();
for (const e of liste) {
  if (!e.geplant_am || e.geplant_am > heute) continue;
  const brett = e.board || '(ohne Pinnwand)';
  faelligJeBrett.set(brett, (faelligJeBrett.get(brett) || 0) + 1);
}
const faellig = [...faelligJeBrett.values()].reduce((a, b) => a + b, 0);

console.log(`${liste.length} Pins · ${vergeben.length} neu terminiert · ${PRO_TAG} pro Tag ab ${tag(START)}`);
console.log(`Zeitraum: ${tage[0]} bis ${tage[tage.length - 1]}  (${tage.length} Tage mit Pins)`);
console.log(`Heute (${heute}) faellig: ${faellig}`);
for (const brett of [...faelligJeBrett.keys()].sort()) {
  console.log(`  ${String(faelligJeBrett.get(brett)).padStart(4)}  ${brett}`);
}
console.log('Davon im Feed: je Pinnwand hoechstens FEED_MAX, die zuletzt faellig gewordenen');
console.log('(stauden-server.js, feedAuswahl()). Genaue Zahl mit Deckel: /pinterest\n');

console.log('Die naechsten 14 Tage:');
for (let i = 0; i < 14; i++) {
  const t = tag(plus(START, i));
  const drauf = liste.filter(e => e.geplant_am === t);
  if (!drauf.length) continue;
  console.log(`  ${t}  ${drauf.map(e => `[${e.typ}] ${e.titel.slice(0, 46)}`).join('\n              ')}`);
}

const proMonat = {};
for (const e of liste) if (e.geplant_am) {
  const m = e.geplant_am.slice(0, 7);
  (proMonat[m] = proMonat[m] || {})[e.typ] = ((proMonat[m] || {})[e.typ] || 0) + 1;
}
console.log('\nVerteilung ueber die Monate:');
for (const m of Object.keys(proMonat).sort()) {
  const z = proMonat[m];
  const summe = Object.values(z).reduce((a, b) => a + b, 0);
  console.log(`  ${m}  ${String(summe).padStart(3)}  ${Object.entries(z).map(([k, v]) => `${k}:${v}`).join('  ')}`);
}

if (DRY) {
  console.log('\n--dry-run: nichts geschrieben.');
} else {
  fs.writeFileSync(LISTE, JSON.stringify(liste, null, 1));
  console.log(`\ngeschrieben: ${LISTE}`);
}
db.close();
