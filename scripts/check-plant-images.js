// Prüft alle Pflanzenbilder mit GPT-4o Vision: passt das Bild zur Pflanze?
// Bei schlechten Treffern (konfidenz < Schwellenwert) → Pixabay-Ersatz suchen.
//
// Ausführen:  node scripts/check-plant-images.js
// Optionen:
//   --dry-run          Nur prüfen + loggen, DB nicht verändern
//   --fix              Schlechte Bilder sofort durch neues Pixabay-Bild ersetzen
//   --staging          Nur Pflanzen mit status='staging' prüfen
//   --live             Nur Pflanzen mit status='live' prüfen (default: alle)
//   --limit=20         Max N Pflanzen prüfen
//   --min-konfidenz=0.7 Schwellenwert (default 0.7)
//   --only-bad         Zeigt am Ende nur die schlechten Bilder
//
// Ergebnis wird nach /tmp/check-images.log geschrieben (zusätzlich zur Konsole).
// Kosten: ~0.003 € pro Bild (GPT-4o Vision, kleines Bild, kurze Antwort)

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const Database = require('better-sqlite3');
const { OpenAI } = require('openai');
const path = require('path');
const fs   = require('fs');

// ── Argumente ─────────────────────────────────────────────────────────────────
const args        = process.argv.slice(2);
const DRY_RUN     = args.includes('--dry-run');
const FIX         = args.includes('--fix') && !args.includes('--dry-run');
const PROPOSE     = args.includes('--propose') && !FIX && !DRY_RUN;
const STAGING_ONLY= args.includes('--staging');
const LIVE_ONLY   = args.includes('--live');
const ONLY_BAD    = args.includes('--only-bad');
const LIMIT       = (() => { const l = args.find(a => a.startsWith('--limit=')); return l ? parseInt(l.split('=')[1]) : null; })();
const MIN_KONF    = (() => { const k = args.find(a => a.startsWith('--min-konfidenz=')); return k ? parseFloat(k.split('=')[1]) : 0.70; })();
const IDS         = (() => { const i = args.find(a => a.startsWith('--ids=')); return i ? i.split('=')[1].split(',').map(Number).filter(Boolean) : null; })();

const db     = new Database(path.join(__dirname, '..', 'stauden.db'));
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const PIXABAY_KEY = process.env.PIXABAY_API_KEY;

const LOG_FILE = '/tmp/check-images.log';
const log = (...msgs) => {
  const line = msgs.join(' ');
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch {}
};

const UPDATE_BILD      = db.prepare('UPDATE pflanzen SET bild_url = ?, bild_lizenz = ? WHERE id = ?');
const UPDATE_VORSCHLAG = db.prepare('UPDATE pflanzen SET bild_vorschlag = ?, bild_check_info = ? WHERE id = ?');
const UPDATE_GEPRUEFT  = db.prepare('UPDATE pflanzen SET bild_geprueft = 1 WHERE id = ?');

// ── Pflanzenliste aufbauen ─────────────────────────────────────────────────────
let where = "bild_url IS NOT NULL AND name_deutsch != 'Test-Pflanze'";
if (IDS && IDS.length)  where += ` AND id IN (${IDS.join(',')})`;
else if (STAGING_ONLY)  where += " AND status = 'staging'";
else if (LIVE_ONLY)     where += " AND (status IS NULL OR status = 'live')";

let pflanzen = db.prepare(`
  SELECT id, name_deutsch, name_botanisch, bild_url, status
  FROM pflanzen WHERE ${where}
  ORDER BY id
`).all();
if (LIMIT) pflanzen = pflanzen.slice(0, LIMIT);

// ── Bild als Data-URL laden (lokal oder remote) ───────────────────────────────
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

async function getImageDataUrl(bildUrl) {
  if (!bildUrl) return null;
  try {
    if (bildUrl.startsWith('/')) {
      // Lokale Datei: base64 einlesen
      const filePath = path.join(PUBLIC_DIR, bildUrl);
      if (!fs.existsSync(filePath)) return null;
      const buf  = fs.readFileSync(filePath);
      const ext  = path.extname(filePath).toLowerCase().replace('.', '') || 'jpeg';
      const mime = ext === 'png' ? 'image/png' : ext === 'gif' ? 'image/gif' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
      return `data:${mime};base64,${buf.toString('base64')}`;
    } else {
      // Externe URL direkt — GPT-4o kann externe URLs laden
      return bildUrl;
    }
  } catch {
    return null;
  }
}

// ── GPT-4o Vision: passt das Bild zur Pflanze? ───────────────────────────────
async function checkImage(pflanze) {
  const imageSource = await getImageDataUrl(pflanze.bild_url);
  if (!imageSource) return { passt: false, konfidenz: 0, was_gezeigt: 'Bild nicht ladbar', grund: 'Datei fehlt oder nicht erreichbar' };

  const isDataUrl = imageSource.startsWith('data:');
  const imageContent = isDataUrl
    ? { type: 'image_url', image_url: { url: imageSource, detail: 'low' } }
    : { type: 'image_url', image_url: { url: imageSource, detail: 'low' } };

  const prompt = `Du bist Pflanzenexperte. Analysiere dieses Bild und beantworte: Zeigt es die Pflanze "${pflanze.name_deutsch}" (botanisch: ${pflanze.name_botanisch})?

Antworte NUR mit diesem JSON (kein Markdown):
{
  "passt": true oder false,
  "konfidenz": 0.0 bis 1.0,
  "was_gezeigt": "<was tatsächlich im Bild zu sehen ist, in 1 Satz>",
  "grund": "<kurze Begründung warum es passt oder nicht passt>"
}

Regeln:
- passt=true wenn die Pflanze klar erkennbar ist (Gattung genügt, muss nicht exakt diese Sorte sein)
- passt=false wenn eine komplett andere Pflanze, ein Tier, eine Landschaft oder ein nicht-pflanzenartiges Motiv zu sehen ist
- konfidenz=1.0 wenn du dir 100% sicher bist, 0.5 wenn unsicher`;

  const res = await openai.chat.completions.create({
    model: 'gpt-4o',
    messages: [{ role: 'user', content: [{ type: 'text', text: prompt }, imageContent] }],
    max_tokens: 200,
    temperature: 0,
  });

  try {
    const text = res.choices[0].message.content.trim().replace(/^```json\s*/,'').replace(/```$/,'');
    return JSON.parse(text);
  } catch {
    return { passt: false, konfidenz: 0, was_gezeigt: '?', grund: 'JSON-Parse-Fehler: ' + res.choices[0].message.content.slice(0,80) };
  }
}

// ── Pixabay: neues Bild suchen ────────────────────────────────────────────────
async function pixabaySearch(query) {
  if (!PIXABAY_KEY) return null;
  try {
    const url = `https://pixabay.com/api/?key=${PIXABAY_KEY}&q=${encodeURIComponent(query)}&image_type=photo&category=nature&per_page=5&safesearch=true`;
    const res  = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const data = await res.json();
    return data.hits?.[0]?.largeImageURL || data.hits?.[0]?.webformatURL || null;
  } catch { return null; }
}

async function fetchReplacement(nameDeutsch, nameBotanisch) {
  const genus = nameBotanisch.split(' ')[0];
  for (const q of [
    `${nameBotanisch} plant`,
    `${genus} garden plant`,
    `${nameDeutsch} Garten`,
    `${genus} flower`,
  ]) {
    const url = await pixabaySearch(q);
    if (url) return url;
    await new Promise(r => setTimeout(r, 400));
  }
  return null;
}

// ── Hauptschleife ──────────────────────────────────────────────────────────────
async function main() {
  try { fs.writeFileSync(LOG_FILE, ''); } catch {} // Log leeren

  const modus = DRY_RUN ? '[DRY RUN]' : FIX ? '[FIX-MODUS]' : PROPOSE ? '[VORSCHLAG-MODUS]' : '[NUR PRÜFEN]';
  log(`\n=== Bildprüfung mit GPT-4o Vision ${modus} ===`);
  log(`Pflanzen: ${pflanzen.length} | Min-Konfidenz: ${MIN_KONF} | ${STAGING_ONLY ? 'Nur Staging' : LIVE_ONLY ? 'Nur Live' : 'Alle'}`);
  log(`Geschätzte Kosten: ~${(pflanzen.length * 0.003).toFixed(2)} € (${pflanzen.length} × 0.003 €)\n`);

  const ergebnisse = { ok: [], schlecht: [], fehler: [] };
  let idx = 0;

  for (const p of pflanzen) {
    idx++;
    process.stdout.write(`[${idx}/${pflanzen.length}] ${p.name_deutsch.padEnd(40)} `);

    let result;
    try {
      result = await checkImage(p);
    } catch (e) {
      const fehlerMsg = `FEHLER: ${e.message}`;
      process.stdout.write(fehlerMsg + '\n');
      ergebnisse.fehler.push({ ...p, fehler: e.message });
      await new Promise(r => setTimeout(r, 1000));
      continue;
    }

    const { passt, konfidenz, was_gezeigt, grund } = result;
    const konfStr  = `${(konfidenz * 100).toFixed(0)}%`;
    const status   = passt && konfidenz >= MIN_KONF ? '✅' : konfidenz >= MIN_KONF * 0.7 ? '⚠️' : '❌';

    process.stdout.write(`${status} ${konfStr}  ${was_gezeigt.slice(0, 55)}\n`);

    if (!passt || konfidenz < MIN_KONF) {
      log(`   → Grund: ${grund}`);
      log(`   → Bild:  ${p.bild_url}`);

      ergebnisse.schlecht.push({ ...p, result });

      if (FIX) {
        process.stdout.write(`   🔄 Suche Ersatz auf Pixabay…`);
        const newUrl = await fetchReplacement(p.name_deutsch, p.name_botanisch);
        if (newUrl) {
          UPDATE_BILD.run(newUrl, 'Pixabay License', p.id);
          log(`   ✓ Ersetzt: ${newUrl.slice(0, 80)}`);
        } else {
          log(`   ✗ Kein Ersatz auf Pixabay gefunden`);
        }
        await new Promise(r => setTimeout(r, 400));
      } else if (PROPOSE) {
        process.stdout.write(`   🔍 Suche Vorschlag auf Pixabay…`);
        const newUrl = await fetchReplacement(p.name_deutsch, p.name_botanisch);
        if (newUrl) {
          UPDATE_VORSCHLAG.run(newUrl, JSON.stringify({ konfidenz, was_gezeigt, grund }), p.id);
          log(`   📌 Vorschlag gespeichert: ${newUrl.slice(0, 80)}`);
        } else {
          log(`   ✗ Kein Vorschlag auf Pixabay gefunden`);
        }
        await new Promise(r => setTimeout(r, 400));
      }
    } else {
      ergebnisse.ok.push({ ...p, result });
    }

    // Als geprüft markieren (für manuelle Nachkontrolle via --ids)
    if (IDS) UPDATE_GEPRUEFT.run(p.id);

    // Rate-Limit: GPT-4o Vision ~60 req/min, wir bleiben auf 30/min
    await new Promise(r => setTimeout(r, 2000));
  }

  // ── Zusammenfassung ──────────────────────────────────────────────────────────
  log(`\n${'─'.repeat(70)}`);
  log(`=== ERGEBNIS: ${ergebnisse.ok.length} OK | ${ergebnisse.schlecht.length} schlecht | ${ergebnisse.fehler.length} Fehler ===\n`);

  if (ergebnisse.schlecht.length > 0) {
    log('SCHLECHTE BILDER:');
    ergebnisse.schlecht.forEach(p => {
      const k = (p.result.konfidenz * 100).toFixed(0);
      log(`  ❌ [${p.id}] ${p.name_deutsch.padEnd(38)} ${k}%  "${p.result.was_gezeigt.slice(0, 50)}"`);
    });
  }

  if (ergebnisse.fehler.length > 0) {
    log('\nFEHLER:');
    ergebnisse.fehler.forEach(p => log(`  ⚠️  [${p.id}] ${p.name_deutsch} — ${p.fehler}`));
  }

  if (!FIX && !PROPOSE && ergebnisse.schlecht.length > 0 && !DRY_RUN) {
    log(`\nTipp: Pixabay-Vorschläge speichern (manuelle Freigabe unter /checking):`);
    log(`  node scripts/check-plant-images.js --propose${STAGING_ONLY ? ' --staging' : LIVE_ONLY ? ' --live' : ''}`);
    log(`  oder direkt ersetzen mit --fix`);
  }

  if (FIX && ergebnisse.schlecht.length > 0) {
    log(`\nErsetzte Bilder sind sofort aktiv. Erneute Prüfung empfohlen:`);
    log(`  node scripts/check-plant-images.js${STAGING_ONLY ? ' --staging' : LIVE_ONLY ? ' --live' : ''}`);
  }

  if (PROPOSE && ergebnisse.schlecht.length > 0) {
    log(`\nVorschläge gespeichert → zur Freigabe: https://staudenplan.de/checking?key=preview2026`);
  }

  log(`\nVollständiges Log: ${LOG_FILE}`);
  db.close();
}

main().catch(console.error);
