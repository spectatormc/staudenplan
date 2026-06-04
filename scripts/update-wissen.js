// Sucht per Brave Search API nach neuen Publikationen ueber Staudenverwendung
// und speichert aufbereitete Zusammenfassungen in der wissen-Datenbank.
// Ausfuehren: node scripts/update-wissen.js
// Auch als Modul nutzbar: module.exports = { runUpdate }

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const Database = require('better-sqlite3');
const { OpenAI } = require('openai');
const path = require('path');

const SUCHANFRAGEN = [
  { query: 'Staudenverwendung Bepflanzungsplanung Privatgarten', kategorie: 'Grundprinzipien' },
  { query: 'naturnahe Bepflanzung Stauden Garten Deutschland', kategorie: 'Oekologie' },
  { query: 'Staudenkombinationen Verwendungsplanung Gartenbeet', kategorie: 'Kombinationen' },
  { query: 'Staudenbeet anlegen Planung Tipps Pflanzauswahl', kategorie: 'Praxis' },
  { query: 'Lebensbereich Stauden RSL naturnaher Garten', kategorie: 'Grundprinzipien' },
  { query: 'Staudenplanung Sonne Halbschatten Schatten Auswahl', kategorie: 'Standorte' },
  { query: 'bienenfreundliche Stauden Insektengarten Deutschland', kategorie: 'Oekologie' },
];

async function runUpdate(db, openai) {
  let erstellt = 0;
  const log = [];

  if (!process.env.BRAVE_SEARCH_API_KEY) {
    log.push('BRAVE_SEARCH_API_KEY fehlt — Web-Update nicht moeglich.');
    return { erstellt, log };
  }

  for (const { query, kategorie } of SUCHANFRAGEN) {
    log.push(`\nSuche: "${query}"`);

    let urls = [];
    try {
      const searchRes = await fetch(
        `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=4&lang=de&country=DE`,
        {
          headers: {
            'Accept': 'application/json',
            'Accept-Encoding': 'identity',
            'X-Subscription-Token': process.env.BRAVE_SEARCH_API_KEY
          }
        }
      );
      const searchData = await searchRes.json();
      urls = (searchData.web?.results || [])
        .filter(r => r.url && !r.url.includes('youtube') && !r.url.includes('pinterest'))
        .map(r => ({ url: r.url, titel: r.title || '' }))
        .slice(0, 4);
    } catch (err) {
      log.push(`  Suche fehlgeschlagen: ${err.message}`);
      continue;
    }

    for (const { url, titel } of urls) {
      // Skip already processed URLs
      const known = db.prepare('SELECT id FROM wissen_quellen WHERE url = ?').get(url);
      if (known) { log.push(`  [skip] ${url}`); continue; }

      let pageText = '';
      try {
        const pageRes = await fetch(url, {
          signal: AbortSignal.timeout(6000),
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; StaudenBot/1.0)' }
        });
        const html = await pageRes.text();
        // Strip HTML, extract readable text
        pageText = html
          .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
          .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
          .replace(/<[^>]+>/g, ' ')
          .replace(/&[a-z]+;/gi, ' ')
          .replace(/\s+/g, ' ')
          .trim()
          .substring(0, 4000);
      } catch (err) {
        log.push(`  [fetch fail] ${url}: ${err.message}`);
        db.prepare('INSERT OR IGNORE INTO wissen_quellen (url, titel, eintraege_erstellt) VALUES (?,?,0)').run(url, titel);
        continue;
      }

      if (pageText.length < 200) {
        log.push(`  [zu kurz] ${url}`);
        continue;
      }

      let summary = '';
      try {
        const completion = await openai.chat.completions.create({
          model: 'gpt-4o-mini',
          messages: [
            {
              role: 'system',
              content: 'Du bist Staudenexperte. Extrahiere aus dem Webseiteninhalt relevantes Fachwissen ueber Staudenverwendung und Bepflanzungsplanung als praezisen Fachtext von 200-350 Woertern auf Deutsch. Nur wirklich relevante Inhalte. Falls der Text nicht relevant ist, antworte exakt mit: IRRELEVANT'
            },
            {
              role: 'user',
              content: `URL: ${url}\nQuelle-Titel: ${titel}\n\nSeiteninhalt:\n${pageText}`
            }
          ],
          temperature: 0.2,
          max_tokens: 600
        });
        summary = completion.choices[0].message.content.trim();
      } catch (err) {
        log.push(`  [KI-Fehler] ${err.message}`);
        continue;
      }

      if (summary === 'IRRELEVANT' || summary.includes('IRRELEVANT')) {
        log.push(`  [irrelevant] ${url}`);
        db.prepare('INSERT OR IGNORE INTO wissen_quellen (url, titel, eintraege_erstellt) VALUES (?,?,0)').run(url, titel);
        continue;
      }

      // Extract a short title from the URL/title
      const kurzTitel = titel.length > 5 ? titel.substring(0, 80) : `Webartikel: ${query}`;

      db.prepare(`
        INSERT INTO wissen (titel, inhalt, kategorie, quelle, datum)
        VALUES (?, ?, ?, ?, date('now'))
      `).run(kurzTitel, summary, kategorie, url);

      db.prepare('INSERT OR IGNORE INTO wissen_quellen (url, titel, eintraege_erstellt) VALUES (?,?,1)').run(url, titel);

      log.push(`  [OK] ${url.substring(0, 60)}...`);
      erstellt++;

      await new Promise(r => setTimeout(r, 800));
    }
  }

  return { erstellt, log };
}

// Standalone-Ausfuehrung
if (require.main === module) {
  const db = new Database(path.join(__dirname, '..', 'stauden.db'));
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  runUpdate(db, openai).then(({ erstellt, log }) => {
    log.forEach(l => console.log(l));
    console.log(`\n=== ${erstellt} neue Wissens-Eintraege erstellt ===`);
    db.close();
  }).catch(console.error);
}

module.exports = { runUpdate };
