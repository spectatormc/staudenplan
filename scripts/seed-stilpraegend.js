// Generiert 8 neue Stilpraegend-Ratgeber via gpt-4o und schreibt sie in die DB.
// Ausfuehren: node scripts/seed-stilpraegend.js

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const Database = require('better-sqlite3');
const { OpenAI } = require('openai');
const path = require('path');

const db = new Database(path.join(__dirname, '..', 'stauden.db'));
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const INSERT = db.prepare(`INSERT INTO wissen (titel, inhalt, kategorie, quelle, datum) VALUES (?, ?, ?, ?, ?)`);
const HEUTE = new Date().toISOString().split('T')[0];

const THEMEN = [
  {
    titel: 'Prairie-Stil — Naturalistische Pflanzenverwendung nach Piet Oudolf',
    kategorie: 'Stilpraegend',
    keywords: 'Prairie-Stil Garten, Piet Oudolf Deutschland, naturalistische Staudenverwendung, New Wave Planting'
  },
  {
    titel: 'Japanischer Garten — Stille und Harmonie mit Stauden',
    kategorie: 'Stilpraegend',
    keywords: 'japanischer Garten Stauden, Zen-Garten Stauden, japanischer Gartenstil Deutschland, asiatischer Garten'
  },
  {
    titel: 'Mediterraner Garten — Hitzestabile Stauden für Südeuropa-Flair',
    kategorie: 'Stilpraegend',
    keywords: 'mediterraner Garten Stauden, Mittelmeer Gartenstil, trockenheitsresistente Stauden, Kiesgarten mediterran'
  },
  {
    titel: 'Formaler Garten — Symmetrie und klassische Ordnung mit Stauden',
    kategorie: 'Stilpraegend',
    keywords: 'formaler Garten Stauden, klassischer Gartenstil, Barockgarten Stauden, strukturierter Garten'
  },
  {
    titel: 'Steingarten und Alpinum — Stauden für felsige Anlagen',
    kategorie: 'Stilpraegend',
    keywords: 'Steingarten Stauden, Alpinum Stauden, Felsgarten bepflanzen, alpine Stauden Garten'
  },
  {
    titel: 'Minimalistischer Stadtgarten — Weniger ist mehr',
    kategorie: 'Stilpraegend',
    keywords: 'minimalistischer Garten Stauden, Stadtgarten minimalistisch, moderner Garten Stauden, cleaner Gartenstil'
  },
  {
    titel: 'Schattenstauden-Garten — Das Staudenbeet unter Bäumen gestalten',
    kategorie: 'Stilpraegend',
    keywords: 'Schattenstauden Garten, Staudenbeet unter Bäumen, Schattenstauden gestalten, Waldgarten Stauden'
  },
  {
    titel: 'Heidegarten — Nordische Stimmung mit Gräsern und Stauden',
    kategorie: 'Stilpraegend',
    keywords: 'Heidegarten Stauden, Heidegarten gestalten, Eriken Gräser Stauden, nordischer Gartenstil'
  },
];

async function generateArtikel(thema) {
  const prompt = `Du bist ein erfahrener deutscher Gartenexperte und schreibst für das Portal staudenplan.de.

Schreibe einen praxisnahen, informativen Ratgeber-Artikel zum Thema: "${thema.titel}"

Zielgruppe: Hobbygärtner in Deutschland, die einen eigenen Garten haben.
Keywords: ${thema.keywords}

Anforderungen:
- 650–850 Wörter
- Praktische, umsetzbare Informationen
- Nenne konkrete Pflanzennamen (deutsche Namen) mit kurzen Erklärungen
- Strukturiert in 4–6 Absätze (kein Markdown, nur Fließtext, Absätze mit \\n getrennt)
- Ersten Absatz als Einleitung die neugierig macht
- Letzten Absatz als Handlungsempfehlung ("Tipp: ...")
- Kein "Fazit:" oder "Zusammenfassung:" am Ende
- Nur deutschsprachig, duze den Leser nicht

Antworte NUR mit dem Artikeltext, ohne Titel, ohne Formatierung.`;

  const res = await openai.chat.completions.create({
    model: 'gpt-4o',
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.7,
  });
  return res.choices[0].message.content.trim();
}

async function main() {
  console.log(`Generiere ${THEMEN.length} Stilpraegend-Artikel...\n`);
  for (const thema of THEMEN) {
    process.stdout.write(`  → ${thema.titel} ... `);
    try {
      const inhalt = await generateArtikel(thema);
      INSERT.run(thema.titel, inhalt, thema.kategorie, 'gpt-4o', HEUTE);
      console.log('OK');
    } catch (e) {
      console.log(`FEHLER: ${e.message}`);
    }
  }
  console.log('\nFertig.');
  db.close();
}

main();
