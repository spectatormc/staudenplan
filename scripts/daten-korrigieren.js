/*
 * Setzt die Befunde der Datenprüfung vom 09.08.2026 um.
 *
 *   node scripts/daten-korrigieren.js              nur zeigen, nichts ändern
 *   node scripts/daten-korrigieren.js --anwenden   schreiben
 *
 * GRUNDSATZ: Keine Pflanze wird offline genommen. Alle 709 bleiben im Lexikon, behalten ihre
 * Seite und ihre Bilder. Korrigiert werden die ANGABEN, damit die Regeln greifen können —
 * eine Zistrose ist nicht falsch in einer Staudendatenbank, sie ist nur nicht winterhart, und
 * genau das muss im Feld stehen. Der Planer liest die Felder danach richtig (stauden-server.js,
 * Konstante PLANBAR).
 *
 * Belege stehen bei jedem Abschnitt. Der botanische Name wird vor jedem Schreibvorgang
 * gegengeprüft: Stimmt er nicht, bricht das Skript ab, statt die falsche Pflanze zu ändern.
 */
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const WURZEL = path.join(__dirname, '..');

/* ── 1. Winterhärte ──────────────────────────────────────────────────────────
 * Das Feld stand bei 74 % aller Pflanzen auf Zone 5 und bei keiner über Zone 7 — ein
 * Vorgabewert. Korrigiert werden die Arten, bei denen das nachweislich nicht stimmt.
 * USDA-Untergrenzen: Zone 6 = −23 °C, 7 = −18 °C, 8 = −12 °C, 9 = −7 °C, 10 = −1 °C.
 */
const ZONEN = [
  // Mittelmeerraum: Zistrosen halten je nach Art −12 bis −15 °C (Lubera, GartenFlora,
  // Plantura). Im Freiland hier nur mit Schutz, im Handel als Kübelpflanze geführt.
  { bot: 'Cistus laurifolius',  zone: 7, warum: 'härteste Art der Gattung, bis −15 °C' },
  { bot: 'Cistus x purpureus',  zone: 8, warum: 'bis etwa −12 °C, in unseren Lagen Kübelpflanze' },
  { bot: 'Cistus x hybridus',   zone: 8, warum: 'bis etwa −12 °C' },
  { bot: 'Cistus albidus',      zone: 8, warum: 'bis etwa −12 °C' },
  // Südliche Halbkugel und Subtropen — im deutschen Handel einjährig oder als Kübelpflanze.
  { bot: 'Salvia elegans',      zone: 9, warum: 'Mexiko, frostfrei überwintern' },
  { bot: 'Melinis nerviglumis', zone: 9, warum: 'Südafrika, hier einjähriges Ziergras' },
  { bot: "Pennisetum setaceum 'Rubrum'", zone: 9, warum: 'Handelsname „Einjähriges Garten-Federborstengras", bis −6 °C' },
  { bot: 'Osteospermum ecklonis', zone: 9, warum: 'Südafrika, klassische Beet- und Balkonpflanze' },
  { bot: 'Agapanthus africanus', zone: 8, warum: 'Südafrika, überwintert frostfrei' },
  { bot: 'Portulaca grandiflora', zone: 10, warum: 'frostempfindliche Sommerblume' },
  { bot: 'Salvia microphylla',  zone: 8, warum: 'Mexiko, nur in Weinbauklima ausreichend hart' },
  // Grenzwertig: bleiben im Planer (Zone 7 ist in weiten Teilen Deutschlands nutzbar),
  // aber die Zahl soll stimmen.
  { bot: 'Santolina chamaecyparissus', zone: 7, warum: 'der ausführliche Text auf der Seite sagt selbst „bis circa −15°C winterhart (Zone 7)"' },
  { bot: 'Santolina rosmarinifolia', zone: 7, warum: 'wie die Schwesterart' },
  { bot: 'Gunnera manicata',    zone: 7, warum: 'braucht dicke Winterabdeckung aus eigenen Blättern' },
  { bot: 'Gunnera tinctoria',   zone: 7, warum: 'wie oben' },
  { bot: 'Cortaderia selloana Pumila', zone: 7, warum: 'Pampasgras braucht zusammengebundenen Horst und Schutz' },
  { bot: 'Nassella tenuissima', zone: 7, warum: 'Mexiko/Südamerika, in kalten Lagen unzuverlässig' },
  { bot: 'Alstroemeria aurantiaca', zone: 7, warum: 'Südamerika, Knollen brauchen Schutz' },
  { bot: "Imperata cylindrica 'Red Baron'", zone: 7, warum: 'in kalten Lagen häufiger Totalausfall' },
  // Aus der Gegenprüfung Feld ↔ eigener Fließtext: der Text ist die genauere Angabe.
  { bot: 'Delosperma cooperi',  zone: 7, warum: 'eigener Text: bis −15 °C' },
  { bot: 'Geranium x magnificum', zone: 6, warum: 'eigener Text: bis −20 °C' },
];

/* ── 2. Lebensdauer ──────────────────────────────────────────────────────────
 * Neue Spalte. Es gab bisher keine Möglichkeit, „ist gar keine Staude" auszudrücken —
 * deshalb konnten einjährige Arten in einem Staudenbeetplan landen.
 *
 * Einjährige werden aus dem PLANER genommen (nicht von der Seite): Eine Sommerblume in
 * einem Bepflanzungsplan, der auf Jahre angelegt ist, ist schlicht der falsche Vorschlag.
 * Zweijährige bleiben drin — Wilde Karde und Nachtviole säen sich zuverlässig selbst aus
 * und sind in naturnahen Pflanzungen richtig; die Angabe steht jetzt nur dabei.
 */
const LEBENSDAUER = [
  { bot: 'Ammi majus',                  wert: 'einjaehrig' },
  { bot: 'Cerinthe major Purpurascens', wert: 'einjaehrig' },
  { bot: 'Phacelia tanacetifolia',      wert: 'einjaehrig' },
  { bot: 'Portulaca grandiflora',       wert: 'einjaehrig' },
  { bot: 'Hordeum jubatum',             wert: 'einjaehrig' },
  { bot: 'Hesperis matronalis',         wert: 'zweijaehrig' },
  { bot: 'Erysimum cheiri',             wert: 'zweijaehrig' },
  { bot: 'Melilotus albus',             wert: 'zweijaehrig' },
  { bot: 'Salvia argentea',             wert: 'zweijaehrig' },
  { bot: 'Dipsacus fullonum',           wert: 'zweijaehrig' },
];

/* ── 3. heimisch ─────────────────────────────────────────────────────────────
 * In beide Richtungen falsch. Bezugsrahmen ist „wächst in Deutschland wild".
 */
const HEIMISCH_WEG = [
  { bot: 'Rudbeckia laciniata',  warum: 'Nordamerika, hier nur eingebürgert' },
  { bot: 'Eutrochium maculatum', warum: 'Nordamerika — der heimische Wasserdost ist Eupatorium cannabinum' },
  { bot: 'Nymphaea tetragona',   warum: 'Ostasien/Nordamerika — heimisch ist Nymphaea alba' },
];
const HEIMISCH_DAZU = ['Sanguisorba officinalis','Armeria maritima','Helleborus niger','Digitalis purpurea',
  'Iris sibirica','Aconitum napellus','Vinca minor','Scabiosa columbaria','Digitalis grandiflora',
  'Saponaria ocymoides','Helleborus foetidus','Teucrium chamaedrys','Lilium martagon','Clematis recta'];

/* ── 4. Bienenfreundlich bei Gräsern ─────────────────────────────────────────
 * Gräser, Seggen und Binsen werden vom Wind bestäubt und liefern keinen Nektar. Das Häkchen
 * führt jeden in die Irre, der über /bienenfreundliche-stauden sucht.
 */
const GRAS_GATTUNG = require('./pin-layout');

/* ── 5. Einzelfälle ──────────────────────────────────────────────────────────*/
const EINZELN = [
  { bot: 'Iris ensata', feld: 'feuchtigkeit', wert: 'feucht|nass',
    warum: 'stand auf „trocken" bei Lebensbereich Quellflur — die Sumpfiris braucht dauerfeuchten Boden' },
  { bot: 'Lycopus', feld: 'name_botanisch', wert: 'Lycopus europaeus',
    warum: 'nur die Gattung eingetragen; der deutsche Name „Ufer-Wolfstrapp" bezeichnet eindeutig L. europaeus' },
  { bot: 'Sagittaria', feld: 'name_botanisch', wert: 'Sagittaria sagittifolia',
    warum: 'nur die Gattung eingetragen; „Pfeilkraut" ist eindeutig S. sagittifolia' },
];

// ── Ausführung ───────────────────────────────────────────────────────────────
const anwenden = process.argv.includes('--anwenden');
const db = new Database(process.env.DB_PFAD || path.join(WURZEL, 'stauden.db'), { readonly: !anwenden });
const protokoll = [];

function finde(bot) {
  const p = db.prepare('SELECT * FROM pflanzen WHERE name_botanisch = ?').get(bot);
  if (!p) throw new Error(`nicht gefunden: „${bot}" — abgebrochen, statt die falsche Pflanze zu ändern`);
  return p;
}
function merke(bereich, p, feld, alt, neu, warum) {
  if (String(alt ?? '') === String(neu ?? '')) return false;
  protokoll.push({ bereich, id: p.id, name: p.name_deutsch, botanisch: p.name_botanisch, feld, alt, neu, warum });
  return true;
}

// 0. Spalte anlegen
const hatSpalte = db.prepare('PRAGMA table_info(pflanzen)').all().some(s => s.name === 'lebensdauer');
if (!hatSpalte) {
  if (anwenden) db.exec("ALTER TABLE pflanzen ADD COLUMN lebensdauer TEXT DEFAULT 'staude'");
  console.log(`Spalte lebensdauer ${anwenden ? 'angelegt' : 'fehlt noch (wird angelegt)'}`);
}

ZONEN.forEach(z => { const p = finde(z.bot); merke('Winterhärte', p, 'winterhart_zone', p.winterhart_zone, z.zone, z.warum); });
LEBENSDAUER.forEach(l => { const p = finde(l.bot); merke('Lebensdauer', p, 'lebensdauer', p.lebensdauer || 'staude', l.wert, l.wert === 'einjaehrig' ? 'einjährig, gehört nicht in einen Staudenbeetplan' : 'zweijährig, blüht einmal und sät sich aus'); });
HEIMISCH_WEG.forEach(h => { const p = finde(h.bot); merke('heimisch', p, 'heimisch', p.heimisch, 0, h.warum); });
HEIMISCH_DAZU.forEach(bot => { const p = finde(bot); merke('heimisch', p, 'heimisch', p.heimisch, 1, 'wächst in Deutschland wild'); });

// Gräser
db.prepare('SELECT * FROM pflanzen WHERE bienen_freundlich = 1').all()
  .filter(p => GRAS_GATTUNG.istGras(p))
  .forEach(p => merke('Bienenweide', p, 'bienen_freundlich', 1, 0, 'Gras — windbestäubt, kein Nektar'));

// Farbe: Schreibweise vereinheitlichen (211 Werte klein, der Rest groß → 92 statt ~25 Werte)
const grossErster = s => s.charAt(0).toUpperCase() + s.slice(1);
db.prepare('SELECT * FROM pflanzen').all().forEach(p => {
  const neu = String(p.farbe || '').split('|').map(t => grossErster(t.trim())).filter(Boolean).join('|');
  merke('Farbe', p, 'farbe', p.farbe, neu, 'Groß- und Kleinschreibung gemischt');
});

/* Lebensbereich: Kürzel der Staudensystematik nach Hansen in dieselbe Sprache bringen wie
 * der Rest der Spalte. Die Ziffer ist die Feuchtestufe (1 trocken, 2 frisch, 3 feucht) und
 * entfällt — die steht schon in `feuchtigkeit`. Nebenbei werden die Trenner vereinheitlicht:
 * „Gehölzrand,Waldsaum" und „Gehölzrand, Waldsaum" waren bisher zwei verschiedene Werte. */
const KUERZEL = { B: 'Beet', FR: 'Freifläche', G: 'Gehölz', GR: 'Gehölzrand', ST: 'Steinanlage', SH: 'Steppenheide', H: 'Heide', W: 'Wasserfläche', WR: 'Teichrand' };
// Schreibvarianten, die beim Umformen sichtbar wurden.
const SYNONYM = { 'Freiflächen': 'Freifläche', 'Steingarten': 'Steinanlage', 'Gehölzränder': 'Gehölzrand' };
db.prepare('SELECT * FROM pflanzen').all().forEach(p => {
  const roh = String(p.lebensbereich || '').trim();
  if (!roh) return;
  const teile = roh.split(/[,/]/).map(t => t.trim()).filter(Boolean).map(t => {
    const m = t.match(/^([A-Za-z]{1,3})\s*\d?$/);                       // „G2", „FR1", „B2"
    if (m && KUERZEL[m[1].toUpperCase()]) return KUERZEL[m[1].toUpperCase()];
    if (/^\d+$/.test(t)) return null;                                   // Reste wie die 3 aus „Fr2,3"
    return SYNONYM[t] || t;
  }).filter(Boolean);
  // Alphabetisch sortiert, weil dieselbe Kombination in beiden Reihenfolgen vorkam
  // („Freifläche,Gehölzrand" und „Gehölzrand,Freifläche") und damit doppelt gezählt wurde.
  const neu = [...new Set(teile)].sort((a, b) => a.localeCompare(b, 'de')).join(',');
  merke('Lebensbereich', p, 'lebensbereich', p.lebensbereich, neu, /^[A-Za-z]{1,3}\d/.test(roh) ? 'Kürzel in Klartext' : 'Schreibweise und Reihenfolge vereinheitlicht');
});

EINZELN.forEach(e => { const p = finde(e.bot); merke('Einzelfall', p, e.feld, p[e.feld], e.wert, e.warum); });

// Ausgabe
const proBereich = new Map();
protokoll.forEach(e => proBereich.set(e.bereich, (proBereich.get(e.bereich) || 0) + 1));
console.log('\nGeplante Änderungen:');
[...proBereich.entries()].forEach(([b, n]) => console.log(`   ${String(n).padStart(4)}  ${b}`));
console.log(`   ${String(protokoll.length).padStart(4)}  insgesamt\n`);

protokoll.filter(e => !/^(Farbe|Lebensbereich)$/.test(e.bereich)).forEach(e =>
  console.log(`   ${e.bereich.padEnd(13)} ${String(e.id).padStart(4)}  ${String(e.name).padEnd(28)}${e.feld}: ${e.alt} → ${e.neu}`));

if (!anwenden) { console.log('\nZum Schreiben: --anwenden'); process.exit(0); }

const schreiben = db.transaction(() => {
  const heute = new Date().toISOString().slice(0, 10);
  protokoll.forEach(e => {
    db.prepare(`UPDATE pflanzen SET ${e.feld} = ?, aktualisiert_am = ? WHERE id = ?`).run(e.neu, heute, e.id);
  });
});
schreiben();

const beleg = path.join(WURZEL, 'data', `datenkorrektur-${new Date().toISOString().slice(0, 10)}.json`);
fs.mkdirSync(path.dirname(beleg), { recursive: true });
fs.writeFileSync(beleg, JSON.stringify(protokoll, null, 2) + '\n');
console.log(`\n${protokoll.length} Änderungen geschrieben. Beleg: ${path.relative(WURZEL, beleg)}`);
