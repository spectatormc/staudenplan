require('dotenv').config();
const express = require('express');
const Database = require('better-sqlite3');
const nodemailer = require('nodemailer');
const rateLimit = require('express-rate-limit');
const { OpenAI } = require('openai');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// ─── Datenbank ────────────────────────────────────────────────────────────────
const db = new Database(path.join(__dirname, 'stauden.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS anfragen (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    erstellt_am TEXT DEFAULT (datetime('now')),
    name TEXT, email TEXT, plz TEXT, telefon TEXT, anmerkungen TEXT,
    gartenflaeche REAL, licht TEXT, boden TEXT, stil TEXT, farbe TEXT, saison TEXT,
    ki_plan TEXT
  );

  CREATE TABLE IF NOT EXISTS pflanzen (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name_deutsch TEXT NOT NULL,
    name_botanisch TEXT UNIQUE NOT NULL,
    beschreibung TEXT,
    licht TEXT,
    boden TEXT,
    stil TEXT,
    bluehzeit TEXT,
    farbe TEXT,
    hoehe_cm_min INTEGER,
    hoehe_cm_max INTEGER,
    pflege_sterne INTEGER,
    preis_stueck_eur REAL,
    winterhart_zone INTEGER,
    bienen_freundlich INTEGER DEFAULT 0,
    heimisch INTEGER DEFAULT 0,
    aktualisiert_am TEXT DEFAULT (datetime('now'))
  );

  CREATE VIRTUAL TABLE IF NOT EXISTS wissen USING fts5(
    titel, inhalt, kategorie, quelle, datum
  );

  CREATE TABLE IF NOT EXISTS wissen_quellen (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    url TEXT UNIQUE,
    titel TEXT,
    abgerufen_am TEXT DEFAULT (datetime('now')),
    eintraege_erstellt INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS email_gate (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    erstellt_am TEXT DEFAULT (datetime('now')),
    email TEXT NOT NULL,
    gartenflaeche REAL,
    licht TEXT,
    stil TEXT,
    quelle TEXT DEFAULT 'pdf-download'
  );
`);

// ─── OpenAI (lazy) ────────────────────────────────────────────────────────────
let openai = null;
function getOpenAI() {
  if (!openai) openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return openai;
}

// ─── E-Mail ───────────────────────────────────────────────────────────────────
const transporter = nodemailer.createTransport({
  host: process.env.EMAIL_HOST || 'localhost',
  port: parseInt(process.env.EMAIL_PORT) || 587,
  secure: process.env.EMAIL_SECURE === 'true',
  auth: process.env.EMAIL_USER ? { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS } : undefined,
});

// ─── Rate Limiting ────────────────────────────────────────────────────────────

// Global: max 200 Requests pro IP pro Minute (schützt vor Bot-Floods)
app.use(rateLimit({
  windowMs: 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  skip: req => req.path.startsWith('/images/') || req.path.endsWith('.jpg') || req.path.endsWith('.png'),
  message: 'Zu viele Anfragen. Bitte versuche es in einer Minute erneut.',
}));

// /api/pflanzen: max 30 Abrufe pro Minute (verhindert automatisiertes Scraping)
const pflanzenLimiter = rateLimit({
  windowMs: 60 * 1000, max: 30,
  message: { error: 'Zu viele Anfragen.' }
});

const planLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 10,
  message: { error: 'Zu viele Anfragen, bitte versuche es später erneut.' }
});
const anfrageLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 5,
  message: { error: 'Zu viele Anfragen, bitte versuche es später erneut.' }
});
const alternativLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, max: 30,
  message: { error: 'Zu viele Anfragen.' }
});

// ─── RAG-Hilfsfunktionen ──────────────────────────────────────────────────────

const LICHT_MAP = {
  'Vollsonne (6+ h)': 'Sonne',
  'Halbschatten (3–6 h)': 'Halbschatten',
  'Schatten (unter 3 h)': 'Schatten',
  'Wechselnde Bedingungen': 'Sonne',
};
const BODEN_MAP = {
  'Sandig / durchlässig': 'sandig',
  'Lehmig / schwer': 'lehmig',
  'Normal / humos': 'normal',
  'Normal / unbekannt': 'normal',
};
const STIL_MAP = {
  'Naturgarten / Wildgarten': 'Naturgarten',
  'Bauerngarten / Romantisch': 'Bauerngarten',
  'Modern / Minimalistisch': 'Modern',
  'Cottage-Garten / Englisch': 'Cottage',
};

function getFeuchtigkeit(boden, standortBeschr) {
  const s = (standortBeschr || '').toLowerCase();
  if (s.includes('nass') || s.includes('teichrand') || s.includes('sumpf')) return 'nass';
  if (s.includes('dauerhaft feucht') || s.includes('feucht-kühl') || s.includes('feucht-nass')) return 'feucht';
  if (s.includes('sehr trocken') || s.includes('kiesgarten') || s.includes('trocken')) return 'trocken';
  if (s.includes('wechselfeucht')) return 'wechselfeucht';
  if (boden === 'Sandig / durchlässig') return 'trocken';
  if (boden === 'Lehmig / schwer') return 'feucht';
  return 'normal';
}

// Welche DB-Feuchtigkeit-Werte passen zu einem Standort
const FEUCHT_COMPAT = {
  'trocken':       ['trocken', 'normal'],
  'normal':        ['normal', 'trocken', 'wechselfeucht'],
  'wechselfeucht': ['wechselfeucht', 'normal', 'trocken'],
  'feucht':        ['feucht', 'wechselfeucht', 'normal'],
  'nass':          ['nass', 'feucht'],
};

function getPflanzenkandidaten(licht, boden, stil, standortBeschr) {
  const pflanzenCount = db.prepare("SELECT COUNT(*) as n FROM pflanzen WHERE name_deutsch != 'Test-Pflanze'").get().n;
  if (pflanzenCount === 0) return [];

  const lichtTerm   = LICHT_MAP[licht] || licht.split(' ')[0];
  const bodenTerm   = BODEN_MAP[boden] || 'normal';
  const stilTerm    = STIL_MAP[stil]   || stil.split('/')[0].trim();
  const feuchtigkeit = getFeuchtigkeit(boden, standortBeschr);
  const feuchTerms  = FEUCHT_COMPAT[feuchtigkeit] || ['normal'];
  const feuchPlaceholders = feuchTerms.map(() => '?').join(',');

  const COLS = `name_deutsch, name_botanisch, beschreibung, licht, boden, stil,
           bluehzeit, farbe, hoehe_cm_min, hoehe_cm_max,
           pflege_sterne, preis_stueck_eur, bienen_freundlich, heimisch,
           feuchtigkeit, wuchs,
           lebensbereich, breite_cm_max, rolle_empfehlung,
           kombinationspartner, winteraspekt, trockenheitstoleranz`;

  // Vollständiger Match mit Feuchtigkeit
  let kandidaten = db.prepare(`
    SELECT ${COLS}
    FROM pflanzen
    WHERE licht LIKE ? AND (boden LIKE ? OR boden LIKE ?) AND stil LIKE ?
      AND (feuchtigkeit IN (${feuchPlaceholders}) OR feuchtigkeit IS NULL)
      AND (wuchs IS NULL OR wuchs != 'invasiv')
      AND (status IS NULL OR status = 'live')
    ORDER BY RANDOM() LIMIT 35
  `).all(`%${lichtTerm}%`, `%${bodenTerm}%`, '%normal%', `%${stilTerm}%`, ...feuchTerms);

  // Fallback: nur Licht + Feuchtigkeit
  if (kandidaten.length < 10) {
    kandidaten = db.prepare(`
      SELECT ${COLS}
      FROM pflanzen
      WHERE licht LIKE ?
        AND (feuchtigkeit IN (${feuchPlaceholders}) OR feuchtigkeit IS NULL)
        AND (wuchs IS NULL OR wuchs != 'invasiv')
        AND (status IS NULL OR status = 'live')
      ORDER BY RANDOM() LIMIT 35
    `).all(`%${lichtTerm}%`, ...feuchTerms);
  }

  // Letzter Fallback: nur Licht
  if (kandidaten.length < 8) {
    kandidaten = db.prepare(`
      SELECT ${COLS}
      FROM pflanzen WHERE licht LIKE ?
        AND (wuchs IS NULL OR wuchs != 'invasiv')
        AND (status IS NULL OR status = 'live')
      ORDER BY RANDOM() LIMIT 35
    `).all(`%${lichtTerm}%`);
  }

  return kandidaten;
}

function getRelevantesWissen(stil, licht, feuchtigkeit) {
  try {
    const count = db.prepare('SELECT COUNT(*) as n FROM wissen').get().n;
    if (count === 0) return [];

    const stilTerm   = (STIL_MAP[stil]  || stil.split('/')[0].trim()).toLowerCase();
    const lichtTerm  = (LICHT_MAP[licht] || licht.split(' ')[0]).toLowerCase();
    const feuchTerm  = feuchtigkeit === 'nass' || feuchtigkeit === 'feucht' ? 'Feuchtbeet' : '';
    const ftsTerms   = [stilTerm, lichtTerm, 'Höhenstaffelung', feuchTerm].filter(Boolean);
    const ftsQuery   = ftsTerms.join(' OR ');

    return db.prepare(`
      SELECT titel, inhalt, kategorie FROM wissen
      WHERE wissen MATCH ?
      ORDER BY rank LIMIT 6
    `).all(ftsQuery);
  } catch {
    try {
      return db.prepare('SELECT titel, inhalt, kategorie FROM wissen ORDER BY rowid DESC LIMIT 4').all();
    } catch { return []; }
  }
}

function buildSystemPrompt(kandidaten, wissen) {
  let prompt = `Du bist ein erfahrener Staudenspezialist und Gartenplaner aus Deutschland mit 20 Jahren Erfahrung. \
Du empfiehlst ausschließlich in Deutschland winterharte Pflanzen. Antworte immer als valides JSON ohne Markdown-Formatierung.

## PLANUNGSREGELN (strikt einhalten):
1. HÖHENSTAFFELUNG: Hohe Stauden (>100cm) in den Hintergrund, Mittelhohe (50–100cm) in die Mitte, Niedrige (<50cm) und Bodendecker in den Vordergrund.
2. SCHICHTEN: Plane nach dem Drei-Schichten-Prinzip: 15% Leitstauden, 55% Begleitstauden, 30% Füllstauden/Bodendecker.
3. BLÜTENFOLGE: Verteile die Blütezeiten — immer mind. 2 Arten pro Saison (Frühjahr/Sommer/Herbst) einplanen.
4. FARBHARMONIE: Maximal 3–4 Hauptfarben, Weiß oder Silber als Verbinder nutzen.
5. LEITSTAUDEN: Jede Leitstaude mind. 3 Exemplare einplanen — Einzelsetzung wirkt verloren und entspricht nicht der Profipraxis.`;

  if (kandidaten.length > 0) {
    // Warnliste für ausbreitende Arten
    const ausbreiter = kandidaten.filter(p => p.wuchs && p.wuchs !== 'horstig');
    if (ausbreiter.length > 0) {
      prompt += `\n\n## ACHTUNG AUSBREITUNGSVERHALTEN:\n`;
      prompt += ausbreiter.map(p =>
        `- ${p.name_deutsch} (${p.name_botanisch}): wuchs=${p.wuchs} — nur bewusst einsetzen, ggf. Rhizomsperre`
      ).join('\n');
    }

    prompt += '\n\n## VERFÜGBARE PFLANZEN (standortgeprüft):\n';
    prompt += kandidaten.map(p => {
      const hoehe = (p.hoehe_cm_min && p.hoehe_cm_max) ? `${p.hoehe_cm_min}–${p.hoehe_cm_max}cm` : '';
      const breite = p.breite_cm_max ? `Ø${p.breite_cm_max}cm` : '';
      const rolle = p.rolle_empfehlung || ((p.hoehe_cm_max || 50) >= 100 ? 'Leitstaude' : (p.hoehe_cm_max || 50) >= 50 ? 'Begleitstaude' : 'Füllstaude');
      const extras = [
        p.bienen_freundlich ? '🐝' : '',
        p.heimisch ? '🌿heimisch' : '',
        p.feuchtigkeit && p.feuchtigkeit !== 'normal' ? `💧${p.feuchtigkeit}` : '',
        p.trockenheitstoleranz === 'hoch' ? '☀️trockenheitsresistent' : '',
        p.wuchs && p.wuchs !== 'horstig' ? `⚠️${p.wuchs}` : '',
        p.winteraspekt && p.winteraspekt !== 'unauffällig' ? `❄️${p.winteraspekt}` : '',
      ].filter(Boolean).join(' ');
      const lebensb = p.lebensbereich ? ` | LB:${p.lebensbereich}` : '';
      const kombi = p.kombinationspartner ? ` | Kombi:${p.kombinationspartner}` : '';
      return `- [${rolle}] ${p.name_deutsch} (${p.name_botanisch}): ${p.licht} | Blüte: ${p.bluehzeit || '?'} | ${p.farbe || '?'} | ${hoehe}${breite ? ' ' + breite : ''} | ${p.preis_stueck_eur || '?'}€ | Pflege: ${'★'.repeat(p.pflege_sterne || 2)}${lebensb}${kombi}${extras ? ' | ' + extras : ''}`;
    }).join('\n');
    prompt += '\n\nKauflinks: https://www.amazon.de/s?k=BOTANISCHERNAME&tag=gartenbaukosten-21 (BOTANISCHERNAME URL-kodiert).';
  }

  if (wissen.length > 0) {
    prompt += '\n\n## EXPERTENWISSEN BEPFLANZUNGSPLANUNG:\n';
    prompt += wissen.map(w => `### ${w.titel}\n${w.inhalt.substring(0, 600)}`).join('\n\n');
  }

  return prompt;
}

// ─── Routes ───────────────────────────────────────────────────────────────────

app.get('/', (req, res) => {
  try {
    // Inject SEO content from DB into the SPA
    const pflanzenCount = db.prepare("SELECT COUNT(*) as n FROM pflanzen WHERE name_deutsch != 'Test-Pflanze'").get().n;
    let wissenCount = 0;
    try { wissenCount = db.prepare('SELECT COUNT(*) as n FROM wissen').get().n; } catch {}

    // Featured ratgeber (first 6)
    let ratgeberPreviews = [];
    try { ratgeberPreviews = db.prepare('SELECT rowid, titel, kategorie, inhalt FROM wissen ORDER BY rowid LIMIT 6').all(); } catch {}

    // Featured plants (diverse selection)
    const featuredPflanzen = db.prepare(`
      SELECT name_deutsch, name_botanisch, licht, bluehzeit, farbe, beschreibung
      FROM pflanzen ORDER BY RANDOM() LIMIT 8
    `).all();

    function slugify(s) {
      return s.toLowerCase()
        .replace(/ä/g,'ae').replace(/ö/g,'oe').replace(/ü/g,'ue').replace(/ß/g,'ss')
        .replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');
    }

    const ratgeberHTML = ratgeberPreviews.map(r => `
      <a class="seo-artikel-card" href="/ratgeber/${slugify(r.titel)}">
        <span class="sac-kat">${r.kategorie}</span>
        <span class="sac-titel">${r.titel}</span>
        <span class="sac-excerpt">${r.inhalt.substring(0,100)}…</span>
        <span class="sac-more">Weiterlesen →</span>
      </a>`).join('');

    const pflanzenHTML = featuredPflanzen.map(p => `
      <a class="seo-pflanze-card" href="/pflanze/${slugify(p.name_botanisch)}">
        <span class="spc-name">${p.name_deutsch}</span>
        <span class="spc-bot">${p.name_botanisch}</span>
        ${p.bluehzeit ? `<span class="spc-tag">${p.bluehzeit}</span>` : ''}
        ${p.licht ? `<span class="spc-tag">${p.licht.split('|')[0]}</span>` : ''}
      </a>`).join('');

    const fs = require('fs');
    let html = fs.readFileSync(path.join(__dirname, 'stauden-portal.html'), 'utf8');
    html = html.replace(/__PFLANZEN_COUNT__/g, pflanzenCount);

  // Inject SEO sections before </body>
  const seoSection = `
<!-- SEO Content (server-rendered) -->
<div id="seo-content">
  <!-- Stats Banner -->
  <section class="seo-stats">
    <div class="seo-stats-inner">
      <div class="seo-stat"><strong>${pflanzenCount}</strong><span>Stauden in der Datenbank</span></div>
      <div class="seo-stat"><strong>${wissenCount}</strong><span>Ratgeber-Artikel</span></div>
      <div class="seo-stat"><strong>100%</strong><span>Kostenlos &amp; ohne Anmeldung</span></div>
      <div class="seo-stat"><strong>KI</strong><span>Personalisierter Plan in 2 Min.</span></div>
    </div>
  </section>

  <!-- Intro Text -->
  <section class="seo-intro">
    <div class="seo-intro-inner">
      <h2>Bepflanzungsplan online kostenlos erstellen — KI-gestützt & individuell</h2>
      <p>Ein professioneller <strong>Bepflanzungsplan</strong> ist die Grundlage für ein schönes, pflegeleichtes Staudenbeet. Unser KI-Gartenplaner erstellt dir in wenigen Minuten einen maßgeschneiderten Plan — abgestimmt auf Standort, Bodentyp, Gartenstil und deine persönlichen Wünsche. Mit über <strong>${pflanzenCount} geprüften, winterharten Stauden</strong> für deutsche Gärten.</p>
      <p>Anders als generische KI-Tools nutzt unser Planer eine kuratierte Pflanzendatenbank mit echten Staudenexperten-Wissen: Lebensbereiche nach Hansen &amp; Stahl, ökologisch wertvolle Heimische, bewährte Pflanzenkombinationen. Das Ergebnis ist ein <strong>Bepflanzungsplan der wirklich funktioniert</strong> — mit Stückliste, grafischem Plan und direkter Bestellmöglichkeit.</p>
    </div>
  </section>

  <!-- How It Works -->
  <section class="seo-how">
    <div class="seo-section-inner">
      <h2>So erstellt du deinen Bepflanzungsplan</h2>
      <div class="seo-steps">
        <div class="seo-step"><div class="ss-num">1</div><h3>Garten beschreiben</h3><p>Fläche, Lichtbedingungen, Bodentyp und gewünschten Gartenstil eingeben — oder die Fläche direkt im Plan einzeichnen.</p></div>
        <div class="seo-step"><div class="ss-num">2</div><h3>KI generiert deinen Plan</h3><p>Unsere KI durchsucht ${pflanzenCount} geprüfte Stauden und ${wissenCount} Expertentexte — und erstellt einen individuellen, standortgerechten Bepflanzungsplan.</p></div>
        <div class="seo-step"><div class="ss-num">3</div><h3>Pflanzen bestellen</h3><p>Mit Stückliste, grafischem Pflanzplan und Jahreskalender. Die Pflanzen können direkt als Komplettpaket bestellt werden.</p></div>
      </div>
    </div>
  </section>

  <!-- Ratgeber Preview -->
  <section class="seo-ratgeber">
    <div class="seo-section-inner">
      <div class="seo-section-header">
        <h2>Ratgeber: Staudenbeete planen &amp; gestalten</h2>
        <a href="/ratgeber" class="seo-mehr-link">Alle ${wissenCount} Artikel →</a>
      </div>
      <div class="seo-artikel-grid">${ratgeberHTML}</div>
    </div>
  </section>

  <!-- Plant Preview -->
  <section class="seo-pflanzen">
    <div class="seo-section-inner">
      <div class="seo-section-header">
        <h2>Aus unserem Stauden-Lexikon</h2>
        <a href="/pflanzen" class="seo-mehr-link">Alle ${pflanzenCount} Stauden →</a>
      </div>
      <div class="seo-pflanzen-grid">${pflanzenHTML}</div>
    </div>
  </section>

  <!-- Footer -->
  <footer class="seo-footer">
    <div class="seo-footer-inner">
      <div class="seo-footer-col">
        <h4>🌿 Staudenplan.de</h4>
        <p>KI-gestützte Gartenplanung mit ${pflanzenCount} winterharten Stauden für deutsche Gärten.</p>
      </div>
      <div class="seo-footer-col">
        <h4>Ratgeber</h4>
        <ul>
          <li><a href="/ratgeber/staudenbeet-anlegen-schritt-fuer-schritt-anleitung">Staudenbeet anlegen</a></li>
          <li><a href="/ratgeber/stauden-fuer-den-schatten-die-besten-arten-fuer-dunkle-beete">Stauden für Schatten</a></li>
          <li><a href="/ratgeber/pflegeleichte-stauden-fuer-wenig-arbeit-im-garten">Pflegeleichte Stauden</a></li>
          <li><a href="/ratgeber/stauden-kombinieren-so-entstehen-schoene-beete">Stauden kombinieren</a></li>
          <li><a href="/ratgeber/stauden-fuer-bienen-und-insekten-insektenfreundlicher-garten">Bienenfreundliche Stauden</a></li>
          <li><a href="/ratgeber">Alle Ratgeber →</a></li>
        </ul>
      </div>
      <div class="seo-footer-col">
        <h4>Beliebte Stauden</h4>
        <ul>
          <li><a href="/pflanze/geranium-sanguineum">Storchschnabel</a></li>
          <li><a href="/pflanze/hosta-sieboldiana">Funkie / Hosta</a></li>
          <li><a href="/pflanze/salvia-nemorosa">Ziersalbei</a></li>
          <li><a href="/pflanze/echinacea-purpurea">Sonnenhut</a></li>
          <li><a href="/pflanze/nepeta-x-faassenii">Katzenminze</a></li>
          <li><a href="/pflanzen">Alle ${pflanzenCount} Stauden →</a></li>
        </ul>
      </div>
      <div class="seo-footer-col">
        <h4>Bepflanzungsplan</h4>
        <ul>
          <li><a href="/">Kostenlosen Plan erstellen</a></li>
          <li><a href="/pflanzen">Stauden-Lexikon</a></li>
          <li><a href="/ratgeber">Garten-Ratgeber</a></li>
          <li><a href="/ratgeber/bepflanzungsplan-garten-kostenlos-erstellen-so-geht-s">Plan selbst erstellen</a></li>
          <li><a href="/ratgeber/stauden-kaufen-worauf-beim-kauf-achten">Stauden kaufen</a></li>
        </ul>
      </div>
    </div>
    <div class="seo-footer-bottom">
      <p>© 2025 Staudenplan.de · Betrieben von <a href="https://www.freisinger-gartenschmiede.de" style="color:rgba(255,255,255,.6)" target="_blank">Gartenschmiede GmbH</a> · <a href="/impressum" style="color:rgba(255,255,255,.6)">Impressum</a> · <a href="/datenschutz" style="color:rgba(255,255,255,.6)">Datenschutz</a></p>
    </div>
  </footer>
</div>

<style>
/* ── SEO-Content Styles ─────────────────────────────── */
#seo-content { font-family:'Segoe UI',system-ui,sans-serif; }
.seo-stats { background:#1b4332; color:#fff; padding:28px 20px; }
.seo-stats-inner { max-width:900px; margin:0 auto; display:flex; gap:0; flex-wrap:wrap; justify-content:center; }
.seo-stat { text-align:center; padding:16px 32px; border-right:1px solid rgba(255,255,255,.15); }
.seo-stat:last-child { border-right:none; }
.seo-stat strong { display:block; font-size:2rem; font-weight:800; color:#52b788; }
.seo-stat span { font-size:.82rem; opacity:.8; margin-top:2px; display:block; }
.seo-intro { background:#f8f4ef; padding:48px 20px; }
.seo-intro-inner { max-width:800px; margin:0 auto; }
.seo-intro h2 { font-size:1.5rem; color:#1b4332; margin-bottom:16px; line-height:1.3; }
.seo-intro p { font-size:1rem; color:#444; line-height:1.75; margin-bottom:12px; }
.seo-how { background:#fff; padding:48px 20px; }
.seo-section-inner { max-width:960px; margin:0 auto; }
.seo-section-header { display:flex; justify-content:space-between; align-items:center; margin-bottom:24px; flex-wrap:wrap; gap:8px; }
.seo-section-header h2 { font-size:1.4rem; color:#1b4332; }
.seo-mehr-link { color:#2d6a4f; font-weight:600; font-size:.9rem; text-decoration:none; }
.seo-mehr-link:hover { text-decoration:underline; }
.seo-how h2 { font-size:1.4rem; color:#1b4332; margin-bottom:28px; }
.seo-steps { display:grid; grid-template-columns:repeat(auto-fill,minmax(240px,1fr)); gap:20px; }
.seo-step { background:#f8f4ef; border-radius:12px; padding:24px; }
.ss-num { background:#2d6a4f; color:#fff; width:32px; height:32px; border-radius:50%; display:flex; align-items:center; justify-content:center; font-weight:800; font-size:1rem; margin-bottom:12px; }
.seo-step h3 { font-size:1rem; color:#1b4332; margin-bottom:8px; }
.seo-step p { font-size:.88rem; color:#555; line-height:1.6; }
.seo-ratgeber { background:#f0fdf4; padding:48px 20px; }
.seo-artikel-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(240px,1fr)); gap:14px; }
.seo-artikel-card { background:#fff; border-radius:10px; padding:16px; text-decoration:none; color:inherit; box-shadow:0 2px 8px rgba(0,0,0,.07); display:flex; flex-direction:column; gap:5px; transition:transform .12s; }
.seo-artikel-card:hover { transform:translateY(-2px); }
.sac-kat { font-size:.72rem; color:#52b788; font-weight:700; text-transform:uppercase; letter-spacing:.05em; }
.sac-titel { font-size:.92rem; font-weight:700; color:#1b4332; line-height:1.3; }
.sac-excerpt { font-size:.8rem; color:#777; line-height:1.5; flex:1; }
.sac-more { font-size:.78rem; color:#2d6a4f; font-weight:600; }
.seo-pflanzen { background:#fff; padding:48px 20px; }
.seo-pflanzen-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(160px,1fr)); gap:10px; }
.seo-pflanze-card { background:#f8f4ef; border-radius:10px; padding:14px; text-decoration:none; color:inherit; display:flex; flex-direction:column; gap:4px; transition:transform .12s; }
.seo-pflanze-card:hover { transform:translateY(-2px); background:#d8f3dc; }
.spc-name { font-weight:700; font-size:.9rem; color:#1b4332; }
.spc-bot { font-size:.73rem; font-style:italic; color:#888; }
.spc-tag { font-size:.7rem; background:#e0f0e8; color:#2d6a4f; border-radius:4px; padding:1px 7px; align-self:flex-start; margin-top:2px; }
.seo-footer { background:#1b4332; color:#fff; padding:48px 20px 24px; }
.seo-footer-inner { max-width:960px; margin:0 auto; display:grid; grid-template-columns:repeat(auto-fill,minmax(200px,1fr)); gap:32px; margin-bottom:32px; }
.seo-footer h4 { font-size:.95rem; margin-bottom:12px; color:#52b788; }
.seo-footer p { font-size:.82rem; opacity:.8; line-height:1.6; }
.seo-footer ul { list-style:none; padding:0; }
.seo-footer ul li { margin-bottom:6px; }
.seo-footer a { color:rgba(255,255,255,.75); text-decoration:none; font-size:.82rem; }
.seo-footer a:hover { color:#fff; text-decoration:underline; }
.seo-footer-bottom { max-width:960px; margin:0 auto; border-top:1px solid rgba(255,255,255,.1); padding-top:16px; font-size:.78rem; opacity:.6; }
@media(max-width:600px) {
  .seo-stat { padding:12px 16px; }
  .seo-intro h2 { font-size:1.2rem; }
  .seo-footer-inner { grid-template-columns:1fr 1fr; }
}
</style>`;

    html = html.replace('</body>', seoSection + '</body>');
    res.send(html);
  } catch (err) {
    console.error('Root route Fehler:', err.message);
    res.status(500).send(`<h1>Fehler beim Laden der Startseite</h1><p>${err.message}</p><a href="/">Zurück</a>`);
  }
});

function getKlimaregion(plz) {
  if (!plz || plz.length < 2) return null;
  const n = parseInt(plz.substring(0, 2));
  if (n <= 19) return 'Ostdeutschland (kontinental: trockene, heiße Sommer, kalte Winter — trockenheitstolerante und frostharte Arten bevorzugen)';
  if (n <= 39) return 'Norddeutschland/Küste (maritim: mild, feucht, Spätfrost selten — feuchtigkeitsverträgliche und windrobuste Arten bevorzugen)';
  if (n <= 59) return null; // NRW/Mitte — Standardklima, kein besonderer Hinweis nötig
  if (n <= 69) return 'Rheintal/Rhein-Main (warm, relativ trocken, lange Vegetationsperiode — wärmeliebende und trockenheitstolerante Arten gut geeignet, mediterrane Stauden möglich)';
  if (n <= 79) return 'Baden-Württemberg (gemäßigt bis kühl in Höhenlagen — auf Lage im Tal vs. Höhenlage achten, hohe Niederschläge im Schwarzwald)';
  return 'Bayern/Alpenvorland (kontinental: heiße Sommer, kalte Winter, Spätfrost bis Mai möglich, oft Kalkboden — frostharte und kalkverträgliche Arten bevorzugen, Trockenheitstoleranz wichtig)';
}

app.post('/api/plan', planLimiter, async (req, res) => {
  const { gartenflaeche, licht, boden, standort_beschreibung, stil, sichtseite, farbe, saison,
          lieblingspflanzen, budget, nutzung, pflegezeit, vielfalt, dichte, plz } = req.body;

  if (!gartenflaeche || !licht || !boden || !stil) {
    return res.status(400).json({ error: 'Bitte alle Pflichtfelder ausfüllen.' });
  }

  // RAG: Hol Kontext aus der Wissensdatenbank
  const feuchtigkeit = getFeuchtigkeit(boden, standort_beschreibung);
  const kandidaten = getPflanzenkandidaten(licht, boden, stil, standort_beschreibung);
  const wissen = getRelevantesWissen(stil, licht, feuchtigkeit);

  if (kandidaten.length > 0) {
    console.log(`RAG: ${kandidaten.length} Pflanzenkandidaten (feuchtigkeit=${feuchtigkeit}), ${wissen.length} Wissensdokumente`);
  }

  const systemPrompt = buildSystemPrompt(kandidaten, wissen);

  const lieblingsList = Array.isArray(lieblingspflanzen) && lieblingspflanzen.length > 0
    ? lieblingspflanzen.map(p => `${p.name_deutsch} (${p.name_botanisch})`).join(', ')
    : null;
  const nutzungList = Array.isArray(nutzung) && nutzung.length > 0
    ? nutzung.join(', ')
    : null;

  const vielfaltAnweisung = (() => {
    if (vielfalt === 'wenig') return `Empfehle exakt 3–4 geeignete, winterharte Stauden. Setze auf wenige, klar strukturierte Arten mit hoher Wiederholung — ruhige, schlichte Beetwirkung.`;
    if (vielfalt === 'viel') return `Empfehle mindestens 8 verschiedene, winterharte Stauden — bei Flächen über 20 m² gerne bis zu 20 Arten. Maximale Artenvielfalt, kleine Gruppen je Art, hohe Biodiversität.`;
    return `Empfehle 5–8 geeignete, winterharte Stauden.`;
  })();

  const dichteAnweisung = (() => {
    const ppm2 = dichte === 'locker' ? 2.5 : dichte === 'dicht' ? 7 : 4;
    const ziel = Math.round(gartenflaeche * ppm2);
    if (dichte === 'locker') return `Pflanzdichte: locker (2–3 Pflanzen/m²). Gesamtziel ca. ${ziel} Pflanzen für ${gartenflaeche} m². Großzügige Abstände, etwas offener Boden sichtbar.`;
    if (dichte === 'dicht') return `Pflanzdichte: dicht (6–8 Pflanzen/m²). Gesamtziel ca. ${ziel} Pflanzen für ${gartenflaeche} m². Lückenlose Flächendeckung, kein freier Boden.`;
    return `Pflanzdichte: normal (3–5 Pflanzen/m²). Gesamtziel ca. ${ziel} Pflanzen für ${gartenflaeche} m². Gute Flächendeckung mit natürlicher Wirkung.`;
  })();

  const klimaregion = getKlimaregion(plz);

  const userPrompt = `Erstelle einen Bepflanzungsplan für einen Privatgarten:
- Fläche: ${gartenflaeche} m²
- Standort: ${standort_beschreibung || `${licht}, ${boden}`}
- Lichtbedingungen: ${licht}
- Bodentyp: ${boden}
- Gartenstil: ${stil}
- Beettyp / Sichtseite: ${sichtseite || 'einseitig'}
- Farbwunsch: ${farbe || 'keine Präferenz'}
- Blühsaison-Priorität: ${saison || 'ganzjährig'}${plz ? `\n- Region (PLZ ${plz}): ${klimaregion || 'Mitteleuropa, gemäßigtes Klima'}` : ''}${lieblingsList ? `\n- Lieblingspflanzen (unbedingt einplanen): ${lieblingsList}` : ''}${budget ? `\n- Budget: maximal ${budget} € Gesamtkosten` : ''}${nutzungList ? `\n- Gartennutzung/Schwerpunkt: ${nutzungList}` : ''}${pflegezeit ? `\n- Gewünschte Pflegeintensität: ${pflegezeit}` : ''}

${lieblingsList ? `WICHTIG ZU DEN LIEBLINGSPFLANZEN: Prüfe ob die gewünschten Pflanzen zum angegebenen Standort (${licht}, ${boden}, Feuchtigkeit: ${feuchtigkeit}) passen. Falls eine Pflanze nicht passt, weise im "tipps"-Feld explizit darauf hin und schlage eine Alternative vor. Dennoch: Baue alle Lieblingspflanzen ein, sofern irgendwie vertretbar.\n` : ''}${sichtseite && sichtseite.includes('Einseitig') ? 'ANORDNUNG: Einseitig einsehbares Beet — hohe Pflanzen (>80 cm) im Hintergrund, mittlere in der Mitte, niedrige (<40 cm) im Vordergrund. Im Feld "standort" jeder Pflanze angeben: "Hintergrund", "Mitte" oder "Vordergrund".' : ''}${sichtseite && sichtseite.includes('Rundbeet') ? 'ANORDNUNG: Rundbeet / Inselbeet — höchste Pflanzen in der Mitte, nach außen abnehmende Höhen. Im Feld "standort" angeben: "Mitte", "Mittelzone" oder "Rand".' : ''}${sichtseite && sichtseite.includes('Eckbeet') ? 'ANORDNUNG: Eckbeet — höchste Pflanzen an der Ecke/Rückwand, diagonal nach vorne-links und vorne-rechts abfallend. Im Feld "standort" angeben: "Ecke/Hintergrund", "Mitte" oder "Vordergrund".' : ''}
${vielfaltAnweisung} ${dichteAnweisung} Berechne Stückzahlen für ${gartenflaeche} m².
STÜCKZAHLBERECHNUNG: Nutze das Feld "Ø[X]cm" (Ausbreitung) aus der Pflanzenliste für realistische Abstände. Formel: Stückzahl = zugewiesene Fläche / (Ø_cm/100)². Leitstauden erhalten 25–35% der Fläche geteilt durch ihre Stückzahl. Füllstauden füllen die restliche Fläche lückenlos.
Plane IMMER auch 3–4 schnellwüchsige Füllstauden oder Bodendecker ein (z.B. Storchschnabel, Katzenminze, Frauenmantel, Elfenblume, Immergrün), die freie Flächen zwischen Hauptstauden schließen. Diese sollen einen Großteil der Fläche bedecken.
${lieblingsList ? 'Die genannten Lieblingspflanzen MÜSSEN im Plan enthalten sein.' : ''}${budget ? ` Halte die Gesamtkosten unter ${budget} €.` : ''}
${kandidaten.length > 0 ? 'Wähle primär aus der bereitgestellten Pflanzenliste.' : ''}

Vergib jeder Pflanze eine Rolle nach Hansen & Stahl: "Leitstaude" (1–3 auffällige Strukturpflanzen, max. 3 Arten), "Begleitstaude" (rahmt Leitstauden ein, 3–5 Arten), "Füllstaude" (Bodendecker/Lückenfüller, Rest). Leitstauden sind die visuellen Ankerpunkte des Beetes.

PFLANZKALENDER-HINWEIS: Im Feld "pflanzkalender" stehen nicht nur Blühzeiten, sondern auch Winterschmuck-Pflanzen. Im Abschnitt "Winter" alle Pflanzen aus dem Plan auflisten, die im Winter Zierwert haben: Gräser mit dekorativen Samenständen (z.B. Miscanthus, Pennisetum, Panicum, Calamagrostis), Stauden mit stehenbleibenden Fruchtständen oder markanter Silhouette (z.B. Rudbeckia, Echinacea, Sedum/Hylotelephium, Eryngium) sowie wintergrüne Bodendecker. Auch wenn keine Pflanze blüht — die Winter-Liste soll immer mindestens 2–3 Einträge haben, sofern solche Pflanzen im Plan enthalten sind.

JSON-Format:
{
  "pflanzen": [{
    "name_deutsch": "...",
    "name_botanisch": "...",
    "beschreibung": "...",
    "standort": "...",
    "bluehzeit": "...",
    "farbe": "...",
    "hoehe_cm": 0,
    "pflege_sterne": 1,
    "rolle": "Leitstaude",
    "stueckzahl": 0,
    "preis_stueck_eur": 0.00,
    "kauflink": "https://www.amazon.de/s?k=...&tag=gartenbaukosten-21"
  }],
  "beetbeschreibung": "2–3 Sätze die den Charakter und die Gesamtwirkung des Beetes beschreiben — Stil, Farbstimmung, saisonale Höhepunkte, Atmosphäre. Formuliere so, als würdest du einem Gartenbesucher das Konzept erklären.",
  "gesamtkosten_geschaetzt": "...",
  "pflanzabstand_hinweis": "...",
  "pflanzkalender": { "Frühling": [], "Sommer": [], "Herbst": [], "Winter": [] },
  "tipps": []
}`;

  try {
    const completion = await getOpenAI().chat.completions.create({
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      temperature: 0.6,
      response_format: { type: 'json_object' }
    });

    const plan = JSON.parse(completion.choices[0].message.content);

    // Bilder + Pflanzabstand aus DB anreichern
    if (Array.isArray(plan.pflanzen)) {
      plan.pflanzen = plan.pflanzen.map(p => {
        const genus = p.name_botanisch.split(' ')[0];
        const dbP = db.prepare(
          'SELECT bild_url, inhalt_lang FROM pflanzen WHERE name_botanisch = ? OR name_botanisch LIKE ? LIMIT 1'
        ).get(p.name_botanisch, `${genus}%`);
        let pflanzabstand_cm = null, fehler = null;
        if (dbP?.inhalt_lang) {
          try {
            const il = JSON.parse(dbP.inhalt_lang);
            const m = (il.pflanzabstand || '').match(/(\d+)\s*[–\-]\s*(\d+)?\s*cm/i);
            if (m) pflanzabstand_cm = m[2] ? Math.round((parseInt(m[1]) + parseInt(m[2])) / 2) : parseInt(m[1]);
            if (Array.isArray(il.fehler) && il.fehler.length) fehler = il.fehler;
          } catch {}
        }
        return { ...p, bild_url: dbP?.bild_url || null, pflanzabstand_cm, fehler };
      });
    }

    res.json({ success: true, plan, rag: { kandidaten: kandidaten.length, wissen: wissen.length } });
  } catch (err) {
    console.error('OpenAI Fehler:', err.message);
    res.status(500).json({ error: 'Fehler bei der KI-Planung. Bitte versuche es erneut.' });
  }
});

app.post('/api/alternativ', alternativLimiter, (req, res) => {
  const { licht, boden, stil, rolle, ausschliessen } = req.body;
  if (!licht) return res.status(400).json({ error: 'licht erforderlich' });

  const lichtTerm = LICHT_MAP[licht] || (licht.includes('Vollsonne') ? 'Sonne' : licht.includes('Halbschatten') ? 'Halbschatten' : 'Schatten');
  const bodenTerm = boden && (boden.toLowerCase().includes('sandig')) ? 'Sandig'
    : boden && (boden.toLowerCase().includes('lehmig')) ? 'Lehmig' : 'Normal';
  const stilTerm = (stil || '').split(' ')[0] || '';
  const exclude = Array.isArray(ausschliessen) && ausschliessen.length ? ausschliessen : null;
  const exClause = exclude ? `AND name_botanisch NOT IN (${exclude.map(() => '?').join(',')})` : '';

  const COLS = `name_deutsch, name_botanisch, beschreibung, licht, boden, stil,
    bluehzeit, farbe, hoehe_cm_min, hoehe_cm_max, pflege_sterne, preis_stueck_eur,
    bienen_freundlich, heimisch, feuchtigkeit, wuchs, lebensbereich, breite_cm_max,
    rolle_empfehlung, kombinationspartner, winteraspekt, trockenheitstoleranz, bild_url, inhalt_lang`;

  let pflanze = null;

  if (!pflanze) {
    const rows = db.prepare(`SELECT ${COLS} FROM pflanzen
      WHERE licht LIKE ? AND (boden LIKE ? OR boden LIKE ?) AND stil LIKE ?
        AND (wuchs IS NULL OR wuchs != 'invasiv')
        AND (status IS NULL OR status = 'live') ${exClause}
      ORDER BY RANDOM() LIMIT 1`)
      .all(`%${lichtTerm}%`, `%${bodenTerm}%`, '%normal%', `%${stilTerm}%`, ...(exclude || []));
    if (rows.length) pflanze = rows[0];
  }
  if (!pflanze) {
    const rows = db.prepare(`SELECT ${COLS} FROM pflanzen
      WHERE licht LIKE ? AND (wuchs IS NULL OR wuchs != 'invasiv')
        AND (status IS NULL OR status = 'live') ${exClause}
      ORDER BY RANDOM() LIMIT 1`)
      .all(`%${lichtTerm}%`, ...(exclude || []));
    if (rows.length) pflanze = rows[0];
  }

  if (!pflanze) return res.status(404).json({ error: 'Keine Alternative gefunden.' });

  const hoehe_cm = pflanze.hoehe_cm_max
    ? Math.round(((pflanze.hoehe_cm_min || 0) + pflanze.hoehe_cm_max) / 2) : 50;

  let fehler = null;
  if (pflanze.inhalt_lang) {
    try { const il = JSON.parse(pflanze.inhalt_lang); if (Array.isArray(il.fehler)) fehler = il.fehler; } catch {}
  }
  const { inhalt_lang: _, ...pflanzeOhneInhalt } = pflanze;

  res.json({
    success: true,
    pflanze: {
      ...pflanzeOhneInhalt,
      hoehe_cm, fehler,
      kauflink: `https://www.amazon.de/s?k=${encodeURIComponent(pflanze.name_botanisch)}&tag=gartenbaukosten-21`,
      rolle: rolle || (hoehe_cm >= 80 ? 'Leitstaude' : hoehe_cm >= 40 ? 'Begleitstaude' : 'Füllstaude'),
    }
  });
});

app.post('/api/email-gate', rateLimit({ windowMs: 60*60*1000, max: 10, message: { error: 'Zu viele Anfragen.' } }), (req, res) => {
  const { email, gartenflaeche, licht, stil } = req.body;
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Bitte eine gültige E-Mail-Adresse eingeben.' });
  }
  try {
    db.prepare(`INSERT INTO email_gate (email, gartenflaeche, licht, stil) VALUES (?, ?, ?, ?)`)
      .run(email, gartenflaeche || null, licht || null, stil || null);
    res.json({ success: true });
  } catch (err) {
    console.error('Email-Gate Fehler:', err.message);
    res.status(500).json({ error: 'Fehler beim Speichern.' });
  }
});

app.post('/api/anfrage', anfrageLimiter, async (req, res) => {
  const { name, email, plz, telefon, anmerkungen, gartenparameter, ki_plan } = req.body;

  if (!name || !email || !plz) {
    return res.status(400).json({ error: 'Bitte Name, E-Mail und PLZ angeben.' });
  }

  const params = gartenparameter || {};

  try {
    db.prepare(`
      INSERT INTO anfragen (name, email, plz, telefon, anmerkungen, gartenflaeche, licht, boden, stil, farbe, saison, ki_plan)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      name, email, plz, telefon || null, anmerkungen || null,
      params.gartenflaeche || null, params.licht || null, params.boden || null,
      params.stil || null, params.farbe || null, params.saison || null,
      ki_plan ? JSON.stringify(ki_plan) : null
    );
  } catch (err) {
    console.error('DB Fehler:', err.message);
    return res.status(500).json({ error: 'Datenbankfehler beim Speichern.' });
  }

  const pflanzenListe = ki_plan?.pflanzen
    ? ki_plan.pflanzen.map(p =>
        `  • ${p.stueckzahl}x ${p.name_deutsch} (${p.name_botanisch}) — ca. ${(p.preis_stueck_eur * p.stueckzahl).toFixed(2)} €`
      ).join('\n')
    : '  — keine Pflanzenliste vorhanden';

  const betreiberText = `Neue Bepflanzungsanfrage\n\nName: ${name}\nE-Mail: ${email}\nPLZ: ${plz}\nTelefon: ${telefon || '—'}\n\nGartenparameter:\n  Fläche: ${params.gartenflaeche || '—'} m²\n  Licht: ${params.licht || '—'}\n  Boden: ${params.boden || '—'}\n  Stil: ${params.stil || '—'}\n  Farbe: ${params.farbe || '—'}\n  Saison: ${params.saison || '—'}\n\nEmpfohlene Pflanzen:\n${pflanzenListe}\n\nGeschätzte Gesamtkosten: ${ki_plan?.gesamtkosten_geschaetzt || '—'}\n\nAnmerkungen:\n  ${anmerkungen || '—'}`;
  const kundenText = `Hallo ${name},\n\nvielen Dank für Ihre Anfrage! Wir haben Ihren persönlichen Bepflanzungsplan erhalten und melden uns in Kürze mit einem konkreten Angebot für die Lieferung Ihrer Stauden.\n\nIhr Bepflanzungsplan umfasst:\n${pflanzenListe}\n\nGeschätzte Gesamtkosten: ${ki_plan?.gesamtkosten_geschaetzt || 'auf Anfrage'}\n\nFreundliche Grüße\nIhr Stauden-Team`;

  if (process.env.EMAIL_USER && process.env.EMAIL_BETREIBER) {
    try {
      await transporter.sendMail({ from: process.env.EMAIL_USER, to: process.env.EMAIL_BETREIBER, subject: `Neue Bepflanzungsanfrage von ${name} (PLZ ${plz})`, text: betreiberText });
      await transporter.sendMail({ from: process.env.EMAIL_USER, to: email, subject: 'Ihr Bepflanzungsplan — wir melden uns bald!', text: kundenText });
    } catch (err) { console.error('E-Mail Fehler:', err.message); }
  } else {
    console.log('--- E-Mail (Betreiber) ---\n' + betreiberText);
  }

  res.json({ success: true, message: 'Anfrage erfolgreich gesendet.' });
});

// ─── robots.txt ──────────────────────────────────────────────────────────────
// ─── IndexNow ─────────────────────────────────────────────────────────────────
const INDEXNOW_KEY = '57b3c160fda14faa96ad948cb07805aa';

app.get(`/${INDEXNOW_KEY}.txt`, (req, res) => {
  res.type('text/plain').send(INDEXNOW_KEY);
});

app.get('/robots.txt', (req, res) => {
  const base = process.env.SITE_URL || `${req.protocol}://${req.hostname}`;
  res.type('text/plain');
  res.send(`User-agent: *\nAllow: /\nSitemap: ${base}/sitemap.xml\n`);
});

// ─── Sitemap.xml ──────────────────────────────────────────────────────────────
app.get('/sitemap.xml', (req, res) => {
  const base = process.env.SITE_URL || `${req.protocol}://${req.hostname}`;
  const pflanzen = db.prepare('SELECT name_botanisch FROM pflanzen').all();
  let wissens = [];
  try { wissens = db.prepare('SELECT titel FROM wissen').all(); } catch {}

  function slugify(s) {
    return s.toLowerCase()
      .replace(/ä/g,'ae').replace(/ö/g,'oe').replace(/ü/g,'ue').replace(/ß/g,'ss')
      .replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');
  }

  const urls = [
    `<url><loc>${base}/</loc><changefreq>weekly</changefreq><priority>1.0</priority></url>`,
    `<url><loc>${base}/pflanzen</loc><changefreq>weekly</changefreq><priority>0.9</priority></url>`,
    `<url><loc>${base}/ratgeber</loc><changefreq>weekly</changefreq><priority>0.9</priority></url>`,
    ...pflanzen.map(p => `<url><loc>${base}/pflanze/${slugify(p.name_botanisch)}</loc><changefreq>monthly</changefreq><priority>0.7</priority></url>`),
    ...wissens.map(w => `<url><loc>${base}/ratgeber/${slugify(w.titel)}</loc><changefreq>monthly</changefreq><priority>0.8</priority></url>`),
  ];

  res.type('application/xml');
  res.send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>`);
});

// ─── Pflanzen-API (für Client-Suche) ─────────────────────────────────────────
app.get('/api/pflanzen', pflanzenLimiter, (req, res) => {
  const q = (req.query.q || '').toLowerCase();
  let pflanzen = db.prepare(`
    SELECT name_deutsch, name_botanisch, licht, farbe, bluehzeit,
           hoehe_cm_min, hoehe_cm_max, stil, pflege_sterne, beschreibung,
           feuchtigkeit, wuchs, bild_url, bienen_freundlich, heimisch
    FROM pflanzen ORDER BY name_deutsch
  `).all();
  if (q) {
    pflanzen = pflanzen.filter(p =>
      p.name_deutsch.toLowerCase().includes(q) ||
      p.name_botanisch.toLowerCase().includes(q) ||
      (p.farbe || '').toLowerCase().includes(q) ||
      (p.stil || '').toLowerCase().includes(q)
    );
  }
  res.json(pflanzen);
});

// ─── SEO-Hilfsfunktionen ──────────────────────────────────────────────────────

function slugify(str) {
  return str.toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function pflanzeToSlug(name_botanisch) {
  return slugify(name_botanisch);
}

// ─── Impressum & Datenschutz ─────────────────────────────────────────────────

const LEGAL_STYLE = `
  <style>
    *{box-sizing:border-box;margin:0;padding:0}body{font-family:'Segoe UI',system-ui,sans-serif;background:#f8f4ef;color:#1a1a1a}
    nav{background:#1b4332;padding:14px 24px;display:flex;align-items:center;gap:12px}
    nav a{color:#fff;text-decoration:none;font-size:.9rem}nav a:hover{text-decoration:underline}
    nav .brand{font-weight:700;font-size:1rem;margin-right:auto}
    main{max-width:780px;margin:40px auto;padding:0 20px 80px}
    h1{font-size:1.8rem;color:#1b4332;margin-bottom:28px}
    h2{font-size:1.15rem;color:#1b4332;margin:28px 0 10px;padding-bottom:6px;border-bottom:2px solid #d8f3dc}
    p{line-height:1.75;margin-bottom:12px;font-size:.95rem;color:#333}
    a{color:#2d6a4f}ul{padding-left:20px;margin-bottom:12px}li{margin-bottom:6px;font-size:.95rem;color:#333;line-height:1.6}
    footer{text-align:center;padding:24px;color:#888;font-size:.8rem;border-top:1px solid #e9dcc9}
    footer a{color:#2d6a4f}
  </style>`;

const LEGAL_NAV = `<nav>
  <span class="brand"><a href="/" style="color:#fff;text-decoration:none">🌿 Staudenplan.de</a></span>
  <a href="/">Planer</a><a href="/pflanzen">Stauden-Lexikon</a><a href="/ratgeber">Ratgeber</a>
</nav>`;

const LEGAL_FOOTER = `<footer>
  © 2025 Staudenplan.de — Betrieben von Gartenschmiede GmbH ·
  <a href="/impressum">Impressum</a> · <a href="/datenschutz">Datenschutz</a>
</footer>`;

app.get('/impressum', (req, res) => {
  res.send(`<!DOCTYPE html><html lang="de"><head>
  <meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Impressum — Staudenplan.de</title>
  <meta name="robots" content="noindex">
  ${LEGAL_STYLE}</head><body>
  ${LEGAL_NAV}
  <main>
    <h1>Impressum</h1>
    <h2>Angaben gemäß § 5 TMG</h2>
    <p><strong>Gartenschmiede GmbH</strong><br>
    Ortsstraße 7<br>85354 Freising</p>
    <h2>Kontakt</h2>
    <p>Telefon: 08161 97 60 380<br>
    E-Mail: <a href="mailto:info@gartenschmiede.de">info@gartenschmiede.de</a></p>
    <h2>Vertreten durch</h2>
    <p>Marco Holmer, Bastian Rohrhuber</p>
    <h2>Handelsregister</h2>
    <p>Registergericht: Amtsgericht München<br>
    Registernummer: wird nachgetragen</p>
    <h2>Umsatzsteuer-ID</h2>
    <p>Umsatzsteuer-Identifikationsnummer gemäß § 27a UStG: wird nachgetragen</p>
    <h2>Verantwortlich für den Inhalt nach § 55 Abs. 2 RStV</h2>
    <p>Bastian Rohrhuber<br>Ortsstraße 7, 85354 Freising</p>
    <h2>Haftungsausschluss</h2>
    <p>Die Inhalte dieser Website wurden mit größtmöglicher Sorgfalt erstellt. Für die Richtigkeit, Vollständigkeit und Aktualität der Inhalte können wir keine Gewähr übernehmen. Pflanzempfehlungen sind als unverbindliche Hinweise zu verstehen. Standortbedingungen und lokale Gegebenheiten können die Eignung einzelner Pflanzen beeinflussen.</p>
    <h2>Urheberrecht</h2>
    <p>Die durch die Seitenbetreiber erstellten Inhalte und Werke auf dieser Website unterliegen dem deutschen Urheberrecht. Die Vervielfältigung, Bearbeitung, Verbreitung und jede Art der Verwertung außerhalb der Grenzen des Urheberrechtes bedürfen der schriftlichen Zustimmung des jeweiligen Autors.</p>
  </main>
  ${LEGAL_FOOTER}
  </body></html>`);
});

app.get('/datenschutz', (req, res) => {
  res.send(`<!DOCTYPE html><html lang="de"><head>
  <meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Datenschutzerklärung — Staudenplan.de</title>
  <meta name="robots" content="noindex">
  ${LEGAL_STYLE}</head><body>
  ${LEGAL_NAV}
  <main>
    <h1>Datenschutzerklärung</h1>
    <h2>1. Datenschutz auf einen Blick</h2>
    <p>Diese Datenschutzerklärung klärt Sie über die Art, den Umfang und Zweck der Verarbeitung von personenbezogenen Daten auf unserer Website staudenplan.de auf. Verantwortlicher im Sinne der DSGVO ist die Gartenschmiede GmbH.</p>
    <h2>2. Verantwortliche Stelle</h2>
    <p><strong>Gartenschmiede GmbH</strong><br>
    Ortsstraße 7, 85354 Freising<br>
    E-Mail: <a href="mailto:info@gartenschmiede.de">info@gartenschmiede.de</a></p>
    <h2>3. Erhebung und Speicherung personenbezogener Daten</h2>
    <p><strong>Bepflanzungsplan-Anfragen:</strong> Wenn Sie über unser Kontaktformular eine Anfrage senden, speichern wir Ihren Namen, Ihre E-Mail-Adresse, Ihre Postleitzahl sowie die von Ihnen eingegebenen Gartenparameter. Diese Daten werden ausschließlich zur Bearbeitung Ihrer Anfrage und zur Erstellung eines Pflanzenangebots verwendet.</p>
    <p><strong>Server-Logfiles:</strong> Beim Besuch unserer Website werden automatisch technische Daten (IP-Adresse, Browsertyp, Betriebssystem, Uhrzeit) in Server-Logfiles gespeichert. Diese Daten werden ausschließlich zur technischen Fehleranalyse verwendet und nach 7 Tagen gelöscht.</p>
    <p><strong>KI-Verarbeitung:</strong> Ihre Gartenparameter werden zur Erstellung des Bepflanzungsplans an die OpenAI API übermittelt. Es werden keine personenbezogenen Daten (Name, E-Mail) an OpenAI übertragen.</p>
    <h2>4. Ihre Rechte</h2>
    <p>Sie haben das Recht auf Auskunft, Berichtigung, Löschung, Einschränkung der Verarbeitung sowie Datenübertragbarkeit Ihrer gespeicherten personenbezogenen Daten. Wenden Sie sich dazu an: <a href="mailto:info@gartenschmiede.de">info@gartenschmiede.de</a></p>
    <p>Sie haben außerdem das Recht, sich bei einer Aufsichtsbehörde zu beschweren. Zuständig ist das Bayerische Landesamt für Datenschutzaufsicht (BayLDA), Promenade 18, 91522 Ansbach.</p>
    <h2>5. Webanalyse (Plausible)</h2>
    <p>Diese Website nutzt <strong>Plausible Analytics</strong> zur datenschutzfreundlichen Besucherstatistik. Plausible erhebt keine personenbezogenen Daten, setzt keine Cookies und ist vollständig DSGVO-konform. Es werden ausschließlich aggregierte, anonymisierte Seitenaufrufstatistiken erfasst (Seitenaufrufe, Verweildauer, Herkunftsland). Ihre IP-Adresse wird dabei nicht gespeichert. Betreiber: Plausible Insights OÜ, Västriku tn 2, 50403 Tartu, Estland. Weitere Informationen: <a href="https://plausible.io/data-policy" target="_blank" rel="noopener">plausible.io/data-policy</a></p>
    <h2>6. Cookies</h2>
    <p>Diese Website verwendet keine eigenen Tracking-Cookies und keine Werbe-Cookies. Es werden ausschließlich technisch notwendige Funktionen ohne Cookie-Einsatz verwendet. Bitte beachten Sie, dass externe Websites (z.B. Amazon.de), die Sie über Links auf dieser Website aufrufen, eigene Cookies setzen können. Für diese gilt die jeweilige Datenschutzerklärung des Anbieters.</p>
    <h2>6. Affiliate-Links (Amazon Associates)</h2>
    <p>Diese Website nimmt am Amazon-Partnerprogramm (Amazon Associates) teil, einem Partnerwerbeprogramm, das für Websites konzipiert wurde, mittels dessen durch die Platzierung von Werbeanzeigen und Links zu Amazon.de Werbekostenerstattungen verdient werden können.</p>
    <p><strong>Als Amazon-Partner verdiene ich an qualifizierten Käufen.</strong> Das bedeutet: Wenn Sie über einen unserer Kauflinks zu Amazon.de weitergeleitet werden und dort einen Kauf tätigen, erhalten wir eine Provision. Für Sie entstehen dabei keine zusätzlichen Kosten.</p>
    <p>Wenn Sie einen Amazon-Link auf dieser Website anklicken, wird Ihre IP-Adresse an Amazon übertragen. Amazon kann dabei Cookies setzen, um Käufe Ihrem Klick zuzuordnen. Verantwortlich für diese Datenverarbeitung ist die Amazon Europe Core S.à.r.l., 38 avenue John F. Kennedy, L-1855 Luxemburg. Die Datenschutzerklärung von Amazon finden Sie unter: <a href="https://www.amazon.de/gp/help/customer/display.html?nodeId=201909010" target="_blank" rel="noopener">amazon.de/privacy</a></p>
    <h2>7. Externe Links</h2>
    <p>Diese Website enthält Links zu externen Websites. Für den Inhalt dieser externen Seiten sind ausschließlich deren Betreiber verantwortlich. Zum Zeitpunkt der Verlinkung wurden die Seiten auf mögliche Rechtsverstöße überprüft — eine permanente inhaltliche Kontrolle ist ohne konkrete Anhaltspunkte nicht zumutbar.</p>
    <p style="margin-top:24px;color:#aaa;font-size:.83rem">Stand: ${new Date().toLocaleDateString('de-DE', {month:'long',year:'numeric'})}</p>
  </main>
  ${LEGAL_FOOTER}
  </body></html>`);
});

// ─── Staging-Vorschau (intern) ────────────────────────────────────────────────
// URL: /vorschau/pflanzen?key=preview2026

app.get('/vorschau/pflanzen', (req, res) => {
  if (req.query.key !== 'preview2026') {
    return res.status(403).send('<h2>403 — Vorschau-Key fehlt</h2><p>?key=preview2026</p>');
  }
  const pflanzen = db.prepare(`
    SELECT id, name_deutsch, name_botanisch, licht, boden, bluehzeit, farbe,
           hoehe_cm_min, hoehe_cm_max, pflege_sterne, rolle_empfehlung, bild_url,
           bienen_freundlich, heimisch, bild_geprueft
    FROM pflanzen WHERE status = 'staging' ORDER BY name_deutsch
  `).all();
  const total    = pflanzen.length;
  const ohneBild = pflanzen.filter(p => !p.bild_url).length;
  const ausstehend = pflanzen.filter(p => !p.bild_geprueft);
  const bearbeitet = pflanzen.filter(p =>  p.bild_geprueft);

  const makeRow = (p, mitCheckbox) => {
    const img      = p.bild_url ? `<img src="${p.bild_url}" style="width:56px;height:56px;object-fit:cover;border-radius:6px">` : `<span style="display:inline-block;width:56px;height:56px;background:#f0ede8;border-radius:6px;text-align:center;line-height:56px;font-size:1.3rem">🌿</span>`;
    const bienen   = p.bienen_freundlich ? '🐝' : '';
    const heimisch = p.heimisch ? '🏡' : '';
    const cb       = mitCheckbox ? `<td style="padding:8px 6px;text-align:center"><input type="checkbox" class="pcb" value="${p.id}"></td>` : `<td></td>`;
    const geprueft = p.bild_geprueft ? `<span style="font-size:.7rem;background:#d1ecf1;color:#0c5460;padding:2px 7px;border-radius:10px;font-weight:600">✓ geprüft</span>` : '';
    return `<tr>
      ${cb}
      <td style="padding:8px 6px;text-align:center">${img}</td>
      <td style="padding:8px 6px"><strong>${p.name_deutsch}</strong> ${geprueft}<br><small style="color:#888">${p.name_botanisch}</small></td>
      <td style="padding:8px 6px;font-size:.82rem">${p.licht || '–'}</td>
      <td style="padding:8px 6px;font-size:.82rem">${p.bluehzeit || '–'}</td>
      <td style="padding:8px 6px;font-size:.82rem">${p.farbe || '–'}</td>
      <td style="padding:8px 6px;font-size:.82rem">${p.hoehe_cm_min || '?'}–${p.hoehe_cm_max || '?'} cm</td>
      <td style="padding:8px 6px;font-size:.82rem">${p.rolle_empfehlung || '–'}</td>
      <td style="padding:8px 6px">${bienen}${heimisch}</td>
    </tr>`;
  };

  const rowsAus = ausstehend.map(p => makeRow(p, true)).join('');
  const rowsBea = bearbeitet.map(p => makeRow(p, false)).join('');

  res.send(`<!DOCTYPE html><html lang="de"><head>
    <meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <title>Staging-Vorschau — ${total} Pflanzen</title>
    <style>
      *{box-sizing:border-box}
      body{font-family:system-ui,sans-serif;max-width:1200px;margin:0 auto;padding:24px;background:#f8f6f0}
      h1{color:#2d5a3d;margin-bottom:4px}
      h2{color:#2d5a3d;margin:32px 0 12px;font-size:1.1rem}
      .meta{color:#888;margin-bottom:20px;font-size:.9rem}
      .warn{background:#fff3cd;border:1px solid #f0c040;border-radius:8px;padding:12px 16px;margin-bottom:20px;font-size:.9rem}
      .approve-box{background:#e8f5e9;border:1px solid #81c784;border-radius:8px;padding:14px 18px;margin-bottom:24px;font-family:monospace;font-size:.85rem;color:#1b5e20}
      table{width:100%;border-collapse:collapse;background:white;border-radius:10px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,.08);margin-bottom:8px}
      th{background:#2d5a3d;color:white;padding:9px 6px;text-align:left;font-size:.8rem}
      tr:nth-child(even){background:#f9f7f3}
      input[type=search]{padding:8px 14px;border:1px solid #ddd;border-radius:8px;width:280px;font-size:.9rem;margin-bottom:12px}
      .toolbar{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:16px}
      .btn-check{background:#2d6a4f;color:#fff;border:none;border-radius:8px;padding:9px 18px;cursor:pointer;font-weight:600;font-size:.88rem}
      .btn-check:disabled{opacity:.5;cursor:not-allowed}
      .btn-all{background:none;border:1px solid #aaa;border-radius:8px;padding:7px 13px;cursor:pointer;font-size:.82rem;color:#555}
      #sel-count{font-size:.85rem;color:#2d5a3d;font-weight:600}
      #status-msg{font-size:.85rem;color:#1b5e20;font-weight:600;display:none}
      input[type=checkbox]{width:16px;height:16px;cursor:pointer;accent-color:#2d6a4f}
    </style>
  </head><body>
    <h1>🌿 Staging-Vorschau</h1>
    <p class="meta">${total} Pflanzen · ${ohneBild} ohne Bild · ${bearbeitet.length} geprüft · Nur intern sichtbar</p>
    ${ohneBild > 0 ? `<div class="warn">⚠️ <strong>${ohneBild} Pflanzen haben noch kein Bild.</strong></div>` : ''}
    <div class="approve-box">
      Freischalten wenn bereit: <strong>node scripts/approve-staging.js</strong><br>
      oder einzeln: <strong>node scripts/approve-staging.js --id=123</strong>
    </div>

    <h2>📋 Ausstehend (${ausstehend.length})</h2>
    <div class="toolbar">
      <input type="search" id="q" placeholder="Filtern…" oninput="filterTable(this.value)">
      <button class="btn-all" onclick="toggleAll(true)">Alle wählen</button>
      <button class="btn-all" onclick="toggleAll(false)">Alle abwählen</button>
      <span id="sel-count">0 ausgewählt</span>
      <button class="btn-check" id="btn-recheck" onclick="beauftragenPruefung()" disabled>🔍 Prüfung beauftragen</button>
      <span id="status-msg"></span>
    </div>
    <table id="t">
      <thead><tr><th style="width:32px"></th><th>Bild</th><th>Name</th><th>Licht</th><th>Blühzeit</th><th>Farbe</th><th>Höhe</th><th>Rolle</th><th></th></tr></thead>
      <tbody id="tb">${rowsAus || '<tr><td colspan="9" style="padding:16px;color:#888;text-align:center">Alle Pflanzen bereits geprüft ✓</td></tr>'}</tbody>
    </table>

    ${bearbeitet.length > 0 ? `
    <h2>✅ Bearbeitet (${bearbeitet.length})</h2>
    <table id="t2">
      <thead><tr><th></th><th>Bild</th><th>Name</th><th>Licht</th><th>Blühzeit</th><th>Farbe</th><th>Höhe</th><th>Rolle</th><th></th></tr></thead>
      <tbody>${rowsBea}</tbody>
    </table>` : ''}

    <script>
      document.querySelectorAll('.pcb').forEach(cb => cb.addEventListener('change', updateCount));
      function updateCount() {
        const n = document.querySelectorAll('.pcb:checked').length;
        document.getElementById('sel-count').textContent = n + ' ausgewählt';
        document.getElementById('btn-recheck').disabled = n === 0;
      }
      function toggleAll(val) {
        document.querySelectorAll('#tb .pcb:not([style*="none"])').forEach(cb => {
          if(cb.closest('tr').style.display !== 'none') cb.checked = val;
        });
        updateCount();
      }
      function filterTable(q) {
        document.querySelectorAll('#tb tr').forEach(r => {
          r.style.display = r.textContent.toLowerCase().includes(q.toLowerCase()) ? '' : 'none';
        });
      }
      async function beauftragenPruefung() {
        const ids = [...document.querySelectorAll('.pcb:checked')].map(cb => parseInt(cb.value));
        if (!ids.length) return;
        const btn = document.getElementById('btn-recheck');
        const msg = document.getElementById('status-msg');
        btn.disabled = true;
        btn.textContent = '⏳ Wird gestartet…';
        msg.style.display = 'inline';
        msg.textContent = '';
        const r = await fetch('/api/recheck-pflanzen', {
          method: 'POST',
          headers: {'Content-Type':'application/json'},
          body: JSON.stringify({ ids })
        });
        const data = await r.json();
        if (!r.ok) {
          msg.textContent = '✗ Fehler: ' + (data.error || 'unbekannt');
          btn.disabled = false;
          btn.textContent = '🔍 Prüfung beauftragen';
          return;
        }
        // Polling bis alle geprüft
        const poll = setInterval(async () => {
          try {
            const s = await fetch('/api/recheck-status?ids=' + ids.join(','));
            const st = await s.json();
            msg.textContent = '🔍 GPT-4o prüft… ' + st.done + ' / ' + st.total + ' fertig';
            if (st.fertig) {
              clearInterval(poll);
              msg.textContent = '✅ Alle ' + st.total + ' Pflanzen geprüft — Seite wird neu geladen…';
              setTimeout(() => location.reload(), 1500);
            }
          } catch {}
        }, 3000);
      }
    </script>
  </body></html>`);
});

// ─── Bildprüfung: Vorschläge manuell freigeben ────────────────────────────────

app.get('/checking', (req, res) => {
  if (req.query.key !== 'preview2026') return res.status(403).send('<h2>403 — Key fehlt</h2><p>?key=preview2026</p>');

  const pflanzen = db.prepare(`
    SELECT id, name_deutsch, name_botanisch, bild_url, bild_vorschlag, bild_check_info, status
    FROM pflanzen WHERE bild_vorschlag IS NOT NULL AND bild_vorschlag != ''
    ORDER BY status DESC, name_deutsch
  `).all();

  const cards = pflanzen.map(p => {
    let info = {};
    try { info = JSON.parse(p.bild_check_info || '{}'); } catch {}
    const konfStr = info.konfidenz != null ? `${(info.konfidenz * 100).toFixed(0)}% Konfidenz` : '';
    const altImg = p.bild_url
      ? `<img src="${p.bild_url}" onerror="this.parentElement.innerHTML='<div class=no-img>🌿 kein Bild</div>'">`
      : `<div class="no-img">🌿 kein Bild</div>`;
    return `<div class="card" id="card-${p.id}">
      <div class="card-head">
        <strong>${p.name_deutsch}</strong>
        <span class="tag ${p.status === 'staging' ? 'tag-staging' : 'tag-live'}">${p.status}</span>
      </div>
      <div class="bot">${p.name_botanisch}</div>
      <div class="imgs">
        <div class="img-box">${altImg}<div class="lbl">⚠ Aktuell (falsch)</div></div>
        <div class="img-box"><img src="${p.bild_vorschlag}" onerror="this.style.opacity='.3'"><div class="lbl">✦ Vorschlag Pixabay</div></div>
      </div>
      ${info.was_gezeigt ? `<div class="verdict">GPT-4o erkannte: <em>${info.was_gezeigt}</em>${konfStr ? ' · ' + konfStr : ''}${info.grund ? '<br><small>' + info.grund + '</small>' : ''}</div>` : ''}
      <div class="btns">
        <button class="btn-ok" onclick="approve(${p.id},this)">✓ Übernehmen</button>
        <button class="btn-no" onclick="reject(${p.id},this)">✗ Behalten</button>
      </div>
    </div>`;
  }).join('') || '<p style="color:#888;padding:20px">Keine Vorschläge vorhanden — zuerst <code>check-plant-images.js --live --propose</code> ausführen.</p>';

  res.send(`<!DOCTYPE html><html lang="de"><head>
  <meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Bildprüfung — Vorschläge freigeben</title>
  <style>
    *{box-sizing:border-box}
    body{font-family:system-ui,sans-serif;max-width:1280px;margin:0 auto;padding:24px;background:#f8f6f0}
    h1{color:#2d5a3d;margin-bottom:4px}
    .meta{color:#888;margin-bottom:20px;font-size:.9rem}
    .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(340px,1fr));gap:18px}
    .card{background:#fff;border-radius:12px;padding:16px;box-shadow:0 1px 6px rgba(0,0,0,.1);transition:opacity .3s}
    .card.done{opacity:.35;pointer-events:none}
    .card-head{display:flex;align-items:center;gap:8px;margin-bottom:2px}
    .card-head strong{font-size:.97rem;color:#1b4332}
    .bot{font-size:.76rem;color:#999;margin-bottom:12px}
    .tag{font-size:.68rem;font-weight:700;padding:2px 7px;border-radius:20px;white-space:nowrap}
    .tag-staging{background:#fff3cd;color:#856404}
    .tag-live{background:#d1ecf1;color:#0c5460}
    .imgs{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px}
    .img-box img{width:100%;height:140px;object-fit:cover;border-radius:8px;border:2px solid #e8e4de;display:block}
    .no-img{width:100%;height:140px;background:#f0ede8;border-radius:8px;display:flex;align-items:center;justify-content:center;font-size:1.4rem;color:#aaa}
    .lbl{font-size:.7rem;color:#888;margin-top:4px;text-align:center}
    .verdict{background:#fff8e1;border-radius:6px;padding:8px 10px;font-size:.78rem;color:#5d4037;margin-bottom:10px;line-height:1.4}
    .btns{display:flex;gap:8px}
    .btn-ok{flex:1;background:#2d6a4f;color:#fff;border:none;border-radius:8px;padding:10px;cursor:pointer;font-weight:600;font-size:.9rem}
    .btn-ok:hover{background:#1b5e20}
    .btn-no{flex:1;background:#f5f5f5;color:#555;border:1px solid #ddd;border-radius:8px;padding:10px;cursor:pointer;font-size:.9rem}
    .btn-no:hover{background:#eee}
    #counter{font-weight:600;color:#2d5a3d}
    .all-btns{display:flex;gap:12px;margin-bottom:24px;flex-wrap:wrap}
    .btn-all{padding:9px 18px;border-radius:8px;border:none;cursor:pointer;font-size:.88rem;font-weight:600}
    .btn-all-ok{background:#2d6a4f;color:#fff}
    .btn-all-no{background:#f5f5f5;color:#555;border:1px solid #ddd}
  </style>
</head><body>
  <h1>🔍 Bildprüfung — Vorschläge freigeben</h1>
  <p class="meta"><span id="counter">${pflanzen.length}</span> Vorschläge warten · Klicke pro Pflanze: ✓ Vorschlag übernehmen oder ✗ aktuelles Bild behalten</p>
  <div class="all-btns">
    <button class="btn-all btn-all-ok" onclick="approveAll()">✓ Alle übernehmen</button>
    <button class="btn-all btn-all-no" onclick="rejectAll()">✗ Alle behalten</button>
  </div>
  <div class="grid" id="grid">${cards}</div>
  <script>
    function updateCounter(){
      document.getElementById('counter').textContent=document.querySelectorAll('.card:not(.done)').length;
    }
    function hideCard(id){
      const card=document.getElementById('card-'+id);
      card.classList.add('done');
      setTimeout(()=>{ card.style.display='none'; updateCounter(); },900);
    }
    async function approve(id,btn){
      const orig=btn.textContent; btn.textContent='⏳'; btn.disabled=true;
      const r=await fetch('/api/bild-approve/'+id,{method:'POST'});
      if(r.ok){ hideCard(id); }
      else{btn.textContent=orig;btn.disabled=false;alert('Fehler');}
    }
    async function reject(id,btn){
      const orig=btn.textContent; btn.textContent='⏳'; btn.disabled=true;
      const r=await fetch('/api/bild-reject/'+id,{method:'POST'});
      if(r.ok){ hideCard(id); }
      else{btn.textContent=orig;btn.disabled=false;alert('Fehler');}
    }
    async function approveAll(){
      if(!confirm('Alle '+document.querySelectorAll('.card:not(.done)').length+' Vorschläge übernehmen?'))return;
      for(const c of document.querySelectorAll('.card:not(.done)')){
        const id=c.id.replace('card-','');
        const btn=c.querySelector('.btn-ok');
        await approve(parseInt(id),btn);
        await new Promise(r=>setTimeout(r,80));
      }
    }
    async function rejectAll(){
      if(!confirm('Alle Vorschläge ablehnen (aktuelle Bilder behalten)?'))return;
      for(const c of document.querySelectorAll('.card:not(.done)')){
        const id=c.id.replace('card-','');
        const btn=c.querySelector('.btn-no');
        await reject(parseInt(id),btn);
        await new Promise(r=>setTimeout(r,80));
      }
    }
  </script>
</body></html>`);
});

app.post('/api/bild-approve/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  const p = db.prepare('SELECT bild_vorschlag, name_deutsch FROM pflanzen WHERE id = ?').get(id);
  if (!p?.bild_vorschlag) return res.status(404).json({ error: 'Kein Vorschlag' });

  let finalUrl = p.bild_vorschlag;

  // Externe URL lokal herunterladen (Pixabay-URLs laufen ab)
  if (finalUrl.startsWith('http')) {
    try {
      const fs   = require('fs');
      const pathM = require('path');
      const https = require('https');
      const http  = require('http');
      const imgDir = pathM.join(__dirname, 'public', 'images', 'pflanzen');
      if (!fs.existsSync(imgDir)) fs.mkdirSync(imgDir, { recursive: true });
      const slug = (p.name_deutsch || 'pflanze').toLowerCase()
        .replace(/ä/g,'ae').replace(/ö/g,'oe').replace(/ü/g,'ue').replace(/ß/g,'ss')
        .replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,40);
      const dest  = pathM.join(imgDir, `${slug}-${id}.jpg`);
      const local = `/images/pflanzen/${slug}-${id}.jpg`;

      await new Promise((resolve, reject) => {
        const download = (url) => {
          const proto = url.startsWith('https') ? https : http;
          const file  = fs.createWriteStream(dest);
          proto.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, r => {
            if (r.statusCode === 301 || r.statusCode === 302) {
              file.close(); fs.unlink(dest, ()=>{});
              return download(r.headers.location);
            }
            if (r.statusCode !== 200) { file.close(); fs.unlink(dest, ()=>{}); return reject(new Error('HTTP ' + r.statusCode)); }
            r.pipe(file);
            file.on('finish', () => file.close(resolve));
          }).on('error', err => { fs.unlink(dest, ()=>{}); reject(err); });
        };
        download(url);
      });
      finalUrl = local;
    } catch (e) {
      console.error('Download fehlgeschlagen, externe URL wird gespeichert:', e.message);
    }
  }

  db.prepare("UPDATE pflanzen SET bild_url = ?, bild_lizenz = 'Pixabay License', bild_vorschlag = NULL, bild_check_info = NULL, status = 'live' WHERE id = ?")
    .run(finalUrl, id);
  res.json({ ok: true });
});

app.post('/api/bild-reject/:id', (req, res) => {
  const id = parseInt(req.params.id);
  db.prepare("UPDATE pflanzen SET bild_vorschlag = NULL, bild_check_info = NULL, status = 'live' WHERE id = ?").run(id);
  res.json({ ok: true });
});

app.post('/api/recheck-pflanzen', (req, res) => {
  const ids = (req.body.ids || []).map(Number).filter(n => n > 0 && Number.isInteger(n));
  if (!ids.length) return res.status(400).json({ error: 'Keine gültigen IDs' });

  // bild_geprueft auf 0 zurücksetzen — wird erst vom Script auf 1 gesetzt wenn fertig
  db.prepare(`UPDATE pflanzen SET bild_geprueft = 0 WHERE id IN (${ids.map(() => '?').join(',')})`)
    .run(...ids);

  // Prüfskript im Hintergrund starten
  const { spawn } = require('child_process');
  const child = spawn(process.execPath, [
    path.join(__dirname, 'scripts', 'check-plant-images.js'),
    '--fix',
    `--ids=${ids.join(',')}`
  ], { cwd: __dirname, detached: true, stdio: 'ignore' });
  child.unref();

  res.json({ ok: true, count: ids.length, ids });
});

// Polling-Endpoint: wie viele der angefragten IDs sind bereits fertig geprüft?
app.get('/api/recheck-status', (req, res) => {
  const ids = (req.query.ids || '').split(',').map(Number).filter(n => n > 0);
  if (!ids.length) return res.status(400).json({ error: 'Keine IDs' });
  const done = db.prepare(
    `SELECT COUNT(*) as n FROM pflanzen WHERE bild_geprueft = 1 AND id IN (${ids.map(() => '?').join(',')})`
  ).get(...ids).n;
  res.json({ done, total: ids.length, fertig: done === ids.length });
});

// ─── Bildauswahl: 3 Kandidaten pro Pflanze ────────────────────────────────────

app.get('/auswahl-pflanzen', (req, res) => {
  if (req.query.key !== 'preview2026') return res.status(403).send('<h2>403</h2>');

  const offene = db.prepare(`
    SELECT id, name_deutsch, name_botanisch, bild_url, bild_kandidaten
    FROM pflanzen WHERE bild_kandidaten IS NOT NULL AND bild_kandidaten != '[]'
      AND (bild_gesperrt IS NULL OR bild_gesperrt = 0)
    ORDER BY name_deutsch
  `).all();

  const gesperrte = db.prepare(`
    SELECT id, name_deutsch, name_botanisch, bild_url
    FROM pflanzen WHERE bild_gesperrt = 1 AND status = 'staging'
    ORDER BY name_deutsch
  `).all();

  const makeCard = p => {
    let kandidaten = [];
    try { kandidaten = JSON.parse(p.bild_kandidaten || '[]'); } catch {}
    const aktImg = p.bild_url
      ? `<img src="${p.bild_url}" class="akt-img"><div class="lbl">Aktuell</div>`
      : `<div class="no-img">🌿</div><div class="lbl">Kein Bild</div>`;
    const kandCards = kandidaten.map((url, i) => `
      <div class="kand-card" id="kand-${p.id}-${i}" onclick="waehle(${p.id},'${url}',${i})">
        <img src="${url}" onerror="this.parentElement.classList.add('broken')">
        <div class="lbl">Option ${i + 1}</div>
      </div>`).join('');
    return `<div class="plant-card" id="plant-${p.id}">
      <div class="plant-head">
        <strong>${p.name_deutsch}</strong>
        <span class="bot">${p.name_botanisch}</span>
        <span class="done-badge" id="done-${p.id}" style="display:none">✓ Gespeichert</span>
        ${p.bild_url ? `<button class="btn-behalten" onclick="waehle(${p.id},'${p.bild_url}',-1)">Bestand behalten</button>` : ''}
        <button class="btn-falsch" onclick="alleFalsch(${p.id},this)">Alle falsch</button>
      </div>
      <div class="imgs-row">
        <div class="akt-wrap">${aktImg}</div>
        <div class="arrow">→</div>
        <div class="kand-row">${kandCards}</div>
      </div>
    </div>`;
  };

  const cards = offene.map(makeCard).join('') || '<p style="color:#999">Alle bearbeitet.</p>';

  const gesperrtRows = gesperrte.map(p => `
    <div class="gesperrt-row" id="plant-g-${p.id}">
      ${p.bild_url ? `<img src="${p.bild_url}" class="g-img">` : `<div class="g-img no-img-sm">🌿</div>`}
      <div class="g-info">
        <strong>${p.name_deutsch}</strong>
        <span class="bot">${p.name_botanisch}</span>
      </div>
      <button class="btn-entsperren" onclick="entsperre(${p.id},this)">↩ Entsperren</button>
    </div>`).join('') || '<p style="color:#999;font-size:.88rem">Keine gesperrten Pflanzen.</p>';

  res.send(`<!DOCTYPE html><html lang="de"><head>
  <meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Bildauswahl</title>
  <style>
    *{box-sizing:border-box}
    body{font-family:system-ui,sans-serif;max-width:1100px;margin:0 auto;padding:24px;background:#f8f6f0}
    h1{color:#2d5a3d;margin-bottom:4px}
    h2{color:#555;font-size:1rem;margin:32px 0 12px;border-top:1px solid #e0dbd4;padding-top:24px}
    .meta{color:#888;font-size:.88rem;margin-bottom:24px}
    .plant-card{background:#fff;border-radius:12px;padding:16px 18px;margin-bottom:16px;box-shadow:0 1px 5px rgba(0,0,0,.09);transition:opacity .3s}
    .plant-card.saved{opacity:.45;pointer-events:none}
    .plant-card.gesperrt-lokal{opacity:.35;pointer-events:none}
    .plant-head{display:flex;align-items:center;gap:10px;margin-bottom:12px;flex-wrap:wrap}
    .plant-head strong{font-size:1rem;color:#1b4332}
    .bot{font-size:.78rem;color:#999}
    .done-badge{font-size:.78rem;background:#d4edda;color:#155724;padding:3px 10px;border-radius:20px;font-weight:600}
    .btn-behalten{background:#e8f5e9;border:1px solid #81c784;color:#2d5a3d;font-size:.78rem;font-weight:600;padding:4px 12px;border-radius:20px;cursor:pointer}
    .btn-behalten:hover{background:#c8e6c9}
    .btn-falsch{margin-left:auto;background:#fff3cd;border:1px solid #e0b84a;color:#856404;font-size:.78rem;font-weight:600;padding:4px 12px;border-radius:20px;cursor:pointer}
    .btn-falsch:hover{background:#ffeaa0}
    .imgs-row{display:flex;align-items:flex-start;gap:14px;flex-wrap:wrap}
    .akt-wrap{text-align:center;min-width:110px}
    .akt-img{width:110px;height:110px;object-fit:cover;border-radius:8px;border:2px solid #ddd;display:block}
    .no-img{width:110px;height:110px;background:#f0ede8;border-radius:8px;display:flex;align-items:center;justify-content:center;font-size:1.8rem}
    .lbl{font-size:.7rem;color:#aaa;margin-top:4px;text-align:center}
    .arrow{font-size:1.4rem;color:#bbb;padding-top:40px}
    .kand-row{display:flex;gap:10px;flex-wrap:wrap}
    .kand-card{text-align:center;cursor:pointer;border:2px solid #e8e4de;border-radius:8px;padding:4px;transition:border-color .15s,transform .12s;min-width:110px}
    .kand-card img{width:110px;height:110px;object-fit:cover;border-radius:6px;display:block}
    .kand-card:hover{border-color:#2d6a4f;transform:scale(1.03)}
    .kand-card.selected{border-color:#2d6a4f;box-shadow:0 0 0 3px rgba(45,106,79,.2)}
    .kand-card.broken{opacity:.3;pointer-events:none}
    .kand-card.broken img{display:none}
    .kand-card.broken::after{content:'✗ Bild fehlt';display:block;font-size:.75rem;padding:42px 8px;color:#bbb}
    /* Gesperrt-Sektion */
    .gesperrt-box{background:#fff8f0;border:1px solid #f0d090;border-radius:10px;padding:14px 16px}
    .gesperrt-row{display:flex;align-items:center;gap:12px;padding:8px 0;border-bottom:1px solid #f0e8d0}
    .gesperrt-row:last-child{border-bottom:none}
    .g-img{width:56px;height:56px;object-fit:cover;border-radius:6px;flex-shrink:0}
    .no-img-sm{width:56px;height:56px;background:#f0ede8;border-radius:6px;display:flex;align-items:center;justify-content:center;font-size:1.2rem;flex-shrink:0}
    .g-info{flex:1;min-width:0}
    .g-info strong{display:block;font-size:.9rem;color:#1b4332}
    .btn-entsperren{background:#fff;border:1px solid #ccc;color:#666;font-size:.75rem;padding:4px 10px;border-radius:16px;cursor:pointer;white-space:nowrap}
    .btn-entsperren:hover{background:#f5f5f5}
    .sperr-badge{font-size:.75rem;background:#fff3cd;color:#856404;padding:3px 10px;border-radius:20px;font-weight:600;display:none}
  </style>
</head><body>
  <h1>Bildauswahl</h1>
  <p class="meta">${offene.length} offen · ${gesperrte.length} gesperrt · Klick auf Bild = sofort übernehmen · "Alle falsch" = für Live gesperrt</p>
  ${cards}
  <h2>Gesperrt — kein passendes Bild (${gesperrte.length})</h2>
  <div class="gesperrt-box">${gesperrtRows}</div>
  <script>
    async function waehle(id, url, idx) {
      document.querySelectorAll(\`#plant-\${id} .kand-card\`).forEach(c => c.classList.remove('selected'));
      if (idx >= 0) document.getElementById(\`kand-\${id}-\${idx}\`).classList.add('selected');
      const r = await fetch(\`/api/bild-waehlen/\${id}\`, {
        method: 'POST', headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ url })
      });
      if (r.ok) {
        const card = document.getElementById(\`plant-\${id}\`);
        card.classList.add('saved');
        document.getElementById(\`done-\${id}\`).style.display = 'inline';
        const akt = document.querySelector(\`#plant-\${id} .akt-img\`);
        if (akt) akt.src = url;
        setTimeout(() => { card.style.display = 'none'; }, 1200);
      }
    }
    async function alleFalsch(id, btn) {
      if (!confirm('Pflanze sperren? Sie kann dann nicht live geschaltet werden bis du sie entsperrst.')) return;
      const r = await fetch(\`/api/bild-ablehnen/\${id}\`, { method: 'POST' });
      if (r.ok) {
        const card = document.getElementById(\`plant-\${id}\`);
        card.classList.add('gesperrt-lokal');
        btn.textContent = '🚫 Gesperrt';
        btn.disabled = true;
        // Nach kurzer Pause ausblenden
        setTimeout(() => { card.style.display = 'none'; }, 1200);
      }
    }
    async function entsperre(id, btn) {
      const r = await fetch(\`/api/bild-entsperren/\${id}\`, { method: 'POST' });
      if (r.ok) {
        const row = document.getElementById(\`plant-g-\${id}\`);
        btn.textContent = '✓';
        setTimeout(() => { row.style.display = 'none'; }, 800);
      }
    }
  </script>
</body></html>`);
});

app.post('/api/bild-waehlen/:id', (req, res) => {
  const id  = parseInt(req.params.id);
  const url = req.body.url;
  if (!id || !url) return res.status(400).json({ error: 'id oder url fehlt' });
  db.prepare("UPDATE pflanzen SET bild_url = ?, bild_kandidaten = NULL, bild_gesperrt = 0, status = 'live' WHERE id = ?").run(url, id);
  res.json({ ok: true });
});

app.post('/api/bild-ablehnen/:id', (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) return res.status(400).json({ error: 'id fehlt' });
  db.prepare('UPDATE pflanzen SET bild_gesperrt = 1, bild_kandidaten = NULL WHERE id = ?').run(id);
  res.json({ ok: true });
});

app.post('/api/bild-entsperren/:id', (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) return res.status(400).json({ error: 'id fehlt' });
  db.prepare('UPDATE pflanzen SET bild_gesperrt = 0 WHERE id = ?').run(id);
  res.json({ ok: true });
});

// ─── Admin-Übersicht ─────────────────────────────────────────────────────────

app.get('/admin', (req, res) => {
  if (req.query.key !== 'preview2026') return res.status(403).send('<h2>403</h2>');

  // ── Stats ──
  const stats = {
    live:       db.prepare("SELECT COUNT(*) as n FROM pflanzen WHERE status='live' OR status IS NULL").get().n,
    staging:    db.prepare("SELECT COUNT(*) as n FROM pflanzen WHERE status='staging'").get().n,
    vorschlaege:db.prepare("SELECT COUNT(*) as n FROM pflanzen WHERE bild_vorschlag IS NOT NULL").get().n,
    kandidaten: db.prepare("SELECT COUNT(*) as n FROM pflanzen WHERE bild_kandidaten IS NOT NULL AND bild_kandidaten != '[]' AND (bild_gesperrt IS NULL OR bild_gesperrt=0)").get().n,
    gesperrt:   db.prepare("SELECT COUNT(*) as n FROM pflanzen WHERE bild_gesperrt=1").get().n,
    ohneBild:   db.prepare("SELECT COUNT(*) as n FROM pflanzen WHERE (bild_url IS NULL OR bild_url='') AND status='staging'").get().n,
  };

  // ── Tab 1: Bildprüfung ──
  const vorschlaege = db.prepare(`
    SELECT id, name_deutsch, name_botanisch, bild_url, bild_vorschlag, bild_check_info, status
    FROM pflanzen WHERE bild_vorschlag IS NOT NULL AND bild_vorschlag != ''
    ORDER BY name_deutsch
  `).all();

  const pruefCards = vorschlaege.map(p => {
    let info = {};
    try { info = JSON.parse(p.bild_check_info || '{}'); } catch {}
    const konfStr = info.konfidenz != null ? `${(info.konfidenz*100).toFixed(0)}% Konfidenz` : '';
    const altImg = p.bild_url
      ? `<img src="${p.bild_url}" onerror="this.parentElement.innerHTML='<div class=no-img>🌿</div>'">`
      : `<div class="no-img">🌿 kein Bild</div>`;
    return `<div class="card" id="card-${p.id}">
      <div class="card-head"><strong>${p.name_deutsch}</strong>
        <span class="tag tag-${p.status||'live'}">${p.status||'live'}</span>
      </div>
      <div class="bot">${p.name_botanisch}</div>
      <div class="imgs">
        <div class="img-box">${altImg}<div class="lbl">⚠ Aktuell</div></div>
        <div class="img-box"><img src="${p.bild_vorschlag}" onerror="this.style.opacity='.2'"><div class="lbl">✦ Vorschlag</div></div>
      </div>
      ${info.was_gezeigt ? `<div class="verdict">GPT: <em>${info.was_gezeigt}</em>${konfStr?' · '+konfStr:''}${info.grund?'<br><small>'+info.grund+'</small>':''}</div>` : ''}
      <div class="btns">
        <button class="btn-ok" onclick="approve(${p.id},this)">✓ Übernehmen</button>
        <button class="btn-no" onclick="reject(${p.id},this)">✗ Behalten</button>
      </div>
    </div>`;
  }).join('') || '<p class="empty">Keine offenen Vorschläge.</p>';

  // ── Tab 2: Bildauswahl ──
  const kandidatenPflanzen = db.prepare(`
    SELECT id, name_deutsch, name_botanisch, bild_url, bild_kandidaten
    FROM pflanzen WHERE bild_kandidaten IS NOT NULL AND bild_kandidaten != '[]'
      AND (bild_gesperrt IS NULL OR bild_gesperrt=0)
    ORDER BY name_deutsch
  `).all();
  const gesperrte = db.prepare(`
    SELECT id, name_deutsch, name_botanisch, bild_url
    FROM pflanzen WHERE bild_gesperrt=1 AND status='staging' ORDER BY name_deutsch
  `).all();

  const auswahlCards = kandidatenPflanzen.map(p => {
    let kands = [];
    try { kands = JSON.parse(p.bild_kandidaten||'[]'); } catch {}
    const aktImg = p.bild_url
      ? `<img src="${p.bild_url}" class="akt-img"><div class="lbl">Aktuell</div>`
      : `<div class="no-img-sm">🌿</div><div class="lbl">Kein Bild</div>`;
    const kandCards = kands.map((url,i)=>`
      <div class="kand-card" id="kand-${p.id}-${i}" onclick="waehle(${p.id},'${url}',${i})">
        <img src="${url}" onerror="this.parentElement.classList.add('broken')">
        <div class="lbl">Option ${i+1}</div>
      </div>`).join('');
    return `<div class="plant-card" id="plant-${p.id}">
      <div class="plant-head">
        <strong>${p.name_deutsch}</strong><span class="bot">${p.name_botanisch}</span>
        <span class="done-badge" id="done-${p.id}" style="display:none">✓ Gespeichert</span>
        ${p.bild_url?`<button class="btn-behalten" onclick="waehle(${p.id},'${p.bild_url}',-1)">Bestand behalten</button>`:''}
        <button class="btn-falsch" onclick="alleFalsch(${p.id},this)">Alle falsch</button>
      </div>
      <div class="imgs-row">
        <div class="akt-wrap">${aktImg}</div>
        <div class="arrow">→</div>
        <div class="kand-row">${kandCards}</div>
      </div>
    </div>`;
  }).join('') || '<p class="empty">Alle bearbeitet.</p>';

  const gesperrtRows = gesperrte.map(p=>`
    <div class="gesperrt-row" id="plant-g-${p.id}">
      ${p.bild_url?`<img src="${p.bild_url}" class="g-img">`:`<div class="g-img no-img-sm">🌿</div>`}
      <div class="g-info"><strong>${p.name_deutsch}</strong><span class="bot">${p.name_botanisch}</span></div>
      <button class="btn-entsperren" onclick="entsperre(${p.id},this)">↩ Entsperren</button>
    </div>`).join('') || '<p class="empty" style="font-size:.85rem">Keine gesperrten Pflanzen.</p>';


  // ── Tab 4: Live Pflanzen ──
  const livePflanzen = db.prepare(`
    SELECT id, name_deutsch, name_botanisch, bild_url, hoehe_cm_min, hoehe_cm_max
    FROM pflanzen WHERE status='live' OR status IS NULL ORDER BY name_deutsch
  `).all();

  const liveRows = livePflanzen.map(p => {
    const img = p.bild_url
      ? `<img src="${p.bild_url}" class="st-img">`
      : `<div class="st-img no-img-sm">🌿</div>`;
    return `<div class="st-row" id="lv-${p.id}">
      ${img}
      <div class="st-info" style="flex:1;min-width:180px">
        <strong>${p.name_deutsch}</strong>
        <span class="bot">${p.name_botanisch}</span>
      </div>
      <div class="st-meta">${p.hoehe_cm_min||'?'}–${p.hoehe_cm_max||'?'}cm</div>
      <button class="btn-pruefen" id="bp-${p.id}" onclick="bildPruefen(${p.id},this)">Bild prüfen</button>
    </div>`;
  }).join('') || '<p class="empty">Keine Live-Pflanzen.</p>';

  res.send(`<!DOCTYPE html><html lang="de"><head>
  <meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Admin — Staudenplan</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:system-ui,sans-serif;background:#f2efe9;min-height:100vh}
    /* ── Header ── */
    .header{background:#1b4332;color:#fff;padding:16px 24px;display:flex;align-items:center;gap:20px;flex-wrap:wrap}
    .header h1{font-size:1.1rem;font-weight:700;letter-spacing:.02em}
    .stat-chips{display:flex;gap:8px;flex-wrap:wrap;margin-left:auto}
    .chip{background:rgba(255,255,255,.13);border-radius:20px;padding:4px 12px;font-size:.78rem;white-space:nowrap}
    .chip.warn{background:rgba(255,200,0,.25);color:#ffe082}
    /* ── Tabs ── */
    .tabs{background:#fff;border-bottom:1px solid #e0dbd4;display:flex;gap:0;padding:0 24px}
    .tab{padding:14px 20px;font-size:.9rem;font-weight:600;color:#888;border-bottom:3px solid transparent;cursor:pointer;white-space:nowrap;transition:color .15s}
    .tab:hover{color:#2d5a3d}
    .tab.active{color:#1b4332;border-bottom-color:#2d6a4f}
    .badge{display:inline-block;background:#e8f5e9;color:#2d5a3d;font-size:.7rem;font-weight:700;border-radius:20px;padding:1px 7px;margin-left:5px;vertical-align:middle}
    .badge.orange{background:#fff3cd;color:#856404}
    /* ── Content ── */
    .content{max-width:1200px;margin:0 auto;padding:24px}
    .pane{display:none}.pane.active{display:block}
    /* ── Toolbar ── */
    .toolbar{display:flex;gap:10px;margin-bottom:20px;flex-wrap:wrap;align-items:center}
    .toolbar-meta{color:#999;font-size:.85rem;flex:1}
    .btn-action{padding:9px 18px;border-radius:8px;border:none;cursor:pointer;font-size:.85rem;font-weight:600;transition:background .15s}
    .btn-green{background:#2d6a4f;color:#fff}.btn-green:hover{background:#1b5e20}
    .btn-gray{background:#f0ede8;color:#555;border:1px solid #ddd}.btn-gray:hover{background:#e5e0d8}
    .btn-orange{background:#e65100;color:#fff}.btn-orange:hover{background:#bf360c}
    /* ── Bildprüfung Grid ── */
    .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:16px}
    .card{background:#fff;border-radius:10px;padding:14px;box-shadow:0 1px 5px rgba(0,0,0,.08);transition:opacity .3s}
    .card.done{opacity:.25;pointer-events:none}
    .card-head{display:flex;align-items:center;gap:8px;margin-bottom:2px}
    .card-head strong{font-size:.95rem;color:#1b4332;flex:1}
    .bot{font-size:.74rem;color:#aaa;margin-bottom:10px}
    .tag{font-size:.68rem;font-weight:700;padding:2px 7px;border-radius:20px;white-space:nowrap}
    .tag-live{background:#d1ecf1;color:#0c5460}
    .tag-staging{background:#fff3cd;color:#856404}
    .imgs{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:8px}
    .img-box img{width:100%;height:130px;object-fit:cover;border-radius:7px;border:2px solid #e8e4de;display:block}
    .no-img{width:100%;height:130px;background:#f0ede8;border-radius:7px;display:flex;align-items:center;justify-content:center;font-size:1.2rem;color:#bbb}
    .lbl{font-size:.68rem;color:#aaa;margin-top:3px;text-align:center}
    .verdict{background:#fff8e1;border-radius:6px;padding:7px 9px;font-size:.75rem;color:#5d4037;margin-bottom:8px;line-height:1.4}
    .btns{display:flex;gap:7px}
    .btn-ok{flex:1;background:#2d6a4f;color:#fff;border:none;border-radius:7px;padding:9px;cursor:pointer;font-weight:600;font-size:.88rem}
    .btn-ok:hover{background:#1b5e20}
    .btn-no{flex:1;background:#f5f5f5;color:#555;border:1px solid #ddd;border-radius:7px;padding:9px;cursor:pointer;font-size:.88rem}
    .btn-no:hover{background:#eee}
    /* ── Bildauswahl ── */
    .plant-card{background:#fff;border-radius:10px;padding:14px 16px;margin-bottom:14px;box-shadow:0 1px 5px rgba(0,0,0,.08);transition:opacity .3s}
    .plant-card.saved,.plant-card.gesperrt-lokal{opacity:.25;pointer-events:none}
    .plant-head{display:flex;align-items:center;gap:8px;margin-bottom:10px;flex-wrap:wrap}
    .plant-head strong{font-size:.95rem;color:#1b4332}
    .done-badge{font-size:.75rem;background:#d4edda;color:#155724;padding:3px 9px;border-radius:20px;font-weight:600}
    .btn-behalten{background:#e8f5e9;border:1px solid #81c784;color:#2d5a3d;font-size:.75rem;font-weight:600;padding:3px 10px;border-radius:20px;cursor:pointer}
    .btn-falsch{background:#fff3cd;border:1px solid #e0b84a;color:#856404;font-size:.75rem;font-weight:600;padding:3px 10px;border-radius:20px;cursor:pointer;margin-left:auto}
    .imgs-row{display:flex;align-items:flex-start;gap:12px;flex-wrap:wrap}
    .akt-wrap{text-align:center;min-width:100px}
    .akt-img{width:100px;height:100px;object-fit:cover;border-radius:7px;border:2px solid #ddd;display:block}
    .no-img-sm{width:100px;height:100px;background:#f0ede8;border-radius:7px;display:flex;align-items:center;justify-content:center;font-size:1.4rem}
    .arrow{font-size:1.3rem;color:#bbb;padding-top:35px}
    .kand-row{display:flex;gap:8px;flex-wrap:wrap}
    .kand-card{text-align:center;cursor:pointer;border:2px solid #e8e4de;border-radius:7px;padding:3px;transition:border-color .15s,transform .12s;min-width:100px}
    .kand-card img{width:100px;height:100px;object-fit:cover;border-radius:5px;display:block}
    .kand-card:hover{border-color:#2d6a4f;transform:scale(1.03)}
    .kand-card.selected{border-color:#2d6a4f;box-shadow:0 0 0 3px rgba(45,106,79,.2)}
    .kand-card.broken{opacity:.25;pointer-events:none}
    .kand-card.broken img{display:none}.kand-card.broken::after{content:'✗';display:block;font-size:1rem;padding:38px 8px;color:#bbb}
    /* Gesperrt */
    .gesperrt-box{background:#fff8f0;border:1px solid #f0d090;border-radius:8px;padding:12px 14px;margin-top:20px}
    .gesperrt-box h3{font-size:.85rem;color:#856404;margin-bottom:10px}
    .gesperrt-row{display:flex;align-items:center;gap:10px;padding:6px 0;border-bottom:1px solid #f0e8d0}
    .gesperrt-row:last-child{border-bottom:none}
    .g-img{width:48px;height:48px;object-fit:cover;border-radius:5px;flex-shrink:0}
    .g-info{flex:1;min-width:0}.g-info strong{display:block;font-size:.88rem;color:#1b4332}
    .btn-entsperren{background:#fff;border:1px solid #ccc;color:#666;font-size:.72rem;padding:3px 9px;border-radius:14px;cursor:pointer;white-space:nowrap}
    .btn-pruefen{background:#fff3cd;border:1px solid #e0b84a;color:#856404;font-size:.75rem;font-weight:600;padding:4px 11px;border-radius:14px;cursor:pointer;white-space:nowrap;flex-shrink:0}
    .btn-pruefen:hover{background:#ffeaa0}
    .btn-pruefen:disabled{opacity:.5;cursor:default}
    /* ── Staging Liste ── */
    .st-list{background:#fff;border-radius:10px;overflow:hidden;box-shadow:0 1px 5px rgba(0,0,0,.08)}
    .st-row{display:flex;align-items:center;gap:12px;padding:10px 14px;border-bottom:1px solid #f0ede8}
    .st-row:last-child{border-bottom:none}
    .st-img{width:52px;height:52px;object-fit:cover;border-radius:6px;flex-shrink:0}
    .st-info{flex:1;min-width:0}.st-info strong{display:block;font-size:.9rem;color:#1b4332}
    .st-meta{font-size:.75rem;color:#aaa;white-space:nowrap}
    .st-vorschlag{width:100%;display:flex;align-items:center;gap:10px;padding:8px 0 2px;flex-wrap:wrap}
    .st-imgs{display:flex;align-items:center;gap:8px}
    .st-arrow{font-size:1.1rem;color:#bbb}
    .st-vbtns{display:flex;gap:6px}
    .empty{color:#aaa;font-size:.88rem;padding:20px 0}
    /* ── Spinner ── */
    .spinner{display:inline-block;width:14px;height:14px;border:2px solid rgba(255,255,255,.4);border-top-color:#fff;border-radius:50%;animation:spin .7s linear infinite;vertical-align:middle;margin-right:6px}
    @keyframes spin{to{transform:rotate(360deg)}}
  </style>
</head><body>

<div class="header">
  <h1>🌿 Staudenplan Admin</h1>
  <div class="stat-chips">
    <span class="chip">${stats.live} live</span>
    <span class="chip ${stats.staging>0?'warn':''}">${stats.staging} staging</span>
    <span class="chip ${stats.vorschlaege>0?'warn':''}">${stats.vorschlaege} Vorschläge offen</span>
    <span class="chip">${stats.kandidaten} zur Bildauswahl</span>
    ${stats.gesperrt>0?`<span class="chip warn">${stats.gesperrt} gesperrt</span>`:''}
    ${stats.ohneBild>0?`<span class="chip warn">${stats.ohneBild} ohne Bild</span>`:''}
  </div>
</div>

<div class="tabs">
  <div class="tab active" onclick="showTab('pruefung',this)">Bildprüfung <span class="badge orange" id="b-pruefung">${vorschlaege.length}</span></div>
  <div class="tab" onclick="showTab('auswahl',this)">Bildauswahl <span class="badge" id="b-auswahl">${kandidatenPflanzen.length}</span></div>
  <div class="tab" onclick="showTab('live',this)">Live Pflanzen <span class="badge" id="b-live">${livePflanzen.length}</span></div>
</div>

<div class="content">

  <!-- Tab 1: Bildprüfung -->
  <div class="pane active" id="pane-pruefung">
    <div class="toolbar">
      <span class="toolbar-meta"><span id="counter-pruefung">${vorschlaege.length}</span> Vorschläge warten</span>
      <button class="btn-action btn-green" onclick="approveAll()">✓ Alle übernehmen</button>
      <button class="btn-action btn-gray" onclick="rejectAll()">✗ Alle behalten</button>
      <button class="btn-action btn-orange" onclick="bildNeuLaden(this)">↺ Bilder neu prüfen</button>
    </div>
    <div class="grid" id="grid-pruefung">${pruefCards}</div>
  </div>

  <!-- Tab 2: Bildauswahl -->
  <div class="pane" id="pane-auswahl">
    <div class="toolbar">
      <span class="toolbar-meta">${kandidatenPflanzen.length} Pflanzen mit Kandidaten</span>
      <button class="btn-action btn-orange" onclick="kandidatenNeuLaden(this)">↺ Kandidaten neu laden</button>
    </div>
    ${auswahlCards}
    ${gesperrte.length>0?`<div class="gesperrt-box"><h3>Gesperrt — kein passendes Bild (${gesperrte.length})</h3>${gesperrtRows}</div>`:''}
  </div>

  <!-- Tab 3: Live Pflanzen -->
  <div class="pane" id="pane-live">
    <div class="toolbar">
      <span class="toolbar-meta">${livePflanzen.length} Live-Pflanzen · "Bild prüfen" schaltet die Pflanze offline und startet einen GPT-Check</span>
    </div>
    <input type="text" id="live-search" placeholder="Pflanze suchen…" oninput="filterLive(this.value)"
      style="width:100%;max-width:360px;padding:9px 14px;border:1.5px solid #ddd;border-radius:8px;font-size:.9rem;margin-bottom:16px;display:block">
    <div class="st-list" id="live-list">${liveRows}</div>
  </div>

</div>

<script>
  function showTab(name, el) {
    document.querySelectorAll('.tab').forEach(t=>t.classList.remove('active'));
    document.querySelectorAll('.pane').forEach(p=>p.classList.remove('active'));
    el.classList.add('active');
    document.getElementById('pane-'+name).classList.add('active');
  }

  // ── Bildprüfung ──
  function updatePruefCounter(){
    const n = document.querySelectorAll('#grid-pruefung .card:not(.done)').length;
    document.getElementById('counter-pruefung').textContent = n;
    document.getElementById('b-pruefung').textContent = n;
  }
  function hideCard(id){
    const c=document.getElementById('card-'+id);
    c.classList.add('done');
    setTimeout(()=>{ c.style.display='none'; updatePruefCounter(); },900);
  }
  async function approve(id,btn){
    const orig=btn.textContent; btn.innerHTML='<span class=spinner></span>'; btn.disabled=true;
    const r=await fetch('/api/bild-approve/'+id,{method:'POST'});
    if(r.ok){ hideCard(id); }
    else{ btn.textContent=orig; btn.disabled=false; alert('Fehler'); }
  }
  async function reject(id,btn){
    const orig=btn.textContent; btn.textContent='⏳'; btn.disabled=true;
    const r=await fetch('/api/bild-reject/'+id,{method:'POST'});
    if(r.ok){ hideCard(id); }
    else{ btn.textContent=orig; btn.disabled=false; alert('Fehler'); }
  }
  async function approveAll(){
    const cards=[...document.querySelectorAll('#grid-pruefung .card:not(.done)')];
    if(!confirm('Alle '+cards.length+' Vorschläge übernehmen?'))return;
    for(const c of cards){
      const id=parseInt(c.id.replace('card-',''));
      await approve(id,c.querySelector('.btn-ok'));
      await new Promise(r=>setTimeout(r,80));
    }
  }
  async function rejectAll(){
    const cards=[...document.querySelectorAll('#grid-pruefung .card:not(.done)')];
    if(!confirm('Alle '+cards.length+' Vorschläge ablehnen?'))return;
    for(const c of cards){
      const id=parseInt(c.id.replace('card-',''));
      await reject(id,c.querySelector('.btn-no'));
      await new Promise(r=>setTimeout(r,80));
    }
  }
  async function bildNeuLaden(btn){
    if(!confirm('Neuen Bildcheck starten? Das dauert ca. 15 Minuten.'))return;
    btn.innerHTML='<span class=spinner></span> Läuft…'; btn.disabled=true;
    await fetch('/api/bildcheck-starten',{method:'POST'});
    btn.textContent='✓ Gestartet — Seite in 15 Min. neu laden';
  }

  // ── Bildauswahl ──
  async function waehle(id, url, idx) {
    document.querySelectorAll(\`#plant-\${id} .kand-card\`).forEach(c=>c.classList.remove('selected'));
    if(idx>=0) document.getElementById(\`kand-\${id}-\${idx}\`).classList.add('selected');
    const r=await fetch('/api/bild-waehlen/'+id,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({url})});
    if(r.ok){
      const card=document.getElementById('plant-'+id);
      card.classList.add('saved');
      document.getElementById('done-'+id).style.display='inline';
      const akt=document.querySelector('#plant-'+id+' .akt-img');
      if(akt) akt.src=url;
      setTimeout(()=>{ card.style.display='none'; document.getElementById('b-auswahl').textContent=parseInt(document.getElementById('b-auswahl').textContent||0)-1; },1200);
    }
  }
  async function alleFalsch(id,btn){
    if(!confirm('Pflanze sperren?'))return;
    const r=await fetch('/api/bild-ablehnen/'+id,{method:'POST'});
    if(r.ok){
      const card=document.getElementById('plant-'+id);
      card.classList.add('gesperrt-lokal');
      btn.textContent='🚫 Gesperrt'; btn.disabled=true;
      setTimeout(()=>{ card.style.display='none'; },1200);
    }
  }
  async function entsperre(id,btn){
    const r=await fetch('/api/bild-entsperren/'+id,{method:'POST'});
    if(r.ok){ const row=document.getElementById('plant-g-'+id); btn.textContent='✓'; setTimeout(()=>row.style.display='none',800); }
  }


  // ── Live-Tab Suche ──
  function filterLive(q) {
    const term = q.toLowerCase();
    document.querySelectorAll('#live-list .st-row').forEach(row => {
      const text = row.textContent.toLowerCase();
      row.style.display = text.includes(term) ? '' : 'none';
    });
  }

  // ── Live: Bild prüfen ──
  async function bildPruefen(id, btn) {
    if (!confirm('Pflanze offline schalten und Bild mit GPT prüfen? Dauert ca. 10 Sekunden.')) return;
    btn.innerHTML = '<span class=spinner></span>'; btn.disabled = true;
    const r = await fetch('/api/bild-pruefen/' + id, { method: 'POST' });
    if (r.ok) {
      const row = document.getElementById('lv-' + id);
      row.style.opacity = '.35';
      btn.textContent = '⏳ In Prüfung…';
      // Nach 12s prüfen ob Vorschlag bereit (recheck-status nutzt bild_geprueft)
      setTimeout(async () => {
        const s = await fetch('/api/recheck-status?ids=' + id);
        const data = await s.json();
        if (data.fertig) {
          btn.textContent = '✓ Geprüft — Bildprüfung-Tab öffnen';
          btn.onclick = () => { document.querySelector('.tab[onclick*="pruefung"]').click(); };
          btn.disabled = false;
        } else {
          btn.textContent = '⏳ Läuft noch…';
          btn.disabled = false;
        }
      }, 12000);
    } else {
      btn.textContent = 'Bild prüfen'; btn.disabled = false;
    }
  }

  async function kandidatenNeuLaden(btn){
    if(!confirm('Kandidaten für alle geprueften Pflanzen neu laden?'))return;
    btn.innerHTML='<span class=spinner></span> Läuft…'; btn.disabled=true;
    await fetch('/api/kandidaten-starten',{method:'POST'});
    btn.textContent='✓ Gestartet — Seite in 2 Min. neu laden';
  }
</script>
</body></html>`);
});

// Einzelne Live-Pflanze offline schalten und Bildcheck starten
app.post('/api/bild-pruefen/:id', (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) return res.status(400).json({ error: 'id fehlt' });
  db.prepare("UPDATE pflanzen SET status='staging', bild_geprueft=0 WHERE id=?").run(id);
  const { spawn } = require('child_process');
  const child = spawn(process.execPath, [
    path.join(__dirname, 'scripts', 'check-plant-images.js'),
    '--propose', `--ids=${id}`
  ], { cwd: __dirname, detached: true, stdio: 'ignore' });
  child.unref();
  res.json({ ok: true });
});

// Bildcheck im Hintergrund starten
app.post('/api/bildcheck-starten', (req, res) => {
  // Nur Pflanzen mit offenem Vorschlag neu prüfen (nicht alle 500+ Live-Pflanzen)
  const ids = db.prepare("SELECT id FROM pflanzen WHERE bild_vorschlag IS NOT NULL AND bild_vorschlag != ''")
    .all().map(p => p.id);
  if (!ids.length) return res.json({ ok: true, count: 0 });
  const { spawn } = require('child_process');
  const child = spawn(process.execPath, [
    path.join(__dirname, 'scripts', 'check-plant-images.js'),
    '--propose', `--ids=${ids.join(',')}`
  ], { cwd: __dirname, detached: true, stdio: 'ignore' });
  child.unref();
  res.json({ ok: true, count: ids.length });
});

// Kandidaten-Fetch im Hintergrund starten
app.post('/api/kandidaten-starten', (req, res) => {
  const { spawn } = require('child_process');
  const child = spawn(process.execPath, [
    path.join(__dirname, 'scripts', 'fetch-bild-kandidaten.js')
  ], { cwd: __dirname, detached: true, stdio: 'ignore' });
  child.unref();
  res.json({ ok: true });
});

// ─── Pflanzenseiten (SEO) ─────────────────────────────────────────────────────

app.get('/pflanzen', (req, res) => {
  const total = db.prepare("SELECT COUNT(*) as n FROM pflanzen WHERE name_deutsch != 'Test-Pflanze'").get().n;
  res.send(`<!DOCTYPE html><html lang="de"><head>
  <meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Stauden suchen & filtern — ${total} winterharte Gartenstauden | Staudenplan.de</title>
  <meta name="description" content="Alle ${total} winterharten Gartenstauden filtern nach Standort, Blühzeit, Farbe, Höhe, Feuchtigkeit und mehr — mit Fotos, Pflege-Tipps und Kauflink.">
  <link rel="canonical" href="https://www.staudenplan.de/pflanzen">
  <meta property="og:title" content="Stauden suchen — ${total} winterharte Arten">
  <meta property="og:image" content="https://www.staudenplan.de/images/og-default.jpg">
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:'Segoe UI',system-ui,sans-serif;background:#f8f4ef;color:#1a1a1a}
    .layout{display:flex;gap:0;max-width:1300px;margin:0 auto;padding:24px 16px 60px;align-items:flex-start}
    /* Sidebar */
    .sidebar{width:240px;flex-shrink:0;background:#fff;border-radius:14px;padding:20px;box-shadow:0 2px 12px rgba(0,0,0,.07);position:sticky;top:76px;max-height:calc(100vh - 100px);overflow-y:auto}
    .sidebar h3{font-size:.78rem;font-weight:700;color:#aaa;text-transform:uppercase;letter-spacing:.06em;margin-bottom:10px;margin-top:16px}
    .sidebar h3:first-child{margin-top:0}
    .chip-group{display:flex;flex-wrap:wrap;gap:5px;margin-bottom:4px}
    .chip{background:#f0ede8;color:#555;border:none;border-radius:20px;padding:4px 11px;font-size:.78rem;cursor:pointer;font-family:inherit;transition:all .15s}
    .chip.active{background:#1b4332;color:#fff}
    .chip:hover:not(.active){background:#d8f3dc;color:#1b4332}
    /* Farb-Chips: inline-style hat höhere Priorität als .active — deswegen Ring statt Hintergrund */
    .chip[data-filter="farbe"].active{outline:2.5px solid #1b4332;box-shadow:inset 0 0 0 2px rgba(255,255,255,.9),0 2px 8px rgba(0,0,0,.2);transform:scale(1.1)}
    .toggle-row{display:flex;align-items:center;gap:8px;margin-bottom:6px;cursor:pointer}
    .toggle-row input{accent-color:#2d6a4f;width:16px;height:16px}
    .toggle-row label{font-size:.85rem;color:#333;cursor:pointer}
    .btn-reset{width:100%;margin-top:16px;background:#f0ede8;border:none;border-radius:8px;padding:9px;font-size:.82rem;color:#666;cursor:pointer;font-family:inherit}
    .btn-reset:hover{background:#d8f3dc;color:#1b4332}
    /* Main */
    .main{flex:1;min-width:0;padding-left:20px}
    .search-bar{display:flex;gap:10px;margin-bottom:18px;align-items:center}
    .search-bar input{flex:1;padding:11px 16px 11px 40px;border:2px solid #e0d9cf;border-radius:10px;font-size:.95rem;font-family:inherit;background:#fff url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' fill='%23aaa' viewBox='0 0 16 16'%3E%3Cpath d='M11.742 10.344a6.5 6.5 0 1 0-1.397 1.398h-.001c.03.04.062.078.098.115l3.85 3.85a1 1 0 0 0 1.415-1.414l-3.85-3.85a1.007 1.007 0 0 0-.115-.099zm-5.742 1.656a5.5 5.5 0 1 1 0-11 5.5 5.5 0 0 1 0 11z'/%3E%3C/svg%3E") no-repeat 12px center;outline:none;transition:border-color .15s}
    .search-bar input:focus{border-color:#2d6a4f}
    #count-label{font-size:.82rem;color:#aaa;margin-bottom:16px}
    #grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(185px,1fr));gap:12px}
    .p-card{display:flex;flex-direction:column;background:#fff;border-radius:12px;text-decoration:none;color:inherit;box-shadow:0 2px 10px rgba(0,0,0,.07);overflow:hidden;transition:transform .15s;position:relative}
    .p-card:hover{transform:translateY(-3px)}
    .p-card-img{height:130px;position:relative;background:linear-gradient(135deg,#d8f3dc,#b7e4c7);width:100%;flex-shrink:0}
    .p-card-img img{width:100%;height:100%;object-fit:cover;display:block}
    .p-card-body{padding:12px}
    .p-card-name{font-weight:700;font-size:.9rem;color:#1b4332;margin-bottom:2px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
    .p-card-bot{font-size:.7rem;font-style:italic;color:#bbb;margin-bottom:7px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
    .p-card-tags{display:flex;flex-wrap:wrap;gap:3px}
    .p-tag{border-radius:4px;padding:1px 7px;font-size:.68rem;font-weight:600}
    .wl-card-btn{position:absolute;top:6px;right:6px;background:rgba(255,255,255,.9);border:none;border-radius:20px;padding:4px 10px;font-size:.7rem;font-weight:700;cursor:pointer;color:#1b4332;box-shadow:0 1px 4px rgba(0,0,0,.15)}
    #pagination{display:flex;align-items:center;justify-content:center;gap:5px;margin-top:28px;flex-wrap:wrap}
    .page-btn{background:#fff;border:1.5px solid #e0dbd2;border-radius:8px;padding:6px 13px;font-size:.82rem;font-family:inherit;cursor:pointer;color:#555;transition:all .12s;min-width:36px}
    .page-btn:hover:not(:disabled){border-color:#2d6a4f;color:#1b4332;background:#f0fdf4}
    .page-btn.cur{background:#1b4332;border-color:#1b4332;color:#fff;font-weight:700;cursor:default}
    .page-btn:disabled{opacity:.3;cursor:default}
    .page-dots{padding:0 4px;color:#bbb;font-size:.85rem;align-self:center}
    .wl-card-btn.added{background:#52b788;color:#fff}
    #empty{display:none;text-align:center;padding:60px 20px;color:#aaa;font-size:1rem}
    @media(max-width:700px){
      .layout{flex-direction:column;padding:12px}
      .sidebar{width:100%;position:static;max-height:none}
      .main{padding-left:0;margin-top:16px}
    }
  </style>
  </head><body>
  ${NAV_LINKS}
  <!-- Hero -->
  <div style="background:linear-gradient(160deg,#1b4332,#2d6a4f);color:#fff;padding:36px 24px;text-align:center">
    <h1 style="font-size:1.8rem;font-weight:800;margin-bottom:6px">Stauden suchen & filtern</h1>
    <p style="opacity:.8;font-size:.95rem">${total} winterharte Gartenstauden — filtere nach Standort, Blühzeit, Farbe und mehr</p>
  </div>

  <div class="layout">
    <!-- Sidebar Filter -->
    <aside class="sidebar">
      <h3>Standort</h3>
      <div class="chip-group">
        <button class="chip" data-filter="licht" data-val="Sonne" onclick="toggleChip(this)">☀️ Sonne</button>
        <button class="chip" data-filter="licht" data-val="Halbschatten" onclick="toggleChip(this)">🌤️ Halbschatten</button>
        <button class="chip" data-filter="licht" data-val="Schatten" onclick="toggleChip(this)">🌥️ Schatten</button>
      </div>

      <h3>Feuchtigkeit</h3>
      <div class="chip-group">
        <button class="chip" data-filter="feuchtigkeit" data-val="trocken" onclick="toggleChip(this)">🏜️ Trocken</button>
        <button class="chip" data-filter="feuchtigkeit" data-val="normal" onclick="toggleChip(this)">🌱 Normal</button>
        <button class="chip" data-filter="feuchtigkeit" data-val="feucht" onclick="toggleChip(this)">💧 Feucht</button>
        <button class="chip" data-filter="feuchtigkeit" data-val="nass" onclick="toggleChip(this)">🌊 Nass</button>
      </div>

      <h3>Höhe</h3>
      <div class="chip-group">
        <button class="chip" data-filter="hoehe" data-val="klein" onclick="toggleChip(this)">🌿 &lt;40 cm</button>
        <button class="chip" data-filter="hoehe" data-val="mittel" onclick="toggleChip(this)">🌾 40–100 cm</button>
        <button class="chip" data-filter="hoehe" data-val="gross" onclick="toggleChip(this)">🌳 &gt;100 cm</button>
      </div>

      <h3>Blühzeit</h3>
      <div class="chip-group">
        <button class="chip" data-filter="bluehzeit" data-val="frühjahr" onclick="toggleChip(this)">🌷 Frühjahr</button>
        <button class="chip" data-filter="bluehzeit" data-val="sommer" onclick="toggleChip(this)">🌻 Sommer</button>
        <button class="chip" data-filter="bluehzeit" data-val="herbst" onclick="toggleChip(this)">🍂 Herbst</button>
      </div>

      <h3>Farbe</h3>
      <div class="chip-group">
        ${[['weiß','#f5f5f5','#333'],['rosa','#ffb6c1','#333'],['rot','#e53e3e','#fff'],
           ['blau','#3b82f6','#fff'],['violett','#7c3aed','#fff'],['lila','#a855f7','#fff'],
           ['gelb','#f59e0b','#fff'],['orange','#f97316','#fff']].map(([v,bg,fg]) =>
          `<button class="chip" data-filter="farbe" data-val="${v}" onclick="toggleChip(this)" style="background:${bg};color:${fg}">${v}</button>`
        ).join('')}
      </div>

      <h3>Gartenstil</h3>
      <div class="chip-group">
        <button class="chip" data-filter="stil" data-val="Naturgarten" onclick="toggleChip(this)">🌿 Natur</button>
        <button class="chip" data-filter="stil" data-val="Bauerngarten" onclick="toggleChip(this)">🌸 Bauerngarten</button>
        <button class="chip" data-filter="stil" data-val="Cottage" onclick="toggleChip(this)">🏡 Cottage</button>
        <button class="chip" data-filter="stil" data-val="Modern" onclick="toggleChip(this)">◼ Modern</button>
      </div>

      <h3>Pflege</h3>
      <div class="chip-group">
        <button class="chip" data-filter="pflege" data-val="1" onclick="toggleChip(this)">★ Einfach</button>
        <button class="chip" data-filter="pflege" data-val="2" onclick="toggleChip(this)">★★ Mittel</button>
        <button class="chip" data-filter="pflege" data-val="3" onclick="toggleChip(this)">★★★ Intensiv</button>
      </div>

      <h3>Eigenschaften</h3>
      <label class="toggle-row"><input type="checkbox" id="f-bienen" onchange="applyFilters()"><label for="f-bienen">🐝 Bienenfreundlich</label></label>
      <label class="toggle-row"><input type="checkbox" id="f-heimisch" onchange="applyFilters()"><label for="f-heimisch">🌱 Heimisch</label></label>

      <button class="btn-reset" onclick="resetFilters()">✕ Alle Filter zurücksetzen</button>
    </aside>

    <!-- Main Content -->
    <div class="main">
      <div class="search-bar">
        <input type="text" id="search" placeholder="Name suchen… Sonnenhut, Hosta, Salvia…" oninput="applyFilters()">
      </div>
      <p id="count-label"></p>
      <div id="grid"></div>
      <div id="empty">🌿 Keine Stauden gefunden — probiere andere Filter.</div>
      <div id="pagination"></div>
    </div>
  </div>

  ${SITE_FOOTER}
  <script>
  function imgErr(img){img.parentElement.innerHTML='<div style="display:flex;align-items:center;justify-content:center;height:100%;font-size:3rem">🌿</div>';}
  let allPflanzen = [];
  const WL_KEY = 'staudenplan_wishlist';
  function getWL(){try{return JSON.parse(localStorage.getItem(WL_KEY)||'[]');}catch{return[];}}
  function saveWL(wl){localStorage.setItem(WL_KEY,JSON.stringify(wl));}

  async function loadPflanzen() {
    const r = await fetch('/api/pflanzen');
    allPflanzen = await r.json();
    applyFilters();
  }

  const activeFilters = {};
  function toggleChip(btn) {
    const f = btn.dataset.filter, v = btn.dataset.val;
    if (!activeFilters[f]) activeFilters[f] = new Set();
    if (activeFilters[f].has(v)) {
      activeFilters[f].delete(v);
      btn.classList.remove('active');
      if (f === 'farbe') btn.textContent = v; // Häkchen entfernen
    } else {
      activeFilters[f].add(v);
      btn.classList.add('active');
      if (f === 'farbe') btn.textContent = '✓ ' + v; // Häkchen zeigen
    }
    applyFilters();
  }

  const PAGE_SIZE = 40;
  let currentPage = 1;
  let filteredResults = [];

  function applyFilters() {
    currentPage = 1;
    const q = (document.getElementById('search').value || '').toLowerCase();
    const bienen = document.getElementById('f-bienen').checked;
    const heimisch = document.getElementById('f-heimisch').checked;

    filteredResults = allPflanzen.filter(p => {
      if (q && !p.name_deutsch.toLowerCase().includes(q) && !p.name_botanisch.toLowerCase().includes(q) && !(p.beschreibung||'').toLowerCase().includes(q)) return false;
      if (activeFilters.licht?.size && !activeFilters.licht.has((p.licht||'').split('|')[0])) return false;
      if (activeFilters.feuchtigkeit?.size && !activeFilters.feuchtigkeit.has(p.feuchtigkeit||'normal')) return false;
      if (activeFilters.stil?.size && ![...activeFilters.stil].some(s => (p.stil||'').includes(s))) return false;
      if (activeFilters.pflege?.size && !activeFilters.pflege.has(String(p.pflege_sterne||1))) return false;
      if (activeFilters.farbe?.size && ![...activeFilters.farbe].some(f => (p.farbe||'').toLowerCase().includes(f))) return false;
      if (activeFilters.bluehzeit?.size) {
        const bz = (p.bluehzeit||'').toLowerCase();
        const match = [...activeFilters.bluehzeit].some(s =>
          (s==='frühjahr' && (bz.includes('märz')||bz.includes('april')||bz.includes('mai'))) ||
          (s==='sommer' && (bz.includes('juni')||bz.includes('juli')||bz.includes('august'))) ||
          (s==='herbst' && (bz.includes('sept')||bz.includes('okt')||bz.includes('nov')))
        );
        if (!match) return false;
      }
      if (activeFilters.hoehe?.size) {
        const h = p.hoehe_cm_max || p.hoehe_cm_min || 50;
        const ok = [...activeFilters.hoehe].some(s =>
          (s==='klein' && h<40) || (s==='mittel' && h>=40 && h<=100) || (s==='gross' && h>100));
        if (!ok) return false;
      }
      if (bienen && !p.bienen_freundlich) return false;
      if (heimisch && !p.heimisch) return false;
      return true;
    });

    renderPage();
  }

  function goPage(n) {
    currentPage = n;
    renderPage();
    window.scrollTo({ top: document.getElementById('grid').offsetTop - 80, behavior: 'smooth' });
  }

  function renderPage() {
    const total = filteredResults.length;
    const totalPages = Math.ceil(total / PAGE_SIZE);
    const from = (currentPage - 1) * PAGE_SIZE;
    const pageItems = filteredResults.slice(from, from + PAGE_SIZE);

    document.getElementById('empty').style.display = total === 0 ? 'block' : 'none';
    document.getElementById('count-label').textContent = total === 0 ? '' :
      total <= PAGE_SIZE
        ? total + ' Stauden'
        : (from + 1) + '–' + Math.min(from + PAGE_SIZE, total) + ' von ' + total + ' Stauden';

    const LICHT_C = {Sonne:'#f59e0b',Halbschatten:'#6366f1',Schatten:'#475569'};
    const wl = getWL();
    document.getElementById('grid').innerHTML = pageItems.map(p => {
      const slug = p.name_botanisch.toLowerCase().replace(/ä/g,'ae').replace(/ö/g,'oe').replace(/ü/g,'ue').replace(/ß/g,'ss').replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');
      const lichtKey = (p.licht||'').split('|')[0];
      const lc = LICHT_C[lichtKey]||'#2d6a4f';
      const inWl = wl.find(w => w.name_botanisch === p.name_botanisch);
      return \`<div class="p-card" style="cursor:pointer">
        <a href="/pflanze/\${slug}" style="text-decoration:none;color:inherit;flex:1;display:flex;flex-direction:column">
          <div class="p-card-img">
            \${p.bild_url ? \`<img src="\${p.bild_url}" alt="\${p.name_deutsch.replace(/"/g,'&quot;')}" loading="lazy" onerror="imgErr(this)">\` : '<div style="display:flex;align-items:center;justify-content:center;height:100%;font-size:3rem">🌿</div>'}
            <div style="position:absolute;bottom:0;left:0;right:0;background:linear-gradient(transparent,rgba(0,0,0,.5));padding:6px 10px">
              <span style="background:\${lc};color:#fff;border-radius:4px;padding:1px 7px;font-size:.65rem;font-weight:700">\${lichtKey}</span>
            </div>
          </div>
          <div class="p-card-body">
            <div class="p-card-name">\${p.name_deutsch}</div>
            <div class="p-card-bot">\${p.name_botanisch}</div>
            <div class="p-card-tags">
              \${p.farbe ? \`<span class="p-tag" style="background:#f0fdf4;color:#2d6a4f">\${p.farbe.split('|')[0]}</span>\` : ''}
              \${p.bluehzeit ? \`<span class="p-tag" style="background:#fef3c7;color:#92400e">\${p.bluehzeit}</span>\` : ''}
              \${p.bienen_freundlich ? '<span class="p-tag" style="background:#fef9c3;color:#92400e">🐝</span>' : ''}
            </div>
          </div>
        </a>
        <button class="wl-card-btn \${inWl?'added':''}" data-bot="\${p.name_botanisch.replace(/"/g,'&quot;')}" data-de="\${p.name_deutsch.replace(/"/g,'&quot;')}" onclick="toggleWlCard(this,this.dataset.bot,this.dataset.de)">
          \${inWl ? '✓ Wunschliste' : '+ Wunschliste'}
        </button>
      </div>\`;
    }).join('');

    // Pagination
    const pg = document.getElementById('pagination');
    if (totalPages <= 1) { pg.innerHTML = ''; return; }

    const parts = [];
    parts.push(\`<button class="page-btn" onclick="goPage(\${currentPage-1})" \${currentPage===1?'disabled':''}>← zurück</button>\`);
    let last = 0;
    for (let i = 1; i <= totalPages; i++) {
      if (i === 1 || i === totalPages || (i >= currentPage - 2 && i <= currentPage + 2)) {
        if (last && i - last > 1) parts.push('<span class="page-dots">…</span>');
        parts.push(\`<button class="page-btn \${i===currentPage?'cur':''}" onclick="\${i===currentPage?'':' goPage('+i+')'}">\${i}</button>\`);
        last = i;
      }
    }
    parts.push(\`<button class="page-btn" onclick="goPage(\${currentPage+1})" \${currentPage===totalPages?'disabled':''}>weiter →</button>\`);
    pg.innerHTML = parts.join('');
  }

  function toggleWlCard(btn, bot, de) {
    let wl = getWL();
    if (wl.find(w => w.name_botanisch === bot)) {
      wl = wl.filter(w => w.name_botanisch !== bot);
      btn.textContent = '+ Wunschliste'; btn.classList.remove('added');
    } else {
      wl.push({name_deutsch: de, name_botanisch: bot});
      btn.textContent = '✓ Wunschliste'; btn.classList.add('added');
    }
    saveWL(wl);
    document.dispatchEvent(new CustomEvent('wl-changed'));
  }

  function resetFilters() {
    Object.keys(activeFilters).forEach(k => activeFilters[k].clear());
    document.querySelectorAll('.chip.active').forEach(c => {
      c.classList.remove('active');
      if (c.dataset.filter === 'farbe') c.textContent = c.dataset.val; // Häkchen entfernen
    });
    document.getElementById('f-bienen').checked = false;
    document.getElementById('f-heimisch').checked = false;
    document.getElementById('search').value = '';
    applyFilters();
  }

  loadPflanzen();
  </script>
  </body></html>`);
});

app.get('/pflanze/:slug', (req, res) => {
  const slug = req.params.slug;
  const alle = db.prepare('SELECT * FROM pflanzen').all();
  const pflanze = alle.find(p => pflanzeToSlug(p.name_botanisch) === slug);

  if (!pflanze) return res.status(404).send('<h2>Pflanze nicht gefunden. <a href="/pflanzen">Zurück zum Lexikon</a></h2>');

  const kauflink = `https://www.amazon.de/s?k=${encodeURIComponent(pflanze.name_botanisch)}&tag=gartenbaukosten-21`;
  const aehnliche = db.prepare(`
    SELECT name_deutsch, name_botanisch FROM pflanzen
    WHERE licht LIKE ? AND id != ? ORDER BY RANDOM() LIMIT 6
  `).all(`%${(pflanze.licht || '').split('|')[0]}%`, pflanze.id);

  const pflegeSterne = '★'.repeat(pflanze.pflege_sterne || 1) + '☆'.repeat(3 - (pflanze.pflege_sterne || 1));
  const hoehe = (pflanze.hoehe_cm_min && pflanze.hoehe_cm_max) ? `${pflanze.hoehe_cm_min}–${pflanze.hoehe_cm_max} cm` : (pflanze.hoehe_cm_min || pflanze.hoehe_cm_max || '—') + ' cm';
  const schemaOrg = JSON.stringify([
    {
      "@context": "https://schema.org",
      "@type": "Product",
      "name": `${pflanze.name_deutsch} (${pflanze.name_botanisch})`,
      "description": pflanze.beschreibung || '',
      "image": pflanze.bild_url || 'https://www.staudenplan.de/images/og-default.jpg',
      "offers": { "@type": "Offer", "priceCurrency": "EUR", "price": pflanze.preis_stueck_eur || 0, "availability": "https://schema.org/InStock" }
    },
    {
      "@context": "https://schema.org",
      "@type": "BreadcrumbList",
      "itemListElement": [
        { "@type": "ListItem", "position": 1, "name": "Startseite", "item": "https://www.staudenplan.de/" },
        { "@type": "ListItem", "position": 2, "name": "Stauden-Lexikon", "item": "https://www.staudenplan.de/pflanzen" },
        { "@type": "ListItem", "position": 3, "name": pflanze.name_deutsch, "item": `https://www.staudenplan.de/pflanze/${slug}` }
      ]
    }
  ]);

  // Ähnliche mit Bildern
  const aehnlicheMitBild = db.prepare(`
    SELECT name_deutsch, name_botanisch, bild_url, bluehzeit, licht FROM pflanzen
    WHERE (licht LIKE ? OR stil LIKE ?) AND id != ? ORDER BY RANDOM() LIMIT 6
  `).all(`%${(pflanze.licht||'').split('|')[0]}%`, `%${(pflanze.stil||'').split('|')[0]}%`, pflanze.id);

  res.send(`<!DOCTYPE html><html lang="de"><head>
  <meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${pflanze.name_deutsch} (${pflanze.name_botanisch}) — Pflege, Standort & Verwendung | Staudenplan.de</title>
  <meta name="description" content="${pflanze.name_deutsch} (${pflanze.name_botanisch}): ${(pflanze.beschreibung || '').substring(0, 130)} — Standort ${pflanze.licht||''}, Blühzeit ${pflanze.bluehzeit||''}, Pflege und Kauftipp.">
  <link rel="canonical" href="https://www.staudenplan.de/pflanze/${slug}">
  <meta property="og:title" content="${pflanze.name_deutsch} — Pflege, Standort & Kauftipp">
  <meta property="og:description" content="${(pflanze.beschreibung || '').substring(0, 155)}">
  <meta property="og:image" content="${pflanze.bild_url || 'https://www.staudenplan.de/images/og-default.jpg'}">
  <meta property="og:url" content="https://www.staudenplan.de/pflanze/${slug}">
  <meta property="og:type" content="product">
  <script type="application/ld+json">${schemaOrg}</script>
  <style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:'Segoe UI',system-ui,sans-serif;background:#f8f4ef;color:#1a1a1a}@media(max-width:680px){.pflanz-grid{grid-template-columns:1fr!important}.pflanz-hero-inner{flex-direction:column!important}}</style>
  </head><body>
  ${NAV_LINKS}

  <!-- Breadcrumb -->
  <div style="max-width:960px;margin:14px auto 0;padding:0 20px;font-size:.8rem;color:#aaa">
    <a href="/" style="color:#2d6a4f;text-decoration:none">Startseite</a> ›
    <a href="/pflanzen" style="color:#2d6a4f;text-decoration:none"> Stauden-Lexikon</a> ›
    <span>${pflanze.name_deutsch}</span>
  </div>

  <!-- Hero: Bild links, Info rechts -->
  <div style="max-width:960px;margin:20px auto;padding:0 20px">
    <div class="pflanz-hero-inner" style="display:flex;gap:28px;align-items:flex-start">

      <!-- Bild -->
      <div style="flex-shrink:0;width:380px;max-width:100%">
        ${pflanze.bild_url
          ? `<div style="border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.12);aspect-ratio:4/3">
               <img src="${pflanze.bild_url}" alt="${pflanze.name_deutsch} — ${pflanze.name_botanisch}" style="width:100%;height:100%;object-fit:cover;display:block">
             </div>
             <p style="font-size:.68rem;color:#bbb;margin-top:6px;text-align:right">Foto: Pixabay</p>`
          : `<div style="border-radius:16px;background:linear-gradient(135deg,#d8f3dc,#b7e4c7);aspect-ratio:4/3;display:flex;align-items:center;justify-content:center;font-size:6rem">🌿</div>`}
      </div>

      <!-- Info -->
      <div style="flex:1;min-width:0">
        <h1 style="font-size:clamp(1.5rem,4vw,2rem);color:#1b4332;font-weight:800;line-height:1.2;margin-bottom:4px">${pflanze.name_deutsch}</h1>
        <p style="font-style:italic;color:#888;font-size:1rem;margin-bottom:14px">${pflanze.name_botanisch}</p>
        <p style="line-height:1.7;color:#333;margin-bottom:20px;font-size:.95rem">${pflanze.beschreibung || 'Winterharte Gartenstaude für deutsche Gärten.'}</p>

        <!-- Eigenschaften Grid -->
        <div class="pflanz-grid" style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:24px">
          ${[
            ['☀️ Standort', (pflanze.licht||'—').replace(/\|/g,' · ')],
            ['🌸 Blühzeit', pflanze.bluehzeit||'—'],
            ['↕ Höhe', hoehe],
            ['🎨 Farbe', (pflanze.farbe||'—').replace(/\|/g,' · ')],
            ['🌱 Pflege', pflegeSterne],
            ['💶 Preis', pflanze.preis_stueck_eur ? pflanze.preis_stueck_eur.toFixed(2)+' €/Stück' : '—'],
          ].map(([l,v]) => `
            <div style="background:#fff;border-radius:10px;padding:12px 14px;box-shadow:0 1px 6px rgba(0,0,0,.06)">
              <div style="font-size:.72rem;color:#aaa;margin-bottom:3px;text-transform:uppercase;letter-spacing:.05em">${l}</div>
              <div style="font-weight:700;font-size:.92rem;color:#1b4332">${v}</div>
            </div>`).join('')}
          ${pflanze.bienen_freundlich ? `<div style="background:#fef9c3;border-radius:10px;padding:12px 14px"><div style="font-size:.72rem;color:#92400e;margin-bottom:3px;text-transform:uppercase;letter-spacing:.05em">Ökologie</div><div style="font-weight:700;font-size:.92rem;color:#92400e">🐝 Bienenfreundlich</div></div>` : ''}
          ${pflanze.heimisch ? `<div style="background:#f0fdf4;border-radius:10px;padding:12px 14px"><div style="font-size:.72rem;color:#065f46;margin-bottom:3px;text-transform:uppercase;letter-spacing:.05em">Herkunft</div><div style="font-weight:700;font-size:.92rem;color:#065f46">🌱 Heimisch in Deutschland</div></div>` : ''}
        </div>

        <!-- CTA Buttons -->
        <div style="display:flex;gap:10px;flex-wrap:wrap">
          <a href="${kauflink}" target="_blank" rel="noopener sponsored" style="background:#6b4226;color:#fff;border-radius:50px;padding:13px 28px;text-decoration:none;font-weight:700;font-size:.9rem;transition:background .15s">Bei Amazon kaufen →</a>
          <button id="wl-btn" onclick="addToWunschliste()" style="background:#2d6a4f;color:#fff;border:none;border-radius:50px;padding:13px 28px;font-weight:700;font-size:.9rem;cursor:pointer;transition:background .2s">🌿 Zur Wunschliste</button>
          <script>
          (function(){
            const KEY='staudenplan_wishlist', BOT='${pflanze.name_botanisch.replace(/'/g,"\\'")}', DE='${pflanze.name_deutsch.replace(/'/g,"\\'")}';
            function getWL(){try{return JSON.parse(localStorage.getItem(KEY)||'[]');}catch{return[];}}
            function setAdded(){const b=document.getElementById('wl-btn');if(!b)return;b.textContent='✓ Auf Wunschliste';b.style.background='#52b788';b.style.cursor='default';b.onclick=function(){if(window.snavToggle)window.snavToggle();};}
            window.addToWunschliste=function(){const wl=getWL();if(!wl.find(p=>p.name_botanisch===BOT)){wl.push({name_deutsch:DE,name_botanisch:BOT});localStorage.setItem(KEY,JSON.stringify(wl));}setAdded();document.dispatchEvent(new CustomEvent('wl-changed'));if(window.snavUpdateBtn)window.snavUpdateBtn();};
            if(getWL().find(p=>p.name_botanisch===BOT)){setAdded();if(window.snavUpdateBtn)window.snavUpdateBtn();}
          })();
          </script>
        </div>
        <p style="font-size:.72rem;color:#bbb;margin-top:8px">* Als Amazon-Partner verdienen wir an qualifizierten Käufen.
        </div>
      </div>
    </div>
  </div>

  <!-- Inhalt -->
  <main style="max-width:960px;margin:32px auto;padding:0 20px 60px">

    <!-- Standort & Pflege -->
    <section style="background:#fff;border-radius:14px;padding:24px;box-shadow:0 2px 12px rgba(0,0,0,.07);margin-bottom:24px">
      <h2 style="font-size:1.15rem;color:#1b4332;margin-bottom:16px;font-weight:700;display:flex;align-items:center;gap:8px">🌱 Standort & Pflege</h2>
      <p style="line-height:1.75;color:#333;margin-bottom:12px"><strong>${pflanze.name_deutsch}</strong> (${pflanze.name_botanisch}) ist eine ${pflanze.licht?pflanze.licht.split('|')[0]+'-liebende':''} Gartenstaude mit einer Wuchshöhe von ${hoehe}. ${pflanze.beschreibung||''}</p>
      <p style="line-height:1.75;color:#333;margin-bottom:12px">Besonders gut eignet sich die Pflanze für den <strong>${(pflanze.stil||'Naturgarten').replace(/\|/g,', ')}</strong>. Bodentyp: ${(pflanze.boden||'normaler Gartenboden').replace(/\|/g,', ')}.</p>
      <p style="line-height:1.75;color:#333"><strong>Pflanzzeit:</strong> März–Mai (Frühjahr) oder September–Oktober (Herbst). ${pflanze.bienen_freundlich?'Als bienenfreundliche Staude leistet sie einen wichtigen Beitrag zur Gartenökologie.':''} ${pflanze.heimisch?'Als heimische Art ist sie besonders wertvoll für einheimische Insekten und Vögel.':''}</p>
    </section>

    ${(() => {
      const d = pflanze.inhalt_lang ? (() => { try { return JSON.parse(pflanze.inhalt_lang); } catch { return null; } })() : null;
      if (!d) return '';
      return `
    <!-- Pflege im Detail -->
    <section style="background:#fff;border-radius:14px;padding:24px;box-shadow:0 2px 12px rgba(0,0,0,.07);margin-bottom:24px">
      <h2 style="font-size:1.15rem;color:#1b4332;margin-bottom:20px;font-weight:700">🌿 Pflege im Detail</h2>
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:14px">
        ${[
          ['📅 Pflanzzeit', d.pflanzzeit],
          ['📐 Pflanzabstand', d.pflanzabstand],
          ['💧 Gießen', d.giessen],
          ['🌱 Düngen', d.duengen],
          ['✂️ Rückschnitt', d.rueckschnitt],
          ['❄️ Überwinterung', d.ueberwinterung],
        ].filter(([,v]) => v).map(([label, val]) => `
          <div style="background:#f8f4ef;border-radius:10px;padding:14px 16px">
            <div style="font-size:.75rem;font-weight:700;color:#2d6a4f;margin-bottom:5px;text-transform:uppercase;letter-spacing:.04em">${label}</div>
            <p style="font-size:.88rem;color:#333;line-height:1.6;margin:0">${val}</p>
          </div>`).join('')}
      </div>
      ${d.tipp ? `<div style="background:linear-gradient(135deg,#d8f3dc,#b7e4c7);border-radius:10px;padding:14px 18px;margin-top:14px;display:flex;gap:12px;align-items:flex-start">
        <span style="font-size:1.4rem;flex-shrink:0">💡</span>
        <div><div style="font-size:.75rem;font-weight:700;color:#1b4332;margin-bottom:3px;text-transform:uppercase">Experten-Tipp</div><p style="font-size:.88rem;color:#1b4332;line-height:1.6;margin:0">${d.tipp}</p></div>
      </div>` : ''}
    </section>

    <!-- Kombinationen -->
    ${(() => {
      if (!d.kombinationen || d.kombinationen.length === 0) return '';
      // Für jeden Partner passende DB-Pflanze suchen (Genus-Match als Fallback)
      const kombinationenMitLink = d.kombinationen.map(k => {
        const genus = (k.name_botanisch || '').split(' ')[0];
        const match = db.prepare(
          `SELECT name_botanisch, name_deutsch FROM pflanzen
           WHERE name_botanisch = ? OR name_botanisch LIKE ? OR name_deutsch = ?
           LIMIT 1`
        ).get(k.name_botanisch, `${genus} %`, k.name_deutsch);
        return { ...k, slug: match ? pflanzeToSlug(match.name_botanisch) : null,
                       name_deutsch: match ? match.name_deutsch : k.name_deutsch };
      });
      return `
    <section style="background:#fff;border-radius:14px;padding:24px;box-shadow:0 2px 12px rgba(0,0,0,.07);margin-bottom:24px">
      <h2 style="font-size:1.15rem;color:#1b4332;margin-bottom:16px;font-weight:700">🌸 Ideale Kombinationspartner</h2>
      <div style="display:flex;flex-direction:column;gap:10px">
        ${kombinationenMitLink.map(k => k.slug
          ? `<a href="/pflanze/${k.slug}" style="display:flex;gap:14px;align-items:center;background:#f8f4ef;border-radius:10px;padding:12px 16px;text-decoration:none;color:inherit;transition:background .12s" onmouseover="this.style.background='#d8f3dc'" onmouseout="this.style.background='#f8f4ef'">
              <span style="font-size:1.5rem;flex-shrink:0">🌿</span>
              <div>
                <div style="font-weight:700;font-size:.92rem;color:#1b4332">${k.name_deutsch} <span style="font-style:italic;color:#aaa;font-weight:400;font-size:.8rem">${k.name_botanisch}</span></div>
                <div style="font-size:.82rem;color:#555;margin-top:2px">${k.grund}</div>
              </div>
              <span style="margin-left:auto;color:#2d6a4f;font-size:.8rem;font-weight:600;white-space:nowrap">Ansehen →</span>
            </a>`
          : `<div style="display:flex;gap:14px;align-items:center;background:#f8f4ef;border-radius:10px;padding:12px 16px;">
              <span style="font-size:1.5rem;flex-shrink:0">🌿</span>
              <div>
                <div style="font-weight:700;font-size:.92rem;color:#1b4332">${k.name_deutsch} <span style="font-style:italic;color:#aaa;font-weight:400;font-size:.8rem">${k.name_botanisch}</span></div>
                <div style="font-size:.82rem;color:#555;margin-top:2px">${k.grund}</div>
              </div>
            </div>`
        ).join('')}
      </div>
    </section>`;
    })()}

    <!-- Häufige Fehler -->
    ${d.fehler && d.fehler.length > 0 ? `
    <section style="background:#fff5f5;border-radius:14px;padding:24px;box-shadow:0 2px 12px rgba(0,0,0,.07);margin-bottom:24px">
      <h2 style="font-size:1.15rem;color:#9b2335;margin-bottom:14px;font-weight:700">⚠️ Häufige Fehler vermeiden</h2>
      <ul style="list-style:none;padding:0;display:flex;flex-direction:column;gap:8px">
        ${d.fehler.map(f => `<li style="display:flex;gap:10px;font-size:.88rem;color:#333;line-height:1.6"><span style="color:#e53e3e;font-weight:700;flex-shrink:0">✗</span>${f}</li>`).join('')}
      </ul>
    </section>` : ''}`;
    })()}

    <!-- Stile-Tags -->
    <section style="background:#f0fdf4;border-radius:14px;padding:20px 24px;margin-bottom:24px">
      <h2 style="font-size:1rem;color:#1b4332;margin-bottom:12px;font-weight:700">🎨 Gartenstil-Empfehlung</h2>
      <div style="display:flex;flex-wrap:wrap;gap:8px">
        ${(pflanze.stil||'Naturgarten').split('|').map(s => `<span style="background:#2d6a4f;color:#fff;border-radius:20px;padding:6px 16px;font-size:.82rem;font-weight:600">${s.trim()}</span>`).join('')}
      </div>
    </section>

    <!-- Ähnliche Stauden -->
    ${aehnlicheMitBild.length > 0 ? `
    <section>
      <h2 style="font-size:1.1rem;color:#1b4332;margin-bottom:16px;font-weight:700">🌺 Ähnliche Stauden</h2>
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:12px">
        ${aehnlicheMitBild.map(a => `
          <a href="/pflanze/${pflanzeToSlug(a.name_botanisch)}" style="background:#fff;border-radius:12px;text-decoration:none;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.07);transition:transform .12s" onmouseover="this.style.transform='translateY(-2px)'" onmouseout="this.style.transform=''">
            ${a.bild_url
              ? `<div style="height:90px;overflow:hidden"><img src="${a.bild_url}" alt="${a.name_deutsch}" style="width:100%;height:100%;object-fit:cover" loading="lazy"></div>`
              : `<div style="height:90px;background:linear-gradient(135deg,#d8f3dc,#b7e4c7);display:flex;align-items:center;justify-content:center;font-size:2rem">🌿</div>`}
            <div style="padding:10px">
              <div style="font-size:.82rem;font-weight:700;color:#1b4332;line-height:1.3">${a.name_deutsch}</div>
              <div style="font-size:.68rem;color:#aaa;font-style:italic">${a.name_botanisch}</div>
            </div>
          </a>`).join('')}
      </div>
    </section>` : ''}

    <!-- Plan CTA -->
    <div style="background:linear-gradient(135deg,#1b4332,#2d6a4f);color:#fff;border-radius:14px;padding:28px;margin-top:32px;text-align:center">
      <h3 style="font-size:1.15rem;margin-bottom:8px">Passt ${pflanze.name_deutsch} in deinen Garten?</h3>
      <p style="opacity:.88;font-size:.9rem;margin-bottom:18px">Unser KI-Planer zeigt dir den perfekten Bepflanzungsplan — mit ${pflanze.name_deutsch} als Teil eines harmonischen Gesamtkonzepts.</p>
      <a href="/" style="background:#fff;color:#1b4332;border-radius:50px;padding:12px 30px;text-decoration:none;font-weight:700;font-size:.9rem;display:inline-block">Kostenlosen Plan erstellen →</a>
    </div>
  </main>
  ${SITE_FOOTER}
  </body></html>`);
});

// ─── Ratgeber-Seiten (SEO) ────────────────────────────────────────────────────

// Kategorie-Design
const KAT_CONFIG = {
  'Grundprinzipien': { icon: '📚', grad: 'linear-gradient(135deg,#1b4332,#2d6a4f)', img: '/images/ratgeber-grundprinzipien.jpg' },
  'Standorte':       { icon: '🗺️', grad: 'linear-gradient(135deg,#1e3a5f,#2563eb)', img: '/images/ratgeber-standorte.jpg' },
  'Gestaltung':      { icon: '🎨', grad: 'linear-gradient(135deg,#4c1d95,#7c3aed)', img: '/images/ratgeber-gestaltung.jpg' },
  'Oekologie':       { icon: '🌿', grad: 'linear-gradient(135deg,#064e3b,#059669)', img: '/images/ratgeber-oekologie.jpg' },
  'Praxis':          { icon: '🔨', grad: 'linear-gradient(135deg,#78350f,#d97706)', img: '/images/ratgeber-praxis.jpg' },
  'Kombinationen':   { icon: '🌸', grad: 'linear-gradient(135deg,#831843,#db2777)', img: '/images/ratgeber-kombinationen.jpg' },
  'Stilpraegend':    { icon: '🏡', grad: 'linear-gradient(135deg,#134e4a,#0d9488)', img: '/images/ratgeber-stil.jpg' },
  'Design':          { icon: '✏️', grad: 'linear-gradient(135deg,#1e293b,#475569)', img: '/images/ratgeber-design.jpg' },
};
function katCfg(k) { return KAT_CONFIG[k] || { icon: '🌱', grad: 'linear-gradient(135deg,#1b4332,#52b788)', img: '' }; }
function readingTime(text) { return Math.max(1, Math.round(text.split(/\s+/).length / 200)); }

const FAVICON = `<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🌿</text></svg>">`;

const PLAUSIBLE = `<!-- Privacy-friendly analytics by Plausible -->
<script async src="https://plausible.io/js/pa-CQxds67VLWtj57jHuhY1V.js"></script>
<script>window.plausible=window.plausible||function(){(plausible.q=plausible.q||[]).push(arguments)},plausible.init=plausible.init||function(i){plausible.o=i||{}};plausible.init()</script>`;

const NAV_LINKS = `${FAVICON}${PLAUSIBLE}
<style>
  .snav{background:#1b4332;padding:12px 20px;display:flex;align-items:center;gap:6px;position:sticky;top:0;z-index:100}
  .snav a{color:rgba(255,255,255,.8);text-decoration:none;font-size:.85rem;padding:5px 10px;border-radius:20px;transition:background .12s}
  .snav a:hover{background:rgba(255,255,255,.12);color:#fff}
  #snav-wl-btn{font-family:inherit}
  #snav-wl-dd{display:none;position:fixed;top:52px;right:12px;background:#fff;border-radius:14px;box-shadow:0 8px 32px rgba(0,0,0,.2);padding:16px;min-width:280px;z-index:200}
  #snav-wl-list{display:flex;flex-direction:column;gap:6px;margin-bottom:12px;max-height:220px;overflow-y:auto}
  .snav-wl-item{display:flex;justify-content:space-between;align-items:center;background:#f8f4ef;border-radius:8px;padding:8px 12px}
  .snav-wl-item span{font-size:.85rem;font-weight:600;color:#1b4332}
  .snav-wl-rm{background:none;border:none;color:#aaa;cursor:pointer;font-size:1rem;padding:0 2px}
  .snav-wl-rm:hover{color:#e53e3e}
  @media(max-width:600px){
    .snav{padding:8px 12px;gap:2px}
    .snav a{font-size:.75rem;padding:4px 6px}
    #snav-wl-btn{font-size:.75rem;padding:4px 10px}
    #snav-wl-dd{left:8px;right:8px;min-width:0;top:50px}
    #snav-planer{display:none}
    .snav-logo-text{display:none}
  }
</style>
<nav class="snav">
  <a href="/" style="color:#fff;font-weight:700;font-size:1rem;margin-right:auto">🌿 <span class="snav-logo-text">Staudenplan.de</span></a>
  <a href="/" id="snav-planer">Planer</a>
  <a href="/pflanzen">Stauden</a>
  <a href="/ratgeber">Ratgeber</a>
  <button id="snav-wl-btn" style="background:rgba(255,255,255,.25);border:1.5px solid rgba(255,255,255,.6);color:#fff;font-size:.82rem;padding:5px 14px;border-radius:20px;cursor:pointer;font-family:inherit;font-weight:600" onclick="snavToggle()">🌿 <span id="snav-wl-n">0</span></button>
</nav>
<div id="snav-wl-dd">
  <p style="font-size:.75rem;color:#aaa;font-weight:700;text-transform:uppercase;letter-spacing:.05em;margin-bottom:10px">Meine Wunschliste</p>
  <div id="snav-wl-list"></div>
  <a href="/" style="display:block;background:#1b4332;color:#fff;border-radius:10px;padding:11px;text-align:center;text-decoration:none;font-weight:700;font-size:.88rem">Plan mit diesen Pflanzen erstellen →</a>
  <button onclick="snavClose()" style="width:100%;background:none;border:none;color:#aaa;font-size:.8rem;cursor:pointer;margin-top:8px;padding:4px">Schließen</button>
</div>
<script>
(function(){
  const WL='staudenplan_wishlist';
  function getWL(){try{return JSON.parse(localStorage.getItem(WL)||'[]');}catch{return[];}}
  function saveWL(w){localStorage.setItem(WL,JSON.stringify(w));}
  function renderDD(){
    var wl=getWL();
    var list=document.getElementById('snav-wl-list');
    list.innerHTML=wl.length?wl.map(function(p){
      return '<div class="snav-wl-item"><span>'+p.name_deutsch+'</span><button class="snav-wl-rm" onclick="snavRm(this.dataset.bot)" data-bot="'+p.name_botanisch.replace(/"/g,'&quot;')+'" title="Entfernen">✕</button></div>';
    }).join(''):'<p style="color:#aaa;font-size:.85rem">Noch leer</p>';
  }
  window.snavToggle=function(){var d=document.getElementById('snav-wl-dd');renderDD();d.style.display=d.style.display==='block'?'none':'block';};
  window.snavClose=function(){document.getElementById('snav-wl-dd').style.display='none';};
  window.snavRm=function(bot){var wl=getWL().filter(function(p){return p.name_botanisch!==bot;});saveWL(wl);updateBtn();renderDD();};
  function updateBtn(){
    var wl=getWL();
    var n=document.getElementById('snav-wl-n');
    if(n) n.textContent=wl.length;
    var btn=document.getElementById('snav-wl-btn');
    if(!btn)return;
    if(wl.length>0){btn.style.background='rgba(82,183,136,.35)';btn.style.borderColor='rgba(82,183,136,.7)';}
    else{btn.style.background='rgba(255,255,255,.15)';btn.style.borderColor='rgba(255,255,255,.3)';}
    if(wl.length===0)document.getElementById('snav-wl-dd') && (document.getElementById('snav-wl-dd').style.display='none');
  }
  window.snavUpdateBtn = updateBtn;
  document.addEventListener('wl-changed', updateBtn);
  updateBtn();
  setInterval(updateBtn, 500);
  document.addEventListener('click',function(e){
    var dd=document.getElementById('snav-wl-dd');
    var btn=document.getElementById('snav-wl-btn');
    if(dd&&btn&&!dd.contains(e.target)&&!btn.contains(e.target))dd.style.display='none';
  });
})();
</script>`;

const SITE_FOOTER = `<footer style="background:#1b4332;color:rgba(255,255,255,.7);padding:32px 24px;text-align:center;font-size:.82rem">
  <p style="margin-bottom:8px">© 2025 Staudenplan.de · <a href="/impressum" style="color:rgba(255,255,255,.6)">Impressum</a> · <a href="/datenschutz" style="color:rgba(255,255,255,.6)">Datenschutz</a> · <a href="https://www.freisinger-gartenschmiede.de" style="color:rgba(255,255,255,.6)" target="_blank">Gartenschmiede GmbH</a></p>
  <p><a href="/" style="color:#52b788">🌿 KI-Planer</a> · <a href="/pflanzen" style="color:#52b788">Stauden-Lexikon</a> · <a href="/ratgeber" style="color:#52b788">Ratgeber</a></p>
</footer>`;

app.get('/ratgeber', (req, res) => {
  let artikel = [];
  try { artikel = db.prepare('SELECT rowid, titel, kategorie, inhalt FROM wissen ORDER BY rowid DESC').all(); } catch {}

  const kategorien = [...new Set(artikel.map(a => a.kategorie))];
  const byKat = Object.fromEntries(kategorien.map(k => [k, artikel.filter(a => a.kategorie === k)]));

  // Featured = neuester Artikel
  const featured = artikel[0];
  const featuredCfg = featured ? katCfg(featured.kategorie) : null;

  const featuredHtml = featured ? `
    <a href="/ratgeber/${slugify(featured.titel)}" style="display:grid;grid-template-columns:1fr 1fr;gap:0;text-decoration:none;color:inherit;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.1);margin-bottom:48px;transition:transform .15s" onmouseover="this.style.transform='translateY(-3px)'" onmouseout="this.style.transform=''">
      <div style="background:${featuredCfg.grad};padding:40px;display:flex;flex-direction:column;justify-content:center;min-height:200px">
        <div style="font-size:2.5rem;margin-bottom:12px">${featuredCfg.icon}</div>
        <span style="background:rgba(255,255,255,.2);color:#fff;border-radius:20px;padding:4px 12px;font-size:.75rem;font-weight:700;text-transform:uppercase;letter-spacing:.05em;display:inline-block;margin-bottom:12px">${featured.kategorie}</span>
        <p style="color:rgba(255,255,255,.7);font-size:.82rem">${readingTime(featured.inhalt)} Min. Lesezeit</p>
      </div>
      <div style="padding:32px;display:flex;flex-direction:column;justify-content:center">
        <span style="font-size:.75rem;color:#52b788;font-weight:700;text-transform:uppercase;letter-spacing:.05em;margin-bottom:10px">Empfohlener Artikel</span>
        <h2 style="font-size:1.3rem;color:#1b4332;line-height:1.3;margin-bottom:12px;font-weight:700">${featured.titel}</h2>
        <p style="color:#555;font-size:.88rem;line-height:1.6;margin-bottom:20px">${featured.inhalt.substring(0, 130)}…</p>
        <span style="color:#2d6a4f;font-weight:700;font-size:.9rem">Jetzt lesen →</span>
      </div>
    </a>` : '';

  const sections = kategorien.map(kat => {
    const cfg = katCfg(kat);
    const arts = byKat[kat];
    return `
    <section style="margin-bottom:48px">
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:20px;padding-bottom:12px;border-bottom:2px solid #d8f3dc">
        <span style="font-size:1.4rem">${cfg.icon}</span>
        <h2 style="font-size:1.2rem;color:#1b4332;font-weight:700">${kat}</h2>
        <span style="margin-left:auto;font-size:.78rem;color:#aaa">${arts.length} Artikel</span>
      </div>
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:14px">
        ${arts.map(a => `
          <a href="/ratgeber/${slugify(a.titel)}" style="display:flex;flex-direction:column;background:#fff;border-radius:12px;padding:0;text-decoration:none;color:inherit;box-shadow:0 2px 10px rgba(0,0,0,.07);overflow:hidden;transition:transform .12s" onmouseover="this.style.transform='translateY(-3px)'" onmouseout="this.style.transform=''">
            <div style="background:${cfg.grad};padding:16px 18px;display:flex;align-items:center;gap:8px">
              <span style="font-size:1.1rem">${cfg.icon}</span>
              <span style="color:rgba(255,255,255,.75);font-size:.72rem;font-weight:600;text-transform:uppercase;letter-spacing:.04em">${kat}</span>
              <span style="margin-left:auto;color:rgba(255,255,255,.6);font-size:.7rem">${readingTime(a.inhalt)} Min.</span>
            </div>
            <div style="padding:16px 18px 18px;flex:1;display:flex;flex-direction:column">
              <h3 style="font-size:.92rem;font-weight:700;color:#1a1a1a;line-height:1.4;margin-bottom:8px">${a.titel}</h3>
              <p style="font-size:.8rem;color:#777;line-height:1.5;flex:1">${a.inhalt.substring(0, 90)}…</p>
              <span style="color:#2d6a4f;font-size:.78rem;font-weight:700;margin-top:10px">Weiterlesen →</span>
            </div>
          </a>`).join('')}
      </div>
    </section>`;
  }).join('');

  res.send(`<!DOCTYPE html><html lang="de"><head>
  <meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Garten-Ratgeber — Staudenbeete planen, pflegen und gestalten | Staudenplan.de</title>
  <meta name="description" content="Ratgeber für Staudenbeete: ${artikel.length} Expertentexte zu Standorten, Pflanzkombinationen, Pflege und Gestaltung — von Grundprinzipien bis Praxistipps.">
  <style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:'Segoe UI',system-ui,sans-serif;background:#f8f4ef;color:#1a1a1a}@media(max-width:640px){a[style*="grid-template-columns:1fr 1fr"]{display:flex!important;flex-direction:column!important}}</style>
  </head><body>
  ${NAV_LINKS}
  <!-- Hero -->
  <div style="background:linear-gradient(160deg,#1b4332 0%,#2d6a4f 60%,#52b788 100%);color:#fff;padding:56px 24px;text-align:center">
    <h1 style="font-size:2rem;font-weight:800;margin-bottom:10px">Garten-Ratgeber</h1>
    <p style="opacity:.85;max-width:560px;margin:0 auto 24px;font-size:1rem;line-height:1.6">Expertenwissen für schöne Staudenbeete — ${artikel.length} Artikel zu Planung, Pflege, Standorten und Gestaltung</p>
    <div style="display:flex;gap:12px;justify-content:center;flex-wrap:wrap">
      ${kategorien.map(k => `<a href="#kat-${slugify(k)}" style="background:rgba(255,255,255,.15);color:#fff;text-decoration:none;border-radius:20px;padding:6px 16px;font-size:.82rem;font-weight:600;transition:background .12s" onmouseover="this.style.background='rgba(255,255,255,.25)'" onmouseout="this.style.background='rgba(255,255,255,.15)'">${katCfg(k).icon} ${k}</a>`).join('')}
    </div>
  </div>
  <!-- Content -->
  <main style="max-width:1100px;margin:0 auto;padding:48px 20px 60px">
    ${featuredHtml}
    ${sections}
  </main>
  <!-- CTA -->
  <div style="background:linear-gradient(135deg,#6b4226,#9a5e38);color:#fff;padding:48px 24px;text-align:center">
    <h2 style="font-size:1.5rem;margin-bottom:10px">Bereit deinen Garten zu bepflanzen?</h2>
    <p style="opacity:.88;margin-bottom:24px;font-size:.95rem">Nutze unser KI-Tool und erstelle in 2 Minuten deinen personalisierten Bepflanzungsplan.</p>
    <a href="/" style="background:#fff;color:#6b4226;border-radius:50px;padding:14px 36px;text-decoration:none;font-weight:700;font-size:1rem">Kostenlosen Plan erstellen →</a>
  </div>
  ${SITE_FOOTER}
  </body></html>`);
});

app.get('/ratgeber/:slug', (req, res) => {
  const slug = req.params.slug;
  let alle = [];
  try { alle = db.prepare('SELECT rowid, * FROM wissen').all(); } catch {}

  const artikel = alle.find(a => slugify(a.titel) === slug);
  if (!artikel) return res.status(404).send(`<!DOCTYPE html><html lang="de"><head><meta charset="UTF-8"><title>Nicht gefunden</title></head><body>${NAV_LINKS}<div style="text-align:center;padding:80px 20px"><h1>Artikel nicht gefunden</h1><p><a href="/ratgeber">Zurück zum Ratgeber</a></p></div>${SITE_FOOTER}</body></html>`);

  const verwandte = alle.filter(a => a.kategorie === artikel.kategorie && a.rowid !== artikel.rowid).slice(0, 3);
  const cfg = katCfg(artikel.kategorie);
  const lesezeit = readingTime(artikel.inhalt);

  // Passende Pflanzen zum Artikel (interne Verlinkung)
  const artikelWoerter = artikel.titel.toLowerCase() + ' ' + artikel.inhalt.toLowerCase();
  const passendePflanzen = db.prepare('SELECT name_deutsch, name_botanisch, bild_url, bluehzeit, licht FROM pflanzen ORDER BY RANDOM()').all()
    .filter(p => artikelWoerter.includes(p.name_deutsch.toLowerCase()) || artikelWoerter.includes((p.name_botanisch || '').split(' ')[0].toLowerCase()))
    .slice(0, 4);

  // Article Schema
  const articleSchema = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "Article",
    "headline": artikel.titel,
    "description": artikel.inhalt.substring(0, 155),
    "author": { "@type": "Organization", "name": "Staudenplan.de" },
    "publisher": { "@type": "Organization", "name": "Staudenplan.de", "url": "https://www.staudenplan.de" },
    "datePublished": artikel.datum || new Date().toISOString().split('T')[0],
    "image": "https://www.staudenplan.de/images/og-default.jpg",
    "mainEntityOfPage": `https://www.staudenplan.de/ratgeber/${slug}`
  });

  // Absätze mit Pull-Quote auf zweitem Absatz
  const absaetzeRaw = artikel.inhalt.split('\n').filter(l => l.trim());
  const absaetze = absaetzeRaw.map((t, i) => {
    if (i === 0) return `<p style="font-size:1.08rem;line-height:1.8;color:#222;margin-bottom:20px;font-weight:400">${t}</p>`;
    if (i === 1) return `<blockquote style="border-left:4px solid #52b788;background:#f0fdf4;border-radius:0 10px 10px 0;padding:18px 20px;margin:28px 0;font-size:1rem;line-height:1.7;color:#1b4332;font-style:italic">${t}</blockquote>`;
    return `<p style="margin-bottom:18px;line-height:1.78;font-size:.97rem;color:#333">${t}</p>`;
  }).join('\n');

  const passendePflanzenHtml = passendePflanzen.length > 0 ? `
    <div style="margin-top:40px;padding-top:28px;border-top:2px solid #e0d9cf">
      <h2 style="font-size:1.1rem;color:#1b4332;margin-bottom:16px;font-weight:700">🌿 Im Artikel erwähnte Stauden</h2>
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:10px">
        ${passendePflanzen.map(p => `
          <a href="/pflanze/${pflanzeToSlug(p.name_botanisch)}" style="background:#fff;border-radius:10px;text-decoration:none;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.07);transition:transform .12s" onmouseover="this.style.transform='translateY(-2px)'" onmouseout="this.style.transform=''">
            ${p.bild_url ? `<div style="height:80px;overflow:hidden"><img src="${p.bild_url}" alt="${p.name_deutsch}" loading="lazy" style="width:100%;height:100%;object-fit:cover"></div>` : `<div style="height:80px;background:linear-gradient(135deg,#d8f3dc,#b7e4c7);display:flex;align-items:center;justify-content:center;font-size:2rem">🌿</div>`}
            <div style="padding:10px">
              <div style="font-size:.82rem;font-weight:700;color:#1b4332">${p.name_deutsch}</div>
              <div style="font-size:.7rem;color:#aaa;font-style:italic">${p.name_botanisch}</div>
            </div>
          </a>`).join('')}
      </div>
    </div>` : '';

  const verwandteHtml = verwandte.length > 0 ? `
    <div style="margin-top:48px;padding-top:32px;border-top:2px solid #e0d9cf">
      <h2 style="font-size:1.1rem;color:#1b4332;margin-bottom:20px;font-weight:700">Weitere Ratgeber: ${artikel.kategorie}</h2>
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:12px">
        ${verwandte.map(v => `
          <a href="/ratgeber/${slugify(v.titel)}" style="background:#fff;border-radius:10px;padding:0;text-decoration:none;box-shadow:0 2px 8px rgba(0,0,0,.07);overflow:hidden;transition:transform .12s" onmouseover="this.style.transform='translateY(-2px)'" onmouseout="this.style.transform=''">
            <div style="background:${cfg.grad};padding:10px 14px"><span style="color:rgba(255,255,255,.8);font-size:.72rem;font-weight:600">${cfg.icon} ${v.kategorie}</span></div>
            <div style="padding:14px"><p style="font-size:.85rem;font-weight:700;color:#1a1a1a;line-height:1.4;margin-bottom:6px">${v.titel}</p><span style="color:#2d6a4f;font-size:.78rem;font-weight:700">Lesen →</span></div>
          </a>`).join('')}
      </div>
    </div>` : '';

  res.send(`<!DOCTYPE html><html lang="de"><head>
  <meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${artikel.titel} | Staudenplan.de Ratgeber</title>
  <meta name="description" content="${artikel.inhalt.substring(0, 155).replace(/"/g,"'")}">
  <link rel="canonical" href="https://www.staudenplan.de/ratgeber/${slug}">
  <meta property="og:title" content="${artikel.titel}">
  <meta property="og:type" content="article">
  <meta property="og:description" content="${artikel.inhalt.substring(0, 155).replace(/"/g,"'")}">
  <meta property="og:image" content="https://www.staudenplan.de/images/og-default.jpg">
  <meta property="og:url" content="https://www.staudenplan.de/ratgeber/${slug}">
  <script type="application/ld+json">${articleSchema}</script>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:'Segoe UI',system-ui,sans-serif;background:#f8f4ef;color:#1a1a1a}
    @media(max-width:900px){.art-layout{flex-direction:column!important}.art-sidebar{position:static!important;width:100%!important}}
  </style>
  </head><body>
  ${NAV_LINKS}

  <!-- Artikel-Hero -->
  <div style="background:${cfg.grad};padding:48px 24px 40px;position:relative;overflow:hidden">
    <div style="position:absolute;inset:0;background:url('${cfg.img}') center/cover no-repeat;opacity:.15"></div>
    <div style="max-width:760px;margin:0 auto;position:relative">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:16px">
        <a href="/ratgeber" style="color:rgba(255,255,255,.7);text-decoration:none;font-size:.82rem">← Ratgeber</a>
        <span style="color:rgba(255,255,255,.4)">/</span>
        <span style="background:rgba(255,255,255,.2);color:#fff;border-radius:20px;padding:3px 12px;font-size:.75rem;font-weight:700">${cfg.icon} ${artikel.kategorie}</span>
      </div>
      <h1 style="font-size:clamp(1.5rem,4vw,2rem);font-weight:800;color:#fff;line-height:1.25;margin-bottom:16px">${artikel.titel}</h1>
      <div style="display:flex;align-items:center;gap:16px;color:rgba(255,255,255,.7);font-size:.82rem">
        <span>📖 ${lesezeit} Min. Lesezeit</span>
        <span>·</span>
        <span>Staudenplan.de Redaktion</span>
        <span>·</span>
        <span>${artikel.datum || new Date().getFullYear()}</span>
      </div>
    </div>
  </div>

  <!-- Inhalt + Sidebar -->
  <div class="art-layout" style="max-width:1060px;margin:0 auto;padding:40px 20px 60px;display:flex;gap:40px;align-items:flex-start">
    <!-- Artikel -->
    <article style="flex:1;min-width:0">
      <div>${absaetze}</div>

      <!-- Mid-CTA -->
      <div style="background:linear-gradient(135deg,#1b4332,#2d6a4f);color:#fff;border-radius:14px;padding:28px;margin:36px 0;text-align:center">
        <p style="font-size:.85rem;opacity:.8;margin-bottom:6px">Das Gelernte direkt umsetzen</p>
        <h3 style="font-size:1.15rem;margin-bottom:12px">Bepflanzungsplan für dein Beet erstellen</h3>
        <a href="/" style="background:#fff;color:#1b4332;border-radius:50px;padding:11px 28px;text-decoration:none;font-weight:700;font-size:.9rem;display:inline-block">Jetzt kostenlosen Plan erstellen →</a>
      </div>

      ${passendePflanzenHtml}
      ${verwandteHtml}
    </article>

    <!-- Sidebar -->
    <aside class="art-sidebar" style="width:280px;flex-shrink:0;position:sticky;top:80px">
      <div style="background:#fff;border-radius:14px;box-shadow:0 2px 16px rgba(0,0,0,.08);overflow:hidden;margin-bottom:20px">
        <div style="background:${cfg.grad};padding:16px 18px">
          <p style="color:rgba(255,255,255,.8);font-size:.75rem;font-weight:700;text-transform:uppercase;letter-spacing:.04em">KI-Planer</p>
        </div>
        <div style="padding:18px">
          <p style="font-size:.85rem;color:#555;line-height:1.6;margin-bottom:14px">Alles was du in diesem Artikel gelernt hast, kannst du direkt in deinen persönlichen Bepflanzungsplan einfließen lassen.</p>
          <a href="/" style="display:block;background:#2d6a4f;color:#fff;border-radius:10px;padding:12px;text-align:center;text-decoration:none;font-weight:700;font-size:.9rem">Plan erstellen →</a>
        </div>
      </div>
      <div style="background:#fff;border-radius:14px;box-shadow:0 2px 16px rgba(0,0,0,.08);padding:18px">
        <p style="font-weight:700;font-size:.9rem;color:#1b4332;margin-bottom:12px">Alle ${artikel.kategorie}-Artikel</p>
        ${alle.filter(a => a.kategorie === artikel.kategorie).map(a =>
          `<a href="/ratgeber/${slugify(a.titel)}" style="display:block;font-size:.8rem;color:${a.rowid===artikel.rowid?'#2d6a4f':'#555'};text-decoration:none;padding:6px 0;border-bottom:1px solid #f0ede8;font-weight:${a.rowid===artikel.rowid?'700':'400'};line-height:1.4">${a.rowid===artikel.rowid?'▶ ':''}${a.titel}</a>`
        ).join('')}
      </div>
    </aside>
  </div>

  ${SITE_FOOTER}
  </body></html>`);
});

// ─── Admin ────────────────────────────────────────────────────────────────────

function checkAdminPw(req, res) {
  if (!req.query.pw || req.query.pw !== process.env.ADMIN_PASSWORT) {
    res.status(401).json({ error: 'Passwort fehlt oder falsch.' });
    return false;
  }
  return true;
}

app.get('/admin', (req, res) => {
  if (!req.query.pw || req.query.pw !== process.env.ADMIN_PASSWORT) {
    return res.status(401).send('<h2>Bitte /admin?pw=PASSWORT aufrufen</h2>');
  }

  const anfragen   = db.prepare('SELECT * FROM anfragen ORDER BY erstellt_am DESC').all();
  const emailGates = db.prepare('SELECT * FROM email_gate ORDER BY erstellt_am DESC').all();
  const pflanzenN  = db.prepare("SELECT COUNT(*) as n FROM pflanzen WHERE name_deutsch != 'Test-Pflanze'").get().n;
  let wissenN = 0;
  try { wissenN = db.prepare('SELECT COUNT(*) as n FROM wissen').get().n; } catch {}

  const rows = anfragen.map(a => `
    <tr>
      <td>${a.id}</td><td>${a.erstellt_am}</td><td>${a.name}</td>
      <td><a href="mailto:${a.email}">${a.email}</a></td><td>${a.plz}</td>
      <td>${a.gartenflaeche || '—'} m²</td><td>${a.licht || '—'}</td>
      <td>${a.stil || '—'}</td><td>${a.anmerkungen || '—'}</td>
    </tr>`).join('');

  res.send(`<!DOCTYPE html><html lang="de"><head><meta charset="UTF-8"><title>Admin — Stauden-Portal</title>
  <style>
    body{font-family:sans-serif;padding:20px;background:#f8f4ef}
    h1{color:#1b4332}h2{color:#2d6a4f;margin-top:28px}
    table{border-collapse:collapse;width:100%;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.1)}
    th,td{border:1px solid #e0d9cf;padding:8px 12px;text-align:left}th{background:#2d6a4f;color:#fff}
    .stat-row{display:flex;gap:16px;margin-bottom:24px}
    .stat{background:#fff;border-radius:8px;padding:16px 24px;box-shadow:0 2px 8px rgba(0,0,0,.08)}
    .stat strong{display:block;font-size:2rem;color:#2d6a4f}
    .btn{background:#2d6a4f;color:#fff;border:none;border-radius:8px;padding:10px 20px;cursor:pointer;font-size:1rem;margin-right:8px}
    .btn:hover{background:#1b4332}.btn.orange{background:#6b4226}.btn.orange:hover{background:#4a2e1a}
    #update-log{background:#1a1a1a;color:#a8f0c8;border-radius:8px;padding:16px;font-family:monospace;font-size:.85rem;min-height:80px;white-space:pre-wrap;margin-top:12px;display:none}
  </style></head>
  <body>
  <h1>Stauden-Portal Admin</h1>
  <div class="stat-row">
    <div class="stat"><strong>${emailGates.length}</strong>PDF-Downloads (E-Mails)</div>
    <div class="stat"><strong>${anfragen.length}</strong>Beratungsanfragen</div>
    <div class="stat"><strong>${pflanzenN}</strong>Pflanzen in DB</div>
    <div class="stat"><strong>${wissenN}</strong>Wissens-Einträge</div>
  </div>
  <h2>Wissensdatenbank</h2>
  <button class="btn orange" onclick="updateWissen()">🌿 Wissen aktualisieren (Web-Suche)</button>
  <div id="update-log"></div>
  <h2>📧 PDF-Downloads / E-Mail-Liste (${emailGates.length})</h2>
  <table><tr><th>#</th><th>Datum</th><th>E-Mail</th><th>Fläche</th><th>Licht</th><th>Stil</th></tr>
  ${emailGates.map(e => `<tr><td>${e.id}</td><td>${e.erstellt_am}</td><td><a href="mailto:${e.email}">${e.email}</a></td><td>${e.gartenflaeche||'—'} m²</td><td>${e.licht||'—'}</td><td>${e.stil||'—'}</td></tr>`).join('')}
  </table>
  <h2>Beratungsanfragen (${anfragen.length})</h2>
  <table><tr><th>#</th><th>Datum</th><th>Name</th><th>E-Mail</th><th>PLZ</th><th>Fläche</th><th>Licht</th><th>Stil</th><th>Anmerkungen</th></tr>${rows}</table>
  <script>
  async function updateWissen() {
    const log = document.getElementById('update-log');
    log.style.display = 'block';
    log.textContent = 'Starte Web-Suche...\\n';
    try {
      const res = await fetch('/admin/update-wissen?pw=${process.env.ADMIN_PASSWORT || ''}', { method: 'POST' });
      const data = await res.json();
      log.textContent += (data.log || []).join('\\n') + '\\n\\n✅ ' + data.erstellt + ' neue Einträge erstellt.';
    } catch(e) { log.textContent += 'Fehler: ' + e.message; }
  }
  </script>
  </body></html>`);
});

app.post('/admin/update-wissen', async (req, res) => {
  if (!checkAdminPw(req, res)) return;

  try {
    const { runUpdate } = require('./scripts/update-wissen');
    const result = await runUpdate(db, getOpenAI());
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message, log: [] });
  }
});

// ─── Static Files (nach allen Routes!) ────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// ─── Start ────────────────────────────────────────────────────────────────────

app.listen(PORT, async () => {
  const pflanzenN = db.prepare("SELECT COUNT(*) as n FROM pflanzen WHERE name_deutsch != 'Test-Pflanze'").get().n;
  let wissenN = 0;
  try { wissenN = db.prepare('SELECT COUNT(*) as n FROM wissen').get().n; } catch {}
  console.log(`Stauden-Portal läuft auf http://localhost:${PORT}`);
  console.log(`Datenbank: ${pflanzenN} Pflanzen, ${wissenN} Wissens-Einträge`);

  // IndexNow: alle URLs bei Bing einreichen
  const BASE = process.env.SITE_URL || 'https://www.staudenplan.de';
  try {
    const pflanzen = db.prepare('SELECT name_botanisch FROM pflanzen').all();
    let wissens = [];
    try { wissens = db.prepare('SELECT titel FROM wissen').all(); } catch {}
    const urls = [
      BASE + '/',
      BASE + '/pflanzen',
      BASE + '/ratgeber',
      ...pflanzen.map(p => `${BASE}/pflanze/${pflanzeToSlug(p.name_botanisch)}`),
      ...wissens.map(w => `${BASE}/ratgeber/${slugify(w.titel)}`),
    ];
    const res = await fetch('https://api.indexnow.org/indexnow', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ host: 'www.staudenplan.de', key: INDEXNOW_KEY, urlList: urls }),
      signal: AbortSignal.timeout(10000)
    });
    console.log(`IndexNow: ${urls.length} URLs eingereicht (Status ${res.status})`);
  } catch (e) {
    console.log(`IndexNow: ${e.message}`);
  }
});
