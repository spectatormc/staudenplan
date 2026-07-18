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

// nginx läuft als einziger Reverse-Proxy davor (siehe DEPLOY.md) — ohne das hier
// gruppiert express-rate-limit alle Besucher unter der nginx-Loopback-Adresse in
// einen einzigen Rate-Limit-Bucket statt pro echter Client-IP.
app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use(express.json());

// Security-Header (kein CSP: Seite nutzt durchgängig Inline-Styles/-Scripts,
// eine korrekte CSP-Policy dafür ist ein eigenes Vorhaben)
app.use((req, res, next) => {
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
});

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

// ─── SEO-Migrationen (läuft bei jedem Start, idempotent) ─────────────────────
(function runSeoMigrations() {
  // Ratgeber-Titel auf Keywords optimieren
  const titelUpdates = [
    ['Planungsprozess für ein Staudenbeet', 'Staudenbeet planen: Schritt-für-Schritt Anleitung mit Pflanzplan'],
    ['Schattenbeete unter Bäumen und Sträuchern', 'Stauden für Schatten: Die besten Arten für schattige Beete'],
    ['Halbschattige Staudenbeete am Gehölzrand', 'Halbschatten-Stauden: Schöne Beete am Gehölzrand'],
    ['Bienenweide-Stauden und Insektenförderung', 'Bienenfreundliche Stauden: Top 15 Trachtpflanzen für deinen Garten'],
    ['Cottage-Garten und englischer Gartenstil', 'Cottage-Garten anlegen: Romantische Bepflanzung nach englischem Vorbild'],
    ['Sonnige trockene Staudenbeete und Kiesgärten', 'Kiesgarten & Trockenbeet: Stauden für sonnige, trockene Standorte'],
    ['Feuchte Standorte, Teichrand und Sumpfbeete', 'Teichrand & Sumpfbeet bepflanzen: Stauden für feuchte Standorte'],
    ['Stauden richtig pflanzen — Zeitpunkt und Technik', 'Stauden pflanzen: Zeitpunkt, Pflanzabstand & Technik'],
    ['Pflanzdichte und Stückzahlberechnung im Staudenbeet', 'Pflanzdichte berechnen: Wie viele Stauden pro m²?'],
    ['Farbgestaltung im Staudenbeet', 'Staudenbeet Farbgestaltung: Harmonische Farbkombinationen planen'],
    ['Ganzjahres-Attraktivität und saisonale Abfolge', 'Ganzjährig blühendes Staudenbeet: Saisonale Abfolge planen'],
    ['Ziergräser als Staudenbegleiter', 'Ziergräser im Staudenbeet: Die besten Arten & Kombinationen'],
    ['Winteraspekte und Struktur im Staudenbeet', 'Winteraspekte im Staudenbeet: Schönheit auch in der kalten Jahreszeit'],
    ['Lebendige Böden und Bodenbiologie im Staudenbeet', 'Bodenbiologie im Staudenbeet: Gesunden Boden aufbauen'],
    ['Bodenvorbereitung und Standortverbesserung', 'Bodenvorbereitung für Staudenbeete: Standort richtig vorbereiten'],
    ['Heimische vs. gartenwürdige Exoten', 'Heimische Stauden vs. Exoten: Was ist besser für deinen Garten?'],
  ];
  try {
    for (const [alt, neu] of titelUpdates) {
      const row = db.prepare('SELECT rowid FROM wissen WHERE titel = ? LIMIT 1').get(alt);
      if (row) db.prepare('UPDATE wissen SET titel = ? WHERE rowid = ?').run(neu, row.rowid);
    }
  } catch {}

  // Neue SEO-Cluster-Artikel einfügen (idempotent)
  const neueArtikel = [
    {
      titel: 'Heiligenkraut pflanzen und pflegen — Santolina chamaecyparissus',
      kategorie: 'Pflanzenportraits',
      inhalt: `Heiligenkraut (Santolina chamaecyparissus) ist ein immergrüner Halbstrauch aus der Familie der Korbblütler und stammt ursprünglich aus dem westlichen Mittelmeerraum. Der botanische Name Santolina chamaecyparissus bedeutet sinngemäß „kleine Zypresse am Boden" — eine Anspielung auf die feingliedrigen, silbrig-grauen Blättchen, die an Zypressen-Laub erinnern. Durch seine silbrige Laubfarbe, die langen Blütezeiten und die extreme Trockenheitstoleranz hat sich Heiligenkraut in deutschen Gärten als zuverlässige Dauerstaude für sonnige Standorte bewährt.

Standort und Boden: Heiligenkraut benötigt zwingend einen vollsonnigen bis sonnigen Standort mit sehr gut durchlässigem Boden. Sandige, kalkhaltige oder steinige Böden sind ideal. Staunässe ist sein größter Feind — wer in lehmigen oder humusreichen Gärten gärtnert, sollte Heiligenkraut auf einem erhöhten Beet oder in einem Kiesbett pflanzen. In nährstoffreichen, feuchten Böden wächst Heiligenkraut zu üppig und verliert seine kompakte Polsterform. Als typische Kiesgartenpflanze eignet sich Heiligenkraut hervorragend für mediterrane Gärten, Steppenpflanzungen und Steingärten.

Pflege und Rückschnitt: Etabliertes Heiligenkraut ist ausgesprochen pflegeleicht. Weder regelmäßige Bewässerung noch Düngung sind nötig. Der entscheidende Pflegeschritt ist der zweimalige Rückschnitt pro Jahr: Im März oder April direkt nach dem Neuaustrieb und nach der Blüte im August kräftig ins ältere Holz schneiden, um eine kompakte Polsterform zu erhalten. Ohne Rückschnitt verholzt die Basis und die Pflanze öffnet sich unattraktiv auseinander. Wer besonders kompaktes Wachstum wünscht, schneidet die Blütenstiele bereits im Knospenstadium zurück.

Blüte und Blütezeit: Von Juni bis August erscheinen leuchtend gelbe, kugelrunde Blütenköpfchen auf langen Stielen. Die Blüten sind einfach gebaut und werden gerne von Bienen und Schwebfliegen besucht. Santolina rosmarinifolia, eine verwandte Art mit grünem Laub, blüht ebenfalls gelb; Santolina serratifolia zeigt gezähnte Blätter und ist etwas kompakter.

Heiligenkraut Verwendung: Als silbriger Kontrastpartner zu blau-violetten Stauden wie Lavendel (Lavandula angustifolia), Ziersalbei (Salvia nemorosa) oder Katzenminze (Nepeta x faassenii) ist Heiligenkraut unübertroffen. Klassisch als Beetbegleitung, niedriger Heckensaum, Beetkante oder Bodendecker in trockenen Staudenbeeten verwendet.

Ist Heiligenkraut essbar? Historisch wurden die aromatischen Blätter mit ihren ätherischen Ölen als Gewürz eingesetzt, heute gilt Heiligenkraut jedoch nicht als Speisepflanze. In größeren Mengen können die ätherischen Öle reizend wirken. Als Räucherpflanze oder für Duftsträuße wird Heiligenkraut manchmal noch genutzt.

Botanischer Name und Winterhärte: Der botanische Name lautet Santolina chamaecyparissus. Heiligenkraut ist bis circa -15°C winterhart (Zone 7). In rauen Lagen oder auf schweren, feuchten Böden kann ein leichter Reisigschutz sinnvoll sein. Überwinterungsfeind Nummer eins ist nicht der Frost, sondern nasse Bodenverhältnisse im Winter.`
    },
    {
      titel: 'Kaiserkrone pflanzen und pflegen — Fritillaria imperialis',
      kategorie: 'Pflanzenportraits',
      inhalt: `Die Kaiserkrone (Fritillaria imperialis) gehört zu den imposantesten Frühjahrsblühern im deutschen Garten. Auf 80 bis 120 cm hohen Stielen trägt sie einen einzigartigen Blütenkranz aus hängenden, glockenförmigen Blüten in Orange, Gelb, Rot oder Weiß — gekrönt von einem Büschel aufrechter Hochblätter, das der Pflanze ihren majestätischen Namen eingebracht hat. Die Kaiserkrone blüht April bis Mai und ist eine der ersten großen Frühlingserscheinungen im Staudenbeet.

Kaiserkrone pflanzen — Wann und wie: Die Zwiebeln werden im September und Oktober gesetzt, sobald sie im Handel erhältlich sind. Möglichst frisch kaufen — weiche, schrumplige Zwiebeln nicht verwenden. Pflanztiefe: 15–20 cm (ca. dreifache Zwiebelbreite). Wichtiger Trick: Die Zwiebeln leicht schräg (45 Grad) einlegen, damit kein Wasser in der natürlichen Vertiefung auf der Zwiebelspitze stehenbleibt, was zu Fäulnis führen kann. Pflanzabstand: 30–40 cm. Kaiserkronen wirken am stärksten in Gruppen von 3–7 Zwiebeln.

Standort und Boden: Kaiserkronen bevorzugen einen sonnigen bis halbschattigen Standort mit tiefgründigem, humusreichem und gut durchlässigem Boden. Frisch-feuchter Boden ist ideal, Staunässe führt schnell zu Zwiebelfäule. Auf sandigem Boden Kompost einarbeiten, um Wasserhaltefähigkeit zu erhöhen.

Pflege und Düngung: Beim Austrieb im Frühjahr und nach der Blüte mit einem organischen Volldünger versorgen — Kaiserkronen sind Starkzehrer. Das Laub nach der Blüte vollständig einziehen lassen (mindestens 6 Wochen), da die Zwiebel in dieser Phase Reservestoffe für die nächste Saison einlagert. Erst wenn das Laub vollständig eingetrocknet ist, zurückschneiden.

Kaiserkrone Sorten: 'Aurora' (orangerot, sehr robust), 'Lutea' (reingelb, beliebt), 'Rubra' (dunkelrot), 'The Premier' (leuchtend goldorange), 'Prolifera' (mehrstöckige Blütenkrone, besonders spektakulär). Weiße Sorten wie 'White Beauty' sind seltener erhältlich.

Kaiserkronen und der Geruch: Kaiserkronen verströmen einen eigentümlichen, mäuseartigen Geruch aus Blüten und Zwiebeln. Dieser soll Wühlmäuse und Maulwürfe fernhalten — in der Praxis ist die Wirkung begrenzt. Beim Pflanzen Handschuhe tragen, da der Geruch intensiv an Händen haftet.

Winterhärte und Überwinterung: Kaiserkronen sind sehr winterhart (bis –28°C, Zone 5) und brauchen keinen Winterschutz. Frostschäden können allenfalls an bereits austreibenden Blättern im zeitigen Frühjahr auftreten — ein einfaches Vlies reicht zum Schutz. Den Boden im Winter trocken halten, um Zwiebelfäule zu vermeiden.

Pflanzpartner: Vergissmeinnicht (Myosotis), Tulpen, Narzissen, Geranium phaeum, Waldsteinia ternata als Bodendecker. Im Bauerngarten oder Cottage-Garten kombiniert die Kaiserkrone wunderbar mit Pfingstrosen und Rittersporn.`
    },
    {
      titel: 'Geranium Rozanne — Der Storchschnabel mit der längsten Blütezeit',
      kategorie: 'Pflanzenportraits',
      inhalt: `Geranium 'Rozanne' ist eine der beliebtesten Gartenstauden der letzten Jahrzehnte. Von Mai bis zum ersten Frost erscheinen ununterbrochen großzügige, violettblaue Blüten mit weißem Zentrum — eine Blütezeit, die kaum eine andere winterharte Staude übertreffen kann. 'Rozanne' wurde 1989 in einem privaten englischen Garten in Somerset entdeckt, als natürlicher Hybrid zwischen Geranium himalayense und Geranium wallichianum. Heute ist dieser Storchschnabel weltweit eine der meistverkauften Gartenstauden.

Standort und Boden: Geranium 'Rozanne' ist ausgesprochen anpassungsfähig. Von vollsonnig bis halbschattig gedeiht die Pflanze problemlos. Im tiefen Schatten lässt die Blütenintensität nach. Der Boden sollte durchlässig und mäßig nährstoffreich sein; Staunässe ist zu vermeiden. Normaler Gartenboden genügt — Düngung ist in der Regel nicht nötig.

Wuchs und Pflanzabstand: Der Wuchs ist locker ausgebreitet bis hängend, ideal als Bodendecker zwischen höheren Stauden. 'Rozanne' wird 40–50 cm hoch und 60–90 cm breit. Pflanzabstand: 40–50 cm. Pflanzzeit: März bis Mai oder September bis Oktober.

Storchschnabel Rozanne Rückschnitt: Im Hochsommer, wenn eine kurze Blühpause eintritt, lohnt ein kräftiger Rückschnitt auf 10–15 cm — innerhalb von zwei Wochen treibt 'Rozanne' frisch durch und blüht bis in den November. Dieser „Chelsea-Chop"-Schnitt im Juni verlängert die Blühsaison erheblich. Im Herbst einziehen lassen, im Frühjahr altes Material entfernen.

Winterhärte: Geranium 'Rozanne' ist sehr winterhart (bis –25°C, Zone 5). Der oberirdische Teil zieht im Winter ein, im Frühjahr treibt die Staude zuverlässig neu aus.

Kombination und Verwendung: Die violettblaue Blüte harmoniert hervorragend mit Gelb (Achillea 'Moonshine'), Weiß (Phlox), Rosa (Rosen) und Violett (Salvia nemorosa). Als Unterpflanzung von Rosen ist 'Rozanne' eine klassische Kombination. Auch unter Laubgehölzen, als Beeteinfassung oder zwischen Gräsern eingesetzt zeigt der Storchschnabel Rozanne seine Qualitäten.

Kaufhinweis: Geranium 'Rozanne' ist eine eingetragene Schutzsorte (Handelsname 'Rozanne', Sortenbezeichnung 'Gerwat'). Im Handel unter dem Namen Geranium 'Rozanne' oder Geranium 'Gerwat' erhältlich. Günstigere „Rozanne-ähnliche" Produkte sind häufig andere Arten (z.B. Geranium x magnificum) mit deutlich kürzerer Blütezeit.`
    },
  ];

  try {
    const insertStmt = db.prepare('INSERT INTO wissen(titel, inhalt, kategorie, quelle, datum) VALUES (?, ?, ?, ?, ?)');
    for (const art of neueArtikel) {
      const exists = db.prepare('SELECT COUNT(*) as n FROM wissen WHERE titel = ?').get(art.titel).n;
      if (!exists) insertStmt.run(art.titel, art.inhalt, art.kategorie, 'Staudenplan.de Redaktion', '2026-06-25');
    }
  } catch {}
})();

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
// Admin-Aktionen (KI-Bildgenerierung etc.) sind zusätzlich zum Passwortschutz
// begrenzt, damit ein geleaktes/erratenes Passwort keine unbegrenzten OpenAI-Kosten
// bzw. unbegrenzt viele Kindprozesse auf dem geteilten VPS auslösen kann.
const adminActionLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, max: 30,
  message: { error: 'Zu viele Admin-Aktionen.' }
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

  // WHERE-Varianten (Vollmatch → Licht+Feucht → nur Licht)
  const FULL_WHERE  = `licht LIKE ? AND (boden LIKE ? OR boden LIKE ?) AND stil LIKE ?
      AND (feuchtigkeit IN (${feuchPlaceholders}) OR feuchtigkeit IS NULL)
      AND (wuchs IS NULL OR wuchs != 'invasiv') AND (status IS NULL OR status = 'live')`;
  const FULL_ARGS   = [`%${lichtTerm}%`, `%${bodenTerm}%`, '%normal%', `%${stilTerm}%`, ...feuchTerms];

  const LICHT_WHERE = `licht LIKE ?
      AND (feuchtigkeit IN (${feuchPlaceholders}) OR feuchtigkeit IS NULL)
      AND (wuchs IS NULL OR wuchs != 'invasiv') AND (status IS NULL OR status = 'live')`;
  const LICHT_ARGS  = [`%${lichtTerm}%`, ...feuchTerms];

  const LAST_WHERE  = `licht LIKE ? AND (wuchs IS NULL OR wuchs != 'invasiv') AND (status IS NULL OR status = 'live')`;
  const LAST_ARGS   = [`%${lichtTerm}%`];

  // Rollen-Filter (spiegelt die Logik aus buildSystemPrompt Zeile ~269)
  const LEIT_F    = `(rolle_empfehlung = 'Leitstaude'    OR (rolle_empfehlung IS NULL AND COALESCE(hoehe_cm_max,50) >= 100))`;
  const BEGLEIT_F = `(rolle_empfehlung = 'Begleitstaude' OR (rolle_empfehlung IS NULL AND COALESCE(hoehe_cm_max,50) >= 50 AND COALESCE(hoehe_cm_max,50) < 100))`;
  const FUELL_F   = `(rolle_empfehlung = 'Füllstaude'    OR (rolle_empfehlung IS NULL AND COALESCE(hoehe_cm_max,50) < 50))`;

  function roleQuery(where, args, roleFilter, n) {
    return db.prepare(
      `SELECT ${COLS} FROM pflanzen WHERE ${where} AND ${roleFilter} ORDER BY RANDOM() LIMIT ${n}`
    ).all(...args);
  }

  // Rollenausgewogene Selektion: Leit / Begleit / Füll separat abfragen
  let leit    = roleQuery(FULL_WHERE, FULL_ARGS, LEIT_F,    8);
  let begleit = roleQuery(FULL_WHERE, FULL_ARGS, BEGLEIT_F, 15);
  let fuell   = roleQuery(FULL_WHERE, FULL_ARGS, FUELL_F,   10);

  // Fallback pro Rolle auf Licht+Feuchtigkeit wenn zu wenige Treffer
  if (leit.length    < 3) leit    = roleQuery(LICHT_WHERE, LICHT_ARGS, LEIT_F,    8);
  if (begleit.length < 5) begleit = roleQuery(LICHT_WHERE, LICHT_ARGS, BEGLEIT_F, 15);
  if (fuell.length   < 3) fuell   = roleQuery(LICHT_WHERE, LICHT_ARGS, FUELL_F,   10);

  // Letzter Fallback nur auf Licht
  if (leit.length    < 2) leit    = roleQuery(LAST_WHERE, LAST_ARGS, LEIT_F,    8);
  if (begleit.length < 3) begleit = roleQuery(LAST_WHERE, LAST_ARGS, BEGLEIT_F, 15);
  if (fuell.length   < 2) fuell   = roleQuery(LAST_WHERE, LAST_ARGS, FUELL_F,   10);

  // Deduplizieren und zusammenführen (Leit → Begleit → Füll)
  const seen = new Set();
  const kandidaten = [...leit, ...begleit, ...fuell].filter(p => {
    if (seen.has(p.name_botanisch)) return false;
    seen.add(p.name_botanisch);
    return true;
  });

  if (kandidaten.length >= 8) return kandidaten;

  // Absoluter Fallback: alle passenden Pflanzen nach Licht
  return db.prepare(
    `SELECT ${COLS} FROM pflanzen WHERE ${LAST_WHERE} ORDER BY RANDOM() LIMIT 35`
  ).all(...LAST_ARGS);
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

function getGeophytenKandidaten(licht) {
  const lichtTerm = LICHT_MAP[licht] || licht.split(' ')[0];
  const GENERA = ['Tulipa', 'Narcissus', 'Allium', 'Muscari', 'Crocus', 'Galanthus', 'Scilla', 'Camassia', 'Nectaroscordum'];
  const clause = GENERA.map(() => 'name_botanisch LIKE ?').join(' OR ');
  try {
    return db.prepare(
      `SELECT name_deutsch, name_botanisch, bluehzeit, farbe, hoehe_cm_min, hoehe_cm_max, preis_stueck_eur, licht
       FROM pflanzen
       WHERE (${clause}) AND licht LIKE ?
         AND (wuchs IS NULL OR wuchs != 'invasiv') AND (status IS NULL OR status = 'live')
       ORDER BY RANDOM() LIMIT 10`
    ).all(...GENERA.map(g => `${g}%`), `%${lichtTerm}%`);
  } catch { return []; }
}

function buildSystemPrompt(kandidaten, wissen, geophytenKandidaten = []) {
  let prompt = `Du bist ein erfahrener Staudenspezialist und Gartenplaner aus Deutschland mit 20 Jahren Erfahrung. \
Du empfiehlst ausschließlich in Deutschland winterharte Pflanzen. Antworte immer als valides JSON ohne Markdown-Formatierung.

## PLANUNGSREGELN (strikt einhalten):
1. HÖHENSTAFFELUNG: Hohe Stauden (>100cm) in den Hintergrund, Mittelhohe (50–100cm) in die Mitte, Niedrige (<50cm) und Bodendecker in den Vordergrund.
2. SCHICHTEN (PFLICHT): Dein Plan MUSS enthalten: 1–3 Leitstauden-Arten (visuelle Ankerpunkte), mind. 3 Begleitstauden-Arten (Rahmen und Übergänge), mind. 2 Füllstauden-Arten (Bodendecker/Lückenfüller). Ein Plan ohne Füllstauden ist unvollständig und wird abgelehnt.
3. BLÜTENFOLGE: Verteile die Blütezeiten — immer mind. 2 Arten pro Saison (Frühjahr/Sommer/Herbst) einplanen.
4. FARBHARMONIE: Maximal 3–4 Hauptfarben, Weiß oder Silber als Verbinder nutzen.
5. LEITSTAUDEN: Jede Leitstaude mind. 3 Exemplare einplanen — Einzelsetzung wirkt verloren und entspricht nicht der Profipraxis.
6. KONZEPT (PFLICHT): Schreibe ZUERST das Feld "konzept" — ein einziger prägnanter Satz der das Thema und den Charakter des Beetes benennt (z.B. "Romantisches Pastell-Staudenbeet in Rosa-Weiß-Lavendel mit Blütefolge von Mai bis Oktober"). Alle Pflanzenwahl folgt konsequent diesem Konzept.`;

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

  if (geophytenKandidaten.length > 0) {
    prompt += '\n\n## GEOPHYTEN-AUSWAHL (Zwiebelpflanzen für die Frühjahrsschicht):\n';
    prompt += 'Diese Zwiebeln werden ZUSÄTZLICH zu den Stauden eingeplant — als eigene unterirdische Schicht. Sie ersetzen KEINE Staude und fließen NICHT in die Pflanzdichte ein.\n';
    prompt += geophytenKandidaten.map(p => {
      const hoehe = (p.hoehe_cm_min && p.hoehe_cm_max) ? `${p.hoehe_cm_min}–${p.hoehe_cm_max}cm` : '';
      return `- [Geophyt] ${p.name_deutsch} (${p.name_botanisch}): Blüte ${p.bluehzeit || '?'} | ${p.farbe || '?'} | ${hoehe} | ${p.preis_stueck_eur || '?'}€`;
    }).join('\n');
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
      <p style="margin-top:16px;font-size:.88rem;color:#666;border-top:1px solid #dde8e0;padding-top:14px">💡 <strong>Was kostet Gartenplanung?</strong> Einen Überblick über typische Kosten für Gartenplanung findest du bei <a href="https://gartenbau-kosten.de/gartenplanung/gartenplanung-kosten/" target="_blank" rel="noopener" style="color:#2d6a4f;font-weight:600">gartenbau-kosten.de →</a></p>
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
          lieblingspflanzen, budget, nutzung, pflegezeit, vielfalt, dichte, plz, geophyten } = req.body;

  if (!gartenflaeche || !licht || !boden || !stil) {
    return res.status(400).json({ error: 'Bitte alle Pflichtfelder ausfüllen.' });
  }

  // RAG: Hol Kontext aus der Wissensdatenbank
  const feuchtigkeit = getFeuchtigkeit(boden, standort_beschreibung);
  const kandidaten = getPflanzenkandidaten(licht, boden, stil, standort_beschreibung);
  const wissen = getRelevantesWissen(stil, licht, feuchtigkeit);

  const geophytenKandidaten = geophyten ? getGeophytenKandidaten(licht) : [];

  if (kandidaten.length > 0) {
    console.log(`RAG: ${kandidaten.length} Pflanzenkandidaten (feuchtigkeit=${feuchtigkeit}), ${wissen.length} Wissensdokumente${geophytenKandidaten.length > 0 ? `, ${geophytenKandidaten.length} Geophyten` : ''}`);
  }

  const systemPrompt = buildSystemPrompt(kandidaten, wissen, geophytenKandidaten);

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
ROLLENPFLICHT — dein Plan ist ungültig ohne: mind. 2 Füllstauden-Arten (z.B. Storchschnabel, Katzenminze, Frauenmantel, Elfenblume, Immergrün, Gundermann, Waldsteinia) die alle freien Flächen lückenlos schließen; mind. 3 Begleitstauden-Arten (mittlere Höhe, rahmen Leitstauden ein).
${geophytenKandidaten.length > 0 ? `GEOPHYTEN-SCHICHT (ZUSÄTZLICH, PFLICHT da angefordert): Wähle 2–4 Geophyten aus der bereitgestellten Geophyten-Liste. Diese kommen ON TOP zu allen Stauden dazu — sie ersetzen KEINE Staude, reduzieren NICHT deren Stückzahl und fließen NICHT in die Pflanzdichte-Berechnung ein. Vergib ihnen Rolle "Geophyt". Stückzahl pro Art: ${Math.round((gartenflaeche || 10) * 5)} ÷ Anzahl Geophyten-Arten (mind. 5 Stk/Art, in Gruppen à 7–15 gepflanzt). Pflanzzeit: Oktober–November im Herbst als Zwiebeln in den Boden zwischen die Stauden.` : ''}
${lieblingsList ? 'Die genannten Lieblingspflanzen MÜSSEN im Plan enthalten sein.' : ''}${budget ? ` Halte die Gesamtkosten unter ${budget} €.` : ''}
${kandidaten.length > 0 ? 'Wähle primär aus der bereitgestellten Pflanzenliste.' : ''}

Vergib jeder Pflanze eine Rolle nach Hansen & Stahl: "Leitstaude" (1–3 auffällige Strukturpflanzen, max. 3 Arten), "Begleitstaude" (rahmt Leitstauden ein, mind. 3 Arten), "Füllstaude" (Bodendecker/Lückenfüller, mind. 2 Arten). Leitstauden sind visuelle Ankerpunkte, Begleitstauden der Rahmen, Füllstauden schließen alle Lücken lückenlos.

PFLANZKALENDER-HINWEIS: Im Feld "pflanzkalender" stehen nicht nur Blühzeiten, sondern auch Winterschmuck-Pflanzen. Im Abschnitt "Winter" alle Pflanzen aus dem Plan auflisten, die im Winter Zierwert haben: Gräser mit dekorativen Samenständen (z.B. Miscanthus, Pennisetum, Panicum, Calamagrostis), Stauden mit stehenbleibenden Fruchtständen oder markanter Silhouette (z.B. Rudbeckia, Echinacea, Sedum/Hylotelephium, Eryngium) sowie wintergrüne Bodendecker. Auch wenn keine Pflanze blüht — die Winter-Liste soll immer mindestens 2–3 Einträge haben, sofern solche Pflanzen im Plan enthalten sind.

JSON-Format:
{
  "konzept": "Ein prägnanter Satz der das Thema und den Stil des Beetes benennt (z.B. 'Naturnahes Blütenparadies in Blau-Violett mit Schmetterlingspflanzen und gestaffelter Höhe').",
  "pflanzen": [{
    "name_deutsch": "...",
    "name_botanisch": "...",
    "beschreibung": "...",
    "standort": "...",
    "bluehzeit": "...",
    "farbe": "...",
    "hoehe_cm": 0,
    "pflege_sterne": 1,
    "rolle": "Leitstaude",  // Leitstaude | Begleitstaude | Füllstaude | Geophyt
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
  if (!/^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/.test(email)) {
    return res.status(400).json({ error: 'Bitte eine gültige E-Mail-Adresse eingeben.' });
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

  const pflanzenListe = Array.isArray(ki_plan?.pflanzen)
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
    `<url><loc>${base}/stauden-fuer-schatten</loc><changefreq>monthly</changefreq><priority>0.85</priority></url>`,
    `<url><loc>${base}/stauden-fuer-sonne</loc><changefreq>monthly</changefreq><priority>0.85</priority></url>`,
    `<url><loc>${base}/pflegeleichte-stauden</loc><changefreq>monthly</changefreq><priority>0.85</priority></url>`,
    `<url><loc>${base}/bienenfreundliche-stauden</loc><changefreq>monthly</changefreq><priority>0.85</priority></url>`,
    `<url><loc>${base}/staudenbeet-planen</loc><changefreq>monthly</changefreq><priority>0.85</priority></url>`,
    `<url><loc>${base}/stauden-kombinieren</loc><changefreq>monthly</changefreq><priority>0.85</priority></url>`,
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
  if (!req.query.pw || req.query.pw !== process.env.ADMIN_PASSWORT) return res.status(403).send('<h2>403</h2>');

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
  const ADMIN_PW = ${JSON.stringify(req.query.pw)};
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
    await fetch('/api/bildcheck-starten?pw='+encodeURIComponent(ADMIN_PW),{method:'POST'});
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
    const r = await fetch('/api/ki-bild-vorschlag/' + id + '?pw=' + encodeURIComponent(ADMIN_PW), { method: 'POST' });
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
app.post('/api/ki-bild-vorschlag/:id', adminActionLimiter, (req, res) => {
  if (!checkAdminPw(req, res)) return;
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
app.post('/api/ki-bild-ablehnen/:id', adminActionLimiter, (req, res) => {
  if (!checkAdminPw(req, res)) return;
  const id = parseInt(req.params.id);
  db.prepare("UPDATE pflanzen SET bild_vorschlag=NULL, bild_check_info=NULL WHERE id=?").run(id);
  res.json({ ok: true });
});

// KI-Bilder generieren im Hintergrund starten
app.post('/api/ki-bilder-starten', adminActionLimiter, (req, res) => {
  if (!checkAdminPw(req, res)) return;
  const { spawn } = require('child_process');
  const child = spawn(process.execPath, [
    path.join(__dirname, 'scripts', 'generate-ki-bilder.js'), '--limit=10'
  ], { cwd: __dirname, detached: true, stdio: 'ignore' });
  child.unref();
  res.json({ ok: true });
});

// Bildcheck im Hintergrund starten
app.post('/api/bildcheck-starten', adminActionLimiter, (req, res) => {
  if (!checkAdminPw(req, res)) return;
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
app.post('/api/kandidaten-starten', adminActionLimiter, (req, res) => {
  if (!checkAdminPw(req, res)) return;
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

  // Inhalt-Lang vorab parsen (für FAQ + Verlinkung)
  const inhaltLang = pflanze.inhalt_lang
    ? (() => { try { return JSON.parse(pflanze.inhalt_lang); } catch { return null; } })()
    : null;

  // FAQ automatisch aus DB-Feldern generieren
  const faqItems = [
    pflanze.bluehzeit     && { q: `Wann blüht ${pflanze.name_deutsch}?`, a: `${pflanze.name_deutsch} blüht ${pflanze.bluehzeit}.` },
    pflanze.licht         && { q: `Welchen Standort braucht ${pflanze.name_deutsch}?`, a: `${pflanze.name_deutsch} (${pflanze.name_botanisch}) bevorzugt ${pflanze.licht.replace(/\|/g, '- und ')}-Standorte.` },
    (pflanze.hoehe_cm_min || pflanze.hoehe_cm_max) && { q: `Wie hoch wird ${pflanze.name_deutsch}?`, a: `${pflanze.name_deutsch} erreicht eine Wuchshöhe von ${hoehe}.` },
    inhaltLang?.pflanzabstand && { q: `Welchen Pflanzabstand empfiehlt man für ${pflanze.name_deutsch}?`, a: inhaltLang.pflanzabstand },
    inhaltLang?.pflanzzeit    && { q: `Wann pflanzt man ${pflanze.name_deutsch}?`, a: inhaltLang.pflanzzeit },
    inhaltLang?.rueckschnitt  && { q: `Wann und wie schneidet man ${pflanze.name_deutsch} zurück?`, a: inhaltLang.rueckschnitt },
    inhaltLang?.ueberwinterung && { q: `Ist ${pflanze.name_deutsch} winterhart?`, a: inhaltLang.ueberwinterung },
    pflanze.bienen_freundlich  && { q: `Ist ${pflanze.name_deutsch} bienenfreundlich?`, a: `Ja, ${pflanze.name_deutsch} ist eine wertvolle Trachtpflanze und zieht Bienen, Hummeln und andere Bestäuber zuverlässig an.` },
  ].filter(Boolean).slice(0, 7);

  const faqSchema = faqItems.length > 0 ? JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    'mainEntity': faqItems.map(item => ({
      '@type': 'Question',
      'name': item.q,
      'acceptedAnswer': { '@type': 'Answer', 'text': item.a }
    }))
  }) : null;

  const faqHtml = faqItems.length > 0 ? `
    <section style="background:#fff;border-radius:14px;padding:24px;box-shadow:0 2px 12px rgba(0,0,0,.07);margin-bottom:24px">
      <h2 style="font-size:1.15rem;color:#1b4332;margin-bottom:20px;font-weight:700">❓ Häufige Fragen zu ${pflanze.name_deutsch}</h2>
      <div>
        ${faqItems.map((item, i) => `<details style="border-bottom:${i < faqItems.length - 1 ? '1px solid #f0ede8' : 'none'};padding:14px 0"${i === 0 ? ' open' : ''}>
          <summary style="font-weight:700;font-size:.92rem;color:#1b4332;cursor:pointer;list-style:none;display:flex;justify-content:space-between;align-items:center">${item.q}<span style="color:#2d6a4f;flex-shrink:0;margin-left:8px;font-size:.75rem">▼</span></summary>
          <p style="font-size:.88rem;color:#555;line-height:1.65;margin-top:10px;padding-right:8px">${item.a}</p>
        </details>`).join('')}
      </div>
    </section>` : '';

  // Passende Ratgeber für interne Verlinkung
  let passendArtikel = [];
  try {
    const genus = (pflanze.name_botanisch || '').split(' ')[0];
    const lichtKey = (pflanze.licht || '').split('|')[0];
    passendArtikel = db.prepare(`SELECT titel FROM wissen WHERE inhalt LIKE ? OR inhalt LIKE ? OR inhalt LIKE ? LIMIT 3`)
      .all(`%${pflanze.name_deutsch}%`, `%${genus}%`, `%${lichtKey}%`);
  } catch {}

  const passendArtikelHtml = passendArtikel.length > 0 ? `
    <section style="background:#f0fdf4;border-radius:14px;padding:20px 24px;margin-bottom:24px">
      <h2 style="font-size:1rem;color:#1b4332;margin-bottom:14px;font-weight:700">📚 Weiterführende Ratgeber</h2>
      <div style="display:flex;flex-direction:column;gap:8px">
        ${passendArtikel.map(a => `<a href="/ratgeber/${slugify(a.titel)}" style="display:flex;align-items:center;gap:10px;color:#2d6a4f;text-decoration:none;font-size:.88rem;font-weight:600;padding:8px 12px;background:#fff;border-radius:8px;transition:background .12s" onmouseover="this.style.background='#d8f3dc'" onmouseout="this.style.background='#fff'">→ ${a.titel}</a>`).join('')}
      </div>
    </section>` : '';

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
  ${faqSchema ? `<script type="application/ld+json">${faqSchema}</script>` : ''}
  <style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:'Segoe UI',system-ui,sans-serif;background:#f8f4ef;color:#1a1a1a}@media(max-width:680px){.pflanz-grid{grid-template-columns:1fr!important}.pflanz-hero-inner{flex-direction:column!important}}details>summary::-webkit-details-marker{display:none}</style>
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
      const d = inhaltLang;
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

    ${faqHtml}
    ${passendArtikelHtml}

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

// ─── Statische Kategorie-Seiten (SEO) ────────────────────────────────────────

function kategorieSeitenHTML({ titel, metaDesc, h1, intro, pflanzen, artikelLinks, slug }) {
  const pflanzenHtml = pflanzen.map(p => `
    <a href="/pflanze/${pflanzeToSlug(p.name_botanisch)}" style="background:#fff;border-radius:12px;text-decoration:none;color:inherit;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.07);transition:transform .12s;display:flex;flex-direction:column" onmouseover="this.style.transform='translateY(-2px)'" onmouseout="this.style.transform=''">
      ${p.bild_url
        ? `<div style="height:120px;overflow:hidden"><img src="${p.bild_url}" alt="${p.name_deutsch}" loading="lazy" style="width:100%;height:100%;object-fit:cover"></div>`
        : `<div style="height:120px;background:linear-gradient(135deg,#d8f3dc,#b7e4c7);display:flex;align-items:center;justify-content:center;font-size:3rem">🌿</div>`}
      <div style="padding:12px">
        <div style="font-size:.88rem;font-weight:700;color:#1b4332;line-height:1.3;margin-bottom:3px">${p.name_deutsch}</div>
        <div style="font-size:.73rem;color:#aaa;font-style:italic;margin-bottom:6px">${p.name_botanisch}</div>
        ${p.bluehzeit ? `<div style="font-size:.72rem;color:#2d6a4f">🌸 ${p.bluehzeit}</div>` : ''}
      </div>
    </a>`).join('');

  const artikelHtml = artikelLinks.length > 0 ? `
    <div style="margin-top:48px;padding-top:32px;border-top:2px solid #d8f3dc">
      <h2 style="font-size:1.15rem;color:#1b4332;margin-bottom:16px;font-weight:700">📚 Ratgeber-Artikel zum Thema</h2>
      <div style="display:flex;flex-direction:column;gap:10px">
        ${artikelLinks.map(a => `<a href="/ratgeber/${slugify(a.titel)}" style="display:flex;align-items:center;gap:10px;background:#fff;border-radius:10px;padding:14px 18px;text-decoration:none;box-shadow:0 2px 8px rgba(0,0,0,.06);transition:background .12s" onmouseover="this.style.background='#f0fdf4'" onmouseout="this.style.background='#fff'">
          <span style="font-size:1.2rem;flex-shrink:0">📖</span>
          <span style="font-size:.9rem;font-weight:600;color:#1b4332">${a.titel}</span>
          <span style="margin-left:auto;color:#2d6a4f;font-weight:700;font-size:.82rem;white-space:nowrap">Lesen →</span>
        </a>`).join('')}
      </div>
    </div>` : '';

  return `<!DOCTYPE html><html lang="de"><head>
  <meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${titel} | Staudenplan.de</title>
  <meta name="description" content="${metaDesc}">
  <link rel="canonical" href="https://www.staudenplan.de/${slug}">
  <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🌿</text></svg>">
  <meta property="og:title" content="${titel}">
  <meta property="og:description" content="${metaDesc}">
  <meta property="og:type" content="website">
  <script type="application/ld+json">${JSON.stringify({
    '@context':'https://schema.org','@type':'CollectionPage',
    'name': titel, 'description': metaDesc,
    'url': `https://www.staudenplan.de/${slug}`,
    'breadcrumb': {'@type':'BreadcrumbList','itemListElement':[
      {'@type':'ListItem','position':1,'name':'Startseite','item':'https://www.staudenplan.de/'},
      {'@type':'ListItem','position':2,'name':'Stauden-Lexikon','item':'https://www.staudenplan.de/pflanzen'},
      {'@type':'ListItem','position':3,'name':h1,'item':`https://www.staudenplan.de/${slug}`}
    ]}
  })}</script>
  <style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:'Segoe UI',system-ui,sans-serif;background:#f8f4ef;color:#1a1a1a}</style>
  </head><body>
  ${NAV_LINKS}
  <div style="background:linear-gradient(160deg,#1b4332,#2d6a4f);color:#fff;padding:48px 24px 40px;text-align:center">
    <div style="font-size:.8rem;opacity:.7;margin-bottom:8px"><a href="/" style="color:rgba(255,255,255,.7);text-decoration:none">Startseite</a> › <a href="/pflanzen" style="color:rgba(255,255,255,.7);text-decoration:none">Stauden-Lexikon</a> › <span>${h1}</span></div>
    <h1 style="font-size:clamp(1.5rem,4vw,2rem);font-weight:800;line-height:1.25;margin-bottom:12px">${h1}</h1>
    <p style="opacity:.88;max-width:600px;margin:0 auto;font-size:.95rem;line-height:1.6">${pflanzen.length} passende Stauden gefunden</p>
  </div>
  <main style="max-width:1060px;margin:0 auto;padding:40px 20px 60px">
    <div style="background:#fff;border-radius:14px;padding:24px 28px;box-shadow:0 2px 12px rgba(0,0,0,.07);margin-bottom:36px">
      ${intro.split('\n\n').map(p => `<p style="line-height:1.78;color:#333;font-size:.97rem;margin-bottom:16px">${p}</p>`).join('')}
      <p style="margin-bottom:0"><a href="/" style="display:inline-block;background:#1b4332;color:#fff;border-radius:50px;padding:10px 24px;text-decoration:none;font-weight:700;font-size:.88rem;margin-top:8px">Kostenlosen Bepflanzungsplan erstellen →</a></p>
    </div>
    <h2 style="font-size:1.2rem;color:#1b4332;margin-bottom:20px;font-weight:700">${pflanzen.length} Stauden für diesen Standort</h2>
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:14px">
      ${pflanzenHtml}
    </div>
    ${artikelHtml}
    <div style="background:linear-gradient(135deg,#1b4332,#2d6a4f);color:#fff;border-radius:14px;padding:28px;margin-top:48px;text-align:center">
      <h2 style="font-size:1.2rem;margin-bottom:8px">KI-Bepflanzungsplan für deinen Garten</h2>
      <p style="opacity:.88;font-size:.9rem;margin-bottom:18px">Unser KI-Planer wählt aus ${pflanzen.length}+ passenden Stauden die besten für deinen Standort — kostenlos und in 2 Minuten.</p>
      <a href="/" style="background:#fff;color:#1b4332;border-radius:50px;padding:12px 30px;text-decoration:none;font-weight:700;font-size:.9rem;display:inline-block">Kostenlosen Plan erstellen →</a>
    </div>
  </main>
  ${SITE_FOOTER}
  </body></html>`;
}

app.get('/stauden-fuer-schatten', (req, res) => {
  const pflanzen = db.prepare(`SELECT name_deutsch, name_botanisch, bild_url, bluehzeit, licht FROM pflanzen WHERE licht LIKE '%Schatten%' ORDER BY name_deutsch`).all();
  let artikel = [];
  try { artikel = db.prepare(`SELECT titel FROM wissen WHERE titel LIKE '%Schatten%' OR inhalt LIKE '%Schattenbeet%' LIMIT 4`).all(); } catch {}
  res.send(kategorieSeitenHTML({
    slug: 'stauden-fuer-schatten',
    titel: 'Stauden für Schatten — Die besten Schattenstauden für deutsche Gärten',
    metaDesc: `${pflanzen.length} winterharte Stauden für schattige Beete: Welche Pflanzen gedeihen unter Bäumen, an der Nordseite oder im tiefen Schatten? Mit Pflanzplan-Tool.`,
    h1: 'Stauden für Schatten',
    intro: `Schattige Gartenbereiche gelten als Herausforderung — dabei bieten sie eine einzigartige Möglichkeit für elegante, ruhige Pflanzungen. Unter Bäumen, an schattigen Hauswänden oder in nordexponierten Beeten gedeihen zahlreiche winterharte Stauden, die dort ihre beste Qualität zeigen: satte Blattstrukturen, kühle Blautöne, zarte Frühlingsblüher.\n\nDie wichtigsten Schattenstauden teilen sich in zwei Gruppen: Halbschatten-Pflanzen (2–4 Stunden direktes Sonnenlicht) wie Astilbe, Hosta, Geranium oder Rodgersia — und echte Tiefschatten-Pflanzen (unter 2 Stunden Sonne) wie Elfenblume (Epimedium), Waldsteinia oder Bärlauch-Verwandte. Entscheidend ist außerdem der Boden: Unter Bäumen herrscht oft Wurzelkonkurrenz und Trockenheit, was robuste Arten wie Epimedium oder Waldsteinia bevorzugt.\n\nMit unserem kostenlosen KI-Bepflanzungsplan gibst du einfach deinen Standort ein — Halbschatten oder tiefer Schatten, Bodentyp, Größe — und erhältst einen maßgeschneiderten Plan mit winterharten Schattenstauden für genau deinen Garten.`,
    pflanzen,
    artikelLinks: artikel,
  }));
});

app.get('/stauden-fuer-sonne', (req, res) => {
  const pflanzen = db.prepare(`SELECT name_deutsch, name_botanisch, bild_url, bluehzeit, licht FROM pflanzen WHERE licht LIKE '%Sonne%' ORDER BY name_deutsch`).all();
  let artikel = [];
  try { artikel = db.prepare(`SELECT titel FROM wissen WHERE titel LIKE '%sonn%' OR titel LIKE '%Kiesgarten%' OR titel LIKE '%trocken%' LIMIT 4`).all(); } catch {}
  res.send(kategorieSeitenHTML({
    slug: 'stauden-fuer-sonne',
    titel: 'Stauden für Sonne — Sonnenpflanzen für das Staudenbeet',
    metaDesc: `${pflanzen.length} winterharte Stauden für vollsonnige Standorte: Von pflegeleicht bis üppig blühend — die besten Sonnenpflanzen für deinen Garten.`,
    h1: 'Stauden für Sonne',
    intro: `Vollsonnige Standorte sind im deutschen Garten am häufigsten — und bieten die größte Auswahl an winterharten Stauden. Vom pflegeleichten Kiesgarten bis zum üppigen Bauerngarten: Sonnenpflanzen bilden das Rückgrat des klassischen Staudenbeetes.\n\nBesonders bewährt haben sich für sonnige Beete: Ziersalbei (Salvia nemorosa) mit langen Blütezeiten, Sonnenhut (Echinacea) als Schmetterlingspflanze, Schafgarbe (Achillea) in vielen Farben, Lavendel für mediterranes Flair und Katzenminze (Nepeta) als vielseitiger Beeteinfasser. Für trockene, sandige Böden eignen sich außerdem Sedum, Stachys byzantina und Santolina.\n\nUnser KI-Planer hilft dir, aus über ${pflanzen.length} sonnigen Staudenarten die beste Kombination für dein Beet zu erstellen — abgestimmt auf Größe, Bodentyp und deinen Gartenstil.`,
    pflanzen,
    artikelLinks: artikel,
  }));
});

app.get('/pflegeleichte-stauden', (req, res) => {
  const pflanzen = db.prepare(`SELECT name_deutsch, name_botanisch, bild_url, bluehzeit, licht, pflege_sterne FROM pflanzen WHERE pflege_sterne = 1 ORDER BY name_deutsch`).all();
  let artikel = [];
  try { artikel = db.prepare(`SELECT titel FROM wissen WHERE titel LIKE '%pflegeleicht%' OR inhalt LIKE '%pflegeleicht%' LIMIT 4`).all(); } catch {}
  res.send(kategorieSeitenHTML({
    slug: 'pflegeleichte-stauden',
    titel: 'Pflegeleichte Stauden — Wenig Arbeit, viel Wirkung im Garten',
    metaDesc: `${pflanzen.length} winterharte Stauden mit minimalem Pflegeaufwand: Einmal pflanzen, dauerhaft schön — die besten pflegeleichten Gartenstauden.`,
    h1: 'Pflegeleichte Stauden',
    intro: `Pflegeleichte Stauden sind die ehrlichste Investition im Garten: Einmal gut gepflanzt, gedeihen sie Jahr für Jahr ohne großen Aufwand. Kein Gießen in trockenen Sommern, kein aufwendiger Rückschnitt, keine jährliche Neubepflanzung.\n\nDie pflegeleichtesten Gartenstauden vereinen drei Eigenschaften: Sie sind trockenheitstolerant, behaupten sich gegen Unkraut und sind robust gegen Schädlinge. Zu den bewährtesten Kandidaten zählen Storchschnabel (Geranium), Elfenblume (Epimedium), Schafgarbe (Achillea), Herbst-Fettblatt (Sedum), Katzenminze (Nepeta) und Stauden-Geranium (Geranium macrorrhizum).\n\nFür das "Einmal pflanzen, fertig"-Konzept empfiehlt sich außerdem, Bodendecker wie Waldsteinia oder Lamium mit höherwachsenden Strukturstauden zu kombinieren: Das unterdrückt Unkraut und schafft ein dauerhaft attraktives Beet ohne Wochenendeinsatz.`,
    pflanzen,
    artikelLinks: artikel,
  }));
});

app.get('/bienenfreundliche-stauden', (req, res) => {
  const pflanzen = db.prepare(`SELECT name_deutsch, name_botanisch, bild_url, bluehzeit, licht FROM pflanzen WHERE bienen_freundlich = 1 ORDER BY name_deutsch`).all();
  let artikel = [];
  try { artikel = db.prepare(`SELECT titel FROM wissen WHERE titel LIKE '%Bien%' OR titel LIKE '%Insekt%' OR inhalt LIKE '%Trachtpflanze%' LIMIT 4`).all(); } catch {}
  res.send(kategorieSeitenHTML({
    slug: 'bienenfreundliche-stauden',
    titel: 'Bienenfreundliche Stauden — Trachtpflanzen für den Garten',
    metaDesc: `${pflanzen.length} winterharte Stauden für Bienen, Hummeln und Schmetterlinge — die besten Trachtpflanzen für einen insektenfreundlichen Garten.`,
    h1: 'Bienenfreundliche Stauden',
    intro: `Ein bienenfreundlicher Garten ist mehr als ein ökologisches Zeichen — er ist attraktiver, lebendiger und oft einfacher zu pflegen, da heimische Bestäuber das ökologische Gleichgewicht stützen. Entscheidend für den Bienenwert einer Staude ist die Blütenstruktur: Einfache, offene Blüten mit sichtbaren Staubblättern sind Nektar- und Pollenquellen, während gefüllte Zuchtformen oft wertlos für Insekten sind.\n\nDie besten Bienenstauden decken die ganze Saison ab: Lungenkraut (Pulmonaria) im Frühjahr, Salvia nemorosa und Katzenminze im Frühsommer, Sonnenhut (Echinacea) und Flockenblume (Centaurea) im Sommer, Herbstaster und Fetthenne (Sedum) im Herbst. Dieses "Nektarband" von März bis Oktober ist das Ziel eines echten Bienengartens.\n\nUnser KI-Bepflanzungsplan wählt automatisch bienenfreundliche Kombinationen aus, wenn du "Bienengarten" als Gartennutzung angibst — abgestimmt auf deinen Standort und Gartenstil.`,
    pflanzen,
    artikelLinks: artikel,
  }));
});

app.get('/staudenbeet-planen', (req, res) => {
  const pflanzenCount = db.prepare("SELECT COUNT(*) as n FROM pflanzen").get().n;
  let artikel = [];
  try { artikel = db.prepare(`SELECT titel FROM wissen WHERE titel LIKE '%plan%' OR titel LIKE '%Planung%' OR inhalt LIKE '%Bepflanzungsplan%' LIMIT 5`).all(); } catch {}
  const artikelHtml = artikel.map(a => `<a href="/ratgeber/${slugify(a.titel)}" style="display:flex;align-items:center;gap:10px;background:#fff;border-radius:10px;padding:14px 18px;text-decoration:none;box-shadow:0 2px 8px rgba(0,0,0,.06);transition:background .12s;margin-bottom:10px" onmouseover="this.style.background='#f0fdf4'" onmouseout="this.style.background='#fff'"><span style="font-size:1.2rem">📖</span><span style="font-size:.9rem;font-weight:600;color:#1b4332">${a.titel}</span><span style="margin-left:auto;color:#2d6a4f;font-weight:700;font-size:.82rem">Lesen →</span></a>`).join('');
  res.send(`<!DOCTYPE html><html lang="de"><head>
  <meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Staudenbeet planen — Kostenloser Online-Planer mit KI | Staudenplan.de</title>
  <meta name="description" content="Staudenbeet kostenlos online planen: KI-Bepflanzungsplan in 2 Minuten — mit ${pflanzenCount} winterharten Stauden, Pflanzplan-Grafik und Stückliste.">
  <link rel="canonical" href="https://www.staudenplan.de/staudenbeet-planen">
  <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🌿</text></svg>">
  <style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:'Segoe UI',system-ui,sans-serif;background:#f8f4ef;color:#1a1a1a}</style>
  </head><body>
  ${NAV_LINKS}
  <div style="background:linear-gradient(160deg,#1b4332,#2d6a4f);color:#fff;padding:56px 24px 48px;text-align:center">
    <h1 style="font-size:clamp(1.6rem,4vw,2.2rem);font-weight:800;line-height:1.2;margin-bottom:14px">Staudenbeet online planen — kostenlos & mit KI</h1>
    <p style="opacity:.88;max-width:620px;margin:0 auto 28px;font-size:1rem;line-height:1.65">Standort, Größe und Stil eingeben — unser KI-Planer erstellt deinen individuellen Bepflanzungsplan mit ${pflanzenCount} winterharten Stauden.</p>
    <a href="/" style="background:#fff;color:#1b4332;border-radius:50px;padding:15px 40px;text-decoration:none;font-weight:800;font-size:1rem;display:inline-block">Jetzt kostenlosen Plan erstellen →</a>
  </div>
  <main style="max-width:900px;margin:0 auto;padding:48px 20px 60px">
    <div style="background:#fff;border-radius:14px;padding:28px;box-shadow:0 2px 12px rgba(0,0,0,.07);margin-bottom:36px">
      <h2 style="font-size:1.2rem;color:#1b4332;margin-bottom:16px;font-weight:700">So funktioniert der KI-Bepflanzungsplan</h2>
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:16px;margin-bottom:20px">
        ${[['1','Garten beschreiben','Fläche, Lichtbedingungen, Bodentyp und Gartenstil eingeben — oder Fläche direkt einzeichnen.'],['2','KI generiert deinen Plan',`Unsere KI durchsucht ${pflanzenCount} geprüfte Stauden und erstellt einen standortgerechten Plan.`],['3','Pflanzen bestellen','Mit Stückliste, grafischem Pflanzplan und Jahreskalender. Komplettpaket direkt bestellbar.']].map(([n,t,s]) => `<div style="background:#f8f4ef;border-radius:10px;padding:18px"><div style="background:#2d6a4f;color:#fff;width:28px;height:28px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:.88rem;margin-bottom:10px">${n}</div><h3 style="font-size:.95rem;font-weight:700;color:#1b4332;margin-bottom:6px">${t}</h3><p style="font-size:.83rem;color:#555;line-height:1.6">${s}</p></div>`).join('')}
      </div>
      <h2 style="font-size:1.1rem;color:#1b4332;margin-bottom:12px;font-weight:700">Was kostet ein Bepflanzungsplan?</h2>
      <p style="line-height:1.75;color:#333;font-size:.95rem;margin-bottom:12px">Unser KI-Bepflanzungsplan ist vollständig <strong>kostenlos und ohne Anmeldung</strong>. Ein professioneller Gartenplaner kostet für einen einfachen Plan oft 150–500 €. Unser Tool liefert einen ähnlich individualisierten Plan — in 2 Minuten, rund um die Uhr, für 0 €.</p>
      <p style="line-height:1.75;color:#333;font-size:.95rem">Die einzigen Kosten entstehen beim optionalen Kauf der empfohlenen Pflanzen. Der Plan selbst ist und bleibt kostenlos.</p>
    </div>
    ${artikel.length > 0 ? `<h2 style="font-size:1.15rem;color:#1b4332;margin-bottom:16px;font-weight:700">📚 Ratgeber: Staudenbeet richtig planen</h2>${artikelHtml}` : ''}
  </main>
  ${SITE_FOOTER}
  </body></html>`);
});

app.get('/stauden-kombinieren', (req, res) => {
  const pflanzen = db.prepare(`SELECT name_deutsch, name_botanisch, bild_url, bluehzeit, licht FROM pflanzen ORDER BY RANDOM() LIMIT 48`).all();
  let artikel = [];
  try { artikel = db.prepare(`SELECT titel FROM wissen WHERE titel LIKE '%kombin%' OR titel LIKE '%Kombination%' OR titel LIKE '%Schichten%' OR titel LIKE '%Farbgest%' LIMIT 5`).all(); } catch {}
  res.send(kategorieSeitenHTML({
    slug: 'stauden-kombinieren',
    titel: 'Stauden kombinieren — Bewährte Pflanzenkombinationen für das Staudenbeet',
    metaDesc: 'Stauden richtig kombinieren: Farbharmonien, Höhenstaffelung, Saisonstaffelung — mit Pflanzbeispielen, Praxistipps und kostenlosem KI-Pflanzplan.',
    h1: 'Stauden kombinieren',
    intro: `Die Kunst des Staudenkombinierens liegt im Zusammenspiel von Blühzeit, Höhe, Farbe und Textur. Eine gelungene Kombination sieht nicht nur im Hochsommer gut aus, sondern vom frühen Frühjahr bis in den Winteraspekt hinein.\n\nDrei Grundregeln erleichtern den Einstieg: Erstens, Höhenstaffelung beachten — hohe Strukturpflanzen (Miscanthus, Rudbeckia) hinten, mittelhohe Blütenstauden in der Mitte (Salvia, Echinacea), niedrige Bodendecker vorne (Geranium, Nepeta). Zweitens, Blühzeiten überlappen lassen — immer mindestens eine blühende Staude pro Saison einplanen. Drittens, Farbkontraste oder Farbharmonien wählen — Blau-Violett mit Gelb für Spannung, Rosa-Weiß für Eleganz.\n\nBewährte Dreier-Kombinationen: Salvia nemorosa + Achillea 'Moonshine' + Geranium sanguineum (sonnig, trocken); Astilbe + Hosta + Geranium macrorrhizum (Halbschatten, feucht); Echinacea + Rudbeckia + Pennisetum (sonnig, Sommerflor bis Herbst).`,
    pflanzen,
    artikelLinks: artikel,
  }));
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

  // Passende Pflanzen zum Artikel (interne Verlinkung)
  const artikelWoerter = artikel.titel.toLowerCase() + ' ' + artikel.inhalt.toLowerCase();

  const hatHeckenThema = artikelWoerter.includes('hecke') || artikelWoerter.includes('sichtschutz');
  const heckenKostenHtml = hatHeckenThema ? `
    <div style="background:#f0fdf4;border:1px solid #b7e4c7;border-radius:12px;padding:18px 20px;margin:32px 0;display:flex;align-items:flex-start;gap:12px">
      <span style="font-size:1.4rem;flex-shrink:0">💡</span>
      <div>
        <p style="font-size:.88rem;color:#1b4332;line-height:1.6"><strong>Hecke als Sichtschutz geplant?</strong> Was die Bepflanzung einer Hecke kostet, erklärt <a href="https://gartenbau-kosten.de/hecke/hecke-bepflanzung-kosten/" target="_blank" rel="noopener" style="color:#2d6a4f;font-weight:600">gartenbau-kosten.de → Hecke Bepflanzung Kosten</a></p>
      </div>
    </div>` : '';
  const cfg = katCfg(artikel.kategorie);
  const lesezeit = readingTime(artikel.inhalt);

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

  // Botanische Pflanzennamen im Artikeltext automatisch verlinken
  let artikelInhalt = artikel.inhalt;
  try {
    const pflanzenLinks = db.prepare('SELECT name_botanisch FROM pflanzen WHERE name_botanisch IS NOT NULL ORDER BY length(name_botanisch) DESC').all();
    for (const { name_botanisch } of pflanzenLinks) {
      const idx = artikelInhalt.indexOf(name_botanisch);
      if (idx !== -1) {
        const s = pflanzeToSlug(name_botanisch);
        artikelInhalt = artikelInhalt.substring(0, idx) +
          `<a href="/pflanze/${s}" style="color:#2d6a4f;font-weight:600;text-decoration:none;border-bottom:1px solid #b7e4c7">${name_botanisch}</a>` +
          artikelInhalt.substring(idx + name_botanisch.length);
      }
    }
  } catch {}

  // Absätze mit Pull-Quote auf zweitem Absatz
  const absaetzeRaw = artikelInhalt.split('\n').filter(l => l.trim());
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

      ${heckenKostenHtml}
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

const BLOOM_COLORS_SSR = {
  'Rosa':'#f472b6','Pink':'#f472b6','Purpur':'#a855f7','Lila':'#a855f7','Violett':'#818cf8',
  'Blau':'#3b82f6','Weiß':'#e2e8f0','Weiss':'#e2e8f0','Creme':'#fef3c7',
  'Gelb':'#facc15','Orange':'#fb923c','Rot':'#ef4444','Weinrot':'#b91c1c',
  'Grün':'#4ade80','Gruen':'#4ade80','Silber':'#d1d5db','Bronze':'#d97706',
};
function bloomColorSSR(farbe) {
  if (!farbe) return '#86efac';
  const k = (farbe.split(/[|,]/)[0] || '').trim();
  return BLOOM_COLORS_SSR[k] || '#86efac';
}
function hexLightenSSR(hex, amt) {
  const n = parseInt(hex.replace('#',''), 16);
  return '#' + [n>>16, (n>>8)&0xff, n&0xff]
    .map(v => Math.min(255, v+amt).toString(16).padStart(2,'0')).join('');
}
function hexDarkenSSR(hex, amt) { return hexLightenSSR(hex, -amt); }

function renderGrafischSSR(pflanzen, flaeche) {
  const W = 720, H = Math.round(720 * 0.48), PAD = 16;
  const bedW = W - PAD * 2, bedH = H - PAD * 2;
  const gartW = parseFloat(Math.sqrt(flaeche * 3).toFixed(1));
  const gartH = parseFloat((flaeche / gartW).toFixed(1));

  const all = [];
  pflanzen.forEach((p, pi) => {
    const n = p.stueckzahl || 1;
    const h = p.hoehe_cm || 50;
    const yZone = 1 - Math.min(0.85, (h / 160) * 0.7 + 0.15);
    for (let i = 0; i < n; i++) {
      const seed = pi * 37 + i * 19;
      const xRand = (Math.sin(seed * 127.1 + 0.3) * 0.5 + 0.5);
      const yRand = (Math.sin(seed * 311.7 + 1.1) * 0.5 + 0.5) * 0.28 - 0.14;
      const xBase = (pi / pflanzen.length) + (i + 0.5) / (pflanzen.length * n);
      const x = (xBase + (xRand - 0.5) * 0.12) * bedW;
      const y = (yZone + yRand) * bedH;
      all.push({
        x: Math.max(0.06 * bedW, Math.min(0.94 * bedW, x)),
        y: Math.max(0.06 * bedH, Math.min(0.94 * bedH, y)),
        pflanze: p, pi
      });
    }
  });

  const gradDefs = pflanzen.map((p, pi) => {
    const c = bloomColorSSR(p.farbe);
    return `<radialGradient id="pg${pi}" cx="35%" cy="35%" r="65%">
      <stop offset="0%" stop-color="${hexLightenSSR(c,50)}"/>
      <stop offset="60%" stop-color="${c}"/>
      <stop offset="100%" stop-color="${hexDarkenSSR(c,30)}"/>
    </radialGradient>`;
  }).join('');

  const soilDots = Array.from({length:120}, (_,i) => {
    const sx = 20 + (i * 73.1) % (bedW - 30);
    const sy = 10 + (i * 47.3) % (bedH - 20);
    return `<circle cx="${PAD+sx}" cy="${PAD+sy}" r="1.2" fill="rgba(0,0,0,.12)"/>`;
  }).join('');

  const meterPxX = bedW / gartW, meterPxY = bedH / gartH;
  const gridLines = [];
  for (let x = meterPxX; x < bedW; x += meterPxX)
    gridLines.push(`<line x1="${(PAD+x).toFixed(1)}" y1="${PAD}" x2="${(PAD+x).toFixed(1)}" y2="${PAD+bedH}" stroke="rgba(255,255,255,.12)" stroke-width="1" stroke-dasharray="4,4"/>`);
  for (let y = meterPxY; y < bedH; y += meterPxY)
    gridLines.push(`<line x1="${PAD}" y1="${(PAD+y).toFixed(1)}" x2="${PAD+bedW}" y2="${(PAD+y).toFixed(1)}" stroke="rgba(255,255,255,.12)" stroke-width="1" stroke-dasharray="4,4"/>`);

  const circles = [...all].sort((a,b) => a.y - b.y).map(({x, y, pflanze, pi}) => {
    const r = Math.max(11, Math.min(26, (pflanze.hoehe_cm || 50) / 5.5));
    const num = pflanzen.findIndex(pp => pp.name_botanisch === pflanze.name_botanisch) + 1;
    return `<g>
      <circle cx="${(PAD+x).toFixed(1)}" cy="${(PAD+y).toFixed(1)}" r="${(r+2).toFixed(1)}" fill="rgba(0,0,0,.2)"/>
      <circle cx="${(PAD+x).toFixed(1)}" cy="${(PAD+y).toFixed(1)}" r="${r.toFixed(1)}" fill="url(#pg${pi})" stroke="rgba(255,255,255,.6)" stroke-width="1.5"/>
      <text x="${(PAD+x).toFixed(1)}" y="${(PAD+y+4).toFixed(1)}" text-anchor="middle" font-size="${Math.max(8, r*0.55).toFixed(1)}px" font-weight="800" fill="rgba(0,0,0,.6)" font-family="system-ui">${num}</text>
    </g>`;
  }).join('');

  const scaleY = PAD + bedH + 8;
  const svg = `<svg width="${W}" height="${H+24}" xmlns="http://www.w3.org/2000/svg" style="max-width:100%;border-radius:12px;display:block">
    <defs>
      ${gradDefs}
      <linearGradient id="soilGrad" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#7a5230"/>
        <stop offset="100%" stop-color="#4e3019"/>
      </linearGradient>
      <clipPath id="bedClip"><rect x="${PAD}" y="${PAD}" width="${bedW}" height="${bedH}" rx="8"/></clipPath>
    </defs>
    <rect x="${PAD}" y="${PAD}" width="${bedW}" height="${bedH}" rx="8" fill="url(#soilGrad)"/>
    <g clip-path="url(#bedClip)">${soilDots}${gridLines.join('')}</g>
    <rect x="${PAD}" y="${PAD}" width="${bedW}" height="${bedH}" rx="8" fill="none" stroke="#a0714f" stroke-width="2.5"/>
    <g clip-path="url(#bedClip)">${circles}</g>
    <text x="${W/2}" y="${PAD-4}" text-anchor="middle" font-size="10" fill="#888" font-family="system-ui">↑ Hinten (${gartW} m)</text>
    <text x="8" y="${PAD+bedH/2}" text-anchor="middle" font-size="10" fill="#888" font-family="system-ui" transform="rotate(-90,8,${PAD+bedH/2})">${gartH} m</text>
    <rect x="${PAD+10}" y="${scaleY}" width="${Math.round(meterPxX)}" height="5" rx="2" fill="#666"/>
    <text x="${PAD+10}" y="${scaleY+14}" font-size="10" fill="#888" font-family="system-ui">1 m</text>
    <text x="${W/2}" y="${scaleY+14}" text-anchor="middle" font-size="10" fill="#aaa" font-family="system-ui">Vorne (${gartW} m)</text>
  </svg>`;

  const legend = pflanzen.map((p, i) => {
    const c = bloomColorSSR(p.farbe);
    return `<div class="vl-item">
      <span class="vl-num">${i+1}</span>
      <span class="vl-dot" style="background:${c}"></span>
      <span>${p.name_deutsch}</span>
      ${p.bluehzeit ? `<span style="color:#999;font-size:.72rem">${p.bluehzeit}</span>` : ''}
    </div>`;
  }).join('');

  return `<div class="viz-card">
    <div class="viz-card-title">🎨 Grafischer Bepflanzungsplan — Draufsicht</div>
    <div class="viz-card-body">
      <div class="viz-svg-wrap">${svg}</div>
      <div class="viz-legend">${legend}</div>
    </div>
  </div>`;
}

function renderBeispielPlanSSR(plan, flaeche) {
  if (!plan || !plan.pflanzen) return '';
  const emojis = ['🌸','🌺','🌼','🌻','🌹','💐','🌷','🌿','🍃','🌾'];
  const jez = {'Frühling':'🌱','Sommer':'☀️','Herbst':'🍂','Winter':'❄️'};
  const pflanzen = plan.pflanzen;

  const gesamt = pflanzen.reduce((s,p) => s + (p.stueckzahl||0), 0);
  const meta = `<div class="em-bar">
    <div class="em-item"><strong>${pflanzen.length}</strong> Pflanzenarten</div>
    <div class="em-item"><strong>${gesamt}</strong> Pflanzen gesamt</div>
    <div class="em-item"><strong>${plan.gesamtkosten_geschaetzt||'–'} €</strong> Gesamtkosten ca.</div>
  </div>`;

  const cards = pflanzen.map((p, i) => {
    const c = bloomColorSSR(p.farbe);
    const cLight = hexLightenSSR(c, 40);
    const farbenTag = p.farbe
      ? `<span class="tag" style="background:${hexLightenSSR(c,50)};color:${hexDarkenSSR(c,40)}">${p.farbe}</span>` : '';
    const st = Math.min(p.pflege_sterne || 1, 3);
    const stars = '★'.repeat(st) + '☆'.repeat(3 - st);
    const preis = ((p.preis_stueck_eur||0) * (p.stueckzahl||1)).toFixed(2);
    const imgTop = p.bild_url
      ? `<img src="${p.bild_url}" alt="${p.name_deutsch}" style="width:100%;height:100%;object-fit:cover;display:block" loading="lazy">`
      : `<div style="font-size:2.2rem;display:flex;align-items:center;justify-content:center;height:100%">${emojis[i%10]}</div>`;
    return `<div class="pflanze-card">
      <div class="pflanze-card-top" style="background:linear-gradient(135deg,${cLight},${c})">${imgTop}</div>
      <div class="pflanze-card-body">
        <div class="pflanze-name">${p.name_deutsch}</div>
        <div class="pflanze-botanisch">${p.name_botanisch||''}</div>
        <div class="pflanze-beschreibung">${p.beschreibung||''}</div>
        <div class="pflanze-tags">
          <span class="tag">☀️ ${p.standort||''}</span>
          <span class="tag">🌸 ${p.bluehzeit||''}</span>
          ${farbenTag}
          <span class="tag tag-erde">↕ ${p.hoehe_cm||'?'} cm</span>
          <span class="tag tag-stueck">× ${p.stueckzahl||1} Stück</span>
        </div>
        <div class="pflanze-preis">
          <span>Pflege: <span class="pflege-sterne">${stars}</span></span>
          <strong>${preis} €</strong>
        </div>
        <a class="btn-kaufen" href="${p.kauflink||'/'}" target="_blank" rel="noopener">Kaufen →</a>
      </div>
    </div>`;
  }).join('');

  const kal = Object.entries(plan.pflanzkalender || {}).map(([jz, items]) => {
    const icon = jez[jz] || '📅';
    const liItems = (Array.isArray(items) ? items : [items]).map(it => `<li>${it}</li>`).join('');
    return `<div class="kalender-card"><h4>${icon} ${jz}</h4><ul>${liItems}</ul></div>`;
  }).join('');

  const tippsAll = (plan.tipps||[]).concat(plan.pflanzabstand_hinweis ? [plan.pflanzabstand_hinweis] : []);
  const tippsList = tippsAll.map(t => `<li>${t}</li>`).join('');

  const grafisch = flaeche ? renderGrafischSSR(pflanzen, flaeche) : '';

  return `<div class="card-wrap">
    <h2 class="sec-title">🌿 KI-Pflanzplan für dieses Beet</h2>
    ${meta}
    ${grafisch}
    <p class="sec-title" style="font-size:.95rem;margin-top:8px">Pflanzenauswahl</p>
    <div class="pflanzen-grid">${cards}</div>
    ${kal ? `<p class="sec-title" style="font-size:.95rem">Jahreskalender</p><div class="kalender-grid">${kal}</div>` : ''}
    ${tippsList ? `<p class="sec-title" style="font-size:.95rem">Pflegetipps</p><ul class="tipps-list">${tippsList}</ul>` : ''}
    ${plan.beetbeschreibung ? `<p style="color:#444;line-height:1.75;font-size:.92rem;margin-top:16px;padding-top:16px;border-top:1px solid #eee">${plan.beetbeschreibung}</p>` : ''}
  </div>`;
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

app.get('/api/beispiel-plan/:slug', (req, res) => {
  const plan = loadBeispielPlan(req.params.slug);
  if (!plan) return res.status(404).json({ error: 'Plan nicht gefunden' });
  res.json({ success: true, plan });
});

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
${NAV_LINKS}
<style>
:root{--gd:#1b4332;--gm:#2d6a4f;--gl:#52b788;--gp:#f0faf3;--ea:#7d4f2a;--tx:#222;--tl:#666;--r:12px;--sh:0 2px 10px rgba(0,0,0,.07)}
.pflanzen-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:16px;margin-bottom:36px}
.pflanze-card{background:#fff;border-radius:var(--r);box-shadow:var(--sh);overflow:hidden;transition:transform .15s}
.pflanze-card:hover{transform:translateY(-3px)}
.pflanze-card-top{height:140px;overflow:hidden;position:relative}
.pflanze-card-body{padding:16px 18px 18px}
.pflanze-name{font-weight:700;font-size:1rem;color:var(--gd);margin-bottom:2px}
.pflanze-botanisch{font-size:.78rem;color:var(--tl);font-style:italic;margin-bottom:8px}
.pflanze-beschreibung{font-size:.85rem;color:var(--tx);line-height:1.5;margin-bottom:12px}
.pflanze-tags{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:12px}
.tag{background:var(--gp);color:var(--gd);border-radius:6px;padding:3px 9px;font-size:.75rem;font-weight:500}
.tag-erde{background:#f3e5d0;color:var(--ea)}
.tag-stueck{background:#e8f4f8;color:#1a607a}
.pflanze-preis{display:flex;align-items:center;justify-content:space-between;font-size:.88rem;color:var(--tl);margin-bottom:12px}
.pflanze-preis strong{color:var(--ea);font-size:1rem}
.pflege-sterne{color:var(--gl);letter-spacing:2px}
.btn-kaufen{display:block;width:100%;background:var(--gm);color:#fff;border:none;border-radius:8px;padding:10px;font-size:.9rem;font-weight:600;text-decoration:none;text-align:center;cursor:pointer;transition:background .15s;box-sizing:border-box}
.btn-kaufen:hover{background:var(--gd)}
.kalender-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:12px;margin-bottom:36px}
.kalender-card{background:#fff;border-radius:var(--r);box-shadow:var(--sh);padding:16px}
.kalender-card h4{font-size:.95rem;color:var(--gd);margin:0 0 10px}
.kalender-card ul{list-style:none;padding:0;margin:0}
.kalender-card ul li{font-size:.83rem;color:var(--tl);padding:3px 0;display:flex;gap:6px}
.kalender-card ul li::before{content:'→';color:var(--gl);flex-shrink:0}
.tipps-list{background:var(--gp);border-radius:var(--r);padding:20px 24px;margin-bottom:36px}
.tipps-list li{font-size:.9rem;color:var(--gd);padding:6px 0;display:flex;gap:10px;list-style:none}
.tipps-list li::before{content:'🌿';flex-shrink:0}
.em-bar{display:flex;gap:16px;flex-wrap:wrap;background:var(--gp);border-radius:10px;padding:16px 20px;margin-bottom:24px}
.em-item{font-size:.85rem;color:var(--tl)}
.em-item strong{display:block;font-size:1.1rem;color:var(--gd)}
.sec-title{font-size:1.1rem;font-weight:700;color:var(--gd);margin:0 0 16px;display:flex;align-items:center;gap:8px}
.card-wrap{background:#fff;border-radius:14px;padding:28px 20px;box-shadow:0 2px 12px rgba(0,0,0,.07);margin-bottom:24px}
.viz-card{background:#fff;border-radius:var(--r);box-shadow:var(--sh);overflow:hidden;margin-bottom:20px}
.viz-card-title{background:var(--gd);color:#fff;padding:12px 20px;font-size:.9rem;font-weight:700}
.viz-card-body{padding:20px}
.viz-svg-wrap{overflow-x:auto}
.viz-legend{display:flex;flex-wrap:wrap;gap:8px;margin-top:16px;padding-top:16px;border-top:1px solid var(--gp)}
.vl-item{display:flex;align-items:center;gap:6px;font-size:.8rem;color:var(--tx);background:var(--gp);border-radius:6px;padding:4px 10px}
.vl-num{background:var(--gm);color:#fff;border-radius:50%;width:18px;height:18px;display:inline-flex;align-items:center;justify-content:center;font-size:.68rem;font-weight:700;flex-shrink:0}
.vl-dot{width:12px;height:12px;border-radius:50%;flex-shrink:0;border:1.5px solid rgba(0,0,0,.15)}
</style>
</head><body style="font-family:system-ui,sans-serif;background:#f6faf7;margin:0">

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

<div style="max-width:900px;margin:0 auto;padding:32px 16px 60px">

  <div class="card-wrap">
    <h2 class="sec-title">Standort auf einen Blick</h2>
    ${steckbriefHtml}
    <p style="color:#444;line-height:1.75;margin-bottom:10px">${b.intro}</p>
    <p style="color:#444;line-height:1.75">${b.intro2}</p>
  </div>

  ${renderBeispielPlanSSR(plan, b.flaeche)}

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
