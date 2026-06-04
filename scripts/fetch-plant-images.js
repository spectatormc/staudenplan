// Lädt Pflanzenbilder von Wikipedia für alle Einträge in der DB.
// Ausfuehren: node scripts/fetch-plant-images.js
// Idempotent — überspringt Pflanzen mit vorhandenem Bild.

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, '..', 'stauden.db'));

// Spalte hinzufuegen falls nicht vorhanden
try { db.exec('ALTER TABLE pflanzen ADD COLUMN bild_url TEXT'); } catch {}
try { db.exec('ALTER TABLE pflanzen ADD COLUMN bild_lizenz TEXT'); } catch {}

const UPDATE = db.prepare('UPDATE pflanzen SET bild_url = ?, bild_lizenz = ? WHERE id = ?');
const PFLANZEN = db.prepare('SELECT id, name_botanisch, name_deutsch FROM pflanzen WHERE bild_url IS NULL ORDER BY id').all();

async function getWikipediaImage(query) {
  // Versuche zuerst mit exaktem botanischen Namen
  const wikis = [
    `https://de.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(query)}`,
    `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(query)}`,
  ];

  for (const url of wikis) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'StaudenplanBot/1.0 (https://www.staudenplan.de; info@freisinger-gartenschmiede.de)' },
        signal: AbortSignal.timeout(5000)
      });
      if (!res.ok) continue;
      const data = await res.json();
      if (data.originalimage?.source) {
        return { url: data.originalimage.source, lizenz: 'Wikipedia Commons' };
      }
      if (data.thumbnail?.source) {
        // Thumbnail auf hoehste Qualitaet umschreiben
        const highRes = data.thumbnail.source.replace(/\/\d+px-/, '/640px-');
        return { url: highRes, lizenz: 'Wikipedia Commons' };
      }
    } catch {}
  }

  // Fallback: Wikipedia-API Bildsuche
  try {
    const searchUrl = `https://en.wikipedia.org/w/api.php?action=query&titles=${encodeURIComponent(query)}&prop=pageimages&pithumbsize=640&format=json&origin=*`;
    const res = await fetch(searchUrl, { signal: AbortSignal.timeout(5000) });
    if (res.ok) {
      const data = await res.json();
      const pages = data.query?.pages || {};
      for (const page of Object.values(pages)) {
        if (page.thumbnail?.source) return { url: page.thumbnail.source, lizenz: 'Wikipedia Commons' };
      }
    }
  } catch {}

  return null;
}

async function main() {
  console.log(`=== Pflanzenbilder holen (${PFLANZEN.length} ohne Bild) ===\n`);
  let gefunden = 0, nicht = 0;

  for (const p of PFLANZEN) {
    const result = await getWikipediaImage(p.name_botanisch);

    if (result) {
      UPDATE.run(result.url, result.lizenz, p.id);
      console.log(`✓ ${p.name_deutsch} — ${result.url.substring(0, 70)}…`);
      gefunden++;
    } else {
      console.log(`✗ ${p.name_deutsch} (${p.name_botanisch}) — kein Bild`);
      nicht++;
    }

    // Rate limiting: Wikipedia erlaubt ~200 req/min, wir nehmen 2/sek
    await new Promise(r => setTimeout(r, 500));
  }

  const total = db.prepare('SELECT COUNT(*) as n FROM pflanzen WHERE bild_url IS NOT NULL').get().n;
  console.log(`\n=== Fertig: ${gefunden} neu gefunden, ${nicht} nicht gefunden, ${total} gesamt mit Bild ===`);
  db.close();
}

main().catch(console.error);
