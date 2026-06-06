// Top-up auf 500 Pflanzen — ~50 gezielte Ergänzungen.
// Ausführen: node scripts/seed-pflanzen-topup.js

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const Database = require('better-sqlite3');
const { OpenAI } = require('openai');
const path = require('path');

const DRY_RUN = process.argv.includes('--dry-run');

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
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
`);

const PFLANZEN = [
  // HOSTA — kaum vertreten, sehr gefragt
  { de: 'Blaue Funkie',              bot: 'Hosta sieboldiana Elegans',             kat: 'Schatten' },
  { de: 'Goldherz-Funkie',           bot: "Hosta 'Sum and Substance'",             kat: 'Schatten' },
  { de: 'Weißrand-Funkie',           bot: "Hosta 'Francee'",                       kat: 'Schatten' },
  { de: 'Zwerg-Funkie',              bot: "Hosta 'Halcyon'",                       kat: 'Schatten' },
  { de: 'Gelbblatt-Funkie',          bot: "Hosta 'Gold Standard'",                 kat: 'Schatten' },

  // GERANIUM — beliebte Ergänzungen
  { de: 'Blauer Storchschnabel',     bot: "Geranium x magnificum",                 kat: 'Sonne' },
  { de: 'Himalaya-Storchschnabel',   bot: 'Geranium himalayense',                  kat: 'Sonne' },
  { de: 'Pracht-Storchschnabel',     bot: "Geranium x oxonianum 'Wargrave Pink'",  kat: 'Sonne' },
  { de: 'Dunkler Storchschnabel',    bot: "Geranium phaeum",                       kat: 'Schatten' },
  { de: 'Dunkelvioletter Storchschnabel', bot: "Geranium x 'Rozanne'",             kat: 'Sonne' },

  // ASTILBE — mehr Sorten
  { de: 'Frühe Prachtspiere',        bot: "Astilbe x arendsii 'Fanal'",            kat: 'Schatten' },
  { de: 'Weiße Prachtspiere',        bot: "Astilbe x arendsii 'Brautschleier'",    kat: 'Schatten' },
  { de: 'Rosa Prachtspiere',         bot: "Astilbe x arendsii 'Bressingham Beauty'", kat: 'Schatten' },

  // HEUCHERA — sehr beliebt, unterrepräsentiert
  { de: 'Purpur-Glöckchen',          bot: "Heuchera 'Palace Purple'",              kat: 'Schatten' },
  { de: 'Karamel-Glöckchen',         bot: "Heuchera 'Caramel'",                    kat: 'Schatten' },
  { de: 'Silber-Glöckchen',          bot: "Heuchera 'Silver Scrolls'",             kat: 'Schatten' },
  { de: 'Limonen-Glöckchen',         bot: "Heuchera 'Lime Marmalade'",             kat: 'Schatten' },

  // CAMPANULA — wichtige fehlende Arten
  { de: 'Riesen-Glockenblume',       bot: 'Campanula lactiflora',                  kat: 'Sonne' },
  { de: 'Pfirsichblatt-Glockenblume Weiß', bot: "Campanula persicifolia 'Alba'",  kat: 'Sonne' },
  { de: 'Milchglockenblume',         bot: 'Campanula lactiflora',                  kat: 'Sonne' },
  { de: 'Ähren-Glockenblume',        bot: 'Campanula spicata',                     kat: 'Sonne' },
  { de: 'Sibirische Glockenblume',   bot: 'Campanula sibirica',                    kat: 'Sonne' },

  // IRIS — wichtige fehlende Sorten
  { de: 'Sumpf-Schwertlilie',        bot: 'Iris pseudacorus',                      kat: 'Feucht' },
  { de: 'Japanische Schwertlilie',   bot: 'Iris ensata',                           kat: 'Feucht' },
  { de: 'Niedrige Bart-Iris',        bot: 'Iris pumila',                           kat: 'Sonne' },

  // CLEMATIS — krautige Sorten
  { de: 'Krautige Waldrebe',         bot: 'Clematis integrifolia',                 kat: 'Sonne' },
  { de: 'Blauviolette Waldrebe',     bot: 'Clematis x durandii',                   kat: 'Sonne' },
  { de: 'Aufrechte Waldrebe',        bot: 'Clematis recta',                        kat: 'Sonne' },

  // PRIMULA — beliebte Sorten
  { de: 'Kissenpriemel',             bot: 'Primula auricula',                      kat: 'Schatten' },
  { de: 'Hohe Schlüsselblume',       bot: 'Primula elatior',                       kat: 'Schatten' },

  // MISC. WICHTIGE FEHLENDE
  { de: 'Weißer Rittersporn',        bot: "Delphinium elatum 'Galahad'",           kat: 'Schnitt' },
  { de: 'Blauer Rittersporn',        bot: "Delphinium elatum 'Blue Nile'",         kat: 'Schnitt' },
  { de: 'Stockrose',                 bot: 'Alcea rosea',                           kat: 'Sonne' },
  { de: 'Schwarze Stockrose',        bot: "Alcea rosea 'Nigra'",                   kat: 'Sonne' },
  { de: 'Hoher Phlox',               bot: "Phlox paniculata 'David'",              kat: 'Sonne' },
  { de: 'Lachsfarbener Phlox',       bot: "Phlox paniculata 'Starfire'",           kat: 'Sonne' },
  { de: 'Purpursonnenhut Kultiv.',   bot: "Echinacea purpurea 'Magnus'",           kat: 'Sonne' },
  { de: 'Weißer Sonnenhut',          bot: "Echinacea purpurea 'Alba'",             kat: 'Sonne' },
  { de: 'Herbst-Chrysantheme',       bot: 'Chrysanthemum x hortorum',              kat: 'Sonne' },
  { de: 'Bergmargerite',             bot: 'Leucanthemum x superbum',               kat: 'Sonne' },
  { de: 'Riesen-Goldnessel',         bot: "Lamium galeobdolon 'Hermann's Pride'",  kat: 'Schatten' },
  { de: 'Fenchel',                   bot: 'Foeniculum vulgare',                    kat: 'Sonne' },
  { de: 'Bronzefenchel',             bot: "Foeniculum vulgare 'Purpureum'",        kat: 'Sonne' },
  { de: 'Engelwurz',                 bot: 'Angelica archangelica',                 kat: 'Feucht' },
  { de: 'Zitronenmelisse',           bot: 'Melissa officinalis',                   kat: 'Sonne' },
  { de: 'Katzenminze Faassen groß',  bot: "Nepeta x faassenii 'Six Hills Giant'",  kat: 'Sonne' },
  { de: 'Hohe Katzenminze',          bot: 'Nepeta grandiflora',                    kat: 'Sonne' },
  { de: 'Tatarisches Eisenkraut',    bot: 'Verbena hastata',                       kat: 'Feucht' },
  { de: 'Kerzen-Knöterich',          bot: 'Persicaria polymorpha',                 kat: 'Sonne' },
  { de: 'Weißer Wiesenknopf',        bot: "Sanguisorba officinalis 'Tanna'",       kat: 'Sonne' },
];

async function generatePflanze(p) {
  const res = await openai.chat.completions.create({
    model: 'gpt-4o',
    messages: [{ role: 'user', content: `Du bist ein Staudenexperte für deutsche Gärten. Generiere vollständige Datenbankdaten für:

Pflanze: ${p.de} (${p.bot})
Kategorie: ${p.kat}

Antworte NUR mit diesem JSON (kein Markdown):
{
  "beschreibung": "<2-3 Sätze>",
  "licht": "<'Sonne', 'Halbschatten', 'Schatten', 'Sonne|Halbschatten' oder 'Halbschatten|Schatten'>",
  "boden": "<'sandig', 'normal', 'lehmig', 'humos' oder Kombinationen mit |>",
  "stil": "<max 2 Stile mit |: Naturgarten, Bauerngarten, Cottage, Modern, Steingarten, Mediterran, Schattengarten>",
  "bluehzeit": "<z.B. 'Mai - Juni'>",
  "farbe": "<Hauptfarbe>",
  "hoehe_cm_min": <Zahl>,
  "hoehe_cm_max": <Zahl>,
  "pflege_sterne": <1-3>,
  "preis_stueck_eur": <Zahl>,
  "winterhart_zone": <4, 5 oder 6>,
  "bienen_freundlich": <1 oder 0>,
  "heimisch": <1 oder 0>,
  "feuchtigkeit": "<'trocken', 'normal', 'feucht' oder 'wechselfeucht'>",
  "wuchs": "<'horstig', 'ausläufer', 'selbstsäend' oder 'invasiv'>",
  "inhalt_lang": "<4-6 Sätze>",
  "lebensbereich": "<Hansen & Stahl, bis 2 kommagetrennt>",
  "breite_cm_max": <Zahl>,
  "rolle_empfehlung": "<'Leitstaude', 'Begleitstaude' oder 'Füllstaude'>",
  "kombinationspartner": "<3-4 botanische Namen kommagetrennt>",
  "winteraspekt": "<kurze Beschreibung>",
  "trockenheitstoleranz": "<'hoch', 'mittel' oder 'gering'>"
}` }],
    temperature: 0.2,
    response_format: { type: 'json_object' },
  });
  return JSON.parse(res.choices[0].message.content);
}

async function main() {
  const existing = new Set(
    db.prepare("SELECT name_botanisch FROM pflanzen WHERE name_deutsch != 'Test-Pflanze'")
      .all().map(r => r.name_botanisch.toLowerCase())
  );
  const ziel = PFLANZEN.filter(p => !existing.has(p.bot.toLowerCase()));
  const vorher = db.prepare("SELECT COUNT(*) as n FROM pflanzen WHERE name_deutsch != 'Test-Pflanze'").get().n;

  console.log(`\n=== Top-up auf 500 ${DRY_RUN ? '[DRY RUN] ' : ''}===`);
  console.log(`Vorher: ${vorher} | Neu: ${ziel.length} | Ziel: ${vorher + ziel.length}\n`);

  let ok = 0, err = 0;
  for (const p of ziel) {
    process.stdout.write(`  ${p.de} ... `);
    try {
      const d = await generatePflanze(p);
      if (!DRY_RUN) {
        INSERT.run(p.de, p.bot,
          d.beschreibung, d.licht, d.boden, d.stil,
          d.bluehzeit, d.farbe, d.hoehe_cm_min, d.hoehe_cm_max,
          d.pflege_sterne, d.preis_stueck_eur, d.winterhart_zone,
          d.bienen_freundlich, d.heimisch, d.feuchtigkeit, d.wuchs,
          d.inhalt_lang, d.lebensbereich, d.breite_cm_max,
          d.rolle_empfehlung, d.kombinationspartner, d.winteraspekt, d.trockenheitstoleranz
        );
      }
      console.log(`OK  ${d.hoehe_cm_min}-${d.hoehe_cm_max}cm | ${d.licht}`);
      ok++;
    } catch (e) { console.log(`FEHLER: ${e.message}`); err++; }
    await new Promise(r => setTimeout(r, 200));
  }

  const nachher = db.prepare("SELECT COUNT(*) as n FROM pflanzen WHERE name_deutsch != 'Test-Pflanze'").get().n;
  console.log(`\n=== Fertig: ${ok} neu | Gesamt: ${nachher} Pflanzen ===\n`);
  db.close();
}

main().catch(console.error);
