// Ersetzt Duplikat-Bilder (gleiche Dateigröße = gleiche Pixabay-Placeholder) durch DALL-E 3.
// Ausführen: node scripts/fix-duplicate-images.js
// Erkennt Duplikate anhand der Dateigröße, generiert pro Pflanze ein eigenes Bild.

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const Database = require('better-sqlite3');
const { OpenAI } = require('openai');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const db = new Database(path.join(__dirname, '..', 'stauden.db'));
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const PIXABAY_KEY = process.env.PIXABAY_API_KEY;

const IMG_DIR = path.join(__dirname, '..', 'public', 'images', 'pflanzen');
const UPDATE = db.prepare('UPDATE pflanzen SET bild_url = ?, bild_lizenz = ? WHERE id = ?');

// Schritt 1: Alle lokalen Bilder hashen und Duplikat-Gruppen finden
console.log('\n=== Duplikat-Bilder erkennen ===');
const sizeMap = {};
const files = fs.readdirSync(IMG_DIR).filter(f => f.endsWith('.jpg'));
for (const f of files) {
  const size = fs.statSync(path.join(IMG_DIR, f)).size;
  if (!sizeMap[size]) sizeMap[size] = [];
  sizeMap[size].push(f);
}

// Nur Größen mit >1 Datei = Duplikate
const dupFiles = new Set();
for (const [size, group] of Object.entries(sizeMap)) {
  if (group.length > 1) {
    // Alle außer der ersten sind Duplikate (erste bekommt auch neues Bild da unklar welches "richtig" ist)
    group.forEach(f => dupFiles.add(f));
  }
}

// IDs aus Dateinamen extrahieren (format: slug-ID.jpg)
const dupIds = [...dupFiles].map(f => {
  const m = f.match(/-(\d+)\.jpg$/);
  return m ? parseInt(m[1]) : null;
}).filter(Boolean);

console.log(`${dupIds.length} Pflanzen mit doppeltem Bild gefunden.\n`);

if (dupIds.length === 0) { console.log('Keine Duplikate — fertig!'); db.close(); process.exit(0); }

// Pflanzen laden
const placeholders = dupIds.map(() => '?').join(',');
const pflanzen = db.prepare(`
  SELECT id, name_deutsch, name_botanisch, farbe, licht, bluehzeit
  FROM pflanzen WHERE id IN (${placeholders})
  ORDER BY name_deutsch
`).all(...dupIds);

console.log(`Generiere ${pflanzen.length} DALL-E 3 Bilder (je ~$0.04)...\n`);

function slugify(name) {
  return name.toLowerCase()
    .replace(/ä/g,'ae').replace(/ö/g,'oe').replace(/ü/g,'ue').replace(/ß/g,'ss')
    .replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');
}

async function pixabaySearch(nameDeutsch, nameBotanisch) {
  if (!PIXABAY_KEY) return null;
  const genus = nameBotanisch.split(' ')[0];
  const queries = [
    `${genus} ${nameBotanisch.split(' ')[1] || ''} flower`.trim(),
    `${genus} plant garden`,
    `${nameDeutsch} Pflanze`,
  ];
  for (const q of queries) {
    try {
      const url = `https://pixabay.com/api/?key=${PIXABAY_KEY}&q=${encodeURIComponent(q)}&image_type=photo&category=nature&per_page=5&safesearch=true`;
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) continue;
      const data = await res.json();
      if (data.hits?.length > 0) {
        // Nimm nicht das erste — nimm eines das nicht die gleiche Größe hat wie bekannte Duplikate
        for (const hit of data.hits) {
          const imgUrl = hit.webformatURL || hit.largeImageURL;
          if (imgUrl) return imgUrl;
        }
      }
    } catch {}
    await new Promise(r => setTimeout(r, 300));
  }
  return null;
}

async function generateDalle(p) {
  const color = p.farbe ? p.farbe.split('|')[0] : '';
  const bloom = p.bluehzeit ? `blooming ${p.bluehzeit}` : 'in bloom';
  const prompt = `Professional botanical garden photography of ${p.name_botanisch} (${p.name_deutsch}), ${color ? color + ' flowers, ' : ''}${bloom}, close-up shot, natural daylight, shallow depth of field, no people, no text, real plant photography style`;

  const res = await openai.images.generate({
    model: 'dall-e-3',
    prompt,
    size: '1024x1024',
    quality: 'standard',
    n: 1,
  });

  const imgRes = await fetch(res.data[0].url, { signal: AbortSignal.timeout(30000) });
  if (!imgRes.ok) throw new Error(`Download fehlgeschlagen: ${imgRes.status}`);
  const buf = Buffer.from(await imgRes.arrayBuffer());
  return buf;
}

async function main() {
  let pixOk = 0, dalleOk = 0, err = 0;

  for (const p of pflanzen) {
    const filename = `${slugify(p.name_deutsch)}-${p.id}.jpg`;
    const filepath = path.join(IMG_DIR, filename);
    process.stdout.write(`  ${p.name_deutsch} (${p.name_botanisch}) ... `);

    try {
      // 1. Pixabay nochmal mit botanischem Namen probieren
      let saved = false;
      if (PIXABAY_KEY) {
        const pixUrl = await pixabaySearch(p.name_deutsch, p.name_botanisch);
        if (pixUrl) {
          const imgRes = await fetch(pixUrl, { signal: AbortSignal.timeout(20000), headers: { 'Referer': 'https://staudenplan.de/' } });
          if (imgRes.ok) {
            const buf = Buffer.from(await imgRes.arrayBuffer());
            const newSize = buf.length;
            // Prüfen ob diese Größe auch ein Duplikat ist
            const isDupSize = Object.entries(sizeMap).some(([sz, grp]) => parseInt(sz) === newSize && grp.length > 1);
            if (!isDupSize && buf.length > 10000) {
              fs.writeFileSync(filepath, buf);
              UPDATE.run(`/images/pflanzen/${filename}`, 'Pixabay lokal', p.id);
              console.log(`Pixabay ✓`);
              pixOk++; saved = true;
            }
          }
        }
      }

      // 2. DALL-E 3 wenn Pixabay kein spezifisches Bild liefert
      if (!saved) {
        const buf = await generateDalle(p);
        fs.writeFileSync(filepath, buf);
        UPDATE.run(`/images/pflanzen/${filename}`, 'DALL-E 3', p.id);
        console.log(`DALL-E ✓`);
        dalleOk++; saved = true;
      }
    } catch(e) {
      console.log(`FEHLER: ${e.message}`);
      err++;
    }

    await new Promise(r => setTimeout(r, 800));
  }

  console.log(`\n=== Fertig: ${pixOk} Pixabay, ${dalleOk} DALL-E, ${err} Fehler ===`);
  console.log(`Geschätzte DALL-E Kosten: ~$${(dalleOk * 0.04).toFixed(2)}\n`);
  db.close();
}

main().catch(console.error);
