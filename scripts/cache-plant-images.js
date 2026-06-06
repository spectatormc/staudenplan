// Lädt alle Pixabay-Bilder herunter und speichert sie lokal unter public/images/pflanzen/
// Damit sind Bilder immer verfügbar (kein Hotlinking = kein 403-Problem).
// Ausführen: node scripts/cache-plant-images.js
// Optionen: --missing (nur Pflanzen ohne lokale URL), --force (alle neu laden)

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const args = process.argv.slice(2);
const FORCE = args.includes('--force');

const PIXABAY_KEY = process.env.PIXABAY_API_KEY;
const db = new Database(path.join(__dirname, '..', 'stauden.db'));

const IMG_DIR = path.join(__dirname, '..', 'public', 'images', 'pflanzen');
if (!fs.existsSync(IMG_DIR)) fs.mkdirSync(IMG_DIR, { recursive: true });

const UPDATE = db.prepare('UPDATE pflanzen SET bild_url = ?, bild_lizenz = ? WHERE id = ?');

// Nur Pflanzen mit externen URLs (Pixabay-Links) verarbeiten
const where = FORCE
  ? "name_deutsch != 'Test-Pflanze'"
  : "name_deutsch != 'Test-Pflanze' AND bild_url IS NOT NULL AND bild_url NOT LIKE '/images/%'";

const pflanzen = db.prepare(`SELECT id, name_deutsch, name_botanisch, bild_url FROM pflanzen WHERE ${where}`).all();

function slugify(name) {
  return name.toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

async function pixabaySearch(nameDeutsch, nameBotanisch) {
  if (!PIXABAY_KEY) return null;
  const genus = nameBotanisch.split(' ')[0];
  const queries = [
    `${nameDeutsch} Blüte`,
    `${genus} flower`,
    `${nameDeutsch}`,
    `${genus} garden`,
  ];
  for (const q of queries) {
    try {
      const url = `https://pixabay.com/api/?key=${PIXABAY_KEY}&q=${encodeURIComponent(q)}&image_type=photo&category=nature&per_page=3&safesearch=true`;
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) continue;
      const data = await res.json();
      // webformatURL bevorzugen (für Anzeige geeignet), largeImageURL als Fallback
      const hit = data.hits?.[0];
      if (hit) return hit.webformatURL || hit.largeImageURL || null;
    } catch {}
    await new Promise(r => setTimeout(r, 300));
  }
  return null;
}

async function downloadImage(srcUrl, filename) {
  const res = await fetch(srcUrl, {
    signal: AbortSignal.timeout(20000),
    headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://staudenplan.de/' }
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 5000) throw new Error(`Bild zu klein (${buf.length} bytes) — wahrscheinlich Fehlerseite`);
  const filepath = path.join(IMG_DIR, filename);
  fs.writeFileSync(filepath, buf);
  return `/images/pflanzen/${filename}`;
}

async function main() {
  console.log(`\n=== Pflanzenbilder lokal cachen (${pflanzen.length} zu verarbeiten) ===\n`);
  let ok = 0, err = 0;

  for (const p of pflanzen) {
    const filename = `${slugify(p.name_deutsch)}-${p.id}.jpg`;
    const localPath = `/images/pflanzen/${filename}`;
    process.stdout.write(`  ${p.name_deutsch} ... `);

    try {
      // Wenn bereits lokale Datei existiert und nicht --force: überspringen
      if (!FORCE && fs.existsSync(path.join(IMG_DIR, filename))) {
        UPDATE.run(localPath, 'lokal gecacht', p.id);
        console.log(`übersprungen (Datei vorhanden)`);
        ok++; continue;
      }

      // 1. Aktuelle URL versuchen herunterzuladen
      let srcUrl = p.bild_url;
      let downloaded = false;

      if (srcUrl && !srcUrl.startsWith('/images/')) {
        try {
          const localUrl = await downloadImage(srcUrl, filename);
          UPDATE.run(localUrl, 'lokal gecacht', p.id);
          console.log(`✓ heruntergeladen (${srcUrl.substring(0,50)}…)`);
          ok++; downloaded = true;
        } catch (e) {
          process.stdout.write(`Download fehlgeschlagen (${e.message}) → Pixabay … `);
        }
      }

      // 2. Pixabay neu suchen falls Download fehlschlug
      if (!downloaded && PIXABAY_KEY) {
        const newUrl = await pixabaySearch(p.name_deutsch, p.name_botanisch);
        if (newUrl) {
          const localUrl = await downloadImage(newUrl, filename);
          UPDATE.run(localUrl, 'Pixabay lokal', p.id);
          console.log(`✓ Pixabay neu`);
          ok++; downloaded = true;
        }
      }

      if (!downloaded) { console.log(`✗ kein Bild`); err++; }
    } catch (e) {
      console.log(`FEHLER: ${e.message}`);
      err++;
    }

    await new Promise(r => setTimeout(r, 400));
  }

  const local = db.prepare("SELECT COUNT(*) as n FROM pflanzen WHERE bild_url LIKE '/images/%'").get().n;
  console.log(`\n=== Fertig: ${ok} OK, ${err} Fehler | ${local} Pflanzen mit lokalem Bild ===\n`);
  db.close();
}

main().catch(console.error);
