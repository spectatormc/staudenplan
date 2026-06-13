// Generiert KI-Bilder für live-Pflanzen mit abgelaufenen externen URLs.
// Setzt bild_url direkt (kein Staging) — Pflanze bleibt live.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const Database = require('better-sqlite3');
const { OpenAI } = require('openai');
const fs   = require('fs');
const path = require('path');

const db     = new Database(path.join(__dirname, '..', 'stauden.db'));
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const IMG_DIR = path.join(__dirname, '..', 'public', 'images', 'pflanzen');
if (!fs.existsSync(IMG_DIR)) fs.mkdirSync(IMG_DIR, { recursive: true });

// IDs der live-Pflanzen mit abgelaufenen Pixabay-URLs
const BROKEN_IDS = [185,190,191,196,207,212,225,233,241,274,277,280,281,284,287,309,310,317,328,333,341,344,348,351,356,357,367,376,388,392,404,425,426,446,450,460,480,496,501,559,577,608,609,636,652,677,717,734];

const args  = process.argv.slice(2);
const LIMIT = (() => { const l = args.find(a => a.startsWith('--limit=')); return l ? parseInt(l.split('=')[1]) : BROKEN_IDS.length; })();

const pflanzen = db.prepare(
  `SELECT id, name_deutsch, name_botanisch, farbe FROM pflanzen WHERE id IN (${BROKEN_IDS.join(',')}) ORDER BY id LIMIT ${LIMIT}`
).all();

if (!pflanzen.length) {
  console.log('Keine Pflanzen gefunden.'); db.close(); process.exit(0);
}

console.log(`\n=== KI-Fix für ${pflanzen.length} live-Pflanzen mit abgelaufenen Bildern ===`);
console.log(`Geschätzte Kosten: ~${(pflanzen.length * 0.04).toFixed(2)} $\n`);

function buildPrompt(p) {
  const farbe = (p.farbe || '').split(',').slice(0,2).map(s => s.trim()).filter(Boolean).join(' and ');
  const farbeHinweis = farbe ? ` with ${farbe} flowers` : '';
  return `Photorealistic garden photograph of the full plant ${p.name_botanisch} (${p.name_deutsch})${farbeHinweis}. `
    + `Show the entire plant including stems, leaves and flowers to reveal its natural shape and growth habit. `
    + `Plant in a garden bed, natural daylight, blurred green garden background. `
    + `No text, no watermarks, no people. High quality plant photography.`;
}

const UPDATE = db.prepare(
  "UPDATE pflanzen SET bild_url=?, bild_lizenz='KI-generiert / OpenAI', bild_ki=1 WHERE id=?"
);

async function main() {
  let ok = 0, fail = 0;
  for (const p of pflanzen) {
    process.stdout.write(`[${p.id}] ${p.name_deutsch.padEnd(40)} `);
    const prompt = buildPrompt(p);

    try {
      const resp = await openai.images.generate({
        model:         'gpt-image-1',
        prompt,
        n:             1,
        size:          '1024x1024',
        quality:       'medium',
        output_format: 'jpeg',
      });

      const slug     = p.name_deutsch.toLowerCase()
        .replace(/ä/g,'ae').replace(/ö/g,'oe').replace(/ü/g,'ue').replace(/ß/g,'ss')
        .replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,40);
      const filename = `ki-${slug}-${p.id}.jpg`;
      const dest     = path.join(IMG_DIR, filename);
      const localUrl = `/images/pflanzen/${filename}`;

      const b64 = resp.data[0].b64_json;
      if (!b64) throw new Error('Kein b64_json');
      fs.writeFileSync(dest, Buffer.from(b64, 'base64'));

      UPDATE.run(localUrl, p.id);
      console.log(`✅ ${localUrl}`);
      ok++;
    } catch (e) {
      console.log(`❌ ${e.message}`);
      fail++;
    }

    await new Promise(r => setTimeout(r, 13000));
  }

  console.log(`\n=== Fertig. ${ok} ersetzt, ${fail} Fehler. ===`);
  db.close();
}

main().catch(console.error);
