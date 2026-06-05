// Generiert 20 neue SEO-Ratgeber-Artikel (Phase 2) via gpt-4o.
// Ausfuehren: node scripts/seed-ratgeber-phase2.js

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const Database = require('better-sqlite3');
const { OpenAI } = require('openai');
const path = require('path');

const db = new Database(path.join(__dirname, '..', 'stauden.db'));
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const INSERT = db.prepare(`INSERT INTO wissen (titel, inhalt, kategorie, quelle, datum) VALUES (?, ?, ?, ?, ?)`);
const HEUTE = new Date().toISOString().split('T')[0];

const THEMEN = [
  // Praxis
  { titel: 'Stauden düngen — wann, womit und wie viel?', kategorie: 'Praxis', keywords: 'Stauden düngen, Staudenbeet düngen, Biodünger Stauden' },
  { titel: 'Stauden vermehren — Teilen, Aussaat und Stecklinge leicht gemacht', kategorie: 'Praxis', keywords: 'Stauden vermehren, Stauden teilen, Stecklinge Stauden' },
  { titel: 'Stauden schneiden — der richtige Rückschnitt für jede Art', kategorie: 'Praxis', keywords: 'Stauden schneiden, Stauden zurückschneiden, Rückschnitt Stauden' },
  { titel: 'Stauden pflanzen — die optimale Pflanzzeit im Frühjahr und Herbst', kategorie: 'Praxis', keywords: 'Stauden pflanzen, Pflanzzeit Stauden, Stauden einpflanzen' },
  { titel: 'Staudenbeet anlegen — Kosten, Planung und Schritt-für-Schritt-Anleitung', kategorie: 'Praxis', keywords: 'Staudenbeet anlegen, Kosten Staudenbeet, Staudenbeet planen' },
  { titel: 'Stauden teilen — warum und wann man Stauden aufteilen sollte', kategorie: 'Praxis', keywords: 'Stauden teilen, Staudenhorste teilen, Stauden verjüngen' },
  // Standorte
  { titel: 'Stauden für Kübel und Balkon — die robustesten Sorten', kategorie: 'Standorte', keywords: 'Stauden Kübel, Balkonstauden, Stauden Balkon Kübel' },
  { titel: 'Stauden für den Vorgarten — pflegeleichte Ideen für die Straßenfront', kategorie: 'Standorte', keywords: 'Stauden Vorgarten, Vorgarten Stauden pflegeleicht, Staudenbeet Vorgarten' },
  { titel: 'Stauden für Trockenmauern und Steingärten', kategorie: 'Standorte', keywords: 'Stauden Trockenmauer, Steingarten Stauden, Trockenmauer bepflanzen' },
  { titel: 'Stauden für den Teichrand und Feuchtbeet', kategorie: 'Standorte', keywords: 'Stauden Teichrand, Feuchtbeet Stauden, Sumpfpflanzen Teich' },
  { titel: 'Stauden für Nordhang und Schattenhang — Lösungen für schwierige Lagen', kategorie: 'Standorte', keywords: 'Stauden Nordhang, Schattenhang bepflanzen, Hang Stauden Schatten' },
  { titel: 'Stauden für den Stadtgarten — hitzeverträglich und pflegeleicht', kategorie: 'Standorte', keywords: 'Stauden Stadtgarten, Stadtgarten Stauden, hitzeverträgliche Stauden' },
  // Gestaltung
  { titel: 'Staudenbeet Ideen — 10 inspirierende Gestaltungsbeispiele', kategorie: 'Gestaltung', keywords: 'Staudenbeet Ideen, Staudenbeet Gestaltung, Staudenbeet Beispiele' },
  { titel: 'Stauden die den ganzen Sommer blühen — Dauerbüher für das Beet', kategorie: 'Gestaltung', keywords: 'Stauden die lange blühen, Dauerblüher Stauden, Stauden ganzer Sommer' },
  { titel: 'Herbststauden — die schönsten Arten für Farbe im Herbst', kategorie: 'Gestaltung', keywords: 'Herbststauden, Stauden Herbst, Herbstblüher Stauden' },
  { titel: 'Stauden für weiße Beete — Weißgarten im eigenen Garten anlegen', kategorie: 'Gestaltung', keywords: 'Weißgarten Stauden, weiße Stauden, weißes Staudenbeet' },
  // Ökologie & Spezial
  { titel: 'Winterharte Stauden für Deutschland — was wirklich den Winter übersteht', kategorie: 'Oekologie', keywords: 'winterharte Stauden, Stauden winterhart, frostharte Stauden' },
  { titel: 'Ungiftige Stauden für Gärten mit Kindern und Haustieren', kategorie: 'Oekologie', keywords: 'ungiftige Stauden, Stauden Kinder sicher, giftige Stauden vermeiden' },
  { titel: 'Bodendecker Stauden — flächendeckende Pflanzen für weniger Unkraut', kategorie: 'Standorte', keywords: 'Bodendecker Stauden, Stauden als Bodendecker, flächendeckende Stauden' },
  { titel: 'Stauden kaufen — worauf beim Kauf in Gärtnerei und Online-Shop achten', kategorie: 'Praxis', keywords: 'Stauden kaufen, Stauden online kaufen, Stauden Gärtnerei kaufen' },
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
    temperature: 0.5,
  });
  return res.choices[0].message.content.trim();
}

async function main() {
  console.log(`=== SEO Ratgeber Phase 2: ${THEMEN.length} Artikel ===\n`);
  let neu = 0, skip = 0;

  for (const t of THEMEN) {
    const exists = db.prepare('SELECT COUNT(*) as n FROM wissen WHERE titel = ?').get(t.titel).n;
    if (exists) { console.log(`- Übersprungen: ${t.titel}`); skip++; continue; }

    try {
      const inhalt = await generateArtikel(t);
      INSERT.run(t.titel, inhalt, t.kategorie, 'Staudenplan-Redaktion', HEUTE);
      console.log(`✓ ${t.titel} (${inhalt.length} Zeichen)`);
      neu++;
    } catch (e) {
      console.error(`✗ ${t.titel}: ${e.message}`);
    }
    await new Promise(r => setTimeout(r, 1500));
  }

  const total = db.prepare('SELECT COUNT(*) as n FROM wissen').get().n;
  console.log(`\n=== Fertig: ${neu} neue Artikel, ${skip} übersprungen, ${total} gesamt ===`);
  db.close();
}

main().catch(console.error);
