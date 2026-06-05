// Fügt Feuchtigkeit + Wuchsverhalten zur Pflanzen-DB hinzu.
// Ausfuehren: node scripts/migrate-feuchtigkeit-wuchs.js

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const Database = require('better-sqlite3');
const path = require('path');
const db = new Database(path.join(__dirname, '..', 'stauden.db'));

try { db.exec(`ALTER TABLE pflanzen ADD COLUMN feuchtigkeit TEXT DEFAULT 'normal'`); console.log('✓ Spalte feuchtigkeit hinzugefügt'); } catch { console.log('- feuchtigkeit bereits vorhanden'); }
try { db.exec(`ALTER TABLE pflanzen ADD COLUMN wuchs TEXT DEFAULT 'horstig'`); console.log('✓ Spalte wuchs hinzugefügt'); } catch { console.log('- wuchs bereits vorhanden'); }

// ── Feuchtigkeit ──────────────────────────────────────────────────────────────

const TROCKEN = [
  'Lavandula', 'Thymus', 'Salvia', 'Perovskia', 'Stachys', 'Artemisia',
  'Festuca', 'Helictotrichon', 'Stipa', 'Phlomis', 'Cistus', 'Verbena',
  'Echinops', 'Eryngium', 'Euphorbia', 'Sedum', 'Sempervivum', 'Dianthus',
  'Gypsophila', 'Linum', 'Centranthus', 'Oenothera', 'Origanum', 'Aethionema',
  'Nepeta', 'Agastache', 'Penstemon', 'Achillea', 'Erigeron', 'Helianthemum',
  'Iris', 'Allium', 'Inula', 'Coreopsis', 'Gaillardia', 'Rudbeckia',
  'Delosperma', 'Antennaria', 'Armeria', 'Aubrieta', 'Arabis',
];

const FEUCHT = [
  'Astilbe', 'Ligularia', 'Rodgersia', 'Gunnera', 'Petasites', 'Darmera',
  'Filipendula', 'Lythrum', 'Caltha', 'Lysimachia', 'Lobelia', 'Mimulus',
  'Lycopus', 'Mentha', 'Pontederia', 'Sagittaria', 'Typha', 'Carex',
  'Primula japonica', 'Primula florindae', 'Iris pseudacorus', 'Iris sibirica',
  'Cimicifuga', 'Actaea', 'Aruncus', 'Trollius', 'Ranunculus',
];

const WECHSELFEUCHT = [
  'Helenium', 'Persicaria', 'Sanguisorba', 'Thalictrum', 'Veronicastrum',
  'Hemerocallis', 'Hosta', 'Bergenia', 'Astrantia', 'Phlox',
  'Monarda', 'Chelone', 'Vernonia',
];

const NASS = [
  'Iris pseudacorus', 'Caltha', 'Typha', 'Pontederia', 'Sagittaria',
  'Butomus', 'Alisma', 'Glyceria',
];

function setFeuchtigkeit(genera, wert) {
  for (const g of genera) {
    const r = db.prepare(`UPDATE pflanzen SET feuchtigkeit = ? WHERE name_botanisch LIKE ?`).run(wert, `${g}%`);
    if (r.changes > 0) console.log(`  feuchtigkeit=${wert}: ${g}* (${r.changes})`);
  }
}

console.log('\n── Feuchtigkeit ──');
setFeuchtigkeit(TROCKEN, 'trocken');
setFeuchtigkeit(WECHSELFEUCHT, 'wechselfeucht');
setFeuchtigkeit(FEUCHT, 'feucht');
setFeuchtigkeit(NASS, 'nass');

// ── Wuchsverhalten ────────────────────────────────────────────────────────────

const AUSLAEUFER = [
  // Rhizomatös ausbreitend, kann benachbarte Pflanzen verdrängen
  { g: 'Lysimachia', w: 'ausläufer' },
  { g: 'Mentha', w: 'invasiv' },
  { g: 'Petasites', w: 'invasiv' },
  { g: 'Aegopodium', w: 'invasiv' },
  { g: 'Vinca', w: 'ausläufer' },
  { g: 'Lamium', w: 'ausläufer' },
  { g: 'Waldsteinia', w: 'ausläufer' },
  { g: 'Ajuga', w: 'ausläufer' },
  { g: 'Pachysandra', w: 'ausläufer' },
  { g: 'Convallaria', w: 'ausläufer' },
  { g: 'Polygonatum', w: 'ausläufer' },
  { g: 'Solidago', w: 'ausläufer' },
  { g: 'Macleaya', w: 'ausläufer' },
  { g: 'Physalis', w: 'ausläufer' },
  { g: 'Persicaria', w: 'ausläufer' },
];

const SELBSTSAEND = [
  { g: 'Digitalis', w: 'selbstsäend' },
  { g: 'Alchemilla', w: 'selbstsäend' },
  { g: 'Verbena bonariensis', w: 'selbstsäend' },
  { g: 'Aquilegia', w: 'selbstsäend' },
  { g: 'Oenothera', w: 'selbstsäend' },
  { g: 'Lythrum', w: 'selbstsäend' },
  { g: 'Centranthus', w: 'selbstsäend' },
  { g: 'Verbascum', w: 'selbstsäend' },
  { g: 'Papaver', w: 'selbstsäend' },
];

console.log('\n── Wuchsverhalten ──');
for (const { g, w } of [...AUSLAEUFER, ...SELBSTSAEND]) {
  const r = db.prepare(`UPDATE pflanzen SET wuchs = ? WHERE name_botanisch LIKE ?`).run(w, `${g}%`);
  if (r.changes > 0) console.log(`  wuchs=${w}: ${g}* (${r.changes})`);
}

const total = db.prepare(`SELECT COUNT(*) as n FROM pflanzen WHERE feuchtigkeit != 'normal'`).get().n;
const wuchsTotal = db.prepare(`SELECT COUNT(*) as n FROM pflanzen WHERE wuchs != 'horstig'`).get().n;
console.log(`\n=== Fertig: ${total} Pflanzen mit Feuchtigkeitspräferenz, ${wuchsTotal} mit Wuchs-Hinweis ===`);
db.close();
