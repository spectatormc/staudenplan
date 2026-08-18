/*
 * Erzeugt aus einem Ratgeber-Artikel einen Pinterest-Pin (1000 × 1500).
 *
 *   node scripts/pin-ratgeber.js --liste            zeigt alle Artikel
 *   node scripts/pin-ratgeber.js <rowid> [ziel.jpg]
 *
 * WARUM DIESE SORTE: Die vier bisherigen Pin-Arten hängen alle an der Blüte, und der Blühbeginn
 * der 278 pinnbaren Stauden ballt sich im Juni (85 Arten). Von November bis Februar gäbe es
 * deshalb fast nichts zu zeigen — das ist keine Datenlücke, sondern die Sache selbst. Ratgeber
 * sind saisonunabhängig und tragen genau diese Monate. Nebenbei ist „how-to" auf Pinterest eine
 * der meistgesuchten Inhaltsarten.
 *
 * REIN TYPOGRAFISCH, wie die Vorschaukarten unter public/og/: Ein Ratgeber hat kein eigenes
 * Bild, und die Pflanzenfotos gehören überwiegend Pixabay und Wikimedia — für einen Pin unter
 * eigenem Namen sind sie gesperrt (siehe pin-bild.js). Eine Textkarte umgeht die Frage ganz.
 *
 * KEIN ERFUNDENER INHALT: Der Teaser ist der erste VOLLSTÄNDIGE Satz des Artikels, nicht eine
 * Zusammenfassung. Was auf dem Pin steht, steht so auch auf der Seite.
 */
const Database = require('better-sqlite3');
const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const { MAGICK, FONT, FONT_B, textBreite, umbrechenBreit } = require('./pin-layout');

const WURZEL = path.join(__dirname, '..');
const B = 1000, H = 1500;

// Grundton je Kategorie — dieselben acht wie bei den Vorschaukarten und im Artikelkopf.
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

/* Erster vollständiger Satz mit brauchbarer Länge. Abgeschnittene Sätze sehen auf einem Pin
 * nach Fehler aus — dieselbe Regel wie beim Beetplan-Pin. */
function ersterSatz(text, minLaenge = 60, maxLaenge = 220) {
  const saetze = String(text || '').replace(/\s+/g, ' ').split(/(?<=[.!?])\s+/);
  for (const s of saetze) {
    const t = s.trim();
    if (t.length >= minLaenge && t.length <= maxLaenge) return t;
  }
  return '';
}

function lesezeit(text) {
  return Math.max(1, Math.round(String(text || '').split(/\s+/).length / 200));
}

function ratgeberPin(artikel, ziel) {
  const [flaeche, akzent] = KAT_FARBE[artikel.kategorie] || STANDARD;
  const innen = B - 120;

  const titelZeilen = (() => {
    let g = 62;
    let z = umbrechenBreit(artikel.titel, FONT_B, g, innen);
    while (z.length > 5 && g > 40) { g -= 5; z = umbrechenBreit(artikel.titel, FONT_B, g, innen); }
    return { g, z: z.slice(0, 5) };
  })();

  // Mehr Teaser zulassen: Die Karte ist hochkant und der Titel allein füllt sie nicht. Die
  // erste Fassung ließ 700 Pixel Leerraum in der Mitte, was auf Pinterest nach einem Fehler
  // aussieht. Reicht ein Satz nicht, kommt der nächste dazu — aber nur ganze Sätze.
  const teaser = ersterSatz(artikel.inhalt, 60, 480);
  const teaserZeilen = teaser ? umbrechenBreit(teaser, FONT, 31, innen).slice(0, 10) : [];

  /* Der Block wird VERTIKAL ZENTRIERT statt oben angeheftet. Artikeltitel sind zwischen zwei
   * und fünf Zeilen lang; bei fester Startlinie klafft darunter je nach Länge eine andere
   * Lücke. Zentriert sitzt die Karte immer ausgewogen. */
  const KOPF = 96, FUSS = 230;
  const zeilenH = Math.round(titelZeilen.g * 1.2);
  const blockH = 74                                   // Kategoriezeile
    + titelZeilen.z.length * zeilenH
    + (teaserZeilen.length ? 60 + teaserZeilen.length * 44 : 0);
  let y = Math.max(KOPF, Math.round((H - FUSS - blockH) / 2));

  const args = ['-size', `${B}x${H}`, `xc:${flaeche}`, '-gravity', 'northwest'];

  // Akzentbalken oben statt links: im Hochformat trägt eine waagerechte Kante besser.
  args.push('-fill', akzent, '-draw', `rectangle 0,0 ${B},12`);

  args.push('-font', FONT_B, '-pointsize', '28', '-fill', akzent);
  args.push('-annotate', `+60+${y}`, String(artikel.kategorie || 'Ratgeber').toUpperCase());
  y += 74;

  args.push('-font', FONT_B, '-pointsize', String(titelZeilen.g), '-fill', 'white');
  for (const z of titelZeilen.z) { args.push('-annotate', `+60+${y}`, z); y += zeilenH; }

  if (teaserZeilen.length) {
    y += 26;
    args.push('-fill', akzent, '-draw', `rectangle 60,${y} 200,${y + 3}`);
    y += 34;
    args.push('-font', FONT, '-pointsize', '31', '-fill', '#d8f3dc');
    for (const z of teaserZeilen) { args.push('-annotate', `+60+${y}`, z); y += 44; }
  }

  // Lesezeit als kleine Einordnung — auf Pinterest ein wirksamer Klickgrund bei Textinhalten.
  args.push('-font', FONT, '-pointsize', '27', '-fill', '#74c69d');
  args.push('-annotate', `+60+${H - 190}`, `${lesezeit(artikel.inhalt)} Min. Lesezeit`);

  args.push('-font', FONT_B, '-pointsize', '31', '-fill', '#95d5b2');
  args.push('-annotate', `+60+${H - 128}`, 'Ganzen Ratgeber lesen — kostenlos');

  args.push('-font', FONT, '-pointsize', '25', '-fill', '#74c69d');
  args.push('-annotate', `+60+${H - 48}`, 'staudenplan.de   ·   Ratgeber');

  args.push('-quality', '88', ziel);
  execFileSync(MAGICK, args, { stdio: 'pipe' });
  return { ziel, teaser: !!teaser, zeilen: titelZeilen.z.length };
}

function ladeArtikel(db) {
  return db.prepare('SELECT rowid, titel, inhalt, kategorie FROM wissen ORDER BY rowid').all();
}

if (require.main === module) {
  const db = new Database(process.env.DB_PFAD || path.join(WURZEL, 'stauden.db'), { readonly: true });
  const artikel = ladeArtikel(db);

  if (process.argv.includes('--liste')) {
    for (const a of artikel) console.log(`${String(a.rowid).padStart(4)}  [${a.kategorie}] ${a.titel}`);
    console.log(`\n${artikel.length} Artikel`);
    process.exit(0);
  }
  const id = Number(process.argv[2]);
  const a = artikel.find(x => x.rowid === id) || artikel[0];
  if (!a) { console.error('Kein Artikel gefunden'); process.exit(1); }
  const r = ratgeberPin(a, process.argv[3] || `/tmp/pin-ratgeber-${slugify(a.titel)}.jpg`);
  console.log('erzeugt:', r.ziel, '·', a.titel, r.teaser ? '' : '· ohne Teaser');
}

module.exports = { ratgeberPin, ladeArtikel, ersterSatz, lesezeit, slugify };
