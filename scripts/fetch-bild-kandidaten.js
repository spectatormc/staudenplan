// Sucht für jede manuell geprüfte Pflanze (bild_geprueft=1) 3 Bildkandidaten auf Pixabay.
// Ergebnis wird in bild_kandidaten (JSON-Array) gespeichert.
// Ausführen: node scripts/fetch-bild-kandidaten.js
// Optional:  --ids=1,2,3  (nur bestimmte Pflanzen)
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const Database = require('better-sqlite3');
const path     = require('path');
const https    = require('https');
const fs       = require('fs');

const db          = new Database(path.join(__dirname, '..', 'stauden.db'));
const PIXABAY_KEY = process.env.PIXABAY_API_KEY;
const IMG_DIR     = path.join(__dirname, '..', 'public', 'images', 'pflanzen');
const UPDATE      = db.prepare('UPDATE pflanzen SET bild_kandidaten = ? WHERE id = ?');

const args = process.argv.slice(2);
const IDS  = (() => { const i = args.find(a => a.startsWith('--ids=')); return i ? i.split('=')[1].split(',').map(Number) : null; })();

let where = "bild_geprueft = 1 AND status = 'staging'";
if (IDS?.length) where = `id IN (${IDS.join(',')})`;

const pflanzen = db.prepare(`SELECT id, name_deutsch, name_botanisch FROM pflanzen WHERE ${where} ORDER BY id`).all();
console.log(`\n=== Bildkandidaten für ${pflanzen.length} Pflanzen ===\n`);

async function pixabayMulti(query, n = 3) {
  try {
    const url = `https://pixabay.com/api/?key=${PIXABAY_KEY}&q=${encodeURIComponent(query)}&image_type=photo&category=nature&per_page=${n + 2}&safesearch=true`;
    const res  = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.hits || []).slice(0, n).map(h => h.largeImageURL || h.webformatURL).filter(Boolean);
  } catch { return []; }
}

function downloadLocal(url, id, idx) {
  return new Promise((resolve) => {
    const dest = path.join(IMG_DIR, `kandidat-${id}-${idx}.jpg`);
    if (fs.existsSync(dest)) return resolve(`/images/pflanzen/kandidat-${id}-${idx}.jpg`);
    const proto = url.startsWith('https') ? https : require('http');
    const file  = fs.createWriteStream(dest);
    proto.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, res => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        file.close(); fs.unlink(dest, () => {});
        return downloadLocal(res.headers.location, id, idx).then(resolve);
      }
      if (res.statusCode !== 200) { file.close(); fs.unlink(dest, () => {}); return resolve(null); }
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(`/images/pflanzen/kandidat-${id}-${idx}.jpg`); });
    }).on('error', () => { fs.unlink(dest, () => {}); resolve(null); });
  });
}

async function main() {
  for (const p of pflanzen) {
    process.stdout.write(`[${p.id}] ${p.name_deutsch.padEnd(38)} `);
    const genus   = p.name_botanisch.split(' ')[0];
    const queries = [
      `${p.name_botanisch} plant flower`,
      `${p.name_deutsch} Garten Blüte`,
      `${genus} garden perennial`,
    ];

    const urls = new Set();
    for (const q of queries) {
      if (urls.size >= 3) break;
      const hits = await pixabayMulti(q, 3);
      for (const u of hits) { if (urls.size < 3) urls.add(u); }
      await new Promise(r => setTimeout(r, 300));
    }

    const pixUrls = [...urls].slice(0, 3);
    if (!pixUrls.length) { console.log('✗ keine Kandidaten gefunden'); continue; }

    // Lokal herunterladen
    const localPaths = [];
    for (let i = 0; i < pixUrls.length; i++) {
      const local = await downloadLocal(pixUrls[i], p.id, i + 1);
      if (local) localPaths.push(local);
    }

    UPDATE.run(JSON.stringify(localPaths), p.id);
    console.log(`✓ ${localPaths.length} Kandidaten gespeichert`);
    await new Promise(r => setTimeout(r, 500));
  }

  const n = db.prepare("SELECT COUNT(*) as n FROM pflanzen WHERE bild_kandidaten IS NOT NULL").get().n;
  console.log(`\n=== Fertig. ${n} Pflanzen haben jetzt Kandidaten. ===`);
  console.log(`→ Auswahl unter: /auswahl-pflanzen?key=preview2026`);
  db.close();
}

main().catch(console.error);
