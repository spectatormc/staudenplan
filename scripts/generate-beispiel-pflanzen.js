// Generiert kuratierte Pflanzenlisten für die 8 Beet-Beispielseiten via OpenAI.
// Ergebnis wird in scripts/beispiel-pflanzen.json gespeichert.
// Ausführen: node scripts/generate-beispiel-pflanzen.js
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const Database = require('better-sqlite3');
const { OpenAI } = require('openai');
const fs = require('fs');
const path = require('path');

const db = new Database(path.join(__dirname, '..', 'stauden.db'));
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const SZENARIEN = [
  {
    slug: 'schattenbeet',
    label: 'Schattenbeet 6 m²',
    licht: 'Halbschatten',
    feuchtigkeit: ['normal', 'feucht'],
    prompt: 'Halbschatten, normaler Gartenboden, 6 m², gemäßigter Gartenstil. Typische Hauswand oder Gehölzrand. Ziel: ansprechendes Beet mit Blüten und Blattschmuck ohne direkte Sonne.',
  },
  {
    slug: 'sonnenbeet',
    label: 'Sonnenbeet 8 m²',
    licht: 'Sonne',
    feuchtigkeit: ['normal'],
    prompt: 'Vollsonne (6+ Stunden), normaler humoser Gartenboden, 8 m², klassischer Gartenstil. Typisches Staudenbeet im offenen Garten. Ziel: langer Blütenflor Mai–Oktober, gute Kombination aus Leit- und Füllstauden.',
  },
  {
    slug: 'kiesgarten',
    label: 'Kiesgarten 10 m²',
    licht: 'Sonne',
    feuchtigkeit: ['trocken'],
    prompt: 'Vollsonne, sehr trockener sandiger oder kiesiger Boden, 10 m², mediterran/Steppencharakter. Kiesgarten oder Trockenstaudenbeet. Ziel: trockenheitstolerant, bienenfreundlich, mediterran-steppenartig.',
  },
  {
    slug: 'naturgarten',
    label: 'Naturgarten 12 m²',
    licht: 'Sonne',
    feuchtigkeit: ['normal', 'feucht'],
    prompt: 'Vollsonne, wechselfeuchter normaler Boden, 12 m², naturnaher/Wildgarten-Stil. Präriecharakter, hohe Biodiversität. Ziel: heimische Arten, bienenfreundlich, naturnahes Wiesenbeet mit Gräsern.',
  },
  {
    slug: 'teichrand',
    label: 'Teichrand 4 m²',
    licht: 'Halbschatten',
    feuchtigkeit: ['nass', 'feucht'],
    prompt: 'Halbschatten bis Sonne, dauerhaft feuchter bis nasser Boden, 4 m², Teichrand oder Sumpfbeet. Ziel: Uferpflanzen, Sumpfpflanzen, natürlicher Übergang vom Wasser zum Garten, Lebensraum für Amphibien.',
  },
  {
    slug: 'nordseite',
    label: 'Nordseite 5 m²',
    licht: 'Schatten',
    feuchtigkeit: ['normal', 'feucht'],
    prompt: 'Dauerschatten (unter 3 Stunden Sonne), kühler frischer normaler Boden, 5 m², Nordseite oder Gebäudeschatten. Ziel: blühende und blattschmuckreiche Schattenstauden, die auch im tiefen Schatten gedeihen.',
  },
  {
    slug: 'cottage-garten',
    label: 'Cottage-Garten 8 m²',
    licht: 'Halbschatten',
    feuchtigkeit: ['normal'],
    prompt: 'Halbschatten bis Sonne, normaler Gartenboden, 8 m², Cottage/Englischer Gartenstil. Ziel: romantisch-üppig, Pastelltöne (Rosa, Lila, Weiß), duftende Stauden, langer Blütenflor, englischer Landgartenstil.',
  },
  {
    slug: 'vorgarten',
    label: 'Vorgarten 6 m²',
    licht: 'Halbschatten',
    feuchtigkeit: ['normal'],
    prompt: 'Halbschatten, normaler Gartenboden, 6 m², repräsentativer Vorgarten. Ziel: ganzjährig ordentlich und ansprechend, winterhart, pflegeleicht, immergrüne Elemente, strukturgebende Arten.',
  },
];

function getPflanzenAusDB(licht, feuchtigkeiten) {
  const lichtKw = licht === 'Schatten' ? '%Schatten%' : licht === 'Sonne' ? '%Sonne%' : '%Halbschatten%';
  const fp = feuchtigkeiten.map(() => '?').join(',');
  return db.prepare(`
    SELECT id, name_deutsch, name_botanisch, hoehe_cm_min, hoehe_cm_max, farbe,
           bienen_freundlich, bluehzeit, rolle_empfehlung, wuchs
    FROM pflanzen
    WHERE status='live' AND bild_url IS NOT NULL AND bild_url != ''
      AND licht LIKE ? AND feuchtigkeit IN (${fp})
      AND (wuchs IS NULL OR wuchs != 'invasiv')
    ORDER BY pflege_sterne DESC
    LIMIT 60
  `).all(lichtKw, ...feuchtigkeiten);
}

function matchPflanze(kiName, dbPflanzen) {
  const norm = s => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const kiNorm = norm(kiName);
  // Exakter Match
  let match = dbPflanzen.find(p =>
    norm(p.name_deutsch) === kiNorm || norm(p.name_botanisch) === kiNorm
  );
  if (match) return match;
  // Teilstring Match (Gattungsname)
  const genus = kiNorm.split(/\s/)[0];
  match = dbPflanzen.find(p =>
    norm(p.name_botanisch).startsWith(genus) || norm(p.name_deutsch).includes(genus)
  );
  return match || null;
}

async function generiereAuswahl(szenario, dbPflanzen) {
  const pflanzenListe = dbPflanzen.slice(0, 40).map(p =>
    `${p.name_deutsch} (${p.name_botanisch}), ${p.hoehe_cm_max || '?'} cm, Blüte: ${p.bluehzeit || '?'}, Farbe: ${p.farbe || '?'}${p.bienen_freundlich ? ', bienenfreundlich' : ''}`
  ).join('\n');

  const prompt = `Du bist ein erfahrener Staudenspezialist. Wähle aus der folgenden Pflanzenliste genau 5 Stauden aus, die ideal für dieses Beet sind:

STANDORT: ${szenario.prompt}

VERFÜGBARE PFLANZEN (wähle NUR aus dieser Liste):
${pflanzenListe}

Kriterien für die Auswahl:
- Verschiedene Blühzeiten (Frühling bis Herbst abdecken)
- Unterschiedliche Höhen (Staffelung von vorne nach hinten)
- Gute optische Kombination (Farben, Formen)
- Mindestens 1 Leitstaude, 2 Begleitstauden, 1-2 Füllstauden

Antworte NUR mit einem JSON-Array mit genau 5 Objekten:
[
  { "name_deutsch": "...", "name_botanisch": "...", "rolle": "Leitstaude/Begleitstaude/Füllstaude", "begruendung": "kurz warum" }
]`;

  const resp = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.3,
    response_format: { type: 'json_object' },
  });

  const raw = resp.choices[0].message.content;
  // JSON aus Antwort extrahieren (kann Array oder Objekt mit Array sein)
  let arr;
  try {
    const parsed = JSON.parse(raw);
    arr = Array.isArray(parsed) ? parsed : Object.values(parsed).find(v => Array.isArray(v));
  } catch {
    throw new Error(`JSON parse fehler: ${raw.substring(0, 200)}`);
  }
  if (!arr || !arr.length) throw new Error('Kein Array in Antwort');
  return arr;
}

async function main() {
  const result = {};
  console.log(`\n=== Kuratierte Pflanzenlisten für ${SZENARIEN.length} Beispiele ===\n`);

  for (const sz of SZENARIEN) {
    process.stdout.write(`[${sz.slug}] ${sz.label.padEnd(25)} `);
    try {
      const dbPflanzen = getPflanzenAusDB(sz.licht, sz.feuchtigkeit);
      if (dbPflanzen.length < 5) {
        console.log(`⚠️  Nur ${dbPflanzen.length} Pflanzen in DB — überspringe`);
        continue;
      }

      const kiAuswahl = await generiereAuswahl(sz, dbPflanzen);
      const ids = [];
      const details = [];

      for (const ki of kiAuswahl) {
        const match = matchPflanze(ki.name_deutsch, dbPflanzen) ||
                      matchPflanze(ki.name_botanisch, dbPflanzen);
        if (match) {
          ids.push(match.id);
          details.push(`  ✓ ${match.name_deutsch} (${ki.rolle})`);
        } else {
          // Fallback: erste passende aus DB nehmen die noch nicht drin ist
          const fallback = dbPflanzen.find(p => !ids.includes(p.id));
          if (fallback) {
            ids.push(fallback.id);
            details.push(`  ~ ${fallback.name_deutsch} [Fallback für: ${ki.name_deutsch}]`);
          }
        }
      }

      result[sz.slug] = ids.slice(0, 5);
      console.log(`✅ ${ids.length} Pflanzen`);
      details.forEach(d => console.log(d));

      await new Promise(r => setTimeout(r, 2000)); // Rate-limit
    } catch (e) {
      console.log(`❌ ${e.message}`);
    }
    console.log('');
  }

  const outPath = path.join(__dirname, 'beispiel-pflanzen.json');
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2));
  console.log(`\n✅ Gespeichert: ${outPath}`);
  console.log(JSON.stringify(result, null, 2));
  db.close();
}

main().catch(console.error);
