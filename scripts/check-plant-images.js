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
//   --vorschlag        Beurteilt bild_vorschlag statt des ausgelieferten Bildes (schreibt nie)
//   --winter           Beurteilt bild_winter_url mit einem eigenen Maßstab (schreibt nie)
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
/* --vorschlag prüft das Bild unter bild_vorschlag statt das ausgelieferte unter bild_url.
 * Gedacht für den Ablauf „erzeugen → prüfen → übernehmen": Der Vorschlag wird beurteilt,
 * BEVOR er live geht, statt danach. Der Modus schreibt nie (durchgesetzt in NUR_LESEN, siehe
 * unten) — er beurteilt nur, und über das Übernehmen entscheidet
 * scripts/bild-vorschlag-uebernehmen.js. */
const VORSCHLAG   = args.includes('--vorschlag');
/* --winter prüft das WINTERBILD unter bild_winter_url (seit 22.09.2026). Gebaut wie
 * --vorschlag: ein anderes Bild derselben Pflanze, ein Modus, der nie schreibt.
 *
 * ER BRAUCHT ABER EINEN ANDEREN MASSSTAB, und das ist der eigentliche Punkt. Beurteilt wird
 * hier gegen ein Wikipedia-Referenzbild derselben Art — und das zeigt die Pflanze in der
 * Regel im SOMMER und in Blüte. Ein RICHTIGES Winterbild (trockener Grashorst, Samenstand,
 * bronzefarbene Rosette) fiele gegen diese Referenz durch, gerade weil es richtig ist: Die
 * Blütenfarbe fehlt, und genau nach ihr fragt der Maßstab des Normalfalls an erster Stelle.
 * Eine Prüfung, die Richtiges verwirft, ist so schädlich wie eine, die Falsches durchwinkt —
 * sie wird abgeschaltet, und dann prüft niemand mehr etwas. Der Wintermodus sagt dem Modell
 * deshalb ausdrücklich, dass Bild 2 den Ruhezustand zeigt, nennt ihm den erwarteten
 * Winteraspekt aus WINTER_WERT und nimmt die Blütenfarbe als Kriterium heraus. */
const WINTER      = args.includes('--winter');
/* Beide Modi beurteilen ein Bild, das NICHT unter bild_url ausgeliefert wird. Sie dürfen
 * deshalb nichts schreiben — auch nicht bild_geprueft: Dieses Feld sagt „das ausgelieferte
 * Bild ist angesehen worden", und angesehen wurde hier ein anderes. Eine Zusage, die der
 * Code nicht durchsetzt, ist keine; bis zum 22.09.2026 stand sie nur im Kommentar, während
 * --vorschlag zusammen mit --ids bild_geprueft setzte. */
const NUR_LESEN   = VORSCHLAG || WINTER;
const FIX         = args.includes('--fix') && !args.includes('--dry-run') && !NUR_LESEN;
const PROPOSE     = args.includes('--propose') && !FIX && !DRY_RUN && !NUR_LESEN;
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
const UPDATE_VORSCHLAG = db.prepare("UPDATE pflanzen SET bild_vorschlag = ?, bild_check_info = ?, status = 'staging' WHERE id = ?");
const UPDATE_GEPRUEFT  = db.prepare('UPDATE pflanzen SET bild_geprueft = 1 WHERE id = ?');

/* Die Aspektliste und den Spaltennamen holt nur der Wintermodus — und erst hier, nicht am
 * Dateikopf: scripts/winterbild-auftrag.js lädt pin-saison.js und damit die Suche nach
 * ImageMagick und den Schriften. Ein Skript, das nie ein Bild zeichnet, soll sich die nicht
 * im Normalfall einhandeln. Die deutsche Beschriftung des Winteraspekts („Samenstände bleiben
 * stehen") kommt aus WINTER_WERT — dieselbe Zeile, die im Pin steht, den dieses Bild
 * bebildert. Zwei Fassungen davon wären zwei Maßstäbe. */
const winterbild = WINTER ? require('./winterbild-auftrag') : null;
const saison     = WINTER ? require('./pin-saison') : null;

// ── Pflanzenliste aufbauen ─────────────────────────────────────────────────────
const BILD_SPALTE = WINTER ? winterbild.WINTERBILD_SPALTE : VORSCHLAG ? 'bild_vorschlag' : 'bild_url';
/* Der Normalfall lässt eine leere Zeichenkette in bild_url ausdrücklich stehen (so war es und
 * so bleibt es): Ein Bild, das nicht lädt, ist genau der Fall, den --propose ersetzen soll.
 * Die beiden Nebenbilder gibt es dagegen entweder oder gar nicht — eine leere Zeichenkette
 * heißt dort „nicht erzeugt" und ist nichts zu beurteilen. */
let where = BILD_SPALTE === 'bild_url'
  ? "bild_url IS NOT NULL AND name_deutsch != 'Test-Pflanze'"
  : `${BILD_SPALTE} IS NOT NULL AND ${BILD_SPALTE} != '' AND name_deutsch != 'Test-Pflanze'`;
if (IDS && IDS.length)  where += ` AND id IN (${IDS.join(',')})`;
else if (STAGING_ONLY)  where += " AND status = 'staging'";
else if (LIVE_ONLY)     where += " AND (status IS NULL OR status = 'live')";

let pflanzen = db.prepare(`
  SELECT id, name_deutsch, name_botanisch, status, farbe,
         ${WINTER ? 'winteraspekt,' : ''}
         ${BILD_SPALTE === 'bild_url' ? 'bild_url' : `${BILD_SPALTE} AS bild_url`}
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

// ── Wikipedia: Referenzbild intern holen (nur für GPT, nie angezeigt) ────────
async function getWikipediaRef(nameBotanisch) {
  const variants = [
    `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(nameBotanisch.replace(/ /g,'_'))}`,
    `https://de.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(nameBotanisch.replace(/ /g,'_'))}`,
    `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(nameBotanisch.split(' ')[0])}`,
  ];
  for (const url of variants) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(5000), headers: { 'User-Agent': 'StaudenplanBot/1.0' } });
      if (!res.ok) continue;
      const data = await res.json();
      const src = data.originalimage?.source || data.thumbnail?.source;
      if (src) return src;
    } catch {}
  }
  return null;
}

// ── GPT-4o Vision: passt das Bild zur Pflanze? ───────────────────────────────
/* Die Aspektliste im Winterprompt kommt aus WINTER_WERT, sie wird nicht getippt. Die
 * getippte Fassung war schon beim Schreiben auseinandergelaufen: fuenf Eintraege statt sechs,
 * es fehlte das halbimmergruene Laub. Ein neuer Eintrag in WINTER_WERT wandert so von selbst
 * in den Massstab, statt still zu fehlen. */
const ASPEKT_LISTE = Object.values(saison.WINTER_WERT).join(' / ');

async function checkImage(pflanze) {
  const imageSource = await getImageDataUrl(pflanze.bild_url);
  if (!imageSource) return { passt: false, konfidenz: 0, was_gezeigt: 'Bild nicht ladbar', grund: 'Datei fehlt oder nicht erreichbar' };

  const kandidatContent = { type: 'image_url', image_url: { url: imageSource, detail: 'low' } };
  /* Im Wintermodus KEIN Farbhinweis: Auf einem richtigen Winterbild ist keine Blüte zu sehen,
   * die Farbe wäre also ein Kriterium, das nur gegen das Bild sprechen kann. Stattdessen
   * bekommt das Modell den erwarteten Winteraspekt — das, was auf dem Bild zu sehen sein SOLL
   * und was der Pin daneben behauptet. */
  const farbenHinweis   = (!WINTER && pflanze.farbe) ? ` Typische Blütenfarbe laut Datenbank: ${pflanze.farbe}.` : '';
  /* Fehlt der Aspekt, wird keiner erfunden — das Modell erfährt stattdessen, dass die
   * Datenbank dazu nichts sagt. Vorkommen kann das
   * nur, wenn jemand bild_winter_url von Hand gesetzt hat — der Erzeuger verlangt einen
   * Schlüssel aus WINTER_WERT. Ein geratener Aspekt wäre ein Maßstab, den die Daten nicht
   * hergeben, und er würde ein richtiges Bild verwerfen. */
  const winterAspekt    = WINTER ? saison.winterAspekt(pflanze) : null;
  const aspektSatz      = winterAspekt
    ? ` Laut Datenbank ist im Winter zu sehen: ${winterAspekt}.`
    : ' Welcher Winteraspekt zu erwarten ist, steht nicht in der Datenbank.';

  // Wikipedia-Referenz holen (intern, nie angezeigt)
  const wikiUrl = await getWikipediaRef(pflanze.name_botanisch);
  const hatReferenz = !!wikiUrl;

  let messages;
  if (WINTER) {
    /* Der Wintermaßstab. Zwei Fassungen, je nachdem ob es eine Referenz gibt — dieselbe
     * Aufteilung wie im Normalfall darunter. Gefragt wird nach Plausibilität, nicht nach
     * Übereinstimmung: Ein Winterbild KANN dem Sommerbild nicht gleichen, sonst wäre es
     * falsch. Die Blütenfarbe ist ausdrücklich kein Kriterium. */
    const prompt = hatReferenz
      ? `Du bist Pflanzenexperte. Bild 1 ist ein verifiziertes Wikipedia-Referenzbild der Pflanze "${pflanze.name_deutsch}" (botanisch: ${pflanze.name_botanisch}) — es zeigt sie in der Regel im SOMMER und in Blüte.

Bild 2 soll dieselbe Art im winterlichen RUHEZUSTAND zeigen (Dezember, deutscher Garten).${aspektSatz}

Beurteile: Ist Bild 2 plausibel diese Art im Winter?
Kriterien: Wuchsform und Habitus, Silhouette, Größenverhältnisse, Form der Stängel und Samenstände, Blattform und Blattstellung NUR soweit im Winter überhaupt noch Laub vorhanden ist, und ob der gezeigte Winteraspekt zu dem passt, der erwartet wird (${ASPEKT_LISTE}).

WICHTIG:
- Die Blütenfarbe ist KEIN Kriterium. Ein richtiges Winterbild hat keine Blüten.
- Dass Bild 2 anders aussieht als Bild 1, ist ERWARTET und für sich kein Grund für passt=false.
- passt=false, wenn eine andere Gattung zu sehen ist, wenn Bild 2 trotz Winter blüht oder frisch austreibt, wenn der gezeigte Winteraspekt dem erwarteten widerspricht, oder wenn ein Tier / eine Landschaft / keine Pflanze gezeigt wird.`
      : `Du bist Pflanzenexperte. Dieses Bild soll die Pflanze "${pflanze.name_deutsch}" (botanisch: ${pflanze.name_botanisch}) im winterlichen RUHEZUSTAND zeigen (Dezember, deutscher Garten).${aspektSatz}

Beurteile: Ist das plausibel diese Art im Winter?
Kriterien: Wuchsform und Habitus, Silhouette, Form der Stängel und Samenstände, Blattform und Blattstellung NUR soweit im Winter überhaupt noch Laub vorhanden ist, und ob der gezeigte Winteraspekt zu dem passt, der erwartet wird.

WICHTIG:
- Die Blütenfarbe ist KEIN Kriterium. Ein richtiges Winterbild hat keine Blüten.
- passt=false, wenn eine andere Gattung zu sehen ist, wenn die Pflanze trotz Winter blüht oder frisch austreibt, wenn der gezeigte Winteraspekt dem erwarteten widerspricht, oder wenn ein Tier / eine Landschaft / keine Pflanze gezeigt wird.`;

    const antwortForm = `

Antworte NUR mit diesem JSON (kein Markdown):
{
  "passt": true oder false,
  "konfidenz": 0.0 bis 1.0,
  "was_gezeigt": "<was im Winterbild zu sehen ist, in 1 Satz>",
  "grund": "<warum das plausibel diese Art im Winter ist oder nicht, in 1-2 Sätzen>"
}

Zur Konfidenz: Sie sagt, wie sicher du dir bei der ART bist — NICHT, wie ungewohnt der
Ruhezustand aussieht. Dass eine Pflanze im Winter schwerer zu bestimmen ist als in Blüte,
senkt die Konfidenz NICHT. konfidenz=1.0 wenn du sicher bist, 0.5 wenn unsicher.`;
    const inhalt = [{ type: 'text', text: prompt + antwortForm }];
    if (hatReferenz) inhalt.push({ type: 'image_url', image_url: { url: wikiUrl, detail: 'low' } });
    inhalt.push(kandidatContent);
    messages = [{ role: 'user', content: inhalt }];
  } else if (hatReferenz) {
    const refContent = { type: 'image_url', image_url: { url: wikiUrl, detail: 'low' } };
    const prompt = `Du bist Pflanzenexperte. Bild 1 ist ein verifiziertes Wikipedia-Referenzbild der Pflanze "${pflanze.name_deutsch}" (botanisch: ${pflanze.name_botanisch}).${farbenHinweis}

Prüfe ob Bild 2 (das Kandidatenbild) dieselbe oder eine botanisch sehr ähnliche Pflanze zeigt.
Achte besonders auf: Blütenfarbe, Blütenform, Blattform, Wuchsform.

Antworte NUR mit diesem JSON (kein Markdown):
{
  "passt": true oder false,
  "konfidenz": 0.0 bis 1.0,
  "was_gezeigt": "<was in Bild 2 zu sehen ist, in 1 Satz>",
  "grund": "<Vergleich mit Referenz: was stimmt überein oder weicht ab>"
}

Regeln:
- passt=true wenn Gattung und Habitus erkennbar übereinstimmen (exakte Sorte nicht nötig)
- passt=false wenn Blütenfarbe deutlich abweicht, eine andere Pflanzengattung zu sehen ist, oder ein Tier/Landschaft/Nicht-Pflanze gezeigt wird
- konfidenz=1.0 wenn du 100% sicher bist, 0.5 wenn unsicher`;
    messages = [{ role: 'user', content: [{ type: 'text', text: prompt }, refContent, kandidatContent] }];
  } else {
    const prompt = `Du bist Pflanzenexperte. Analysiere dieses Bild: Zeigt es die Pflanze "${pflanze.name_deutsch}" (botanisch: ${pflanze.name_botanisch})?${farbenHinweis}

Antworte NUR mit diesem JSON (kein Markdown):
{
  "passt": true oder false,
  "konfidenz": 0.0 bis 1.0,
  "was_gezeigt": "<was im Bild zu sehen ist, in 1 Satz>",
  "grund": "<kurze Begründung>"
}

Regeln:
- passt=true wenn die Gattung klar erkennbar ist und Blütenfarbe zur Angabe passt
- passt=false wenn eine andere Pflanze, ein Tier, eine Landschaft oder Nicht-Pflanze zu sehen ist
- konfidenz=1.0 wenn du 100% sicher bist, 0.5 wenn unsicher`;
    messages = [{ role: 'user', content: [{ type: 'text', text: prompt }, kandidatContent] }];
  }

  const res = await openai.chat.completions.create({
    model: 'gpt-4o',
    messages,
    // Der Winterprompt verlangt eine Begruendung; reisst die Antwort ab, scheitert JSON.parse
    // und der catch unten liefert passt:false/konfidenz:0 — ein richtiges Bild landete dann unter
    // "SCHLECHTE BILDER". Deshalb mehr Platz, und der Abbruch wird unten als Fehler gemeldet.
    max_tokens: WINTER ? 320 : 200,
    temperature: 0,
  });

  if (res.choices[0].finish_reason === 'length') {
    // Kein Urteil, sondern ein abgeschnittener Satz. Als 'passt=false' zu werten hiesse, ein
    // moeglicherweise richtiges Bild wegen der Antwortlaenge zu verwerfen.
    throw new Error('Antwort des Modells abgeschnitten (max_tokens) — kein Urteil moeglich');
  }
  try {
    const text = res.choices[0].message.content.trim().replace(/^```json\s*/,'').replace(/```$/,'');
    return JSON.parse(text);
  } catch {
    return { passt: false, konfidenz: 0, was_gezeigt: '?', grund: 'JSON-Parse-Fehler: ' + res.choices[0].message.content.slice(0,80) };
  }
}

// ── Botanischen Namen für Suche bereinigen ────────────────────────────────────
function cleanBotanischForSearch(name) {
  return name
    .replace(/\s*'[^']*'/g, '')  // Sortenamen 'Album', 'Pumila' etc. entfernen
    .replace(/\s+x\s+/gi, ' ')   // Hybrid-x entfernen: "Cistus x purpureus" → "Cistus purpureus"
    .replace(/\s+/g, ' ')
    .trim();
}

// ── Pixabay: mehrere Kandidaten suchen ───────────────────────────────────────
async function pixabaySearch(query, n = 5) {
  if (!PIXABAY_KEY) return [];
  try {
    const url = `https://pixabay.com/api/?key=${PIXABAY_KEY}&q=${encodeURIComponent(query)}&image_type=photo&category=nature&per_page=${n}&safesearch=true&editors_choice=false&order=popular`;
    const res  = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.hits || []).map(h => h.largeImageURL || h.webformatURL).filter(Boolean);
  } catch { return []; }
}

// ── Wikimedia Commons: freie Pflanzenfotos suchen ────────────────────────────
async function wikimediaSearch(nameBotanisch, n = 3) {
  const clean = cleanBotanischForSearch(nameBotanisch);
  try {
    const searchUrl = `https://commons.wikimedia.org/w/api.php?action=query&list=search`
      + `&srsearch=${encodeURIComponent(clean)}&srnamespace=6&srlimit=15&format=json`;
    const sRes = await fetch(searchUrl, { signal: AbortSignal.timeout(8000), headers: { 'User-Agent': 'StaudenplanBot/1.0 (staudenplan.de)' } });
    if (!sRes.ok) return [];
    const sData = await sRes.json();
    const titles = (sData.query?.search || [])
      .map(r => r.title)
      .filter(t => /\.(jpg|jpeg|png)$/i.test(t));
    if (!titles.length) return [];

    const infoUrl = `https://commons.wikimedia.org/w/api.php?action=query`
      + `&titles=${encodeURIComponent(titles.slice(0, 10).join('|'))}`
      + `&prop=imageinfo&iiprop=url|extmetadata&iiurlwidth=800&format=json`;
    const iRes = await fetch(infoUrl, { signal: AbortSignal.timeout(8000), headers: { 'User-Agent': 'StaudenplanBot/1.0 (staudenplan.de)' } });
    if (!iRes.ok) return [];
    const iData = await iRes.json();

    const results = [];
    for (const page of Object.values(iData.query?.pages || {})) {
      const info = page.imageinfo?.[0];
      if (!info) continue;
      const license = info.extmetadata?.LicenseShortName?.value || '';
      const isFree = /^(CC[- ]0|CC BY[\s\-]|Public Domain|PD[^-]|CC-BY\s)/i.test(license)
        && !/NonCommercial|NC/i.test(license);
      if (!isFree) continue;
      const imgUrl = info.thumburl || info.url;
      if (!imgUrl || !/\.(jpg|jpeg|png)(\?|$)/i.test(imgUrl)) continue;
      const artist = (info.extmetadata?.Artist?.value || 'Wikimedia Commons').replace(/<[^>]+>/g, '').trim().slice(0, 60);
      results.push({ url: imgUrl, lizenz: `${license || 'CC BY'}, Wikimedia Commons, ${artist}` });
      if (results.length >= n) break;
    }
    return results;
  } catch { return []; }
}

// ── Schnell-Validierung: ist das überhaupt eine Pflanze? ─────────────────────
async function istPflanzenbild(imageUrl) {
  try {
    const res = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: [
        { type: 'text', text: 'Zeigt dieses Bild eine Pflanze, Blume oder Gartenpflanze? Antworte nur mit "ja" oder "nein".' },
        { type: 'image_url', image_url: { url: imageUrl, detail: 'low' } }
      ]}],
      max_tokens: 5,
      temperature: 0,
    });
    const antwort = res.choices[0].message.content.trim().toLowerCase();
    return antwort.startsWith('ja');
  } catch { return true; } // im Zweifel durchlassen
}

// Gibt { url, lizenz } oder null zurück
async function fetchReplacement(nameDeutsch, nameBotanisch, farbe) {
  const clean = cleanBotanischForSearch(nameBotanisch);
  const genus = clean.split(' ')[0];
  const f     = (farbe || '').split(',')[0].trim();

  const queries = [
    f ? `${clean} ${f} flower` : `${clean} flower`,
    `${clean} plant garden`,
    f ? `${genus} ${f} perennial` : `${genus} garden perennial`,
    `${genus} flower`,
    `${nameDeutsch} Blüte`,
  ];

  for (const q of queries) {
    const urls = await pixabaySearch(q, 5);
    for (const url of urls) {
      const ok = await istPflanzenbild(url);
      if (ok) return { url, lizenz: 'Pixabay License' };
    }
    await new Promise(r => setTimeout(r, 300));
  }

  // Pixabay erfolglos → Wikimedia Commons als Fallback
  process.stdout.write(' [Wikimedia…]');
  const wikiResults = await wikimediaSearch(nameBotanisch);
  for (const { url, lizenz } of wikiResults) {
    const ok = await istPflanzenbild(url);
    if (ok) return { url, lizenz };
  }

  return null;
}

// ── Hauptschleife ──────────────────────────────────────────────────────────────
async function main() {
  try { fs.writeFileSync(LOG_FILE, ''); } catch {} // Log leeren

  const modus = WINTER ? '[WINTERBILDER · NUR PRÜFEN]'
              : DRY_RUN ? '[DRY RUN]' : FIX ? '[FIX-MODUS]' : PROPOSE ? '[VORSCHLAG-MODUS]' : '[NUR PRÜFEN]';
  log(`\n=== Bildprüfung mit GPT-4o Vision ${modus} ===`);
  if (WINTER) {
    log(`Geprüft wird ${BILD_SPALTE} — das Bild, das der Winter-Pin zeigt. Maßstab: plausibel diese Art`);
    log('im Ruhezustand (Wuchsform, Blattform, Silhouette, Winteraspekt). Blütenfarbe zählt nicht.');
    log('Dieser Modus schreibt nichts — auch bild_geprueft nicht.');
  }
  log(`Pflanzen: ${pflanzen.length} | Min-Konfidenz: ${MIN_KONF} | ${STAGING_ONLY ? 'Nur Staging' : LIVE_ONLY ? 'Nur Live' : 'Alle'}`);
  log(`Geschätzte Kosten: ~${(pflanzen.length * 0.006).toFixed(2)} € (${pflanzen.length} × ~0.006 € mit Wikipedia-Referenz)\n`);

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
      if (PROPOSE) {
        process.stdout.write(`   🔍 Suche Vorschlag (bild_url defekt)…`);
        const found = await fetchReplacement(p.name_deutsch, p.name_botanisch, p.farbe);
        if (found) {
          UPDATE_VORSCHLAG.run(found.url, JSON.stringify({ konfidenz: 0, was_gezeigt: 'bild_url defekt', grund: e.message, lizenz: found.lizenz }), p.id);
          log(`   📌 Vorschlag gespeichert: ${found.url.slice(0, 80)} [${found.lizenz}]`);
        } else {
          log(`   ✗ Kein Vorschlag gefunden`);
        }
      }
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
        process.stdout.write(`   🔄 Suche Ersatz…`);
        const found = await fetchReplacement(p.name_deutsch, p.name_botanisch, p.farbe);
        if (found) {
          UPDATE_BILD.run(found.url, found.lizenz, p.id);
          log(`   ✓ Ersetzt: ${found.url.slice(0, 80)} [${found.lizenz}]`);
        } else {
          log(`   ✗ Kein Ersatz gefunden (Pixabay + Wikimedia)`);
        }
        await new Promise(r => setTimeout(r, 400));
      } else if (PROPOSE) {
        process.stdout.write(`   🔍 Suche Vorschlag…`);
        const found = await fetchReplacement(p.name_deutsch, p.name_botanisch, p.farbe);
        if (found) {
          UPDATE_VORSCHLAG.run(found.url, JSON.stringify({ konfidenz, was_gezeigt, grund, lizenz: found.lizenz }), p.id);
          log(`   📌 Vorschlag gespeichert: ${found.url.slice(0, 80)} [${found.lizenz}]`);
        } else {
          log(`   ✗ Kein Vorschlag gefunden (Pixabay + Wikimedia)`);
        }
        await new Promise(r => setTimeout(r, 400));
      }
    } else {
      ergebnisse.ok.push({ ...p, result });
    }

    /* Als geprüft markieren (für manuelle Nachkontrolle via --ids) — aber nur im Normalfall.
     * bild_geprueft ist eine Aussage über das AUSGELIEFERTE Bild; in --vorschlag und --winter
     * wurde ein anderes angesehen. Siehe NUR_LESEN oben. */
    if (IDS && !NUR_LESEN) UPDATE_GEPRUEFT.run(p.id);

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

  /* Der Wintermodus bekommt einen EIGENEN Hinweis. Der Rat unten — „Pixabay-Vorschläge
   * speichern" — wäre hier grob falsch: Ein Ersatz von Pixabay ist ein fremdes Foto und
   * käme als Winterbild niemals in Frage (bild_winter_url nimmt nur selbst erzeugte
   * Dateien an, siehe istWinterbildPfad in scripts/winterbild-auftrag.js). Ein schlechtes
   * Winterbild wird neu erzeugt, nicht ersetzt. */
  if (WINTER && ergebnisse.schlecht.length > 0) {
    const ids = ergebnisse.schlecht.map(p => p.id).join(',');
    log(`\nTipp: Diese Winterbilder neu erzeugen (kostet ~${(ergebnisse.schlecht.length * winterbild.KOSTEN_JE_BILD).toFixed(2)} $):`);
    log(`  node scripts/winterbilder-erzeugen.js --ids=${ids}`);
    log(`  oder mit dem anderen Bildauftrag: --ids=${ids} --fassung=b`);
    log('Danach erneut prüfen — und erst dann die Pins neu bauen.');
  }

  if (!FIX && !PROPOSE && !NUR_LESEN && ergebnisse.schlecht.length > 0 && !DRY_RUN) {
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
