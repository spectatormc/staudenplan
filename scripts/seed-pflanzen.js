// Befüllt die pflanzen-Tabelle mit ~300 deutschen Gartenstauden per GPT-4o.
// Ausfuehren: node scripts/seed-pflanzen.js
// Idempotent via INSERT OR IGNORE.

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const Database = require('better-sqlite3');
const { OpenAI } = require('openai');
const fs = require('fs');
const path = require('path');

const db = new Database(path.join(__dirname, '..', 'stauden.db'));
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

db.exec(`
  CREATE TABLE IF NOT EXISTS pflanzen (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name_deutsch TEXT NOT NULL,
    name_botanisch TEXT UNIQUE NOT NULL,
    beschreibung TEXT,
    licht TEXT,
    boden TEXT,
    stil TEXT,
    bluehzeit TEXT,
    farbe TEXT,
    hoehe_cm_min INTEGER,
    hoehe_cm_max INTEGER,
    pflege_sterne INTEGER,
    preis_stueck_eur REAL,
    winterhart_zone INTEGER,
    bienen_freundlich INTEGER DEFAULT 0,
    heimisch INTEGER DEFAULT 0,
    aktualisiert_am TEXT DEFAULT (datetime('now'))
  )
`);

const BATCHES = [
  {
    name: 'Sonnige Staudenbeete (Präriecharakter)',
    prompt: 'Sonnige Staudenbeete im Präriecharakter: hohe, strukturgebende Stauden und Begleiter wie Echinops, Echinacea, Rudbeckia, Agastache, Penstemon, Salvia, Veronicastrum, Sanguisorba, Eryngium, Phlomis, Monarda, Liatris, Knautia, Achillea, Gaura/Oenothera, Gaillardia, Helenium, Heliopsis, Inula, Solidago, Telekia, Baptisia, Thermopsis, Verbascum, Verbena bonariensis, Persicaria amplexicaulis, Astrantia für trockene Lagen, Dianthus, Gypsophila'
  },
  {
    name: 'Sonnige Kies- und Mediterrangärten',
    prompt: 'Trockenresistente Stauden für Kiesgärten und mediterrane Beete: Lavandula, Stachys byzantina, Artemisia, Festuca glauca, Sedum/Hylotelephium, Sempervivum-Begleiter, Allium ornamentale, Iris germanica, Euphorbia, Perovskia, Centranthus, Phlox subulata, Linum, Oenothera, Nepeta, Cistus-Unterpflanzung, Origanum, Thymus, Delosperma, Osteospermum, Anaphalis, Cerastium, Aubrieta, Armeria, Dianthus gratianopolitanus'
  },
  {
    name: 'Halbschatten-Stauden (Waldrand)',
    prompt: 'Halbschattige Waldrand-Stauden: Astilbe, Hosta, Rodgersia, Ligularia, Aruncus, Thalictrum, Actaea, Cimicifuga, Filipendula, Persicaria bistorta, Polygonatum, Anemone sylvestris, Anemone hupehensis, Brunnera, Pulmonaria, Helleborus, Epimedium, Geranium (halbschattige Arten), Carex, Dryopteris, Matteuccia, Osmunda, Hakonechloa, Luzula, Campanula latifolia, Trollius, Lysimachia, Primula (garten-Arten)'
  },
  {
    name: 'Halbschatten-Beete (gartentauglich)',
    prompt: 'Klassische Halbschatten-Gartenstauden: Astilbe (alle Formen), Digitalis, Foxglove, Geranium endressii, G. nodosum, G. phaeum, Aquilegia, Bergenia, Ajuga, Alchemilla, Lamium, Saxifraga, Tiarella, Heuchera, Heucherella, Phlox divaricata, P. stolonifera, Convallaria, Iris sibirica, Chelone, Aconitum, Veratrum, Kirengeshoma, Meconopsis, Cephalaria'
  },
  {
    name: 'Schattenstauden',
    prompt: 'Echte Schattenstauden für tiefere Schatten unter Gehölzen: Hosta (alle Sorten), Epimedium (alle Arten), Dryopteris, Athyrium, Polystichum, Asplenium, Omphalodes, Pachysandra, Waldsteinia, Vinca, Luzula sylvatica, Carex pendula, Pulmonaria (dunkle Lagen), Lamiastrum, Arum italicum, Aruncus aethusifolius, Sarcococca, Asarum, Paris quadrifolia, Trillium, Maianthemum'
  },
  {
    name: 'Trockene und magere Standorte',
    prompt: 'Stauden für trockene, magere Böden: Sedum spurium, S. reflexum, Hylotelephium, Sempervivum, Delosperma, Portulaca, Stachys byzantina, Artemisia schmidtiana, Festuca, Antennaria, Dianthus carthusianorum, D. deltoides, Pulsatilla vulgaris, Linum perenne, Silene, Erysimum, Malva, Potentilla, Anchusa, Lithospermum, Phacelia, Hieracium, Centaurea, Lychnis viscaria, Helichrysum'
  },
  {
    name: 'Feuchte Standorte und Teichrand',
    prompt: 'Feuchtigkeitsliebende Stauden für nasse und feuchte Böden, Teichrand, Sumpfbeete: Iris pseudacorus, Iris ensata, Caltha palustris, Trollius europaeus, Primula japonica, P. bulleyana, Gunnera tinctoria, Ligularia, Astilbe chinensis, Filipendula ulmaria, Lysimachia punctata, L. nummularia, Lythrum salicaria, Lobelia cardinalis, Lobelia siphilitica, Mimulus, Lycopus, Mentha, Veronicastrum (feuchte Böden), Carex, Typha, Sagittaria, Pontederia'
  },
  {
    name: 'Bauerngarten-Klassiker',
    prompt: 'Klassische Bauerngarten- und Cottage-Stauden: Paeonia (Pfingstrosen), Delphinium, Lupinus, Rosa (Bodendeckerrosen), Iris germanica, Phlox paniculata, Monarda, Lychnis coronaria, Campanula persicifolia, C. glomerata, Hesperis, Digitalis, Malva alcea, Kniphofia, Agapanthus (winterharte Sorten), Crocosmia, Centaurea montana, Coreopsis, Geum, Tradescantia, Verbascum, Thalictrum, Achillea, Rudbeckia, Hemerocallis, Yucca'
  },
  {
    name: 'Naturgarten (heimische Arten)',
    prompt: 'Heimische (einheimische) Wildstauden für naturnahe Gärten in Deutschland: Salvia pratensis, S. nemorosa, Centaurea scabiosa, C. cyanus, Knautia arvensis, Scabiosa columbaria, Origanum vulgare, Thymus, Primula veris, Ranunculus aconitifolius, Geranium pratense, G. sanguineum, Silene dioica, Lychnis flos-cuculi, Leucanthemum vulgare, Tanacetum vulgare, Dipsacus fullonum, Cichorium intybus, Hypericum perforatum, Verbascum thapsus, Echium vulgare, Campanula rotundifolia, Betonica officinalis, Agrimonia, Sanguisorba minor'
  },
  {
    name: 'Moderne Staudenbeete und Herbststauden',
    prompt: 'Stauden für moderne Staudenbeete (Neues Deutsches Design), Herbst-Winteraspekte: Pennisetum, Miscanthus (Ziergräser, aber füge nur Stauden ein), Aster (Herbstaster), Amsonia, Calamintha, Sporobolus heterolepis, Panicum virgatum (nur Gras-Begleiter-Stauden), Sedum telenum, Persicaria amplexicaulis, Phlox, Calamagrostis-Begleiter, Sanguisorba, Hylotelephium Herbstsorten, Eupatorium, Vernonia, Rudbeckia maxima, Ratibida, Silphium, Parthenium, Physalis alkekengi, Anemone japonica Herbstsorten, Leucanthemella'
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
  console.log(`\n[${batch.name}] Generiere Daten...`);

  const prompt = `Erstelle eine Liste von 28-32 Gartenstauden und Gartenpflanzen aus dieser Kategorie: "${batch.name}".
Schwerpunkt: ${batch.prompt}

Jede Pflanze soll typisch für deutsche Privatgärten und in Deutschland winterhart (Zone 5-7) sein.
Preis: realistischer Handelspreis in deutschen Gärtnereien (3-25 €/Stück).

Antworte als JSON-Array:
[
  {
    "name_deutsch": "Purpur-Storchschnabel",
    "name_botanisch": "Geranium sanguineum",
    "beschreibung": "Robuste, teppichbildende Staude mit leuchtend purpurroten Blüten von Mai bis August. Ideal für sonnige bis halbschattige Beete und Steingärten.",
    "licht": "Sonne|Halbschatten",
    "boden": "sandig|normal",
    "stil": "Naturgarten|Bauerngarten|Cottage",
    "bluehzeit": "Mai - August",
    "farbe": "Rosa|Purpur",
    "hoehe_cm_min": 20,
    "hoehe_cm_max": 30,
    "pflege_sterne": 1,
    "preis_stueck_eur": 6.90,
    "winterhart_zone": 5,
    "bienen_freundlich": 1,
    "heimisch": 1
  }
]

Regeln:
- licht: Kombinationen aus "Sonne", "Halbschatten", "Schatten" mit | getrennt
- boden: Kombinationen aus "sandig", "lehmig", "normal" mit | getrennt
- stil: Kombinationen aus "Naturgarten", "Bauerngarten", "Modern", "Cottage" mit | getrennt
- farbe: Hauptblütefarben mit | getrennt (z.B. "Rosa|Weiß|Lila")
- pflege_sterne: 1 = pflegeleicht, 2 = mittel, 3 = anspruchsvoll
- heimisch: 1 = in Deutschland heimisch, 0 = Gartenpflanze
- Keine Wiederholungen, echte botanische Namen`;

  const completion = await openai.chat.completions.create({
    model: 'gpt-4o',
    messages: [
      {
        role: 'system',
        content: 'Du bist ein erfahrener Botaniker und Staudenspezialist. Gib ausschließlich valides JSON zurück, kein Markdown.'
      },
      { role: 'user', content: prompt }
    ],
    temperature: 0.4,
    response_format: { type: 'json_object' }
  });

  const raw = completion.choices[0].message.content;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.error('Parse-Fehler:', raw.substring(0, 200));
    return 0;
  }

  const pflanzen = Array.isArray(parsed) ? parsed : (parsed.pflanzen || parsed.plants || Object.values(parsed)[0]);
  if (!Array.isArray(pflanzen)) {
    console.error('Kein Array gefunden in:', Object.keys(parsed));
    return 0;
  }

  let inserted = 0;
  for (const p of pflanzen) {
    if (!p.name_deutsch || !p.name_botanisch) continue;
    try {
      const result = INSERT.run(
        p.name_deutsch, p.name_botanisch, p.beschreibung || null,
        p.licht || 'Sonne|Halbschatten', p.boden || 'normal',
        p.stil || 'Bauerngarten|Naturgarten', p.bluehzeit || null,
        p.farbe || null, p.hoehe_cm_min || null, p.hoehe_cm_max || null,
        p.pflege_sterne || 2, p.preis_stueck_eur || 7.90,
        p.winterhart_zone || 6, p.bienen_freundlich ? 1 : 0, p.heimisch ? 1 : 0
      );
      if (result.changes > 0) inserted++;
    } catch (err) {
      console.warn(`  Skip ${p.name_botanisch}: ${err.message}`);
    }
  }
  console.log(`  -> ${inserted} neue Eintraege (${pflanzen.length} generiert)`);
  return inserted;
}

async function main() {
  console.log('=== Pflanzendatenbank befuellen ===');
  console.log(`Vorher: ${db.prepare('SELECT COUNT(*) as n FROM pflanzen').get().n} Eintraege`);

  let total = 0;
  const allData = [];

  for (const batch of BATCHES) {
    const count = await generateBatch(batch);
    total += count;
    // Short pause to respect rate limits
    await new Promise(r => setTimeout(r, 1000));
  }

  const finalCount = db.prepare('SELECT COUNT(*) as n FROM pflanzen').get().n;
  console.log(`\n=== Fertig: ${total} neue Eintraege, ${finalCount} gesamt ===`);

  // Save to JSON for version control
  const allPflanzen = db.prepare('SELECT * FROM pflanzen ORDER BY name_botanisch').all();
  fs.writeFileSync(
    path.join(__dirname, '..', 'data', 'pflanzen-seed.json'),
    JSON.stringify(allPflanzen, null, 2)
  );
  console.log(`Gespeichert: data/pflanzen-seed.json`);

  db.close();
}

main().catch(console.error);
