// Lädt alle Staging-Pflanzenbilder mit externer URL lokal auf den Server herunter.
// Externe Pixabay-URLs laufen ab — lokale Kopien sind dauerhaft.
// Ausführen: node scripts/download-staging-images.js
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const Database = require('better-sqlite3');
const path     = require('path');
const fs       = require('fs');
const https    = require('https');
const http     = require('http');

const db       = new Database(path.join(__dirname, '..', 'stauden.db'));
const IMG_DIR  = path.join(__dirname, '..', 'public', 'images', 'pflanzen');
const UPDATE   = db.prepare("UPDATE pflanzen SET bild_url = ? WHERE id = ?");

if (!fs.existsSync(IMG_DIR)) fs.mkdirSync(IMG_DIR, { recursive: true });

const pflanzen = db.prepare(`
  SELECT id, name_deutsch, bild_url FROM pflanzen
  WHERE bild_url LIKE 'http%' AND (status = 'staging' OR bild_geprueft = 1)
  ORDER BY id
`).all();

console.log(`\n=== Bilder herunterladen: ${pflanzen.length} externe URLs ===\n`);

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith('https') ? https : http;
    const file  = fs.createWriteStream(dest);
    proto.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, res => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        file.close();
        fs.unlink(dest, () => {});
        return download(res.headers.location, dest).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        file.close();
        fs.unlink(dest, () => {});
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      res.pipe(file);
      file.on('finish', () => file.close(resolve));
    }).on('error', err => { fs.unlink(dest, () => {}); reject(err); });
  });
}

async function main() {
  let ok = 0, fehler = 0;
  for (const p of pflanzen) {
    const slug = p.name_deutsch.toLowerCase()
      .replace(/ä/g,'ae').replace(/ö/g,'oe').replace(/ü/g,'ue').replace(/ß/g,'ss')
      .replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0, 40);
    const datei = `${slug}-${p.id}.jpg`;
    const dest  = path.join(IMG_DIR, datei);
    const local = `/images/pflanzen/${datei}`;

    process.stdout.write(`[${p.id}] ${p.name_deutsch.padEnd(35)} `);
    try {
      await download(p.bild_url, dest);
      const size = fs.statSync(dest).size;
      if (size < 1000) throw new Error('Datei zu klein (wahrscheinlich Fehlerseite)');
      UPDATE.run(local, p.id);
      console.log(`✓ ${(size/1024).toFixed(0)} KB → ${local}`);
      ok++;
    } catch (e) {
      console.log(`✗ ${e.message}`);
      fehler++;
    }
    await new Promise(r => setTimeout(r, 150));
  }
  console.log(`\n=== Fertig: ${ok} heruntergeladen, ${fehler} Fehler ===`);
  db.close();
}

main().catch(console.error);
