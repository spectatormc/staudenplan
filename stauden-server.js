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
const planLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 10,
  message: { error: 'Zu viele Anfragen, bitte versuche es später erneut.' }
});
const anfrageLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 5,
  message: { error: 'Zu viele Anfragen, bitte versuche es später erneut.' }
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
  const pflanzenCount = db.prepare('SELECT COUNT(*) as n FROM pflanzen').get().n;
  if (pflanzenCount === 0) return [];

  const lichtTerm   = LICHT_MAP[licht] || licht.split(' ')[0];
  const bodenTerm   = BODEN_MAP[boden] || 'normal';
  const stilTerm    = STIL_MAP[stil]   || stil.split('/')[0].trim();
  const feuchtigkeit = getFeuchtigkeit(boden, standortBeschr);
  const feuchTerms  = FEUCHT_COMPAT[feuchtigkeit] || ['normal'];
  const feuchPlaceholders = feuchTerms.map(() => '?').join(',');

  // Vollständiger Match mit Feuchtigkeit
  let kandidaten = db.prepare(`
    SELECT name_deutsch, name_botanisch, beschreibung, licht, boden, stil,
           bluehzeit, farbe, hoehe_cm_min, hoehe_cm_max,
           pflege_sterne, preis_stueck_eur, bienen_freundlich, heimisch,
           feuchtigkeit, wuchs
    FROM pflanzen
    WHERE licht LIKE ? AND (boden LIKE ? OR boden LIKE ?) AND stil LIKE ?
      AND (feuchtigkeit IN (${feuchPlaceholders}) OR feuchtigkeit IS NULL)
    ORDER BY RANDOM() LIMIT 35
  `).all(`%${lichtTerm}%`, `%${bodenTerm}%`, '%normal%', `%${stilTerm}%`, ...feuchTerms);

  // Fallback: nur Licht + Feuchtigkeit
  if (kandidaten.length < 10) {
    kandidaten = db.prepare(`
      SELECT name_deutsch, name_botanisch, beschreibung, licht, boden, stil,
             bluehzeit, farbe, hoehe_cm_min, hoehe_cm_max,
             pflege_sterne, preis_stueck_eur, bienen_freundlich, heimisch,
             feuchtigkeit, wuchs
      FROM pflanzen
      WHERE licht LIKE ?
        AND (feuchtigkeit IN (${feuchPlaceholders}) OR feuchtigkeit IS NULL)
      ORDER BY RANDOM() LIMIT 35
    `).all(`%${lichtTerm}%`, ...feuchTerms);
  }

  // Letzter Fallback: nur Licht
  if (kandidaten.length < 8) {
    kandidaten = db.prepare(`
      SELECT name_deutsch, name_botanisch, beschreibung, licht, boden, stil,
             bluehzeit, farbe, hoehe_cm_min, hoehe_cm_max,
             pflege_sterne, preis_stueck_eur, bienen_freundlich, heimisch,
             feuchtigkeit, wuchs
      FROM pflanzen WHERE licht LIKE ? ORDER BY RANDOM() LIMIT 35
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
4. FARBHARMONIE: Maximal 3–4 Hauptfarben, Weiß oder Silber als Verbinder nutzen.`;

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
      const schicht = (p.hoehe_cm_max || 50) >= 100 ? 'Leitstaude' : (p.hoehe_cm_max || 50) >= 50 ? 'Begleiter' : 'Bodendecker';
      const extras = [
        p.bienen_freundlich ? '🐝bienenfr.' : '',
        p.heimisch ? '🌿heimisch' : '',
        p.feuchtigkeit && p.feuchtigkeit !== 'normal' ? `💧${p.feuchtigkeit}` : '',
        p.wuchs && p.wuchs !== 'horstig' ? `⚠️${p.wuchs}` : '',
      ].filter(Boolean).join(' ');
      return `- [${schicht}] ${p.name_deutsch} (${p.name_botanisch}): ${p.licht} | Blüte: ${p.bluehzeit || '?'} | ${p.farbe || '?'} | ${hoehe} | ${p.preis_stueck_eur || '?'}€ | Pflege: ${'★'.repeat(p.pflege_sterne || 2)}${extras ? ' | ' + extras : ''}`;
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
    const pflanzenCount = db.prepare('SELECT COUNT(*) as n FROM pflanzen').get().n;
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
      <h2>Bepflanzungsplan kostenlos erstellen — KI-gestützt & individuell</h2>
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
      <p>© 2025 Staudenplan.de · Betrieben von <a href="https://www.gartenschmiede.de" style="color:rgba(255,255,255,.6)" target="_blank">Gartenschmiede GmbH</a> · <a href="/impressum" style="color:rgba(255,255,255,.6)">Impressum</a> · <a href="/datenschutz" style="color:rgba(255,255,255,.6)">Datenschutz</a></p>
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

app.post('/api/plan', planLimiter, async (req, res) => {
  const { gartenflaeche, licht, boden, standort_beschreibung, stil, farbe, saison,
          lieblingspflanzen, budget, nutzung, pflegezeit } = req.body;

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

  const userPrompt = `Erstelle einen Bepflanzungsplan für einen Privatgarten:
- Fläche: ${gartenflaeche} m²
- Standort: ${standort_beschreibung || `${licht}, ${boden}`}
- Lichtbedingungen: ${licht}
- Bodentyp: ${boden}
- Gartenstil: ${stil}
- Farbwunsch: ${farbe || 'keine Präferenz'}
- Blühsaison-Priorität: ${saison || 'ganzjährig'}${lieblingsList ? `\n- Lieblingspflanzen (unbedingt einplanen): ${lieblingsList}` : ''}${budget ? `\n- Budget: maximal ${budget} € Gesamtkosten` : ''}${nutzungList ? `\n- Gartennutzung/Schwerpunkt: ${nutzungList}` : ''}${pflegezeit ? `\n- Gewünschte Pflegeintensität: ${pflegezeit}` : ''}

Empfehle 10–15 geeignete, winterharte Stauden. Berechne Stückzahlen für ${gartenflaeche} m².
Plane IMMER auch 3–4 schnellwüchsige Füllstauden oder Bodendecker ein (z.B. Storchschnabel, Katzenminze, Frauenmantel, Elfenblume, Immergrün), die freie Flächen zwischen Hauptstauden schließen. Diese sollen einen Großteil der Fläche bedecken.
${lieblingsList ? 'Die genannten Lieblingspflanzen MÜSSEN im Plan enthalten sein.' : ''}${budget ? ` Halte die Gesamtkosten unter ${budget} €.` : ''}
${kandidaten.length > 0 ? 'Wähle primär aus der bereitgestellten Pflanzenliste.' : ''}

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
    "stueckzahl": 0,
    "preis_stueck_eur": 0.00,
    "kauflink": "https://www.amazon.de/s?k=...&tag=gartenbaukosten-21"
  }],
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

    // Bilder aus DB anreichern
    if (Array.isArray(plan.pflanzen)) {
      plan.pflanzen = plan.pflanzen.map(p => {
        const genus = p.name_botanisch.split(' ')[0];
        const dbP = db.prepare(
          'SELECT bild_url FROM pflanzen WHERE name_botanisch = ? OR name_botanisch LIKE ? LIMIT 1'
        ).get(p.name_botanisch, `${genus}%`);
        return { ...p, bild_url: dbP?.bild_url || null };
      });
    }

    res.json({ success: true, plan, rag: { kandidaten: kandidaten.length, wissen: wissen.length } });
  } catch (err) {
    console.error('OpenAI Fehler:', err.message);
    res.status(500).json({ error: 'Fehler bei der KI-Planung. Bitte versuche es erneut.' });
  }
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
app.get('/api/pflanzen', (req, res) => {
  const q = (req.query.q || '').toLowerCase();
  let pflanzen = db.prepare(`
    SELECT name_deutsch, name_botanisch, licht, farbe, bluehzeit,
           hoehe_cm_min, hoehe_cm_max, stil, pflege_sterne, beschreibung
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
  res.json(pflanzen.slice(0, 40));
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
    <h2>5. Cookies</h2>
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

// ─── Pflanzenseiten (SEO) ─────────────────────────────────────────────────────

app.get('/pflanzen', (req, res) => {
  const pflanzen = db.prepare(`
    SELECT name_deutsch, name_botanisch, licht, bluehzeit, farbe,
           hoehe_cm_min, hoehe_cm_max, stil, bild_url, pflege_sterne, beschreibung
    FROM pflanzen ORDER BY name_deutsch
  `).all();

  const LICHT_FARBEN = { 'Sonne': '#f59e0b', 'Halbschatten': '#6366f1', 'Schatten': '#475569' };

  const cards = pflanzen.map(p => {
    const lichtKey = (p.licht || '').split('|')[0];
    const lichtFarbe = LICHT_FARBEN[lichtKey] || '#2d6a4f';
    const imgStyle = p.bild_url
      ? `background:url('${p.bild_url}') center/cover no-repeat`
      : `background:linear-gradient(135deg,#d8f3dc,#b7e4c7)`;
    return `
    <a href="/pflanze/${pflanzeToSlug(p.name_botanisch)}" style="display:flex;flex-direction:column;background:#fff;border-radius:14px;text-decoration:none;color:inherit;box-shadow:0 2px 12px rgba(0,0,0,.08);overflow:hidden;transition:transform .15s" onmouseover="this.style.transform='translateY(-3px)'" onmouseout="this.style.transform=''">
      <div style="${imgStyle};height:140px;position:relative">
        ${!p.bild_url ? '<div style="display:flex;align-items:center;justify-content:center;height:100%;font-size:3rem">🌿</div>' : ''}
        <div style="position:absolute;bottom:0;left:0;right:0;background:linear-gradient(transparent,rgba(0,0,0,.55));padding:8px 12px">
          <span style="background:${lichtFarbe};color:#fff;border-radius:4px;padding:2px 8px;font-size:.68rem;font-weight:700">${lichtKey}</span>
        </div>
      </div>
      <div style="padding:14px">
        <div style="font-weight:700;font-size:.92rem;color:#1b4332;margin-bottom:2px">${p.name_deutsch}</div>
        <div style="font-size:.73rem;font-style:italic;color:#aaa;margin-bottom:8px">${p.name_botanisch}</div>
        <div style="display:flex;flex-wrap:wrap;gap:4px">
          ${p.farbe ? `<span style="background:#f0fdf4;color:#2d6a4f;border-radius:4px;padding:1px 7px;font-size:.7rem">${p.farbe.split('|')[0]}</span>` : ''}
          ${p.bluehzeit ? `<span style="background:#fef3c7;color:#92400e;border-radius:4px;padding:1px 7px;font-size:.7rem">${p.bluehzeit}</span>` : ''}
        </div>
      </div>
    </a>`;
  }).join('');

  res.send(`<!DOCTYPE html><html lang="de"><head>
  <meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Stauden-Lexikon — ${pflanzen.length} winterharte Gartenstauden | Staudenplan.de</title>
  <meta name="description" content="Stauden-Lexikon mit ${pflanzen.length} winterharten Gartenstauden: Fotos, Standortanforderungen, Blühzeiten, Pflegetipps und Kaufmöglichkeiten — alle kostenlos.">
  <style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:'Segoe UI',system-ui,sans-serif;background:#f8f4ef;color:#1a1a1a}</style>
  </head><body>
  ${NAV_LINKS}
  <!-- Hero -->
  <div style="background:linear-gradient(160deg,#1b4332 0%,#2d6a4f 55%,#52b788 100%);color:#fff;padding:52px 24px;text-align:center">
    <h1 style="font-size:2rem;font-weight:800;margin-bottom:10px">Stauden-Lexikon</h1>
    <p style="opacity:.85;max-width:540px;margin:0 auto 28px;font-size:1rem;line-height:1.6">${pflanzen.length} winterharte Gartenstauden für Deutschland — mit Fotos, Standortanforderungen, Blühzeiten und direktem Kauflink</p>
    <div style="max-width:520px;margin:0 auto;position:relative">
      <input type="text" id="search" placeholder="Pflanze suchen… Storchschnabel, Hosta, Salvia…"
        style="width:100%;padding:14px 20px 14px 44px;border-radius:50px;border:none;font-size:.95rem;box-shadow:0 4px 20px rgba(0,0,0,.2)"
        oninput="filter(this.value)">
      <span style="position:absolute;left:16px;top:50%;transform:translateY(-50%);font-size:1.1rem">🔍</span>
    </div>
    <div style="margin-top:16px;display:flex;gap:8px;justify-content:center;flex-wrap:wrap">
      <button onclick="filterLicht('Sonne')" style="background:rgba(255,255,255,.2);color:#fff;border:none;border-radius:20px;padding:5px 14px;font-size:.78rem;cursor:pointer;font-family:inherit">☀️ Sonne</button>
      <button onclick="filterLicht('Halbschatten')" style="background:rgba(255,255,255,.2);color:#fff;border:none;border-radius:20px;padding:5px 14px;font-size:.78rem;cursor:pointer;font-family:inherit">🌤️ Halbschatten</button>
      <button onclick="filterLicht('Schatten')" style="background:rgba(255,255,255,.2);color:#fff;border:none;border-radius:20px;padding:5px 14px;font-size:.78rem;cursor:pointer;font-family:inherit">🌥️ Schatten</button>
      <button onclick="filter('')" style="background:rgba(255,255,255,.15);color:#fff;border:none;border-radius:20px;padding:5px 14px;font-size:.78rem;cursor:pointer;font-family:inherit">✕ Alle</button>
    </div>
  </div>
  <!-- Grid -->
  <main style="max-width:1200px;margin:0 auto;padding:32px 20px 60px">
    <p style="font-size:.82rem;color:#aaa;margin-bottom:20px" id="count-label">${pflanzen.length} Stauden</p>
    <div id="grid" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:14px">${cards}</div>
  </main>
  ${SITE_FOOTER}
  <script>
    const allCards = Array.from(document.querySelectorAll('#grid a'));
    function filter(q) {
      q = q.toLowerCase();
      let n=0;
      allCards.forEach(c => { const show = !q || c.textContent.toLowerCase().includes(q); c.style.display=show?'':'none'; if(show)n++; });
      document.getElementById('count-label').textContent = n + ' Stauden';
    }
    function filterLicht(licht) {
      let n=0;
      allCards.forEach(c => { const show = c.textContent.includes(licht); c.style.display=show?'':'none'; if(show)n++; });
      document.getElementById('count-label').textContent = n + ' Stauden (' + licht + ')';
    }
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
  const schemaOrg = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "Product",
    "name": pflanze.name_deutsch,
    "description": pflanze.beschreibung || '',
    "offers": { "@type": "Offer", "priceCurrency": "EUR", "price": pflanze.preis_stueck_eur || 0 }
  });

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
  <meta property="og:image" content="${pflanze.bild_url || ''}">
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
          <a href="/?pflanze=${encodeURIComponent(pflanze.name_botanisch)}&pname=${encodeURIComponent(pflanze.name_deutsch)}" style="background:#2d6a4f;color:#fff;border-radius:50px;padding:13px 28px;text-decoration:none;font-weight:700;font-size:.9rem">In Plan aufnehmen →</a>
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
    ${d.kombinationen && d.kombinationen.length > 0 ? `
    <section style="background:#fff;border-radius:14px;padding:24px;box-shadow:0 2px 12px rgba(0,0,0,.07);margin-bottom:24px">
      <h2 style="font-size:1.15rem;color:#1b4332;margin-bottom:16px;font-weight:700">🌸 Ideale Kombinationspartner</h2>
      <div style="display:flex;flex-direction:column;gap:10px">
        ${d.kombinationen.map(k => `
          <a href="/pflanze/${pflanzeToSlug(k.name_botanisch)}" style="display:flex;gap:14px;align-items:center;background:#f8f4ef;border-radius:10px;padding:12px 16px;text-decoration:none;color:inherit;transition:background .12s" onmouseover="this.style.background='#d8f3dc'" onmouseout="this.style.background='#f8f4ef'">
            <span style="font-size:1.5rem;flex-shrink:0">🌿</span>
            <div>
              <div style="font-weight:700;font-size:.92rem;color:#1b4332">${k.name_deutsch} <span style="font-style:italic;color:#aaa;font-weight:400;font-size:.8rem">${k.name_botanisch}</span></div>
              <div style="font-size:.82rem;color:#555;margin-top:2px">${k.grund}</div>
            </div>
            <span style="margin-left:auto;color:#2d6a4f;font-size:.8rem;font-weight:600;white-space:nowrap">Ansehen →</span>
          </a>`).join('')}
      </div>
    </section>` : ''}

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

const NAV_LINKS = `<nav style="background:#1b4332;padding:14px 24px;display:flex;align-items:center;gap:14px;position:sticky;top:0;z-index:50">
  <a href="/" style="color:#fff;text-decoration:none;font-weight:700;font-size:1rem;margin-right:auto">🌿 Staudenplan.de</a>
  <a href="/" style="color:rgba(255,255,255,.8);text-decoration:none;font-size:.88rem">Planer</a>
  <a href="/pflanzen" style="color:rgba(255,255,255,.8);text-decoration:none;font-size:.88rem">Stauden</a>
  <a href="/ratgeber" style="color:#fff;text-decoration:none;font-size:.88rem;font-weight:600">Ratgeber</a>
</nav>`;

const SITE_FOOTER = `<footer style="background:#1b4332;color:rgba(255,255,255,.7);padding:32px 24px;text-align:center;font-size:.82rem">
  <p style="margin-bottom:8px">© 2025 Staudenplan.de · <a href="/impressum" style="color:rgba(255,255,255,.6)">Impressum</a> · <a href="/datenschutz" style="color:rgba(255,255,255,.6)">Datenschutz</a> · <a href="https://www.gartenschmiede.de" style="color:rgba(255,255,255,.6)" target="_blank">Gartenschmiede GmbH</a></p>
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

  // Absätze mit Pull-Quote auf zweitem Absatz
  const absaetzeRaw = artikel.inhalt.split('\n').filter(l => l.trim());
  const absaetze = absaetzeRaw.map((t, i) => {
    if (i === 0) return `<p style="font-size:1.08rem;line-height:1.8;color:#222;margin-bottom:20px;font-weight:400">${t}</p>`;
    if (i === 1) return `<blockquote style="border-left:4px solid #52b788;background:#f0fdf4;border-radius:0 10px 10px 0;padding:18px 20px;margin:28px 0;font-size:1rem;line-height:1.7;color:#1b4332;font-style:italic">${t}</blockquote>`;
    return `<p style="margin-bottom:18px;line-height:1.78;font-size:.97rem;color:#333">${t}</p>`;
  }).join('\n');

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
  const pflanzenN  = db.prepare('SELECT COUNT(*) as n FROM pflanzen').get().n;
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

app.listen(PORT, () => {
  const pflanzenN = db.prepare('SELECT COUNT(*) as n FROM pflanzen').get().n;
  let wissenN = 0;
  try { wissenN = db.prepare('SELECT COUNT(*) as n FROM wissen').get().n; } catch {}
  console.log(`Stauden-Portal läuft auf http://localhost:${PORT}`);
  console.log(`Datenbank: ${pflanzenN} Pflanzen, ${wissenN} Wissens-Einträge`);
});
