// Generiert ausführliche Pflegetexte für alle Pflanzenseiten via gpt-4o.
// Ausfuehren: node scripts/enrich-plant-pages.js
// Idempotent — überspringt Pflanzen mit vorhandenem inhalt_lang.

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const Database = require('better-sqlite3');
const { OpenAI } = require('openai');
const path = require('path');

const db = new Database(path.join(__dirname, '..', 'stauden.db'));
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

try { db.exec(`ALTER TABLE pflanzen ADD COLUMN inhalt_lang TEXT`); console.log('✓ Spalte inhalt_lang hinzugefügt'); } catch {}

const UPDATE = db.prepare(`UPDATE pflanzen SET inhalt_lang = ? WHERE id = ?`);
const PFLANZEN = db.prepare(`
  SELECT id, name_deutsch, name_botanisch, beschreibung, licht, boden, stil,
         bluehzeit, farbe, hoehe_cm_min, hoehe_cm_max, pflege_sterne,
         bienen_freundlich, heimisch, feuchtigkeit
  FROM pflanzen WHERE inhalt_lang IS NULL ORDER BY id
`).all();

async function enrichPlant(p) {
  const hoehe = (p.hoehe_cm_min && p.hoehe_cm_max) ? `${p.hoehe_cm_min}–${p.hoehe_cm_max} cm` : `${p.hoehe_cm_min || p.hoehe_cm_max || 50} cm`;

  const prompt = `Du bist ein erfahrener deutscher Staudenspezialist. Erstelle präzise, praxisnahe Pflegeinformationen für folgende Gartenstaude:

Name: ${p.name_deutsch} (${p.name_botanisch})
Beschreibung: ${p.beschreibung || ''}
Standort: ${p.licht || ''}, ${p.boden || ''}, Feuchtigkeit: ${p.feuchtigkeit || 'normal'}
Höhe: ${hoehe} | Blüte: ${p.bluehzeit || ''} | Farbe: ${p.farbe || ''}
Stil: ${p.stil || ''} | Pflege: ${'★'.repeat(p.pflege_sterne || 2)}
${p.bienen_freundlich ? 'Bienenfreundlich.' : ''} ${p.heimisch ? 'Heimisch in Deutschland.' : ''}

Antworte als valides JSON (kein Markdown):
{
  "pflanzzeit": "1–2 Sätze wann und wie pflanzen",
  "pflanzabstand": "konkrete cm-Angabe + Stück pro m²",
  "giessen": "1–2 Sätze Bewässerungsbedarf",
  "duengen": "1–2 Sätze Düngung",
  "rueckschnitt": "1–2 Sätze wann und wie zurückschneiden",
  "ueberwinterung": "1 Satz Winterhärte und Schutz falls nötig",
  "kombinationen": [
    {"name_botanisch": "...", "name_deutsch": "...", "grund": "kurze Begründung warum diese Kombination funktioniert"},
    {"name_botanisch": "...", "name_deutsch": "...", "grund": "..."},
    {"name_botanisch": "...", "name_deutsch": "...", "grund": "..."}
  ],
  "fehler": ["häufiger Fehler 1", "häufiger Fehler 2", "häufiger Fehler 3"],
  "tipp": "1 konkreter Experten-Tipp der einen Mehrwert bietet"
}`;

  const res = await openai.chat.completions.create({
    model: 'gpt-4o',
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.4,
    response_format: { type: 'json_object' },
  });

  return JSON.parse(res.choices[0].message.content);
}

async function main() {
  console.log(`=== Pflanzenseiten anreichern: ${PFLANZEN.length} Pflanzen ohne Inhalt ===\n`);
  let ok = 0, err = 0;

  for (const p of PFLANZEN) {
    try {
      const data = await enrichPlant(p);
      UPDATE.run(JSON.stringify(data), p.id);
      console.log(`✓ ${p.name_deutsch}`);
      ok++;
    } catch (e) {
      console.error(`✗ ${p.name_deutsch}: ${e.message}`);
      err++;
    }
    await new Promise(r => setTimeout(r, 1200));
  }

  const total = db.prepare(`SELECT COUNT(*) as n FROM pflanzen WHERE inhalt_lang IS NOT NULL`).get().n;
  console.log(`\n=== Fertig: ${ok} neu, ${err} Fehler, ${total} gesamt mit Inhalt ===`);
  db.close();
}

main().catch(console.error);
