// Lädt Pflanzenbilder von Pixabay (Pixabay License — kostenlos, kommerziell erlaubt, keine Attribution nötig).
// Voraussetzung: PIXABAY_API_KEY in .env
// Ausfuehren: node scripts/fetch-plant-images.js
// Idempotent — überspringt Pflanzen mit vorhandenem Bild.

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const Database = require('better-sqlite3');
const path = require('path');

const PIXABAY_KEY = process.env.PIXABAY_API_KEY;
if (!PIXABAY_KEY) {
  console.error('PIXABAY_API_KEY fehlt in .env!');
  console.error('Kostenlos registrieren: https://pixabay.com/api/docs/');
  process.exit(1);
}

const db = new Database(path.join(__dirname, '..', 'stauden.db'));

try { db.exec('ALTER TABLE pflanzen ADD COLUMN bild_url TEXT'); } catch {}
try { db.exec('ALTER TABLE pflanzen ADD COLUMN bild_lizenz TEXT'); } catch {}

const UPDATE = db.prepare('UPDATE pflanzen SET bild_url = ?, bild_lizenz = ? WHERE id = ?');
const PFLANZEN = db.prepare('SELECT id, name_botanisch, name_deutsch FROM pflanzen WHERE bild_url IS NULL ORDER BY id').all();

async function pixabaySearch(query) {
  const url = `https://pixabay.com/api/?key=${PIXABAY_KEY}&q=${encodeURIComponent(query)}&image_type=photo&category=nature&per_page=3&safesearch=true&lang=de`;
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) return null;
  const data = await res.json();
  return data.hits?.[0]?.largeImageURL || data.hits?.[0]?.webformatURL || null;
}

async function getPixabayImage(nameDeutsch, nameBotanisch) {
  const genus = nameBotanisch.split(' ')[0];

  const queries = [
    `${nameDeutsch} Blüte Garten`,
    `${genus} flower garden`,
    `${nameDeutsch} Staude`,
    `${genus} plant`,
  ];

  for (const q of queries) {
    try {
      const url = await pixabaySearch(q);
      if (url) return url;
    } catch {}
    await new Promise(r => setTimeout(r, 300));
  }
  return null;
}

async function main() {
  console.log(`=== Pflanzenbilder von Pixabay (${PFLANZEN.length} ohne Bild) ===\n`);
  let gefunden = 0, nicht = 0;

  for (const p of PFLANZEN) {
    const url = await getPixabayImage(p.name_deutsch, p.name_botanisch);

    if (url) {
      UPDATE.run(url, 'Pixabay License', p.id);
      console.log(`✓ ${p.name_deutsch} — ${url.substring(0, 70)}…`);
      gefunden++;
    } else {
      console.log(`✗ ${p.name_deutsch} (${p.name_botanisch}) — kein Bild`);
      nicht++;
    }

    // Pixabay: max 100 req/min im Free-Tier
    await new Promise(r => setTimeout(r, 700));
  }

  const total = db.prepare('SELECT COUNT(*) as n FROM pflanzen WHERE bild_url IS NOT NULL').get().n;
  console.log(`\n=== Fertig: ${gefunden} neu, ${nicht} ohne Bild, ${total} gesamt ===`);
  db.close();
}

main().catch(console.error);
