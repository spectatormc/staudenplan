require('dotenv').config();
const express = require('express');
const Database = require('better-sqlite3');
const nodemailer = require('nodemailer');
const rateLimit = require('express-rate-limit');
const { OpenAI } = require('openai');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// www-Redirect: staudenplan.de → www.staudenplan.de (301)
app.use((req, res, next) => {
  if (req.hostname === 'staudenplan.de') {
    return res.redirect(301, 'https://www.staudenplan.de' + req.url);
  }
  next();
});

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

  <!-- Beispiele Teaser -->
  <section class="seo-beispiele">
    <div class="seo-section-inner">
      <div class="seo-section-header">
        <h2>Fertige Beet-Beispiele mit Pflanznamen</h2>
        <a href="/beispiele" class="seo-mehr-link">Alle 8 Beispiele →</a>
      </div>
      <div class="seo-beispiele-grid">
        <a href="/beispiel/schattenbeet" class="seo-beispiel-card">
          <div class="sbc-icon" style="background:linear-gradient(135deg,#1b4332,#2d6a4f)">🌿</div>
          <div class="sbc-body"><div class="sbc-titel">Schattenbeet</div><div class="sbc-sub">Halbschatten · 6 m²</div></div>
          <div class="sbc-arrow">→</div>
        </a>
        <a href="/beispiel/sonnenbeet" class="seo-beispiel-card">
          <div class="sbc-icon" style="background:linear-gradient(135deg,#92400e,#d97706)">☀️</div>
          <div class="sbc-body"><div class="sbc-titel">Sonnenbeet</div><div class="sbc-sub">Vollsonne · 8 m²</div></div>
          <div class="sbc-arrow">→</div>
        </a>
        <a href="/beispiel/kiesgarten" class="seo-beispiel-card">
          <div class="sbc-icon" style="background:linear-gradient(135deg,#78350f,#b45309)">🪨</div>
          <div class="sbc-body"><div class="sbc-titel">Kiesgarten</div><div class="sbc-sub">Trocken · 10 m²</div></div>
          <div class="sbc-arrow">→</div>
        </a>
        <a href="/beispiel/naturgarten" class="seo-beispiel-card">
          <div class="sbc-icon" style="background:linear-gradient(135deg,#14532d,#16a34a)">🌾</div>
          <div class="sbc-body"><div class="sbc-titel">Naturgarten</div><div class="sbc-sub">Naturnah · 12 m²</div></div>
          <div class="sbc-arrow">→</div>
        </a>
        <a href="/beispiel/teichrand" class="seo-beispiel-card">
          <div class="sbc-icon" style="background:linear-gradient(135deg,#0c4a6e,#0284c7)">💧</div>
          <div class="sbc-body"><div class="sbc-titel">Teichrand</div><div class="sbc-sub">Feucht/nass · 4 m²</div></div>
          <div class="sbc-arrow">→</div>
        </a>
        <a href="/beispiel/nordseite" class="seo-beispiel-card">
          <div class="sbc-icon" style="background:linear-gradient(135deg,#1e3a5f,#2563eb)">🏠</div>
          <div class="sbc-body"><div class="sbc-titel">Nordseite</div><div class="sbc-sub">Dauerschatten · 5 m²</div></div>
          <div class="sbc-arrow">→</div>
        </a>
        <a href="/beispiel/cottage-garten" class="seo-beispiel-card">
          <div class="sbc-icon" style="background:linear-gradient(135deg,#6d1b47,#c2587e)">🌸</div>
          <div class="sbc-body"><div class="sbc-titel">Cottage-Garten</div><div class="sbc-sub">Romantisch · 8 m²</div></div>
          <div class="sbc-arrow">→</div>
        </a>
        <a href="/beispiel/vorgarten" class="seo-beispiel-card">
          <div class="sbc-icon" style="background:linear-gradient(135deg,#2d5016,#52b788)">🏡</div>
          <div class="sbc-body"><div class="sbc-titel">Vorgarten</div><div class="sbc-sub">Repräsentativ · 6 m²</div></div>
          <div class="sbc-arrow">→</div>
        </a>
      </div>
    </div>
  </section>

  <!-- Quiz Teaser -->
  <section class="seo-quiz-teaser">
    <div class="seo-section-inner">
      <div class="quiz-teaser-inner">
        <div class="quiz-teaser-left">
          <div class="quiz-teaser-icon">🧠</div>
          <h2>Teste dein Staudenwissen</h2>
          <p>Kannst du Stauden am Bild erkennen? Oder willst du herausfinden, welcher Gartentyp du bist? Unser Quiz macht den Test – kostenlos und in 2 Minuten.</p>
          <div class="quiz-teaser-badges">
            <span>🌿 Wissenstest</span>
            <span>🌸 Gartentyp-Quiz</span>
          </div>
          <a href="/quiz" class="quiz-teaser-btn">Quiz starten →</a>
        </div>
        <div class="quiz-teaser-right">
          <div class="quiz-preview-card">
            <div class="qp-label">Wie heißt diese Staude?</div>
            <div class="qp-options">
              <div class="qp-opt qp-richtig">✓ Echinacea purpurea</div>
              <div class="qp-opt">Rudbeckia fulgida</div>
              <div class="qp-opt">Salvia nemorosa</div>
              <div class="qp-opt">Monarda didyma</div>
            </div>
          </div>
        </div>
      </div>
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
          <li><a href="/beispiele">🌿 Beet-Beispiele</a></li>
          <li><a href="/quiz">🧠 Stauden-Quiz</a></li>
          <li><a href="/pflanzen">Stauden-Lexikon</a></li>
          <li><a href="/ratgeber">Garten-Ratgeber</a></li>
          <li><a href="/ratgeber/bepflanzungsplan-garten-kostenlos-erstellen-so-geht-s">Plan selbst erstellen</a></li>
          <li><a href="/ratgeber/stauden-kaufen-worauf-beim-kauf-achten">Stauden kaufen</a></li>
        </ul>
      </div>
    </div>
    <div class="seo-footer-bottom">
      <p>© 2025 Staudenplan.de · Betrieben von <a href="https://www.freisinger-gartenschmiede.de" style="color:rgba(255,255,255,.6)" target="_blank">Gartenschmiede GmbH</a> · <a href="/impressum" style="color:rgba(255,255,255,.6)">Impressum</a> · <a href="/datenschutz" style="color:rgba(255,255,255,.6)">Datenschutz</a> · <a href="/impressum#haftung" style="color:rgba(255,255,255,.6)">Haftungsausschluss</a></p>
      <p style="margin-top:6px;font-size:.75rem;opacity:.7">Alle Bepflanzungspläne sind unverbindliche KI-Empfehlungen und ersetzen keine professionelle Gartenberatung.</p>
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
.seo-beispiele { background:#f0fdf4; padding:48px 20px; }
.seo-beispiele-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(220px,1fr)); gap:10px; }
.seo-beispiel-card { display:flex; align-items:center; gap:12px; background:#fff; border-radius:12px; padding:12px 14px; text-decoration:none; color:inherit; box-shadow:0 2px 8px rgba(0,0,0,.07); transition:transform .12s,box-shadow .12s; }
.seo-beispiel-card:hover { transform:translateY(-2px); box-shadow:0 4px 16px rgba(0,0,0,.12); }
.sbc-icon { width:42px; height:42px; border-radius:10px; display:flex; align-items:center; justify-content:center; font-size:1.25rem; flex-shrink:0; }
.sbc-body { flex:1; min-width:0; }
.sbc-titel { font-weight:700; font-size:.9rem; color:#1b4332; }
.sbc-sub { font-size:.75rem; color:#888; margin-top:1px; }
.sbc-arrow { color:#52b788; font-weight:700; font-size:1rem; flex-shrink:0; }
.seo-quiz-teaser { background:linear-gradient(135deg, #1b4332 0%, #2d6a4f 60%, #40916c 100%); padding:56px 20px; }
.quiz-teaser-inner { max-width:960px; margin:0 auto; display:grid; grid-template-columns:1fr 1fr; gap:48px; align-items:center; }
.quiz-teaser-left .quiz-teaser-icon { font-size:2.8rem; margin-bottom:12px; }
.quiz-teaser-left h2 { font-size:1.6rem; color:#fff; font-weight:800; margin-bottom:12px; line-height:1.25; }
.quiz-teaser-left p { color:rgba(255,255,255,.85); font-size:.95rem; line-height:1.65; margin-bottom:18px; }
.quiz-teaser-badges { display:flex; gap:10px; flex-wrap:wrap; margin-bottom:24px; }
.quiz-teaser-badges span { background:rgba(255,255,255,.15); color:#fff; border-radius:20px; padding:5px 14px; font-size:.8rem; font-weight:600; }
.quiz-teaser-btn { display:inline-block; padding:14px 32px; background:#fff; color:#1b4332; border-radius:30px; font-weight:800; text-decoration:none; font-size:1rem; transition:transform .15s,box-shadow .15s; box-shadow:0 4px 16px rgba(0,0,0,.15); }
.quiz-teaser-btn:hover { transform:translateY(-2px); box-shadow:0 8px 24px rgba(0,0,0,.2); }
.quiz-preview-card { background:rgba(255,255,255,.95); border-radius:14px; padding:22px; box-shadow:0 8px 32px rgba(0,0,0,.2); }
.qp-label { font-size:.9rem; font-weight:700; color:#1b4332; margin-bottom:14px; text-align:center; }
.qp-options { display:flex; flex-direction:column; gap:8px; }
.qp-opt { padding:11px 14px; border-radius:8px; border:2px solid #d0e8d8; background:#f0faf3; font-size:.85rem; font-weight:600; color:#1b4332; }
.qp-richtig { background:#d4edda; border-color:#28a745; color:#155724; }
@media(max-width:720px) {
  .quiz-teaser-inner { grid-template-columns:1fr; gap:28px; }
  .quiz-teaser-right { display:none; }
}
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
    `<url><loc>${base}/beispiele</loc><changefreq>monthly</changefreq><priority>0.9</priority></url>`,
    `<url><loc>${base}/quiz</loc><changefreq>monthly</changefreq><priority>0.8</priority></url>`,
    ...BEISPIELE.map(b => `<url><loc>${base}/beispiel/${b.slug}</loc><changefreq>monthly</changefreq><priority>0.8</priority></url>`),
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
  <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🌿</text></svg>">
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
    <h2 id="haftung">Haftungsausschluss</h2>
    <h3>1. Allgemeine Inhalte</h3>
    <p>Die Inhalte dieser Website wurden mit größtmöglicher Sorgfalt erstellt. Für die Richtigkeit, Vollständigkeit und Aktualität der Inhalte können wir jedoch keine Gewähr übernehmen. Als Diensteanbieter sind wir gemäß § 7 Abs. 1 TMG für eigene Inhalte auf diesen Seiten nach den allgemeinen Gesetzen verantwortlich.</p>
    <h3>2. KI-generierte Bepflanzungspläne</h3>
    <p>Die auf Staudenplan.de erstellten Bepflanzungspläne werden mithilfe künstlicher Intelligenz (KI) generiert und stellen <strong>ausdrücklich keine professionelle Gartenberatung</strong> dar. Die Pläne sind als unverbindliche Anregung und Entscheidungshilfe zu verstehen.</p>
    <p>Wir übernehmen keinerlei Haftung für:</p>
    <ul>
      <li>Pflanzenverluste oder -schäden, die auf Basis unserer Empfehlungen entstehen</li>
      <li>Planungsfehler durch falsch eingegebene Standortdaten</li>
      <li>Abweichungen zwischen empfohlenen und tatsächlich erhältlichen Pflanzensorten</li>
      <li>Nicht berücksichtigte Mikroklimata, Bodenverhältnisse oder lokale Besonderheiten</li>
      <li>Fehler oder Ungenauigkeiten in den KI-generierten Pflanzbeschreibungen</li>
    </ul>
    <p>Vor größeren Pflanzinvestitionen empfehlen wir ausdrücklich die Rücksprache mit einem qualifizierten Fachbetrieb oder Gartengestalter, der die spezifischen Bedingungen vor Ort beurteilen kann.</p>
    <h3>3. Pflanzinformationen und Ratgeber-Inhalte</h3>
    <p>Alle Pflanzbeschreibungen, Wuchshöhen, Standortangaben und Pflegehinweise sind Richtwerte. Tatsächliche Werte können je nach Standort, Klima, Bodenzustand und Pflanzenpflege erheblich abweichen. Insbesondere Angaben zur Winterhärte beziehen sich auf Durchschnittswerte für deutsche Klimazonen — örtliche Frosteinbrüche oder besondere Witterungsereignisse können die Winterhärte einzelner Pflanzen beeinflussen.</p>
    <h3>4. Externe Links</h3>
    <p>Diese Website enthält Links zu externen Websites Dritter, auf deren Inhalte wir keinen Einfluss haben. Für die Inhalte der verlinkten Seiten ist stets der jeweilige Anbieter verantwortlich. Eine permanente inhaltliche Kontrolle der verlinkten Seiten ist ohne konkrete Anhaltspunkte einer Rechtsverletzung nicht zumutbar.</p>
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


// ─── Admin-Übersicht ─────────────────────────────────────────────────────────

app.get('/admin', (req, res) => {
  if (req.query.key !== 'preview2026') return res.status(403).send('<h2>403</h2>');

  // ── Stats ──
  const stats = {
    live:    db.prepare("SELECT COUNT(*) as n FROM pflanzen WHERE status='live' OR status IS NULL").get().n,
    staging: db.prepare("SELECT COUNT(*) as n FROM pflanzen WHERE status='staging'").get().n,
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
    const kiTag = info.ki ? `<span class="tag" style="background:#e8d5ff;color:#5b2d8e">✦ KI</span>` : `<span class="tag tag-${p.status||'live'}">${p.status||'live'}</span>`;
    return `<div class="card" id="card-${p.id}">
      <div class="card-head"><strong>${p.name_deutsch}</strong>${kiTag}</div>
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
      <button class="btn-pruefen" id="bp-${p.id}" onclick="kiVorschlagErstellen(${p.id},this)">KI-Bild erstellen</button>
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
    <span class="chip ${stats.staging>0?'warn':''}">${stats.staging} offline</span>
    ${vorschlaege.length>0?`<span class="chip warn">${vorschlaege.length} zur Bildprüfung</span>`:''}
  </div>
</div>

<div class="tabs">
  <div class="tab active" onclick="showTab('pruefung',this)">Bildprüfung <span class="badge orange" id="b-pruefung">${vorschlaege.length}</span></div>
  <div class="tab" onclick="showTab('live',this)">Live Pflanzen <span class="badge" id="b-live">${livePflanzen.length}</span></div>
  <div class="tab" onclick="showTab('vorlagen',this)">✨ Vorlagen</div>
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

  <!-- Tab 2: Live Pflanzen -->
  <div class="pane" id="pane-live">
    <div class="toolbar">
      <span class="toolbar-meta">${livePflanzen.length} Live-Pflanzen · "KI-Bild erstellen" generiert einen neuen Vorschlag — erscheint dann in der Bildprüfung</span>
    </div>
    <input type="text" id="live-search" placeholder="Pflanze suchen…" oninput="filterLive(this.value)"
      style="width:100%;max-width:360px;padding:9px 14px;border:1.5px solid #ddd;border-radius:8px;font-size:.9rem;margin-bottom:16px;display:block">
    <div class="st-list" id="live-list">${liveRows}</div>
  </div>

  <!-- Tab 5: Vorlagen -->
  <div class="pane" id="pane-vorlagen">
    <div style="max-width:760px">

      <!-- KI-Generator -->
      <div style="background:#fff;border-radius:12px;box-shadow:0 1px 8px rgba(0,0,0,.09);padding:22px;margin-bottom:24px;border:2px solid #52b788">
        <h2 style="margin:0 0 6px;font-size:1rem;color:#1b4332">✨ KI-Antwort für konkrete Frage generieren</h2>
        <p style="margin:0 0 12px;font-size:.83rem;color:#888">Frage aus Google Alert / Facebook / Forum einfügen — KI schreibt eine authentische Gärtner-Antwort mit Link:</p>
        <textarea id="fragenInput" placeholder="z.B. 'Hallo, ich habe ein schattiges Beet unter einer alten Birke, ca. 3m² — was kann ich da pflanzen?'" style="width:100%;min-height:80px;border:1.5px solid #b7dfc7;border-radius:8px;padding:10px 12px;font-size:.9rem;font-family:inherit;resize:vertical;box-sizing:border-box"></textarea>
        <div style="display:flex;gap:10px;margin-top:10px;align-items:center">
          <button onclick="generiereAntwort()" id="genBtn" style="background:#1b4332;color:#fff;border:none;border-radius:8px;padding:10px 22px;cursor:pointer;font-weight:700;font-size:.92rem">✨ Generieren</button>
          <span style="font-size:.78rem;color:#aaa">Strg+Enter</span>
          <span id="genStatus" style="font-size:.83rem;color:#888;margin-left:4px"></span>
        </div>
        <div id="genResult" style="display:none;margin-top:16px">
          <div style="font-size:.78rem;color:#666;margin-bottom:5px;font-weight:600">Antwort — vor dem Posten kurz prüfen:</div>
          <textarea id="genText" style="width:100%;min-height:150px;border:1.5px solid #b7dfc7;border-radius:8px;padding:10px 12px;font-size:.88rem;line-height:1.65;font-family:inherit;resize:vertical;box-sizing:border-box;background:#f8fffe"></textarea>
          <div style="display:flex;gap:8px;margin-top:8px">
            <button onclick="kopierenGen()" style="background:#2d6a4f;color:#fff;border:none;border-radius:7px;padding:8px 18px;cursor:pointer;font-weight:600;font-size:.88rem;flex:1">📋 Kopieren</button>
            <button onclick="generiereAntwort()" style="background:#f0ede8;color:#555;border:none;border-radius:7px;padding:8px 14px;cursor:pointer;font-size:.82rem">↻ Neu</button>
          </div>
          <div id="genOk" style="display:none;color:#2d6a4f;font-size:.82rem;margin-top:6px;font-weight:600">✓ Kopiert!</div>
        </div>
      </div>

      <!-- Trennlinie -->
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:22px">
        <div style="flex:1;height:1px;background:#e0dbd4"></div>
        <span style="font-size:.78rem;color:#aaa;font-weight:600">FERTIGE VORLAGEN</span>
        <div style="flex:1;height:1px;background:#e0dbd4"></div>
      </div>

      <!-- Template Cards -->
      ${[
        { kategorie:'Schattenbeet', emoji:'🌿', farbe:'#2d6a4f', fragen:['Was soll ich ins Schattenbeet pflanzen?','Welche Stauden für den Schatten?','Nordseite bepflanzen'],
          vorlage:`Für ein klassisches Schattenbeet funktioniert die Kombination aus Hosta (Funkie), Farn und Astilbe seit Generationen zuverlässig. Hosta liefert die Blattstruktur, der Farn die Leichtigkeit und die Astilbe blüht im Hochsommer auch bei wenig Licht. Actaea simplex (Silberkerze) kommt noch dazu für den Herbst.

Ich habe dafür einen kostenlosen KI-Bepflanzungsplan erstellt bekommen – sehr praktisch wenn man Abstände und Stückzahlen ausrechnen möchte: https://www.staudenplan.de`},
        { kategorie:'Trockenes Sonnenbeet', emoji:'☀️', farbe:'#b5451b', fragen:['Pflanzen für trockenen Boden','Kiesgarten bepflanzen','Mediterrane Pflanzen'],
          vorlage:`Für trockene, sonnige Standorte sind Lavendel, Stachys byzantina (Wollziest), Sedum (Fetthenne) und Salvia nemorosa (Gartensalbei) unschlagbar. Die kommen auch mit Hitze klar und brauchen kaum Wasser.

Als ich meinen Kiesgarten geplant habe, hat mir dieser kostenlose KI-Planer sehr geholfen – einfach Standort und Größe eingeben: https://www.staudenplan.de`},
        { kategorie:'Anfänger / pflegeleicht', emoji:'🌱', farbe:'#52b788', fragen:['Pflegeleichte Stauden für Anfänger','Welche Pflanzen machen keine Arbeit?'],
          vorlage:`Für Anfänger empfehle ich robuste Stauden: Rudbeckia (Sonnenhut), Geranium (Storchschnabel), Salvia nemorosa und Stachys. Die kommen alle mit normalen Böden klar, brauchen kein Düngen und breiten sich angenehm aus ohne invasiv zu werden.

Zum Planen gibt es einen kostenlosen KI-Gartenplaner, der auch gleich die Stückzahlen berechnet: https://www.staudenplan.de`},
        { kategorie:'Teich / Feuchtbeet', emoji:'💧', farbe:'#1d6995', fragen:['Teichrand bepflanzen','Pflanzen für feuchten Boden'],
          vorlage:`Am Teichrand funktioniert eine Zonierung am besten: direkt am Wasser Iris pseudacorus und Pontederia cordata. Im feuchten Übergangsbereich dann Lythrum salicaria (Blutweiderich) und Filipendula ulmaria (Mädesüß) – der duftet im Sommer herrlich.

Ich habe das mit einem kostenlosen KI-Tool geplant: https://www.staudenplan.de/ratgeber/teichrand-und-feuchtbeet-gestaltung-am-wasser`},
        { kategorie:'Bienen / Insekten', emoji:'🐝', farbe:'#d4a017', fragen:['Bienenfreundliche Pflanzen','Insektenwildgarten anlegen'],
          vorlage:`Für Bienen und Insekten sind heimische Stauden am besten: Agastache, Echinacea (Sonnenhut), Salvia, Origanum und Verbena bonariensis. Die blühen gestaffelt von Mai bis Oktober und werden regelrecht belagert.

Für einen kompletten Bepflanzungsplan: https://www.staudenplan.de`},
        { kategorie:'Staudenbeet planen', emoji:'📋', farbe:'#4a4e69', fragen:['Wie plane ich ein Staudenbeet?','Bepflanzungsplan erstellen'],
          vorlage:`Ich würde als erstes Standort und Bodenverhältnisse klären (Sonne/Schatten, trocken/feucht) bevor ich Pflanzen aussuche. Das klingt trivial macht aber einen riesigen Unterschied.

Für die konkrete Planung mit Pflanzliste, Abständen und Stückzahlen nutze ich diesen kostenlosen KI-Gartenplaner: https://www.staudenplan.de`},
      ].map((t,i) => `
        <div style="background:#fff;border-radius:12px;box-shadow:0 1px 8px rgba(0,0,0,.07);overflow:hidden;margin-bottom:16px">
          <div style="background:${t.farbe};padding:12px 16px;display:flex;align-items:center;gap:10px">
            <span style="font-size:1.3rem">${t.emoji}</span>
            <div>
              <div style="color:#fff;font-weight:700;font-size:.95rem">${t.kategorie}</div>
              <div style="color:rgba(255,255,255,.7);font-size:.75rem;margin-top:1px">${t.fragen.map(f=>`"${f}"`).join(' · ')}</div>
            </div>
          </div>
          <div style="padding:14px 16px">
            <textarea id="vtxt${i}" readonly style="width:100%;min-height:110px;border:1.5px solid #e0d9cf;border-radius:7px;padding:10px;font-size:.86rem;line-height:1.6;color:#333;resize:vertical;font-family:inherit;background:#fafaf8;box-sizing:border-box">${t.vorlage}</textarea>
            <div style="display:flex;gap:8px;margin-top:8px">
              <button onclick="kopierenV(${i})" style="background:${t.farbe};color:#fff;border:none;border-radius:7px;padding:7px 16px;cursor:pointer;font-weight:600;font-size:.85rem;flex:1">📋 Kopieren</button>
            </div>
            <div id="vok${i}" style="display:none;color:#2d6a4f;font-size:.8rem;margin-top:5px;font-weight:600">✓ Kopiert!</div>
          </div>
        </div>`).join('')}
    </div>
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

  // ── Live-Tab Suche ──
  function filterLive(q) {
    const term = q.toLowerCase();
    document.querySelectorAll('#live-list .st-row').forEach(row => {
      const text = row.textContent.toLowerCase();
      row.style.display = text.includes(term) ? '' : 'none';
    });
  }

  // ── Live: Neues KI-Bild als Vorschlag erstellen ──
  async function kiVorschlagErstellen(id, btn) {
    if (!confirm('Neues KI-Bild generieren? Dauert ca. 30 Sekunden. Das aktuelle Bild bleibt bis zur Freigabe aktiv.')) return;
    btn.innerHTML = '<span class=spinner></span>'; btn.disabled = true;
    const r = await fetch('/api/ki-bild-vorschlag/' + id, { method: 'POST' });
    if (r.ok) {
      btn.textContent = '⏳ Wird generiert…';
      setTimeout(() => {
        btn.textContent = '→ In Bildprüfung';
        btn.disabled = false;
        btn.onclick = () => document.querySelector('.tab[onclick*="pruefung"]').click();
      }, 35000);
    } else {
      btn.textContent = 'KI-Bild erstellen'; btn.disabled = false;
    }
  }

  // ── Vorlagen-Tab ──
  function kopierenV(i) {
    const txt = document.getElementById('vtxt'+i).value;
    navigator.clipboard.writeText(txt).then(()=>{
      const ok = document.getElementById('vok'+i);
      ok.style.display='block';
      setTimeout(()=>ok.style.display='none', 2500);
    }).catch(()=>{ document.getElementById('vtxt'+i).select(); document.execCommand('copy'); });
  }
  function kopierenGen() {
    const txt = document.getElementById('genText').value;
    navigator.clipboard.writeText(txt).then(()=>{
      const ok = document.getElementById('genOk');
      ok.style.display='block';
      setTimeout(()=>ok.style.display='none', 2500);
    }).catch(()=>{ document.getElementById('genText').select(); document.execCommand('copy'); });
  }
  async function generiereAntwort() {
    const frage = document.getElementById('fragenInput').value.trim();
    if (!frage) { alert('Bitte eine Frage eingeben.'); return; }
    const btn = document.getElementById('genBtn');
    const status = document.getElementById('genStatus');
    btn.disabled = true; btn.textContent = '⏳ …';
    status.textContent = 'KI arbeitet…';
    try {
      const resp = await fetch('/api/antwort-generieren?key=preview2026', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ frage })
      });
      const data = await resp.json();
      if (data.error) throw new Error(data.error);
      document.getElementById('genText').value = data.antwort;
      document.getElementById('genResult').style.display = 'block';
      document.getElementById('genResult').scrollIntoView({ behavior:'smooth', block:'nearest' });
      status.textContent = '';
    } catch(e) { status.textContent = 'Fehler: '+e.message; }
    btn.disabled=false; btn.textContent='✨ Generieren';
  }
  document.addEventListener('keydown', e => {
    if (e.key==='Enter' && e.ctrlKey && document.getElementById('pane-vorlagen').classList.contains('active'))
      generiereAntwort();
  });
</script>
</body></html>`);
});

// Neues KI-Bild für live Pflanze als Vorschlag generieren (Pflanze bleibt live)
app.post('/api/ki-bild-vorschlag/:id', (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) return res.status(400).json({ error: 'id fehlt' });
  const { spawn } = require('child_process');
  const child = spawn(process.execPath, [
    path.join(__dirname, 'scripts', 'generate-ki-bilder.js'),
    `--ids=${id}`, '--keep-live'
  ], { cwd: __dirname, detached: true, stdio: 'ignore' });
  child.unref();
  res.json({ ok: true });
});

// KI-Bild ablehnen (bild_ki bleibt 1, damit nicht nochmal vorgeschlagen wird)
app.post('/api/ki-bild-ablehnen/:id', (req, res) => {
  const id = parseInt(req.params.id);
  db.prepare("UPDATE pflanzen SET bild_vorschlag=NULL, bild_check_info=NULL WHERE id=?").run(id);
  res.json({ ok: true });
});

// KI-Bilder generieren im Hintergrund starten
app.post('/api/ki-bilder-starten', (req, res) => {
  const { spawn } = require('child_process');
  const child = spawn(process.execPath, [
    path.join(__dirname, 'scripts', 'generate-ki-bilder.js'), '--limit=10'
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
  <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🌿</text></svg>">
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
  const bildAbsolut = (pflanze.bild_url || '').startsWith('http')
    ? pflanze.bild_url
    : `https://www.staudenplan.de${pflanze.bild_url || '/images/og-default.jpg'}`;

  const additionalProps = [
    pflanze.bluehzeit  && { "@type": "PropertyValue", "name": "Blühzeit",      "value": pflanze.bluehzeit },
    pflanze.licht      && { "@type": "PropertyValue", "name": "Lichtbedarf",   "value": pflanze.licht },
    pflanze.feuchtigkeit && { "@type": "PropertyValue", "name": "Feuchtigkeit","value": pflanze.feuchtigkeit },
    pflanze.boden      && { "@type": "PropertyValue", "name": "Boden",         "value": pflanze.boden },
    hoehe !== '— cm'   && { "@type": "PropertyValue", "name": "Wuchshöhe",     "value": hoehe },
    pflanze.winterhart_zone && { "@type": "PropertyValue", "name": "Winterhärte", "value": `Zone ${pflanze.winterhart_zone}` },
  ].filter(Boolean);

  const schemaOrg = JSON.stringify([
    {
      "@context": "https://schema.org",
      "@type": "Product",
      "name": `${pflanze.name_deutsch} (${pflanze.name_botanisch})`,
      "description": pflanze.beschreibung || '',
      "image": bildAbsolut,
      "color": pflanze.farbe || undefined,
      "category": "Gartenstauden",
      "brand": { "@type": "Brand", "name": "Staudenplan.de" },
      "additionalProperty": additionalProps,
      "mpn": pflanze.name_botanisch,
      "offers": {
        "@type": "Offer",
        "priceCurrency": "EUR",
        "price": pflanze.preis_stueck_eur || 0,
        "availability": "https://schema.org/InStock",
        "url": `https://www.staudenplan.de/pflanze/${slug}`,
        "seller": { "@type": "Organization", "name": "Staudenplan.de" },
        "shippingDetails": {
          "@type": "OfferShippingDetails",
          "shippingRate": { "@type": "MonetaryAmount", "value": "4.95", "currency": "EUR" },
          "shippingDestination": { "@type": "DefinedRegion", "addressCountry": "DE" },
          "deliveryTime": {
            "@type": "ShippingDeliveryTime",
            "handlingTime": { "@type": "QuantitativeValue", "minValue": 1, "maxValue": 2, "unitCode": "DAY" },
            "transitTime": { "@type": "QuantitativeValue", "minValue": 2, "maxValue": 5, "unitCode": "DAY" }
          }
        },
        "hasMerchantReturnPolicy": {
          "@type": "MerchantReturnPolicy",
          "applicableCountry": "DE",
          "returnPolicyCategory": "https://schema.org/MerchantReturnFiniteReturnWindow",
          "merchantReturnDays": 14,
          "returnMethod": "https://schema.org/ReturnByMail",
          "returnFees": "https://schema.org/FreeReturn"
        }
      }
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
  <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🌿</text></svg>">
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
             <p style="font-size:.68rem;color:#bbb;margin-top:6px;text-align:right">${
               pflanze.bild_ki ? 'KI-generiert · OpenAI'
               : (pflanze.bild_lizenz || '').includes('Wikimedia') ? `Foto: ${pflanze.bild_lizenz}`
               : 'Foto: Pixabay'
             }</p>`
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
      let kombinationen = d.kombinationen;
      if (typeof kombinationen === 'string') { try { kombinationen = JSON.parse(kombinationen); } catch { kombinationen = []; } }
      if (!Array.isArray(kombinationen) || kombinationen.length === 0) return '';
      // Für jeden Partner passende DB-Pflanze suchen (Genus-Match als Fallback)
      const kombinationenMitLink = kombinationen.map(k => {
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
  <p style="margin-top:12px;font-size:.75rem;opacity:.5">Alle Bepflanzungspläne sind unverbindliche KI-Empfehlungen und ersetzen keine professionelle Gartenberatung. · <a href="/impressum#haftung" style="color:rgba(255,255,255,.5)">Haftungsausschluss</a></p>
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
  <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🌿</text></svg>">
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
  <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🌿</text></svg>">
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

// ─── Beispiele ────────────────────────────────────────────────────────────────

const BEISPIELE = [
  {
    slug: 'schattenbeet',
    title: 'Schattenbeet Beispiel',
    h1: 'Schattenbeet bepflanzen: Beispiel mit Pflanznamen',
    icon: '🌿',
    grad: 'linear-gradient(135deg,#1b4332,#2d6a4f)',
    flaeche: 6,
    licht: 'Halbschatten',
    feuchtigkeit: ['normal','feucht'],
    badge: 'Halbschatten · 6 m²',
    intro: 'Ein Schattenbeet muss kein tristes Loch sein. Mit den richtigen Stauden entsteht auch ohne direkte Sonne ein üppiges, grünes Beet mit Blüten von Frühjahr bis Herbst. Dieses Beispiel zeigt einen typischen Halbschattenstandort mit normalem Gartenboden — wie man ihn häufig an Hauswänden, unter Gehölzen oder an der Nordseite von Zäunen findet.',
    intro2: 'Die Auswahl kombiniert blühende Stauden mit dekorativen Blattschmuckpflanzen. So bleibt das Beet auch außerhalb der Blütezeit interessant. Alle Pflanzen sind winterhart und für Deutschland geeignet.',
    cta_params: '?licht=Halbschatten+%283%E2%80%936+h%29&standort=Schattenbeet+Halbschatten+normaler+Gartenboden',
    seo_text: 'Schattenbeet Beispiele mit Pflanzliste helfen dabei, den richtigen Pflanzplan für schwierige Standorte zu entwickeln. Beliebte Pflanzen für Halbschatten sind Funkie (Hosta), Astilbe, Storchschnabel, Waldgeißbart und Elfenblume (Epimedium).',
  },
  {
    slug: 'sonnenbeet',
    title: 'Sonnenbeet Beispiel',
    h1: 'Sonnenbeet bepflanzen: Beispiel mit Pflanznamen',
    icon: '☀️',
    grad: 'linear-gradient(135deg,#92400e,#d97706)',
    flaeche: 8,
    licht: 'Sonne',
    feuchtigkeit: ['normal'],
    badge: 'Vollsonne · 8 m²',
    intro: 'Ein klassisches Staudenbeet in der Sonne gehört zu den dankbarsten Gartenprojekten überhaupt. Mit den richtigen Pflanzen blüht es von Mai bis Oktober ohne Pause. Dieses Beispiel zeigt ein typisches Sonnenbeet mit normalem, humosem Boden — der häufigste Standort in deutschen Gärten.',
    intro2: 'Die Kombination aus Leitstauden, Begleitstauden und Füllern sorgt für ein lebendiges Beet mit gestaffelter Höhe und langer Blütezeit. Alle Pflanzen sind mehrjährig, winterhart und benötigen wenig Pflege.',
    cta_params: '?licht=Vollsonne+%286%2B+h%29&standort=Sonnenbeet+Vollsonne+normaler+humoser+Boden',
    seo_text: 'Sonnenbeet Beispiele mit konkreten Pflanzenlisten sind der beste Einstieg für eigene Beetplanung. Klassiker für sonnige Staudenbeete: Sonnenhut (Echinacea), Salbei (Salvia), Katzenminze (Nepeta), Schafgarbe (Achillea) und Phlox.',
  },
  {
    slug: 'kiesgarten',
    title: 'Kiesgarten Beispiel',
    h1: 'Kiesgarten bepflanzen: Beispiel mit Pflanznamen',
    icon: '🪨',
    grad: 'linear-gradient(135deg,#78350f,#b45309)',
    flaeche: 10,
    licht: 'Sonne',
    feuchtigkeit: ['trocken'],
    badge: 'Vollsonne · trocken · 10 m²',
    intro: 'Kiesgärten und Trockenstaudenbeete sind pflegeleicht, wassersparend und bieten im Hochsommer Farbe, wenn andere Beete bereits verblüht sind. Dieses Beispiel zeigt einen typischen Kiesgarten mit sandig-kiesigem Untergrund — ideal für mediterrane und steppenartige Pflanzen.',
    intro2: 'Die gewählten Stauden stammen aus trockenen Steppenregionen Europas und Asiens. Sie kommen mit wenig Wasser aus, locken Bienen und Schmetterlinge an und bilden auch im Winter attraktive Samenstände.',
    cta_params: '?licht=Vollsonne+%286%2B+h%29&boden=Sandig+%2F+durchl%C3%A4ssig&standort=Kiesgarten+Trockenbeet+Vollsonne+sehr+trocken',
    seo_text: 'Kiesgarten Bepflanzungsbeispiele zeigen, welche Stauden wirklich trockenheitsresistent sind. Bewährt im Kiesgarten: Lavendel, Ziersalbei, Steppen-Salbei, Schafgarbe, Blaustrahlhafer (Helictotrichon) und Katzenminze.',
  },
  {
    slug: 'naturgarten',
    title: 'Naturgarten Beispiel',
    h1: 'Naturgarten & Präriegarten: Beispiel mit Pflanznamen',
    icon: '🌾',
    grad: 'linear-gradient(135deg,#14532d,#16a34a)',
    flaeche: 12,
    licht: 'Sonne',
    feuchtigkeit: ['normal','feucht'],
    badge: 'Vollsonne · naturnah · 12 m²',
    intro: 'Ein naturnaher Garten mit Präriecharakter braucht wenig Pflege und bietet Bienen, Schmetterlingen und Vögeln Lebensraum das ganze Jahr. Dieses Beispiel kombiniert heimische Stauden mit naturnahen Gräsern für ein wildes, aber dennoch strukturiertes Beet.',
    intro2: 'Alle gewählten Pflanzen sind bienenfreundlich oder heimisch in Deutschland. Die Samenstände bleiben im Winter stehen — ein wichtiger Aspekt für Insekten und die Winteroptik des Gartens.',
    cta_params: '?licht=Vollsonne+%286%2B+h%29&stil=Natur%2FWildgarten&standort=Naturgarten+Präriecharakter+heimische+Stauden+Insektenparadies',
    seo_text: 'Naturgarten Beispiele mit heimischen Pflanzen sind besonders gefragt. Für naturnahe Beete eignen sich: Sonnenhut (Echinacea), Schafgarbe (Achillea millefolium), Storchschnabel (Geranium), Ziersalbei (Salvia nemorosa) und Chinaschilf (Miscanthus).',
  },
  {
    slug: 'teichrand',
    title: 'Teichrand Bepflanzung Beispiel',
    h1: 'Teichrand bepflanzen: Beispiel mit Pflanznamen',
    icon: '💧',
    grad: 'linear-gradient(135deg,#0c4a6e,#0284c7)',
    flaeche: 4,
    licht: 'Halbschatten',
    feuchtigkeit: ['nass','feucht'],
    badge: 'Teichrand · feucht/nass · 4 m²',
    intro: 'Der Teichrand ist ein besonders reizvoller Gartenbereich mit eigenem Charakter. Die richtige Bepflanzung verbindet Wasserpflanzen mit Uferpflanzen zu einem natürlichen Übergang. Dieses Beispiel zeigt eine typische Teichrandzone mit dauerhaft feuchtem bis nassem Boden.',
    intro2: 'Die gewählten Pflanzen kommen mit stehender Nässe und Wassernähe zurecht. Sie bilden einen fließenden Übergang vom Ufer zum Garten und bieten Fröschen, Libellen und Vögeln wichtigen Lebensraum.',
    cta_params: '?licht=Halbschatten+%283%E2%80%936+h%29&standort=Teichrand+Sumpfbeet+dauerhaft+feucht+nass',
    seo_text: 'Teichrand Bepflanzungsbeispiele mit Pflanzliste helfen bei der Auswahl der richtigen Ufer- und Feuchtigkeitspflanzen. Klassiker am Teichrand: Sumpfdotterblume (Caltha), Blutweiderich (Lythrum), Schilfgras, Iris (Sumpfschwertlilie) und Vergissmeinnicht.',
  },
  {
    slug: 'nordseite',
    title: 'Nordseite bepflanzen Beispiel',
    h1: 'Nordseite bepflanzen: Schattenbeet Beispiel',
    icon: '🏠',
    grad: 'linear-gradient(135deg,#1e3a5f,#2563eb)',
    flaeche: 5,
    licht: 'Schatten',
    feuchtigkeit: ['normal','feucht'],
    badge: 'Dauerschatten · 5 m²',
    intro: 'Die Nordseite des Hauses gilt als schwierigster Gartenstandort — kein direktes Sonnenlicht, oft feuchte Luft und wenig Wärme. Dennoch gibt es eine Reihe von Stauden, die dort nicht nur überleben, sondern richtig aufblühen. Dieses Beispiel zeigt eine typische Hausseite im Dauerschatten.',
    intro2: 'Blattschmuckpflanzen spielen hier eine große Rolle: Dunkles Laub, helle Blätter und ausgeprägte Texturen ersetzen das, was Blüten an der Südseite leisten. Einige dieser Pflanzen blühen sogar im tiefen Schatten.',
    cta_params: '?licht=Schatten+%28unter+3+h%29&standort=Nordseite+Gebäudeschatten+Dauerschatten+kühl+frisch',
    seo_text: 'Nordseite bepflanzen Beispiele zeigen, welche Stauden im Dauerschatten funktionieren. Robuste Schattenstauden: Funkie (Hosta), Waldgeißbart (Aruncus), Elfenblume (Epimedium), Maiglöckchen (Convallaria) und Farn.',
  },
  {
    slug: 'cottage-garten',
    title: 'Cottage-Garten Beispiel',
    h1: 'Cottage-Garten bepflanzen: Romantisches Staudenbeet',
    icon: '🌸',
    grad: 'linear-gradient(135deg,#6d1b47,#c2587e)',
    flaeche: 8,
    licht: 'Halbschatten',
    feuchtigkeit: ['normal'],
    badge: 'Romantisch · Halbschatten/Sonne · 8 m²',
    intro: 'Der Cottage-Stil steht für üppige, naturnahe Beete mit romantischem Charakter — viele Blütenfarben, weiche Formen und ein wenig kontrolliertes Chaos. Dieses Beispiel zeigt ein typisches Cottage-Garten-Beet in Pastelltönen mit Rosa, Lila und Weiß.',
    intro2: 'Die Auswahl vereint klassische Englische-Garten-Pflanzen mit robusten Stauden, die auch in Deutschland problemlos gedeihen. Duftende Stauden, Schmetterlingsmagnet-Pflanzen und lange Blütezeiten sind die Merkmale dieser Kombination.',
    cta_params: '?stil=Cottage%2FEnglisch&standort=Romantischer+Cottage-Garten+Pastelltöne+Rosa+Lila+Weiß',
    seo_text: 'Cottage-Garten Bepflanzungsbeispiele für romantische Staudenbeete. Typisch für den Cottage-Stil: Phlox, Rittersporn (Delphinium), Fingerhut (Digitalis), Malve (Malva), Frauenmantel (Alchemilla) und Glockenblume (Campanula).',
  },
  {
    slug: 'vorgarten',
    title: 'Vorgarten Bepflanzung Beispiel',
    h1: 'Vorgarten bepflanzen: Beispiel mit Pflanznamen',
    icon: '🏡',
    grad: 'linear-gradient(135deg,#2d5016,#52b788)',
    flaeche: 6,
    licht: 'Halbschatten',
    feuchtigkeit: ['normal'],
    badge: 'Vorgarten · Halbschatten · 6 m²',
    intro: 'Der Vorgarten ist die Visitenkarte des Hauses — er soll das ganze Jahr über ordentlich und ansprechend aussehen. Gleichzeitig muss er pflegeleicht sein, da Vorgärten oft wenig Zeit bekommen. Dieses Beispiel zeigt eine typische Vorgartensituation mit Halbschatten durch Straßenbäume oder das Gebäude selbst.',
    intro2: 'Die Auswahl setzt auf immergrüne und winterharte Arten mit langem Zierwert. Blüten im Frühjahr, Sommerfarbe und Herbstaspekt sorgen dafür, dass der Vorgarten keine Pause macht.',
    cta_params: '?standort=Vorgarten+Halbschatten+Straße+repräsentativ+pflegeleicht',
    seo_text: 'Vorgarten bepflanzen Beispiele mit Pflanzliste. Bewährt im Vorgarten: Storchschnabel (Geranium), Blauschwingel (Festuca), Lavendel, Katzenminze (Nepeta), Wolfsmilch (Euphorbia) und Bergenie (Bergenia).',
  },
];

const BEISPIEL_PFLANZEN_IDS = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'scripts/beispiel-pflanzen.json'), 'utf8')); }
  catch { return {}; }
})();

function loadBeispielPlan(slug) {
  try {
    const p = path.join(__dirname, 'scripts', `beispiel-plan-${slug}.json`);
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch { return null; }
}

function generateBeispielSVG(plan) {
  const W = 760, H = 310;
  const pflanzen = (plan.pflanzen || []).filter(p => !p.fehler);

  const FARBEN = {
    'blau': '#4f7fc9', 'lila': '#8b5cf6', 'violett': '#7c3aed', 'purpur': '#a21caf',
    'rosa': '#e879a0', 'pink': '#ec4899', 'rot': '#ef4444', 'orange': '#f97316',
    'gelb': '#ca8a04', 'creme': '#d9bc82', 'beige': '#c2a069', 'weiss': '#d4d4d4',
    'weiß': '#d4d4d4', 'grün': '#22c55e', 'gruen': '#16a34a', 'bordeaux': '#9f1239',
    'magenta': '#d946ef', 'silber': '#9ca3af', 'bronze': '#a16207',
  };
  function getCol(farbe) {
    if (!farbe) return '#52b788';
    const f = farbe.toLowerCase();
    for (const [k, v] of Object.entries(FARBEN)) { if (f.includes(k)) return v; }
    return '#52b788';
  }
  function getRow(p) {
    const r = (p.rolle || '').toLowerCase();
    if (r.includes('leit') || r.includes('hinter')) return 0;
    if (r.includes('begleit') || r.includes('mitte')) return 1;
    return 2;
  }

  const rows = [[], [], []];
  pflanzen.forEach(p => rows[getRow(p)].push(p));
  // Rows without plants: redistribute
  if (!rows[0].length && rows[1].length) { rows[0].push(...rows[1].splice(0,1)); }
  if (!rows[2].length && rows[1].length > 1) { rows[2].push(...rows[1].splice(-1,1)); }

  const ROW_Y = [82, 182, 265];
  const ROW_R  = [38, 28, 20];
  const ROW_LBL = ['Hintergrund', 'Mitte', 'Vordergrund'];

  let svgCircles = '', svgLabels = '', svgRowLbls = '';

  rows.forEach((plants, ri) => {
    if (!plants.length) return;
    const yc = ROW_Y[ri];
    const rMax = ROW_R[ri];
    const slotW = (W - 60) / plants.length;

    plants.forEach((p, ci) => {
      const r = Math.min(rMax, Math.max(14, (p.pflanzabstand_cm || 40) * 0.38));
      const xc = 30 + slotW * ci + slotW / 2;
      const col = getCol(p.farbe);
      const strokeCol = (col === '#d4d4d4' || col === '#d9bc82') ? '#bbb' : 'rgba(0,0,0,.15)';
      svgCircles += `<circle cx="${xc.toFixed(1)}" cy="${yc}" r="${r}" fill="${col}" fill-opacity=".88" stroke="${strokeCol}" stroke-width="1.5"/>`;

      // Extra specimens wenn stueckzahl > 1
      const n = Math.min(p.stueckzahl || 1, 4);
      if (n > 1) {
        const sr = r * 0.55, gap = r * 1.35;
        for (let j = 0; j < Math.min(n - 1, 3); j++) {
          const ang = (j / Math.max(n - 1, 1)) * Math.PI + Math.PI * 0.3;
          const sx = (xc + Math.cos(ang) * gap).toFixed(1);
          const sy = (yc + Math.sin(ang) * gap * 0.45).toFixed(1);
          svgCircles += `<circle cx="${sx}" cy="${sy}" r="${sr}" fill="${col}" fill-opacity=".55" stroke="${strokeCol}" stroke-width="1"/>`;
        }
      }

      const label = p.name_deutsch.split(' ')[0];
      svgLabels += `<text x="${xc.toFixed(1)}" y="${yc + r + 13}" text-anchor="middle" font-family="system-ui,sans-serif" font-size="9.5" fill="#333" font-weight="600">${label}</text>`;
    });
    svgRowLbls += `<text x="8" y="${yc + 3}" text-anchor="start" font-family="system-ui,sans-serif" font-size="9" fill="#a0916e">${ROW_LBL[ri]}</text>`;
  });

  // Legend rows
  const perRow = 3;
  const legRows = Math.ceil(pflanzen.length / perRow);
  const LH = H + 18, legH = legRows * 24 + 30;
  const legend = pflanzen.map((p, i) => {
    const col = getCol(p.farbe);
    const lx = 24 + (i % perRow) * (W / perRow);
    const ly = LH + Math.floor(i / perRow) * 24 + 16;
    const rolle = p.rolle ? ` · ${p.rolle}` : '';
    const stk = p.stueckzahl ? ` (${p.stueckzahl}×)` : '';
    return `<circle cx="${lx+7}" cy="${ly-4}" r="7" fill="${col}" fill-opacity=".88"/>
<text x="${lx+20}" y="${ly}" font-family="system-ui,sans-serif" font-size="10.5" fill="#333">${p.name_deutsch}${stk}<tspan fill="#999" font-size="9.5">${rolle}</tspan></text>`;
  }).join('');

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H + legH}" width="100%" style="max-width:760px;display:block">
  <defs>
    <linearGradient id="bgGrad" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#b5a07a"/>
      <stop offset="100%" stop-color="#d4c89a"/>
    </linearGradient>
    <linearGradient id="grassGrad" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#5c9e50"/>
      <stop offset="100%" stop-color="#3d7a35"/>
    </linearGradient>
  </defs>
  <!-- Bed bg -->
  <rect x="0" y="0" width="${W}" height="${H}" fill="url(#bgGrad)" rx="10"/>
  <!-- Back wall hint -->
  <rect x="0" y="0" width="${W}" height="16" fill="#8a7355" rx="10"/>
  <rect x="0" y="0" width="${W}" height="8" fill="#7a6445" rx="10"/>
  <!-- Front grass -->
  <rect x="0" y="${H-18}" width="${W}" height="18" fill="url(#grassGrad)" rx="10"/>
  <!-- Divider dashes -->
  <line x1="0" y1="${ROW_Y[1]-44}" x2="${W}" y2="${ROW_Y[1]-44}" stroke="#c5b08a" stroke-width="1" stroke-dasharray="5,5" opacity=".6"/>
  <line x1="0" y1="${ROW_Y[2]-38}" x2="${W}" y2="${ROW_Y[2]-38}" stroke="#c5b08a" stroke-width="1" stroke-dasharray="5,5" opacity=".6"/>
  <!-- Row labels -->
  ${svgRowLbls}
  <!-- Circles -->
  ${svgCircles}
  <!-- Plant labels -->
  ${svgLabels}
  <!-- Compass arrow -->
  <text x="${W-22}" y="20" font-family="system-ui,sans-serif" font-size="11" fill="#fff" text-anchor="middle" font-weight="700">N</text>
  <text x="${W-22}" y="${H-8}" font-family="system-ui,sans-serif" font-size="11" fill="#fff" text-anchor="middle" font-weight="700">S</text>
  <!-- Legend bg -->
  <rect x="0" y="${H}" width="${W}" height="${legH}" fill="#fafaf7"/>
  <text x="16" y="${LH+8}" font-family="system-ui,sans-serif" font-size="10" fill="#aaa" font-weight="700" letter-spacing=".08em">LEGENDE</text>
  ${legend}
</svg>`;
}

function getPflanzenFuerBeispiel(slug, licht, feuchtigkeiten) {
  const ids = BEISPIEL_PFLANZEN_IDS[slug];
  if (ids && ids.length) {
    const placeholders = ids.map(() => '?').join(',');
    const pflanzen = db.prepare(`
      SELECT id, name_deutsch, name_botanisch, bild_url, licht, farbe,
             hoehe_cm_min, hoehe_cm_max, bienen_freundlich, beschreibung, bluehzeit
      FROM pflanzen WHERE id IN (${placeholders})
    `).all(...ids);
    // Reihenfolge der IDs beibehalten
    return ids.map(id => pflanzen.find(p => p.id === id)).filter(Boolean);
  }
  // Fallback: dynamisch aus DB
  const lichtKw = licht === 'Schatten' ? '%Schatten%' : licht === 'Sonne' ? '%Sonne%' : '%Halbschatten%';
  const fPlaceholders = feuchtigkeiten.map(() => '?').join(',');
  return db.prepare(`
    SELECT id, name_deutsch, name_botanisch, bild_url, licht, farbe,
           hoehe_cm_min, hoehe_cm_max, bienen_freundlich, beschreibung, bluehzeit
    FROM pflanzen
    WHERE status='live' AND bild_url IS NOT NULL AND bild_url != ''
      AND licht LIKE ? AND feuchtigkeit IN (${fPlaceholders})
    ORDER BY pflege_sterne DESC, id ASC LIMIT 5
  `).all(lichtKw, ...feuchtigkeiten);
}

app.get('/beispiele', (req, res) => {
  const cardsHtml = BEISPIELE.map(b => `
    <a href="/beispiel/${b.slug}" style="text-decoration:none;color:inherit;display:block">
      <div style="background:#fff;border-radius:14px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,.08);transition:transform .15s" onmouseover="this.style.transform='translateY(-3px)'" onmouseout="this.style.transform=''">
        <div style="background:${b.grad};padding:24px 20px;display:flex;align-items:center;gap:14px">
          <span style="font-size:2rem">${b.icon}</span>
          <div>
            <div style="color:#fff;font-weight:800;font-size:1rem;line-height:1.2">${b.title}</div>
            <div style="color:rgba(255,255,255,.75);font-size:.78rem;margin-top:3px">${b.badge}</div>
          </div>
        </div>
        <div style="padding:16px 20px">
          <p style="font-size:.85rem;color:#555;line-height:1.55;margin-bottom:12px">${b.intro.substring(0,120)}…</p>
          <span style="color:#2d6a4f;font-size:.82rem;font-weight:700">Beispiel ansehen →</span>
        </div>
      </div>
    </a>`).join('');

  res.send(`<!DOCTYPE html><html lang="de"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Staudenbeet Beispiele mit Pflanznamen – 8 fertige Pflanzpläne | Staudenplan.de</title>
<meta name="description" content="8 konkrete Staudenbeet-Beispiele mit Pflanzliste und Namen: Schattenbeet, Sonnenbeet, Kiesgarten, Naturgarten, Teichrand und mehr. Kostenlos auf Staudenplan.de.">
<link rel="canonical" href="https://www.staudenplan.de/beispiele">
${NAV_LINKS}</head><body style="font-family:system-ui,sans-serif;background:#f6faf7;margin:0">
<div style="background:linear-gradient(135deg,#1b4332,#2d6a4f);padding:48px 20px 36px;text-align:center;color:#fff">
  <h1 style="font-size:clamp(1.6rem,4vw,2.2rem);font-weight:800;margin-bottom:10px">Staudenbeet Beispiele mit Pflanznamen</h1>
  <p style="opacity:.85;max-width:560px;margin:0 auto 24px;font-size:1rem;line-height:1.6">8 fertige Bepflanzungsbeispiele für verschiedene Standorte — mit konkreter Pflanzliste, Fotos und Pflanztipps.</p>
  <a href="/" style="display:inline-block;background:#fff;color:#1b4332;padding:12px 28px;border-radius:30px;font-weight:800;text-decoration:none;font-size:.95rem">🌿 Eigenen Plan erstellen →</a>
</div>
<div style="max-width:960px;margin:0 auto;padding:40px 16px">
  <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:20px">
    ${cardsHtml}
  </div>
  <div style="margin-top:48px;background:#fff;border-radius:14px;padding:28px;box-shadow:0 2px 12px rgba(0,0,0,.07)">
    <h2 style="font-size:1.2rem;color:#1b4332;margin-bottom:12px">Kein passendes Beispiel dabei?</h2>
    <p style="color:#555;font-size:.9rem;line-height:1.6;margin-bottom:16px">Unser KI-Gartenplaner erstellt dir in 2 Minuten einen individuellen Bepflanzungsplan — abgestimmt auf deinen genauen Standort, Bodentyp und Stil. Kostenlos und ohne Anmeldung.</p>
    <a href="/" style="display:inline-block;background:#2d6a4f;color:#fff;padding:12px 28px;border-radius:30px;font-weight:700;text-decoration:none;font-size:.9rem">Individuellem Plan erstellen →</a>
  </div>
</div>
${SITE_FOOTER}</body></html>`);
});

app.get('/beispiel/:slug', (req, res) => {
  const b = BEISPIELE.find(x => x.slug === req.params.slug);
  if (!b) return res.status(404).send('Nicht gefunden');

  const pflanzen = getPflanzenFuerBeispiel(b.slug, b.licht, b.feuchtigkeit);
  if (!pflanzen.length) return res.status(404).send('Keine Pflanzen gefunden');
  const plan = loadBeispielPlan(b.slug);

  const pflanzenHtml = pflanzen.map((p, i) => {
    const hoehe = p.hoehe_cm_min && p.hoehe_cm_max ? `${p.hoehe_cm_min}–${p.hoehe_cm_max} cm` : p.hoehe_cm_max ? `bis ${p.hoehe_cm_max} cm` : '';
    return `
    <div style="background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 10px rgba(0,0,0,.07)">
      <img src="${p.bild_url}" alt="${p.name_deutsch}" style="width:100%;height:180px;object-fit:cover" loading="lazy">
      <div style="padding:14px 16px">
        <div style="font-size:.7rem;color:#52b788;font-weight:700;text-transform:uppercase;letter-spacing:.05em;margin-bottom:4px">Pflanze ${i+1}</div>
        <h3 style="font-size:.95rem;color:#1b4332;font-weight:800;margin-bottom:2px"><a href="/pflanze/${slugify(p.name_botanisch)}" style="color:inherit;text-decoration:none">${p.name_deutsch}</a></h3>
        <div style="font-size:.78rem;font-style:italic;color:#888;margin-bottom:8px">${p.name_botanisch}</div>
        <div style="display:flex;flex-wrap:wrap;gap:5px">
          ${p.farbe ? `<span style="background:#f0faf3;color:#2d6a4f;border-radius:4px;padding:2px 8px;font-size:.72rem;font-weight:600">${p.farbe.split(',')[0]}</span>` : ''}
          ${hoehe ? `<span style="background:#f0faf3;color:#2d6a4f;border-radius:4px;padding:2px 8px;font-size:.72rem;font-weight:600">${hoehe}</span>` : ''}
          ${p.bienen_freundlich ? `<span style="background:#fef9c3;color:#854d0e;border-radius:4px;padding:2px 8px;font-size:.72rem;font-weight:600">🐝 Bienenfreundlich</span>` : ''}
        </div>
      </div>
    </div>`;
  }).join('');

  const steckbriefHtml = `
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:12px;margin:24px 0">
      <div style="background:#f0faf3;border-radius:10px;padding:14px;text-align:center">
        <div style="font-size:1.3rem;margin-bottom:4px">📐</div>
        <div style="font-size:.75rem;color:#888;margin-bottom:2px">Fläche</div>
        <div style="font-weight:700;color:#1b4332">${b.flaeche} m²</div>
      </div>
      <div style="background:#f0faf3;border-radius:10px;padding:14px;text-align:center">
        <div style="font-size:1.3rem;margin-bottom:4px">${b.licht === 'Sonne' ? '☀️' : b.licht === 'Schatten' ? '🌑' : '⛅'}</div>
        <div style="font-size:.75rem;color:#888;margin-bottom:2px">Licht</div>
        <div style="font-weight:700;color:#1b4332">${b.licht}</div>
      </div>
      <div style="background:#f0faf3;border-radius:10px;padding:14px;text-align:center">
        <div style="font-size:1.3rem;margin-bottom:4px">🌱</div>
        <div style="font-size:.75rem;color:#888;margin-bottom:2px">Pflanzen</div>
        <div style="font-weight:700;color:#1b4332">${pflanzen.length} Arten</div>
      </div>
      <div style="background:#f0faf3;border-radius:10px;padding:14px;text-align:center">
        <div style="font-size:1.3rem;margin-bottom:4px">💧</div>
        <div style="font-size:.75rem;color:#888;margin-bottom:2px">Feuchtigkeit</div>
        <div style="font-weight:700;color:#1b4332">${b.feuchtigkeit[0]}</div>
      </div>
    </div>`;

  const breadcrumb = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    "itemListElement": [
      { "@type": "ListItem", "position": 1, "name": "Startseite", "item": "https://www.staudenplan.de/" },
      { "@type": "ListItem", "position": 2, "name": "Beet-Beispiele", "item": "https://www.staudenplan.de/beispiele" },
      { "@type": "ListItem", "position": 3, "name": b.title, "item": `https://www.staudenplan.de/beispiel/${b.slug}` }
    ]
  });

  res.send(`<!DOCTYPE html><html lang="de"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${b.h1} | Staudenplan.de</title>
<meta name="description" content="${b.intro.substring(0,155)}">
<link rel="canonical" href="https://www.staudenplan.de/beispiel/${b.slug}">
<script type="application/ld+json">${breadcrumb}</script>
${NAV_LINKS}</head><body style="font-family:system-ui,sans-serif;background:#f6faf7;margin:0">

<div style="background:${b.grad};padding:48px 20px 36px;color:#fff;text-align:center">
  <div style="font-size:2.5rem;margin-bottom:10px">${b.icon}</div>
  <div style="display:inline-block;background:rgba(255,255,255,.2);color:#fff;border-radius:20px;padding:4px 14px;font-size:.78rem;font-weight:700;margin-bottom:12px">${b.badge}</div>
  <h1 style="font-size:clamp(1.4rem,4vw,2rem);font-weight:800;margin-bottom:10px;line-height:1.25">${b.h1}</h1>
  <p style="opacity:.85;max-width:520px;margin:0 auto;font-size:.95rem;line-height:1.6">${b.intro.substring(0,120)}…</p>
</div>

<nav style="background:#fff;border-bottom:1px solid #eee;padding:10px 20px;font-size:.82rem">
  <a href="/" style="color:#2d6a4f;text-decoration:none">Startseite</a> ›
  <a href="/beispiele" style="color:#2d6a4f;text-decoration:none">Beet-Beispiele</a> ›
  <span style="color:#888">${b.title}</span>
</nav>

<div style="max-width:860px;margin:0 auto;padding:32px 16px 60px">

  <div style="background:#fff;border-radius:14px;padding:28px;box-shadow:0 2px 12px rgba(0,0,0,.07);margin-bottom:24px">
    <h2 style="font-size:1.1rem;color:#1b4332;margin-bottom:12px">Standort auf einen Blick</h2>
    ${steckbriefHtml}
    <p style="color:#444;line-height:1.75;margin-bottom:10px">${b.intro}</p>
    <p style="color:#444;line-height:1.75">${b.intro2}</p>
  </div>

  <h2 style="font-size:1.2rem;color:#1b4332;margin-bottom:16px">Pflanzen für dieses Beet</h2>
  <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:14px;margin-bottom:32px">
    ${pflanzenHtml}
  </div>

  ${plan ? `
  <div style="background:#fff;border-radius:14px;padding:28px 20px;box-shadow:0 2px 12px rgba(0,0,0,.07);margin-bottom:24px">
    <h2 style="font-size:1.15rem;color:#1b4332;margin-bottom:6px">Pflanzplan · Draufsicht (Schematisch)</h2>
    <p style="color:#777;font-size:.82rem;margin-bottom:16px;line-height:1.5">Anordnung der Stauden im Beet — Hintergrund (groß) bis Vordergrund (klein). Kreisgrößen entsprechen ca. dem Pflanzabstand.</p>
    <div style="border-radius:10px;overflow:hidden;border:1px solid #eee">
      ${generateBeispielSVG(plan)}
    </div>
  </div>

  <div style="background:#fff;border-radius:14px;padding:24px 20px;box-shadow:0 2px 12px rgba(0,0,0,.07);margin-bottom:24px">
    <h2 style="font-size:1.1rem;color:#1b4332;margin-bottom:14px">Stückliste & Kosten</h2>
    <div style="overflow-x:auto">
    <table style="width:100%;border-collapse:collapse;font-size:.85rem">
      <thead>
        <tr style="background:#f0faf3;color:#1b4332">
          <th style="text-align:left;padding:10px 12px;border-radius:8px 0 0 8px">Pflanze</th>
          <th style="padding:10px 8px;text-align:center">Rolle</th>
          <th style="padding:10px 8px;text-align:center">Anzahl</th>
          <th style="padding:10px 8px;text-align:center">Abstand</th>
          <th style="padding:10px 12px;text-align:right;border-radius:0 8px 8px 0">Preis ca.</th>
        </tr>
      </thead>
      <tbody>
        ${(plan.pflanzen||[]).filter(p=>!p.fehler).map((p,i) => `
        <tr style="border-top:1px solid #f0f0f0;background:${i%2?'#fafafa':'#fff'}">
          <td style="padding:10px 12px">
            <div style="font-weight:700;color:#1b4332">${p.name_deutsch}</div>
            <div style="font-size:.75rem;color:#888;font-style:italic">${p.name_botanisch||''}</div>
          </td>
          <td style="padding:10px 8px;text-align:center">
            <span style="background:${p.rolle==='Leitstaude'?'#dcfce7':p.rolle==='Begleitstaude'?'#fef9c3':'#f0f4ff'};color:${p.rolle==='Leitstaude'?'#15803d':p.rolle==='Begleitstaude'?'#854d0e':'#3730a3'};border-radius:4px;padding:2px 7px;font-size:.72rem;font-weight:700">${p.rolle||'—'}</span>
          </td>
          <td style="padding:10px 8px;text-align:center;font-weight:600">${p.stueckzahl||'—'}</td>
          <td style="padding:10px 8px;text-align:center;color:#666">${p.pflanzabstand_cm?p.pflanzabstand_cm+' cm':'—'}</td>
          <td style="padding:10px 12px;text-align:right;color:#444">${p.preis_stueck_eur && p.stueckzahl ? (p.preis_stueck_eur*p.stueckzahl).toFixed(0)+' €' : p.preis_stueck_eur ? '~'+p.preis_stueck_eur+' €' : '—'}</td>
        </tr>`).join('')}
      </tbody>
      <tfoot>
        <tr style="border-top:2px solid #e0e0e0;background:#f9f9f9">
          <td colspan="4" style="padding:10px 12px;font-weight:700;color:#1b4332">Gesamt geschätzt</td>
          <td style="padding:10px 12px;text-align:right;font-weight:800;color:#1b4332;font-size:1rem">${plan.gesamtkosten_geschaetzt||'—'} €</td>
        </tr>
      </tfoot>
    </table>
    </div>
  </div>

  <div style="background:#fff;border-radius:14px;padding:24px 20px;box-shadow:0 2px 12px rgba(0,0,0,.07);margin-bottom:24px">
    <h2 style="font-size:1.1rem;color:#1b4332;margin-bottom:12px">Über dieses Beet</h2>
    <p style="color:#444;line-height:1.75;font-size:.92rem">${plan.beetbeschreibung||''}</p>
    ${plan.pflanzkalender ? `
    <h3 style="font-size:.95rem;color:#1b4332;margin:18px 0 10px">Pflanzkalender</h3>
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:8px">
      ${Object.entries(plan.pflanzkalender).map(([monat,akt]) => `
      <div style="background:#f0faf3;border-radius:8px;padding:10px 12px">
        <div style="font-size:.72rem;color:#52b788;font-weight:700;text-transform:uppercase;margin-bottom:3px">${monat}</div>
        <div style="font-size:.82rem;color:#444;line-height:1.4">${akt}</div>
      </div>`).join('')}
    </div>` : ''}
    ${plan.tipps && plan.tipps.length ? `
    <h3 style="font-size:.95rem;color:#1b4332;margin:18px 0 10px">Pflegetipps</h3>
    <ul style="margin:0;padding-left:20px;color:#444;font-size:.88rem;line-height:1.8">
      ${plan.tipps.map(t => `<li>${t}</li>`).join('')}
    </ul>` : ''}
  </div>` : ''}

  <div style="background:linear-gradient(135deg,#1b4332,#2d6a4f);border-radius:14px;padding:28px;color:#fff;margin-bottom:32px">
    <h2 style="font-size:1.1rem;margin-bottom:8px">Diesen Plan für deinen Garten anpassen</h2>
    <p style="opacity:.85;font-size:.9rem;line-height:1.6;margin-bottom:18px">Unser KI-Planer erstellt dir einen individuellen Bepflanzungsplan — abgestimmt auf deine genaue Fläche, deinen Boden und deine Vorlieben. Kostenlos und in 2 Minuten.</p>
    <a href="/${b.cta_params}" style="display:inline-block;background:#fff;color:#1b4332;padding:13px 28px;border-radius:30px;font-weight:800;text-decoration:none;font-size:.95rem">🌿 Meinen Plan erstellen →</a>
  </div>

  <div style="background:#fff;border-radius:14px;padding:24px;box-shadow:0 2px 12px rgba(0,0,0,.07);margin-bottom:24px">
    <p style="color:#555;font-size:.88rem;line-height:1.7">${b.seo_text}</p>
  </div>

  <h3 style="font-size:1rem;color:#1b4332;margin-bottom:14px">Weitere Beet-Beispiele</h3>
  <div style="display:flex;flex-wrap:wrap;gap:10px">
    ${BEISPIELE.filter(x => x.slug !== b.slug).map(x => `
      <a href="/beispiel/${x.slug}" style="display:flex;align-items:center;gap:8px;background:#fff;border-radius:30px;padding:8px 16px;text-decoration:none;color:#1b4332;font-size:.85rem;font-weight:600;box-shadow:0 1px 6px rgba(0,0,0,.08)">
        ${x.icon} ${x.title}
      </a>`).join('')}
  </div>
</div>
${SITE_FOOTER}</body></html>`);
});

// ─── Admin ────────────────────────────────────────────────────────────────────

function checkAdminPw(req, res) {
  if (!req.query.pw || req.query.pw !== process.env.ADMIN_PASSWORT) {
    res.status(401).json({ error: 'Passwort fehlt oder falsch.' });
    return false;
  }
  return true;
}


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

// ─── Quiz ─────────────────────────────────────────────────────────────────────

app.get('/api/quiz-fragen', (req, res) => {
  try {
    const n = Math.min(parseInt(req.query.n) || 10, 20);
    const alle = db.prepare(`
      SELECT id, name_deutsch, name_botanisch, bild_url
      FROM pflanzen
      WHERE status='live' AND bild_url IS NOT NULL AND bild_url != ''
      ORDER BY RANDOM()
      LIMIT ?
    `).all(n * 3); // mehr holen für wrong options

    const fragen = [];
    for (let i = 0; i < Math.min(n, alle.length); i++) {
      const richtig = alle[i];
      const falsche = alle.filter((_, j) => j !== i).sort(() => Math.random() - .5).slice(0, 3);
      const optionen = [richtig, ...falsche].sort(() => Math.random() - .5);
      fragen.push({
        id: richtig.id,
        bild_url: richtig.bild_url,
        richtig: richtig.name_deutsch,
        botanisch: richtig.name_botanisch,
        optionen: optionen.map(p => p.name_deutsch)
      });
    }
    res.json(fragen);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/quiz', (req, res) => {
  let html;
  try { html = require('fs').readFileSync(path.join(__dirname, 'public/quiz.html'), 'utf8'); } catch { return res.status(404).send('quiz.html nicht gefunden'); }
  res.send(html);
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
