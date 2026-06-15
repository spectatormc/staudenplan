// Generiert echte KI-Pflanzpläne für alle 8 Beet-Beispiele.
// Speichert Ergebnisse in scripts/beispiel-plan-[slug].json
// Ausführen: node scripts/generate-beispiel-plaene.js
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const https = require('https');
const fs = require('fs');
const path = require('path');

const BASE = 'http://localhost:3003';

const SZENARIEN = [
  { slug: 'schattenbeet', flaeche: 6, licht: 'Halbschatten (3–6 h)', boden: 'Normal / humos', stil: 'Gemischt/Modern', standort_beschreibung: 'Halbschatten, normaler Gartenboden, Hauswand oder Gehölzrand, ansprechendes Beet mit Blüten und Blattschmuck' },
  { slug: 'sonnenbeet', flaeche: 8, licht: 'Vollsonne (6+ h)', boden: 'Normal / humos', stil: 'Gemischt/Modern', standort_beschreibung: 'Vollsonne, normaler humoser Boden, klassisches Staudenbeet, langer Blütenflor Mai bis Oktober' },
  { slug: 'kiesgarten', flaeche: 10, licht: 'Vollsonne (6+ h)', boden: 'Sandig / durchlässig', stil: 'Natur/Wildgarten', standort_beschreibung: 'Vollsonne, sehr trockener sandiger kiesiger Boden, Kiesgarten Trockenstaudenbeet, mediterran steppenartig trockenheitsresistent' },
  { slug: 'naturgarten', flaeche: 12, licht: 'Vollsonne (6+ h)', boden: 'Normal / humos', stil: 'Natur/Wildgarten', standort_beschreibung: 'Vollsonne, wechselfeuchter normaler Boden, Naturgarten Präriecharakter, heimische Stauden bienenfreundlich hohe Biodiversität' },
  { slug: 'teichrand', flaeche: 4, licht: 'Halbschatten (3–6 h)', boden: 'Lehmig / schwer', stil: 'Natur/Wildgarten', standort_beschreibung: 'Teichrand Sumpfbeet dauerhaft feucht nass, Uferpflanzen natürlicher Übergang vom Wasser zum Garten' },
  { slug: 'nordseite', flaeche: 5, licht: 'Schatten (unter 3 h)', boden: 'Normal / humos', stil: 'Gemischt/Modern', standort_beschreibung: 'Nordseite Gebäudeschatten Dauerschatten, kühler frischer Boden, blühende und blattschmuckreiche Schattenstauden' },
  { slug: 'cottage-garten', flaeche: 8, licht: 'Halbschatten (3–6 h)', boden: 'Normal / humos', stil: 'Cottage/Englisch', standort_beschreibung: 'Romantischer Cottage-Garten, Pastelltöne Rosa Lila Weiß, duftende Stauden, üppig englischer Landgartenstil' },
  { slug: 'vorgarten', flaeche: 6, licht: 'Halbschatten (3–6 h)', boden: 'Normal / humos', stil: 'Gemischt/Modern', standort_beschreibung: 'Repräsentativer Vorgarten, ganzjährig ordentlich und ansprechend, winterhart pflegeleicht immergrüne Elemente strukturgebend' },
];

function post(url, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const opts = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
    };
    const req = require('http').request(url, opts, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); } catch { reject(new Error('JSON parse: ' + raw.slice(0, 100))); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function main() {
  console.log(`\n=== Generiere Beispiel-Pläne für ${SZENARIEN.length} Szenarien ===\n`);

  for (const sz of SZENARIEN) {
    process.stdout.write(`[${sz.slug}] ${sz.slug.padEnd(20)} `);
    try {
      const result = await post(`${BASE}/api/plan`, {
        gartenflaeche: sz.flaeche,
        licht: sz.licht,
        boden: sz.boden,
        stil: sz.stil,
        standort_beschreibung: sz.standort_beschreibung,
        farbe: 'keine Präferenz',
        saison: 'ganzjährig',
        vielfalt: 'ausgewogen',
        dichte: 'normal',
        sichtseite: 'Einseitig (Hauptansicht von vorne)',
      });

      if (!result.success) throw new Error(result.error || 'API Fehler');

      const outPath = path.join(__dirname, `beispiel-plan-${sz.slug}.json`);
      fs.writeFileSync(outPath, JSON.stringify(result.plan, null, 2));
      console.log(`✅ ${result.plan.pflanzen.length} Pflanzen, ${result.plan.gesamtkosten_geschaetzt || '?'} €`);

      await new Promise(r => setTimeout(r, 3000)); // Rate-limit
    } catch (e) {
      console.log(`❌ ${e.message}`);
    }
  }
  console.log('\n=== Fertig ===');
}

main().catch(console.error);
