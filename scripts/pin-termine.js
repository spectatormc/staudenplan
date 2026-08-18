/*
 * Vergibt jedem Pin ein Veröffentlichungsdatum (`geplant_am`) in public/pins/liste.json.
 *
 *   node scripts/pin-termine.js --dry-run              Kalender zeigen, nichts schreiben
 *   node scripts/pin-termine.js                        Termine vergeben und schreiben
 *   node scripts/pin-termine.js --pro-tag 3            Pins pro Tag (Vorgabe 3)
 *   node scripts/pin-termine.js --ab 2026-08-19        Startdatum (Vorgabe: morgen)
 *   node scripts/pin-termine.js --neu                  auch bereits vergebene Termine neu setzen
 *   node scripts/pin-termine.js --startschub 3         je Pinnwand N Pins auf den Starttag ziehen
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
 */
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

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
const PRO_TAG = Number(wert('pro-tag')) || 3;

const tag = d => d.toISOString().slice(0, 10);
const ausTag = s => new Date(s + 'T12:00:00Z');
const plus = (d, n) => new Date(d.getTime() + n * 86400000);

const START = wert('ab') ? ausTag(wert('ab')) : plus(new Date(), 1);

const db = new Database(process.env.DB_PFAD || path.join(WURZEL, 'stauden.db'), { readonly: true });
const liste = JSON.parse(fs.readFileSync(LISTE, 'utf8'));

// ── Blühzeit je Pflanzen-Slug, für das Wunschdatum der Einzelpflanzen ────────
const MONATE = { januar: 1, februar: 2, 'märz': 3, april: 4, mai: 5, juni: 6,
                 juli: 7, august: 8, september: 9, oktober: 10, november: 11, dezember: 12 };
const slugify = s => String(s).toLowerCase()
  .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
  .replace(/['']/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

const bluehStart = {};
for (const p of db.prepare('SELECT name_botanisch, bluehzeit FROM pflanzen').all()) {
  const ersterMonat = String(p.bluehzeit || '').toLowerCase().match(/[a-zäöü]+/);
  const m = ersterMonat ? MONATE[ersterMonat[0]] : null;
  if (m) bluehStart[slugify(p.name_botanisch)] = m;
}

/*
 * Das nächste Vorkommen eines Monats ab dem Startdatum, mit Vorlauf. Der Vorlauf ist der Kern
 * der Sache: Wer im Mai ein blühendes Beet sehen will, sucht im April danach.
 */
function naechstesFenster(monat, vorlaufTage = 21) {
  for (let jahr = START.getUTCFullYear() - 1; jahr <= START.getUTCFullYear() + 1; jahr++) {
    const ziel = plus(new Date(Date.UTC(jahr, monat - 1, 1, 12)), -vorlaufTage);
    if (ziel >= START) return ziel;
    /* Fenster gerade erst verpasst? Dann sofort statt in einem Jahr. Beim Start mitten in der
     * Saison ist das der Normalfall: Eine Staude, die JETZT blüht, hatte ihren Vorlauf im Juli.
     * Sie ein Jahr liegen zu lassen wäre absurd — sie ist heute am besten zu zeigen. Grenze bei
     * gut zwei Monaten nach Blühbeginn, danach ist die Blüte wirklich vorbei. */
    const seither = (START - ziel) / 86400000;
    if (seither > 0 && seither <= 75) return new Date(START);
  }
  return START;
}

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
const WINTER_MONATE = [11, 12, 1, 2];
const ratgeberWunsch = new Map();
{
  const alleRatgeber = liste.filter(x => x.typ === 'ratgeber').map(x => x.guid).sort();
  alleRatgeber.forEach((guid, i) => {
    if (i % 2 === 0) ratgeberWunsch.set(guid, naechstesFenster(WINTER_MONATE[(i / 2) % 4], 0));
  });
}

// Wunschdatum je Pin. null heißt „egal, verteile mich".
function wunsch(e) {
  if (e.typ === 'saison') {
    const m = Number(String(e.guid).replace('saison-', ''));
    return m ? naechstesFenster(m, 21) : null;
  }
  if (e.typ === 'beetplan') {
    // Planungszeit Februar bis Mai, über die vier Monate gestreut
    const i = Math.abs(hash(e.guid)) % 4;
    return naechstesFenster(2 + i, 0);
  }
  if (e.typ === 'kombi') {
    // Die beiden Pflanzzeiten: Frühjahr und Frühherbst
    return naechstesFenster(hash(e.guid) % 2 === 0 ? 3 : 9, 14);
  }
  if (e.typ === 'pflanze') {
    const m = bluehStart[String(e.guid).replace('pflanze-', '')];
    return m ? naechstesFenster(m, 21) : null;
  }
  if (e.typ === 'ratgeber') return ratgeberWunsch.get(e.guid) || null;
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

for (const e of liste) {
  if (e.geplant_am && !NEU) belegt.set(e.geplant_am, (belegt.get(e.geplant_am) || 0) + 1);
}

function freierTag(ab, maxSuche = 400) {
  let d = ab < START ? new Date(START) : new Date(ab);
  for (let i = 0; i < maxSuche; i++) {
    const t = tag(d);
    if ((belegt.get(t) || 0) < PRO_TAG) return t;
    d = plus(d, 1);
  }
  return tag(d);
}

const offen = liste.filter(e => NEU || !e.geplant_am);
const mitWunsch = [], ohneWunsch = [];
for (const e of offen) (wunsch(e) ? mitWunsch : ohneWunsch).push(e);

// Zuerst die terminierten, nach Wunschdatum
mitWunsch.sort((a, b) => wunsch(a) - wunsch(b));
for (const e of mitWunsch) {
  const t = freierTag(wunsch(e));
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
const SCHUB = Number(wert('startschub')) || 3;
if (SCHUB > 0) {
  const jeBrett = {};
  for (const e of liste) (jeBrett[e.board] = jeBrett[e.board] || []).push(e);
  let vorgezogen = 0;
  for (const eintraege of Object.values(jeBrett)) {
    eintraege.sort((a, b) => String(a.geplant_am).localeCompare(String(b.geplant_am)));
    for (const e of eintraege.slice(0, SCHUB)) {
      if (e.geplant_am > tag(START)) { e.geplant_am = tag(START); vorgezogen++; }
    }
  }
  if (vorgezogen) console.log(`Startschub: ${vorgezogen} Pins auf ${tag(START)} vorgezogen (${SCHUB} je Pinnwand)`);
}

// ── Ausgabe ─────────────────────────────────────────────────────────────────
const tage = [...belegt.keys()].sort();
const heute = tag(new Date());
const faellig = liste.filter(e => e.geplant_am && e.geplant_am <= heute).length;

console.log(`${liste.length} Pins · ${vergeben.length} neu terminiert · ${PRO_TAG} pro Tag ab ${tag(START)}`);
console.log(`Zeitraum: ${tage[0]} bis ${tage[tage.length - 1]}  (${tage.length} Tage mit Pins)`);
console.log(`Heute (${heute}) faellig und im Feed: ${faellig}\n`);

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
