// Fügt 50 weitere Stauden-Einträge hinzu (2 neue Kategorien).
// node scripts/seed-pflanzen-extra.js

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const Database = require('better-sqlite3');
const { OpenAI } = require('openai');
const path = require('path');
const fs = require('fs');

const db = new Database(path.join(__dirname, '..', 'stauden.db'));
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const EXTRA_BATCHES = [
  {
    name: 'Vorgarten und pflegeleichte Beete',
    prompt: 'Stauden besonders geeignet für Vorgartenbeete, pflegeleichte Beete und Beete für Einsteiger: Sedum (Fetthenne), Bergenia (Bergenien alle Sorten), Stachys byzantina (Wollziest), Geranium (robuste Arten wie G. sanguineum, G. macrorrhizum), Astilbe (pflegeleicht), Helleborus, Alchemilla mollis (Frauenmantel), Nepeta (Katzenminze alle Sorten), Salvia nemorosa und Hybriden, Coreopsis grandiflora, Rudbeckia fulgida, Echinacea, Achillea (Schafgarbe alle Farben), Gaillardia, Leucanthemum, Platycodon, Amsonia, Phlox paniculata (robuste Sorten), Kniphofia (winterharte Sorten), Crocosmia, Agapanthus (winterharte), Veronica spicata, Liatris spicata, Hemerocallis (Taglilie alle Sorten), Tradescantia, Penstemon (winterharte Sorten)'
  },
  {
    name: 'Balkon, Kübel und kleine Gärten',
    prompt: 'Kompakte Stauden für Kübel, Balkonkästen und kleine Stadtgärten: Kleine Hosta-Sorten, Heuchera (alle Farben), Tiarella, Heucherella, Astilbe chinensis "Pumila", Bergenia "Baby Doll", Veronica prostrata, Saxifraga (Steinbrech), Armeria maritima (Grasnelke), Dianthus (Garten-Nelken kompakte Sorten), Aubrieta, Phlox subulata, Delosperma, Sedum album, Sempervivum, Thymus, Origanum laevigatum "Herrenhausen", Geranium cinereum, G. sanguineum "Album", Campanula carpatica, Potentilla neumanniana, Primula (winterharte Gartenarten), Linum perenne, Scabiosa columbaria, Stokesia laevis, Erodium, Anaphalis, Gypsophila repens, Erinus alpinus'
  }
];

const INSERT = db.prepare(`
  INSERT OR IGNORE INTO pflanzen
  (name_deutsch, name_botanisch, beschreibung, licht, boden, stil, bluehzeit, farbe,
   hoehe_cm_min, hoehe_cm_max, pflege_sterne, preis_stueck_eur, winterhart_zone,
   bienen_freundlich, heimisch)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

async function generateBatch(batch) {
  console.log(`\n[${batch.name}] Generiere...`);
  const prompt = `Erstelle eine Liste von 25-28 Gartenstauden aus dieser Kategorie: "${batch.name}".
Schwerpunkt: ${batch.prompt}

Alle Pflanzen sollen in Deutschland winterhart (Zone 5-7) und für Privatgärten geeignet sein.
Preise: realistisch (3-20 €/Stück).

Antworte als JSON mit einem Array unter dem Key "pflanzen":
{
  "pflanzen": [
    {
      "name_deutsch": "Bergenien",
      "name_botanisch": "Bergenia cordifolia",
      "beschreibung": "Immergrüne, robuste Staude mit großen ledrigen Blättern und rosa Blütenrispen im Frühjahr. Ideal für pflegeleichte Beete.",
      "licht": "Sonne|Halbschatten|Schatten",
      "boden": "sandig|lehmig|normal",
      "stil": "Naturgarten|Bauerngarten|Modern|Cottage",
      "bluehzeit": "März - April",
      "farbe": "Rosa|Weiß",
      "hoehe_cm_min": 30,
      "hoehe_cm_max": 45,
      "pflege_sterne": 1,
      "preis_stueck_eur": 7.90,
      "winterhart_zone": 4,
      "bienen_freundlich": 1,
      "heimisch": 0
    }
  ]
}`;

  const completion = await openai.chat.completions.create({
    model: 'gpt-4o',
    messages: [
      { role: 'system', content: 'Du bist Botaniker und Staudenspezialist. Nur valides JSON zurückgeben.' },
      { role: 'user', content: prompt }
    ],
    temperature: 0.4,
    response_format: { type: 'json_object' }
  });

  let parsed;
  try { parsed = JSON.parse(completion.choices[0].message.content); }
  catch { console.error('Parse-Fehler'); return 0; }

  const pflanzen = parsed.pflanzen || parsed.plants || (Array.isArray(parsed) ? parsed : null);
  if (!Array.isArray(pflanzen)) { console.error('Kein Array:', Object.keys(parsed)); return 0; }

  let inserted = 0;
  for (const p of pflanzen) {
    if (!p.name_deutsch || !p.name_botanisch) continue;
    try {
      const r = INSERT.run(
        p.name_deutsch, p.name_botanisch, p.beschreibung || null,
        p.licht || 'Sonne|Halbschatten', p.boden || 'normal',
        p.stil || 'Bauerngarten|Naturgarten', p.bluehzeit || null,
        p.farbe || null, p.hoehe_cm_min || null, p.hoehe_cm_max || null,
        p.pflege_sterne || 2, p.preis_stueck_eur || 7.90,
        p.winterhart_zone || 6, p.bienen_freundlich ? 1 : 0, p.heimisch ? 1 : 0
      );
      if (r.changes > 0) inserted++;
    } catch (e) { console.warn(`  Skip ${p.name_botanisch}: ${e.message}`); }
  }
  console.log(`  -> ${inserted} neu (${pflanzen.length} generiert)`);
  return inserted;
}

(async () => {
  console.log(`=== Vorher: ${db.prepare('SELECT COUNT(*) as n FROM pflanzen').get().n} Einträge ===`);
  let total = 0;
  for (const batch of EXTRA_BATCHES) {
    total += await generateBatch(batch);
    await new Promise(r => setTimeout(r, 1000));
  }
  const final = db.prepare('SELECT COUNT(*) as n FROM pflanzen').get().n;
  console.log(`\n=== +${total} neue, ${final} gesamt ===`);

  // Update seed JSON
  const all = db.prepare('SELECT * FROM pflanzen ORDER BY name_botanisch').all();
  fs.writeFileSync(path.join(__dirname, '..', 'data', 'pflanzen-seed.json'), JSON.stringify(all, null, 2));
  db.close();
})().catch(console.error);
