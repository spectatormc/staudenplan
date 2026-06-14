// Erweitert dünne Ratgeber-Artikel (<1500Z) per GPT-4o-mini auf ~2000-2500 Zeichen.
// Behält bestehenden Inhalt, ergänzt nur fehlende Tiefe.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const Database = require('better-sqlite3');
const { OpenAI } = require('openai');

const db = new Database(require('path').join(__dirname, '..', 'stauden.db'));
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const args = process.argv.slice(2);
const LIMIT = (() => { const l = args.find(a => a.startsWith('--limit=')); return l ? parseInt(l.split('=')[1]) : 30; })();

const artikel = db.prepare(
  'SELECT rowid, titel, inhalt, kategorie FROM wissen WHERE LENGTH(inhalt)<1500 ORDER BY LENGTH(inhalt) ASC LIMIT ?'
).all(LIMIT);

if (!artikel.length) { console.log('Keine dünnen Artikel gefunden.'); db.close(); process.exit(0); }

console.log(`\n=== Erweitere ${artikel.length} dünne Ratgeber-Artikel ===\n`);

const UPDATE = db.prepare('UPDATE wissen SET inhalt=? WHERE rowid=?');

async function erweitere(a) {
  const prompt = `Du bist ein erfahrener Gartenexperte und schreibst für den deutschsprachigen Hobbygärtner.

Thema: "${a.titel}"
Kategorie: ${a.kategorie}

Bestehender Kurztext (soll erweitert werden):
${a.inhalt}

Aufgabe: Erweitere diesen Text auf 2000–2500 Zeichen. Behalte alle vorhandenen Inhalte bei und ergänze:
- Konkrete Pflanzennamen mit botanischen Namen in Klammern (mindestens 4–6 Arten)
- Praktische Gestaltungshinweise und Pflege-Tipps
- Saisonale Aspekte (was wann blüht oder wirkt)
- Einen abschließenden praktischen Tipp

Schreibe ohne Überschriften, in fließenden Absätzen, direkt und praxisnah. Kein Markdown, keine Aufzählungszeichen.`;

  const resp = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.7,
    max_tokens: 900,
  });

  return resp.choices[0].message.content.trim();
}

async function main() {
  let ok = 0, fail = 0;
  for (const a of artikel) {
    process.stdout.write(`[${a.rowid}] ${a.titel.slice(0, 55).padEnd(55)} `);
    try {
      const neu = await erweitere(a);
      UPDATE.run(neu, a.rowid);
      const len = neu.length;
      const words = neu.split(/\s+/).filter(w => w.length > 2).length;
      console.log(`✅ ${len}Z ~${words}W`);
      ok++;
    } catch (e) {
      console.log(`❌ ${e.message}`);
      fail++;
    }
    await new Promise(r => setTimeout(r, 800));
  }
  console.log(`\n=== Fertig. ${ok} erweitert, ${fail} Fehler. ===`);
  db.close();
}

main().catch(console.error);
