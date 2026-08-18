/*
 * Erzeugt je Ratgeber-Artikel ein eigenes Vorschaubild (1200 × 630) unter public/og/.
 *
 *   node scripts/og-ratgeber.js              fehlende erzeugen
 *   node scripts/og-ratgeber.js --neu        alle neu erzeugen
 *   node scripts/og-ratgeber.js --limit 3    nur die ersten N, für Probeläufe
 *
 * WARUM: Alle 78 Artikel teilten sich bisher /images/og-default.jpg. Wer die Seiten teilt oder
 * pinnt — der Betreiber selbst oder ein Besucher —, erzeugt damit 78 bildgleiche Vorschauen.
 * Pinterest fasst optisch identische Pins zusammen und wertet Wiederholung als Spam; Facebook
 * und WhatsApp zeigen für jeden Artikel dasselbe Bild.
 *
 * WARUM REIN TYPOGRAFISCH, OHNE PFLANZENFOTO: 412 der 711 Pflanzenbilder stammen von Pixabay
 * oder Wikimedia. Ein og:image ist genau das Bild, das beim Teilen und Pinnen nach außen geht —
 * damit gälte für sie dieselbe Schranke, die scripts/pin-bild.js für Pins durchsetzt. Eine
 * Textkarte umgeht die Frage vollständig, statt sie je Artikel prüfen zu müssen.
 *
 * Die Kategoriefarben sind dieselben wie im Artikel-Kopfbereich (KAT_CONFIG in
 * stauden-server.js). Bei acht Kategorien ergibt das acht Grundtöne; unterschieden werden die
 * Karten ohnehin durch den Titel.
 */
const Database = require('better-sqlite3');
const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const WURZEL = path.join(__dirname, '..');
const ZIEL = path.join(WURZEL, 'public', 'og');
const B = 1200, H = 630;
const FONT = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf';
const FONT_B = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf';

const argv = process.argv.slice(2);
const NEU = argv.includes('--neu');
const LIMIT = Number(argv[argv.indexOf('--limit') + 1]) || 0;

// Grundton je Kategorie, abgeleitet aus KAT_CONFIG in stauden-server.js. Dort stehen
// CSS-Verläufe; hier reicht die dunkle Hälfte als Fläche plus ein hellerer Ton für die Linie.
const KAT_FARBE = {
  'Grundprinzipien':   ['#1b4332', '#52b788'],
  'Standorte':         ['#1e3a5f', '#60a5fa'],
  'Gestaltung':        ['#4c1d95', '#c4b5fd'],
  'Oekologie':         ['#064e3b', '#6ee7b7'],
  'Praxis':            ['#78350f', '#fcd34d'],
  'Kombinationen':     ['#831843', '#f9a8d4'],
  'Stilpraegend':      ['#134e4a', '#5eead4'],
  'Design':            ['#1e293b', '#cbd5e1'],
  'Pflanzenportraits': ['#3f2d1e', '#fcd34d'],
};
const STANDARD = ['#1b4332', '#95d5b2'];

const slugify = s => String(s).toLowerCase()
  .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/*
 * Textbreite bei ImageMagick erfragen statt zu schätzen. Geschätzte Breite hat beim Pin-Bau
 * zweimal Überschriften abgeschnitten — auf einer Vorschaukarte fiele das noch mehr auf, weil
 * sie fast nur aus der Überschrift besteht.
 */
function textBreite(text, font, groesse) {
  const out = execFileSync('convert', ['-font', font, '-pointsize', String(groesse),
    'label:' + text, '-format', '%w', 'info:'], { encoding: 'utf8' });
  return parseInt(out, 10) || 0;
}

function umbrechenBreit(text, font, groesse, maxBreite) {
  const worte = String(text).split(/\s+/);
  const zeilen = [];
  let z = '';
  for (const w of worte) {
    const versuch = (z + ' ' + w).trim();
    if (z && textBreite(versuch, font, groesse) > maxBreite) { zeilen.push(z); z = w; }
    else z = versuch;
  }
  if (z) zeilen.push(z);
  return zeilen;
}

function ogKarte(artikel, ziel) {
  const [flaeche, akzent] = KAT_FARBE[artikel.kategorie] || STANDARD;
  const innen = B - 160;

  // Schriftgrad so wählen, dass der Titel in höchstens vier Zeilen passt. Lange Titel gibt es
  // reichlich ("Staudenbeet Farbgestaltung: Harmonische Farbkombinationen planen").
  let groesse = 62;
  let zeilen = umbrechenBreit(artikel.titel, FONT_B, groesse, innen);
  while (zeilen.length > 4 && groesse > 38) {
    groesse -= 6;
    zeilen = umbrechenBreit(artikel.titel, FONT_B, groesse, innen);
  }
  // Reicht auch das nicht, wird gekürzt statt überlaufen zu lassen.
  if (zeilen.length > 4) zeilen = zeilen.slice(0, 4).map((z, i) => i === 3 ? z + ' …' : z);

  const zeilenH = Math.round(groesse * 1.22);
  const blockH = zeilen.length * zeilenH;
  const start = Math.round((H - blockH) / 2) + 10;

  const args = ['-size', `${B}x${H}`, `xc:${flaeche}`, '-gravity', 'northwest'];

  // Akzentbalken links: gibt der Karte eine Kante und macht die Kategorie auch ohne Text lesbar.
  args.push('-fill', akzent, '-draw', `rectangle 0,0 14,${H}`);

  // Kategorie als Zeile oben
  args.push('-font', FONT_B, '-pointsize', '26', '-fill', akzent);
  args.push('-annotate', '+80+64', artikel.kategorie.toUpperCase());

  // Titel
  args.push('-font', FONT_B, '-pointsize', String(groesse), '-fill', 'white');
  let y = start;
  for (const z of zeilen) { args.push('-annotate', `+80+${y}`, z); y += zeilenH; }

  // Fußzeile
  args.push('-font', FONT, '-pointsize', '27', '-fill', 'rgba(255,255,255,0.72)');
  args.push('-annotate', `+80+${H - 68}`, 'staudenplan.de   ·   Ratgeber');

  args.push('-quality', '88', ziel);
  execFileSync('convert', args, { stdio: 'pipe' });
}

const db = new Database(process.env.DB_PFAD || path.join(WURZEL, 'stauden.db'), { readonly: true });
fs.mkdirSync(ZIEL, { recursive: true });

let artikel = db.prepare('SELECT titel, kategorie FROM wissen').all();
if (LIMIT) artikel = artikel.slice(0, LIMIT);

let erzeugt = 0, vorhanden = 0, fehler = 0;
for (const a of artikel) {
  const datei = path.join(ZIEL, `ratgeber-${slugify(a.titel)}.jpg`);
  if (fs.existsSync(datei) && !NEU) { vorhanden++; continue; }
  try { ogKarte(a, datei); erzeugt++; }
  catch (e) { console.error(`  ! ${a.titel}: ${e.message}`); fehler++; }
}

console.log(`${artikel.length} Artikel · ${erzeugt} erzeugt · ${vorhanden} unverändert · ${fehler} Fehler`);
console.log(`Ziel: ${ZIEL}`);
if (fehler) process.exitCode = 1;
