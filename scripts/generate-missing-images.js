// Generiert fehlende Pflanzenbilder: zuerst Pixabay, dann DALL-E 3 als Fallback.
// DALL-E-Bilder werden lokal gespeichert unter public/images/pflanzen/<slug>.jpg
// Ausführen: node scripts/generate-missing-images.js
// Optionen: --force (alle neu laden), --dalle-only, --pixabay-only

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const Database = require('better-sqlite3');
const { OpenAI } = require('openai');
const path = require('path');
const fs = require('fs');

const args = process.argv.slice(2);
const FORCE = args.includes('--force');
const DALLE_ONLY = args.includes('--dalle-only');
const PIXABAY_ONLY = args.includes('--pixabay-only');

const PIXABAY_KEY = process.env.PIXABAY_API_KEY;
const db = new Database(path.join(__dirname, '..', 'stauden.db'));
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Verzeichnis für KI-generierte Bilder
const IMG_DIR = path.join(__dirname, '..', 'public', 'images', 'pflanzen');
if (!fs.existsSync(IMG_DIR)) fs.mkdirSync(IMG_DIR, { recursive: true });

const UPDATE = db.prepare('UPDATE pflanzen SET bild_url = ?, bild_lizenz = ? WHERE id = ?');

const query = FORCE
  ? "SELECT id, name_deutsch, name_botanisch, farbe, licht, boden FROM pflanzen WHERE name_deutsch != 'Test-Pflanze'"
  : "SELECT id, name_deutsch, name_botanisch, farbe, licht, boden FROM pflanzen WHERE name_deutsch != 'Test-Pflanze' AND (bild_url IS NULL OR bild_url = '')";
const PFLANZEN = db.prepare(query).all();

// ── Pixabay ─────────────────────────────────────────────────────────────────
async function pixabaySearch(query) {
  if (!PIXABAY_KEY) return null;
  const url = `https://pixabay.com/api/?key=${PIXABAY_KEY}&q=${encodeURIComponent(query)}&image_type=photo&category=nature&per_page=3&safesearch=true&lang=de`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const data = await res.json();
    return data.hits?.[0]?.largeImageURL || data.hits?.[0]?.webformatURL || null;
  } catch { return null; }
}

async function getPixabayImage(p) {
  const genus = p.name_botanisch.split(' ')[0];
  const queries = [
    `${p.name_deutsch} Blüte Garten`,
    `${genus} flower garden`,
    `${p.name_deutsch} Staude`,
    `${genus} plant`,
  ];
  for (const q of queries) {
    const url = await pixabaySearch(q);
    if (url) return url;
    await new Promise(r => setTimeout(r, 350));
  }
  return null;
}

// ── DALL-E 3 ─────────────────────────────────────────────────────────────────
function slugify(name) {
  return name.toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

async function generateDalleImage(p) {
  const prompt = `Professional garden photography: ${p.name_botanisch} (${p.name_deutsch}), close-up of flowering plant in a naturalistic perennial garden, soft natural light, shallow depth of field, botanical illustration quality, green background, no text, no people`;

  const res = await openai.images.generate({
    model: 'dall-e-3',
    prompt,
    size: '1024x1024',
    quality: 'standard',
    n: 1,
  });

  const imageUrl = res.data[0].url;

  // Bild herunterladen und lokal speichern (URL läuft ab)
  const imgRes = await fetch(imageUrl, { signal: AbortSignal.timeout(30000) });
  if (!imgRes.ok) throw new Error(`Download fehlgeschlagen: ${imgRes.status}`);

  const filename = `${slugify(p.name_deutsch)}-${p.id}.jpg`;
  const filepath = path.join(IMG_DIR, filename);
  const buffer = Buffer.from(await imgRes.arrayBuffer());
  fs.writeFileSync(filepath, buffer);

  return `/images/pflanzen/${filename}`;
}

// ── Hauptschleife ─────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n=== Fehlende Pflanzenbilder generieren ===`);
  console.log(`Zu verarbeiten: ${PFLANZEN.length} Pflanzen\n`);

  let pixabayOk = 0, dalleOk = 0, err = 0;

  for (const p of PFLANZEN) {
    process.stdout.write(`  ${p.name_deutsch} ... `);

    try {
      // 1. Pixabay versuchen
      let url = null;
      let lizenz = null;

      if (!DALLE_ONLY && PIXABAY_KEY) {
        url = await getPixabayImage(p);
        if (url) {
          lizenz = 'Pixabay License';
          pixabayOk++;
          console.log(`Pixabay ✓`);
        }
      }

      // 2. DALL-E 3 als Fallback
      if (!url && !PIXABAY_ONLY) {
        url = await generateDalleImage(p);
        lizenz = 'DALL-E 3 generated';
        dalleOk++;
        console.log(`DALL-E ✓  →  ${url}`);
      }

      if (!url) {
        console.log(`kein Bild`);
        err++;
        continue;
      }

      UPDATE.run(url, lizenz, p.id);
    } catch (e) {
      console.log(`FEHLER: ${e.message}`);
      err++;
    }

    // Rate limit
    await new Promise(r => setTimeout(r, 500));
  }

  const withImg = db.prepare("SELECT COUNT(*) as n FROM pflanzen WHERE bild_url IS NOT NULL AND bild_url != ''").get().n;
  console.log(`\n=== Fertig: ${pixabayOk} Pixabay, ${dalleOk} DALL-E, ${err} Fehler ===`);
  console.log(`Gesamt mit Bild: ${withImg} Pflanzen\n`);
  db.close();
}

main().catch(console.error);
