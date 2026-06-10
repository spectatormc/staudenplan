// Generiert einen gezielten SEO-Ratgeber für "Bepflanzungsplan online erstellen"
// Ausfuehren: node scripts/seed-online-ratgeber.js

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
    titel: 'Bepflanzungsplan online erstellen — der kostenlose KI-Planer für dein Staudenbeet',
    kategorie: 'Praxis',
    keywords: 'Bepflanzungsplan online erstellen, Gartenplaner online kostenlos, Staudenbeet online planen, Beetplanung online Tool, Bepflanzungsplan kostenlos'
  },
  {
    titel: 'Gartenplanung online — mit KI zum fertigen Staudenbeet-Plan',
    kategorie: 'Praxis',
    keywords: 'Gartenplanung online, Gartenplaner online kostenlos, Staudenbeet planen online, Gartengestaltung online Tool, Gartenplan online erstellen'
  },
  {
    titel: 'Staudenbeet planen online — Schritt für Schritt mit dem KI-Gartenplaner',
    kategorie: 'Praxis',
    keywords: 'Staudenbeet planen online, Staudenbeet online gestalten, Beetplanung online kostenlos, Staudenbeet Planer Tool, Staudenplan online'
  }
];

async function generateArtikel(thema) {
  const prompt = `Du bist ein erfahrener deutscher Gartenexperte und schreibst für das Portal staudenplan.de — einem kostenlosen Online-Gartenplaner der KI nutzt um personalisierte Bepflanzungspläne für Staudenbeete zu erstellen.

Schreibe einen praxisnahen, informativen Ratgeber-Artikel zum Thema: "${thema.titel}"

Zielgruppe: Hobbygärtner in Deutschland, die einen Bepflanzungsplan online erstellen möchten und nach einem kostenlosen Tool suchen.
Keywords: ${thema.keywords}

Kontext zum Tool: staudenplan.de ist ein kostenloser Online-Planer der in 5 einfachen Schritten einen personalisierten Staudenbeet-Plan erstellt — mit Standortanalyse, Stilauswahl, KI-Pflanzauswahl aus über 486 winterharten Stauden, grafischem Bepflanzungsplan, Höhenansicht und Stückliste zum Bestellen.

Anforderungen:
- 700–900 Wörter
- Erkläre warum digitale/online Planung besser als Papier ist (Änderungen, Visualisierung, Datenbank)
- Erkläre die Vorteile eines KI-gestützten Planers: Standorteignung automatisch geprüft, Pflanzenkombinationen bewährt, keine Fachkenntnisse nötig
- Nenne konkrete Beispiele was ein guter Online-Planer leisten sollte
- Strukturiert in 5–6 Absätze (kein Markdown, nur Fließtext, Absätze mit \\n getrennt)
- Erster Absatz: Problem/Situation (viele wollen ein schönes Beet, wissen aber nicht wie planen)
- Letzter Absatz: Handlungsempfehlung mit konkretem Hinweis auf kostenlosen Online-Planer
- Kein "Fazit:" — direkt als Empfehlung formulieren
- Nur deutschsprachig, duze den Leser nicht

Antworte NUR mit dem Artikeltext, ohne Titel, ohne Formatierung.`;

  const res = await openai.chat.completions.create({
    model: 'gpt-4o',
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.7,
    max_tokens: 1200
  });

  return res.choices[0].message.content.trim();
}

(async () => {
  for (const thema of THEMEN) {
    const exists = db.prepare('SELECT titel FROM wissen WHERE titel = ?').get(thema.titel);
    if (exists) { console.log('Bereits vorhanden, überspringe:', thema.titel); continue; }

    console.log('Generiere:', thema.titel);
    try {
      const inhalt = await generateArtikel(thema);
      INSERT.run(thema.titel, inhalt, thema.kategorie, 'KI-generiert', HEUTE);
      console.log('✅ Eingefügt:', thema.titel, `(${inhalt.split(' ').length} Wörter)`);
    } catch (e) {
      console.error('Fehler bei', thema.titel, e.message);
    }
  }
  console.log('\nFertig. Neue DB-Größe:', db.prepare('SELECT COUNT(*) as n FROM wissen').get().n, 'Artikel');
  db.close();
})();
