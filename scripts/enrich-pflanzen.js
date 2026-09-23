// Reichert alle Pflanzen in der DB mit fehlenden Feldern via GPT-4o an.
// Fügt Spalten hinzu falls noch nicht vorhanden, dann enriched jede Pflanze.
// Ausführen: node scripts/enrich-pflanzen.js
// Optionen: --dry-run (kein DB-Schreiben), --limit=20 (nur N Pflanzen)

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const Database = require('better-sqlite3');
/*
 * DIE VOKABELLISTE KOMMT AUS scripts/lebensbereiche.js, sie steht nicht mehr hier.
 *
 * Bis zum 23.09.2026 stand sie als Beispielaufzählung im Prompt — und in ihr fehlten fünf
 * der zehn Bereiche: Gehölz, Beet, Steinanlage, Teichrand und Wasserfläche. Die Verteilung
 * der erzeugten Spalte ist deshalb das Abbild dieser Liste und nicht das der Pflanzen:
 * Gehölzrand 448 Zeilen, aber Gehölz 18; Quellflur 62, aber Teichrand 2. Eine externe
 * Stichprobe über 35 Arten fand 17 von 20 Beanstandungen an genau dieser Stelle — der
 * fehlende Bereich war keiner, den das Modell übersehen hat, sondern einer, den es nicht
 * schreiben konnte. Wurmfarn und Königsfarn stehen auf „Gehölzrand,Waldsaum", weil „Gehölz"
 * nie zur Auswahl stand.
 *
 * Zwei Vokabeln standen darin, die es im Zielsystem nicht gibt: „Waldsaum" (der Saum fällt
 * unter Gehölzrand — trotzdem 184 Zeilen) und „Staudenheide" (0 Zeilen, das Modell hat sie
 * zu Recht ignoriert). Und „bis zu 2" war ein Formatzwang: Hansen/Stahl vergibt regelmässig
 * drei Bereiche, 672 von 711 Zeilen tragen genau zwei.
 */
const { promptVokabular } = require('./lebensbereiche');
const LB_VOKABULAR = promptVokabular();
const { OpenAI } = require('openai');
const path = require('path');

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const LIMIT = (() => { const l = args.find(a => a.startsWith('--limit=')); return l ? parseInt(l.split('=')[1]) : null; })();
const ONLY_EMPTY = !args.includes('--force'); // Standardmäßig nur fehlende Felder befüllen

const db = new Database(path.join(__dirname, '..', 'stauden.db'));
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ── Migration: Spalten hinzufügen falls nicht vorhanden ─────────────────────
const NEW_COLS = [
  { name: 'lebensbereich',       type: 'TEXT' },
  { name: 'breite_cm_max',       type: 'INTEGER' },
  { name: 'rolle_empfehlung',    type: 'TEXT' },
  { name: 'kombinationspartner', type: 'TEXT' },
  { name: 'winteraspekt',        type: 'TEXT' },
  { name: 'trockenheitstoleranz', type: 'TEXT' },
];

const existingCols = db.pragma('table_info(pflanzen)').map(c => c.name);
for (const col of NEW_COLS) {
  if (!existingCols.includes(col.name)) {
    db.exec(`ALTER TABLE pflanzen ADD COLUMN ${col.name} ${col.type}`);
    console.log(`+ Spalte hinzugefügt: ${col.name}`);
  }
}

// ── Pflanzen laden ───────────────────────────────────────────────────────────
let query = `SELECT id, name_deutsch, name_botanisch, licht, boden, feuchtigkeit,
             hoehe_cm_min, hoehe_cm_max, bluehzeit, farbe, wuchs,
             lebensbereich, breite_cm_max, rolle_empfehlung, kombinationspartner,
             winteraspekt, trockenheitstoleranz
             FROM pflanzen WHERE name_deutsch != 'Test-Pflanze'`;

if (ONLY_EMPTY) {
  query += ` AND (lebensbereich IS NULL OR breite_cm_max IS NULL OR rolle_empfehlung IS NULL)`;
}
if (LIMIT) query += ` LIMIT ${LIMIT}`;

const pflanzen = db.prepare(query).all();

const UPDATE = db.prepare(`
  UPDATE pflanzen SET
    lebensbereich = ?,
    breite_cm_max = ?,
    rolle_empfehlung = ?,
    kombinationspartner = ?,
    winteraspekt = ?,
    trockenheitstoleranz = ?
  WHERE id = ?
`);

// ── GPT-4o Enrichment ────────────────────────────────────────────────────────
async function enrichPflanze(p) {
  const prompt = `Du bist ein Staudenexperte nach dem System von Hansen & Stahl.
Analysiere diese Staude und antworte NUR mit einem JSON-Objekt (kein Markdown, kein Text drumherum):

Pflanze: ${p.name_deutsch} (${p.name_botanisch})
Standort: Licht: ${p.licht || '?'}, Boden: ${p.boden || '?'}, Feuchtigkeit: ${p.feuchtigkeit || 'normal'}
Höhe: ${p.hoehe_cm_min || '?'}–${p.hoehe_cm_max || '?'} cm
Blütezeit: ${p.bluehzeit || '?'}, Farbe: ${p.farbe || '?'}
Wuchs: ${p.wuchs || '?'}

Felder die du befüllen sollst:
{
  "lebensbereich": "<Lebensbereich(e) nach Hansen & Stahl. AUSSCHLIESSLICH diese Begriffe, bis zu 3 kommagetrennt, den vorwiegenden zuerst: ${LB_VOKABULAR}>",
  "breite_cm_max": <typische Ausbreitung in cm als Zahl, z.B. 60>,
  "rolle_empfehlung": "<'Leitstaude' wenn strukturprägend und auffällig (1–3 je Beet), 'Begleitstaude' wenn ergänzend und dekorativ, 'Füllstaude' wenn flächendeckend oder füllend>",
  "kombinationspartner": "<3–5 botanische Namen von gut passenden Staudenpartnern, kommagetrennt>",
  "winteraspekt": "<z.B. 'Samenstand dekorativ', 'Blätter halbimmergrün', 'Rosetten wintergrün', 'Gräser Struktur', 'unauffällig' — kurz und präzise>",
  "trockenheitstoleranz": "<'hoch', 'mittel' oder 'gering'>"
}`;

  const res = await openai.chat.completions.create({
    model: 'gpt-4o',
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.2,
    response_format: { type: 'json_object' },
  });

  return JSON.parse(res.choices[0].message.content);
}

// ── Hauptschleife ─────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n=== Pflanzen-Enrichment ${DRY_RUN ? '[DRY RUN] ' : ''}===`);
  console.log(`Zu verarbeiten: ${pflanzen.length} Pflanzen${LIMIT ? ` (Limit: ${LIMIT})` : ''}\n`);

  let ok = 0, err = 0;

  for (const p of pflanzen) {
    process.stdout.write(`  ${p.name_deutsch} ... `);
    try {
      const d = await enrichPflanze(p);

      if (!DRY_RUN) {
        UPDATE.run(
          d.lebensbereich || null,
          d.breite_cm_max || null,
          d.rolle_empfehlung || null,
          d.kombinationspartner || null,
          d.winteraspekt || null,
          d.trockenheitstoleranz || null,
          p.id
        );
      }

      console.log(`OK  [${d.lebensbereich}] ${d.rolle_empfehlung} / ${d.trockenheitstoleranz}`);
      ok++;
    } catch (e) {
      console.log(`FEHLER: ${e.message}`);
      err++;
    }
    // Rate limit: 150ms zwischen Anfragen
    await new Promise(r => setTimeout(r, 150));
  }

  const total = db.prepare('SELECT COUNT(*) as n FROM pflanzen WHERE lebensbereich IS NOT NULL').get().n;
  console.log(`\n=== Fertig: ${ok} enriched, ${err} Fehler, ${total} Pflanzen mit Lebensbereich gesamt ===\n`);
  db.close();
}

main().catch(console.error);
