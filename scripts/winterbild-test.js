/*
 * TESTLAUF: Wie sieht ein eigenes WINTERBILD je Staude aus?
 *
 * Hintergrund: Die Pin-Sorte pflanze-winter zeigt heute dasselbe Bild wie der Bluehzeit-Pin —
 * also die Pflanze in Bluete, waehrend der Pin von Winterstruktur spricht. Es gibt je Pflanze
 * nur ein KI-Bild. Dieses Skript prueft, ob sich ein brauchbares Winterbild ueberhaupt
 * erzeugen laesst, BEVOR dafuer eine Spalte, ein Ausgabepfad und eine Pipeline gebaut werden.
 *
 * WAS ES NICHT TUT: Es fasst die Datenbank nicht an — kein bild_vorschlag, kein bild_url,
 * keine Spalte. Die Bilder landen unter public/winterbild-test/ und sind von aussen
 * erreichbar, damit man sie ansehen kann; sie haengen an keinem Pin und an keiner Seite.
 *
 * Ausfuehren:
 *   node scripts/winterbild-test.js                 alle Testpflanzen, beide Fassungen
 *   node scripts/winterbild-test.js --ids=265,598   nur diese
 *   node scripts/winterbild-test.js --fassung=a     nur eine Fassung
 *   node scripts/winterbild-test.js --trocken       nur die Auftraege zeigen, nichts erzeugen
 *
 * WARUM ZWEI FASSUNGEN: Welcher Auftrag ein brauchbares Bild ergibt, ist nicht herleitbar,
 * sondern nur zu sehen. Fassung A beschreibt den ZUSTAND der Pflanze im Winter und verbietet
 * Blueten ausdruecklich; Fassung B beschreibt eine WINTERSZENE mit Raureif und tiefem Licht.
 * Beide bekommen denselben Satz zum Winteraspekt — den, der auch auf der Kachel steht.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { OpenAI } = require('openai');

const argv = process.argv.slice(2);
const wert = n => { const a = argv.find(x => x.startsWith(`--${n}=`)); return a ? a.split('=')[1] : null; };
const TROCKEN = argv.includes('--trocken');
const IDS = (wert('ids') || '').split(',').map(Number).filter(Boolean);
const FASSUNG = (wert('fassung') || '').toLowerCase();

const WURZEL = path.join(__dirname, '..');
const ZIEL = path.join(WURZEL, 'public', 'winterbild-test');
const db = new Database(path.join(WURZEL, 'stauden.db'), { readonly: true });
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/* Was im Winter ZU SEHEN ist, haengt am Aspekt — ein Samenstand sieht anders aus als eine
 * wintergruene Rosette. Die Schluessel sind dieselben wie in WINTER_WERT (scripts/pin-saison.js);
 * eine zweite Werteliste waere eine zweite Fassung derselben Regel. Hier steht nur, WIE der
 * Zustand im Bild aussieht — die deutsche Beschriftung kommt weiterhin aus pin-saison.js. */
const ASPEKT = {
  'samenstand dekorativ': 'The plant has finished flowering: dry, brown and beige seed heads on stiff standing stems, no petals left, foliage withered. The dried seed heads are the subject.',
  'gräser struktur': 'The ornamental grass is dormant: straw-coloured and golden-brown dry blades and flower plumes, still upright and arching, no green growth. The dry winter silhouette is the subject.',
  'blätter immergrün': 'The plant is evergreen and keeps its foliage through winter: firm green leaves, no flowers, surrounded by the bare dormant garden.',
  'rosetten wintergrün': 'The plant overwinters as a flat evergreen rosette of leaves close to the ground, no flowers, no tall stems.',
  'blätter halbimmergrün': 'The plant is semi-evergreen in winter: a low mound of leathery leaves, some tinged bronze or reddish from the cold, no flowers.',
  'struktur': 'The plant is dormant but keeps its structure: dry standing stems and remains of foliage, no flowers.',
};

const FASSUNGEN = {
  a: (p, aspekt) => `Photorealistic garden photograph of ${p.name_botanisch} (${p.name_deutsch}) in WINTER, in a German garden in December. `
    + `${aspekt} `
    + `Hoar frost on the plant, low winter sunlight, bare dormant garden bed behind it, muted winter colours. `
    + `IMPORTANT: absolutely no flowers, no blossoms, no fresh green spring growth — this is the winter state of the plant. `
    + `Show the whole plant and its shape. No text, no watermarks, no people. High quality plant photography.`,

  b: (p, aspekt) => `Photorealistic winter garden scene, close view of ${p.name_botanisch} (${p.name_deutsch}) as the subject. `
    + `${aspekt} `
    + `A light dusting of snow and frost, overcast cold daylight, a quiet winter garden with bare soil and dormant perennials behind. `
    + `IMPORTANT: no flowers and no blossoms of any kind. `
    + `Show the whole plant and its shape. No text, no watermarks, no people. High quality plant photography.`,
};

const TEST_IDS = [265, 598, 448, 257, 90];
const auswahl = (IDS.length ? IDS : TEST_IDS);
const pflanzen = db.prepare(
  `SELECT id, name_deutsch, name_botanisch, winteraspekt FROM pflanzen WHERE id IN (${auswahl.join(',')})`
).all();

const fassungen = FASSUNG ? [FASSUNG] : ['a', 'b'];
console.log(`\n=== Winterbild-Test: ${pflanzen.length} Pflanzen x ${fassungen.length} Fassung(en) ===`);
if (!TROCKEN) console.log(`Geschaetzte Kosten: ~${(pflanzen.length * fassungen.length * 0.04).toFixed(2)} $\n`);

fs.mkdirSync(ZIEL, { recursive: true });

(async () => {
  for (const p of pflanzen) {
    const schluessel = String(p.winteraspekt || '').trim().toLowerCase();
    const aspekt = ASPEKT[schluessel];
    if (!aspekt) {
      console.log(`[${p.id}] ${p.name_deutsch}: winteraspekt "${p.winteraspekt}" ist kein bekannter Schluessel — uebersprungen.`);
      continue;
    }
    for (const f of fassungen) {
      const prompt = FASSUNGEN[f](p, aspekt);
      const datei = `winter-${f}-${p.id}.jpg`;
      process.stdout.write(`[${p.id}] ${String(p.name_deutsch).padEnd(28)} ${schluessel.padEnd(22)} Fassung ${f.toUpperCase()}  `);
      if (TROCKEN) { console.log('\n    ' + prompt + '\n'); continue; }
      try {
        const resp = await openai.images.generate({
          model: 'gpt-image-1', prompt, n: 1, size: '1024x1024',
          quality: 'medium', output_format: 'jpeg',
        });
        const b64 = resp.data[0].b64_json;
        if (!b64) throw new Error('kein b64_json');
        fs.writeFileSync(path.join(ZIEL, datei), Buffer.from(b64, 'base64'));
        console.log(`OK -> /winterbild-test/${datei}`);
      } catch (e) {
        console.log(`FEHLER: ${e.message}`);
      }
      await new Promise(r => setTimeout(r, 13000)); // 5 Bilder/Minute
    }
  }
  console.log(`\nFertig. Dateien unter ${ZIEL}`);
  db.close();
})();
