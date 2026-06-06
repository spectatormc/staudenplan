// Erweitert die Pflanzendatenbank von ~223 auf ~500 Einträge via GPT-4o.
// Nur fehlende Pflanzen werden generiert (Duplikat-Check per name_botanisch).
// Ausführen: node scripts/seed-pflanzen-500.js
// Optionen: --dry-run, --limit=20, --kategorie=Gräser

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const Database = require('better-sqlite3');
const { OpenAI } = require('openai');
const path = require('path');

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const LIMIT = (() => { const l = args.find(a => a.startsWith('--limit=')); return l ? parseInt(l.split('=')[1]) : null; })();
const KAT_FILTER = (() => { const k = args.find(a => a.startsWith('--kategorie=')); return k ? k.split('=')[1] : null; })();

const db = new Database(path.join(__dirname, '..', 'stauden.db'));
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const INSERT = db.prepare(`
  INSERT OR IGNORE INTO pflanzen
    (name_deutsch, name_botanisch, beschreibung, licht, boden, stil,
     bluehzeit, farbe, hoehe_cm_min, hoehe_cm_max, pflege_sterne,
     preis_stueck_eur, winterhart_zone, bienen_freundlich, heimisch,
     feuchtigkeit, wuchs, inhalt_lang,
     lebensbereich, breite_cm_max, rolle_empfehlung,
     kombinationspartner, winteraspekt, trockenheitstoleranz)
  VALUES
    (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
`);

// ── Pflanzenliste: ~280 fehlende Arten ────────────────────────────────────────
const PFLANZEN = [
  // GRÄSER — die größte Lücke
  { de: 'Karl-Foerster-Gras',        bot: 'Calamagrostis x acutiflora',           kat: 'Gräser' },
  { de: 'Chinaschilf',               bot: 'Miscanthus sinensis',                   kat: 'Gräser' },
  { de: 'Schmal-Chinaschilf',        bot: "Miscanthus sinensis 'Gracillimus'",     kat: 'Gräser' },
  { de: 'Silber-Chinaschilf',        bot: "Miscanthus sinensis 'Silberfeder'",     kat: 'Gräser' },
  { de: 'Zebra-Chinaschilf',         bot: "Miscanthus sinensis 'Zebrinus'",        kat: 'Gräser' },
  { de: 'Riesen-Chinaschilf',        bot: 'Miscanthus floridulus',                 kat: 'Gräser' },
  { de: 'Lampenputzergras',          bot: 'Pennisetum alopecuroides',              kat: 'Gräser' },
  { de: 'Orient-Federborstengras',   bot: 'Pennisetum orientale',                  kat: 'Gräser' },
  { de: 'Roter Lampenputzer',        bot: "Pennisetum setaceum 'Rubrum'",          kat: 'Gräser' },
  { de: 'Hohes Pfeifengras',         bot: 'Molinia arundinacea',                   kat: 'Gräser' },
  { de: 'Kleines Pfeifengras',       bot: 'Molinia caerulea',                      kat: 'Gräser' },
  { de: 'Rutenhirse',                bot: 'Panicum virgatum',                      kat: 'Gräser' },
  { de: 'Rote Rutenhirse',           bot: "Panicum virgatum 'Shenandoah'",         kat: 'Gräser' },
  { de: 'Rasenschmiele',             bot: 'Deschampsia cespitosa',                 kat: 'Gräser' },
  { de: 'Drahtschmiele',             bot: 'Deschampsia flexuosa',                  kat: 'Gräser' },
  { de: 'Herbst-Blaugras',           bot: 'Sesleria autumnalis',                   kat: 'Gräser' },
  { de: 'Frühlings-Blaugras',        bot: 'Sesleria caerulea',                     kat: 'Gräser' },
  { de: 'Zittergras',                bot: 'Briza media',                           kat: 'Gräser' },
  { de: 'Blaustrahlhafer',           bot: 'Helictotrichon sempervirens',           kat: 'Gräser' },
  { de: 'Zartes Federgras',          bot: 'Nassella tenuissima',                   kat: 'Gräser' },
  { de: 'Pfriemengras',              bot: 'Stipa pennata',                         kat: 'Gräser' },
  { de: 'Silberpfeilgras',           bot: 'Stipa calamagrostis',                   kat: 'Gräser' },
  { de: 'Palmwedel-Segge',           bot: 'Carex muskingumensis',                  kat: 'Gräser' },
  { de: 'Morrow-Segge',              bot: 'Carex morrowii',                        kat: 'Gräser' },
  { de: 'Orange-Segge',              bot: 'Carex testacea',                        kat: 'Gräser' },
  { de: 'Immergrüne Gold-Segge',     bot: "Carex oshimensis 'Evergold'",           kat: 'Gräser' },
  { de: 'Morgenstern-Segge',         bot: 'Carex grayi',                           kat: 'Gräser' },
  { de: 'Blauschillergras',          bot: 'Koeleria glauca',                       kat: 'Gräser' },
  { de: 'Japanisches Blutgras',      bot: "Imperata cylindrica 'Red Baron'",       kat: 'Gräser' },
  { de: 'Breitsähren-Waldgras',      bot: 'Chasmanthium latifolium',               kat: 'Gräser' },
  { de: 'Schneeweißes Hainsimse',    bot: 'Luzula nivea',                          kat: 'Gräser' },
  { de: 'Großes Bartgras',           bot: 'Andropogon gerardii',                   kat: 'Gräser' },
  { de: 'Blaues Besenreitgras',      bot: 'Schizachyrium scoparium',               kat: 'Gräser' },

  // FARNE — kaum vorhanden
  { de: 'Straußenfarn',              bot: 'Matteuccia struthiopteris',              kat: 'Farne' },
  { de: 'Königsfarn',                bot: 'Osmunda regalis',                       kat: 'Farne' },
  { de: 'Japanischer Schmuckfarn',   bot: "Athyrium niponicum 'Pictum'",           kat: 'Farne' },
  { de: 'Amerikanischer Frauenhaarfarn', bot: 'Adiantum pedatum',                  kat: 'Farne' },
  { de: 'Stachel-Schildfarn',        bot: 'Polystichum aculeatum',                 kat: 'Farne' },
  { de: 'Goldschuppenf-Wurmfarn',    bot: 'Dryopteris affinis',                    kat: 'Farne' },
  { de: 'Herbst-Wurmfarn',           bot: 'Dryopteris erythrosora',                kat: 'Farne' },

  // SONNENPFLANZEN — wichtige Lücken
  { de: 'Goldschafgarbe',            bot: 'Achillea filipendulina',                kat: 'Sonne' },
  { de: 'Sumpf-Schafgarbe',          bot: 'Achillea ptarmica',                     kat: 'Sonne' },
  { de: 'Korea-Duftnessel',          bot: 'Agastache rugosa',                      kat: 'Sonne' },
  { de: 'Mexikanischer Riesenysop',  bot: 'Agastache mexicana',                    kat: 'Sonne' },
  { de: 'Orangegelber Riesenysop',   bot: "Agastache 'Apricot Sunrise'",           kat: 'Sonne' },
  { de: 'Mazedonische Witwenblume',  bot: 'Knautia macedonica',                    kat: 'Sonne' },
  { de: 'Japanischer Wiesenknopf',   bot: 'Sanguisorba obtusa',                    kat: 'Sonne' },
  { de: 'Schmalblättriger Wiesenknopf', bot: 'Sanguisorba tenuifolia',             kat: 'Sonne' },
  { de: 'Chinesische Wiesenraute',   bot: 'Thalictrum delavayi',                   kat: 'Sonne' },
  { de: 'Glänzende Wiesenraute',     bot: 'Thalictrum lucidum',                    kat: 'Sonne' },
  { de: 'Gelbe Wiesenraute',         bot: 'Thalictrum flavum',                     kat: 'Sonne' },
  { de: 'Phönizische Königskerze',   bot: 'Verbascum phoeniceum',                  kat: 'Sonne' },
  { de: 'Olympische Königskerze',    bot: 'Verbascum olympicum',                   kat: 'Sonne' },
  { de: 'Knolliger Brandkraut',      bot: 'Phlomis tuberosa',                      kat: 'Sonne' },
  { de: 'Echter Salbei',             bot: 'Salvia officinalis',                    kat: 'Sonne' },
  { de: 'Garten-Salbei',             bot: 'Salvia x sylvestris',                   kat: 'Sonne' },
  { de: 'Quirlblütiger Salbei',      bot: 'Salvia verticillata',                   kat: 'Sonne' },
  { de: 'Ananas-Salbei',             bot: 'Salvia elegans',                        kat: 'Sonne' },
  { de: 'Kleinsalbei',               bot: 'Salvia microphylla',                    kat: 'Sonne' },
  { de: 'Blasser Sonnenhut',         bot: 'Echinacea pallida',                     kat: 'Sonne' },
  { de: 'Gelber Sonnenhut',          bot: 'Echinacea paradoxa',                    kat: 'Sonne' },
  { de: 'Schmalblättriger Sonnenhut', bot: 'Echinacea angustifolia',               kat: 'Sonne' },
  { de: 'Schlitzblättriger Sonnenhut', bot: 'Rudbeckia laciniata',                 kat: 'Sonne' },
  { de: 'Duftender Sonnenhut',       bot: 'Rudbeckia subtomentosa',                kat: 'Sonne' },
  { de: 'Riesen-Sonnenhut',          bot: 'Rudbeckia maxima',                      kat: 'Sonne' },
  { de: 'Prärie-Sonnenhut',          bot: 'Ratibida columnifera',                  kat: 'Sonne' },
  { de: 'Stauden-Sonnenblume',       bot: 'Helianthus decapetalus',                kat: 'Sonne' },
  { de: 'Weiden-Sonnenblume',        bot: 'Helianthus salicifolius',               kat: 'Sonne' },
  { de: 'Großköpfige Flockenblume',  bot: 'Centaurea macrocephala',                kat: 'Sonne' },
  { de: 'Vielfarbige Wolfsmilch',    bot: 'Euphorbia polychroma',                  kat: 'Sonne' },
  { de: 'Wulfens Wolfsmilch',        bot: 'Euphorbia wulfenii',                    kat: 'Sonne' },
  { de: 'Sternkugellauch',           bot: 'Allium cristophii',                     kat: 'Sonne' },
  { de: 'Holländischer Zierlauch',   bot: 'Allium hollandicum',                    kat: 'Sonne' },
  { de: 'Berglauch',                 bot: 'Allium senescens',                      kat: 'Sonne' },
  { de: 'Goldlauch',                 bot: 'Allium moly',                           kat: 'Sonne' },
  { de: 'Silber-Mannstreu',          bot: 'Eryngium giganteum',                    kat: 'Sonne' },
  { de: 'Spanischer Mannstreu',      bot: 'Eryngium bourgatii',                    kat: 'Sonne' },
  { de: 'Kaminblümchen',             bot: 'Calamintha nepeta',                     kat: 'Sonne' },
  { de: 'Großblütige Bergminze',     bot: 'Calamintha grandiflora',                kat: 'Sonne' },
  { de: 'Großblütiger Fingerhut',    bot: 'Digitalis grandiflora',                 kat: 'Sonne' },
  { de: 'Gelber Fingerhut',          bot: 'Digitalis lutea',                       kat: 'Sonne' },
  { de: 'Purpur-Leinkraut',          bot: 'Linaria purpurea',                      kat: 'Sonne' },
  { de: 'Färber-Hundskamille',       bot: 'Anthemis tinctoria',                    kat: 'Sonne' },
  { de: 'Breitblättriger Strandflieder', bot: 'Limonium platyphyllum',             kat: 'Sonne' },
  { de: 'Feder-Nelke',               bot: 'Dianthus plumarius',                    kat: 'Sonne' },
  { de: 'Pracht-Nelke',              bot: 'Dianthus superbus',                     kat: 'Sonne' },
  { de: 'Kleines Mädchenauge',       bot: "Coreopsis verticillata 'Moonbeam'",     kat: 'Sonne' },
  { de: 'Quirlblättriges Mädchenauge', bot: 'Coreopsis tripteris',                 kat: 'Sonne' },
  { de: 'Rotes Seifenkraut',         bot: 'Saponaria ocymoides',                   kat: 'Sonne' },
  { de: 'Purpur-Wasserdost',         bot: 'Eutrochium purpureum',                  kat: 'Sonne' },
  { de: 'Gefleckter Wasserdost',     bot: 'Eutrochium maculatum',                  kat: 'Sonne' },
  { de: 'Knollen-Seidenpflanze',     bot: 'Asclepias tuberosa',                    kat: 'Sonne' },
  { de: 'Rosen-Seidenpflanze',       bot: 'Asclepias incarnata',                   kat: 'Sonne' },
  { de: 'Bärtige Iris',              bot: "Iris barbata 'Pallida'",                kat: 'Sonne' },
  { de: 'Spanische Iris',            bot: 'Iris xiphium',                          kat: 'Sonne' },
  { de: 'Wiesenweisblau',            bot: 'Camasia quamash',                       kat: 'Sonne' },
  { de: 'Weißer Falscher Indigo',    bot: 'Baptisia alba',                         kat: 'Sonne' },
  { de: 'Durchwachsene Becherpflanze', bot: 'Silphium perfoliatum',                kat: 'Sonne' },
  { de: 'Bärtiger Bartfaden',        bot: 'Penstemon barbatus',                    kat: 'Sonne' },
  { de: 'Rauhhaariger Bartfaden',    bot: 'Penstemon hirsutus',                    kat: 'Sonne' },
  { de: 'Neuengland-Aster',          bot: 'Symphyotrichum novae-angliae',          kat: 'Sonne' },
  { de: 'Glattblatt-Aster',          bot: 'Symphyotrichum laeve',                  kat: 'Sonne' },
  { de: 'Berg-Aster',                bot: 'Aster amellus',                         kat: 'Sonne' },
  { de: 'Kissen-Aster',              bot: 'Aster dumosus',                         kat: 'Sonne' },
  { de: 'Großblütige Scheinaster',   bot: 'Vernonia crinita',                      kat: 'Sonne' },
  { de: 'Lespedeza',                 bot: 'Lespedeza thunbergii',                  kat: 'Sonne' },
  { de: 'Goldenes Greiskraut',       bot: 'Packera aurea',                         kat: 'Sonne' },
  { de: 'Pracht-Berufkraut',         bot: 'Erigeron speciosus',                    kat: 'Sonne' },
  { de: 'Bischofskraut',             bot: 'Ammi majus',                            kat: 'Sonne' },

  // TRÄNENDES HERZ & SCHATTEN-KLASSIKER
  { de: 'Tränendes Herz',            bot: 'Lamprocapnos spectabilis',              kat: 'Schatten' },
  { de: 'Weißes Tränendes Herz',     bot: "Lamprocapnos spectabilis 'Alba'",       kat: 'Schatten' },
  { de: 'Wald-Tränendes Herz',       bot: 'Dicentra formosa',                      kat: 'Schatten' },
  { de: 'Traubensilberkerze',        bot: 'Actaea racemosa',                       kat: 'Schatten' },
  { de: 'Japanisches Silberlicht',   bot: 'Actaea simplex',                        kat: 'Schatten' },
  { de: 'Lenz-Rose',                 bot: 'Helleborus orientalis',                 kat: 'Schatten' },
  { de: 'Stinkende Nieswurz',        bot: 'Helleborus foetidus',                   kat: 'Schatten' },
  { de: 'Hybrid-Nieswurz',           bot: 'Helleborus x hybridus',                kat: 'Schatten' },
  { de: 'Leberblümchen',             bot: 'Hepatica nobilis',                      kat: 'Schatten' },
  { de: 'Geflecktes Lungenkraut',    bot: 'Pulmonaria saccharata',                 kat: 'Schatten' },
  { de: 'Schmalblättriges Lungenkraut', bot: 'Pulmonaria angustifolia',            kat: 'Schatten' },
  { de: 'Silberblatt-Lungenkraut',   bot: "Pulmonaria longifolia 'Bertram Anderson'", kat: 'Schatten' },
  { de: 'Herbst-Alpenveilchen',      bot: 'Cyclamen hederifolium',                 kat: 'Schatten' },
  { de: 'Winter-Alpenveilchen',      bot: 'Cyclamen coum',                         kat: 'Schatten' },
  { de: 'Schirmblatt',               bot: 'Darmera peltata',                       kat: 'Schatten' },
  { de: 'Krainer Sterndolde',        bot: 'Astrantia carniolica',                  kat: 'Schatten' },
  { de: 'Großblütige Sterndolde',    bot: 'Astrantia maxima',                      kat: 'Schatten' },
  { de: 'Wiesenschaumkraut',         bot: 'Cardamine pratensis',                   kat: 'Schatten' },
  { de: 'Großes Dreiblatt',          bot: 'Trillium grandiflorum',                 kat: 'Schatten' },
  { de: 'Wachsglöckchen',            bot: 'Kirengeshoma palmata',                  kat: 'Schatten' },
  { de: 'Frauenhaarfarn',            bot: 'Adiantum venustum',                     kat: 'Schatten' },
  { de: 'Ligularia',                 bot: 'Ligularia stenocephala',                kat: 'Schatten' },
  { de: 'Schmalkopf-Ligularie',      bot: "Ligularia stenocephala 'The Rocket'",   kat: 'Schatten' },
  { de: 'Przewalski-Ligularie',      bot: 'Ligularia przewalskii',                 kat: 'Schatten' },
  { de: 'Buschwindröschen',          bot: 'Anemone nemorosa',                      kat: 'Schatten' },
  { de: 'Gelbes Windröschen',        bot: 'Anemone ranunculoides',                 kat: 'Schatten' },
  { de: 'Hohler Lerchensporn',       bot: 'Corydalis cava',                        kat: 'Schatten' },
  { de: 'Chinesischer Lerchensporn', bot: 'Corydalis flexuosa',                    kat: 'Schatten' },
  { de: 'Gelber Lerchensporn',       bot: 'Corydalis lutea',                       kat: 'Schatten' },
  { de: 'Eremurus-Farn',             bot: 'Dryopteris erythrosora',                kat: 'Schatten' },
  { de: 'Kaukasusvergißmeinnicht',   bot: 'Brunnera macrophylla',                  kat: 'Schatten' },
  { de: 'Buntblättriges Brunnera',   bot: "Brunnera macrophylla 'Jack Frost'",     kat: 'Schatten' },
  { de: 'Rosskastanien-Schaublatt',  bot: 'Rodgersia aesculifolia',                kat: 'Schatten' },
  { de: 'Gefiederte Schaublatt',     bot: 'Rodgersia pinnata',                     kat: 'Schatten' },
  { de: 'Fingerblättriges Schaublatt', bot: 'Rodgersia podophylla',                kat: 'Schatten' },
  { de: 'Geißbart',                  bot: 'Aruncus dioicus',                       kat: 'Schatten' },
  { de: 'Zwerg-Geißbart',            bot: 'Aruncus aethusifolius',                 kat: 'Schatten' },
  { de: 'Wohlriechende Weißwurz',    bot: 'Polygonatum odoratum',                  kat: 'Schatten' },
  { de: 'Horn-Veilchen',             bot: 'Viola cornuta',                         kat: 'Schatten' },
  { de: 'Scharfer Hahnenfuß',        bot: 'Ranunculus acris',                      kat: 'Schatten' },
  { de: 'Lamium',                    bot: 'Lamium orvala',                         kat: 'Schatten' },

  // FEUCHT & WASSER
  { de: 'Rotes Mädesüß',             bot: 'Filipendula rubra',                     kat: 'Feucht' },
  { de: 'Fingerblättriges Mädesüß',  bot: 'Filipendula palmata',                   kat: 'Feucht' },
  { de: 'Etagen-Primel',             bot: 'Primula bulleyana',                     kat: 'Feucht' },
  { de: 'Tibet-Primel',              bot: 'Primula florindae',                     kat: 'Feucht' },
  { de: 'Mehlige Etagen-Primel',     bot: 'Primula pulverulenta',                  kat: 'Feucht' },
  { de: 'Kugel-Primel',              bot: 'Primula denticulata',                   kat: 'Feucht' },
  { de: 'Straußfelberich',           bot: 'Lysimachia clethroides',                kat: 'Feucht' },
  { de: 'Bunte Schwertlilie',        bot: 'Iris versicolor',                       kat: 'Feucht' },
  { de: 'Glatte Schwertlilie',       bot: 'Iris laevigata',                        kat: 'Feucht' },
  { de: 'Lila Engelwurz',            bot: 'Angelica gigas',                        kat: 'Feucht' },
  { de: 'Wald-Engelwurz',            bot: 'Angelica sylvestris',                   kat: 'Feucht' },
  { de: 'Ruten-Blutweiderich',       bot: 'Lythrum virgatum',                      kat: 'Feucht' },
  { de: 'Kalmus',                    bot: 'Acorus calamus',                        kat: 'Feucht' },
  { de: 'Buntblättriger Kalmus',     bot: "Acorus calamus 'Variegatus'",           kat: 'Feucht' },
  { de: 'Sumpf-Calla',               bot: 'Calla palustris',                       kat: 'Feucht' },
  { de: 'Wasserminze',               bot: 'Mentha aquatica',                       kat: 'Feucht' },
  { de: 'Berula',                    bot: 'Berula erecta',                         kat: 'Feucht' },
  { de: 'Rohrkolben',                bot: 'Typha minima',                          kat: 'Feucht' },
  { de: 'Zwerg-Rohrkolben',          bot: 'Typha laxmannii',                       kat: 'Feucht' },
  { de: 'Großes Windröschen',        bot: 'Anemone sylvestris',                    kat: 'Feucht' },
  { de: 'Sibirischer Ehrenpreis',    bot: 'Veronicastrum sibiricum',               kat: 'Feucht' },

  // MEDITERRAN & STEINGARTEN
  { de: 'Lavandin',                  bot: 'Lavandula x intermedia',                kat: 'Mediterran' },
  { de: 'Breitblättriger Lavendel',  bot: 'Lavandula latifolia',                   kat: 'Mediterran' },
  { de: 'Edel-Gamander',             bot: 'Teucrium chamaedrys',                   kat: 'Mediterran' },
  { de: 'Polei-Gamander',            bot: 'Teucrium polium',                       kat: 'Mediterran' },
  { de: 'Heiligenkraut',             bot: 'Santolina chamaecyparissus',            kat: 'Mediterran' },
  { de: 'Weinraute',                 bot: 'Ruta graveolens',                       kat: 'Mediterran' },
  { de: 'Weicher Bärenklau',         bot: 'Acanthus mollis',                       kat: 'Mediterran' },
  { de: 'Stacheliger Bärenklau',     bot: 'Acanthus spinosus',                     kat: 'Mediterran' },
  { de: 'Strauch-Beifuß',            bot: 'Artemisia arborescens',                 kat: 'Mediterran' },
  { de: 'Silbersalbei',              bot: 'Salvia argentea',                       kat: 'Mediterran' },
  { de: 'Falscher Diptam',           bot: 'Ballota pseudodictamnus',               kat: 'Mediterran' },
  { de: 'Großer Reiherschnabel',     bot: 'Erodium manescavii',                    kat: 'Mediterran' },
  { de: 'Purpur-Fetthenne',          bot: 'Hylotelephium telephium',               kat: 'Mediterran' },
  { de: 'Kaukasusfetthenne',         bot: 'Sedum cauticola',                       kat: 'Mediterran' },
  { de: 'Kriechtymian',              bot: 'Thymus serpyllum',                      kat: 'Mediterran' },
  { de: 'Frühblühender Thymian',     bot: 'Thymus praecox',                        kat: 'Mediterran' },
  { de: 'Rundblättriger Dost',       bot: 'Origanum rotundifolium',                kat: 'Mediterran' },
  { de: 'Herzblättriges Leimkraut',  bot: 'Silene schafta',                        kat: 'Mediterran' },
  { de: 'Lorbeer-Zistrose',          bot: 'Cistus laurifolius',                    kat: 'Mediterran' },
  { de: 'Kleinkaukasische Gänsekresse', bot: 'Arabis caucasica',                   kat: 'Mediterran' },
  { de: 'Schleifenblume',            bot: 'Iberis sempervirens',                   kat: 'Mediterran' },

  // PRAIRIE / MODERN PLANTING
  { de: 'Prärie-Dropsgras',          bot: 'Sporobolus heterolepis',                kat: 'Prairie' },
  { de: 'Nickende Sorghumgras',      bot: 'Sorghastrum nutans',                    kat: 'Prairie' },
  { de: 'Kugelfrucht-Baptisie',      bot: 'Baptisia sphaerocarpa',                 kat: 'Prairie' },
  { de: 'Kompass-Becherpflanze',     bot: 'Silphium laciniatum',                   kat: 'Prairie' },
  { de: 'Weiche Stauden-Sonnenblume', bot: 'Helianthus mollis',                    kat: 'Prairie' },
  { de: 'Rohe Prachtscharte',        bot: 'Liatris aspera',                        kat: 'Prairie' },
  { de: 'Dichte Prachtscharte',      bot: 'Liatris pycnostachya',                  kat: 'Prairie' },
  { de: 'Blaues Pfeilkraut',         bot: 'Sagittaria latifolia',                  kat: 'Prairie' },
  { de: 'Zizia',                     bot: 'Zizia aurea',                           kat: 'Prairie' },
  { de: 'Ohio-Dreimasterblume',      bot: 'Tradescantia ohiensis',                 kat: 'Prairie' },

  // KLASSIKER & SCHNITTSTAUDEN
  { de: 'Garten-Pfingstrose',        bot: 'Paeonia officinalis',                   kat: 'Schnitt' },
  { de: 'Chinesischer Eisenhut',     bot: 'Aconitum carmichaelii',                 kat: 'Schnitt' },
  { de: 'Garten-Eisenhut',           bot: 'Aconitum x cammarum',                  kat: 'Schnitt' },
  { de: 'Chinesischer Rittersporn',  bot: 'Delphinium grandiflorum',               kat: 'Schnitt' },
  { de: 'Belladonna-Rittersporn',    bot: 'Delphinium x belladonna',               kat: 'Schnitt' },
  { de: 'Trollblume Kultursorten',   bot: 'Trollius x cultorum',                   kat: 'Schnitt' },
  { de: 'Türkenbund-Lilie',          bot: 'Lilium martagon',                       kat: 'Schnitt' },
  { de: 'Königslilie',               bot: 'Lilium regale',                         kat: 'Schnitt' },
  { de: 'Prächtige Feuerlilie',      bot: 'Kniphofia triangularis',                kat: 'Schnitt' },
  { de: 'Japanische Wiesenraute',    bot: 'Thalictrum rochebrunianum',             kat: 'Schnitt' },
  { de: 'Große Inkalilie',           bot: 'Alstroemeria aurantiaca',               kat: 'Schnitt' },
  { de: 'Japanische Sterndolde',     bot: "Astrantia major 'Ruby Wedding'",        kat: 'Schnitt' },
  { de: 'Schwarzes Schöllkraut',     bot: "Actaea simplex 'Brunette'",             kat: 'Schnitt' },
  { de: 'Lila Kaukasische Witwenblume', bot: 'Scabiosa caucasica',                kat: 'Schnitt' },
  { de: 'Kokardenblume',             bot: 'Gaillardia x grandiflora',              kat: 'Schnitt' },

  // FRÜHJAHRSBLÜHER & ZWIEBELN (einpflanzen als Staude)
  { de: 'Winterling',                bot: 'Eranthis hyemalis',                     kat: 'Frühjahr' },
  { de: 'Sibirischer Blaustern',     bot: 'Scilla siberica',                       kat: 'Frühjahr' },
  { de: 'Arménische Traubenhyazinthe', bot: 'Muscari armeniacum',                  kat: 'Frühjahr' },
  { de: 'Strahlenanemone',           bot: 'Anemone blanda',                        kat: 'Frühjahr' },
  { de: 'Schneestolz',               bot: 'Chionodoxa luciliae',                   kat: 'Frühjahr' },
  { de: 'Nektarlauch',               bot: 'Nectaroscordum siculum',                kat: 'Frühjahr' },
  { de: 'Dolden-Milchstern',         bot: 'Ornithogalum umbellatum',               kat: 'Frühjahr' },
  { de: 'Camas-Prärielilie',         bot: 'Camassia cusickii',                     kat: 'Frühjahr' },
  { de: 'Blaue Prärielilie',         bot: 'Camassia quamash',                      kat: 'Frühjahr' },
  { de: 'Herbstzeitlose',            bot: 'Colchicum autumnale',                   kat: 'Frühjahr' },
  { de: 'Gebirgslauch',              bot: 'Allium oreophilum',                     kat: 'Frühjahr' },

  // BODENDECKER & KLEINSTFLÄCHEN
  { de: 'Großkelchiges Johanniskraut', bot: 'Hypericum calycinum',                 kat: 'Bodendecker' },
  { de: 'Olymp-Johanniskraut',       bot: 'Hypericum olympicum',                   kat: 'Bodendecker' },
  { de: 'Waldsteinie',               bot: 'Waldsteinia geoides',                   kat: 'Bodendecker' },
  { de: 'Immergrünes Garten-Vergissmeinnicht', bot: 'Omphalodes cappadocica',      kat: 'Bodendecker' },
  { de: 'Buntblättrige Günsel',      bot: "Ajuga reptans 'Multicolor'",            kat: 'Bodendecker' },
  { de: 'Breit-Wegerich',            bot: 'Plantago major',                        kat: 'Bodendecker' },
  { de: 'Fetthenne Herbststimmung',  bot: "Hylotelephium 'Herbstfreude'",          kat: 'Bodendecker' },
  { de: 'Elfenblume Sulphureum',     bot: "Epimedium x versicolor 'Sulphureum'",  kat: 'Bodendecker' },
  { de: 'Großblütige Elfenblume',    bot: 'Epimedium grandiflorum',                kat: 'Bodendecker' },
  { de: 'Rotes Elfenblume',          bot: 'Epimedium rubrum',                      kat: 'Bodendecker' },
  { de: 'Schleifenblume',            bot: 'Iberis sempervirens',                   kat: 'Bodendecker' },
  { de: 'Teppich-Phlox',             bot: "Phlox subulata 'Mc Daniel's Cushion'", kat: 'Bodendecker' },
  { de: 'Blaukissen Compact',        bot: "Aubrieta 'Royal Blue'",                 kat: 'Bodendecker' },
];

// ── Felder generieren via GPT-4o ─────────────────────────────────────────────
async function generatePflanze(p) {
  const prompt = `Du bist ein Staudenexperte für deutsche Gärten. Generiere vollständige Datenbankdaten für:

Pflanze: ${p.de} (${p.bot})
Kategorie: ${p.kat}

Antworte NUR mit diesem JSON (kein Markdown, kein Text):
{
  "beschreibung": "<2-3 Sätze, prägnant, Besonderheiten, Verwendung>",
  "licht": "<'Sonne', 'Halbschatten', 'Schatten', 'Sonne|Halbschatten' oder 'Halbschatten|Schatten'>",
  "boden": "<'sandig', 'normal', 'lehmig', 'humos' oder Kombinationen mit |>",
  "stil": "<Hauptstile mit |: Naturgarten, Bauerngarten, Cottage, Modern, Steingarten, Mediterran, Schattengarten — max 2>",
  "bluehzeit": "<z.B. 'Mai - Juni' oder 'Juli - September'>",
  "farbe": "<Hauptfarbe, z.B. 'Blau', 'Gelb', 'Rosa', 'Weiß', oder 'Gelb | Orange'>",
  "hoehe_cm_min": <Zahl>,
  "hoehe_cm_max": <Zahl>,
  "pflege_sterne": <1-3>,
  "preis_stueck_eur": <realistischer Gärtnerei-Preis, z.B. 6.50>,
  "winterhart_zone": <4, 5 oder 6>,
  "bienen_freundlich": <1 oder 0>,
  "heimisch": <1 wenn in Deutschland heimisch, sonst 0>,
  "feuchtigkeit": "<'trocken', 'normal', 'feucht' oder 'wechselfeucht'>",
  "wuchs": "<'horstig', 'ausläufer', 'selbstsäend' oder 'invasiv'>",
  "inhalt_lang": "<4-6 Sätze: Herkunft, Wuchs, Kombination, Pflege, Tipp>",
  "lebensbereich": "<Hansen & Stahl: 'Freifläche', 'Gehölzrand', 'Waldsaum', 'Quellflur', 'Steppenheide' etc. — bis 2 kommagetrennt>",
  "breite_cm_max": <typische Ausbreitung als Zahl>,
  "rolle_empfehlung": "<'Leitstaude', 'Begleitstaude' oder 'Füllstaude'>",
  "kombinationspartner": "<3-4 botanische Namen passender Staudenpartner, kommagetrennt>",
  "winteraspekt": "<'Samenstand dekorativ', 'Blätter immergrün', 'Rosetten wintergrün', 'Gräser Struktur' oder 'unauffällig'>",
  "trockenheitstoleranz": "<'hoch', 'mittel' oder 'gering'>"
}`;

  const res = await openai.chat.completions.create({
    model: 'gpt-4o',
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.2,
    response_format: { type: 'json_object' },
  });
  return JSON.parse(res.choices[0].message.content);
}

// ── Hauptschleife ─────────────────────────────────────────────────────────────
async function main() {
  // Vorhandene botanische Namen laden
  const existingBotNames = new Set(
    db.prepare("SELECT name_botanisch FROM pflanzen WHERE name_deutsch != 'Test-Pflanze'")
      .all().map(r => r.name_botanisch.toLowerCase())
  );

  let ziel = PFLANZEN.filter(p => {
    if (existingBotNames.has(p.bot.toLowerCase())) return false;
    if (KAT_FILTER && p.kat !== KAT_FILTER) return false;
    return true;
  });
  if (LIMIT) ziel = ziel.slice(0, LIMIT);

  const vorher = db.prepare("SELECT COUNT(*) as n FROM pflanzen WHERE name_deutsch != 'Test-Pflanze'").get().n;
  console.log(`\n=== Pflanzen-500 Seed ${DRY_RUN ? '[DRY RUN] ' : ''}===`);
  console.log(`Vorher: ${vorher} | Neu zu generieren: ${ziel.length} | Danach ca. ${vorher + ziel.length}\n`);

  let ok = 0, err = 0;
  for (const p of ziel) {
    process.stdout.write(`  [${p.kat}] ${p.de} ... `);
    try {
      const d = await generatePflanze(p);
      if (!DRY_RUN) {
        INSERT.run(
          p.de, p.bot,
          d.beschreibung || null, d.licht || null, d.boden || null, d.stil || null,
          d.bluehzeit || null, d.farbe || null,
          d.hoehe_cm_min || null, d.hoehe_cm_max || null,
          d.pflege_sterne || 2, d.preis_stueck_eur || 7.90,
          d.winterhart_zone || 5, d.bienen_freundlich || 0, d.heimisch || 0,
          d.feuchtigkeit || 'normal', d.wuchs || 'horstig',
          d.inhalt_lang || null,
          d.lebensbereich || null, d.breite_cm_max || null,
          d.rolle_empfehlung || null, d.kombinationspartner || null,
          d.winteraspekt || null, d.trockenheitstoleranz || null
        );
      }
      console.log(`OK  ${d.hoehe_cm_min}-${d.hoehe_cm_max}cm | ${d.licht} | ${d.rolle_empfehlung}`);
      ok++;
    } catch (e) {
      console.log(`FEHLER: ${e.message}`);
      err++;
    }
    await new Promise(r => setTimeout(r, 200));
  }

  const nachher = db.prepare("SELECT COUNT(*) as n FROM pflanzen WHERE name_deutsch != 'Test-Pflanze'").get().n;
  console.log(`\n=== Fertig: ${ok} neu, ${err} Fehler | Gesamt jetzt: ${nachher} Pflanzen ===\n`);
  db.close();
}

main().catch(console.error);
