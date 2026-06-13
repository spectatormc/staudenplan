// Generiert KI-Bilder (DALL-E 3) für Pflanzen ohne gutes Foto.
// Ergebnis wird als bild_vorschlag gespeichert + bild_ki=1 markiert.
//
// Ausführen:  node scripts/generate-ki-bilder.js
// Optionen:
//   --limit=10       Anzahl Pflanzen (default: 10)
//   --ids=1,2,3      Bestimmte Pflanzen-IDs
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const Database = require('better-sqlite3');
const { OpenAI } = require('openai');
const https    = require('https');
const http     = require('http');
const fs       = require('fs');
const path     = require('path');

const db     = new Database(path.join(__dirname, '..', 'stauden.db'));
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// bild_ki Spalte anlegen falls noch nicht vorhanden
try {
  db.exec("ALTER TABLE pflanzen ADD COLUMN bild_ki INTEGER DEFAULT 0");
  console.log('✅ Spalte bild_ki hinzugefügt.');
} catch (e) {
  if (!e.message.includes('duplicate column')) throw e;
}

const IMG_DIR = path.join(__dirname, '..', 'public', 'images', 'pflanzen');
if (!fs.existsSync(IMG_DIR)) fs.mkdirSync(IMG_DIR, { recursive: true });

const args  = process.argv.slice(2);
const LIMIT = (() => { const l = args.find(a => a.startsWith('--limit=')); return l ? parseInt(l.split('=')[1]) : 10; })();
const IDS   = (() => { const i = args.find(a => a.startsWith('--ids=')); return i ? i.split('=')[1].split(',').map(Number).filter(Boolean) : null; })();

let where = "status='staging' AND (bild_ki IS NULL OR bild_ki=0)";
if (IDS?.length) where = `id IN (${IDS.join(',')})`;

const pflanzen = db.prepare(`
  SELECT id, name_deutsch, name_botanisch, farbe
  FROM pflanzen WHERE ${where}
  ORDER BY id LIMIT ${LIMIT}
`).all();

if (!pflanzen.length) {
  console.log('Keine passenden Pflanzen gefunden.');
  db.close();
  process.exit(0);
}

console.log(`\n=== KI-Bildgenerierung (DALL-E 3) für ${pflanzen.length} Pflanzen ===`);
console.log(`Geschätzte Kosten: ~${(pflanzen.length * 0.04).toFixed(2)} $ (${pflanzen.length} × $0.04)\n`);

function buildPrompt(p) {
  const farbe = (p.farbe || '').split(',').slice(0,2).map(s => s.trim()).filter(Boolean).join(' and ');
  const farbeHinweis = farbe ? ` with ${farbe} flowers` : '';
  return `Photorealistic garden photograph of the full plant ${p.name_botanisch} (${p.name_deutsch})${farbeHinweis}. `
    + `Show the entire plant including stems, leaves and flowers to reveal its natural shape and growth habit. `
    + `Plant in a garden bed, natural daylight, blurred green garden background. `
    + `No text, no watermarks, no people. High quality plant photography.`;
}

function downloadImage(url, dest) {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith('https') ? https : http;
    const file  = fs.createWriteStream(dest);
    proto.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, res => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        file.close(); fs.unlink(dest, () => {});
        return downloadImage(res.headers.location, dest).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        file.close(); fs.unlink(dest, () => {});
        return reject(new Error('HTTP ' + res.statusCode));
      }
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(); });
    }).on('error', err => { fs.unlink(dest, () => {}); reject(err); });
  });
}

const UPDATE = db.prepare("UPDATE pflanzen SET bild_vorschlag=?, bild_check_info=?, bild_ki=1, status='staging' WHERE id=?");

async function main() {
  for (const p of pflanzen) {
    process.stdout.write(`[${p.id}] ${p.name_deutsch.padEnd(38)} `);
    const prompt = buildPrompt(p);

    try {
      const resp = await openai.images.generate({
        model:          'gpt-image-1',
        prompt,
        n:              1,
        size:           '1024x1024',
        quality:        'medium',
        output_format:  'jpeg',
      });

      const slug     = (p.name_deutsch).toLowerCase()
        .replace(/ä/g,'ae').replace(/ö/g,'oe').replace(/ü/g,'ue').replace(/ß/g,'ss')
        .replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,40);
      const filename = `ki-${slug}-${p.id}.jpg`;
      const dest     = path.join(IMG_DIR, filename);
      const localUrl = `/images/pflanzen/${filename}`;

      // gpt-image-1 gibt base64 zurück, keine URL
      const b64 = resp.data[0].b64_json;
      if (!b64) throw new Error('Kein b64_json in Response');
      fs.writeFileSync(dest, Buffer.from(b64, 'base64'));

      UPDATE.run(
        localUrl,
        JSON.stringify({ ki: true, prompt: prompt.slice(0, 200), lizenz: 'KI-generiert / OpenAI' }),
        p.id
      );
      console.log(`✅ gespeichert → ${localUrl}`);

    } catch (e) {
      console.log(`❌ Fehler: ${e.message}`);
    }

    // Rate-limit: DALL-E 3 = 5 img/min (Standard Tier)
    await new Promise(r => setTimeout(r, 13000));
  }

  const n = db.prepare("SELECT COUNT(*) as n FROM pflanzen WHERE bild_ki=1").get().n;
  console.log(`\n=== Fertig. ${n} KI-Bilder gesamt in der DB. ===`);
  console.log(`→ Review unter: /admin?key=preview2026  (Tab "KI Bild")`);
  db.close();
}

main().catch(console.error);
