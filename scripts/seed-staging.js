// Staging-Seed: Gräser, Zwiebeln, Farne + 300 neue Stauden
// Alle Einträge erhalten status='staging' — bleiben aus Planung + öffentl. Suche ausgeblendet.
// Ausführen: node scripts/seed-staging.js
// Optionen:  --dry-run  --limit=20  --kategorie=Zwiebeln
//
// Danach Bilder laden:  node scripts/fetch-plant-images.js
// Enrich:               node scripts/enrich-plant-pages.js  (oder Staging-Variante)
// Freischalten:         UPDATE pflanzen SET status='live' WHERE status='staging';

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const Database = require('better-sqlite3');
const { OpenAI } = require('openai');
const path = require('path');

const args       = process.argv.slice(2);
const DRY_RUN    = args.includes('--dry-run');
const LIMIT      = (() => { const l = args.find(a => a.startsWith('--limit=')); return l ? parseInt(l.split('=')[1]) : null; })();
const KAT_FILTER = (() => { const k = args.find(a => a.startsWith('--kategorie=')); return k ? k.split('=')[1] : null; })();

const db     = new Database(path.join(__dirname, '..', 'stauden.db'));
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Status-Spalte anlegen falls noch nicht vorhanden
try { db.exec(`ALTER TABLE pflanzen ADD COLUMN status TEXT DEFAULT 'live'`); } catch {}

const INSERT = db.prepare(`
  INSERT OR IGNORE INTO pflanzen
    (name_deutsch, name_botanisch, beschreibung, licht, boden, stil,
     bluehzeit, farbe, hoehe_cm_min, hoehe_cm_max, pflege_sterne,
     preis_stueck_eur, winterhart_zone, bienen_freundlich, heimisch,
     feuchtigkeit, wuchs, inhalt_lang,
     lebensbereich, breite_cm_max, rolle_empfehlung,
     kombinationspartner, winteraspekt, trockenheitstoleranz, status)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
`);

// ─────────────────────────────────────────────────────────────────────────────
//  P F L A N Z E N L I S T E
// ─────────────────────────────────────────────────────────────────────────────
const PFLANZEN = [

  // ── GRÄSER (neue Sorten) ─────────────────────────────────────────────────
  { de: 'Goldenes Flattergras',          bot: 'Milium effusum Aureum',               kat: 'Gräser' },
  { de: 'Großes Waldhainsimse',          bot: 'Luzula sylvatica',                    kat: 'Gräser' },
  { de: 'Silberhainsimse',               bot: 'Luzula nivea',                        kat: 'Gräser' },
  { de: 'Hänge-Segge',                   bot: 'Carex pendula',                       kat: 'Gräser' },
  { de: 'Gold-Segge Bowles',             bot: "Carex elata 'Aurea'",                 kat: 'Gräser' },
  { de: 'Fuchs-Segge',                   bot: 'Carex buchananii',                    kat: 'Gräser' },
  { de: 'Fähnchen-Segge',               bot: 'Carex flagellifera',                  kat: 'Gräser' },
  { de: 'Japanischer Waldfarn-Hafer',    bot: 'Hakonechloa macra',                   kat: 'Gräser' },
  { de: 'Goldgestreifter Waldfarn-Hafer',bot: "Hakonechloa macra 'Aureola'",         kat: 'Gräser' },
  { de: 'Prärie-Dropsgras',              bot: 'Sporobolus heterolepis',               kat: 'Gräser' },
  { de: 'Prärie-Bartgras',               bot: 'Andropogon gerardii',                  kat: 'Gräser' },
  { de: 'Blaues Prärie-Besenreitgras',   bot: 'Schizachyrium scoparium',             kat: 'Gräser' },
  { de: 'Nickende Sorghumhirse',         bot: 'Sorghastrum nutans',                   kat: 'Gräser' },
  { de: 'Quirlblättriges Riedgras',      bot: 'Glyceria maxima Variegata',            kat: 'Gräser' },
  { de: 'Muhlenbergia',                  bot: 'Muhlenbergia capillaris',              kat: 'Gräser' },
  { de: 'Blaues Riedgras',               bot: 'Elymus magellanicus',                  kat: 'Gräser' },
  { de: 'Ehrengras',                     bot: 'Melica altissima Atropurpurea',        kat: 'Gräser' },
  { de: 'Prärie-Mähne-Gras',             bot: 'Bouteloua gracilis',                   kat: 'Gräser' },
  { de: 'Goldband-Schilf',               bot: 'Spartina pectinata Aureomarginata',    kat: 'Gräser' },
  { de: 'Spiralbinse',                   bot: "Juncus effusus 'Spiralis'",            kat: 'Gräser' },
  { de: 'Schmalblättriges Chinaschilf',  bot: "Miscanthus sinensis 'Malepartus'",     kat: 'Gräser' },
  { de: 'Rosafedergras',                 bot: 'Melinis nerviglumis',                  kat: 'Gräser' },
  { de: 'Neuseeländer Segge',            bot: 'Carex testacea',                       kat: 'Gräser' },
  { de: 'Mähnen-Gerste',                 bot: 'Hordeum jubatum',                      kat: 'Gräser' },
  { de: 'Türkisches Federgras',          bot: 'Stipa barbata',                        kat: 'Gräser' },
  { de: 'Großes Steppenbromgras',        bot: 'Bromus inermis Skinner Gold',          kat: 'Gräser' },
  { de: 'Pfahlrohr',                     bot: 'Phragmites australis',                 kat: 'Gräser' },
  { de: 'Zwerg-Pampasgras',              bot: 'Cortaderia selloana Pumila',           kat: 'Gräser' },
  { de: 'Blaugrünes Pfeifengras',        bot: "Molinia caerulea 'Variegata'",         kat: 'Gräser' },
  { de: 'Hohes Pfeifengras Transparent', bot: "Molinia arundinacea 'Transparent'",   kat: 'Gräser' },

  // ── ZWIEBELPFLANZEN ───────────────────────────────────────────────────────
  // Tulpen
  { de: 'Schwarze Tulpe',                bot: "Tulipa 'Queen of Night'",              kat: 'Zwiebeln' },
  { de: 'Aprikosen-Tulpe',               bot: "Tulipa 'Apricot Beauty'",              kat: 'Zwiebeln' },
  { de: 'Papageientulpe Blakjak',        bot: "Tulipa 'Black Parrot'",                kat: 'Zwiebeln' },
  { de: 'Weiße Lilienblüttulpe',         bot: "Tulipa 'White Triumphator'",           kat: 'Zwiebeln' },
  { de: 'Gefranste Tulpe Huis ten Bosch',bot: "Tulipa 'Burgundy Lace'",              kat: 'Zwiebeln' },
  { de: 'Rembrandt-Tulpe Sorbet',        bot: "Tulipa 'Sorbet'",                      kat: 'Zwiebeln' },
  { de: 'Viridiflora-Tulpe',             bot: "Tulipa 'Spring Green'",                kat: 'Zwiebeln' },
  { de: 'Darwin-Hybrid-Tulpe rot',       bot: "Tulipa 'Apeldoorn'",                   kat: 'Zwiebeln' },
  { de: 'Kaufmanns-Tulpe',               bot: 'Tulipa kaufmanniana',                  kat: 'Zwiebeln' },
  { de: 'Wild-Tulpe',                    bot: 'Tulipa sylvestris',                    kat: 'Zwiebeln' },
  { de: 'Triumph-Tulpe Negrita',         bot: "Tulipa 'Negrita'",                     kat: 'Zwiebeln' },
  // Narzissen
  { de: 'Wilde Narzisse',                bot: 'Narcissus pseudonarcissus',            kat: 'Zwiebeln' },
  { de: 'Dichter-Narzisse',              bot: "Narcissus poeticus 'Recurvus'",        kat: 'Zwiebeln' },
  { de: 'Jonquillen-Narzisse',           bot: 'Narcissus jonquilla',                  kat: 'Zwiebeln' },
  { de: 'Zyklamen-Narzisse',             bot: 'Narcissus cyclamineus',                kat: 'Zwiebeln' },
  { de: 'Miniaturnarzisse Tête-à-Tête',  bot: "Narcissus 'Tete-a-Tete'",             kat: 'Zwiebeln' },
  { de: 'Weiße Tazettnarzisse',          bot: "Narcissus 'Ice Follies'",              kat: 'Zwiebeln' },
  { de: 'Doppelblütige Narzisse',        bot: "Narcissus 'Tahiti'",                   kat: 'Zwiebeln' },
  // Allium
  { de: 'Riesen-Zierlauch',              bot: 'Allium giganteum',                     kat: 'Zwiebeln' },
  { de: 'Strahlenkugel-Lauch',           bot: 'Allium schubertii',                    kat: 'Zwiebeln' },
  { de: 'Kugellauch',                    bot: 'Allium sphaerocephalon',               kat: 'Zwiebeln' },
  { de: 'Blauer Zierlauch',              bot: 'Allium caeruleum',                     kat: 'Zwiebeln' },
  { de: 'Schnittknoblauch',              bot: 'Allium tuberosum',                     kat: 'Zwiebeln' },
  { de: 'Berg-Lauch',                    bot: 'Allium oreophilum',                    kat: 'Zwiebeln' },
  { de: 'Nektarlauch',                   bot: 'Nectaroscordum siculum',               kat: 'Zwiebeln' },
  // Hyazinthen
  { de: 'Blaue Hyazinthe',               bot: "Hyacinthus orientalis 'Delft Blue'",   kat: 'Zwiebeln' },
  { de: 'Weiße Hyazinthe',               bot: "Hyacinthus orientalis 'Carnegie'",     kat: 'Zwiebeln' },
  { de: 'Rosa Hyazinthe',                bot: "Hyacinthus orientalis 'Pink Pearl'",   kat: 'Zwiebeln' },
  // Fritillaria
  { de: 'Kaiserkrone',                   bot: 'Fritillaria imperialis',               kat: 'Zwiebeln' },
  { de: 'Schachbrettblume',              bot: 'Fritillaria meleagris',                kat: 'Zwiebeln' },
  { de: 'Persische Fritillarie',         bot: 'Fritillaria persica',                  kat: 'Zwiebeln' },
  // Crocus
  { de: 'Elfen-Krokus',                  bot: 'Crocus tommasinianus',                 kat: 'Zwiebeln' },
  { de: 'Großer Frühlings-Krokus',       bot: 'Crocus vernus',                        kat: 'Zwiebeln' },
  { de: 'Goldlack-Krokus',               bot: 'Crocus chrysanthus',                   kat: 'Zwiebeln' },
  { de: 'Herbst-Krokus',                 bot: 'Crocus speciosus',                     kat: 'Zwiebeln' },
  // Weitere Frühjahrszwiebeln
  { de: 'Großes Schneeglöckchen',        bot: 'Galanthus elwesii',                    kat: 'Zwiebeln' },
  { de: 'Märzenbecher',                  bot: 'Leucojum aestivum',                    kat: 'Zwiebeln' },
  { de: 'Frühlings-Märzenbecher',        bot: 'Leucojum vernum',                      kat: 'Zwiebeln' },
  { de: 'Blaustern Luciliae',            bot: 'Chionodoxa luciliae',                  kat: 'Zwiebeln' },
  { de: 'Streifenblümchen',              bot: 'Puschkinia scilloides',                kat: 'Zwiebeln' },
  { de: 'Sternhyazinthe',                bot: 'Ipheion uniflorum',                    kat: 'Zwiebeln' },
  { de: 'Pracht-Herbstzeitlose',         bot: 'Colchicum speciosum',                  kat: 'Zwiebeln' },
  { de: 'Gefüllte Herbstzeitlose',       bot: "Colchicum 'Waterlily'",                kat: 'Zwiebeln' },
  { de: 'Spanische Hasenglöckchen',      bot: 'Hyacinthoides hispanica',              kat: 'Zwiebeln' },
  { de: 'Atlantisches Hasenglöckchen',   bot: 'Hyacinthoides non-scripta',            kat: 'Zwiebeln' },
  // Lilium (echte Lilien-Zwiebeln)
  { de: 'Sternlilie',                    bot: 'Lilium candidum',                      kat: 'Zwiebeln' },
  { de: 'Tigerlilie',                    bot: 'Lilium lancifolium',                   kat: 'Zwiebeln' },
  { de: 'Goldlilie',                     bot: 'Lilium auratum',                       kat: 'Zwiebeln' },
  { de: 'Sterngläubige Lilie',           bot: "Lilium 'Stargazer'",                   kat: 'Zwiebeln' },
  { de: 'Asiatische Hybridlilie',        bot: "Lilium 'Monte Negro'",                 kat: 'Zwiebeln' },
  // Crocosmia
  { de: 'Montbretie Lucifer',            bot: "Crocosmia 'Lucifer'",                  kat: 'Zwiebeln' },
  { de: 'Garten-Montbretie',             bot: 'Crocosmia x crocosmiiflora',           kat: 'Zwiebeln' },

  // ── FARNE ────────────────────────────────────────────────────────────────
  { de: 'Gewöhnlicher Wurmfarn',         bot: 'Dryopteris filix-mas',                 kat: 'Farne' },
  { de: 'Breiter Wurmfarn',              bot: 'Dryopteris dilatata',                  kat: 'Farne' },
  { de: 'Dorniger Wurmfarn',             bot: 'Dryopteris carthusiana',               kat: 'Farne' },
  { de: 'Wallichers Wurmfarn',           bot: 'Dryopteris wallichiana',               kat: 'Farne' },
  { de: 'Frauenfarn',                    bot: 'Athyrium filix-femina',                kat: 'Farne' },
  { de: 'Weicher Schildfarn',            bot: 'Polystichum setiferum',                kat: 'Farne' },
  { de: 'Mehrstieliger Schildfarn',      bot: 'Polystichum munitum',                  kat: 'Farne' },
  { de: 'Sumpffarn',                     bot: 'Thelypteris palustris',                kat: 'Farne' },
  { de: 'Hirschzungenfarn',              bot: 'Asplenium scolopendrium',              kat: 'Farne' },
  { de: 'Braunstieliger Streifenfarn',   bot: 'Asplenium trichomanes',                kat: 'Farne' },
  { de: 'Eichenfarn',                    bot: 'Gymnocarpium dryopteris',              kat: 'Farne' },
  { de: 'Blasenfarn',                    bot: 'Cystopteris fragilis',                 kat: 'Farne' },
  { de: 'Rippenfarn',                    bot: 'Blechnum spicant',                     kat: 'Farne' },
  { de: 'Buchenfarn',                    bot: 'Phegopteris connectilis',              kat: 'Farne' },
  { de: 'Zimtfarn',                      bot: 'Osmundastrum cinnamomeum',             kat: 'Farne' },
  { de: 'Virginischer Kettenfarn',       bot: 'Woodwardia virginica',                 kat: 'Farne' },
  { de: 'Schild-Dryopteris',             bot: 'Dryopteris expansa',                   kat: 'Farne' },

  // ── STAUDEN: SONNE / HALSCHATTEN (neue Arten) ────────────────────────────
  // Anemone
  { de: 'Herbst-Anemone Honorine Jobert',bot: "Anemone x hybrida 'Honorine Jobert'", kat: 'Sonne' },
  { de: 'Herbst-Anemone Pamina',         bot: "Anemone hupehensis 'Pamina'",          kat: 'Sonne' },
  { de: 'Japanische Anemone',            bot: "Anemone hupehensis var. japonica",     kat: 'Sonne' },
  // Aster / Symphyotrichum
  { de: 'Glattblatt-Herbstaster',        bot: "Symphyotrichum laeve 'Bluebird'",      kat: 'Sonne' },
  { de: 'Samtstieliger Herbstaster',     bot: "Symphyotrichum pringlei 'Monte Cassino'", kat: 'Sonne' },
  { de: 'Eurasischer Bergaster',         bot: 'Aster amellus',                        kat: 'Sonne' },
  { de: 'Kissenaster Herbst',            bot: "Aster x dumosus 'Herbstgruss'",        kat: 'Sonne' },
  { de: 'Goldaster',                     bot: 'Solidago rugosa Fireworks',            kat: 'Sonne' },
  { de: 'Kürze Goldrute',                bot: 'Solidago caesia',                      kat: 'Sonne' },
  // Helenium
  { de: 'Sonnenbraut Moerheim Beauty',   bot: "Helenium 'Moerheim Beauty'",           kat: 'Sonne' },
  { de: 'Sonnenbraut Sahin Early Flowerer', bot: "Helenium 'Sahin Early Flowerer'",  kat: 'Sonne' },
  { de: 'Sonnenbraut Waldtraut',         bot: "Helenium 'Waldtraut'",                 kat: 'Sonne' },
  { de: 'Sonnenbraut Rubinzwerg',        bot: "Helenium 'Rubinzwerg'",                kat: 'Sonne' },
  // Heliopsis
  { de: 'Raue Sonnenauge',               bot: 'Heliopsis helianthoides',              kat: 'Sonne' },
  { de: 'Goldgrünauge Spitzweg',         bot: "Heliopsis helianthoides 'Spitzweg'",   kat: 'Sonne' },
  // Phlox
  { de: 'Sommer-Phlox Nicky',            bot: "Phlox paniculata 'Nicky'",             kat: 'Sonne' },
  { de: 'Sommer-Phlox David',            bot: "Phlox paniculata 'David'",             kat: 'Sonne' },
  { de: 'Sommer-Phlox Sternhimmel',      bot: "Phlox paniculata 'Sternhimmel'",       kat: 'Sonne' },
  { de: 'Rispen-Phlox',                  bot: 'Phlox maculata',                       kat: 'Sonne' },
  { de: 'Wald-Phlox',                    bot: 'Phlox divaricata',                     kat: 'Halbschatten' },
  // Monarda
  { de: 'Indianernessel Marshalls Delight', bot: "Monarda 'Marshall Delight'",        kat: 'Sonne' },
  { de: 'Indianernessel Jacob Cline',    bot: "Monarda 'Jacob Cline'",                kat: 'Sonne' },
  { de: 'Indianernessel Squaw',          bot: "Monarda 'Squaw'",                      kat: 'Sonne' },
  // Verbena
  { de: 'Patagonisches Eisenkraut',      bot: 'Verbena bonariensis',                  kat: 'Sonne' },
  // Gaura / Oenothera
  { de: 'Präriekerze Whirling Butterflies', bot: "Oenothera lindheimeri 'Whirling Butterflies'", kat: 'Sonne' },
  { de: 'Nachtkerze Camel',              bot: "Oenothera glazioviana",                kat: 'Sonne' },
  { de: 'Spitzen-Nachtkerze',            bot: 'Oenothera speciosa',                   kat: 'Sonne' },
  // Lobelia
  { de: 'Kardinalslobelie',              bot: 'Lobelia cardinalis',                   kat: 'Sonne' },
  { de: 'Staudige Lobelie',              bot: "Lobelia x speciosa 'Vedrariensis'",    kat: 'Sonne' },
  // Chelone
  { de: 'Schlangenkopf',                 bot: 'Chelone obliqua',                      kat: 'Sonne' },
  // Physostegia
  { de: 'Gelenkblume Vivid',             bot: "Physostegia virginiana 'Vivid'",       kat: 'Sonne' },
  { de: 'Weiße Gelenkblume',             bot: "Physostegia virginiana 'Summer Snow'", kat: 'Sonne' },
  // Persicaria
  { de: 'Kerzen-Knöterich',              bot: 'Persicaria amplexicaulis',             kat: 'Sonne' },
  { de: 'Alba-Kerzenknöterich',          bot: "Persicaria amplexicaulis 'Alba'",      kat: 'Sonne' },
  { de: 'Nadelkerzen-Knöterich',         bot: "Persicaria amplexicaulis 'Firetail'",  kat: 'Sonne' },
  // Veronicastrum / Veronica
  { de: 'Weißer Ehrenpreis-Kandelaber',  bot: "Veronicastrum virginicum 'Album'",     kat: 'Sonne' },
  { de: 'Lavendel-Ehrenpreis-Kandelaber',bot: "Veronicastrum virginicum 'Lavender Tower'", kat: 'Sonne' },
  { de: 'Langen-Blauer-Ehrenpreis',      bot: 'Veronica longifolia',                  kat: 'Sonne' },
  { de: 'Ähren-Ehrenpreis',              bot: 'Veronica spicata',                     kat: 'Sonne' },
  // Penstemon
  { de: 'Bartwurz Dark Towers',          bot: "Penstemon digitalis 'Dark Towers'",    kat: 'Sonne' },
  { de: 'Schokoladen-Bartfaden',         bot: "Penstemon digitalis 'Husker Red'",     kat: 'Sonne' },
  { de: 'Mexikanischer Bartfaden',       bot: 'Penstemon campanulatus',               kat: 'Sonne' },
  // Baptisia
  { de: 'Blauer Falscher Indigo',        bot: 'Baptisia australis',                   kat: 'Sonne' },
  { de: 'Weißer Falscher Indigo',        bot: 'Baptisia alba',                        kat: 'Sonne' },
  { de: 'Gelber Falscher Indigo',        bot: 'Baptisia sphaerocarpa',                kat: 'Sonne' },
  // Gaillardia
  { de: 'Kokardenblume Burgundy',        bot: "Gaillardia x grandiflora 'Burgundy'",  kat: 'Sonne' },
  { de: 'Kokardenblume Fackelschein',    bot: "Gaillardia x grandiflora 'Fackelschein'", kat: 'Sonne' },
  // Coreopsis
  { de: 'Großes Mädchenauge',            bot: 'Coreopsis grandiflora',                kat: 'Sonne' },
  { de: 'Rosafarbenes Mädchenauge',      bot: "Coreopsis rosea 'American Dream'",     kat: 'Sonne' },
  // Silphium
  { de: 'Durchwachsene Becherpflanze',   bot: 'Silphium perfoliatum',                 kat: 'Sonne' },
  { de: 'Kompass-Pflanze',               bot: 'Silphium laciniatum',                  kat: 'Sonne' },
  // Asclepias
  { de: 'Orangefarbene Seidenpflanze',   bot: 'Asclepias tuberosa',                   kat: 'Sonne' },
  { de: 'Rosa Seidenpflanze',            bot: 'Asclepias incarnata',                  kat: 'Sonne' },
  // Boltonia
  { de: 'Herbst-Schneeball',             bot: "Boltonia asteroides 'Snowbank'",       kat: 'Sonne' },
  // Liatris
  { de: 'Dichte Prachtscharte',          bot: 'Liatris pycnostachya',                 kat: 'Sonne' },
  { de: 'Schroffe Prachtscharte',        bot: 'Liatris aspera',                       kat: 'Sonne' },
  // Tradescantia
  { de: 'Ohio-Dreimasterblume',          bot: 'Tradescantia ohiensis',                kat: 'Sonne' },
  { de: 'Blaue Dreimasterblume',         bot: "Tradescantia x andersoniana 'Zwanenburg Blue'", kat: 'Sonne' },
  // Sisyrinchium
  { de: 'Blauäugiges Gras',              bot: 'Sisyrinchium angustifolium',            kat: 'Sonne' },
  // Agastache (mehr Sorten)
  { de: 'Duftnessel Blue Fortune',       bot: "Agastache 'Blue Fortune'",             kat: 'Sonne' },
  { de: 'Aprikosen-Duftnessel',          bot: "Agastache 'Apricot Sunrise'",          kat: 'Sonne' },
  { de: 'Rose-Duftnessel',               bot: "Agastache 'Rosie Posie'",              kat: 'Sonne' },
  // Sanguisorba
  { de: 'Kleiner Wiesenknopf',           bot: 'Sanguisorba minor',                    kat: 'Sonne' },
  { de: 'Kanadischer Wiesenknopf',       bot: 'Sanguisorba canadensis',               kat: 'Sonne' },
  // Knautia
  { de: 'Wiesen-Witwenblume',            bot: 'Knautia arvensis',                     kat: 'Sonne' },
  // Scabiosa
  { de: 'Tauben-Skabiose',               bot: 'Scabiosa columbaria',                  kat: 'Sonne' },
  { de: 'Hellblaue Skabiose',            bot: "Scabiosa caucasica 'Miss Willmott'",   kat: 'Sonne' },
  // Prunella
  { de: 'Großblütige Brunelle',          bot: 'Prunella grandiflora',                 kat: 'Sonne' },
  // Stachys
  { de: 'Wollziest',                     bot: 'Stachys byzantina',                    kat: 'Sonne' },
  { de: 'Heilziest',                     bot: 'Stachys officinalis',                  kat: 'Sonne' },
  // Oreganum (ornamental)
  { de: 'Zierdost',                      bot: 'Origanum laevigatum Herrenhausen',     kat: 'Sonne' },
  { de: 'Goldmarjoran',                  bot: "Origanum vulgare 'Aureum'",            kat: 'Sonne' },
  // Marrubium
  { de: 'Silber-Andorn',                 bot: 'Marrubium incanum',                    kat: 'Sonne' },
  // Teucrium
  { de: 'Edel-Gamander',                 bot: 'Teucrium chamaedrys',                  kat: 'Sonne' },
  { de: 'Katzen-Gamander',               bot: 'Teucrium pyrenaicum',                  kat: 'Sonne' },
  // Clinopodium
  { de: 'Wirbeldost',                    bot: 'Clinopodium nepeta',                   kat: 'Sonne' },
  // Cerinthe
  { de: 'Blauer Wachsblume',             bot: 'Cerinthe major Purpurascens',          kat: 'Sonne' },
  // Amsonia
  { de: 'Blaue Blaustern-Staude',        bot: 'Amsonia hubrichtii',                   kat: 'Sonne' },
  { de: 'Weidenblättrige Amsonie',       bot: 'Amsonia tabernaemontana',              kat: 'Sonne' },
  // Baptisia
  { de: 'Dreifarbiger Falscher Indigo',  bot: 'Baptisia 'Twilite Prairieblues'',      kat: 'Sonne' },
  // Verbascum
  { de: 'Olympische Königskerze',        bot: 'Verbascum olympicum',                  kat: 'Sonne' },
  { de: 'Hybride Königskerze Chaixii',   bot: 'Verbascum chaixii Album',              kat: 'Sonne' },
  // Linaria
  { de: 'Purpur-Leinkraut',              bot: 'Linaria purpurea',                     kat: 'Sonne' },
  { de: 'Alpen-Leinkraut',               bot: 'Linaria alpina',                       kat: 'Sonne' },
  // Buphthalmum
  { de: 'Ochsenauge',                    bot: 'Buphthalmum salicifolium',             kat: 'Sonne' },
  // Telekia
  { de: 'Telekie',                       bot: 'Telekia speciosa',                     kat: 'Sonne' },
  // Inula
  { de: 'Riesen-Alant',                  bot: 'Inula magnifica',                      kat: 'Sonne' },
  { de: 'Schwert-Alant',                 bot: 'Inula ensifolia',                      kat: 'Sonne' },
  // Doronicum
  { de: 'Kaukasus-Gämswurz',             bot: 'Doronicum caucasicum',                 kat: 'Sonne' },
  // Leucanthemum
  { de: 'Großblütige Margerite',         bot: "Leucanthemum x superbum 'Wirral Supreme'", kat: 'Sonne' },
  { de: 'Herbst-Margerite',              bot: 'Leucanthemella serotina',              kat: 'Sonne' },
  // Tanacetum
  { de: 'Pyrethrum-Margerite',           bot: 'Tanacetum coccineum',                  kat: 'Sonne' },
  { de: 'Silbrige Chrysantheme',         bot: 'Tanacetum argenteum',                  kat: 'Sonne' },
  // Centaurea
  { de: 'Blaue Flockenblume',            bot: 'Centaurea montana',                    kat: 'Sonne' },
  { de: 'Riesen-Flockenblume',           bot: 'Centaurea macrocephala',               kat: 'Sonne' },
  // Linum
  { de: 'Stauden-Lein',                  bot: 'Linum perenne',                        kat: 'Sonne' },
  { de: 'Gelber Lein',                   bot: 'Linum flavum',                         kat: 'Sonne' },
  // Gypsophila
  { de: 'Schleierkraut Staude',          bot: 'Gypsophila paniculata',                kat: 'Sonne' },
  { de: 'Kriechendes Schleierkraut',     bot: 'Gypsophila repens',                    kat: 'Sonne' },
  // Saponaria
  { de: 'Seifenkraut',                   bot: 'Saponaria officinalis',                kat: 'Sonne' },
  // Dianthus
  { de: 'Bartnelke',                     bot: 'Dianthus barbatus',                    kat: 'Sonne' },
  { de: 'Kartäusernelke',                bot: 'Dianthus carthusianorum',              kat: 'Sonne' },
  { de: 'Pracht-Nelke',                  bot: 'Dianthus superbus',                    kat: 'Sonne' },
  // Lychnis
  { de: 'Lichtnelke Silene',             bot: 'Lychnis coronaria',                    kat: 'Sonne' },
  { de: 'Prachtnelke Flos-Cuculi',       bot: 'Lychnis flos-cuculi',                  kat: 'Sonne' },
  // Cerastium
  { de: 'Hornkraut',                     bot: 'Cerastium tomentosum',                 kat: 'Sonne' },
  // Euphorbia
  { de: 'Tautropfen-Wolfsmilch',         bot: 'Euphorbia corollata',                  kat: 'Sonne' },
  { de: 'Dünen-Wolfsmilch',              bot: 'Euphorbia seguieriana',                kat: 'Sonne' },
  // Eryngium
  { de: 'Blaue Distel Planum',           bot: 'Eryngium planum',                      kat: 'Sonne' },
  { de: 'Zwerg-Mannstreu',               bot: 'Eryngium alpinum',                     kat: 'Sonne' },
  // Ferula
  { de: 'Riesenfenchel',                 bot: 'Ferula communis',                      kat: 'Sonne' },
  // Foeniculum
  { de: 'Bronzefenchel',                 bot: 'Foeniculum vulgare Purpureum',         kat: 'Sonne' },
  // Selinum
  { de: 'Bergmilchblatt',                bot: 'Selinum wallichianum',                 kat: 'Sonne' },
  // Trollius
  { de: 'Europäische Trollblume',        bot: 'Trollius europaeus',                   kat: 'Feucht' },
  { de: 'Trollblume Goldquelle',         bot: "Trollius x cultorum 'Goldquelle'",     kat: 'Feucht' },
  // Primula
  { de: 'Japanische Etagen-Primel',      bot: 'Primula japonica',                     kat: 'Feucht' },
  { de: 'Kerzen-Primel',                 bot: 'Primula bulleyana',                    kat: 'Feucht' },
  { de: 'Kugel-Primel',                  bot: 'Primula denticulata',                  kat: 'Feucht' },
  { de: 'Tibetische Primel',             bot: 'Primula florindae',                    kat: 'Feucht' },
  // Caltha
  { de: 'Sumpfdotterblume',              bot: 'Caltha palustris',                     kat: 'Feucht' },
  // Iris
  { de: 'Sumpf-Schwertlilie',            bot: 'Iris pseudacorus',                     kat: 'Feucht' },
  { de: 'Japanische Schwertlilie',       bot: 'Iris ensata',                          kat: 'Feucht' },
  { de: 'Sibirische Schwertlilie',       bot: 'Iris sibirica',                        kat: 'Feucht' },
  // Ligularia
  { de: 'Ligularia The Rocket',          bot: "Ligularia stenocephala 'The Rocket'",  kat: 'Feucht' },
  { de: 'Przewalski-Ligularie',          bot: 'Ligularia przewalskii',                kat: 'Feucht' },
  // Filipendula
  { de: 'Wiesen-Mädesüß',               bot: 'Filipendula ulmaria',                  kat: 'Feucht' },
  { de: 'Rotes Mädesüß',                bot: 'Filipendula rubra',                    kat: 'Feucht' },
  // Lythrum
  { de: 'Ruten-Blutweiderich',           bot: 'Lythrum virgatum',                     kat: 'Feucht' },
  // Darmera
  { de: 'Schirmblatt',                   bot: 'Darmera peltata',                      kat: 'Feucht' },
  // Gunnera
  { de: 'Mammut-Schaublatt',             bot: 'Gunnera manicata',                     kat: 'Feucht' },
  // Petasites
  { de: 'Japanischer Pestwurz',          bot: 'Petasites japonicus',                  kat: 'Feucht' },

  // ── STAUDEN: SCHATTEN / HALBSCHATTEN ─────────────────────────────────────
  { de: 'Japanische Funkie Halcyon',     bot: "Hosta 'Halcyon'",                      kat: 'Schatten' },
  { de: 'Riesenblatt-Funkie',            bot: "Hosta 'Empress Wu'",                   kat: 'Schatten' },
  { de: 'Goldrand-Funkie',               bot: "Hosta 'Wide Brim'",                    kat: 'Schatten' },
  { de: 'Funkie June',                   bot: "Hosta 'June'",                         kat: 'Schatten' },
  { de: 'Tiarella',                      bot: 'Tiarella cordifolia',                  kat: 'Schatten' },
  { de: 'Schaumblüte Pink Skyrocket',    bot: "Tiarella 'Pink Skyrocket'",            kat: 'Schatten' },
  { de: 'Heucherella Tapestry',          bot: "x Heucherella 'Tapestry'",             kat: 'Schatten' },
  { de: 'Heucherella Solar Eclipse',     bot: "x Heucherella 'Solar Eclipse'",        kat: 'Schatten' },
  { de: 'Heuchera Obsidian',             bot: "Heuchera 'Obsidian'",                  kat: 'Schatten' },
  { de: 'Heuchera Fire Alarm',           bot: "Heuchera 'Fire Alarm'",                kat: 'Schatten' },
  { de: 'Maiglöckchen',                  bot: 'Convallaria majalis',                  kat: 'Schatten' },
  { de: 'Goldrand-Maiglöckchen',         bot: "Convallaria majalis 'Hardwick Hall'",  kat: 'Schatten' },
  { de: 'Trillium Recurvatum',           bot: 'Trillium recurvatum',                  kat: 'Schatten' },
  { de: 'Rotes Waldlicht',               bot: 'Actaea rubra',                         kat: 'Schatten' },
  { de: 'Purpur-Silberkerze',            bot: "Actaea simplex 'Brunette'",            kat: 'Schatten' },
  { de: 'Gefleckter Aronstab',           bot: 'Arum maculatum',                       kat: 'Schatten' },
  { de: 'Exotischer Aronstab',           bot: 'Arum italicum Marmoratum',             kat: 'Schatten' },
  { de: 'Märzveilchen',                  bot: 'Viola odorata',                        kat: 'Schatten' },
  { de: 'Wildes Veilchen',               bot: 'Viola riviniana',                      kat: 'Schatten' },
  { de: 'Buntblatt-Lungenkraut',         bot: "Pulmonaria 'Opal'",                    kat: 'Schatten' },
  { de: 'Blaupunkt-Lungenkraut',         bot: "Pulmonaria 'Blue Ensign'",             kat: 'Schatten' },
  { de: 'Weiße Bergenie',                bot: "Bergenia 'Silberlicht'",               kat: 'Schatten' },
  { de: 'Rosa Bergenie Purpurea',        bot: "Bergenia 'Purpurea'",                  kat: 'Schatten' },
  { de: 'Korallen-Bergenie',             bot: "Bergenia 'Bressingham Ruby'",          kat: 'Schatten' },
  { de: 'Elfenblume Amber Queen',        bot: "Epimedium x versicolor 'Amber Queen'", kat: 'Schatten' },
  { de: 'Rote Elfenblume',               bot: "Epimedium x warleyense 'Ellen Willmott'", kat: 'Schatten' },
  { de: 'Orangefarbene Elfenblume',      bot: "Epimedium x warleyense 'Orange Queen'", kat: 'Schatten' },
  { de: 'Großblütige Elfenblume',        bot: 'Epimedium grandiflorum',               kat: 'Schatten' },
  { de: 'Brunnera Variegata',            bot: "Brunnera macrophylla 'Variegata'",     kat: 'Schatten' },
  { de: 'Kaukasus-Vergissmeinnicht',     bot: 'Brunnera macrophylla',                 kat: 'Schatten' },
  { de: 'Wachs-Glöckchen',              bot: 'Kirengeshoma palmata',                 kat: 'Schatten' },
  { de: 'Japanisches Schirmblatt',       bot: 'Diphylleia grayi',                     kat: 'Schatten' },
  { de: 'Schaublatt Aesculifolia',       bot: 'Rodgersia aesculifolia',               kat: 'Schatten' },
  { de: 'Geißbart Zwerg',                bot: 'Aruncus aethusifolius',                kat: 'Schatten' },
  { de: 'Waldkorbblüte',                 bot: 'Cimicifuga ramosa',                    kat: 'Schatten' },
  { de: 'Korallen-Waldkorbblüte',        bot: "Actaea simplex 'Pink Spike'",          kat: 'Schatten' },
  { de: 'Wald-Hahnenfuß',               bot: 'Ranunculus aconitifolius',             kat: 'Schatten' },
  { de: 'Gefüllter Hahnenfuß',           bot: "Ranunculus aconitifolius 'Flore Pleno'", kat: 'Schatten' },
  { de: 'Blaue Hasenglöckchen',          bot: 'Hyacinthoides non-scripta',            kat: 'Schatten' },
  // Pachysandra
  { de: 'Japanisches Scheinmyrte',       bot: 'Pachysandra terminalis',               kat: 'Schatten' },
  { de: 'Buntblatt-Pachysandra',         bot: "Pachysandra terminalis 'Variegata'",   kat: 'Schatten' },
  // Lamium
  { de: 'Goldnessel Beacon Silver',      bot: "Lamium maculatum 'Beacon Silver'",     kat: 'Schatten' },
  { de: 'Goldnessel White Nancy',        bot: "Lamium maculatum 'White Nancy'",       kat: 'Schatten' },
  { de: 'Gelbblütige Goldnessel',        bot: 'Lamium galeobdolon',                   kat: 'Schatten' },
  // Corydalis
  { de: 'Blauer Lerchensporn',           bot: 'Corydalis flexuosa',                   kat: 'Schatten' },
  { de: 'Gelber Lerchensporn',           bot: 'Corydalis lutea',                      kat: 'Schatten' },
  { de: 'Weißer Lerchensporn',           bot: 'Corydalis ochroleuca',                 kat: 'Schatten' },
  { de: 'Hohler Lerchensporn',           bot: 'Corydalis cava',                       kat: 'Schatten' },
  // Saxifraga
  { de: 'Trauben-Steinbrech',            bot: "Saxifraga x arendsii",                 kat: 'Schatten' },
  { de: 'Schaumblüten-Steinbrech',       bot: 'Saxifraga cortusifolia',               kat: 'Schatten' },
  // Dicentra
  { de: 'Wald-Tränendes-Herz Gold',      bot: "Dicentra formosa 'Aurora'",            kat: 'Schatten' },

  // ── MEDITERRAN & STEINGARTEN ──────────────────────────────────────────────
  { de: 'Wiesenweide Santolina',         bot: 'Santolina chamaecyparissus',           kat: 'Mediterran' },
  { de: 'Grüne Heiligenkraut',           bot: 'Santolina rosmarinifolia',             kat: 'Mediterran' },
  { de: 'Weinraute',                     bot: 'Ruta graveolens',                      kat: 'Mediterran' },
  { de: 'Akanthus Mollis',               bot: 'Acanthus mollis',                      kat: 'Mediterran' },
  { de: 'Stacheliger Bärenklau',         bot: 'Acanthus spinosus',                    kat: 'Mediterran' },
  { de: 'Eberraute',                     bot: 'Artemisia abrotanum',                  kat: 'Mediterran' },
  { de: 'Silber-Wermut',                 bot: "Artemisia 'Powis Castle'",             kat: 'Mediterran' },
  { de: 'Artemisia Ludoviciana',         bot: "Artemisia ludoviciana 'Valerie Finnis'", kat: 'Mediterran' },
  { de: 'Ziströschen',                   bot: 'Cistus x hybridus',                    kat: 'Mediterran' },
  { de: 'Strandflieder Violett',         bot: "Limonium platyphyllum 'Violetta'",     kat: 'Mediterran' },
  { de: 'Ballote',                       bot: 'Ballota pseudodictamnus',              kat: 'Mediterran' },
  { de: 'Graues Ziströschen',            bot: 'Cistus albidus',                       kat: 'Mediterran' },
  { de: 'Silbersalbei',                  bot: 'Salvia argentea',                      kat: 'Mediterran' },
  { de: 'Ysop',                          bot: 'Hyssopus officinalis',                 kat: 'Mediterran' },
  { de: 'Rosa Ysop',                     bot: "Hyssopus officinalis 'Roseus'",        kat: 'Mediterran' },
  { de: 'Moltkia',                       bot: 'Moltkia petraea',                      kat: 'Mediterran' },
  { de: 'Arabis Caucasica',              bot: 'Arabis caucasica',                     kat: 'Mediterran' },
  { de: 'Weiße Schleifenblume',          bot: 'Iberis sempervirens',                  kat: 'Mediterran' },
  { de: 'Immergrüne Candytuft',          bot: "Iberis sempervirens 'Snowflake'",      kat: 'Mediterran' },
  { de: 'Kaukasischer Vergissmeinnicht-Steinbrech', bot: 'Omphalodes cappadocica',    kat: 'Mediterran' },
  { de: 'Blauer Kreuzenzian',            bot: 'Gentiana cruciata',                    kat: 'Mediterran' },
  { de: 'Herbst-Enzian',                 bot: 'Gentiana sino-ornata',                 kat: 'Mediterran' },

  // ── BODENDECKER ──────────────────────────────────────────────────────────
  { de: 'Immergrün Vinca minor',         bot: 'Vinca minor',                          kat: 'Bodendecker' },
  { de: 'Weißblühendes Immergrün',       bot: "Vinca minor 'Alba'",                   kat: 'Bodendecker' },
  { de: 'Großes Immergrün',              bot: 'Vinca major',                          kat: 'Bodendecker' },
  { de: 'Waldsteinie',                   bot: 'Waldsteinia geoides',                  kat: 'Bodendecker' },
  { de: 'Dreizählige Waldsteinie',       bot: 'Waldsteinia ternata',                  kat: 'Bodendecker' },
  { de: 'Teppich-Phlox Mc Daniel',       bot: "Phlox subulata 'Mc Daniel Cushion'",   kat: 'Bodendecker' },
  { de: 'Teppich-Phlox Candy Stripe',    bot: "Phlox subulata 'Candy Stripe'",        kat: 'Bodendecker' },
  { de: 'Weiße Teppich-Phlox',           bot: "Phlox subulata 'White Delight'",       kat: 'Bodendecker' },
  { de: 'Blaukissen',                    bot: 'Aubrieta x cultorum',                  kat: 'Bodendecker' },
  { de: 'Schleifenblume Zwerg',          bot: "Iberis saxatilis",                     kat: 'Bodendecker' },
  { de: 'Sedum Dragon Blood',            bot: "Sedum spurium 'Dragon Blood'",         kat: 'Bodendecker' },
  { de: 'Zwerg-Fetthenne',               bot: 'Sedum album',                          kat: 'Bodendecker' },
  { de: 'Mauerpepper',                   bot: 'Sedum acre',                           kat: 'Bodendecker' },
  { de: 'Hauswurz',                      bot: 'Sempervivum tectorum',                 kat: 'Bodendecker' },
  { de: 'Spinnwebs-Hauswurz',            bot: 'Sempervivum arachnoideum',             kat: 'Bodendecker' },
  { de: 'Jovibarba',                     bot: 'Jovibarba hirta',                      kat: 'Bodendecker' },
  { de: 'Teppich-Frostaster',            bot: "Erigeron karvinskianus",               kat: 'Bodendecker' },
  { de: 'Ysop-Steinquendel',             bot: 'Acinos arvensis',                      kat: 'Bodendecker' },
  { de: 'Weißer Steinklee',              bot: 'Melilotus albus',                      kat: 'Bodendecker' },
  { de: 'Goldbeere Waldmeister',         bot: 'Galium odoratum',                      kat: 'Bodendecker' },
];

// ─────────────────────────────────────────────────────────────────────────────
//  GPT-4o: vollständige Pflanzendaten + inhalt_lang als JSON
// ─────────────────────────────────────────────────────────────────────────────
async function generatePflanze(p) {
  const isZwiebel  = p.kat === 'Zwiebeln';
  const isFarn     = p.kat === 'Farne';
  const isGras     = p.kat === 'Gräser';

  const prompt = `Du bist Staudenexperte für deutsche Gärten. Generiere vollständige Datenbankdaten für:

Pflanze: ${p.de} (${p.bot})
Kategorie: ${p.kat}
${isZwiebel ? 'Hinweis: Zwiebelpflanze — zieht im Sommer ein, herbst- oder frühjahrsblühend. Pflanzzeit im Herbst (für Frühjahrsblüher) bzw. Frühjahr.' : ''}
${isFarn    ? 'Hinweis: Farn — keine Blüten, Hauptwert durch Blattwerk und Struktur. bluehzeit leer lassen oder "—".' : ''}

Antworte NUR mit diesem JSON (kein Markdown):
{
  "beschreibung": "<2-3 Sätze, prägnant>",
  "licht": "<'Sonne', 'Halbschatten', 'Schatten', 'Sonne|Halbschatten' oder 'Halbschatten|Schatten'>",
  "boden": "<'sandig', 'normal', 'lehmig', 'humos' oder Kombinationen mit |>",
  "stil": "<max 2 Stile: Naturgarten|Bauerngarten|Cottage|Modern|Steingarten|Mediterran|Schattengarten>",
  "bluehzeit": "<z.B. 'März - April' oder 'Juli - September' — bei Farnen: ''>",
  "farbe": "<Hauptfarbe oder 'grün' bei Gräsern/Farnen>",
  "hoehe_cm_min": <Zahl>,
  "hoehe_cm_max": <Zahl>,
  "pflege_sterne": <1-3>,
  "preis_stueck_eur": <realistischer Gärtnerei-Preis>,
  "winterhart_zone": <4, 5 oder 6>,
  "bienen_freundlich": <1 oder 0>,
  "heimisch": <1 wenn in DE heimisch, sonst 0>,
  "feuchtigkeit": "<'trocken', 'normal', 'feucht' oder 'wechselfeucht'>",
  "wuchs": "<'horstig', 'ausläufer', 'selbstsäend' oder 'invasiv'>",
  "lebensbereich": "<Hansen & Stahl: 'Freifläche', 'Gehölzrand', 'Waldsaum', 'Quellflur', 'Steppenheide' — bis 2>",
  "breite_cm_max": <Zahl>,
  "rolle_empfehlung": "<'Leitstaude', 'Begleitstaude' oder 'Füllstaude'>",
  "kombinationspartner": "<3 botanische Namen passender Partner, kommagetrennt>",
  "winteraspekt": "<'Samenstand dekorativ', 'Blätter immergrün', 'Rosetten wintergrün', 'Gräser Struktur', 'unauffällig'>",
  "trockenheitstoleranz": "<'hoch', 'mittel' oder 'gering'>",
  "inhalt_lang": {
    "pflanzzeit": "<wann pflanzen, z.B. Frühjahr oder Herbst>",
    "giessen": "<1-2 Sätze Gießanleitung>",
    "duengen": "<1-2 Sätze Düngung>",
    "rueckschnitt": "<1-2 Sätze Rückschnitt>",
    "kombinationen": "<2-3 Sätze Pflanzpartnerschaften>",
    "fehler": ["<häufiger Fehler 1>", "<häufiger Fehler 2>", "<häufiger Fehler 3>"],
    "tipp": "<1 konkreter Gärtner-Tipp>",
    "pflanzabstand": "<z.B. '40–60 cm'>"
  }
}`;

  const res = await openai.chat.completions.create({
    model: 'gpt-4o',
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.25,
    response_format: { type: 'json_object' },
  });
  return JSON.parse(res.choices[0].message.content);
}

// ─────────────────────────────────────────────────────────────────────────────
//  Hauptschleife
// ─────────────────────────────────────────────────────────────────────────────
async function main() {
  const existing = new Set(
    db.prepare("SELECT name_botanisch FROM pflanzen WHERE name_deutsch != 'Test-Pflanze'")
      .all().map(r => r.name_botanisch.toLowerCase())
  );

  let ziel = PFLANZEN.filter(p => {
    if (existing.has(p.bot.toLowerCase())) return false;
    if (KAT_FILTER && p.kat !== KAT_FILTER) return false;
    return true;
  });
  if (LIMIT) ziel = ziel.slice(0, LIMIT);

  const vorher = db.prepare("SELECT COUNT(*) as n FROM pflanzen WHERE name_deutsch != 'Test-Pflanze'").get().n;
  const staging = db.prepare("SELECT COUNT(*) as n FROM pflanzen WHERE status = 'staging'").get().n;
  console.log(`\n=== Staging-Seed ${DRY_RUN ? '[DRY RUN] ' : ''}===`);
  console.log(`DB gesamt: ${vorher} | davon staging: ${staging} | neu zu generieren: ${ziel.length}\n`);

  const katStats = {};
  ziel.forEach(p => katStats[p.kat] = (katStats[p.kat] || 0) + 1);
  Object.entries(katStats).forEach(([k, n]) => console.log(`  ${k}: ${n} Pflanzen`));
  console.log();

  let ok = 0, skip = 0, err = 0;

  for (const p of ziel) {
    process.stdout.write(`  [${p.kat.padEnd(12)}] ${p.de} (${p.bot}) ... `);
    try {
      const d = await generatePflanze(p);
      const inhaltJson = typeof d.inhalt_lang === 'object'
        ? JSON.stringify(d.inhalt_lang)
        : d.inhalt_lang || null;

      if (!DRY_RUN) {
        const result = INSERT.run(
          p.de, p.bot,
          d.beschreibung || null, d.licht || null, d.boden || null, d.stil || null,
          d.bluehzeit || null, d.farbe || null,
          d.hoehe_cm_min || null, d.hoehe_cm_max || null,
          d.pflege_sterne || 2, d.preis_stueck_eur || 7.90,
          d.winterhart_zone || 5, d.bienen_freundlich || 0, d.heimisch || 0,
          d.feuchtigkeit || 'normal', d.wuchs || 'horstig',
          inhaltJson,
          d.lebensbereich || null, d.breite_cm_max || null,
          d.rolle_empfehlung || null, d.kombinationspartner || null,
          d.winteraspekt || null, d.trockenheitstoleranz || null,
          'staging'
        );
        if (result.changes === 0) { console.log('SKIP (bereits vorhanden)'); skip++; continue; }
      }
      console.log(`OK  ${d.hoehe_cm_min}-${d.hoehe_cm_max}cm | ${d.licht} | ${d.rolle_empfehlung}`);
      ok++;
    } catch (e) {
      console.log(`FEHLER: ${e.message}`);
      err++;
    }
    await new Promise(r => setTimeout(r, 250));
  }

  const nachher = db.prepare("SELECT COUNT(*) as n FROM pflanzen WHERE name_deutsch != 'Test-Pflanze'").get().n;
  const neuStaging = db.prepare("SELECT COUNT(*) as n FROM pflanzen WHERE status = 'staging'").get().n;
  console.log(`\n=== Fertig: ${ok} neu, ${skip} übersprungen, ${err} Fehler ===`);
  console.log(`DB gesamt: ${nachher} | staging: ${neuStaging}`);
  console.log(`\nNächste Schritte:`);
  console.log(`  Bilder:       node scripts/fetch-plant-images.js`);
  console.log(`  Vorschau:     https://www.staudenplan.de/vorschau/pflanzen?key=preview2026`);
  console.log(`  Freischalten: node scripts/approve-staging.js`);
  db.close();
}

main().catch(console.error);
