require('dotenv').config();
const express = require('express');
const Database = require('better-sqlite3');
const nodemailer = require('nodemailer');
const rateLimit = require('express-rate-limit');
// Rate-Limiter-Fabrik: nur im lokalen Eval-Modus (RATE_LIMIT_DISABLED=1) zu No-Ops,
// damit der Eval-Harness >10 Plan-Calls fahren kann. In Prod nie gesetzt → echte Limits.
const rl = (opts) => process.env.RATE_LIMIT_DISABLED === '1' ? ((req, res, next) => next()) : rateLimit(opts);
const { OpenAI } = require('openai');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
// Kuratierte Giftigkeits-Einstufung auf Gattungsebene. Bewusst eine Liste im Code und kein
// DB-Feld: Die Warnung muss über den ganzen Bestand einheitlich sein und darf nicht davon
// abhängen, ob eine einzelne Zeile schon durch einen Datenlauf gegangen ist.
const { giftigkeit, istKindersicher, kindersicherGrund } = require('./scripts/pflanzen-giftigkeit');

const app = express();
const PORT = process.env.PORT || 3000;

// nginx läuft als einziger Reverse-Proxy davor (siehe DEPLOY.md) — ohne das hier
// gruppiert express-rate-limit alle Besucher unter der nginx-Loopback-Adresse in
// einen einzigen Rate-Limit-Bucket statt pro echter Client-IP.
app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use(express.json({ limit: '2mb' })); // 2mb statt Default 100kb: Anfragen tragen den ganzen ki_plan mit

// Security-Header. CSP erlaubt 'unsafe-inline' für script/style, weil die Seite
// durchgängig Inline-<script>/-style="" nutzt (kein Nonce/Hash-Rewrite ohne
// Komplettumbau möglich) — blockt aber trotzdem das Nachladen fremder Scripts/
// Bilder/Frames sowie Base-Tag- und Clickjacking-Angriffe. Externe Scripts:
// Plausible Analytics + jsPDF/autotable von cdnjs (PDF-Export) — alle Bilder self-hosted.
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' https://plausible.io https://cdnjs.cloudflare.com",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self' https://plausible.io",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'self'",
].join('; ');
app.use((req, res, next) => {
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  res.setHeader('Content-Security-Policy', CSP);
  next();
});

// www-Redirect: staudenplan.de → www.staudenplan.de (301)
app.use((req, res, next) => {
  if (req.hostname === 'staudenplan.de') {
    return res.redirect(301, 'https://www.staudenplan.de' + req.url);
  }
  next();
});

// Veraltete public/index.html (Alt-Kopie der Startseite) nie ausliefern → 301 auf die aktuelle App
app.get('/index.html', (req, res) => res.redirect(301, '/'));

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

  CREATE TABLE IF NOT EXISTS klicks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    erstellt_am TEXT DEFAULT (datetime('now')),
    ziel TEXT NOT NULL,
    pflanze TEXT
  );
  CREATE TABLE IF NOT EXISTS geteilte_plaene (
    id TEXT PRIMARY KEY,
    erstellt_am TEXT DEFAULT (datetime('now')),
    plan_json TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS quiz_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    erstellt_am TEXT DEFAULT (datetime('now')),
    event TEXT NOT NULL,
    quiz TEXT
  );
  -- Anonyme Statistik je erstelltem Plan. Bis August 2026 wurde die PLZ bei jedem Plan
  -- abgefragt, einmal für die Klimaregion-Zeile benutzt und dann verworfen — nach über 80
  -- Plänen war deshalb unbekannt, aus welcher Gegend die Planersteller kommen.
  -- Bewusst OHNE IP, ohne User-Agent und ohne Bezug zu einer E-Mail: Das bleibt damit eine
  -- Statistik über Beete, keine Sammlung über Personen.
  CREATE TABLE IF NOT EXISTS plan_statistik (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    erstellt_am TEXT DEFAULT (datetime('now')),
    plz TEXT,
    gartenflaeche REAL,
    licht TEXT,
    boden TEXT,
    stil TEXT,
    dichte TEXT,
    vielfalt TEXT,
    sichtseite TEXT,
    geophyten INTEGER,
    quelle TEXT,          -- 'ki' oder 'datenbank' (Notplan)
    dauer_ms INTEGER,
    arten INTEGER
  );
`);

// Nachträglich ergänzte Spalten in email_gate. ALTER TABLE ist in SQLite idempotent nur über
// den Umweg der Fehlerbehandlung — die Tabelle existiert bei Bestandsinstallationen bereits.
for (const [spalte, typ] of [
  ['plz', 'TEXT'],
  ['boden', 'TEXT'],
  ['werbung_einwilligung', 'INTEGER DEFAULT 0'],  // getrennt von der Servicemail
  ['bestaetigt', 'INTEGER DEFAULT 0'],            // Double-Opt-In für die Werbeeinwilligung
  ['token', 'TEXT'],                              // für Bestätigung und Abmeldung
  ['abgemeldet_am', 'TEXT'],
]) {
  try { db.exec(`ALTER TABLE email_gate ADD COLUMN ${spalte} ${typ}`); } catch { /* Spalte existiert schon */ }
}

// ─── Gaißmayer-Kaufweiterleitung (ersetzt Amazon-Affiliate) ───────────────────
// Ziel-URL zentral gepflegt: sobald ein Deep-Link / eine Kooperation existiert, hier ändern.
const GAISSMAYER_URL = 'https://www.gaissmayer.de/web/shop/';
// Deeplink in Gaißmayers Produktsuche (verifiziert liefert Treffer). Param-Name aus dem Suchformular.
const GAISSMAYER_SEARCH = 'https://www.gaissmayer.de/web/shop/suche/produkte?filter%5Bartikel%5D%5Btext_suche%5D%5Bwerte%5D%5B%5D=';
// Interner Zähl-Link: leitet auf Gaißmayer weiter und protokolliert den Klick pro Pflanze.
const goLink = (botanisch) => `/go/gaissmayer?p=${encodeURIComponent(botanisch || '')}`;
// Nur http(s)- oder relative URLs zulassen (blockt javascript:/data: aus geteilten Plänen).
const safeUrl = (u) => /^(https?:\/\/|\/)/i.test(String(u == null ? '' : u).trim())
  ? String(u).trim() : '#';

// Zentrale HTML-Ausgabe-Kodierung für alle server-gerenderten Seiten. ALLE DB-/Fremd-/
// LLM-Werte müssen hier durch, bevor sie in HTML interpoliert werden (Text + Attribute).
const escHtml = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// ld+json gegen </script>-Ausbruch härten: < in JSON-Strings unschädlich machen.
const escJsonLd = (obj) => JSON.stringify(obj).replace(/</g, '\\u003c');

// ─── Schema-Migrationen (idempotent, try/catch) ───────────────────────────────
[
  'ALTER TABLE pflanzen ADD COLUMN feuchtigkeit TEXT',
  'ALTER TABLE pflanzen ADD COLUMN wuchs TEXT',
  'ALTER TABLE pflanzen ADD COLUMN lebensbereich TEXT',
  'ALTER TABLE pflanzen ADD COLUMN breite_cm_max INTEGER',
  'ALTER TABLE pflanzen ADD COLUMN rolle_empfehlung TEXT',
  'ALTER TABLE pflanzen ADD COLUMN kombinationspartner TEXT',
  'ALTER TABLE pflanzen ADD COLUMN winteraspekt TEXT',
  'ALTER TABLE pflanzen ADD COLUMN trockenheitstoleranz TEXT',
  'ALTER TABLE pflanzen ADD COLUMN inhalt_lang TEXT',
  // Spalten, die real abgefragt werden (RAG-status, Bild-Workflow), aber bisher nur in
  // externen Skripten angelegt wurden → hier idempotent, damit eine frische DB nicht bricht.
  "ALTER TABLE pflanzen ADD COLUMN status TEXT DEFAULT 'live'",
  'ALTER TABLE pflanzen ADD COLUMN bild_url TEXT',
  'ALTER TABLE pflanzen ADD COLUMN bild_lizenz TEXT',
  'ALTER TABLE pflanzen ADD COLUMN bild_ki INTEGER DEFAULT 0',
  'ALTER TABLE pflanzen ADD COLUMN bild_vorschlag TEXT',
  'ALTER TABLE pflanzen ADD COLUMN bild_geprueft INTEGER DEFAULT 0',
  'ALTER TABLE pflanzen ADD COLUMN bild_check_info TEXT',
  // lebensdauer wird in der RAG-Abfrage gelesen (im SELECT der Kandidatenspalten und als
  // Filter gegen 'einjaehrig'), war aber nie hier eingetragen. Auf einer DB ohne die Spalte antwortet die
  // STARTSEITE mit HTTP 500 ("no such column: lebensdauer") — auf dem Produktivserver ist sie
  // durch ein Skript vorhanden, eine frisch nach DEPLOY.md aufgebaute DB hätte sie nicht.
  'ALTER TABLE pflanzen ADD COLUMN lebensdauer TEXT',
  // Klicks: maschinelle Aufrufe werden markiert statt verworfen — die Weiterleitung
  // funktioniert weiter, die Statistik zeigt aber nur echte Nachfrage.
  'ALTER TABLE klicks ADD COLUMN bot INTEGER DEFAULT 0',
  // Herkunftsfläche des Klicks (aus dem Referer abgeleitet) — zeigt, welche Seite verkauft.
  'ALTER TABLE klicks ADD COLUMN quelle TEXT',
].forEach(sql => { try { db.exec(sql); } catch (_) {} });

// Indizes (idempotent) — Prefix-Lookups auf name_botanisch (Plan-Anreicherung) + status-Filter (RAG)
[
  'CREATE INDEX IF NOT EXISTS idx_pflanzen_botanisch ON pflanzen(name_botanisch)',
  'CREATE INDEX IF NOT EXISTS idx_pflanzen_status ON pflanzen(status)',
].forEach(sql => { try { db.exec(sql); } catch (_) {} });

// Sichtbarkeit für den bis 08/2026 stillen Parse-Fehler: inhalt_lang soll JSON sein, ein Teil
// des Bestands ist aber Prosa. Diese Zeilen verlieren die Feld-Sektionen und vier FAQ-Einträge
// (der Text wird als Freitext gerendert, aber das ist der schwächere Weg). Zahl bei jedem Start
// loggen, damit ein Rückfall auffällt statt jahrelang unbemerkt zu bleiben.
(function zaehleInhaltLangFormat() {
  try {
    const zeilen = db.prepare("SELECT inhalt_lang FROM pflanzen WHERE inhalt_lang IS NOT NULL AND inhalt_lang != ''").all();
    let prosa = 0;
    for (const z of zeilen) { try { JSON.parse(z.inhalt_lang); } catch { prosa++; } }
    if (prosa) console.log(`Hinweis: ${prosa} von ${zeilen.length} inhalt_lang-Feldern sind kein JSON — diese Pflanzenseiten zeigen nur den Freitext (kein Pflegeraster, kein voller FAQ).`);
  } catch (_) { /* Zählung darf den Start nie verhindern */ }
})();

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
  if (!openai) openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: 30000, maxRetries: 1 });
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

// Suchmaschinen-Crawler: dürfen die Inhaltsseiten ohne das globale 200/min-Limit
// abrufen. Grund: Googlebot crawlt in Schüben und lief in das Limit — GSC verbucht
// 429 wie einen Serverfehler und drosselt daraufhin das Crawling der ganzen Domain.
// Die Ausnahme gilt bewusst nur für lesende Zugriffe; alle POST-/API-Routen behalten
// ihre eigenen (engeren) Limiter, ein gefälschter User-Agent gewinnt darüber nichts.
const CRAWLER_UA = /googlebot|bingbot|google-inspectiontool|duckduckbot|applebot|yandexbot|slurp/i;
const istCrawler = req => req.method === 'GET' && CRAWLER_UA.test(req.get('user-agent') || '');

// Global: max 200 Requests pro IP pro Minute (schützt vor Bot-Floods)
app.use(rl({
  windowMs: 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  skip: req => req.path.startsWith('/images/') || req.path.endsWith('.jpg') || req.path.endsWith('.png')
            || istCrawler(req),
  message: 'Zu viele Anfragen. Bitte versuche es in einer Minute erneut.',
}));

// /api/pflanzen: max 30 Abrufe pro Minute (verhindert automatisiertes Scraping)
const pflanzenLimiter = rl({
  windowMs: 60 * 1000, max: 30,
  message: { error: 'Zu viele Anfragen.' }
});

// Kontingent für KI-Pläne: 10 pro 15 Minuten pro IP — aber nur für Pläne, die der Nutzer
// auch bekommen hat. Vorher zählte jeder Hänger mit: die drei Ausfälle in drei Minuten am
// 07.08.2026 kosteten den Betroffenen ein Drittel seines Kontingents, ohne dass er je einen
// Plan gesehen hätte. Ein Notplan aus der Datenbank verbraucht das KI-Kontingent ebenfalls
// nicht, weil er keinen KI-Aufruf gekostet hat.
const planLimiter = rl({
  windowMs: 15 * 60 * 1000, max: 10,
  standardHeaders: true, legacyHeaders: false,
  skipFailedRequests: true,
  requestWasSuccessful: (req, res) => res.statusCode < 400 && !res.locals.notplan,
  message: { error: 'Du hast in den letzten 15 Minuten schon 10 Pläne erstellt. Gleich geht es weiter.' }
});
// Harter Deckel dahinter, der JEDEN Versuch zählt. Ohne ihn wäre die Ausnahme oben ein
// Schlupfloch: Wer Fehlschläge provoziert, könnte sonst unbegrenzt OpenAI-Aufrufe auslösen.
// 25 ist das Zweieinhalbfache — genug Luft für die schlechteste gemessene Fehlerquote (45 %
// am 29.07.), eng genug als Kostenbremse.
const planHartLimiter = rl({
  windowMs: 15 * 60 * 1000, max: 25,
  message: { error: 'Zu viele Anfragen, bitte versuche es später erneut.' }
});
const anfrageLimiter = rl({
  windowMs: 15 * 60 * 1000, max: 5,
  message: { error: 'Zu viele Anfragen, bitte versuche es später erneut.' }
});
const alternativLimiter = rl({
  windowMs: 5 * 60 * 1000, max: 30,
  message: { error: 'Zu viele Anfragen.' }
});
const feedbackLimiter = rl({
  windowMs: 60 * 60 * 1000, max: 5,
  message: { error: 'Zu viele Feedback-Sendungen. Bitte versuche es später erneut.' }
});
// Admin-Aktionen (KI-Bildgenerierung etc.) sind zusätzlich zum Passwortschutz
// begrenzt, damit ein geleaktes/erratenes Passwort keine unbegrenzten OpenAI-Kosten
// bzw. unbegrenzt viele Kindprozesse auf dem geteilten VPS auslösen kann.
const adminActionLimiter = rl({
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

/*
 * Prüft, ob ein Wert aus dem bekannten Vokabular stammt.
 *
 * Bis zum 09.08.2026 fehlte diese Prüfung ganz. Ein Test mit licht="Mondlicht",
 * boden="Vulkanasche" und stil="Raumstation" lieferte HTTP 200, success:true und einen Plan
 * mit sieben Pflanzen — vier davon FREI ERFUNDEN, weil bei null Kandidaten die gesamte
 * Pflanzenliste im Prompt entfällt und das Modell aus eigenem Wissen antwortet. Darunter
 * Rittersporn (stark giftig, vom Kindersicher-Netz abgefangen) und Gundermann, ein
 * wucherndes Unkraut. Das Konzept lautete „Ein kinderfreundliches Raumstation-Staudenbeet".
 *
 * Die Oberfläche bietet nur feste Werte an — kommt etwas anderes an, ist der Aufruf kaputt
 * oder fremd, und dann ist eine klare Fehlermeldung besser als ein erfundener Plan.
 * Die Kurzform ("Sonne" statt "Vollsonne (6+ h)") bleibt gültig: Ältere gespeicherte
 * Formulare und die Beispielaufrufe in der Dokumentation verwenden sie.
 */
/*
 * ACHTUNG, hier lag schon ein Fehler: Die Prüfung stützte sich zuerst auf LICHT_MAP,
 * BODEN_MAP und STIL_MAP. Diese Tabellen sind aber KEINE Vollständigkeitsliste, sondern
 * eine Übersetzungshilfe mit Rückfallregel — STIL_MAP kennt vier Einträge, die Oberfläche
 * bietet acht an. „Prairie-Stil / Naturalistisch", „Mediterraner Garten", „Japanischer
 * Garten" und „Steingarten / Alpin" wären damit abgewiesen worden, obwohl sie täglich
 * gewählt werden. Aufgefallen an den echten Werten in plan_statistik.
 *
 * Die Listen unten stammen deshalb aus dem Client (Attribute data-licht/data-boden und die
 * Aufrufe von selectOption) und aus den tatsächlich eingegangenen Werten. Die Kurzformen
 * bleiben gültig: Sie kommen aus älteren gespeicherten Formularen und aus Testaufrufen.
 *
 * Wer eine Auswahlmöglichkeit im Client ergänzt, muss sie hier eintragen.
 */
const ERLAUBT_LICHT = new Set(['Vollsonne (6+ h)', 'Halbschatten (3–6 h)', 'Schatten (unter 3 h)',
  'Wechselnde Bedingungen', 'Sonne', 'Halbschatten', 'Schatten']);
const ERLAUBT_BODEN = new Set(['Sandig / durchlässig', 'Lehmig / schwer', 'Normal / humos',
  'Normal / unbekannt', 'sandig', 'lehmig', 'normal']);
const ERLAUBT_STIL = new Set(['Naturgarten / Wildgarten', 'Bauerngarten / Romantisch',
  'Modern / Minimalistisch', 'Cottage-Garten / Englisch', 'Prairie-Stil / Naturalistisch',
  'Mediterraner Garten', 'Japanischer Garten', 'Steingarten / Alpin',
  'Naturgarten', 'Bauerngarten', 'Modern', 'Cottage', 'Mediterran']);

const bekannterWert = (wert, erlaubt) => erlaubt.has(String(wert || '').trim());

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

/*
 * Was in einen Bepflanzungsplan darf. Stand bisher sechsmal einzeln im Code und prüfte nur
 * `wuchs` und `status` — die Winterhärte wurde NIE gelesen, obwohl die Seite an drei Stellen
 * mit „geprüften, winterharten Stauden für deutsche Gärten" wirbt und der Systemprompt sagt
 * „Du empfiehlst ausschließlich in Deutschland winterharte Pflanzen". Ohne diese Bedingung
 * konnte der Planer Zistrosen und Kapmargeriten in ein Beet setzen, das auf Jahre angelegt ist.
 *
 * Zone ≤ 7: Der Wert ist die kälteste Zone, die eine Art noch verträgt. Deutschland liegt
 * zwischen 6a (Alpenvorland, Mittelgebirge) und 8a (Rheintal, Niederrhein). Zone 7 hält bis
 * −18 °C und ist damit fast überall nutzbar; ab Zone 8 wird es eine Kübelpflanze.
 *
 * Einjährige bleiben draußen, Zweijährige nicht: Wilde Karde und Nachtviole säen sich
 * zuverlässig selbst aus und gehören in naturnahe Pflanzungen. Eine Sommerblume dagegen ist
 * im nächsten Frühjahr weg.
 *
 * KEINE Pflanze ist deswegen offline — alle 709 behalten Lexikonseite und Bilder. Es geht
 * nur darum, was der Planer in ein Staudenbeet setzt. Betrifft 14 Arten.
 */
// Spalten, die ein Kandidat für den Planer mitbringt. Auf Modulebene, weil inzwischen drei
// Abfragen sie brauchen (Rollenauswahl, Ausweichpfad, Nutzungsschwerpunkte).
const PLAN_COLS = `name_deutsch, name_botanisch, beschreibung, licht, boden, stil,
           bluehzeit, farbe, hoehe_cm_min, hoehe_cm_max,
           pflege_sterne, preis_stueck_eur, bienen_freundlich, heimisch,
           feuchtigkeit, wuchs,
           lebensbereich, breite_cm_max, rolle_empfehlung,
           kombinationspartner, winteraspekt, trockenheitstoleranz, lebensdauer`;

const PLANBAR = `(wuchs IS NULL OR wuchs != 'invasiv')
      AND (status IS NULL OR status = 'live')
      AND (winterhart_zone IS NULL OR winterhart_zone <= 7)
      AND (lebensdauer IS NULL OR lebensdauer != 'einjaehrig')`;

function getPflanzenkandidaten(licht, boden, stil, standortBeschr, kindersicher = false) {
  const pflanzenCount = db.prepare("SELECT COUNT(*) as n FROM pflanzen WHERE name_deutsch != 'Test-Pflanze'").get().n;
  if (pflanzenCount === 0) return [];

  const lichtTerm   = LICHT_MAP[licht] || licht.split(' ')[0];
  const bodenTerm   = BODEN_MAP[boden] || 'normal';
  const stilTerm    = STIL_MAP[stil]   || stil.split('/')[0].trim();
  const feuchtigkeit = getFeuchtigkeit(boden, standortBeschr);
  const feuchTerms  = FEUCHT_COMPAT[feuchtigkeit] || ['normal'];
  const feuchPlaceholders = feuchTerms.map(() => '?').join(',');

  const COLS = PLAN_COLS;

  // WHERE-Varianten (Vollmatch → Licht+Feucht → nur Licht)
  const FULL_WHERE  = `licht LIKE ? AND (boden LIKE ? OR boden LIKE ?) AND stil LIKE ?
      AND (feuchtigkeit IN (${feuchPlaceholders}) OR feuchtigkeit IS NULL)
      AND ${PLANBAR}`;
  const FULL_ARGS   = [`%${lichtTerm}%`, `%${bodenTerm}%`, '%normal%', `%${stilTerm}%`, ...feuchTerms];

  const LICHT_WHERE = `licht LIKE ?
      AND (feuchtigkeit IN (${feuchPlaceholders}) OR feuchtigkeit IS NULL)
      AND ${PLANBAR}`;
  const LICHT_ARGS  = [`%${lichtTerm}%`, ...feuchTerms];

  const LAST_WHERE  = `licht LIKE ? AND ${PLANBAR}`;
  const LAST_ARGS   = [`%${lichtTerm}%`];

  // Rollen-Filter (spiegelt die Logik aus buildSystemPrompt Zeile ~269)
  const LEIT_F    = `(rolle_empfehlung = 'Leitstaude'    OR (rolle_empfehlung IS NULL AND COALESCE(hoehe_cm_max,50) >= 100))`;
  const BEGLEIT_F = `(rolle_empfehlung = 'Begleitstaude' OR (rolle_empfehlung IS NULL AND COALESCE(hoehe_cm_max,50) >= 50 AND COALESCE(hoehe_cm_max,50) < 100))`;
  const FUELL_F   = `(rolle_empfehlung = 'Füllstaude'    OR (rolle_empfehlung IS NULL AND COALESCE(hoehe_cm_max,50) < 50))`;

  /*
   * Der Kindersicher-Filter sitzt hier und nicht weiter oben, damit ihn ALLE Ausweichpfade
   * durchlaufen — auch die beiden Fallbacks weiter unten, die greifen, wenn zu wenige
   * Treffer da sind. Genau dort wäre er sonst still umgangen worden.
   *
   * In JS statt in SQL, weil die Einstufung in scripts/pflanzen-giftigkeit.js auf
   * Gattungsebene kuratiert ist und nicht als Spalte vorliegt. Deshalb wird mehr geholt und
   * danach gekürzt: Rund 29 % des Bestands fallen weg, ohne Aufschlag käme bei LIMIT 8 nur
   * eine Handvoll heraus.
   */
  function roleQuery(where, args, roleFilter, n) {
    const limit = kindersicher ? n * 3 : n;
    const rows = db.prepare(
      `SELECT ${COLS} FROM pflanzen WHERE ${where} AND ${roleFilter} ORDER BY RANDOM() LIMIT ${limit}`
    ).all(...args);
    return kindersicher ? rows.filter(p => istKindersicher(p.name_botanisch)).slice(0, n) : rows;
  }

  // Rollenausgewogene Selektion: Leit / Begleit / Füll separat abfragen
  let leit    = roleQuery(FULL_WHERE, FULL_ARGS, LEIT_F,    8);
  let begleit = roleQuery(FULL_WHERE, FULL_ARGS, BEGLEIT_F, 15);
  let fuell   = roleQuery(FULL_WHERE, FULL_ARGS, FUELL_F,   10);

  /*
   * Ausweichpfade. Die zweite Stufe lässt Bodentyp UND Gartenstil fallen, die dritte auch
   * noch die Feuchtestufe — es bleibt nur das Licht. Das ist richtig so, ein Plan ist besser
   * als eine Fehlermeldung. Bisher geschah es aber lautlos: Wer „Mediterran" gewählt hatte,
   * bekam unter Umständen eine Auswahl ohne jeden Bezug zum Stil und erfuhr es nie.
   * Jetzt wird mitgeschrieben, was aufgegeben wurde; der Aufrufer hängt es an den Plan.
   */
  const aufgegeben = new Set();

  if (leit.length    < 3) { leit    = roleQuery(LICHT_WHERE, LICHT_ARGS, LEIT_F,    8);  aufgegeben.add('Bodentyp').add('Gartenstil'); }
  if (begleit.length < 5) { begleit = roleQuery(LICHT_WHERE, LICHT_ARGS, BEGLEIT_F, 15); aufgegeben.add('Bodentyp').add('Gartenstil'); }
  if (fuell.length   < 3) { fuell   = roleQuery(LICHT_WHERE, LICHT_ARGS, FUELL_F,   10); aufgegeben.add('Bodentyp').add('Gartenstil'); }

  if (leit.length    < 2) { leit    = roleQuery(LAST_WHERE, LAST_ARGS, LEIT_F,    8);  aufgegeben.add('Bodenfeuchte'); }
  if (begleit.length < 3) { begleit = roleQuery(LAST_WHERE, LAST_ARGS, BEGLEIT_F, 15); aufgegeben.add('Bodenfeuchte'); }
  if (fuell.length   < 2) { fuell   = roleQuery(LAST_WHERE, LAST_ARGS, FUELL_F,   10); aufgegeben.add('Bodenfeuchte'); }

  // Deduplizieren und zusammenführen (Leit → Begleit → Füll)
  const seen = new Set();
  const kandidaten = [...leit, ...begleit, ...fuell].filter(p => {
    if (seen.has(p.name_botanisch)) return false;
    seen.add(p.name_botanisch);
    return true;
  });

  // Die Liste der gelockerten Bedingungen reist als Eigenschaft mit, damit die Route sie
  // ohne zweiten Rückgabewert weiterreichen kann.
  const mitVermerk = liste => { liste.aufgegeben = [...aufgegeben]; return liste; };

  if (kandidaten.length >= 8) return mitVermerk(kandidaten);

  // Absoluter Fallback: alle passenden Pflanzen nach Licht
  aufgegeben.add('Bodentyp').add('Gartenstil').add('Bodenfeuchte');
  const rest = db.prepare(
    `SELECT ${COLS} FROM pflanzen WHERE ${LAST_WHERE} ORDER BY RANDOM() LIMIT ${kindersicher ? 105 : 35}`
  ).all(...LAST_ARGS);
  return mitVermerk(kindersicher ? rest.filter(p => istKindersicher(p.name_botanisch)).slice(0, 35) : rest);
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

/*
 * Zwiebelblüher. Hier ist der Kindersicher-Filter am schärfsten spürbar: Narzisse,
 * Blaustern, Traubenhyazinthe, Schneeglöckchen und Milchstern sind giftig, Tulpe und
 * Zierlauch zumindest für Haustiere — von neun Gattungen bleiben zwei übrig. Das ist keine
 * Übervorsicht, sondern die Eigenart der Gruppe: Eine Blumenzwiebel sieht aus wie etwas
 * Essbares und liegt beim Pflanzen offen herum.
 */
/*
 * Nutzungswünsche mit Daten hinterlegen.
 *
 * Bis zum 09.08.2026 landeten alle acht Schalter ausschließlich in der Prompt-Zeile
 * „Gartennutzung/Schwerpunkt: …" und beeinflussten die Pflanzenauswahl mit keinem Zeichen.
 * Die Landingpage /bienenfreundliche-stauden behauptete derweil wörtlich: „Unser
 * KI-Bepflanzungsplan wählt automatisch bienenfreundliche Kombinationen aus, wenn du
 * ‚Bienengarten‘ als Gartennutzung angibst."
 *
 * ZUSÄTZLICHE KANDIDATEN STATT HARTER FILTER — bewusst, und anders als bei „Kindersicher".
 * Dort geht es um Sicherheit, da muss jede gefährliche Art weg. Hier geht es um einen
 * Schwerpunkt: Ein Beet, das NUR aus Sichtschutz-Stauden besteht, wäre eine Wand ohne
 * Vordergrund, und „Schnittblumen" heißt nicht, dass jede Pflanze zum Schneiden sein soll.
 * Die passenden Arten werden deshalb garantiert in die Kandidatenliste gelegt, aus der das
 * Modell wählt — und die Anweisung sagt, was damit zu tun ist. Was nicht in der Liste steht,
 * kann nicht eingeplant werden; was drinsteht, hat eine echte Chance.
 */
const NUTZUNG_REGELN = {
  Bienengarten: {
    bedingung: 'bienen_freundlich = 1',
    anweisung: 'BIENENGARTEN: Mindestens drei Viertel der geplanten Arten müssen mit 🐝 markiert sein. Achte auf ein durchgehendes Nektarband — in jedem Monat von März bis Oktober sollte etwas blühen.',
  },
  Winteraspekt: {
    bedingung: `winteraspekt IS NOT NULL AND (winteraspekt LIKE '%Samenstand%' OR winteraspekt LIKE '%Struktur%'
                OR winteraspekt LIKE '%immergrün%' OR winteraspekt LIKE '%wintergrün%')`,
    anweisung: 'WINTERASPEKT: Mindestens {n} der geplanten Arten müssen mit ✅Winteraspekt markiert sein und im Winter etwas hermachen — stehenbleibende Samenstände, Gräserstruktur oder immergrünes Laub. Weise im Konzept darauf hin, dass diese Arten erst im Frühjahr zurückgeschnitten werden.',
  },
  Sichtschutz: {
    bedingung: 'hoehe_cm_max >= 120',
    anweisung: 'SICHTSCHUTZ: Mindestens {n} der geplanten Arten müssen mit ✅Sichtschutz markiert sein (ab 120 cm) in ausreichender Stückzahl als geschlossene Gruppe. Stauden sind allerdings kein ganzjähriger Sichtschutz — sie ziehen im Winter ein. Sag das im Konzept in einem Satz.',
  },
  Bodendecker: {
    bedingung: `(hoehe_cm_max <= 40 AND breite_cm_max >= hoehe_cm_max)
                OR beschreibung LIKE '%odendecker%' OR inhalt_lang LIKE '%odendecker%'`,
    anweisung: 'BODENDECKER: Mindestens {n} der geplanten Arten müssen mit ✅Bodendecker markiert sein. Setze diese flächig wachsenden, niedrige Arten in großen Gruppen als durchgehende Unterpflanzung ein, damit wenig offener Boden bleibt.',
  },
  Duftgarten: {
    bedingung: `beschreibung LIKE '%duft%' OR inhalt_lang LIKE '%duft%' OR inhalt_lang LIKE '%aromatisch%'`,
    anweisung: 'DUFTGARTEN: Mindestens {n} der geplanten Arten müssen mit ✅Duftgarten markiert sein. Setze sie dorthin, wo man vorbeigeht — an Wegrand und Sitzplatz, nicht in die hinterste Reihe.',
  },
  Schmetterlinge: {
    bedingung: `beschreibung LIKE '%chmetterling%' OR inhalt_lang LIKE '%chmetterling%' OR inhalt_lang LIKE '%Falter%'`,
    anweisung: 'SCHMETTERLINGE: Mindestens {n} der geplanten Arten müssen mit ✅Schmetterlinge markiert sein — offene, nektarreiche Blüten in großen Gruppen — einzelne Pflanzen werden kaum angeflogen.',
  },
  Schnittblumen: {
    bedingung: `beschreibung LIKE '%chnittblume%' OR inhalt_lang LIKE '%chnittblume%' OR inhalt_lang LIKE '%Vase%'`,
    anweisung: 'SCHNITTBLUMEN: Mindestens {n} der geplanten Arten müssen mit ✅Schnittblumen markiert sein — langstielig und zum Schneiden geeignet — sie müssen nicht das ganze Beet ausmachen.',
  },
};

/*
 * Legt zu jedem gewählten Schwerpunkt passende Arten in die Kandidatenliste. Standort und
 * die PLANBAR-Regeln gelten weiter, „Kindersicher" ebenfalls — ein Schwerpunkt darf eine
 * Sicherheitszusage nicht aushebeln.
 */
function ergaenzeNutzungskandidaten(kandidaten, nutzung, licht, kindersicher) {
  if (!Array.isArray(nutzung) || !nutzung.length) return { kandidaten, anweisungen: [] };
  const lichtTerm = LICHT_MAP[licht] || String(licht).split(' ')[0];
  const bekannt = new Set(kandidaten.map(p => p.name_botanisch));
  const anweisungen = [];

  for (const wunsch of nutzung) {
    const regel = NUTZUNG_REGELN[wunsch];
    if (!regel) continue;                                  // „Kindersicher" läuft über den Filter
    let treffer;
    try {
      treffer = db.prepare(
        `SELECT ${PLAN_COLS} FROM pflanzen
         WHERE licht LIKE ? AND (${regel.bedingung}) AND ${PLANBAR}`
      ).all(`%${lichtTerm}%`);
    } catch (e) { console.warn('Nutzungsregel „%s" fehlgeschlagen: %s', wunsch, e.message); continue; }

    if (kindersicher) treffer = treffer.filter(p => istKindersicher(p.name_botanisch));
    const passend = new Set(treffer.map(p => p.name_botanisch));

    const neu = treffer.filter(p => !bekannt.has(p.name_botanisch)).slice(0, 12);
    neu.forEach(p => bekannt.add(p.name_botanisch));
    kandidaten = kandidaten.concat(neu);

    /*
     * Markieren, und zwar ALLE passenden Kandidaten — auch die, die schon vorher in der
     * Liste standen. Ohne diese Kennzeichnung sieht das Modell nicht, welche Art den
     * Schwerpunkt erfüllt: Beim ersten Versuch lieferte ein Duftgarten neun Arten, von
     * denen keine einzige duftete, und das Konzept behauptete trotzdem „mit duftenden
     * Stauden". Für Bienen (🐝) und Winteraspekt (❄️) gab es solche Zeichen schon — genau
     * die beiden Schwerpunkte hatten auf Anhieb funktioniert.
     */
    kandidaten.forEach(p => {
      if (passend.has(p.name_botanisch)) p.schwerpunkt = [...new Set([...(p.schwerpunkt || []), wunsch])];
    });

    // Nur anweisen, wofür es auch Pflanzen gibt — sonst fordert der Prompt etwas ein,
    // das die Liste nicht hergibt, und das Modell erfindet sich Arten dazu.
    const vorhanden = kandidaten.filter(p => passend.has(p.name_botanisch)).length;
    if (vorhanden >= 3) anweisungen.push(regel.anweisung.replace('{n}', Math.min(3, Math.floor(vorhanden / 2))));
    else console.warn('Nutzung „%s": nur %d passende Arten für %s — Anweisung weggelassen', wunsch, vorhanden, licht);
  }
  return { kandidaten, anweisungen };
}

function getGeophytenKandidaten(licht, kindersicher = false) {
  const lichtTerm = LICHT_MAP[licht] || licht.split(' ')[0];
  const GENERA = ['Tulipa', 'Narcissus', 'Allium', 'Muscari', 'Crocus', 'Galanthus', 'Scilla', 'Camassia', 'Nectaroscordum'];
  const clause = GENERA.map(() => 'name_botanisch LIKE ?').join(' OR ');
  try {
    const rows = db.prepare(
      `SELECT name_deutsch, name_botanisch, bluehzeit, farbe, hoehe_cm_min, hoehe_cm_max, preis_stueck_eur, licht
       FROM pflanzen
       WHERE (${clause}) AND licht LIKE ?
         AND ${PLANBAR}
       ORDER BY RANDOM() LIMIT ${kindersicher ? 40 : 10}`
    ).all(...GENERA.map(g => `${g}%`), `%${lichtTerm}%`);
    return kindersicher ? rows.filter(p => istKindersicher(p.name_botanisch)).slice(0, 10) : rows;
  } catch { return []; }
}

// ─── Notplan: regelbasierter Ersatzplan ohne KI ──────────────────────────────
// Wenn OpenAI nicht antwortet (in 14 Tagen im August 2026 bei 8,3 % der Anfragen), bekam der
// Nutzer bisher nur eine Fehlermeldung. Alle Bausteine für einen brauchbaren Plan liegen aber
// schon vor: 709 Arten mit Höhe, Ausbreitung, Blühzeit, Winteraspekt und Preis, dazu eine
// rollenausgewogene Kandidatenauswahl. Der Notplan setzt daraus nach denselben Regeln
// zusammen, die auch im Prompt stehen — Höhenstaffelung, Rollenverteilung, Blütenfolge.
//
// Er wird IMMER als solcher gekennzeichnet und nie als KI-Plan ausgegeben. Alle Angaben
// stammen aus der Datenbank; es wird nichts formuliert, was nicht aus den gewählten Pflanzen
// hervorgeht.

const NOTPLAN_MONAT = {
  januar: 1, februar: 2, märz: 3, maerz: 3, april: 4, mai: 5, juni: 6,
  juli: 7, august: 8, september: 9, oktober: 10, november: 11, dezember: 12
};

// Rollen wie in getPflanzenkandidaten (LEIT_F/BEGLEIT_F/FUELL_F): erst das gepflegte Feld,
// sonst nach Endhöhe. 'Strukturpflanze' (1 Zeile) fällt bewusst auf die Höhenlogik zurück.
function notplanRolle(p) {
  const r = p.rolle_empfehlung;
  if (r === 'Leitstaude' || r === 'Begleitstaude' || r === 'Füllstaude') return r;
  const h = Number(p.hoehe_cm_max) || 50;
  return h >= 100 ? 'Leitstaude' : h >= 50 ? 'Begleitstaude' : 'Füllstaude';
}

// "Juni - September" → [6,7,8,9]. Unlesbares gibt eine leere Liste, dann taucht die Pflanze
// im Kalender schlicht nicht auf, statt dort mit geratenen Monaten zu stehen.
// Getrennt wird nur an echten Trennern. Eine Zeichenklasse wie [–\-—bis] wäre falsch: sie
// trennt auch an den Buchstaben b, i und s und zerlegt damit "juni" und "august".
function notplanMonate(bluehzeit) {
  const teile = String(bluehzeit || '').toLowerCase().split(/\s*(?:–|—|-|bis)\s*/).map(s => s.trim()).filter(Boolean);
  const von = NOTPLAN_MONAT[teile[0]], bis = NOTPLAN_MONAT[teile[1]] ?? von;
  if (!von) return [];
  const monate = [];
  for (let m = von, i = 0; i < 12; i++, m = m === 12 ? 1 : m + 1) {
    monate.push(m);
    if (m === bis) break;
  }
  return monate;
}

function notplanStandort(p, sichtseite) {
  const h = Number(p.hoehe_cm_max) || 50;
  const s = String(sichtseite || '');
  if (/rundbeet|inselbeet/i.test(s)) return h >= 100 ? 'Mitte' : h >= 50 ? 'Mittelzone' : 'Rand';
  if (/eckbeet/i.test(s)) return h >= 100 ? 'Ecke/Hintergrund' : h >= 50 ? 'Mitte' : 'Vordergrund';
  return h >= 100 ? 'Hintergrund' : h >= 50 ? 'Mitte' : 'Vordergrund';
}

// Zwiebel- und Knollenpflanzen. Sie stehen mit in der Pflanzentabelle und damit auch in der
// Kandidatenliste, sind aber keine Stauden: Ein Krokus hat 10 cm Standfläche, wodurch die
// Stückzahlformel ihn zur größten Position im Beet macht — in einem Testlauf 215 Krokusse in
// einem 60-m²-Beet, das nach dem Abblühen im April leer dasteht. Der KI-Pfad behandelt sie
// deshalb als eigene Schicht (Rolle "Geophyt"), der Notplan tut das jetzt genauso.
// Beschriftung der Giftstufen. Muss mit GIFT_LABEL in stauden-portal.html synchron bleiben.
// Die Reihenfolge ist die Dringlichkeit — was ein Kind umbringen kann, steht oben.
// „katzen" und „reizend" sind bewusst eigene Stufen: Ein Sammeltopf „giftig" würde aus
// „für Katzen lebensgefährlich, auch das Vasenwasser" ein „nicht in den Mund nehmen" machen.
const GIFT_REIHENFOLGE = ['stark', 'giftig', 'katzen', 'haustiere', 'reizend'];
const GIFT_LABEL = {
  stark:     '☠️ Stark giftig',
  giftig:    '⚠️ Giftig',
  katzen:    '🐈 Für Katzen lebensgefährlich',
  haustiere: '🐾 Für Haustiere giftig',
  reizend:   '🧤 Hautreizend',
};

const GEOPHYTEN_GATTUNGEN = ['Tulipa', 'Narcissus', 'Allium', 'Muscari', 'Crocus', 'Galanthus', 'Scilla', 'Camassia', 'Nectaroscordum', 'Fritillaria'];
const istGeophyt = p => GEOPHYTEN_GATTUNGEN.some(g => String(p.name_botanisch || '').startsWith(g + ' '));

function buildNotplan({ kandidaten, geophytenKandidaten, geophyten, gartenflaeche, dichte, vielfalt, sichtseite, licht, boden, stil }) {
  const flaeche = Number(gartenflaeche) > 0 ? Number(gartenflaeche) : 10;
  const nachRolle = { Leitstaude: [], Begleitstaude: [], Füllstaude: [] };
  for (const p of (kandidaten || [])) {
    if (istGeophyt(p)) continue;
    nachRolle[notplanRolle(p)].push(p);
  }
  // Ohne Leit- oder Füllstauden wäre der Plan kein Plan — dann lieber ehrlich scheitern.
  if (!nachRolle.Leitstaude.length || !nachRolle.Füllstaude.length) return null;

  const ARTEN = { wenig: [1, 3, 2], ausgewogen: [2, 4, 3], viel: [3, 6, 4] };
  const [nLeit, nBegleit, nFuell] = ARTEN[vielfalt] || ARTEN.ausgewogen;
  // Blühzeiten spreizen: erst nach Blühbeginn sortieren, dann gleichmäßig durchgreifen.
  // So deckt die Auswahl die Saison ab, statt fünf Arten aus demselben Monat zu nehmen.
  const spreizen = (liste, n) => {
    const sortiert = [...liste].sort((a, b) => (notplanMonate(a.bluehzeit)[0] || 13) - (notplanMonate(b.bluehzeit)[0] || 13));
    if (sortiert.length <= n) return sortiert;
    return Array.from({ length: n }, (_, i) => sortiert[Math.round(i * (sortiert.length - 1) / Math.max(1, n - 1))]);
  };

  const gewaehlt = [
    ...spreizen(nachRolle.Leitstaude, nLeit),
    ...spreizen(nachRolle.Begleitstaude, nBegleit),
    ...spreizen(nachRolle.Füllstaude, nFuell),
  ].filter((p, i, arr) => arr.findIndex(q => q.name_botanisch === p.name_botanisch) === i);
  if (gewaehlt.length < 3) return null;

  // Stückzahlen: Flächenanteil je Rolle durch die Standfläche der Art. Anschließend auf die
  // Zieldichte normieren, damit die Einstellung "locker/normal/dicht" auch wirklich wirkt.
  const ANTEIL = { Leitstaude: 0.30, Begleitstaude: 0.45, Füllstaude: 0.25 };
  const proRolle = {};
  gewaehlt.forEach(p => { const r = notplanRolle(p); proRolle[r] = (proRolle[r] || 0) + 1; });

  const roh = gewaehlt.map(p => {
    const rolle = notplanRolle(p);
    const anteilFlaeche = flaeche * ANTEIL[rolle] / proRolle[rolle];
    const breiteM = Math.max(0.1, (Number(p.breite_cm_max) || 40) / 100);
    const n = Math.round(anteilFlaeche / (breiteM * breiteM));
    return { p, rolle, n: Math.max(1, n) };
  });

  const ppm2 = dichte === 'locker' ? 2.5 : dichte === 'dicht' ? 7 : 4;
  const ziel = Math.round(flaeche * ppm2);
  const summe = roh.reduce((s, r) => s + r.n, 0);
  const faktor = summe > 0 ? ziel / summe : 1;

  const pflanzen = roh.map(({ p, rolle, n }) => {
    const min = rolle === 'Leitstaude' ? 3 : rolle === 'Füllstaude' ? 5 : 2;
    return {
      name_deutsch: p.name_deutsch,
      name_botanisch: p.name_botanisch,
      beschreibung: p.beschreibung || '',
      standort: notplanStandort(p, sichtseite),
      bluehzeit: p.bluehzeit || '',
      farbe: p.farbe || '',
      hoehe_cm: Number(p.hoehe_cm_max) || Number(p.hoehe_cm_min) || 50,
      pflege_sterne: Number(p.pflege_sterne) || 2,
      rolle,
      stueckzahl: Math.max(min, Math.round(n * faktor)),
      preis_stueck_eur: Number(p.preis_stueck_eur) || 0,
      kauflink: ''
    };
  });

  // Geophyten als eigene Schicht ON TOP, nur wenn angefordert — wie im KI-Pfad. Sie ersetzen
  // keine Staude und fließen nicht in die Pflanzdichte ein, deshalb erst nach der Normierung.
  if (geophyten && Array.isArray(geophytenKandidaten) && geophytenKandidaten.length) {
    const gewaehlteGeo = spreizen(geophytenKandidaten, Math.min(3, geophytenKandidaten.length));
    const proArt = Math.max(5, Math.round(flaeche * 5 / gewaehlteGeo.length));
    gewaehlteGeo.forEach(g => {
      pflanzen.push({
        name_deutsch: g.name_deutsch,
        name_botanisch: g.name_botanisch,
        beschreibung: g.beschreibung || '',
        standort: 'Zwischen den Stauden',
        bluehzeit: g.bluehzeit || '',
        farbe: g.farbe || '',
        hoehe_cm: Number(g.hoehe_cm_max) || 25,
        pflege_sterne: 1,
        rolle: 'Geophyt',
        stueckzahl: proArt,
        preis_stueck_eur: Number(g.preis_stueck_eur) || 0,
        kauflink: ''
      });
      gewaehlt.push(g);
    });
  }

  // Pflanzkalender aus den tatsächlichen Blühzeiten, Winter aus dem Feld winteraspekt.
  const SAISON = { Frühling: [3, 4, 5], Sommer: [6, 7, 8], Herbst: [9, 10, 11] };
  const kalender = { Frühling: [], Sommer: [], Herbst: [], Winter: [] };
  gewaehlt.forEach(p => {
    const monate = notplanMonate(p.bluehzeit);
    for (const [saison, ms] of Object.entries(SAISON)) {
      if (monate.some(m => ms.includes(m))) kalender[saison].push(`${p.name_deutsch} (${p.bluehzeit})`);
    }
    const w = String(p.winteraspekt || '');
    if (w && w !== 'unauffällig') kalender.Winter.push(`${p.name_deutsch} — ${w}`);
  });

  // Texte ausschließlich aus dem, was in der Auswahl tatsächlich steht.
  // Farben stehen in der DB als "Rosa|Weiß|Lila" und in gemischter Schreibung — auftrennen
  // und normalisieren, sonst steht im Text "Rosa|Weiß|Lila, rosa, Rot|Rosa".
  const farben = [...new Map(gewaehlt
    .flatMap(p => String(p.farbe || '').split('|'))
    .map(f => f.trim())
    .filter(Boolean)
    .map(f => [f.toLowerCase(), f.charAt(0).toUpperCase() + f.slice(1).toLowerCase()])
  ).values()];
  const alleMonate = gewaehlt.flatMap(p => notplanMonate(p.bluehzeit));
  const MONATSNAME = ['', 'Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];
  const spanne = alleMonate.length
    ? `${MONATSNAME[Math.min(...alleMonate)]} bis ${MONATSNAME[Math.max(...alleMonate)]}`
    : null;
  const hoechste = Math.max(...pflanzen.map(p => p.hoehe_cm));
  const gesamtStueck = pflanzen.reduce((s, p) => s + p.stueckzahl, 0);

  // Numerus mitführen: bei genau einer Leitstaude heißt es "bildet", nicht "bilden".
  const leitNamen = pflanzen.filter(p => p.rolle === 'Leitstaude').map(p => p.name_deutsch);
  const tipps = [
    `Setze die Leitstauden zuerst und ordne die übrigen Arten um sie herum an — ${leitNamen.join(', ')} ${leitNamen.length === 1 ? 'bildet' : 'bilden'} das Gerüst des Beetes.`,
    'Pflanze jede Art in Gruppen statt einzeln; Gruppen wirken ruhiger und schließen die Fläche schneller.',
  ];
  if (kalender.Winter.length) {
    tipps.push(`Lass die Samenstände über den Winter stehen — ${kalender.Winter.length === 1 ? 'eine Art in diesem Plan hat' : `${kalender.Winter.length} Arten in diesem Plan haben`} Winterschmuck und bieten Vögeln Nahrung.`);
  }
  const luecken = Object.entries(SAISON).filter(([, ms]) => !alleMonate.some(m => ms.includes(m))).map(([s]) => s);
  if (luecken.length) {
    // "Frühling und Sommer" bzw. "Frühling, Sommer und Herbst" — nicht "A und B und C".
    const aufzaehlung = luecken.length === 1 ? luecken[0]
      : `${luecken.slice(0, -1).join(', ')} und ${luecken[luecken.length - 1]}`;
    tipps.push(`In dieser Zusammenstellung blüht im ${aufzaehlung} nichts — hier lassen sich später gezielt Arten ergänzen.`);
  }

  return {
    quelle: 'datenbank',
    // Standort als Aufzählung statt im Satz: "auf lehmig Boden" wäre grammatisch falsch, und
    // die Bodenwerte der DB lassen sich nicht zuverlässig deklinieren.
    konzept: `${stil || 'Staudenbeet'} — Standort ${licht || 'unbestimmt'}, Boden ${boden || 'normal'}. `
      + `${pflanzen.length} Arten in gestaffelter Höhe${spanne ? `, Blüte von ${spanne}` : ''}.`,
    pflanzen,
    beetbeschreibung: `Dieser Plan stellt ${pflanzen.length} Arten für ${flaeche} m² zusammen, insgesamt ${gesamtStueck} Pflanzen. `
      + `Die Höhen reichen bis ${hoechste} cm und sind nach ${/rundbeet|inselbeet/i.test(String(sichtseite)) ? 'innen ansteigend' : 'hinten ansteigend'} gestaffelt. `
      + (farben.length ? `Vertreten sind die Blütenfarben ${farben.join(', ')}. ` : '')
      + (spanne ? `Zusammen decken die Arten die Zeit von ${spanne} ab.` : ''),
    gesamtkosten_geschaetzt: 0,
    pflanzabstand_hinweis: 'Die Stückzahlen sind aus der Endbreite der jeweiligen Art und der gewählten Pflanzdichte berechnet. Wer sofortige Wirkung möchte, setzt etwas dichter und teilt die Stauden nach einigen Jahren.',
    pflanzkalender: kalender,
    tipps
  };
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
        // Erfüllte Nutzungsschwerpunkte. Ohne diese Kennzeichnung kann das Modell nicht
        // erkennen, welche Art duftet oder sich als Schnittblume eignet — es stand nur im
        // Fließtext der Beschreibung, den die Kandidatenliste gar nicht überträgt.
        Array.isArray(p.schwerpunkt) && p.schwerpunkt.length ? `✅${p.schwerpunkt.join('+')}` : '',
      ].filter(Boolean).join(' ');
      const lebensb = p.lebensbereich ? ` | LB:${p.lebensbereich}` : '';
      const kombi = p.kombinationspartner ? ` | Kombi:${p.kombinationspartner}` : '';
      return `- [${rolle}] ${p.name_deutsch} (${p.name_botanisch}): ${p.licht} | Blüte: ${p.bluehzeit || '?'} | ${p.farbe || '?'} | ${hoehe}${breite ? ' ' + breite : ''} | ${p.preis_stueck_eur || '?'}€ | Pflege: ${'★'.repeat(p.pflege_sterne || 2)}${lebensb}${kombi}${extras ? ' | ' + extras : ''}`;
    }).join('\n');
    prompt += '\n\nDas Feld "kauflink" bitte leer lassen ("") — es wird serverseitig gesetzt.';
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
    // Zwei Zahlen, weil zwei verschiedene Aussagen: pflanzenCount ist das Lexikon,
    // planbarCount das, was der Planer nach PLANBAR wirklich einsetzen darf. Vorher stand
    // überall dieselbe Zahl — auch dort, wo "winterhart" behauptet wurde.
    const planbarCount = db.prepare(`SELECT COUNT(*) as n FROM pflanzen
      WHERE name_deutsch != 'Test-Pflanze' AND ${PLANBAR}`).get().n;
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
        <span class="spc-name">${escHtml(p.name_deutsch)}</span>
        <span class="spc-bot">${escHtml(p.name_botanisch)}</span>
        ${p.bluehzeit ? `<span class="spc-tag">${escHtml(p.bluehzeit)}</span>` : ''}
        ${p.licht ? `<span class="spc-tag">${escHtml(p.licht.split('|')[0])}</span>` : ''}
      </a>`).join('');

    const fs = require('fs');
    let html = fs.readFileSync(path.join(__dirname, 'stauden-portal.html'), 'utf8');
    // planbarCount, nicht pflanzenCount: Alle vier Stellen im Client behaupten „winterharte"
    // bzw. „geprüfte" Stauden (Meta-Beschreibung, og:description, JSON-LD, Fußzeile).
    html = html.replace(/__PFLANZEN_COUNT__/g, planbarCount);

  // FAQ (targetet reale Search-Console-Queries: "bepflanzungsplan erstellen", "beetplaner
  // online kostenlos", "staudenbeet planen online", "stauden pro m²") — HTML + FAQPage-Schema.
  const homeFaq = [
    { q: 'Wie erstelle ich einen Bepflanzungsplan?', a: `Beschreibe deinen Garten — Fläche, Lichtbedingungen, Bodentyp und Gartenstil — und unser KI-Gartenplaner erstellt in rund 2 Minuten einen individuellen Bepflanzungsplan aus ${planbarCount}+ winterharten Stauden. Du bekommst einen grafischen Plan, eine Stückliste und einen Blühkalender — kostenlos und ohne Anmeldung.` },
    { q: 'Gibt es einen kostenlosen Beetplaner online?', a: 'Ja. Staudenplan.de ist ein komplett kostenloser Beetplaner online: Du kannst dein Staudenbeet planen, ohne Konto und ohne E-Mail. Der KI-Planer schlägt standortgerechte Stauden vor und berechnet Stückzahlen und Kosten automatisch.' },
    { q: 'Was kostet ein Bepflanzungsplan?', a: 'Das Erstellen des Bepflanzungsplans bei Staudenplan.de ist kostenlos. Bezahlt wird nur, wenn du die vorgeschlagenen Pflanzen tatsächlich kaufst — so kannst du dein Staudenbeet unverbindlich online planen.' },
    { q: 'Kann ich mein Staudenbeet online planen?', a: 'Ja, genau dafür ist der Planer da. Du zeichnest die Beetfläche direkt ein oder gibst Maße ein, wählst Standort und Stil, und erhältst einen fertigen Pflanzplan mit Höhenstaffelung, Blütenfolge und bewährten Pflanzenkombinationen.' },
    { q: 'Wie viele Stauden brauche ich pro Quadratmeter?', a: 'Je nach Pflanzdichte etwa 2–3 (locker), 4–5 (normal) oder 6–8 Stauden pro m². Der Pflanzplan berechnet die Stückzahlen automatisch aus Fläche und Pflanzabständen — du musst nichts selbst rechnen.' },
  ];

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
      <p>Ein professioneller <strong>Bepflanzungsplan</strong> ist die Grundlage für ein schönes, pflegeleichtes Staudenbeet. Unser KI-Gartenplaner erstellt dir in wenigen Minuten einen maßgeschneiderten Plan — abgestimmt auf Standort, Bodentyp, Gartenstil und deine persönlichen Wünsche. Mit über <strong>${planbarCount} geprüften, winterharten Stauden</strong> für deutsche Gärten.</p>
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
        <div class="seo-step"><div class="ss-num">2</div><h3>KI generiert deinen Plan</h3><p>Unsere KI durchsucht ${planbarCount} geprüfte Stauden und ${wissenCount} Expertentexte — und erstellt einen individuellen, standortgerechten Bepflanzungsplan.</p></div>
        <!-- Nicht "bestellen": Auf staudenplan.de wird nichts verkauft und nichts bestellt. Es gibt
             genau zwei Wege — pro Staude ein Link zur Gärtnerei, oder eine unverbindliche Anfrage
             fürs Komplettpaket, auf die die Gärtnerei mit einem Angebot antwortet (Modal
             "Paket bei der Gärtnerei anfragen"). "Direkt als Komplettpaket bestellt werden"
             versprach einen Bestellvorgang, den es hier nicht gibt. -->
        <div class="seo-step"><div class="ss-num">3</div><h3>Pflanzen besorgen</h3><p>Mit Stückliste, grafischem Pflanzplan und Jahreskalender. Jede Staude ist zur Gärtnerei verlinkt — oder du fragst das Komplettpaket unverbindlich an und bekommst ein Angebot.</p></div>
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

  <!-- FAQ (server-rendered, mit FAQPage-Schema) -->
  <section style="background:#fff;padding:48px 20px">
    <div style="max-width:800px;margin:0 auto">
      <h2 style="font-size:1.5rem;color:#1b4332;margin-bottom:20px;line-height:1.3">Häufige Fragen: Bepflanzungsplan &amp; Beetplaner online</h2>
      ${homeFaq.map(f => `<details style="background:#f8f4ef;border-radius:10px;padding:14px 18px;margin-bottom:10px">
        <summary style="font-weight:700;color:#1b4332;cursor:pointer;font-size:1rem;list-style:none">${f.q}</summary>
        <p style="margin-top:10px;color:#444;line-height:1.7;font-size:.95rem">${f.a}</p>
      </details>`).join('')}
    </div>
  </section>
  <script type="application/ld+json">${escJsonLd({
    '@context': 'https://schema.org', '@type': 'FAQPage',
    mainEntity: homeFaq.map(f => ({ '@type': 'Question', name: f.q, acceptedAnswer: { '@type': 'Answer', text: f.a } })),
  })}</script>

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
        <p>KI-gestützte Gartenplanung mit ${planbarCount} winterharten Stauden für deutsche Gärten.</p>
      </div>
      <div class="seo-footer-col">
        <h4>Ratgeber</h4>
        <ul>
          <li><a href="/ratgeber/staudenbeet-anlegen-schritt-fuer-schritt-anleitung">Staudenbeet anlegen</a></li>
          <li><a href="/ratgeber/stauden-fuer-den-schatten-die-besten-arten-fuer-dunkle-beete">Stauden für Schatten</a></li>
          <li><a href="/pflegeleichte-stauden">Pflegeleichte Stauden</a></li>
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

// Zeitbudget für /api/plan. nginx bricht für staudenplan.de nach 60 s ab (Standardwert von
// proxy_read_timeout, der vhost setzt keinen eigenen). Bis Anfang August zählten hier ZWEI
// verschachtelte Ebenen Versuche statt Zeit — das SDK (timeout 30 s, maxRetries 1 = bis 60 s)
// und die Schleife in dieser Route (bis 2 Durchläufe = bis 120 s). Bei einem Hänger kappte
// deshalb immer nginx zuerst: in 14 Tagen 24 OpenAI-Timeouts und exakt 24 Gateway-Timeouts,
// die saubere Fehlerantwort der App wurde kein einziges Mal ausgeliefert.
//
// PLAN_VERSUCH_MS bleibt bei 30 s. Der langsamste gemessene ERFOLGREICHE Plan lag bei 17,3 s
// (60 m², viel Vielfalt), der schnellste bei 10,8 s. Die Grenze zu senken würde heute
// erfolgreiche Anfragen in Fehler verwandeln und keinen einzigen Gateway-Timeout verhindern —
// die Ausfälle sind Hänger, die auch nach 60 s nichts geliefert hätten.
// Über Umgebungsvariablen überschreibbar, damit sich der Fehlerpfad ohne echten Hänger testen
// lässt (PLAN_VERSUCH_MS=1) und im Ernstfall nachjustiert werden kann, ohne neu zu deployen.
const PLAN_VERSUCH_MS = Number(process.env.PLAN_VERSUCH_MS) || 30000;
// Deckel über die ganze Route, mit 10 s Abstand zu nginx. Der Abstand deckt, dass nginx ab
// TCP-Accept zählt und wir erst im Handler, plus DB-Anreicherung und Serialisierung.
const PLAN_BUDGET_MS = Number(process.env.PLAN_BUDGET_MS) || 50000;

// Fehlerklassen des OpenAI-SDK. Zwingend über instanceof: die Klassen setzen `name` nicht,
// err.name ist bei allen schlicht "Error" — eine Prüfung darauf wäre stiller toter Code.
// Reihenfolge zählt, APIConnectionTimeoutError erbt von APIConnectionError.
function klassifiziereOpenAIFehler(err) {
  if (err instanceof OpenAI.APIUserAbortError) return 'abbruch';
  if (err instanceof OpenAI.APIConnectionTimeoutError) return 'timeout';
  if (err instanceof OpenAI.APIConnectionError) return 'netz';
  if (err && err.status === 429) return 'ratelimit';
  if (err && err.status >= 500) return 'api';
  return 'unbekannt';
}

app.post('/api/plan', planHartLimiter, planLimiter, async (req, res) => {
  const t0 = Date.now();
  const { gartenflaeche, licht, boden, standort_beschreibung, stil, sichtseite, farbe, saison,
          lieblingspflanzen, budget, nutzung, pflegezeit, vielfalt, dichte, plz, geophyten } = req.body;

  if (!gartenflaeche || !licht || !boden || !stil) {
    return res.status(400).json({ error: 'Bitte alle Pflichtfelder ausfüllen.' });
  }
  // Typ-Härtung: RAG- und Prompt-Bildung laufen VOR dem try-Block; ein truthy Nicht-String
  // (z.B. licht:5, plz:80331) würde dort eine uncaught TypeError werfen → 500-HTML statt 400-JSON.
  if (typeof licht !== 'string' || typeof boden !== 'string' || typeof stil !== 'string'
      || (standort_beschreibung != null && typeof standort_beschreibung !== 'string')
      || (plz != null && typeof plz !== 'string')) {
    return res.status(400).json({ error: 'Ungültige Eingabewerte.' });
  }

  // Werte gegen das bekannte Vokabular prüfen (siehe bekannterWert). Vorher genügte es,
  // dass es Zeichenketten waren — „Mondlicht" und „Vulkanasche" lieferten einen Plan.
  const unbekannt = [
    !bekannterWert(licht, ERLAUBT_LICHT) ? 'Lichtverhältnisse' : null,
    !bekannterWert(boden, ERLAUBT_BODEN) ? 'Bodentyp' : null,
    !bekannterWert(stil, ERLAUBT_STIL)   ? 'Gartenstil' : null,
  ].filter(Boolean);
  if (unbekannt.length) {
    console.warn('Plananfrage mit unbekannten Werten abgelehnt: licht=%j boden=%j stil=%j', licht, boden, stil);
    return res.status(400).json({ error: `Unbekannte Angabe bei: ${unbekannt.join(', ')}. Bitte wähle die Werte aus der Liste.` });
  }

  // RAG: Hol Kontext aus der Wissensdatenbank
  const feuchtigkeit = getFeuchtigkeit(boden, standort_beschreibung);
  /*
   * „Kindersicher" war bis zum 09.08.2026 nur ein Wort im Prompt — die Angabe landete
   * ausschließlich in der Zeile „Gartennutzung/Schwerpunkt" und filterte nichts. Entsprechend
   * kamen Eisenhut und Fingerhut in Familienbeeten an, obwohl die kuratierte Giftliste seit
   * Wochen vorlag. Derselbe Fehler wie bei der Winterhärte: eine Zusage ohne Regel.
   *
   * Jetzt entscheidet die Angabe, WELCHE Pflanzen das Modell überhaupt zu sehen bekommt.
   * Was nicht in der Kandidatenliste steht, kann auch nicht eingeplant werden.
   */
  const kindersicher = Array.isArray(nutzung) && nutzung.some(n => /kindersicher|kinderfreundlich/i.test(String(n)));

  let kandidaten = getPflanzenkandidaten(licht, boden, stil, standort_beschreibung, kindersicher);
  // Sofort sichern: Die Liste wird gleich per concat erweitert, und dabei geht die
  // angehängte Eigenschaft verloren.
  const gelockert = kandidaten.aufgegeben || [];

  // Die übrigen sieben Nutzungsschalter wirkten bis 09.08.2026 ebenfalls nicht auf die
  // Auswahl. Jetzt legen sie passende Arten in die Liste und erzeugen eine klare Anweisung.
  const nutzungErgebnis = ergaenzeNutzungskandidaten(kandidaten, nutzung, licht, kindersicher);
  kandidaten = nutzungErgebnis.kandidaten;

  /*
   * Pflegeaufwand. Die Spalte pflege_sterne war bis zum 09.08.2026 unbrauchbar: 531 von 709
   * Pflanzen hatten 2 Sterne, 175 einen und DREI drei — „Intensiv" hätte drei Arten ergeben.
   * Sie wird jetzt aus den Merkmalen hergeleitet, die wirklich Arbeit machen (Ausläufer,
   * Selbstaussaat, Wuchshöhe, Wasserbedarf; siehe scripts/pflegeaufwand-herleiten.js) und
   * verteilt sich auf 434 / 238 / 37.
   *
   * Die Stufe ist eine Obergrenze, keine Zielvorgabe: Wer viel Zeit hat, will nicht
   * ausschließlich pflegeintensive Stauden, sondern nimmt sie in Kauf.
   */
  const pflegeGrenze = /minimal/i.test(String(pflegezeit || '')) ? 1
                     : /mittel/i.test(String(pflegezeit || ''))  ? 2 : null;
  if (pflegeGrenze) {
    const lichtTerm = LICHT_MAP[licht] || String(licht).split(' ')[0];
    let leicht = db.prepare(
      `SELECT ${PLAN_COLS} FROM pflanzen WHERE licht LIKE ? AND pflege_sterne <= ? AND ${PLANBAR}
       ORDER BY RANDOM() LIMIT ${kindersicher ? 45 : 15}`).all(`%${lichtTerm}%`, pflegeGrenze);
    if (kindersicher) leicht = leicht.filter(p => istKindersicher(p.name_botanisch));
    const schon = new Set(kandidaten.map(p => p.name_botanisch));
    kandidaten = kandidaten.concat(leicht.filter(p => !schon.has(p.name_botanisch)).slice(0, 15));
    // Pflegeintensive Arten aus der Liste nehmen, statt nur um Zurückhaltung zu bitten —
    // sonst steht die Goldrute mit ihren Ausläufern im „pflegeleichten" Beet.
    const vorher = kandidaten.length;
    kandidaten = kandidaten.filter(p => (p.pflege_sterne || 2) <= pflegeGrenze);
    if (kandidaten.length < 8) kandidaten = kandidaten.concat(leicht).slice(0, Math.max(20, kandidaten.length));
    nutzungErgebnis.anweisungen.push(pflegeGrenze === 1
      ? 'PFLEGEAUFWAND MINIMAL: Nur Arten, die ohne Stützen, ohne regelmäßiges Teilen und ohne häufiges Gießen auskommen.'
      : 'PFLEGEAUFWAND MITTEL: Keine Arten, die gleichzeitig Ausläufer treiben, Stützen brauchen und gegossen werden müssen.');
    console.log('Pflegegrenze ≤%d★: %d von %d Kandidaten bleiben', pflegeGrenze, kandidaten.length, vorher);
  }

  /*
   * Ohne Kandidaten wird im Prompt die gesamte Pflanzenliste weggelassen — das Modell
   * antwortet dann aus eigenem Wissen. Im Test kamen so vier frei erfundene Arten in einen
   * Plan, darunter Rittersporn und Gundermann: ohne Bild, ohne Preis, ohne Lexikonseite und
   * an allen Regeln vorbei, die auf der Datenbank aufsetzen (Winterhärte, Lebensdauer).
   * Lieber ein klarer Fehler als ein Plan, der nicht zur Seite gehört.
   */
  const MIN_KANDIDATEN = 5;
  if (kandidaten.length < MIN_KANDIDATEN) {
    console.warn('Plananfrage ohne ausreichende Kandidaten: %d bei licht=%j boden=%j stil=%j kindersicher=%s',
      kandidaten.length, licht, boden, stil, kindersicher);
    return res.status(422).json({
      error: kindersicher
        ? 'Für diesen Standort finden wir nicht genügend kindersichere Stauden. Nimm den Haken bei „Kindersicher" heraus oder wähle andere Standortangaben.'
        : 'Für diese Kombination aus Standort, Boden und Stil finden wir zu wenige passende Stauden. Bitte ändere eine der Angaben.',
    });
  }

  const wissen = getRelevantesWissen(stil, licht, feuchtigkeit);

  const geophytenKandidaten = geophyten ? getGeophytenKandidaten(licht, kindersicher) : [];

  if (kandidaten.length > 0) {
    // Markierte Kandidaten mitloggen: Ohne diese Zahl lässt sich später nicht unterscheiden,
    // ob ein Schwerpunkt am fehlenden Angebot oder am Modell gescheitert ist.
    const markiert = {};
    kandidaten.forEach(p => (p.schwerpunkt || []).forEach(s => markiert[s] = (markiert[s] || 0) + 1));
    const markText = Object.entries(markiert).map(([s, n]) => `${s}:${n}`).join(' ');
    console.log(`RAG: ${kandidaten.length} Pflanzenkandidaten (feuchtigkeit=${feuchtigkeit}), ${wissen.length} Wissensdokumente${geophytenKandidaten.length > 0 ? `, ${geophytenKandidaten.length} Geophyten` : ''}${markText ? ` | Schwerpunkte ${markText}` : ''}`);
  }

  const systemPrompt = buildSystemPrompt(kandidaten, wissen, geophytenKandidaten);

  const lieblingsList = Array.isArray(lieblingspflanzen) && lieblingspflanzen.length > 0
    ? lieblingspflanzen.filter(p => p && p.name_deutsch).map(p => `${p.name_deutsch} (${p.name_botanisch || ''})`).join(', ') || null
    : null;
  const nutzungList = Array.isArray(nutzung) && nutzung.length > 0
    ? nutzung.join(', ')
    : null;

  // Der Filter allein reicht: Was nicht in der Kandidatenliste steht, kann das Modell nicht
  // wählen. Die Anweisung steht trotzdem dabei, damit es nicht von sich aus eine giftige Art
  // ergänzt — und weil sie erklärt, warum die Liste kürzer ist als sonst.
  // Anweisungen zu den Schwerpunkten, für die auch Pflanzen in der Liste stehen.
  const nutzungAnweisungen = nutzungErgebnis.anweisungen.length
    ? '\n\n' + nutzungErgebnis.anweisungen.join('\n')
    : '';

  const kindersicherHinweis = kindersicher
    ? '\n\nWICHTIG — KINDERSICHERER GARTEN: Verwende AUSSCHLIESSLICH Pflanzen aus der Kandidatenliste. '
      + 'Ergänze auf keinen Fall eigene Arten. Die Liste enthält bereits nur ungiftige Arten ohne Dornen '
      + 'oder Stacheln; jede zusätzliche Art würde diese Zusage brechen. Erwähne im Konzept mit einem '
      + 'Satz, dass alle vorgeschlagenen Pflanzen ungiftig und dornenfrei sind.'
    : '';

  const vielfaltAnweisung = (() => {
    if (vielfalt === 'wenig') return `Empfehle 6–7 winterharte Stauden — bewusst wenige Arten für eine ruhige, klar strukturierte Wirkung, dafür mit hoher Wiederholung in großen Gruppen. Das ist die kleinstmögliche Auswahl, die noch alle Schichten erfüllt (mind. 1 Leitstaude, 3 Begleitstauden, 2 Füllstauden).`;
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
- Blühsaison-Priorität: ${saison || 'ganzjährig'}${plz ? `\n- Region (PLZ ${plz}): ${klimaregion || 'Mitteleuropa, gemäßigtes Klima'}` : ''}${lieblingsList ? `\n- Lieblingspflanzen (unbedingt einplanen): ${lieblingsList}` : ''}${budget ? `\n- Budget: maximal ${budget} € Gesamtkosten` : ''}${nutzungList ? `\n- Gartennutzung/Schwerpunkt: ${nutzungList}` : ''}${pflegezeit ? `\n- Gewünschte Pflegeintensität: ${pflegezeit}` : ''}${nutzungAnweisungen}${kindersicherHinweis}

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
    "kauflink": ""
  }],
  "beetbeschreibung": "2–3 Sätze die den Charakter und die Gesamtwirkung des Beetes beschreiben — Stil, Farbstimmung, saisonale Höhepunkte, Atmosphäre. Formuliere so, als würdest du einem Gartenbesucher das Konzept erklären.",
  "gesamtkosten_geschaetzt": "...",
  "pflanzabstand_hinweis": "...",
  "pflanzkalender": { "Frühling": [], "Sommer": [], "Herbst": [], "Winter": [] },
  "tipps": []
}`;

  try {
    // Generierung mit max_tokens-Backstop und EINEM Wiederholungsversuch — der aber nur startet,
    // wenn er vollständig ins Zeitbudget passt. Ein zweiter Versuch, den nginx ohnehin abschneidet,
    // hilft niemandem und kostet den Nutzer 30 zusätzliche Sekunden Wartezeit.
    // (max_tokens großzügig: verhindert Runaway, ohne realistische Pläne zu kürzen.)
    const modell = ['gpt-4o', 'gpt-4o-mini'].includes(req.query.model) ? req.query.model : 'gpt-4o-mini';
    let plan = null, versuche = 0, grund = null;
    const versuchMs = [];
    for (let attempt = 1; attempt <= 2 && !plan; attempt++) {
      const rest = PLAN_BUDGET_MS - (Date.now() - t0);
      if (rest < PLAN_VERSUCH_MS) { grund = grund || 'budget'; break; }
      versuche++;
      const tv = Date.now();
      try {
        const completion = await getOpenAI().chat.completions.create({
          // Default gpt-4o-mini (Eval 2026-07-25: gleichauf mit 4o, 0 Halluzinationen, ~15× günstiger).
          // ?model=gpt-4o bleibt als Notausstieg/Override (Allowlist).
          model: modell,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt }
          ],
          temperature: 0.6,
          max_tokens: 8000,
          response_format: { type: 'json_object' }
        }, {
          // Pro Aufruf, nicht am geteilten Client: getOpenAI() bedient auch die Admin-Bild- und
          // Batch-Pfade, die ohne wartenden HTTP-Client laufen und den SDK-Retry behalten sollen.
          timeout: PLAN_VERSUCH_MS,
          maxRetries: 0
        });
        try {
          plan = JSON.parse(completion.choices[0].message.content);
        } catch (parseErr) {
          grund = 'json';
          console.warn(`Plan-JSON ungültig (Versuch ${attempt}/2): ${parseErr.message}`);
        }
      } catch (apiErr) {
        grund = klassifiziereOpenAIFehler(apiErr);
        console.warn(`OpenAI-Aufruf fehlgeschlagen (Versuch ${attempt}/2, ${Date.now() - t0} ms, ${grund}): ${apiErr.message}`);
        // Bei einem Hänger ist ein zweiter Versuch im selben Budget aussichtslos; Kontingent
        // und Wartezeit sparen. Kurze Fehler (Netz, 5xx) bekommen dagegen ihre zweite Chance.
        // Das finally unten läuft auch bei break, die Dauer wird also mitgeschrieben.
        if (grund === 'timeout' || grund === 'abbruch' || grund === 'ratelimit') break;
      } finally {
        versuchMs.push(Date.now() - tv);
      }
    }
    let notplan = false;
    if (!plan) {
      // Statt einer Fehlermeldung ein regelbasierter Plan aus der eigenen Datenbank. Er kostet
      // keinen API-Aufruf, läuft in Millisekunden und wird klar gekennzeichnet — der Nutzer
      // bekommt etwas Brauchbares statt eines Abbruchs.
      plan = buildNotplan({ kandidaten, geophytenKandidaten, geophyten, gartenflaeche, dichte, vielfalt, sichtseite, licht, boden, stil });
      notplan = !!plan;
      // Flag für den Rate-Limiter: ein Notplan hat kein KI-Kontingent verbraucht.
      if (notplan) res.locals.notplan = true;
      console.error(`plan ${notplan ? 'notplan' : 'fehlgeschlagen'} ms=${Date.now() - t0} versuche=${versuche} versuch_ms=${versuchMs.join(',')} grund=${grund || 'unbekannt'} modell=${modell} flaeche=${gartenflaeche}`);
    }
    if (!plan) {
      // Auch der Notplan war nicht möglich (zu wenige Kandidaten für den Standort).
      // 504 statt 500: Das Frontend bevorzugt data.error, sobald JSON vorliegt — der Text muss
      // also hier stehen. Der Statuscode bleibt trotzdem in der 502/504-Familie, damit der
      // vorhandene Zweig im Frontend als Netz greift, falls die Antwort doch einmal ohne JSON
      // ankommt. Bei Timeouts sagt die Meldung, was wirklich los war.
      const istZeit = grund === 'timeout' || grund === 'budget';
      return res.status(istZeit ? 504 : 502).json({
        error: istZeit
          ? 'Die Planerstellung hat zu lange gedauert. Bitte versuch es noch einmal — bei kleineren Flächen geht es meist schneller.'
          : 'Fehler bei der KI-Planung. Bitte versuche es erneut.'
      });
    }

    /*
     * Schwerpunkte deterministisch durchsetzen.
     *
     * Dieselbe Erfahrung wie beim Budget, das aus genau diesem Grund schon serverseitig
     * gekappt wird: Das Modell hält Nebenbedingungen nicht ein, wenn mehrere gleichzeitig
     * gelten. Gemessen bei „Duftgarten + Schnittblumen" mit je 13 markierten Kandidaten in
     * der Liste — geliefert wurden 2 und 1 statt der geforderten 3 und 3.
     *
     * Getauscht wird rollengetreu: Eine Füllstaude wird durch eine Füllstaude ersetzt, damit
     * Höhenstaffelung und Stückzahlen stimmig bleiben. Zuerst fliegen Arten raus, die gar
     * keinen der gewünschten Schwerpunkte erfüllen — wer schon zwei Wünsche bedient, bleibt.
     */
    if (Array.isArray(plan.pflanzen) && nutzungErgebnis.anweisungen.length) {
      const rolleVon = p => p.rolle || ((p.hoehe_cm || 50) >= 100 ? 'Leitstaude' : (p.hoehe_cm || 50) >= 50 ? 'Begleitstaude' : 'Füllstaude');
      const erfuellt = (name, wunsch) => kandidaten.some(k => k.name_botanisch === name && (k.schwerpunkt || []).includes(wunsch));
      const punkte = p => (nutzung || []).filter(w => erfuellt(p.name_botanisch, w)).length;

      for (const wunsch of (nutzung || [])) {
        if (!NUTZUNG_REGELN[wunsch]) continue;
        const markiert = kandidaten.filter(k => (k.schwerpunkt || []).includes(wunsch));
        const soll = Math.min(3, Math.floor(markiert.length / 2));
        let ist = plan.pflanzen.filter(p => erfuellt(p.name_botanisch, wunsch)).length;
        if (ist >= soll) continue;

        const drin = new Set(plan.pflanzen.map(p => p.name_botanisch));
        for (const ersatz of markiert) {
          if (ist >= soll) break;
          if (drin.has(ersatz.name_botanisch)) continue;
          const rolle = ersatz.rolle_empfehlung
            || ((ersatz.hoehe_cm_max || 50) >= 100 ? 'Leitstaude' : (ersatz.hoehe_cm_max || 50) >= 50 ? 'Begleitstaude' : 'Füllstaude');
          // Kandidat mit derselben Rolle und den wenigsten erfüllten Wünschen ersetzen.
          const opfer = plan.pflanzen
            .map((p, i) => ({ p, i, rolle: rolleVon(p), pkt: punkte(p) }))
            .filter(x => x.rolle === rolle && x.pkt === 0)
            .sort((a, b) => a.pkt - b.pkt)[0];
          if (!opfer) continue;
          plan.pflanzen[opfer.i] = {
            ...opfer.p,
            name_deutsch: ersatz.name_deutsch, name_botanisch: ersatz.name_botanisch,
            beschreibung: ersatz.beschreibung || opfer.p.beschreibung,
            bluehzeit: ersatz.bluehzeit || opfer.p.bluehzeit, farbe: ersatz.farbe || opfer.p.farbe,
            hoehe_cm: ersatz.hoehe_cm_max || opfer.p.hoehe_cm,
            pflege_sterne: ersatz.pflege_sterne || opfer.p.pflege_sterne,
            preis_stueck_eur: ersatz.preis_stueck_eur ?? opfer.p.preis_stueck_eur,
          };
          drin.delete(opfer.p.name_botanisch); drin.add(ersatz.name_botanisch);
          ist++;
          console.log('Schwerpunkt „%s": %s ersetzt durch %s', wunsch, opfer.p.name_deutsch, ersatz.name_deutsch);
        }
        if (ist < soll) console.warn('Schwerpunkt „%s": nur %d von %d erreicht — kein passender Tauschpartner', wunsch, ist, soll);
      }
    }

    // Bilder, Pflanzabstand UND Preis aus DB anreichern.
    // Der Preis ist die einzige kaufrelevante Zahl, die früher ungeprüft vom Modell durchlief —
    // die DB ist hier die Wahrheit, nicht die KI. Alle Preisanzeigen im Frontend hängen daran.
    if (Array.isArray(plan.pflanzen)) {
      plan.pflanzen = plan.pflanzen.map(p => {
        const nameBot = (p.name_botanisch || '').trim();
        // Hybrid-Marker (× / x) herausfiltern, damit z.B. "Nepeta x faassenii"
        // auf den DB-Eintrag "Nepeta faassenii" matcht (DB führt Hybride ohne Marker).
        const tokens = nameBot.split(/\s+/).filter(t => t && t !== 'x' && t !== 'X' && t !== '×');
        const genus = tokens[0] || '';
        const binomial = tokens.slice(0, 2).join(' ') || genus;
        let dbP = null;
        if (genus) {
          // Bester Treffer zuerst: exakt → gleiche Art (Gattung+Art) → nur Gattung
          dbP = db.prepare(
            `SELECT name_botanisch, bild_url, inhalt_lang, preis_stueck_eur FROM pflanzen
             WHERE name_botanisch = ? OR name_botanisch LIKE ? OR name_botanisch LIKE ?
             ORDER BY CASE WHEN name_botanisch = ? THEN 0 WHEN name_botanisch LIKE ? THEN 1 ELSE 2 END
             LIMIT 1`
          ).get(nameBot, `${binomial}%`, `${genus}%`, nameBot, `${binomial}%`);
        }
        let pflanzabstand_cm = null, fehler = null;
        if (dbP?.inhalt_lang) {
          try {
            const il = JSON.parse(dbP.inhalt_lang);
            const m = (il.pflanzabstand || '').match(/(\d+)\s*[–\-]\s*(\d+)?\s*cm/i);
            if (m) pflanzabstand_cm = m[2] ? Math.round((parseInt(m[1]) + parseInt(m[2])) / 2) : parseInt(m[1]);
            if (Array.isArray(il.fehler) && il.fehler.length) fehler = il.fehler;
          } catch {}
        }
        // Preis nur aus DB übernehmen, wenn der Treffer auf Artebene passt (exakt oder gleiche Art).
        // binomial muss dafür Gattung+Art (>=2 Tokens) haben — ein reiner Gattungsname ("Salvia")
        // würde sonst den Preis einer beliebigen Fremd-Art derselben Gattung übernehmen.
        const artTreffer = dbP && dbP.name_botanisch &&
          binomial.split(' ').length >= 2 &&
          dbP.name_botanisch.toLowerCase().startsWith(binomial.toLowerCase());
        const preis_stueck_eur = (artTreffer && dbP.preis_stueck_eur != null)
          ? dbP.preis_stueck_eur
          : p.preis_stueck_eur;
        // Giftigkeit aus der kuratierten Liste an den Plan hängen. Bis August 2026 war das
        // Feld zwar für alle 709 Pflanzen gepflegt, kam im Planer aber nie an: Es wurde
        // ausschließlich auf der Einzelpflanzenseite ausgegeben. Der Planer konnte damit
        // Eisenhut oder Fingerhut in ein Familienbeet setzen, ohne ein Wort dazu — bei
        // 141 giftigen und 22 stark giftigen Arten im Bestand.
        const gift = giftigkeit(nameBot);
        return { ...p, preis_stueck_eur, kauflink: goLink(nameBot), bild_url: dbP?.bild_url || null,
                 pflanzabstand_cm, fehler,
                 giftig: gift ? { stufe: gift.stufe, text: gift.text } : null };
      });

      /*
       * Zweites Netz für „Kindersicher". Die Kandidatenliste ist bereits gefiltert, aber das
       * Modell ist nicht daran gebunden — es kann eine Art frei ergänzen, und genau dann
       * stünde wieder Fingerhut im Familienbeet. Hier wird gestrichen, nicht gewarnt: Bei
       * dieser Auswahl ist ein Plan mit einer Art weniger besser als einer mit einer
       * giftigen Art plus Hinweis.
       */
      if (kindersicher) {
        const entfernt = plan.pflanzen.filter(p => kindersicherGrund(p.name_botanisch));
        if (entfernt.length) {
          plan.pflanzen = plan.pflanzen.filter(p => !kindersicherGrund(p.name_botanisch));
          console.warn('kindersicher: %d Art(en) nachträglich entfernt — %s',
            entfernt.length,
            entfernt.map(p => `${p.name_botanisch} (${kindersicherGrund(p.name_botanisch)})`).join(', '));
        }
      }

      // Gesamtkosten serverseitig aus (DB-)Preisen × Stückzahl — konsistent mit dem Frontend,
      // kein frei erfundener Modell-String mehr.
      const gesamt = () => plan.pflanzen.reduce((s, p) => s + (p.preis_stueck_eur || 0) * (p.stueckzahl || 1), 0);

      // Budget deterministisch erzwingen (Eval: Modell hält es von sich aus nie ein).
      // Stückzahlen in Prio-Reihenfolge kappen (Füll → Begleit → Leit → Geophyt), immer
      // die teuerste reduzierbare Art, min. 1 pro Art — Leitstauden/Struktur zuletzt.
      const budgetNum = Number(budget);
      if (Number.isFinite(budgetNum) && budgetNum > 0) {
        const prio = ['Füllstaude', 'Begleitstaude', 'Leitstaude', 'Geophyt'];
        let guard = 0;
        while (gesamt() > budgetNum && guard++ < 1000) {
          let target = null;
          for (const rolle of prio) {
            const cands = plan.pflanzen.filter(p => (p.rolle || '') === rolle && (p.stueckzahl || 1) > 1 && (p.preis_stueck_eur || 0) > 0);
            if (cands.length) { target = cands.sort((a, b) => b.preis_stueck_eur - a.preis_stueck_eur)[0]; break; }
          }
          if (!target) break; // alles bei Stückzahl 1 → nicht weiter kürzbar
          target.stueckzahl -= 1;
        }
      }

      // Gesamtkosten serverseitig aus (DB-)Preisen × Stückzahl — konsistent mit dem Frontend.
      plan.gesamtkosten_geschaetzt = gesamt();
    }

    // Eine Abschlusszeile je Lauf. Bis August stand im Log nur "OpenAI Fehler: Request timed out"
    // ohne Dauer, Fläche oder Versuchszahl — man konnte hinterher nicht sagen, welche Anfrage wie
    // lange lief. Mit dieser Zeile lässt sich prüfen, ob PLAN_VERSUCH_MS richtig gewählt ist.
    if (!notplan) {
      console.log(`plan ok ms=${Date.now() - t0} versuche=${versuche} versuch_ms=${versuchMs.join(',')} modell=${modell} flaeche=${gartenflaeche} dichte=${dichte || 'normal'} pflanzen=${Array.isArray(plan.pflanzen) ? plan.pflanzen.length : 0}`);
    }
    // Anonyme Zeile je Plan. Beantwortet die Frage, die vorher niemand beantworten konnte:
    // aus welcher Gegend kommen die Leute, die wirklich bis zum fertigen Plan durchgehen?
    // Nur die Angaben aus dem Formular, keine IP, kein Personenbezug. Ein Fehler hier darf
    // die Antwort nie gefährden — deshalb gekapselt.
    try {
      const plzSauber = typeof plz === 'string' ? plz.replace(/\D/g, '').slice(0, 5) || null : null;
      db.prepare(`INSERT INTO plan_statistik
        (plz, gartenflaeche, licht, boden, stil, dichte, vielfalt, sichtseite, geophyten, quelle, dauer_ms, arten)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        plzSauber, Number(gartenflaeche) || null,
        licht || null, boden || null, stil || null,
        dichte || null, vielfalt || null,
        typeof sichtseite === 'string' ? sichtseite.slice(0, 60) : null,
        geophyten ? 1 : 0,
        notplan ? 'datenbank' : 'ki',
        Date.now() - t0,
        Array.isArray(plan.pflanzen) ? plan.pflanzen.length : null
      );
    } catch (e) { console.warn('plan_statistik nicht geschrieben:', e.message); }

    // Gelockerte Bedingungen offenlegen. Wer „Mediterran" und „lehmig" angibt und beides
    // still fallen sieht, hält den Plan sonst für eine Antwort auf seine Angaben.
    const lockerHinweis = gelockert.length
      ? `Für die gewählte Kombination gab es zu wenige passende Stauden. Wir haben ${gelockert.length === 1 ? 'die Angabe' : 'die Angaben'} ${gelockert.join(' und ')} bei der Auswahl gelockert — Lichtverhältnisse und Winterhärte gelten unverändert.`
      : undefined;

    res.json({
      success: true, plan,
      quelle: notplan ? 'datenbank' : 'ki',
      hinweis: notplan
        ? 'Die KI war gerade nicht erreichbar. Dieser Plan wurde nach denselben Regeln aus unserer Staudendatenbank zusammengestellt — Höhenstaffelung, Rollenverteilung und Blütenfolge stimmen, nur die persönliche Handschrift fehlt.'
        : lockerHinweis,
      gelockert: gelockert.length ? gelockert : undefined,
      rag: { kandidaten: kandidaten.length, wissen: wissen.length }
    });
  } catch (err) {
    // Fängt seit der Budget-Umstellung KEINE OpenAI-Fehler mehr (die werden in der Schleife
    // behandelt), sondern nur noch Fehler aus DB-Anreicherung und Budget-Kappung. Das Präfix
    // muss das sagen, sonst laufen sie in die Timeout-Zählung und verfälschen die Messung.
    console.error(`Plan-Aufbereitung Fehler nach ${Date.now() - t0} ms:`, err.message);
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
        AND ${PLANBAR} ${exClause}
      ORDER BY RANDOM() LIMIT 1`)
      .all(`%${lichtTerm}%`, `%${bodenTerm}%`, '%normal%', `%${stilTerm}%`, ...(exclude || []));
    if (rows.length) pflanze = rows[0];
  }
  if (!pflanze) {
    const rows = db.prepare(`SELECT ${COLS} FROM pflanzen
      WHERE licht LIKE ? AND ${PLANBAR} ${exClause}
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
      kauflink: goLink(pflanze.name_botanisch),
      rolle: rolle || (hoehe_cm >= 80 ? 'Leitstaude' : hoehe_cm >= 40 ? 'Begleitstaude' : 'Füllstaude'),
    }
  });
});

// „Plan per E-Mail sichern". Zwei rechtlich verschiedene Dinge, deshalb getrennt behandelt:
//   1. Die Mail mit dem Link zum eigenen Plan ist eine Servicemail, die der Nutzer gerade
//      ausdrücklich angefordert hat. Sie geht sofort raus, ohne Bestätigungsschleife.
//   2. „Gelegentliche Gartentipps" ist Werbung. Dafür braucht es eine eigene Einwilligung
//      (Checkbox, nicht vorausgewählt) UND eine Bestätigung per Doppel-Opt-in, sonst kann
//      jeder fremde Adressen eintragen. Erst nach Klick auf den Bestätigungslink zählt sie.
app.post('/api/email-gate', rl({ windowMs: 60 * 60 * 1000, max: 10, message: { error: 'Zu viele Anfragen.' } }), async (req, res) => {
  const { email, gartenflaeche, licht, boden, stil, plz, planUrl, werbung } = req.body;
  if (!email || typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 200) {
    return res.status(400).json({ error: 'Bitte eine gültige E-Mail-Adresse eingeben.' });
  }
  // Nur eigene Links verschicken — sonst wäre der Endpunkt ein Werkzeug, um beliebige URLs
  // aus dem Namen dieser Seite zu versenden.
  const pfad = typeof planUrl === 'string' && /^\/plan\/[a-f0-9]{8,32}$/.test(planUrl) ? planUrl : null;
  const basis = process.env.SITE_URL || 'https://www.staudenplan.de';
  const willWerbung = werbung === true;
  const token = crypto.randomBytes(16).toString('hex');

  try {
    db.prepare(`INSERT INTO email_gate
      (email, gartenflaeche, licht, boden, stil, plz, quelle, werbung_einwilligung, bestaetigt, token)
      VALUES (?,?,?,?,?,?,?,?,0,?)`).run(
      email, Number(gartenflaeche) || null, licht || null, boden || null, stil || null,
      typeof plz === 'string' ? plz.replace(/\D/g, '').slice(0, 5) || null : null,
      pfad ? 'plan-per-mail' : 'pdf-download',
      willWerbung ? 1 : 0, token
    );
  } catch (err) {
    console.error('Email-Gate Fehler:', err.message);
    return res.status(500).json({ error: 'Fehler beim Speichern.' });
  }

  // Versand darf das Speichern nicht gefährden: Die Adresse ist bereits gesichert, ein
  // Mailfehler wird protokolliert, der Nutzer bekommt trotzdem eine ehrliche Rückmeldung.
  let versandOk = true;
  try {
    const bestaetigung = willWerbung
      ? `\n\nDu möchtest gelegentlich Gartentipps bekommen. Bitte bestätige das einmalig hier:\n${basis}/newsletter/bestaetigen?token=${token}\nOhne diesen Klick schicken wir dir keine Tipps.`
      : '';
    await transporter.sendMail({
      from: process.env.EMAIL_USER,
      to: email,
      subject: pfad ? 'Dein Bepflanzungsplan' : 'Dein Plan bei Staudenplan.de',
      text: (pfad
        ? `Hier ist dein Bepflanzungsplan:\n${basis}${pfad}\n\n`
          + `Der Link bleibt bestehen — ruf ihn auf, wann du willst.\n`
          + `Du kannst ihn auch weitergeben: Leite diese Mail einfach weiter oder kopiere die\n`
          + `Adresse. Wer sie öffnet, sieht deinen kompletten Plan mit Beetgrafik, Pflanzenliste\n`
          + `und Pflegehinweisen — ohne sich irgendwo anmelden zu müssen.`
        : 'Danke für dein Interesse an Staudenplan.de.')
        + bestaetigung
        + `\n\n—\nStaudenplan.de\nDu bekommst diese Mail, weil du sie auf staudenplan.de angefordert hast.`,
    });
  } catch (err) {
    versandOk = false;
    console.error('Email-Gate Versand fehlgeschlagen:', err.message);
  }

  res.json({ success: true, versandt: versandOk, bestaetigung_noetig: willWerbung });
});

// Doppel-Opt-in: erst dieser Klick macht aus der angekreuzten Checkbox eine belastbare
// Einwilligung. Ohne ihn bleibt bestaetigt=0 und die Adresse wird nie beworben.
app.get('/newsletter/bestaetigen', (req, res) => {
  const token = String(req.query.token || '');
  const seite = (titel, text) => `<!DOCTYPE html><html lang="de"><head><meta charset="UTF-8">
    <meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
    <title>${escHtml(titel)} — Staudenplan.de</title>${LEGAL_STYLE}</head><body>${LEGAL_NAV}
    <main><h1>${escHtml(titel)}</h1><p>${escHtml(text)}</p>
    <p><a href="/">Zur Startseite</a></p></main>${LEGAL_FOOTER}</body></html>`;
  if (!/^[a-f0-9]{32}$/.test(token)) return res.status(400).send(seite('Link ungültig', 'Dieser Bestätigungslink ist nicht lesbar.'));
  const r = db.prepare('UPDATE email_gate SET bestaetigt = 1 WHERE token = ? AND werbung_einwilligung = 1').run(token);
  if (!r.changes) return res.status(404).send(seite('Nichts zu bestätigen', 'Dieser Link ist abgelaufen oder wurde bereits verwendet.'));
  res.send(seite('Danke, das war es schon', 'Deine Einwilligung ist bestätigt. Du kannst dich in jeder Mail mit einem Klick wieder abmelden.'));
});

// Abmeldung. Muss ohne Anmeldung und ohne Rückfrage funktionieren — ein Abmeldelink, der
// erst ein Formular zeigt, ist keiner. Die Adresse bleibt für die Nachweispflicht stehen,
// wird aber nicht mehr beworben.
app.get('/newsletter/abmelden', (req, res) => {
  const token = String(req.query.token || '');
  const seite = (titel, text) => `<!DOCTYPE html><html lang="de"><head><meta charset="UTF-8">
    <meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
    <title>${escHtml(titel)} — Staudenplan.de</title>${LEGAL_STYLE}</head><body>${LEGAL_NAV}
    <main><h1>${escHtml(titel)}</h1><p>${escHtml(text)}</p>
    <p><a href="/">Zur Startseite</a></p></main>${LEGAL_FOOTER}</body></html>`;
  if (!/^[a-f0-9]{32}$/.test(token)) return res.status(400).send(seite('Link ungültig', 'Dieser Abmeldelink ist nicht lesbar.'));
  db.prepare("UPDATE email_gate SET werbung_einwilligung = 0, bestaetigt = 0, abgemeldet_am = datetime('now') WHERE token = ?").run(token);
  res.send(seite('Abgemeldet', 'Du bekommst keine Gartentipps mehr von uns. Deinen Planlink kannst du weiterhin aufrufen.'));
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
        `  • ${p.stueckzahl || 1}x ${p.name_deutsch} (${p.name_botanisch}) — ca. ${((p.preis_stueck_eur || 0) * (p.stueckzahl || 1)).toFixed(2)} €`
      ).join('\n')
    : '  — keine Pflanzenliste vorhanden';

  // Gesamtkosten immer aus der Pflanzenliste nachrechnen statt das mitgeschickte Feld zu glauben:
  // Der Kunde kann die Dichte verstellt haben, und die Summe soll zu den Einzelpreisen darüber
  // passen. Gerundet und mit Währung — vorher stand hier eine rohe Fließkommazahl wie "487.4".
  const kostenSumme = Array.isArray(ki_plan?.pflanzen)
    ? ki_plan.pflanzen.reduce((s, p) => s + (Number(p.preis_stueck_eur) || 0) * (Number(p.stueckzahl) || 1), 0)
    : null;
  const kostenText = kostenSumme != null && kostenSumme > 0
    ? `ca. ${Math.round(kostenSumme)} €`
    : (typeof ki_plan?.gesamtkosten_geschaetzt === 'number' ? `ca. ${Math.round(ki_plan.gesamtkosten_geschaetzt)} €` : null);

  const betreiberText = `Neue Bepflanzungsanfrage\n\nName: ${name}\nE-Mail: ${email}\nPLZ: ${plz}\nTelefon: ${telefon || '—'}\n\nGartenparameter:\n  Fläche: ${params.gartenflaeche || '—'} m²\n  Licht: ${params.licht || '—'}\n  Boden: ${params.boden || '—'}\n  Stil: ${params.stil || '—'}\n  Farbe: ${params.farbe || '—'}\n  Saison: ${params.saison || '—'}\n\nEmpfohlene Pflanzen:\n${pflanzenListe}\n\nGeschätzte Gesamtkosten: ${kostenText || '—'}\n\nAnmerkungen:\n  ${anmerkungen || '—'}`;
  const kundenText = `Hallo ${name},\n\nvielen Dank für Ihre Anfrage! Wir haben Ihren Bepflanzungsplan erhalten und leiten ihn an unsere Gärtnerei weiter, die sich mit einem konkreten Angebot für Ihr Pflanzenpaket bei Ihnen meldet.\n\nIhr Bepflanzungsplan umfasst:\n${pflanzenListe}\n\nGeschätzte Gesamtkosten: ${kostenText || 'auf Anfrage'}\n\nFreundliche Grüße\nIhr Staudenplan-Team`;

  if (process.env.EMAIL_USER && process.env.EMAIL_BETREIBER) {
    // Zwei unabhängige Sends: schlägt die Betreiber-Mail fehl, soll die Kundenbestätigung
    // trotzdem raus (und umgekehrt). Der Lead liegt ohnehin schon in der DB (/admin/anfragen).
    try {
      await transporter.sendMail({ from: process.env.EMAIL_USER, to: process.env.EMAIL_BETREIBER, subject: `Neue Bepflanzungsanfrage von ${name} (PLZ ${plz})`, text: betreiberText });
    } catch (err) { console.error('E-Mail Fehler (Betreiber):', err.message); }
    try {
      await transporter.sendMail({ from: process.env.EMAIL_USER, to: email, subject: 'Ihr Bepflanzungsplan — wir melden uns bald!', text: kundenText });
    } catch (err) { console.error('E-Mail Fehler (Kunde):', err.message); }
  } else {
    // Kein PII-Volltext in die (auf Shared-VPS geteilten) Logs — nur ein neutraler Hinweis.
    console.log(`Anfrage von ${name} gespeichert (SMTP nicht konfiguriert, Details in /admin/anfragen).`);
  }

  res.json({ success: true, message: 'Anfrage erfolgreich gesendet.' });
});

// ─── Feedback-Widget → E-Mail an Betreiber ───────────────────────────────────
const FEEDBACK_EMAIL = process.env.FEEDBACK_EMAIL || 'Rohrhuber@freisinger-gartenschmiede.de';
app.post('/api/feedback', feedbackLimiter, async (req, res) => {
  const nachricht = (req.body?.nachricht || '').toString().trim();
  if (nachricht.length < 3) return res.status(400).json({ error: 'Bitte gib eine kurze Nachricht ein.' });
  if (nachricht.length > 3000) return res.status(400).json({ error: 'Nachricht ist zu lang (max. 3000 Zeichen).' });

  // Optionale Absender-Adresse streng validieren: kein Whitespace/Komma erlaubt →
  // ausgeschlossen, dass über replyTo eine Header-Injection (CRLF) möglich wäre.
  const emailRaw = (req.body?.email || '').toString().trim();
  const absender = /^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/.test(emailRaw) ? emailRaw : null;
  const seite = (req.body?.seite || '').toString().slice(0, 200);

  const text = `Neues Feedback über Staudenplan.de\n\n`
    + `Von: ${absender || 'anonym (keine E-Mail angegeben)'}\n`
    + `Seite: ${seite || '—'}\n`
    + `Zeit: ${new Date().toLocaleString('de-DE', { timeZone: 'Europe/Berlin' })}\n\n`
    + `Nachricht:\n${nachricht}`;

  if (process.env.EMAIL_USER) {
    try {
      await transporter.sendMail({
        from: process.env.EMAIL_USER,
        to: FEEDBACK_EMAIL,
        replyTo: absender || undefined,
        subject: 'Feedback Staudenplan.de',
        text,
      });
    } catch (err) {
      console.error('Feedback-E-Mail Fehler:', err.message);
      return res.status(500).json({ error: 'Feedback konnte nicht gesendet werden. Bitte später erneut versuchen.' });
    }
  } else {
    console.log(`Feedback eingegangen (${nachricht.length} Zeichen, SMTP nicht konfiguriert).`);
  }

  res.json({ success: true });
});

// ─── Gaißmayer-Weiterleitung + Klickzählung ──────────────────────────────────
// Bot-Erkennung: maschinelle Klicks werden als bot=1 gespeichert, nicht verworfen.
// Grund: die Zahl muss belastbar sein, wenn sie Gaißmayer als Nachfragebeleg vorgelegt wird —
// ein einzelner Scraper hat die Statistik am 03.08.2026 um 58 Klicks aufgebläht.
const BOT_UA = /bot|crawler|spider|slurp|headless|python|curl|wget|scrapy|axios|okhttp|java\/|go-http|libwww|perl|phantom|puppeteer|playwright|semrush|ahrefs|mj12|dotbot|bytespider|gptbot|claudebot|ccbot|petalbot|yandex|baidu|facebookexternalhit|preview/i;
const KLICK_FENSTER_MS = 60 * 60 * 1000;  // Beobachtungsfenster: 1 Stunde
const KLICK_MAX = 5;                      // mehr als 5 Kaufklicks/Stunde ist kein echter Kaufinteressent
const KLICK_VERLAUF_MAX = 5000;           // Obergrenze gegen Speicherwachstum bei IP-Rotation
// Nur im Arbeitsspeicher und nur als Hash mit prozess-zufälligem Salt — die IP selbst wird
// nirgends gespeichert und ist nach einem Neustart auch nicht mehr rekonstruierbar.
const KLICK_SALT = crypto.randomBytes(16);
const klickVerlauf = new Map();

// Ein echter Kaufklick startet immer auf einer eigenen Seite (Planer, Pflanzenseite,
// geteilter Plan, Beispielbeet). Wegen Referrer-Policy strict-origin-when-cross-origin
// senden Browser dabei den Referer mit — fehlt er, war kein Klick im Spiel.
// Belegt am nginx-Log: von 13 refererlosen Klicks waren 12 bingbot/Amazonbot, eine
// Scraper-Flotte mit gefälschtem iPhone-UA aus Rechenzentrums-IPs oder eigene Tests.
const EIGENE_HERKUNFT = /^https?:\/\/([a-z0-9-]+\.)*staudenplan\.de(\/|$|\?)/i;

// Herkunftsfläche aus dem Referer, damit auf /admin/klicks sichtbar wird, welche Seite
// tatsächlich verkauft. Serverseitig und damit adblockerfest — die gleichnamige
// Plausible-Property sieht nur die Hälfte der Klicks und braucht einen teureren Tarif.
const QUELLEN = [
  [/^\/pflanze\//i,      'Pflanzenseite'],
  [/^\/plan\//i,         'Geteilter Plan'],
  [/^\/beispiel(e\/?$|\/)/i, 'Beispielbeet'],
  [/^\/ratgeber/i,       'Ratgeber'],
  [/^\/pflanzen\/?$/i,   'Pflanzenlexikon'],
  [/^\/$/,               'Planer'],
];

// Innerhalb des Planers liegen Pflanzenkarten und Stückliste auf derselben URL ("/"), der Referer
// kann sie also nicht trennen. Dafür hängt das Frontend ein &q=… an den Kauflink. Der Marker
// verfeinert nur, was der Referer ohnehin schon erlaubt — fälschen lässt sich damit nichts.
// Object.create(null): ein einfaches Objektliteral würde bei ?q=constructor oder ?q=toString
// einen Treffer aus der Prototypenkette liefern. Die Folge wäre kein Sicherheitsproblem, aber
// ein stiller Datenverlust — die Zeile ginge mit einem Funktionsobjekt als quelle in den INSERT
// und der Klick fehlte in genau der Statistik, die den Gaißmayer-Nachweis trägt.
const QUELLE_MARKER = Object.assign(Object.create(null), {
  karte: 'Planer (Karte)', stueckliste: 'Planer (Stückliste)',
});

function klickQuelle(req) {
  const ref = String(req.get('referer') || '');
  if (!EIGENE_HERKUNFT.test(ref)) return null;
  let pfad;
  try { pfad = new URL(ref).pathname || '/'; } catch { return null; }
  const treffer = QUELLEN.find(([muster]) => muster.test(pfad));
  const quelle = treffer ? treffer[1] : 'Sonstige';
  if (quelle === 'Planer' && typeof req.query.q === 'string' && QUELLE_MARKER[req.query.q]) {
    return QUELLE_MARKER[req.query.q];
  }
  return quelle;
}

// quelle === null bedeutet: kein Referer von der eigenen Seite → keine Nutzerinteraktion.
function istBotKlick(req, quelle) {
  if (!quelle) return true;

  const ua = String(req.get('user-agent') || '');
  if (!ua || ua.length < 15 || BOT_UA.test(ua)) return true;

  const jetzt = Date.now();
  const kennung = crypto.createHash('sha256').update(KLICK_SALT).update(String(req.ip || '')).digest('hex').slice(0, 16);
  const bisher = (klickVerlauf.get(kennung) || []).filter(t => jetzt - t < KLICK_FENSTER_MS);
  bisher.push(jetzt);
  klickVerlauf.set(kennung, bisher);

  // Aufräumen: abgelaufene Einträge raus, notfalls die ältesten opfern.
  if (klickVerlauf.size > KLICK_VERLAUF_MAX) {
    for (const [k, ts] of klickVerlauf) {
      if (!ts.length || jetzt - ts[ts.length - 1] >= KLICK_FENSTER_MS) klickVerlauf.delete(k);
      if (klickVerlauf.size <= KLICK_VERLAUF_MAX) break;
    }
    while (klickVerlauf.size > KLICK_VERLAUF_MAX) klickVerlauf.delete(klickVerlauf.keys().next().value);
  }
  return bisher.length > KLICK_MAX;
}

const insertKlick = db.prepare('INSERT INTO klicks (ziel, pflanze, bot, quelle) VALUES (?, ?, ?, ?)');
app.get('/go/gaissmayer', (req, res) => {
  const raw = typeof req.query.p === 'string' ? req.query.p : '';
  const pflanze = raw.replace(/[^\p{L}0-9 .×'’()\-]/gu, '').trim().slice(0, 120) || null;
  const quelle = klickQuelle(req);
  try { insertKlick.run('gaissmayer', pflanze, istBotKlick(req, quelle) ? 1 : 0, quelle); } catch { /* Zählung darf die Weiterleitung nie blockieren */ }
  res.set('X-Robots-Tag', 'noindex, nofollow');
  // Deeplink auf die Produktsuche mit Binomial (Gattung+Art) für robuste Treffer; sonst generischer Shop.
  const suchbegriff = pflanze ? pflanze.split(' ').slice(0, 2).join(' ') : '';
  res.redirect(302, suchbegriff ? GAISSMAYER_SEARCH + encodeURIComponent(suchbegriff) : GAISSMAYER_URL);
});

// ─── Plan teilen: öffentlicher Read-only-Link (viral + Backlinks) ─────────────
// Grafik-Parameter validieren: nur endliche, plausible Maße (>=0.1 m, sonst Endlosschleife
// bei den Gitterlinien) + Allowlists. Wird beim Speichern UND beim Rendern angewandt.
function sanitizeGrafikOpts(g) {
  if (!g || typeof g !== 'object') return {};
  const dim = (v, max) => { const n = Number(v); return Number.isFinite(n) && n >= 0.1 && n <= max ? n : undefined; };
  return {
    flaeche: dim(g.flaeche, 5000),
    beetLaenge: dim(g.beetLaenge, 500),
    beetBreite: dim(g.beetBreite, 500),
    sichtseite: typeof g.sichtseite === 'string' ? g.sichtseite.slice(0, 60) : undefined,
    dichte: ['locker', 'normal', 'dicht'].includes(g.dichte) ? g.dichte : undefined,
    form: g.form === 'zeichnen' ? 'zeichnen' : undefined,
    polygons: sanitizePolygons(g.polygons),
    platzierungen: sanitizePlatzierungen(g.platzierungen)
  };
}

// Die im Browser berechnete Pflanzenverteilung, als Anteile der Beetfläche (0…1). Sie wird
// übernommen statt neu gerechnet, damit der geteilte Plan genauso aussieht wie der eigene.
// Untrusted: Werte müssen endlich und im Bild liegen, sonst zeichnet der Renderer Kreise
// irgendwo im Nirgendwo oder mit NaN-Koordinaten. Gedeckelt auf 1500 Punkte — ein dicht
// bepflanzter 120-m²-Plan kommt auf rund 1000.
function sanitizePlatzierungen(raw) {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const punkte = [];
  for (const p of raw.slice(0, 1500)) {
    if (!p || typeof p !== 'object') continue;
    const x = Number(p.x), y = Number(p.y), r = Number(p.r), i = Number(p.i);
    // Etwas Spielraum über 0…1 hinaus: Kreise dürfen am Rand leicht überstehen, so wie sie
    // auch im Browser gezeichnet werden. Der Beschnitt am Beet erledigt den Rest.
    if (![x, y, r, i].every(Number.isFinite)) continue;
    if (x < -0.5 || x > 1.5 || y < -0.5 || y > 1.5) continue;
    if (!(r > 0) || r > 0.5) continue;
    if (!Number.isInteger(i) || i < 0 || i > 500) continue;
    punkte.push({ x, y, r, i });
  }
  return punkte.length ? punkte : undefined;
}

// Gezeichnete Freihandflächen aus (untrusted) Canvas-Koordinaten. Gedeckelt auf 6 Polygone
// à 80 Punkte — von Hand geklickte Flächen haben real 10–40 Punkte und ein bis drei Teilflächen,
// die Grenze ist also großzügig und verhindert nur eingeschleuste Riesenlisten.
// Renderzeit gemessen: typische Pläne 45–200 ms. Teuer wird nicht die Kantenzahl, sondern eine
// dicht bepflanzte große Fläche (144 m² bei Dichte "dicht" = 600 Füllstauden → ~5 s), weil dann
// die Platzierungs-Wiederholungen greifen. Das Ergebnis wird pro Plan gecacht (sharedPlanHtmlCache)
// und das Anlegen ist über planTeilenLimiter begrenzt, die Last bleibt damit gedeckelt.
// Koordinaten müssen endlich und im Canvas-Bereich liegen, damit die Normalisierung
// nie durch NaN/Infinity läuft.
function sanitizePolygons(raw) {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const koord = v => { const n = Number(v); return Number.isFinite(n) && Math.abs(n) <= 20000 ? n : null; };
  const polys = [];
  for (const p of raw.slice(0, 6)) {
    if (!p || typeof p !== 'object' || !Array.isArray(p.points)) continue;
    const points = [];
    for (const pt of p.points.slice(0, 80)) {
      if (!pt || typeof pt !== 'object') continue;
      const x = koord(pt.x), y = koord(pt.y);
      if (x === null || y === null) continue;
      points.push({ x, y });
    }
    if (points.length < 3) continue;   // erst ab 3 Punkten ist es eine Fläche
    const area = Number(p.area);
    polys.push({ points, area: Number.isFinite(area) && area > 0 ? area : undefined });
  }
  return polys.length ? polys : undefined;
}

// Canvas-Punkte → SVG-Koordinaten. Spiegelt scaledPolygonsForSVG aus stauden-portal.html:
// gemeinsame Bounding-Box über alle Polygone, auf die Beetfläche skaliert, 6 % Rand.
function scaledPolygonsSSR(polys, bedW, bedH, offsetX, offsetY) {
  if (!polys || !polys.length) return null;
  const alle = polys.flatMap(p => p.points);
  const minX = Math.min(...alle.map(p => p.x)), maxX = Math.max(...alle.map(p => p.x));
  const minY = Math.min(...alle.map(p => p.y)), maxY = Math.max(...alle.map(p => p.y));
  const rangeX = (maxX - minX) || 1, rangeY = (maxY - minY) || 1;
  const pad = 0.06;
  const sx = bedW * (1 - 2 * pad) / rangeX, sy = bedH * (1 - 2 * pad) / rangeY;
  return polys.map(poly => ({
    svgPoints: poly.points.map(pt => [
      offsetX + (pt.x - minX) * sx + bedW * pad,
      offsetY + (pt.y - minY) * sy + bedH * pad
    ]),
    area: poly.area
  }));
}

// Punkt-in-Polygon & Randführung — 1:1 aus stauden-portal.html, damit ein geteilter Plan
// dieselbe Pflanzenverteilung zeigt wie die App.
function pointInPolygonSSR(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}

function distToSegmentSSR(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(px - ax, py - ay);
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function pointInAnyPolygonSSR(x, y, polys) {
  return polys.some(p => pointInPolygonSSR(x, y, p.svgPoints));
}

function pointInAnyPolygonWithMarginSSR(x, y, polys, margin) {
  return polys.some(p => {
    if (!pointInPolygonSSR(x, y, p.svgPoints)) return false;
    const pts = p.svgPoints;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      if (distToSegmentSSR(x, y, pts[i][0], pts[i][1], pts[j][0], pts[j][1]) < margin) return false;
    }
    return true;
  });
}

function snapInsidePolygonSSR(plant, polys) {
  if (pointInAnyPolygonSSR(plant.x, plant.y, polys)) return;
  let bestX = plant.x, bestY = plant.y, bestDist = Infinity;
  polys.forEach(poly => {
    const pts = poly.svgPoints;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const [ax, ay] = pts[j], [bx, by] = pts[i];
      const edx = bx - ax, edy = by - ay, len2 = edx * edx + edy * edy;
      if (len2 < 0.001) continue;
      const t = Math.max(0, Math.min(1, ((plant.x - ax) * edx + (plant.y - ay) * edy) / len2));
      const nx = ax + t * edx, ny = ay + t * edy;
      const d = Math.hypot(plant.x - nx, plant.y - ny);
      if (d < bestDist) { bestDist = d; bestX = nx; bestY = ny; }
    }
  });
  plant.x = bestX; plant.y = bestY;
  let cx = 0, cy = 0, n = 0;
  polys.forEach(p => p.svgPoints.forEach(([x, y]) => { cx += x; cy += y; n++; }));
  if (!n) return;
  cx /= n; cy /= n;
  for (let s = 0; s < 8; s++) {
    plant.x += (cx - plant.x) * 0.12;
    plant.y += (cy - plant.y) * 0.12;
    if (pointInAnyPolygonSSR(plant.x, plant.y, polys)) return;
  }
}

function polyPointsAttrSSR(pts) {
  return pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
}

const planTeilenLimiter = rl({ windowMs: 15 * 60 * 1000, max: 20, message: { error: 'Zu viele Anfragen.' } });
app.post('/api/plan-teilen', planTeilenLimiter, (req, res) => {
  const plan = req.body && req.body.plan;
  if (!plan || !Array.isArray(plan.pflanzen) || plan.pflanzen.length === 0) {
    return res.status(400).json({ error: 'Kein gültiger Plan zum Teilen.' });
  }
  // Untrusted Pflanzen-Zahlenfelder koerzieren (String/NaN → sauber), damit der SSR-Renderer
  // nie NaN-Koordinaten baut, keine String-Konkatenation in Summen entsteht (Stored-XSS-Vektor
  // über stueckzahl) und '★'.repeat() nie mit ungültiger Zahl crasht.
  const numOrUndef = (v) => { const n = Number(v); return Number.isFinite(n) ? n : undefined; };
  plan.pflanzen = plan.pflanzen.map(p => (p && typeof p === 'object') ? {
    ...p,
    hoehe_cm: numOrUndef(p.hoehe_cm),
    stueckzahl: numOrUndef(p.stueckzahl),
    pflanzabstand_cm: numOrUndef(p.pflanzabstand_cm),
    preis_stueck_eur: numOrUndef(p.preis_stueck_eur),
    pflege_sterne: numOrUndef(p.pflege_sterne)
  } : {});
  // Fläche mitspeichern, damit die geteilte Seite den grafischen Plan (Draufsicht) zeigen kann.
  const flaeche = Number(req.body && req.body.flaeche);
  if (Number.isFinite(flaeche) && flaeche > 0 && flaeche <= 5000) plan._flaeche = flaeche;
  // Grafik-Parameter IMMER neu aus der Anfrage setzen (überschreibt evtl. in plan eingebettetes
  // _grafik → kein Validierungs-Bypass) und säubern.
  plan._grafik = sanitizeGrafikOpts(req.body && req.body.grafik);
  const serialized = JSON.stringify(plan);
  if (serialized.length > 200000) return res.status(400).json({ error: 'Plan zu groß.' });
  const id = crypto.randomBytes(6).toString('hex');
  try {
    db.prepare('INSERT INTO geteilte_plaene (id, plan_json) VALUES (?, ?)').run(id, serialized);
  } catch (e) {
    console.error('Plan-Teilen Fehler:', e.message);
    return res.status(500).json({ error: 'Speichern fehlgeschlagen.' });
  }
  res.json({ success: true, id, url: `/plan/${id}` });
});

// Geteilte Pläne sind unveränderlich → gerendertes HTML cachen (der Grafik-Renderer ist
// CPU-intensiv; so wird pro Plan nur einmal gerechnet, egal wie oft der Link aufgerufen wird).
const sharedPlanHtmlCache = new Map();
app.get('/plan/:id', (req, res) => {
  const id = req.params.id;
  if (!/^[a-f0-9]{8,32}$/.test(id)) return res.status(404).send('<h2>Plan nicht gefunden.</h2>');
  const cached = sharedPlanHtmlCache.get(id);
  if (cached) return res.send(cached);
  const row = db.prepare('SELECT plan_json FROM geteilte_plaene WHERE id = ?').get(id);
  if (!row) return res.status(404).send('<h2>Plan nicht gefunden. <a href="/">Zur Startseite</a></h2>');
  let plan;
  try { plan = JSON.parse(row.plan_json); } catch { return res.status(404).send('<h2>Plan nicht lesbar.</h2>'); }
  const html = renderSharedPlan(plan, id);
  if (sharedPlanHtmlCache.size >= 500) sharedPlanHtmlCache.clear();
  sharedPlanHtmlCache.set(id, html);
  res.send(html);
});

// Read-only-Ansicht eines geteilten Plans — kompletter Plan inkl. grafischem Plan (Draufsicht),
// Pflanzenkarten, Jahreskalender & Pflegetipps. ALLE Plan-Felder werden in den SSR-Renderern escaped.
function renderSharedPlan(plan, id) {
  const pflanzen = Array.isArray(plan.pflanzen) ? plan.pflanzen : [];
  const g = sanitizeGrafikOpts(plan._grafik);
  // Pläne, die vor August 2026 geteilt wurden, tragen die im Browser berechnete Verteilung
  // unbemerkt als plan._normPlacements mit — dort steckte zu jedem Punkt eine vollständige
  // Kopie der Pflanze, beim größten gespeicherten Plan 96 % der Daten. Der Server hat sie nie
  // gelesen und stattdessen neu gerechnet. Jetzt wird sie verwendet, damit auch die bereits
  // verschickten Links die Anordnung des Erstellers zeigen.
  if (!g.platzierungen && Array.isArray(plan._normPlacements)) {
    g.platzierungen = sanitizePlatzierungen(plan._normPlacements.map(p => ({
      x: p.xFrac, y: p.yFrac, r: p.rFrac, i: p.pi
    })));
  }
  const flaeche = Number(g.flaeche) > 0 ? Number(g.flaeche)
    : (Number(plan._flaeche) > 0 ? Number(plan._flaeche) : null);
  const konzept = plan.konzept ? escHtml(plan.konzept) : 'Staudenbeet-Plan';
  return `<!DOCTYPE html><html lang="de"><head><meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Geteilter Bepflanzungsplan | Staudenplan.de</title>
  <meta name="description" content="Ein mit Staudenplan.de erstellter Bepflanzungsplan mit ${pflanzen.length} Stauden — grafischer Plan, Pflanzenauswahl und Pflegetipps. Erstelle deinen eigenen kostenlosen Plan.">
  <meta name="robots" content="noindex, follow">
  <link rel="canonical" href="https://www.staudenplan.de/plan/${escHtml(id)}">
  ${NAV_LINKS}
  <style>
  :root{--gd:#1b4332;--gm:#2d6a4f;--gl:#52b788;--gp:#f0faf3;--ea:#7d4f2a;--tx:#222;--tl:#666;--r:12px;--sh:0 2px 10px rgba(0,0,0,.07)}
  body{font-family:system-ui,sans-serif;background:#f6faf7;margin:0;color:var(--tx)}
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
  .cta{display:inline-block;border-radius:30px;padding:14px 32px;text-decoration:none;font-weight:700}
  @media(max-width:600px){.vl-bluehzeit{display:none}}
  </style>
  </head><body>
  <div style="background:linear-gradient(135deg,#1b4332,#2d6a4f);padding:40px 20px 30px;color:#fff;text-align:center">
    <div style="font-size:2rem;margin-bottom:8px">🌿</div>
    <div style="display:inline-block;background:rgba(255,255,255,.2);border-radius:20px;padding:4px 14px;font-size:.72rem;font-weight:700;letter-spacing:.05em;text-transform:uppercase;margin-bottom:10px">Geteilter Bepflanzungsplan</div>
    <h1 style="font-size:clamp(1.3rem,4vw,1.9rem);font-weight:800;margin:0 auto;max-width:640px;line-height:1.3">${konzept}</h1>
  </div>
  <div style="max-width:900px;margin:0 auto;padding:32px 16px 60px">
    ${renderBeispielPlanSSR(plan, flaeche, g, 'geteilter-plan')}
    <div style="background:linear-gradient(135deg,#1b4332,#2d6a4f);border-radius:14px;padding:28px;color:#fff;margin-bottom:24px;text-align:center">
      <h2 style="font-size:1.2rem;margin:0 0 8px">Erstelle deinen eigenen Bepflanzungsplan</h2>
      <p style="opacity:.88;font-size:.92rem;margin:0 0 18px;line-height:1.6">Kostenlos, in 2 Minuten, ohne Anmeldung — abgestimmt auf deine Fläche, deinen Boden und deine Vorlieben.</p>
      <a class="cta" href="/" style="background:#fff;color:#1b4332">🌿 Jetzt kostenlos planen</a>
    </div>
  </div>
  ${SITE_FOOTER}
  </body></html>`;
}

// Admin: Klick-Statistik (gesamt + pro Pflanze, Fortschritt Richtung 100)
app.get('/admin/klicks', (req, res) => {
  if (!isAdmin(req)) return res.redirect('/admin/login?next=/admin/klicks');
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const ZIEL = 100;
  // Nur bot=0 zählt: Scraper und Klickserien aus derselben Quelle sind als bot=1 markiert
  // (siehe istBotKlick), damit die Zahl gegenüber Gaißmayer belastbar bleibt.
  const ECHT = "ziel = 'gaissmayer' AND COALESCE(bot,0) = 0";
  const gesamt = db.prepare(`SELECT COUNT(*) AS n FROM klicks WHERE ${ECHT}`).get().n;
  const bots = db.prepare("SELECT COUNT(*) AS n FROM klicks WHERE ziel = 'gaissmayer' AND COALESCE(bot,0) = 1").get().n;
  const proPflanze = db.prepare(`
    SELECT pflanze, COUNT(*) AS n, MAX(erstellt_am) AS letzter
    FROM klicks WHERE ${ECHT} AND pflanze IS NOT NULL
    GROUP BY pflanze ORDER BY n DESC, letzter DESC`).all();
  const proQuelle = db.prepare(`
    SELECT COALESCE(quelle,'unbekannt') AS quelle, COUNT(*) AS n
    FROM klicks WHERE ${ECHT} GROUP BY quelle ORDER BY n DESC`).all();
  const proTag = db.prepare(`
    SELECT substr(erstellt_am,1,10) AS tag,
           SUM(CASE WHEN COALESCE(bot,0) = 0 THEN 1 ELSE 0 END) AS n,
           SUM(CASE WHEN COALESCE(bot,0) = 1 THEN 1 ELSE 0 END) AS b
    FROM klicks WHERE ziel = 'gaissmayer' GROUP BY tag ORDER BY tag DESC LIMIT 30`).all();
  const pct = Math.min(100, Math.round(gesamt / ZIEL * 100));
  res.send(`<!DOCTYPE html><html lang="de"><head><meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
  <title>Gaißmayer-Klicks · Admin</title>
  <style>body{font-family:'Segoe UI',system-ui,sans-serif;background:#f8f4ef;color:#1a1a1a;max-width:820px;margin:0 auto;padding:32px 20px}
  h1{color:#1b4332;font-size:1.5rem}h2{font-size:1.05rem;color:#1b4332;margin-top:28px}
  .big{font-size:3rem;font-weight:800;color:#2d6a4f;line-height:1}
  .bar{background:#e5e0d8;border-radius:50px;height:22px;overflow:hidden;margin:12px 0 4px}
  .bar>span{display:block;height:100%;background:linear-gradient(90deg,#52b788,#1b4332)}
  table{width:100%;border-collapse:collapse;margin-top:12px;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 10px rgba(0,0,0,.06)}
  th,td{text-align:left;padding:10px 14px;border-bottom:1px solid #eee;font-size:.9rem}
  th{background:#1b4332;color:#fff}td:nth-child(2),th:nth-child(2){text-align:right;font-weight:700}
  .muted{color:#999;font-size:.82rem}</style></head><body>
  <h1>🌿 Gaißmayer-Kaufklicks <a href="/admin/logout" style="float:right;font-size:.8rem;font-weight:400;color:#999;text-decoration:none">Abmelden →</a></h1>
  <div class="big">${gesamt}<span style="font-size:1rem;color:#999;font-weight:400"> / ${ZIEL}</span></div>
  <div class="bar"><span style="width:${pct}%"></span></div>
  <p class="muted">${pct}% des Ziels${gesamt >= ZIEL ? ' — erreicht! Gaißmayer kann jetzt mit Daten angesprochen werden 🎉' : ''}
  ${bots ? ` · zusätzlich <strong>${bots}</strong> maschinelle Klicks erkannt und nicht mitgezählt` : ''}</p>
  <h2>Welche Fläche verkauft?</h2>
  ${proQuelle.length ? `<table><tr><th>Herkunft des Klicks</th><th>Klicks</th><th>Anteil</th></tr>
  ${proQuelle.map(r => `<tr><td>${esc(r.quelle)}</td><td>${r.n}</td><td class="muted" style="text-align:right">${gesamt ? Math.round(r.n / gesamt * 100) : 0} %</td></tr>`).join('')}</table>
  <p class="muted">Aus dem Referer abgeleitet, serverseitig — erfasst im Gegensatz zu Plausible auch Besucher mit Adblocker. „unbekannt“ sind Klicks von vor der Einführung dieser Spalte.</p>`
    : ''}
  <h2>Nachfrage pro Pflanze</h2>
  ${proPflanze.length ? `<table><tr><th>Pflanze (botanisch)</th><th>Klicks</th><th>Letzter Klick</th></tr>
  ${proPflanze.map(r => `<tr><td>${esc(r.pflanze)}</td><td>${r.n}</td><td class="muted">${esc(r.letzter)}</td></tr>`).join('')}</table>`
    : '<p class="muted">Noch keine Klicks erfasst.</p>'}
  <h2>Klicks pro Tag (letzte 30)</h2>
  ${proTag.length ? `<table><tr><th>Tag</th><th>Echt</th><th>Bots</th></tr>
  ${proTag.map(r => `<tr><td>${esc(r.tag)}</td><td>${r.n}</td><td class="muted" style="text-align:right">${r.b || '—'}</td></tr>`).join('')}</table>` : '<p class="muted">—</p>'}
  <p class="muted">Als maschinell gilt: Klick ohne Referer von der eigenen Seite, fehlender oder verdächtiger User-Agent, oder mehr als ${KLICK_MAX} Kaufklicks pro Stunde von derselben IP-Adresse. Die IP wird dafür nur als gesalzener Hash im Arbeitsspeicher gehalten und nie gespeichert.<br>
  Hinweis zur Einordnung: Die Bot-Erkennung läuft seit dem 06.08.2026. Ältere Markierungen stammen aus einer einmaligen rückwirkenden Bereinigung anhand der nginx-Logs, nicht aus dieser Live-Prüfung.</p>
  </body></html>`);
});

// Admin: eingegangene Anfragen direkt aus der DB (geht nie verloren, auch wenn eine Mail klemmt)
app.get('/admin/anfragen', (req, res) => {
  if (!isAdmin(req)) return res.redirect('/admin/login?next=/admin/anfragen');
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  let anfragen = [];
  try {
    anfragen = db.prepare(`SELECT id, erstellt_am, name, email, plz, telefon, anmerkungen,
      gartenflaeche, licht, boden, stil, farbe, saison, ki_plan
      FROM anfragen ORDER BY id DESC LIMIT 500`).all();
  } catch { /* Tabelle evtl. noch leer */ }

  const rows = anfragen.map(a => {
    let planInfo = '—';
    if (a.ki_plan) {
      try {
        const plan = JSON.parse(a.ki_plan);
        const n = Array.isArray(plan.pflanzen) ? plan.pflanzen.length : 0;
        const kosten = typeof plan.gesamtkosten_geschaetzt === 'number'
          ? Math.round(plan.gesamtkosten_geschaetzt) + ' €' : (plan.gesamtkosten_geschaetzt || '');
        planInfo = esc(`${n} Pflanzen${kosten ? ' · ' + kosten : ''}`);
      } catch { planInfo = '(Plan nicht lesbar)'; }
    }
    const garten = [a.gartenflaeche ? a.gartenflaeche + ' m²' : '', a.licht, a.stil].filter(Boolean).map(esc).join(' · ');
    return `<tr>
      <td class="muted">${esc(a.erstellt_am)}</td>
      <td><strong>${esc(a.name)}</strong></td>
      <td><a href="mailto:${esc(a.email)}">${esc(a.email)}</a></td>
      <td>${esc(a.plz)}</td>
      <td>${esc(a.telefon) || '—'}</td>
      <td class="muted">${garten || '—'}</td>
      <td>${planInfo}</td>
      <td class="muted">${esc(a.anmerkungen) || ''}</td>
    </tr>`;
  }).join('');

  res.send(`<!DOCTYPE html><html lang="de"><head><meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
  <title>Anfragen · Admin</title>
  <style>body{font-family:'Segoe UI',system-ui,sans-serif;background:#f8f4ef;color:#1a1a1a;max-width:1100px;margin:0 auto;padding:32px 20px}
  h1{color:#1b4332;font-size:1.5rem}
  .big{font-size:3rem;font-weight:800;color:#2d6a4f;line-height:1}
  table{width:100%;border-collapse:collapse;margin-top:16px;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 10px rgba(0,0,0,.06);font-size:.88rem}
  th,td{text-align:left;padding:9px 12px;border-bottom:1px solid #eee;vertical-align:top}
  th{background:#1b4332;color:#fff;white-space:nowrap}
  a{color:#2d6a4f}
  .muted{color:#999;font-size:.82rem}</style></head><body>
  <h1>🌿 Eingegangene Anfragen <a href="/admin/logout" style="float:right;font-size:.8rem;font-weight:400;color:#999;text-decoration:none">Abmelden →</a></h1>
  <div class="big">${anfragen.length}</div>
  <p class="muted">Direkt aus der Datenbank — unabhängig vom E-Mail-Versand. Neueste zuerst (max. 500).</p>
  ${anfragen.length ? `<table><tr><th>Datum</th><th>Name</th><th>E-Mail</th><th>PLZ</th><th>Telefon</th><th>Garten</th><th>Plan</th><th>Anmerkungen</th></tr>${rows}</table>` : '<p class="muted">Noch keine Anfragen.</p>'}
  </body></html>`);
});

// ─── Quiz-Tracking (serverseitig, adblocker-fest) → /admin/quiz ──────────────
const quizTrackLimiter = rl({ windowMs: 60 * 1000, max: 60, message: { error: 'Zu viele Anfragen.' } });
const insertQuizEvent = db.prepare('INSERT INTO quiz_events (event, quiz) VALUES (?, ?)');
app.post('/api/quiz-track', quizTrackLimiter, (req, res) => {
  const event = ((req.body && req.body.event) || '').toString();
  const quizRaw = ((req.body && req.body.quiz) || '').toString();
  if (['start', 'complete', 'to_planer'].includes(event)) {
    const quiz = ['wissen', 'gartentyp'].includes(quizRaw) ? quizRaw : null;
    try { insertQuizEvent.run(event, quiz); } catch { /* Tracking darf die Seite nie stören */ }
  }
  res.status(204).end(); // Beacon braucht keine Antwort
});

app.get('/admin/quiz', (req, res) => {
  if (!isAdmin(req)) return res.redirect('/admin/login?next=/admin/quiz');
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const agg = db.prepare('SELECT quiz, event, COUNT(*) AS n FROM quiz_events GROUP BY quiz, event').all();
  const get = (quiz, event) => (agg.find(r => r.quiz === quiz && r.event === event) || {}).n || 0;
  const proTag = db.prepare("SELECT substr(erstellt_am,1,10) AS tag, COUNT(*) AS n FROM quiz_events WHERE event='start' GROUP BY tag ORDER BY tag DESC LIMIT 30").all();
  const rate = (a, b) => b > 0 ? Math.round(a / b * 100) + ' %' : '–';
  const card = (titel, quiz) => {
    const s = get(quiz, 'start'), c = get(quiz, 'complete'), p = get(quiz, 'to_planer');
    return `<div style="background:#fff;border-radius:12px;padding:20px 24px;box-shadow:0 2px 10px rgba(0,0,0,.06);flex:1;min-width:240px">
      <h2 style="font-size:1.05rem;color:#1b4332;margin:0 0 12px">${titel}</h2>
      <div style="display:flex;gap:22px;flex-wrap:wrap">
        <div><div class="big">${s}</div><div class="muted">gestartet</div></div>
        <div><div class="big">${c}</div><div class="muted">abgeschlossen</div></div>
        <div><div class="big">${p}</div><div class="muted">→ Planer</div></div>
      </div>
      <p class="muted" style="margin-top:12px">Abschlussrate ${rate(c, s)} · Planer-Klick ${rate(p, c)} der Abschlüsse</p>
    </div>`;
  };
  res.send(`<!DOCTYPE html><html lang="de"><head><meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
  <title>Quiz-Auswertung · Admin</title>
  <style>body{font-family:'Segoe UI',system-ui,sans-serif;background:#f8f4ef;color:#1a1a1a;max-width:900px;margin:0 auto;padding:32px 20px}
  h1{color:#1b4332;font-size:1.5rem}.big{font-size:2rem;font-weight:800;color:#2d6a4f;line-height:1}
  table{width:100%;border-collapse:collapse;margin-top:12px;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 10px rgba(0,0,0,.06)}
  th,td{text-align:left;padding:10px 14px;border-bottom:1px solid #eee;font-size:.9rem}th{background:#1b4332;color:#fff}
  td:nth-child(2),th:nth-child(2){text-align:right;font-weight:700}.muted{color:#999;font-size:.82rem}a{color:#2d6a4f}</style></head><body>
  <h1>🧠 Quiz-Auswertung <a href="/admin/logout" style="float:right;font-size:.8rem;font-weight:400;color:#999;text-decoration:none">Abmelden →</a></h1>
  <p class="muted">Serverseitig gezählt — unabhängig von Adblockern/Plausible. <a href="/admin/klicks">Gaißmayer-Klicks</a> · <a href="/admin/anfragen">Anfragen</a></p>
  <div style="display:flex;gap:16px;flex-wrap:wrap;margin-top:16px">${card('Wissenstest', 'wissen')}${card('Gartentyp-Quiz', 'gartentyp')}</div>
  <h2 style="font-size:1.05rem;color:#1b4332;margin-top:28px">Quiz-Starts pro Tag (letzte 30)</h2>
  ${proTag.length ? `<table><tr><th>Tag</th><th>Starts</th></tr>${proTag.map(r => `<tr><td>${esc(r.tag)}</td><td>${r.n}</td></tr>`).join('')}</table>` : '<p class="muted">Noch keine Quiz-Aktivität.</p>'}
  </body></html>`);
});

// Wer plant hier eigentlich? Bis August 2026 wurde die PLZ bei jedem Plan abgefragt und
// weggeworfen — die Frage, wie groß der regionale Anteil ist, war deshalb unbeantwortbar.
app.get('/admin/plaene', (req, res) => {
  if (!isAdmin(req)) return res.redirect('/admin/login?next=/admin/plaene');
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const q = (sql, ...a) => { try { return db.prepare(sql).all(...a); } catch { return []; } };

  const gesamt = (q('SELECT COUNT(*) n FROM plan_statistik')[0] || {}).n || 0;
  const mitPlz = (q("SELECT COUNT(*) n FROM plan_statistik WHERE plz IS NOT NULL AND plz != ''")[0] || {}).n || 0;
  // Erste zwei Ziffern = Leitregion. Feiner aufzulösen lohnt bei dieser Fallzahl nicht.
  const regionen = q(`SELECT substr(plz,1,2) AS lr, COUNT(*) n FROM plan_statistik
                      WHERE plz IS NOT NULL AND length(plz) >= 2 GROUP BY lr ORDER BY n DESC`);
  const proTag = q("SELECT substr(erstellt_am,1,10) tag, COUNT(*) n FROM plan_statistik GROUP BY tag ORDER BY tag DESC LIMIT 30");
  const verteilung = (spalte) => q(`SELECT ${spalte} w, COUNT(*) n FROM plan_statistik WHERE ${spalte} IS NOT NULL GROUP BY w ORDER BY n DESC LIMIT 8`);
  const flaeche = q(`SELECT MIN(gartenflaeche) min, MAX(gartenflaeche) max, AVG(gartenflaeche) avg FROM plan_statistik WHERE gartenflaeche > 0`)[0] || {};
  const quelle = q("SELECT quelle w, COUNT(*) n FROM plan_statistik GROUP BY w");
  const mails = q("SELECT COUNT(*) gesamt, SUM(werbung_einwilligung) angekreuzt, SUM(bestaetigt) bestaetigt FROM email_gate")[0] || {};

  // Freising liegt in der Leitregion 85 — der Umkreis, in dem ein Betrieb fährt.
  const regional = regionen.filter(r => ['80', '81', '82', '83', '84', '85', '86'].includes(r.lr)).reduce((s, r) => s + r.n, 0);

  const tab = (titel, rows, spalte = 'Wert') => rows.length
    ? `<h2>${titel}</h2><table><tr><th>${spalte}</th><th>Anzahl</th></tr>${rows.map(r => `<tr><td>${esc(r.w ?? r.lr ?? r.tag)}</td><td>${r.n}</td></tr>`).join('')}</table>`
    : `<h2>${titel}</h2><p class="muted">Noch keine Daten.</p>`;

  res.send(`<!DOCTYPE html><html lang="de"><head><meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
  <title>Planungen · Admin</title>
  <style>body{font-family:'Segoe UI',system-ui,sans-serif;background:#f8f4ef;color:#1a1a1a;max-width:900px;margin:0 auto;padding:32px 20px}
  h1{color:#1b4332;font-size:1.5rem}h2{font-size:1.05rem;color:#1b4332;margin-top:28px}
  .big{font-size:2rem;font-weight:800;color:#2d6a4f;line-height:1}
  table{width:100%;border-collapse:collapse;margin-top:12px;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 10px rgba(0,0,0,.06)}
  th,td{text-align:left;padding:10px 14px;border-bottom:1px solid #eee;font-size:.9rem}th{background:#1b4332;color:#fff}
  td:nth-child(2),th:nth-child(2){text-align:right;font-weight:700}.muted{color:#999;font-size:.82rem}a{color:#2d6a4f}
  .karten{display:flex;gap:16px;flex-wrap:wrap;margin-top:16px}
  .karte{background:#fff;border-radius:12px;padding:20px 24px;box-shadow:0 2px 10px rgba(0,0,0,.06);flex:1;min-width:200px}</style></head><body>
  <h1>📍 Planungen <a href="/admin/logout" style="float:right;font-size:.8rem;font-weight:400;color:#999;text-decoration:none">Abmelden →</a></h1>
  <p class="muted">Anonyme Statistik je erstelltem Plan, ohne IP und ohne Personenbezug.
    <a href="/admin/klicks">Kaufklicks</a> · <a href="/admin/anfragen">Anfragen</a> · <a href="/admin/quiz">Quiz</a></p>
  <div class="karten">
    <div class="karte"><div class="big">${gesamt}</div><div class="muted">Pläne erfasst</div></div>
    <div class="karte"><div class="big">${mitPlz}</div><div class="muted">davon mit PLZ</div></div>
    <div class="karte"><div class="big">${regional}</div><div class="muted">Leitregion 80–86 (Großraum München/Freising)</div></div>
    <div class="karte"><div class="big">${mails.gesamt || 0}</div><div class="muted">E-Mail-Adressen — ${mails.angekreuzt || 0} für Tipps angekreuzt, ${mails.bestaetigt || 0} bestätigt</div></div>
  </div>
  ${gesamt === 0 ? '<p class="muted" style="margin-top:24px">Die Erfassung läuft seit dem Deploy am 08.08.2026. Ältere Pläne sind nicht nachträglich rekonstruierbar.</p>' : ''}
  ${flaeche.min != null ? `<h2>Beetgröße</h2><p class="muted">kleinste ${Number(flaeche.min).toFixed(1)} m² · größte ${Number(flaeche.max).toFixed(1)} m² · Durchschnitt ${Number(flaeche.avg).toFixed(1)} m²</p>` : ''}
  ${tab('Nach Leitregion (erste zwei PLZ-Ziffern)', regionen, 'Leitregion')}
  ${tab('Lichtverhältnisse', verteilung('licht'), 'Licht')}
  ${tab('Bodenart', verteilung('boden'), 'Boden')}
  ${tab('Gartenstil', verteilung('stil'), 'Stil')}
  ${tab('Woher kam der Plan', quelle, 'Quelle')}
  ${tab('Pläne pro Tag (letzte 30)', proTag.map(r => ({ w: r.tag, n: r.n })), 'Tag')}
  </body></html>`);
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
  // Kein Disallow für /go/ — bewusst. Gesperrte URLs kann Google nicht abrufen und deshalb
  // auch nicht sauber verwerfen: Sie standen dauerhaft als "Durch robots.txt blockiert" im
  // Indexierungsbericht (Stand 14.08.2026: 262 von 445 Meldungen) und verdeckten die echten
  // Probleme. Die Route selbst sendet X-Robots-Tag: noindex, nofollow und die Links tragen
  // rel="nofollow" — Google darf den Redirect also abrufen, sieht das noindex und wirft die
  // URLs endgültig raus. Die Crawls zählen nicht als Nachfrage mit: istBotKlick wertet sie
  // über fehlenden Referer und Googlebot-UA als maschinell.
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

// ─── Pinterest-Feeds ──────────────────────────────────────────────────────────
// Pinterest kann einen RSS-Feed selbst abholen und daraus Pins veröffentlichen: bis zu 200
// am Tag, ohne API, ohne App-Freigabe, ohne Token, der nach 30 Tagen abläuft. Das ist der
// einzige Weg, der ohne Standard Access öffentlich sichtbare Pins erzeugt — unter Trial
// Access sind erzeugte Pins nur für den Ersteller sichtbar.
//
// Ein Feed je Pinnwand, so verlangt es Pinterest beim Einrichten. Die Zuordnung steht schon
// in pin-text.js; hier wird nur nach ihr gruppiert.
//
// Der Inhalt kommt aus public/pins/liste.json, die scripts/pins-erzeugen.js im selben Lauf
// wie die Bilder schreibt. Dadurch können Bild und Text nicht auseinanderlaufen.
const PIN_LISTE = path.join(__dirname, 'public', 'pins', 'liste.json');

function pinsLesen() {
  try {
    const roh = JSON.parse(fs.readFileSync(PIN_LISTE, 'utf8'));
    // Nur Einträge, deren Bild wirklich liegt. Ein Feed-Eintrag ohne abrufbares Bild wird von
    // Pinterest stillschweigend übergangen — der Pin fehlt dann, ohne dass etwas protokolliert
    // wird. Lieber gar nicht ausliefern als unbemerkt verschlucken lassen.
    return roh.filter(e => e && e.datei && fs.existsSync(path.join(__dirname, 'public', 'pins', e.datei)));
  } catch { return []; }
}

const pinBrettSlug = b => slugify(String(b || ''));

function rssBauen({ titel, beschreibung, eintraege }) {
  // Älteste zuerst: Pinterest arbeitet den Feed in dieser Richtung ab. Die Datei in derselben
  // Reihenfolge auszuliefern macht nachvollziehbar, was als Nächstes erscheint.
  const sortiert = [...eintraege].sort((a, b) =>
    (Date.parse(a.pubDate) || 0) - (Date.parse(b.pubDate) || 0) || String(a.guid).localeCompare(String(b.guid)));

  const items = sortiert.map(e => `  <item>
    <title>${escHtml(e.titel)}</title>
    <link>${escHtml(e.link)}</link>
    <description>${escHtml(e.beschreibung)}</description>
    <guid isPermaLink="false">${escHtml(e.guid)}</guid>
    <pubDate>${escHtml(e.pubDate)}</pubDate>
    <enclosure url="${escHtml(e.bild)}" type="image/jpeg" length="${Number(e.bytes) || 0}"/>
    <media:content url="${escHtml(e.bild)}" medium="image" type="image/jpeg"/>
  </item>`).join('\n');

  // RSS 2.0, kein Atom — Atom unterstützt Pinterest ausdrücklich nicht. Das Bild steht doppelt
  // als enclosure UND media:content: Pinterest liest beide, und welches der Feed-Leser nimmt,
  // ist nicht dokumentiert.
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/">
<channel>
  <title>${escHtml(titel)}</title>
  <link>https://www.staudenplan.de/</link>
  <description>${escHtml(beschreibung)}</description>
  <language>de-de</language>
${items}
</channel>
</rss>`;
}

// Übersicht mit den Feed-Adressen zum Kopieren. Pinterest verlangt beim Einrichten eine URL
// je Pinnwand; die hier stehen zu haben erspart das Zusammensuchen.
app.get('/pinterest', (req, res) => {
  const alle = pinsLesen();
  const jeBrett = {};
  for (const e of alle) (jeBrett[e.board] = jeBrett[e.board] || []).push(e);
  const zeilen = Object.entries(jeBrett).sort((a, b) => b[1].length - a[1].length).map(([b, l]) =>
    `<tr><td>${escHtml(b)}</td><td style="text-align:right">${l.length}</td>
     <td><a href="/pinterest/${pinBrettSlug(b)}.xml">/pinterest/${pinBrettSlug(b)}.xml</a></td></tr>`).join('');
  res.set('X-Robots-Tag', 'noindex');
  res.send(`<!DOCTYPE html><html lang="de"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>Pinterest-Feeds</title><style>
body{font-family:'Segoe UI',system-ui,sans-serif;background:#f8f4ef;color:#1a1a1a;padding:32px;line-height:1.6}
table{border-collapse:collapse;margin:18px 0;background:#fff;border-radius:8px;overflow:hidden}
td,th{padding:9px 14px;border-bottom:1px solid #e0d9cf;font-size:.9rem}
th{background:#1b4332;color:#fff;text-align:left}a{color:#2d6a4f}
.hinweis{background:#fff;border-left:4px solid #2d6a4f;padding:14px 18px;border-radius:0 8px 8px 0;max-width:70ch}
</style></head><body>
<h1>Pinterest-Feeds</h1>
<p>${alle.length} Pins bereit. Beim Einrichten in Pinterest je Pinnwand einen Feed verbinden.</p>
<table><tr><th>Pinnwand</th><th>Pins</th><th>Feed</th></tr>${zeilen}</table>
<div class="hinweis"><strong>Zuerst der Probelauf:</strong>
<a href="/pinterest/probe.xml">/pinterest/probe.xml</a> liefert fünf gemischte Pins.
Den auf die geheime Testpinnwand legen und 24 Stunden abwarten — erst danach die echten Feeds
verbinden. Ein falsch angeschlossener Feed produziert hunderte Pins, die einzeln gelöscht
werden müssen.</div>
</body></html>`);
});

app.get('/pinterest/:datei', (req, res) => {
  const name = String(req.params.datei || '').replace(/\.xml$/i, '');
  const alle = pinsLesen();
  if (!alle.length) {
    return res.status(503).type('text/plain').send('Noch keine Pins erzeugt — scripts/pins-erzeugen.js laufen lassen.');
  }

  if (name === 'probe') {
    // Fünf Stück, bewusst je Sorte eines: Der Probelauf soll alle vier Bauarten einmal durch
    // Pinterest schicken, nicht fünfmal dieselbe.
    const jeTyp = {};
    for (const e of alle) if (!jeTyp[e.typ]) jeTyp[e.typ] = e;
    const auswahl = Object.values(jeTyp).slice(0, 5);
    res.type('application/rss+xml; charset=utf-8');
    return res.send(rssBauen({
      titel: 'Staudenplan.de — Probelauf',
      beschreibung: 'Fünf Pins zum Prüfen, bevor die echten Feeds verbunden werden.',
      eintraege: auswahl,
    }));
  }

  const auswahl = alle.filter(e => pinBrettSlug(e.board) === name);
  if (!auswahl.length) return res.status(404).type('text/plain').send('Kein Feed unter diesem Namen.');

  res.type('application/rss+xml; charset=utf-8');
  res.send(rssBauen({
    titel: `Staudenplan.de — ${auswahl[0].board}`,
    beschreibung: `${auswahl[0].board}: Stauden, Beetpläne und Kombinationen von staudenplan.de.`,
    eintraege: auswahl,
  }));
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
  <link rel="icon" href="/favicon.ico" sizes="any"><link rel="icon" type="image/svg+xml" href="/favicon.svg"><link rel="apple-touch-icon" href="/apple-touch-icon.png">
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
    <!-- Das TMG wurde im Mai 2024 durch das Digitale-Dienste-Gesetz (DDG) abgelöst; die
         Impressumspflicht steht seither in § 5 DDG, die Verantwortlichkeit in § 7 DDG. Der
         Rundfunkstaatsvertrag ist seit 2020 durch den Medienstaatsvertrag ersetzt (§ 18 MStV). -->
    <h2>Angaben gemäß § 5 DDG</h2>
    <p><strong>Gartenschmiede GmbH</strong><br>
    Ortsstraße 7<br>85354 Freising</p>
    <h2>Kontakt</h2>
    <p>Telefon: 08161 97 60 380<br>
    E-Mail: <a href="mailto:info@gartenschmiede.de">info@gartenschmiede.de</a></p>
    <h2>Vertreten durch</h2>
    <p>Marco Holmer, Bastian Rohrhuber</p>
    <h2>Handelsregister</h2>
    <p>Registergericht: Amtsgericht München<br>
    Registernummer: HRB 239683</p>
    <!-- Umsatzsteuer-ID hier nur eintragen, wenn tatsächlich eine erteilt wurde;
         ohne USt-IdNr. entfällt die Zeile ersatzlos. Ein Platzhalter ist unzulässig. -->
    <h2>Verantwortlich für den Inhalt nach § 18 Abs. 2 MStV</h2>
    <p>Bastian Rohrhuber<br>Ortsstraße 7, 85354 Freising</p>
    <h2 id="haftung">Haftungsausschluss</h2>
    <h3>1. Allgemeine Inhalte</h3>
    <p>Die Inhalte dieser Website wurden mit größtmöglicher Sorgfalt erstellt. Für die Richtigkeit, Vollständigkeit und Aktualität der Inhalte können wir jedoch keine Gewähr übernehmen. Als Diensteanbieter sind wir gemäß § 7 Abs. 1 DDG für eigene Inhalte auf diesen Seiten nach den allgemeinen Gesetzen verantwortlich.</p>
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
    <p><strong>Plan per E-Mail:</strong> Wenn Sie sich den Link zu Ihrem Bepflanzungsplan zuschicken lassen, speichern wir Ihre E-Mail-Adresse zusammen mit den Eckdaten des Plans (Fläche, Lichtverhältnisse, Bodenart, Gartenstil, Postleitzahl). Rechtsgrundlage ist Art. 6 Abs. 1 lit. b DSGVO — Sie haben diese Zusendung ausdrücklich angefordert. Wir verwenden die Adresse für diesen Zweck und löschen sie auf Wunsch jederzeit.</p>
    <p><strong>Gartentipps per E-Mail (freiwillig):</strong> Nur wenn Sie das Kästchen „Schickt mir gelegentlich Gartentipps" aktiv angekreuzt <em>und</em> anschließend den Bestätigungslink in der E-Mail angeklickt haben, senden wir Ihnen gelegentlich Pflanz- und Pflegehinweise. Rechtsgrundlage ist Ihre Einwilligung nach Art. 6 Abs. 1 lit. a DSGVO. <strong>Sie können diese Einwilligung jederzeit widerrufen</strong> — über den Abmeldelink in jeder dieser E-Mails oder formlos per Nachricht an uns. Die Rechtmäßigkeit der bis dahin erfolgten Verarbeitung bleibt davon unberührt. Ohne Bestätigungsklick erhalten Sie keine Gartentipps.</p>
    <p><strong>Anonyme Planungsstatistik:</strong> Bei jedem erstellten Bepflanzungsplan speichern wir die Eckdaten des geplanten Beets (Fläche, Licht, Boden, Stil, Pflanzdichte, Postleitzahl) ohne jeden Personenbezug — ohne IP-Adresse, ohne Kennung, ohne Verbindung zu einer E-Mail-Adresse. Diese Angaben lassen sich keiner Person zuordnen und dienen ausschließlich der Verbesserung des Planers und der Frage, für welche Standorte er genutzt wird. Rechtsgrundlage ist unser berechtigtes Interesse nach Art. 6 Abs. 1 lit. f DSGVO.</p>
    <h2>4. Ihre Rechte</h2>
    <p>Sie haben das Recht auf Auskunft, Berichtigung, Löschung, Einschränkung der Verarbeitung sowie Datenübertragbarkeit Ihrer gespeicherten personenbezogenen Daten. Wenden Sie sich dazu an: <a href="mailto:info@gartenschmiede.de">info@gartenschmiede.de</a></p>
    <p>Sie haben außerdem das Recht, sich bei einer Aufsichtsbehörde zu beschweren. Zuständig ist das Bayerische Landesamt für Datenschutzaufsicht (BayLDA), Promenade 18, 91522 Ansbach.</p>
    <h2>5. Webanalyse (Plausible)</h2>
    <p>Diese Website nutzt <strong>Plausible Analytics</strong> zur datenschutzfreundlichen Besucherstatistik. Plausible erhebt keine personenbezogenen Daten, setzt keine Cookies und ist vollständig DSGVO-konform. Es werden ausschließlich aggregierte, anonymisierte Seitenaufrufstatistiken erfasst (Seitenaufrufe, Verweildauer, Herkunftsland). Ihre IP-Adresse wird dabei nicht gespeichert. Betreiber: Plausible Insights OÜ, Västriku tn 2, 50403 Tartu, Estland. Weitere Informationen: <a href="https://plausible.io/data-policy" target="_blank" rel="noopener">plausible.io/data-policy</a></p>
    <h2>6. Cookies</h2>
    <p>Diese Website verwendet keine eigenen Tracking-Cookies und keine Werbe-Cookies. Es werden ausschließlich technisch notwendige Funktionen ohne Cookie-Einsatz verwendet. Bitte beachten Sie, dass externe Websites (z.B. die verlinkte Staudengärtnerei Gaißmayer), die Sie über Links auf dieser Website aufrufen, eigene Cookies setzen können. Für diese gilt die jeweilige Datenschutzerklärung des Anbieters.</p>
    <h2>6. Empfehlungslinks (Staudengärtnerei)</h2>
    <p>Diese Website verweist von einzelnen Pflanzenseiten sowie aus den KI-Bepflanzungsplänen auf die Staudengärtnerei Gaißmayer (gaissmayer.de), damit Sie die vorgestellten Stauden dort beziehen können. Es handelt sich um redaktionelle Empfehlungslinks. <strong>Es besteht derzeit keine bezahlte Partnerschaft und wir erhalten für diese Verweise keine Provision.</strong></p>
    <p>Wenn Sie einen solchen Link anklicken, werden Sie über eine interne Weiterleitung (/go/…) zum Angebot des Drittanbieters geführt. Wir zählen dabei anonym und ohne Cookies mit, welche Pflanze angeklickt wurde; personenbezogene Daten (z.B. Ihre IP-Adresse) werden hierbei nicht gespeichert. Auf der Zielseite gilt die Datenschutzerklärung des jeweiligen Anbieters.</p>
    <h2>7. Externe Links</h2>
    <p>Diese Website enthält Links zu externen Websites. Für den Inhalt dieser externen Seiten sind ausschließlich deren Betreiber verantwortlich. Zum Zeitpunkt der Verlinkung wurden die Seiten auf mögliche Rechtsverstöße überprüft — eine permanente inhaltliche Kontrolle ist ohne konkrete Anhaltspunkte nicht zumutbar.</p>
    <p style="margin-top:24px;color:#aaa;font-size:.83rem">Stand: ${new Date().toLocaleDateString('de-DE', {month:'long',year:'numeric'})}</p>
  </main>
  ${LEGAL_FOOTER}
  </body></html>`);
});


// ─── Admin-Übersicht ─────────────────────────────────────────────────────────

app.get('/admin', (req, res) => {
  if (!isAdmin(req)) return res.redirect('/admin/login?next=/admin');

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

Ich habe das mit einem kostenlosen KI-Tool geplant: https://www.staudenplan.de/ratgeber/teichrand-sumpfbeet-bepflanzen-stauden-fuer-feuchte-standorte`},
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
    const r=await fetch('/api/ki-bild-ablehnen/'+id,{method:'POST'});
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
      const resp = await fetch('/api/antwort-generieren', {
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
  child.on('error', e => console.error('Kindprozess-Fehler:', e.message));
  child.unref();
  res.json({ ok: true });
});

// Bild-Vorschlag übernehmen: wird zum neuen bild_url, Vorschlag wird geleert
app.post('/api/bild-approve/:id', adminActionLimiter, (req, res) => {
  if (!checkAdminPw(req, res)) return;
  const id = parseInt(req.params.id);
  if (!id) return res.status(400).json({ error: 'id fehlt' });
  const p = db.prepare('SELECT bild_vorschlag, bild_ki FROM pflanzen WHERE id=?').get(id);
  if (!p || !p.bild_vorschlag) return res.status(404).json({ error: 'Kein offener Vorschlag.' });
  db.prepare(
    `UPDATE pflanzen SET bild_url=?, bild_vorschlag=NULL, bild_check_info=NULL, bild_geprueft=1${p.bild_ki ? ", bild_lizenz='KI-generiert / OpenAI'" : ''} WHERE id=?`
  ).run(p.bild_vorschlag, id);
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
  child.on('error', e => console.error('Kindprozess-Fehler:', e.message));
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
  child.on('error', e => console.error('Kindprozess-Fehler:', e.message));
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
  child.on('error', e => console.error('Kindprozess-Fehler:', e.message));
  child.unref();
  res.json({ ok: true });
});

// Vorlagen-Tab: Kundenfrage -> KI-Antwortentwurf zum Copy-Paste
app.post('/api/antwort-generieren', adminActionLimiter, async (req, res) => {
  if (!checkAdminPw(req, res)) return;
  const { frage } = req.body;
  if (!frage || typeof frage !== 'string') return res.status(400).json({ error: 'frage fehlt' });
  try {
    const completion = await getOpenAI().chat.completions.create({
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: 'Du bist Gartenberater bei Staudenplan.de, einem Anbieter für KI-gestützte Bepflanzungspläne mit Pflanzenlieferung. Ein potenzieller Kunde hat eine Frage per E-Mail/Chat gestellt. Schreibe eine freundliche, fachlich fundierte, aber knappe Antwort (max. 150 Wörter) auf Deutsch, die konkret auf die Frage eingeht und beiläufig auf das kostenlose KI-Planungstool auf staudenplan.de hinweist. Kein Briefkopf, keine Anrede-/Grußformel-Floskeln — nur der copy-paste-fertige Fließtext.' },
        { role: 'user', content: frage },
      ],
      temperature: 0.6,
    });
    res.json({ antwort: completion.choices[0].message.content });
  } catch (err) {
    console.error('Antwort-Generieren Fehler:', err.message);
    res.status(500).json({ error: 'KI-Generierung fehlgeschlagen.' });
  }
});

// ─── Pflanzenseiten (SEO) ─────────────────────────────────────────────────────

app.get('/pflanzen', (req, res) => {
  const total = db.prepare("SELECT COUNT(*) as n FROM pflanzen WHERE name_deutsch != 'Test-Pflanze'").get().n;
  res.send(`<!DOCTYPE html><html lang="de"><head>
  <meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Stauden suchen & filtern — ${total} winterharte Gartenstauden | Staudenplan.de</title>
  <meta name="description" content="Alle ${total} winterharten Gartenstauden filtern nach Standort, Blühzeit, Farbe, Höhe, Feuchtigkeit und mehr — mit Fotos, Pflege-Tipps und Kauflink.">
  <link rel="icon" href="/favicon.ico" sizes="any"><link rel="icon" type="image/svg+xml" href="/favicon.svg"><link rel="apple-touch-icon" href="/apple-touch-icon.png">
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

// Slugs zusammengeführter Dubletten. Die Zeilen sind aus der DB entfernt, ihre URLs waren aber
// indexiert — deshalb 301 auf die verbleibende Seite statt 404. Bei künftigen Zusammenführungen
// hier ergänzen.
// Object.create(null) wie bei QUELLE_MARKER: sonst liefe /pflanze/constructor auf einen
// Prototypentreffer und würde mit 301 auf eine Unsinns-URL weiterleiten statt 404 zu geben.
const SLUG_ALIASE = Object.assign(Object.create(null), {
  'cimicifuga-ramosa': 'actaea-simplex',   // Cimicifuga ramosa ist ein Synonym von Actaea simplex
  'camasia-quamash':   'camassia-quamash', // Tippfehler im botanischen Namen, eigene Zeile
  // Aus den nginx-Logs: URLs, die Googlebot noch aufruft und die seit dem Namensaudit
  // 404 liefern. Gattungs-only-Slugs (frühere Sammeleinträge) zeigen auf die Art, die
  // den Eintrag übernommen hat.
  'anaphalis':                'anaphalis-triplinervis',
  'aubrieta':                 'aubrieta-deltoidea',
  'carex-montana':            'carex',
  'epimedium-spp':            'epimedium-x-versicolor',
  'hemerocallis':             'hemerocallis-fulva',
  'hosta-spp':                'hosta-sieboldiana',
  'hylotelephium-spectabile': 'hylotelephium-herbstfreude',
  'lamiastrum-galeobdolon':   'lamium-galeobdolon',  // Lamiastrum ist ein Synonym von Lamium
  'ligularia':                'ligularia-dentata',
  'nepeta-x-faassenii':       'nepeta-faassenii',
  'primula':                  'primula-vulgaris',
  'pulmonaria-spp':           'pulmonaria-officinalis',
  'sempervivum':              'sempervivum-tectorum',
  'sonnenhut':                'rudbeckia-fulgida',    // deutscher Name in Botanik-Slug-Pfad
  'tradescantia':             'tradescantia-andersoniana',
  'typha':                    'typha-minima',
  // Zweite Runde, aus den nginx-Logs vom 08.–17.08.2026: Slugs, die durch das
  // Namensaudit vom 06.08. weggefallen sind. Der Eintrag existiert weiter, nur unter
  // dem heute gültigen botanischen Namen — deshalb 301 und nicht 404.
  'aster-novae-angliae':      'symphyotrichum-novae-angliae', // Aster novae-angliae = Symphyotrichum novae-angliae
  // Der Eintrag „Glattblattaster" heißt seit dem Audit Symphyotrichum laeve. Botanisch ist
  // Aster novi-belgii aber S. novi-belgii, nicht S. laeve — die Weiterleitung folgt der
  // Zeile, die die URL bediente. Ob das Audit hier richtig lag, ist eine Datenfrage.
  'aster-novi-belgii':        'symphyotrichum-laeve',
  'aster-novi-belgii-glattblattaster': 'symphyotrichum-laeve',
  'chrysanthemum-indicum':    'chrysanthemum-x-hortorum', // Gartenchrysanthemen stehen als C. x hortorum in der DB
  'cimicifuga-simplex':       'actaea-simplex',       // wie cimicifuga-ramosa: Cimicifuga ist Synonym von Actaea
  'delosperma':               'delosperma-cooperi',
  'dicentra-spectabilis':     'lamprocapnos-spectabilis', // Tränendes Herz steht heute in Lamprocapnos
  'geranium-rozanne':         'geranium-x-rozanne',   // dieselbe Sorte, nur der Slug änderte sich
  'helenium-hybride':         'helenium-autumnale',   // Sammeleintrag der Sonnenbraut-Hybriden
  'hosta':                    'hosta-sieboldiana',    // wie hosta-spp
  'lycopus':                  'lycopus-europaeus',
  'sagittaria':               'sagittaria-sagittifolia',
  'sedum-telephium':          'hylotelephium-telephium', // Sedum telephium steht heute in Hylotelephium
});

// Ratgeber-Slugs, die beim Titel-Audit umbenannt oder beim Zusammenführen doppelter
// Artikel aufgelöst wurden. Google hat die alten URLs noch im Index und crawlt sie
// weiter — 301 statt 404, damit die Signale erhalten bleiben.
// Bei künftigen Titeländerungen und Zusammenführungen hier ergänzen; danach
// `node scripts/check-ratgeber-aliase.js` laufen lassen, das findet tote Ziele,
// Weiterleitungsketten und interne Links, die auf eine Weiterleitung zeigen.
const RATGEBER_ALIASE = Object.assign(Object.create(null), {
  'bewaehrte-dreier-kombinationen-die-wichtigsten-trios-der-staudenplanung':          'klassische-dreierkombinationen-fuer-staudenbeete',
  'bienenfreundliche-stauden-top-15-trachtpflanzen-fuer-deinen-garten':               'stauden-fuer-bienen-und-insekten-insektenfreundlicher-garten',
  'bienenweide-stauden-und-insektenfoerderung':                                       'stauden-fuer-bienen-und-insekten-insektenfreundlicher-garten',
  'bepflanzungsplan-online-erstellen-der-kostenlose-ki-planer-fuer-dein-staudenbeet': 'gartenplanung-online-mit-ki-zum-fertigen-staudenbeet-plan',
  'bodendecker-stauden-flaechendeckende-pflanzen-fuer-weniger-unkraut':               'bodendecker-stauden-flaechendeckende-pflanzen-fuer-alle-standorte',
  'bodenvorbereitung-und-standortverbesserung':                                       'bodenvorbereitung-fuer-staudenbeete-standort-richtig-vorbereiten',
  'cottage-garten-und-englischer-gartenstil':                                         'cottage-garten-anlegen-romantische-bepflanzung-nach-englischem-vorbild',
  // Zeigte auf "…-theorie-und-praxis", das beim Zusammenführen wegfiel → direkt auf den Nachfolger,
  // sonst entstünde eine 301-Kette.
  'farbgestaltung-im-staudenbeet':                                                    'staudenbeet-farbgestaltung-harmonische-farbkombinationen-planen',
  'farbgestaltung-im-staudenbeet-theorie-und-praxis':                                 'staudenbeet-farbgestaltung-harmonische-farbkombinationen-planen',
  'fehler-vermeiden-haeufige-planungsfehler-in-staudenbeeten':                        'haeufige-planungs-und-pflanzfehler-im-staudenbeet',
  'feuchte-standorte-teichrand-und-sumpfbeete':                                       'teichrand-sumpfbeet-bepflanzen-stauden-fuer-feuchte-standorte',
  'fruehjahrskombination-bluetenfolge-maerz-bis-mai':                                 'fruehjahrskombination-maerz-bis-mai-christrose-bergenie-und-akelei',
  'fuellstauden-und-bodendecker-freiflaechen-nachhaltig-schliessen':                  'bodendecker-stauden-flaechendeckende-pflanzen-fuer-alle-standorte',
  'ganzjaehrig-bluehendes-staudenbeet-saisonale-abfolge-planen':                      'bluetenfolge-planen-fruehjahr-bis-herbst-ohne-pause',
  // Wie oben: altes Ziel ist weggefallen, daher direkt auf den Nachfolger.
  'ganzjahres-attraktivitaet-und-saisonale-abfolge':                                  'bluetenfolge-planen-fruehjahr-bis-herbst-ohne-pause',
  'graeser-im-staudenbeet-struktur-bewegung-und-winteraspekt':                        'ziergraeser-im-staudenbeet-die-besten-arten-kombinationen',
  'halbschattige-staudenbeete-am-gehoelzrand':                                        'halbschatten-stauden-schoene-beete-am-gehoelzrand',
  'heimische-vs-gartenwuerdige-exoten':                                               'heimische-stauden-vs-exoten-was-ist-besser-fuer-deinen-garten',
  'hoehenstaffelung-und-tiefenwirkung':                                               'hoehenstaffelung-im-staudenbeet-das-wichtigste-gestaltungsprinzip',
  'jahrespflege-und-schnittregeln-fuer-staudenbeete':                                 'stauden-schneiden-wann-und-wie-richtig-schneiden',
  'klassische-herbst-kombination-piet-oudolf-praeriecharakter':                       'naturgarten-praeriecharakter-insektenhochburg-juli-oktober',
  'kontrastprinzip-und-texturkombinationen':                                          'kombinationsprinzipien-harmonie-und-kontrast-gezielt-einsetzen',
  'lebendige-boeden-und-bodenbiologie-im-staudenbeet':                                'bodenbiologie-im-staudenbeet-gesunden-boden-aufbauen',
  'lebensbereiche-nach-hansen-stahl-stauden-am-richtigen-standort':                   'lebensbereiche-der-stauden-nach-hansen-stahl',
  'pflanzabstaende-und-stueckzahlen-flaechen-richtig-berechnen':                      'pflanzdichte-berechnen-wie-viele-stauden-pro-m',
  'pflanzdichte-und-stueckzahlberechnung-im-staudenbeet':                             'pflanzdichte-berechnen-wie-viele-stauden-pro-m',
  // Wie oben: altes Ziel ist weggefallen, daher direkt auf den Nachfolger.
  'planungsprozess-fuer-ein-staudenbeet':                                             'staudenbeet-anlegen-schritt-fuer-schritt-anleitung',
  // Beide zeigten auf "schattenstauden-garten-…". Der Artikel heißt seit der Umbenennung
  // "Schattengarten anlegen" — der alte Slug besetzte das Keyword der Landingpage
  // /stauden-fuer-schatten, ohne deren Suchziel zu bedienen.
  'schattenbeete-unter-baeumen-und-straeuchern':                                      'schattengarten-anlegen-das-staudenbeet-unter-baeumen-gestalten',
  'schattenstauden-garten-das-staudenbeet-unter-baeumen-gestalten':                   'schattengarten-anlegen-das-staudenbeet-unter-baeumen-gestalten',
  'sonnige-trockene-staudenbeete-und-kiesgaerten':                                    'kiesgarten-trockenbeet-stauden-fuer-sonnige-trockene-standorte',
  'stauden-die-den-ganzen-sommer-bluehen-dauerbueher-fuer-das-beet':                  'stauden-die-den-ganzen-sommer-bluehen',
  'stauden-fuer-den-teichrand-und-feuchtbeet':                                        'teichrand-sumpfbeet-bepflanzen-stauden-fuer-feuchte-standorte',
  'stauden-pflanzen-die-optimale-pflanzzeit-im-fruehjahr-und-herbst':                 'stauden-pflanzen-wann-ist-der-beste-zeitpunkt',
  'stauden-fuer-den-vorgarten-ideen-und-bepflanzungsplan':                            'stauden-fuer-den-vorgarten-pflegeleichte-ideen-fuer-die-strassenfront',
  'stauden-kaufen-worauf-beim-kauf-in-gaertnerei-und-online-shop-achten':             'stauden-kaufen-worauf-beim-kauf-achten',
  'stauden-schneiden-der-richtige-rueckschnitt-fuer-jede-art':                        'stauden-schneiden-wann-und-wie-richtig-schneiden',
  'staudenbeet-anlegen-kosten-planung-und-schritt-fuer-schritt-anleitung':            'staudenbeet-anlegen-schritt-fuer-schritt-anleitung',
  'staudenbeet-ideen-10-inspirierende-gestaltungsbeispiele':                          'staudenbeet-ideen-5-gestaltungsstile-mit-pflanzenbeispielen',
  'staudenbeet-planen-online-schritt-fuer-schritt-mit-dem-ki-gartenplaner':           'gartenplanung-online-mit-ki-zum-fertigen-staudenbeet-plan',
  'staudenbeet-planen-schritt-fuer-schritt-anleitung-mit-pflanzplan':                 'staudenbeet-anlegen-schritt-fuer-schritt-anleitung',
  'stauden-richtig-pflanzen-zeitpunkt-und-technik':                                   'stauden-pflanzen-zeitpunkt-pflanzabstand-technik',
  'steingarten-und-alpinum-stauden-fuer-felsige-anlagen':                             'stauden-fuer-trockenmauern-und-steingaerten',
  'teichrand-und-feuchtbeet-gestaltung-am-wasser':                                    'teichrand-sumpfbeet-bepflanzen-stauden-fuer-feuchte-standorte',
  'weisser-garten-harmonie-in-weiss-und-silber-nach-sissinghurst':                    'stauden-fuer-weisse-beete-weissgarten-im-eigenen-garten-anlegen',
  'winterharte-stauden-fuer-deutschland-was-wirklich-den-winter-uebersteht':          'winterharte-stauden-fuer-deutschland-was-ueberlebt-den-winter',
  'winteraspekte-und-struktur-im-staudenbeet':                                        'winteraspekte-im-staudenbeet-schoenheit-auch-in-der-kalten-jahreszeit',
  'ziergraeser-als-staudenbegleiter':                                                 'ziergraeser-im-staudenbeet-die-besten-arten-kombinationen',
});

// Ratgeber-Artikel, deren Suchziel eine der SEO-Landingpages bereits vollständig bedient.
// Zwei URLs auf dasselbe Keyword nehmen sich gegenseitig das Ranking weg; die Landingpage
// ist die stärkere Seite (mehr Arten, Einstieg in den Planer), also erbt sie den Artikel.
// Ziel ist hier ein Pfad auf oberster Ebene, nicht unterhalb von /ratgeber/.
const RATGEBER_ZU_SEITE = Object.assign(Object.create(null), {
  'pflegeleichte-stauden-fuer-wenig-arbeit-im-garten': '/pflegeleichte-stauden',
});

app.get('/pflanze/:slug', (req, res) => {
  const slug = req.params.slug;
  if (SLUG_ALIASE[slug]) return res.redirect(301, '/pflanze/' + SLUG_ALIASE[slug]);
  const alle = db.prepare('SELECT * FROM pflanzen').all();
  const pflanze = alle.find(p => pflanzeToSlug(p.name_botanisch) === slug);

  if (!pflanze) return res.status(404).send(`<!DOCTYPE html><html lang="de"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Pflanze nicht gefunden</title></head><body>${NAV_LINKS}<div style="text-align:center;padding:80px 20px"><h1>Pflanze nicht gefunden</h1><p><a href="/pflanzen">Zurück zum Staudenlexikon</a></p></div>${SITE_FOOTER}</body></html>`);

  const kauflink = goLink(pflanze.name_botanisch);
  const aehnliche = db.prepare(`
    SELECT name_deutsch, name_botanisch FROM pflanzen
    WHERE licht LIKE ? AND id != ? ORDER BY RANDOM() LIMIT 6
  `).all(`%${(pflanze.licht || '').split('|')[0]}%`, pflanze.id);

  const pflegeSterne = '★'.repeat(pflanze.pflege_sterne || 1) + '☆'.repeat(3 - (pflanze.pflege_sterne || 1));
  const hoehe = (pflanze.hoehe_cm_min && pflanze.hoehe_cm_max) ? `${pflanze.hoehe_cm_min}–${pflanze.hoehe_cm_max} cm` : (pflanze.hoehe_cm_min || pflanze.hoehe_cm_max || '—') + ' cm';
  const bildAbsolut = (pflanze.bild_url || '').startsWith('http')
    ? pflanze.bild_url
    : `https://www.staudenplan.de${pflanze.bild_url || '/images/og-default.jpg'}`;

  // Mehrfachwerte stehen in der DB pipe-getrennt ("Sonne|Halbschatten"). Der Trenner ist ein
  // internes Speicherformat und hat in der öffentlichen Ausgabe nichts verloren — als Array
  // liest jeder Konsument die Werte einzeln statt als eine Zeichenkette mit Sonderzeichen.
  const mehrwert = v => { const t = String(v).split('|').map(s => s.trim()).filter(Boolean); return t.length > 1 ? t : t[0]; };
  const additionalProps = [
    pflanze.bluehzeit  && { "@type": "PropertyValue", "name": "Blühzeit",      "value": pflanze.bluehzeit },
    pflanze.licht      && { "@type": "PropertyValue", "name": "Lichtbedarf",   "value": mehrwert(pflanze.licht) },
    pflanze.feuchtigkeit && { "@type": "PropertyValue", "name": "Feuchtigkeit","value": mehrwert(pflanze.feuchtigkeit) },
    pflanze.boden      && { "@type": "PropertyValue", "name": "Boden",         "value": mehrwert(pflanze.boden) },
    hoehe !== '— cm'   && { "@type": "PropertyValue", "name": "Wuchshöhe",     "value": hoehe },
    pflanze.winterhart_zone && { "@type": "PropertyValue", "name": "Winterhärte", "value": `Zone ${pflanze.winterhart_zone}` },
    pflanze.farbe      && { "@type": "PropertyValue", "name": "Blütenfarbe",   "value": mehrwert(pflanze.farbe) },
  ].filter(Boolean);

  const schemaOrg = JSON.stringify([
    {
      "@context": "https://schema.org",
      // KEIN "Product" (und damit auch kein "offers"): Staudenplan.de verkauft nichts.
      //
      // Bis 08/2026 stand hier ein Product mit Verkaufspreis unter dem Händlernamen
      // "Staudenplan.de", Versandkosten von 4,95 €, 1-2 Tagen Bearbeitung und 14 Tagen
      // kostenloser Rückgabe — alles frei erfunden, auf jeder Pflanzenseite, ohne AGB und
      // ohne Widerrufsbelehrung. Die Preise in der DB sind Kalkulationsgrößen für die
      // Plansumme, keine Handelspreise (Stichprobe: Echinacea purpurea 8,00 € in der DB
      // gegen 5,10 € bei Gaißmayer). Der Block entstand als Reaktion auf die
      // Search-Console-Warnung "Missing field offers" (Commit bd1e628).
      //
      // Das bloße Streichen von "offers" hat den Typ zurückgelassen und damit einen
      // kritischen Fehler erzeugt ("Entweder offers, review oder aggregateRating müssen
      // angegeben werden", GSC ab 07.08.2026): Ein Product ohne eines dieser drei Felder
      // ist für Google kein gültiges Angebot. Der Fehler war folgenlos für das Ranking —
      // Product-Rich-Results ohne Angebot gibt es ohnehin nicht —, aber er verdeckt in der
      // Search Console echte Befunde. Richtig ist, gar keinen Handelsartikel zu behaupten:
      // Taxon (pending.schema.org) beschreibt genau das, was die Seite ist, nämlich eine
      // Pflanzenart. Google wertet den Typ nicht für Rich Results aus und meldet ihn
      // deshalb auch nicht — die Merkmale bleiben trotzdem maschinenlesbar.
      // Product NICHT wieder einbauen, solange hier nicht wirklich verkauft wird.
      "@type": "Taxon",
      "name": pflanze.name_botanisch,
      "alternateName": pflanze.name_deutsch,
      "taxonRank": "Art",
      "description": pflanze.beschreibung || '',
      "image": bildAbsolut,
      "additionalProperty": additionalProps,
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

  // Kombinationspartner → interne Links (nur zu Pflanzen, die als Seite existieren; dedupliziert)
  const kombiPartner = (pflanze.kombinationspartner || '').split(',')
    .map(s => s.trim()).filter(Boolean)
    .map(name => {
      const nl = name.toLowerCase();
      const binomial = nl.split(' ').slice(0, 2).join(' ');
      return alle.find(p => p.name_botanisch && p.name_botanisch.toLowerCase() === nl)
          || alle.find(p => p.name_botanisch && binomial.split(' ').length >= 2 && p.name_botanisch.toLowerCase().startsWith(binomial))
          || null;
    })
    .filter(Boolean)
    .filter((p, i, arr) => arr.findIndex(x => x.id === p.id) === i && p.id !== pflanze.id)
    .slice(0, 8);
  const kombiHtml = kombiPartner.length > 0 ? `
    <section style="background:#fff;border-radius:14px;padding:20px 24px;margin-bottom:24px;box-shadow:0 2px 12px rgba(0,0,0,.06)">
      <h2 style="font-size:1.05rem;color:#1b4332;margin-bottom:6px;font-weight:700">🌿 Passt gut zu ${escHtml(pflanze.name_deutsch)}</h2>
      <p style="color:#888;font-size:.82rem;margin-bottom:14px">Bewährte Pflanzpartner für harmonische Kombinationen im Beet.</p>
      <div style="display:flex;flex-wrap:wrap;gap:8px">
        ${kombiPartner.map(p => `<a href="/pflanze/${pflanzeToSlug(p.name_botanisch)}" style="display:inline-flex;align-items:center;gap:6px;background:#f0fdf4;border:1px solid #d8f3dc;border-radius:20px;padding:7px 14px;text-decoration:none;color:#1b4332;font-size:.85rem;font-weight:600;transition:background .12s" onmouseover="this.style.background='#d8f3dc'" onmouseout="this.style.background='#f0fdf4'">🌱 ${escHtml(p.name_deutsch)}</a>`).join('')}
      </div>
    </section>` : '';

  // Inhalt-Lang vorab parsen (für FAQ + Verlinkung).
  // 288 der 713 Zeilen enthalten Prosa statt JSON. Bis 08/2026 wurde der Parse-Fehler still zu
  // null — und damit fielen auf diesen Seiten "Pflege im Detail", Kombinationspartner, "Häufige
  // Fehler" und vier von sieben FAQ-Einträgen ersatzlos weg. Der Text lag die ganze Zeit in der
  // DB. Jetzt wird er als freitext durchgereicht und gerendert.
  const inhaltLang = pflanze.inhalt_lang
    ? (() => {
        try { return JSON.parse(pflanze.inhalt_lang); }
        catch { return { freitext: String(pflanze.inhalt_lang) }; }
      })()
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
      <h2 style="font-size:1.15rem;color:#1b4332;margin-bottom:20px;font-weight:700">❓ Häufige Fragen zu ${escHtml(pflanze.name_deutsch)}</h2>
      <div>
        ${faqItems.map((item, i) => `<details style="border-bottom:${i < faqItems.length - 1 ? '1px solid #f0ede8' : 'none'};padding:14px 0"${i === 0 ? ' open' : ''}>
          <summary style="font-weight:700;font-size:.92rem;color:#1b4332;cursor:pointer;list-style:none;display:flex;justify-content:space-between;align-items:center">${escHtml(item.q)}<span style="color:#2d6a4f;flex-shrink:0;margin-left:8px;font-size:.75rem">▼</span></summary>
          <p style="font-size:.88rem;color:#555;line-height:1.65;margin-top:10px;padding-right:8px">${escHtml(item.a)}</p>
        </details>`).join('')}
      </div>
    </section>` : '';

  // Pflege-Content aus inhalt_lang mit SEO-Überschriften ([Pflanze] pflanzen/gießen/schneiden/…)
  // — targetet die Care-Queries aus der Search Console, die bisher schwach ranken.
  const pflName = pflanze.name_deutsch;
  const pflegeFelder = [
    { key: 'pflanzzeit',     h: `${pflName} pflanzen`,    icon: '🌱' },
    { key: 'giessen',        h: `${pflName} gießen`,      icon: '💧' },
    { key: 'duengen',        h: `${pflName} düngen`,      icon: '🌾' },
    { key: 'rueckschnitt',   h: `${pflName} schneiden`,   icon: '✂️' },
    { key: 'ueberwinterung', h: `${pflName} überwintern`, icon: '❄️' },
  ].filter(f => inhaltLang && typeof inhaltLang[f.key] === 'string' && inhaltLang[f.key].trim());
  const pflegeHtml = pflegeFelder.length ? `
    <section style="background:#fff;border-radius:14px;padding:24px;box-shadow:0 2px 12px rgba(0,0,0,.07);margin-bottom:24px">
      <h2 style="font-size:1.2rem;color:#1b4332;margin-bottom:18px;font-weight:700">🌿 Pflege &amp; Anbau von ${escHtml(pflName)}</h2>
      ${pflegeFelder.map(f => `
        <div style="margin-bottom:16px">
          <h3 style="font-size:1rem;color:#2d6a4f;margin-bottom:5px;font-weight:700">${f.icon} ${escHtml(f.h)}</h3>
          <p style="font-size:.92rem;color:#444;line-height:1.7">${escHtml(inhaltLang[f.key])}</p>
        </div>`).join('')}
      ${inhaltLang.tipp ? `<div style="background:#f0fdf4;border-left:4px solid #52b788;border-radius:0 8px 8px 0;padding:12px 16px;margin-top:8px"><strong style="color:#1b4332">💡 Profi-Tipp:</strong> <span style="color:#444;font-size:.92rem">${escHtml(inhaltLang.tipp)}</span></div>` : ''}
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
        ${passendArtikel.map(a => `<a href="/ratgeber/${slugify(a.titel)}" style="display:flex;align-items:center;gap:10px;color:#2d6a4f;text-decoration:none;font-size:.88rem;font-weight:600;padding:8px 12px;background:#fff;border-radius:8px;transition:background .12s" onmouseover="this.style.background='#d8f3dc'" onmouseout="this.style.background='#fff'">→ ${escHtml(a.titel)}</a>`).join('')}
      </div>
    </section>` : '';

  res.send(`<!DOCTYPE html><html lang="de"><head>
  <meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${escHtml(pflanze.name_deutsch)} (${escHtml(pflanze.name_botanisch)}) — Pflege, Standort & Verwendung | Staudenplan.de</title>
  <meta name="description" content="${escHtml(pflanze.name_deutsch)} (${escHtml(pflanze.name_botanisch)}): ${escHtml((pflanze.beschreibung || '').substring(0, 130))} — Standort ${escHtml(pflanze.licht||'')}, Blühzeit ${escHtml(pflanze.bluehzeit||'')}, Pflege und Kauftipp.">
  <link rel="icon" href="/favicon.ico" sizes="any"><link rel="icon" type="image/svg+xml" href="/favicon.svg"><link rel="apple-touch-icon" href="/apple-touch-icon.png">
  <link rel="canonical" href="https://www.staudenplan.de/pflanze/${slug}">
  <meta property="og:title" content="${escHtml(pflanze.name_deutsch)} — Pflege, Standort & Kauftipp">
  <meta property="og:description" content="${escHtml((pflanze.beschreibung || '').substring(0, 155))}">
  <!-- bildAbsolut, nicht pflanze.bild_url: In der DB stehen die Bildpfade relativ
       ("/images/pflanzen/…"), so schreiben es alle Bild-Skripte zurück. Facebook und Pinterest
       lösen relative og:image-Werte nicht gegen die Seiten-URL auf — die Vorschau blieb dadurch
       auf allen Pflanzenseiten leer. Das JSON-LD daneben nutzte längst die absolute Variante. -->
  <meta property="og:image" content="${escHtml(bildAbsolut)}">
  <meta property="og:url" content="https://www.staudenplan.de/pflanze/${slug}">
  <!-- og:type="article", nicht "product": Pinterest und Facebook lesen "product" als Kaufangebot
       und erwarten dann og:price/og:availability — die es hier nicht gibt (siehe Taxon-Kommentar). -->
  <meta property="og:type" content="article">
  <script type="application/ld+json">${schemaOrg.replace(/</g, '\\u003c')}</script>
  ${faqSchema ? `<script type="application/ld+json">${faqSchema.replace(/</g, '\\u003c')}</script>` : ''}
  <style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:'Segoe UI',system-ui,sans-serif;background:#f8f4ef;color:#1a1a1a}@media(max-width:680px){.pflanz-grid{grid-template-columns:1fr!important}.pflanz-hero-inner{flex-direction:column!important}}details>summary::-webkit-details-marker{display:none}</style>
  </head><body>
  ${NAV_LINKS}

  <!-- Breadcrumb -->
  <div style="max-width:960px;margin:14px auto 0;padding:0 20px;font-size:.8rem;color:#aaa">
    <a href="/" style="color:#2d6a4f;text-decoration:none">Startseite</a> ›
    <a href="/pflanzen" style="color:#2d6a4f;text-decoration:none"> Stauden-Lexikon</a> ›
    <span>${escHtml(pflanze.name_deutsch)}</span>
  </div>

  <!-- Hero: Bild links, Info rechts -->
  <div style="max-width:960px;margin:20px auto;padding:0 20px">
    <div class="pflanz-hero-inner" style="display:flex;gap:28px;align-items:flex-start">

      <!-- Bild -->
      <div style="flex-shrink:0;width:380px;max-width:100%">
        ${pflanze.bild_url
          ? `<div style="border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.12);aspect-ratio:4/3">
               <img src="${escHtml(pflanze.bild_url)}" alt="${escHtml(pflanze.name_deutsch)} — ${escHtml(pflanze.name_botanisch)}" style="width:100%;height:100%;object-fit:cover;display:block">
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
        <h1 style="font-size:clamp(1.5rem,4vw,2rem);color:#1b4332;font-weight:800;line-height:1.2;margin-bottom:4px">${escHtml(pflanze.name_deutsch)}</h1>
        <p style="font-style:italic;color:#888;font-size:1rem;margin-bottom:14px">${escHtml(pflanze.name_botanisch)}</p>
        <p style="line-height:1.7;color:#333;margin-bottom:20px;font-size:.95rem">${escHtml(pflanze.beschreibung || 'Winterharte Gartenstaude für deutsche Gärten.')}</p>

        <!-- Eigenschaften Grid -->
        <div class="pflanz-grid" style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:24px">
          ${[
            ['☀️ Standort', (pflanze.licht||'—').replace(/\|/g,' · ')],
            ['🌸 Blühzeit', pflanze.bluehzeit||'—'],
            ['↕ Höhe', hoehe],
            ['🎨 Farbe', (pflanze.farbe||'—').replace(/\|/g,' · ')],
            ['🌱 Pflege', pflegeSterne],
            // "Richtpreis" statt "Preis": die DB-Werte sind Kalkulationsgrößen für die Plansumme,
            // keine Kassenpreise (Echinacea purpurea 8,00 € hier gegen 5,10 € bei Gaißmayer).
            ['💶 Richtpreis', pflanze.preis_stueck_eur ? 'ca. ' + pflanze.preis_stueck_eur.toFixed(2)+' €/Stück' : '—'],
          ].map(([l,v]) => `
            <div style="background:#fff;border-radius:10px;padding:12px 14px;box-shadow:0 1px 6px rgba(0,0,0,.06)">
              <div style="font-size:.72rem;color:#aaa;margin-bottom:3px;text-transform:uppercase;letter-spacing:.05em">${l}</div>
              <div style="font-weight:700;font-size:.92rem;color:#1b4332">${escHtml(v)}</div>
            </div>`).join('')}
          ${pflanze.bienen_freundlich ? `<div style="background:#fef9c3;border-radius:10px;padding:12px 14px"><div style="font-size:.72rem;color:#92400e;margin-bottom:3px;text-transform:uppercase;letter-spacing:.05em">Ökologie</div><div style="font-weight:700;font-size:.92rem;color:#92400e">🐝 Bienenfreundlich</div></div>` : ''}
          ${pflanze.heimisch ? `<div style="background:#f0fdf4;border-radius:10px;padding:12px 14px"><div style="font-size:.72rem;color:#065f46;margin-bottom:3px;text-transform:uppercase;letter-spacing:.05em">Herkunft</div><div style="font-weight:700;font-size:.92rem;color:#065f46">🌱 Heimisch in Deutschland</div></div>` : ''}
        </div>

        <!-- CTA Buttons -->
        <div style="display:flex;gap:10px;flex-wrap:wrap">
          <a href="${kauflink}" target="_blank" rel="noopener nofollow" data-kauf="${escHtml(pflanze.name_botanisch || pflanze.name_deutsch || '')}" data-quelle="pflanzenseite" style="background:#6b4226;color:#fff;border-radius:50px;padding:13px 28px;text-decoration:none;font-weight:700;font-size:.9rem;transition:background .15s">In der Gärtnerei ansehen →</a>
          <button id="wl-btn" onclick="addToWunschliste()" style="background:#2d6a4f;color:#fff;border:none;border-radius:50px;padding:13px 28px;font-weight:700;font-size:.9rem;cursor:pointer;transition:background .2s">🌿 Zur Wunschliste</button>
          <script>
          (function(){
            const KEY='staudenplan_wishlist', BOT=${JSON.stringify(pflanze.name_botanisch).replace(/</g, '\\u003c')}, DE=${JSON.stringify(pflanze.name_deutsch).replace(/</g, '\\u003c')};
            function getWL(){try{return JSON.parse(localStorage.getItem(KEY)||'[]');}catch{return[];}}
            function setAdded(){const b=document.getElementById('wl-btn');if(!b)return;b.textContent='✓ Auf Wunschliste';b.style.background='#52b788';b.style.cursor='default';b.onclick=function(){if(window.snavToggle)window.snavToggle();};}
            window.addToWunschliste=function(){const wl=getWL();if(!wl.find(p=>p.name_botanisch===BOT)){wl.push({name_deutsch:DE,name_botanisch:BOT});localStorage.setItem(KEY,JSON.stringify(wl));}setAdded();document.dispatchEvent(new CustomEvent('wl-changed'));if(window.snavUpdateBtn)window.snavUpdateBtn();};
            if(getWL().find(p=>p.name_botanisch===BOT)){setAdded();if(window.snavUpdateBtn)window.snavUpdateBtn();}
          })();
          </script>
        </div>
        <p style="font-size:.72rem;color:#bbb;margin-top:8px">Externer Link zur Staudengärtnerei Gaißmayer.</p>
        </div>
      </div>
    </div>
  </div>

  <!-- Inhalt -->
  <main style="max-width:960px;margin:32px auto;padding:0 20px 60px">

    <!-- Standort & Pflege -->
    <section style="background:#fff;border-radius:14px;padding:24px;box-shadow:0 2px 12px rgba(0,0,0,.07);margin-bottom:24px">
      <h2 style="font-size:1.15rem;color:#1b4332;margin-bottom:16px;font-weight:700;display:flex;align-items:center;gap:8px">🌱 Standort & Pflege</h2>
      <p style="line-height:1.75;color:#333;margin-bottom:12px"><strong>${escHtml(pflanze.name_deutsch)}</strong> (${escHtml(pflanze.name_botanisch)}) ist eine ${pflanze.licht?escHtml(pflanze.licht.split('|')[0])+'-liebende':''} Gartenstaude mit einer Wuchshöhe von ${hoehe}. ${escHtml(pflanze.beschreibung||'')}</p>
      <p style="line-height:1.75;color:#333;margin-bottom:12px">Besonders gut eignet sich die Pflanze für den <strong>${(pflanze.stil||'Naturgarten').replace(/\|/g,', ')}</strong>. Bodentyp: ${(pflanze.boden||'normaler Gartenboden').replace(/\|/g,', ')}.</p>
      <p style="line-height:1.75;color:#333"><strong>Pflanzzeit:</strong> März–Mai (Frühjahr) oder September–Oktober (Herbst). ${pflanze.bienen_freundlich?'Als bienenfreundliche Staude leistet sie einen wichtigen Beitrag zur Gartenökologie.':''} ${pflanze.heimisch?'Als heimische Art ist sie besonders wertvoll für einheimische Insekten und Vögel.':''}</p>
    </section>

    ${(() => {
      // Giftigkeitshinweis: eigener, auffälliger Block VOR den Pflegeangaben. Der Text stammt
      // aus der kuratierten Gattungsliste (scripts/pflanzen-giftigkeit.js), nicht aus der
      // KI-Generierung — für eine Warnung dieser Art haftet der Betreiber, sie muss über den
      // ganzen Bestand gleich lauten und nachschlagbar sein.
      // Direkt aus der Gattungsliste, NICHT aus inhalt_lang: Zeilen, deren inhalt_lang noch
      // Freitext ist, hatten sonst keinen Hinweis — live betraf das Allium hollandicum und
      // Trollius x cultorum, während dieselbe Art als Sorte warnte. Eine Giftwarnung muss über
      // den ganzen Bestand gleich lauten, unabhängig vom Zustand eines anderen Feldes.
      const gift = giftigkeit(pflanze.name_botanisch);
      const g = gift && gift.text;
      if (!g) return '';
      const stufe = gift.stufe;
      const stark = stufe === 'stark' || stufe === 'katzen';
      return `
    <section style="background:${stark ? '#fff1f0' : '#fffbeb'};border:1px solid ${stark ? '#fca5a5' : '#fde68a'};border-radius:14px;padding:18px 22px;margin-bottom:24px;display:flex;gap:14px;align-items:flex-start">
      <span style="font-size:1.5rem;flex-shrink:0" aria-hidden="true">${stark ? '☠️' : '⚠️'}</span>
      <div>
        <div style="font-weight:700;color:${stark ? '#991b1b' : '#92400e'};margin-bottom:4px">${
          stufe === 'katzen' ? 'Für Katzen lebensgefährlich'
          : stufe === 'stark' ? 'Stark giftige Pflanze'
          : stufe === 'reizend' ? 'Reizt Haut und Schleimhäute'
          : stufe === 'haustiere' ? 'Für Haustiere giftig'
          : 'Giftige Pflanze'}</div>
        <p style="font-size:.9rem;color:#333;line-height:1.65;margin:0">${escHtml(g)}</p>
      </div>
    </section>`;
    })()}

    ${(() => {
      const d = inhaltLang;
      if (!d) return '';
      // Die Feldliste zuerst bilden: bei Freitext-Einträgen ist d zwar truthy, aber leer —
      // ohne diese Prüfung stünde auf 288 Seiten die Überschrift über einem leeren Raster.
      const pflegeFelder = [
        ['📅 Pflanzzeit', d.pflanzzeit],
        ['📐 Pflanzabstand', d.pflanzabstand],
        ['💧 Gießen', d.giessen],
        ['🌱 Düngen', d.duengen],
        ['✂️ Rückschnitt', d.rueckschnitt],
        ['❄️ Überwinterung', d.ueberwinterung],
      ].filter(([, v]) => v);
      return `
    ${d.freitext && !pflegeFelder.length ? `
    <!-- Pflege & Verwendung: nur zeigen, wenn KEIN Feldraster vorliegt. Nach der Überführung
         ins Feldschema bleibt der Originaltext als freitext in der DB stehen (verlustfrei,
         umkehrbar), wird aber nicht mehr zusätzlich ausgegeben — sonst stünde derselbe Inhalt
         zweimal auf der Seite. -->
    <section style="background:#fff;border-radius:14px;padding:24px;box-shadow:0 2px 12px rgba(0,0,0,.07);margin-bottom:24px">
      <h2 style="font-size:1.15rem;color:#1b4332;margin-bottom:16px;font-weight:700">🌿 Pflege &amp; Verwendung</h2>
      ${String(d.freitext).split(/\n{2,}/).map(abs => abs.trim()).filter(Boolean)
        .map(abs => `<p style="line-height:1.75;color:#333;margin-bottom:12px">${escHtml(abs)}</p>`).join('')}
    </section>` : ''}
    ${pflegeFelder.length || d.tipp ? `
    <!-- Pflege im Detail -->
    <section style="background:#fff;border-radius:14px;padding:24px;box-shadow:0 2px 12px rgba(0,0,0,.07);margin-bottom:24px">
      <h2 style="font-size:1.15rem;color:#1b4332;margin-bottom:20px;font-weight:700">🌿 Pflege im Detail</h2>
      ${pflegeFelder.length ? `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:14px">
        ${pflegeFelder.map(([label, val]) => `
          <div style="background:#f8f4ef;border-radius:10px;padding:14px 16px">
            <div style="font-size:.75rem;font-weight:700;color:#2d6a4f;margin-bottom:5px;text-transform:uppercase;letter-spacing:.04em">${label}</div>
            <p style="font-size:.88rem;color:#333;line-height:1.6;margin:0">${escHtml(val)}</p>
          </div>`).join('')}
      </div>` : ''}
      ${d.tipp ? `<div style="background:linear-gradient(135deg,#d8f3dc,#b7e4c7);border-radius:10px;padding:14px 18px;margin-top:14px;display:flex;gap:12px;align-items:flex-start">
        <span style="font-size:1.4rem;flex-shrink:0">💡</span>
        <div><div style="font-size:.75rem;font-weight:700;color:#1b4332;margin-bottom:3px;text-transform:uppercase">Experten-Tipp</div><p style="font-size:.88rem;color:#1b4332;line-height:1.6;margin:0">${escHtml(d.tipp)}</p></div>
      </div>` : ''}
    </section>` : ''}

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
                <div style="font-weight:700;font-size:.92rem;color:#1b4332">${escHtml(k.name_deutsch)} <span style="font-style:italic;color:#aaa;font-weight:400;font-size:.8rem">${escHtml(k.name_botanisch)}</span></div>
                <div style="font-size:.82rem;color:#555;margin-top:2px">${escHtml(k.grund)}</div>
              </div>
              <span style="margin-left:auto;color:#2d6a4f;font-size:.8rem;font-weight:600;white-space:nowrap">Ansehen →</span>
            </a>`
          : `<div style="display:flex;gap:14px;align-items:center;background:#f8f4ef;border-radius:10px;padding:12px 16px;">
              <span style="font-size:1.5rem;flex-shrink:0">🌿</span>
              <div>
                <div style="font-weight:700;font-size:.92rem;color:#1b4332">${escHtml(k.name_deutsch)} <span style="font-style:italic;color:#aaa;font-weight:400;font-size:.8rem">${escHtml(k.name_botanisch)}</span></div>
                <div style="font-size:.82rem;color:#555;margin-top:2px">${escHtml(k.grund)}</div>
              </div>
            </div>`
        ).join('')}
      </div>
    </section>`;
    })()}

    <!-- Häufige Fehler -->
    ${Array.isArray(d.fehler) && d.fehler.length > 0 ? `
    <section style="background:#fff5f5;border-radius:14px;padding:24px;box-shadow:0 2px 12px rgba(0,0,0,.07);margin-bottom:24px">
      <h2 style="font-size:1.15rem;color:#9b2335;margin-bottom:14px;font-weight:700">⚠️ Häufige Fehler vermeiden</h2>
      <ul style="list-style:none;padding:0;display:flex;flex-direction:column;gap:8px">
        ${d.fehler.map(f => `<li style="display:flex;gap:10px;font-size:.88rem;color:#333;line-height:1.6"><span style="color:#e53e3e;font-weight:700;flex-shrink:0">✗</span>${escHtml(f)}</li>`).join('')}
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

    ${kombiHtml}

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

    ${pflegeHtml}
    ${faqHtml}
    ${passendArtikelHtml}

    <!-- Plan CTA -->
    <div style="background:linear-gradient(135deg,#1b4332,#2d6a4f);color:#fff;border-radius:14px;padding:28px;margin-top:32px;text-align:center">
      <h3 style="font-size:1.15rem;margin-bottom:8px">Passt ${escHtml(pflanze.name_deutsch)} in deinen Garten?</h3>
      <p style="opacity:.88;font-size:.9rem;margin-bottom:18px">Unser KI-Planer zeigt dir den perfekten Bepflanzungsplan — mit ${escHtml(pflanze.name_deutsch)} als Teil eines harmonischen Gesamtkonzepts.</p>
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
        ? `<div style="height:120px;overflow:hidden"><img src="${escHtml(p.bild_url)}" alt="${escHtml(p.name_deutsch)}" loading="lazy" style="width:100%;height:100%;object-fit:cover"></div>`
        : `<div style="height:120px;background:linear-gradient(135deg,#d8f3dc,#b7e4c7);display:flex;align-items:center;justify-content:center;font-size:3rem">🌿</div>`}
      <div style="padding:12px">
        <div style="font-size:.88rem;font-weight:700;color:#1b4332;line-height:1.3;margin-bottom:3px">${escHtml(p.name_deutsch)}</div>
        <div style="font-size:.73rem;color:#aaa;font-style:italic;margin-bottom:6px">${escHtml(p.name_botanisch)}</div>
        ${p.bluehzeit ? `<div style="font-size:.72rem;color:#2d6a4f">🌸 ${escHtml(p.bluehzeit)}</div>` : ''}
      </div>
    </a>`).join('');

  const artikelHtml = artikelLinks.length > 0 ? `
    <div style="margin-top:48px;padding-top:32px;border-top:2px solid #d8f3dc">
      <h2 style="font-size:1.15rem;color:#1b4332;margin-bottom:16px;font-weight:700">📚 Ratgeber-Artikel zum Thema</h2>
      <div style="display:flex;flex-direction:column;gap:10px">
        ${artikelLinks.map(a => `<a href="/ratgeber/${slugify(a.titel)}" style="display:flex;align-items:center;gap:10px;background:#fff;border-radius:10px;padding:14px 18px;text-decoration:none;box-shadow:0 2px 8px rgba(0,0,0,.06);transition:background .12s" onmouseover="this.style.background='#f0fdf4'" onmouseout="this.style.background='#fff'">
          <span style="font-size:1.2rem;flex-shrink:0">📖</span>
          <span style="font-size:.9rem;font-weight:600;color:#1b4332">${escHtml(a.titel)}</span>
          <span style="margin-left:auto;color:#2d6a4f;font-weight:700;font-size:.82rem;white-space:nowrap">Lesen →</span>
        </a>`).join('')}
      </div>
    </div>` : '';

  return `<!DOCTYPE html><html lang="de"><head>
  <meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${titel} | Staudenplan.de</title>
  <meta name="description" content="${metaDesc}">
  <link rel="canonical" href="https://www.staudenplan.de/${slug}">
  <link rel="icon" href="/favicon.ico" sizes="any"><link rel="icon" type="image/svg+xml" href="/favicon.svg"><link rel="apple-touch-icon" href="/apple-touch-icon.png">
  <meta property="og:title" content="${titel}">
  <meta property="og:description" content="${metaDesc}">
  <meta property="og:type" content="website">
  <script type="application/ld+json">${escJsonLd({
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
  // Die Zahl steht hier in einem Satz über den Planer, nicht über das Lexikon — deshalb die
  // planbare Menge und nicht alle 709.
  const pflanzenCount = db.prepare(`SELECT COUNT(*) as n FROM pflanzen WHERE ${PLANBAR}`).get().n;
  let artikel = [];
  try { artikel = db.prepare(`SELECT titel FROM wissen WHERE titel LIKE '%plan%' OR titel LIKE '%Planung%' OR titel LIKE '%kombin%' OR titel LIKE '%Standort%' OR inhalt LIKE '%Bepflanzungsplan%' LIMIT 6`).all(); } catch {}
  const artikelHtml = artikel.map(a => `<a href="/ratgeber/${slugify(a.titel)}" style="display:flex;align-items:center;gap:10px;background:#fff;border-radius:10px;padding:14px 18px;text-decoration:none;box-shadow:0 2px 8px rgba(0,0,0,.06);transition:background .12s;margin-bottom:10px" onmouseover="this.style.background='#f0fdf4'" onmouseout="this.style.background='#fff'"><span style="font-size:1.2rem">📖</span><span style="font-size:.9rem;font-weight:600;color:#1b4332">${a.titel}</span><span style="margin-left:auto;color:#2d6a4f;font-weight:700;font-size:.82rem">Lesen →</span></a>`).join('');

  // Schritt-für-Schritt-Anleitung (informationell, klar getrennt von der kommerziellen Startseite)
  const schritte = [
    ['Standort ehrlich analysieren', 'Jede Planung beginnt mit dem, was <strong>vorgegeben</strong> ist: Licht und Boden. Beobachte über einen sonnigen Tag, wie viele Stunden direkte Sonne die Fläche bekommt — 6+ Stunden = vollsonnig (Präriestauden, mediterrane Arten), 3–6 Stunden = halbschattig, unter 3 Stunden = schattig (Funkien, Astilben, Farne). Prüfe den Boden mit einer Handvoll: krümelig-dunkel = humos, klebt und glänzt = lehmig-schwer, rieselt = sandig-trocken. Staunässe nach Regen? Dann brauchst du Feuchtezeiger statt Trockenkünstler. <em>Regel: nicht gegen den Standort planen — die passende Pflanze für den Ort schlägt jede Wunschpflanze am falschen Platz.</em>'],
    ['Größe & Form festlegen', 'Für eine echte Höhenstaffelung sollte ein einseitig einsehbares Beet mindestens <strong>1,5–2 m tief</strong> sein — schmalere Beete (ab 60 cm) tragen nur zwei Höhenebenen. Beim <strong>Rundbeet/Inselbeet</strong> (von allen Seiten sichtbar) kommen die hohen Stauden in die Mitte, nach außen wird es niedriger. Zeichne die Fläche maßstäblich auf Papier oder miss Länge × Breite — daraus ergibt sich später die Stückzahl.'],
    ['Höhenstaffelung — das Rückgrat', 'Der wichtigste Gestaltungsschritt. Teile die Pflanzen in drei Rollen: <strong>Leitstauden</strong> (über 80 cm, geben Struktur — Rittersporn, Chinaschilf, Sonnenhut) nach hinten; <strong>Begleitstauden</strong> (40–80 cm, die Hauptblüher — Salbei, Katzenminze, Schafgarbe) in die Mitte; <strong>Füll- und Bodendecker</strong> (unter 40 cm — Storchschnabel, Frauenmantel, Fetthenne) nach vorn. So verdeckt nichts die Blüte dahinter, und das Beet wirkt tief und ruhig.'],
    ['Blütezeiten staffeln (das „Nektarband")', 'Ein gutes Staudenbeet blüht nicht nur im Juli. Ziel ist eine durchgehende Abfolge von <strong>März bis Oktober</strong> — plane pro Monat mindestens eine blühende Art ein. Frühling: Bergenie, Lungenkraut, Wolfsmilch. Frühsommer: Storchschnabel, Salbei, Katzenminze. Hochsommer: Sonnenhut, Schafgarbe, Flammenblume. Herbst: Herbstaster, Fetthenne, Anemone. Gräser und Samenstände tragen die Struktur bis in den Winter — nicht zu früh zurückschneiden.'],
    ['Farbkonzept wählen', 'Zwei bewährte Wege: <strong>Harmonie</strong> (benachbarte Farben, z. B. Rosa–Violett–Blau) wirkt elegant und ruhig; <strong>Kontrast</strong> (Komplementärfarben, z. B. Blau-Violett + Gelb) macht Spannung. Weiß und silbriges Laub (Wollziest, Katzenminze) vermitteln zwischen kräftigen Tönen und lassen das Beet abends leuchten. Begrenze dich auf 2–3 Leitfarben plus Grün- und Silbertöne — zu viele Farben wirken unruhig.'],
    ['Pflanzabstände & Stückzahl', 'Faustregel: <strong>5–9 Stauden pro m²</strong> bei normaler Pflanzung (locker 3–4, dicht bis 11). Große Leitstauden 1–3/m², niedrige Füllstauden 7–11/m². Der Abstand richtet sich nach der <strong>Endbreite</strong> der Pflanze, nicht nach der Topfgröße. Pflanze in <strong>ungeraden Gruppen</strong> (3er, 5er, 7er) derselben Art — das wirkt natürlicher als Einzelstücke und ergibt ruhige Farbflächen. Lücken lieber vermeiden: freier Boden ist eine Einladung fürs Unkraut.'],
    ['Boden vorbereiten & pflanzen', 'Fläche gründlich von Wurzelunkräutern (Quecke, Giersch, Winde) befreien, den Boden ein Spatenblatt tief lockern und 3–5 l reifen Kompost pro m² einarbeiten. Stauden wässern, einsetzen, andrücken, angießen und eine Mulchschicht auftragen. Beste Pflanzzeit ist der <strong>Herbst (September–Oktober)</strong> — der warme Boden lässt die Wurzeln vor dem Winter einwachsen; zweitbeste Zeit ist das <strong>Frühjahr (April–Mai)</strong>. Containerware geht fast ganzjährig, außer bei Frost und Hochsommerhitze.'],
  ];
  const schritteHtml = schritte.map(([t, s], i) => `
    <div style="display:flex;gap:16px;align-items:flex-start;margin-bottom:22px">
      <div style="flex-shrink:0;background:#2d6a4f;color:#fff;width:34px;height:34px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:1rem">${i + 1}</div>
      <div><h2 style="font-size:1.12rem;color:#1b4332;font-weight:700;margin:4px 0 8px">${t}</h2><p style="line-height:1.75;color:#333;font-size:.95rem">${s}</p></div>
    </div>`).join('');

  const faqs = [
    ['Wie tief sollte ein Staudenbeet sein?', 'Für eine saubere Höhenstaffelung mindestens 1,5–2 m Tiefe. Schmalere Beete ab etwa 60 cm funktionieren mit zwei Höhenebenen. Bei Rundbeeten zählt der Radius (ab ca. 1 m), da die Staffelung von der Mitte nach außen verläuft.'],
    ['Wie viele Stauden braucht man pro Quadratmeter?', 'Als Faustregel 5–9 Stauden pro m² bei normaler Pflanzung — lockerer 3–4, dicht bis etwa 11. Große Leitstauden 1–3/m², niedrige Füllstauden 7–11/m². Lieber etwas dichter pflanzen: geschlossene Flächen unterdrücken Unkraut.'],
    ['Wann legt man ein Staudenbeet am besten an?', 'Ideal ist der Herbst (September–Oktober): Der Boden ist warm, die Stauden wurzeln vor dem Winter ein. Zweitbeste Zeit ist das Frühjahr (April–Mai). Container-Stauden lassen sich fast ganzjährig pflanzen, außer bei Frost oder Hitze.'],
    ['Was sind Leit-, Begleit- und Füllstauden?', 'Leitstauden (über 80 cm) geben Struktur und Höhe (z. B. Rittersporn, Chinaschilf). Begleitstauden (40–80 cm) sind die Hauptblüher der Beetmitte (Sonnenhut, Salbei). Füllstauden (unter 40 cm) schließen Boden und Lücken (Storchschnabel, Frauenmantel).'],
    ['Wie staffelt man Blütezeiten richtig?', 'Ziel ist ein durchgehendes „Nektarband" von März bis Oktober — pro Monat mindestens eine blühende Art. Kombiniere Frühlingsblüher (Bergenie, Lungenkraut), Sommerblüher (Sonnenhut, Salbei) und Herbstblüher (Herbstaster, Fetthenne) und lass Blühzeiten überlappen.'],
  ];
  const faqHtml = faqs.map(([q, a]) => `
    <details style="background:#fff;border-radius:10px;padding:16px 20px;margin-bottom:10px;box-shadow:0 2px 8px rgba(0,0,0,.06)">
      <summary style="font-weight:700;color:#1b4332;font-size:.95rem;cursor:pointer">${q}</summary>
      <p style="line-height:1.7;color:#444;font-size:.9rem;margin-top:10px">${a}</p>
    </details>`).join('');
  const faqSchema = escJsonLd({
    "@context": "https://schema.org", "@type": "FAQPage",
    "mainEntity": faqs.map(([q, a]) => ({ "@type": "Question", "name": q, "acceptedAnswer": { "@type": "Answer", "text": a.replace(/<[^>]+>/g, '') } }))
  });
  const howtoSchema = escJsonLd({
    "@context": "https://schema.org", "@type": "HowTo", "name": "Staudenbeet planen und anlegen",
    "description": "Schritt-für-Schritt-Anleitung, um ein Staudenbeet zu planen: Standort, Höhenstaffelung, Blütezeiten, Farbkonzept, Pflanzabstände und Pflanzung.",
    "step": schritte.map(([t, s], i) => ({ "@type": "HowToStep", "position": i + 1, "name": t, "text": s.replace(/<[^>]+>/g, '') }))
  });

  res.send(`<!DOCTYPE html><html lang="de"><head>
  <meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Staudenbeet planen: Anleitung in 7 Schritten | Staudenplan.de</title>
  <meta name="description" content="Staudenbeet planen wie ein Profi: Schritt-für-Schritt-Anleitung zu Standort, Höhenstaffelung, Blütezeiten, Farbkonzept und Pflanzabständen — mit Praxisbeispielen und kostenlosem Pflanzplan.">
  <link rel="canonical" href="https://www.staudenplan.de/staudenbeet-planen">
  <link rel="icon" href="/favicon.ico" sizes="any"><link rel="icon" type="image/svg+xml" href="/favicon.svg"><link rel="apple-touch-icon" href="/apple-touch-icon.png">
  <script type="application/ld+json">${faqSchema}</script>
  <script type="application/ld+json">${howtoSchema}</script>
  <style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:'Segoe UI',system-ui,sans-serif;background:#f8f4ef;color:#1a1a1a}summary::-webkit-details-marker{display:none}</style>
  </head><body>
  ${NAV_LINKS}
  <div style="background:linear-gradient(160deg,#1b4332,#2d6a4f);color:#fff;padding:52px 24px 44px;text-align:center">
    <div style="max-width:720px;margin:0 auto">
      <h1 style="font-size:clamp(1.6rem,4vw,2.2rem);font-weight:800;line-height:1.22;margin-bottom:14px">Staudenbeet planen &amp; anlegen: die Schritt-für-Schritt-Anleitung</h1>
      <p style="opacity:.9;font-size:1.02rem;line-height:1.65">Von der Standort­analyse bis zur Pflanzung — wie du ein Staudenbeet planst, das von Frühling bis Herbst blüht und pflegeleicht bleibt. Mit konkreten Zahlen und Pflanzenbeispielen.</p>
    </div>
  </div>
  <main style="max-width:820px;margin:0 auto;padding:44px 20px 60px">

    <p style="line-height:1.8;color:#333;font-size:1rem;margin-bottom:14px">Ein gelungenes Staudenbeet ist kein Zufall, sondern das Ergebnis weniger klarer Entscheidungen: der richtige Standort, eine durchdachte Höhenstaffelung, eine über die Saison gestaffelte Blüte und stimmige Farben. Wer diese Schritte der Reihe nach geht, vermeidet die häufigsten Fehler — Pflanzen am falschen Platz, kahle Phasen und ein unruhiges Farbbild. Diese Anleitung führt dich durch die komplette Planung.</p>
    <p style="line-height:1.8;color:#333;font-size:1rem;margin-bottom:30px">Wenn du die Arbeit abkürzen möchtest: Unser <a href="/" style="color:#2d6a4f;font-weight:700">kostenloser Staudenbeet-Planer</a> nimmt dir die Schritte 1–6 automatisch ab — er gleicht Standort, Höhen, Blühzeiten und Stückzahlen mit ${pflanzenCount} winterharten Stauden ab. Die Anleitung hilft dir trotzdem, den Plan zu verstehen und zu verfeinern.</p>

    <div style="background:#fff;border-radius:14px;padding:26px 24px 8px;box-shadow:0 2px 12px rgba(0,0,0,.07);margin-bottom:34px">
      ${schritteHtml}
    </div>

    <div style="background:#f0faf3;border:1px solid #d6efe0;border-radius:12px;padding:22px 24px;margin-bottom:20px">
      <h2 style="font-size:1.12rem;color:#1b4332;font-weight:700;margin-bottom:8px">Schritt 8: Pflege im ersten Jahr</h2>
      <p style="line-height:1.75;color:#333;font-size:.95rem">Im ersten Jahr entscheidet sich, ob das Beet anwächst: In Trockenphasen <strong>durchdringend wässern</strong> (lieber selten und viel als täglich wenig), bis die Stauden eingewurzelt sind. Verblühtes kannst du für eine zweite Blüte zurückschneiden — die Samenstände von Gräsern, Sonnenhut und Fetthenne aber über den Winter stehen lassen: Sie sind Struktur bei Raureif und Nahrung für Vögel und Insekten. Der große Rückschnitt erfolgt erst im <strong>Frühjahr (Februar/März)</strong>, kurz vor dem Neuaustrieb.</p>
    </div>

    <div style="background:linear-gradient(135deg,#1b4332,#2d6a4f);border-radius:14px;padding:30px 26px;color:#fff;text-align:center;margin-bottom:40px">
      <h2 style="font-size:1.25rem;margin-bottom:8px">Alle Schritte automatisch — in 2 Minuten</h2>
      <p style="opacity:.9;font-size:.95rem;line-height:1.6;max-width:560px;margin:0 auto 18px">Gib Standort, Größe und Stil ein — der KI-Planer erledigt Standortabgleich, Höhenstaffelung, Blüh-Staffelung und Stückzahl für dich und liefert einen grafischen Pflanzplan mit Stückliste. Kostenlos, ohne Anmeldung.</p>
      <a href="/" style="display:inline-block;background:#fff;color:#1b4332;border-radius:50px;padding:14px 34px;text-decoration:none;font-weight:800;font-size:.98rem">🌿 Kostenlosen Pflanzplan erstellen →</a>
    </div>

    <h2 style="font-size:1.3rem;color:#1b4332;font-weight:800;margin-bottom:16px">Häufige Fragen zur Staudenbeet-Planung</h2>
    ${faqHtml}

    <div style="display:flex;flex-wrap:wrap;gap:10px;margin:30px 0 10px">
      <a href="/stauden-kombinieren" style="background:#fff;border-radius:30px;padding:9px 18px;text-decoration:none;color:#1b4332;font-size:.86rem;font-weight:600;box-shadow:0 1px 6px rgba(0,0,0,.08)">🌸 Stauden kombinieren</a>
      <a href="/pflanzen" style="background:#fff;border-radius:30px;padding:9px 18px;text-decoration:none;color:#1b4332;font-size:.86rem;font-weight:600;box-shadow:0 1px 6px rgba(0,0,0,.08)">🔎 Stauden-Lexikon</a>
      <a href="/beispiele" style="background:#fff;border-radius:30px;padding:9px 18px;text-decoration:none;color:#1b4332;font-size:.86rem;font-weight:600;box-shadow:0 1px 6px rgba(0,0,0,.08)">🌿 Beet-Beispiele</a>
      <a href="/ratgeber" style="background:#fff;border-radius:30px;padding:9px 18px;text-decoration:none;color:#1b4332;font-size:.86rem;font-weight:600;box-shadow:0 1px 6px rgba(0,0,0,.08)">📖 Garten-Ratgeber</a>
    </div>
    ${artikel.length > 0 ? `<h2 style="font-size:1.15rem;color:#1b4332;margin:28px 0 16px;font-weight:700">Weiterlesen im Ratgeber</h2>${artikelHtml}` : ''}
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
// img zeigte auf acht Dateien, die es nie gab — sie liefen seit dem 23.07. als Dauer-404 im
// nginx-Log. Sichtbar war davon nichts (die Bilder liegen als Overlay mit opacity .15 über dem
// Gradienten), der Gradient trägt die Kachel allein. Deshalb die toten Pfade entfernt statt
// acht Bilder zu erfinden. 'Pflanzenportraits' fehlte ganz und fiel auf das Fallback-Icon.
const KAT_CONFIG = Object.assign(Object.create(null), {
  'Grundprinzipien':   { icon: '📚', grad: 'linear-gradient(135deg,#1b4332,#2d6a4f)' },
  'Standorte':         { icon: '🗺️', grad: 'linear-gradient(135deg,#1e3a5f,#2563eb)' },
  'Gestaltung':        { icon: '🎨', grad: 'linear-gradient(135deg,#4c1d95,#7c3aed)' },
  'Oekologie':         { icon: '🌿', grad: 'linear-gradient(135deg,#064e3b,#059669)' },
  'Praxis':            { icon: '🔨', grad: 'linear-gradient(135deg,#78350f,#d97706)' },
  'Kombinationen':     { icon: '🌸', grad: 'linear-gradient(135deg,#831843,#db2777)' },
  'Stilpraegend':      { icon: '🏡', grad: 'linear-gradient(135deg,#134e4a,#0d9488)' },
  'Design':            { icon: '✏️', grad: 'linear-gradient(135deg,#1e293b,#475569)' },
  'Pflanzenportraits': { icon: '🌷', grad: 'linear-gradient(135deg,#3f2d1e,#a16207)' },
});
// img ist optional und bei keiner Kategorie gesetzt. Es MUSS hier trotzdem als leerer String
// stehen: stand im Hero `url('${cfg.img}')` ohne Prüfung, landete bei jedem Artikel das Wort
// "undefined" im CSS. Der Browser löst das relativ zur Seite auf und fordert
// /ratgeber/undefined an — eine 404 pro Artikelaufruf, in den Logs 31 mal nachweisbar.
function katCfg(k) { return { icon: '🌱', grad: 'linear-gradient(135deg,#1b4332,#52b788)', img: '', ...(KAT_CONFIG[k] || {}) }; }
function readingTime(text) { return Math.max(1, Math.round(text.split(/\s+/).length / 200)); }

const FAVICON = `<link rel="icon" href="/favicon.ico" sizes="any"><link rel="icon" type="image/svg+xml" href="/favicon.svg"><link rel="apple-touch-icon" href="/apple-touch-icon.png">`;

const PLAUSIBLE = `<!-- Privacy-friendly analytics by Plausible -->
<script async src="https://plausible.io/js/pa-CQxds67VLWtj57jHuhY1V.js"></script>
<script>window.plausible=window.plausible||function(){(plausible.q=plausible.q||[]).push(arguments)},plausible.init=plausible.init||function(i){plausible.o=i||{}};plausible.init()</script>
<!-- Kaufklicks aller server-gerenderten Flaechen melden (Planer meldet selbst in stauden-portal.html).
     Delegiert statt onclick pro Link: greift auch fuer spaeter ergaenzte Kaufflaechen. Der Link oeffnet
     in einem neuen Tab, die Seite bleibt stehen -> das Event hat Zeit zu senden. -->
<script>document.addEventListener('click',function(e){var a=e.target&&e.target.closest?e.target.closest('[data-kauf]'):null;
if(a&&window.plausible)plausible('Gärtnerei-Klick',{props:{pflanze:a.getAttribute('data-kauf')||'',quelle:a.getAttribute('data-quelle')||''}});});</script>`;

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
  <link rel="icon" href="/favicon.ico" sizes="any"><link rel="icon" type="image/svg+xml" href="/favicon.svg"><link rel="apple-touch-icon" href="/apple-touch-icon.png">
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
  if (RATGEBER_ZU_SEITE[slug]) return res.redirect(301, RATGEBER_ZU_SEITE[slug]);
  if (RATGEBER_ALIASE[slug]) return res.redirect(301, '/ratgeber/' + RATGEBER_ALIASE[slug]);
  let alle = [];
  try { alle = db.prepare('SELECT rowid, * FROM wissen').all(); } catch {}

  const artikel = alle.find(a => slugify(a.titel) === slug);
  if (!artikel) return res.status(404).send(`<!DOCTYPE html><html lang="de"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Nicht gefunden</title></head><body>${NAV_LINKS}<div style="text-align:center;padding:80px 20px"><h1>Artikel nicht gefunden</h1><p><a href="/ratgeber">Zurück zum Ratgeber</a></p></div>${SITE_FOOTER}</body></html>`);

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

  // Eigenes Vorschaubild je Artikel (scripts/og-ratgeber.js). Bis zum 18.08.2026 teilten sich
  // alle 78 Artikel og-default.jpg — wer sie teilte oder pinnte, erzeugte 78 bildgleiche
  // Vorschauen; Pinterest fasst optisch identische Pins zusammen und wertet das als Wiederholung.
  // Mit Rueckfall: Fehlt die Datei, steht wieder das Standardbild da statt eines toten Verweises.
  const ogDatei = path.join(__dirname, 'public', 'og', `ratgeber-${slug}.jpg`);
  const ogBild = fs.existsSync(ogDatei)
    ? `https://www.staudenplan.de/og/ratgeber-${slug}.jpg`
    : 'https://www.staudenplan.de/images/og-default.jpg';

  const passendePflanzen = db.prepare('SELECT name_deutsch, name_botanisch, bild_url, bluehzeit, licht FROM pflanzen ORDER BY RANDOM()').all()
    .filter(p => artikelWoerter.includes(p.name_deutsch.toLowerCase()) || artikelWoerter.includes((p.name_botanisch || '').split(' ')[0].toLowerCase()))
    .slice(0, 4);

  // Article Schema (escJsonLd härtet gegen </script>-Ausbruch)
  const articleSchema = escJsonLd({
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

  // Artikeltext ist untrusted (teils aus externem Brave-Ingest): erst escapen, DANN
  // botanische Namen verlinken — Suche/Ersetzung läuft auf dem escapten Text.
  let artikelInhalt = escHtml(artikel.inhalt);
  try {
    const pflanzenLinks = db.prepare('SELECT name_botanisch FROM pflanzen WHERE name_botanisch IS NOT NULL ORDER BY length(name_botanisch) DESC').all();
    for (const { name_botanisch } of pflanzenLinks) {
      const escName = escHtml(name_botanisch);
      const idx = artikelInhalt.indexOf(escName);
      if (idx !== -1) {
        const s = pflanzeToSlug(name_botanisch);
        artikelInhalt = artikelInhalt.substring(0, idx) +
          `<a href="/pflanze/${s}" style="color:#2d6a4f;font-weight:600;text-decoration:none;border-bottom:1px solid #b7e4c7">${escName}</a>` +
          artikelInhalt.substring(idx + escName.length);
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
            ${p.bild_url ? `<div style="height:80px;overflow:hidden"><img src="${escHtml(p.bild_url)}" alt="${escHtml(p.name_deutsch)}" loading="lazy" style="width:100%;height:100%;object-fit:cover"></div>` : `<div style="height:80px;background:linear-gradient(135deg,#d8f3dc,#b7e4c7);display:flex;align-items:center;justify-content:center;font-size:2rem">🌿</div>`}
            <div style="padding:10px">
              <div style="font-size:.82rem;font-weight:700;color:#1b4332">${escHtml(p.name_deutsch)}</div>
              <div style="font-size:.7rem;color:#aaa;font-style:italic">${escHtml(p.name_botanisch)}</div>
            </div>
          </a>`).join('')}
      </div>
    </div>` : '';

  const verwandteHtml = verwandte.length > 0 ? `
    <div style="margin-top:48px;padding-top:32px;border-top:2px solid #e0d9cf">
      <h2 style="font-size:1.1rem;color:#1b4332;margin-bottom:20px;font-weight:700">Weitere Ratgeber: ${escHtml(artikel.kategorie)}</h2>
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:12px">
        ${verwandte.map(v => `
          <a href="/ratgeber/${slugify(v.titel)}" style="background:#fff;border-radius:10px;padding:0;text-decoration:none;box-shadow:0 2px 8px rgba(0,0,0,.07);overflow:hidden;transition:transform .12s" onmouseover="this.style.transform='translateY(-2px)'" onmouseout="this.style.transform=''">
            <div style="background:${cfg.grad};padding:10px 14px"><span style="color:rgba(255,255,255,.8);font-size:.72rem;font-weight:600">${cfg.icon} ${escHtml(v.kategorie)}</span></div>
            <div style="padding:14px"><p style="font-size:.85rem;font-weight:700;color:#1a1a1a;line-height:1.4;margin-bottom:6px">${escHtml(v.titel)}</p><span style="color:#2d6a4f;font-size:.78rem;font-weight:700">Lesen →</span></div>
          </a>`).join('')}
      </div>
    </div>` : '';

  res.send(`<!DOCTYPE html><html lang="de"><head>
  <meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${escHtml(artikel.titel)} | Staudenplan.de Ratgeber</title>
  <meta name="description" content="${escHtml(artikel.inhalt.substring(0, 155))}">
  <link rel="icon" href="/favicon.ico" sizes="any"><link rel="icon" type="image/svg+xml" href="/favicon.svg"><link rel="apple-touch-icon" href="/apple-touch-icon.png">
  <link rel="canonical" href="https://www.staudenplan.de/ratgeber/${slug}">
  <meta property="og:title" content="${escHtml(artikel.titel)}">
  <meta property="og:type" content="article">
  <meta property="og:description" content="${escHtml(artikel.inhalt.substring(0, 155))}">
  <meta property="og:image" content="${ogBild}">
  <meta property="og:url" content="https://www.staudenplan.de/ratgeber/${slug}">
  <meta property="og:site_name" content="Staudenplan.de">
  <meta property="article:published_time" content="${escHtml(artikel.datum || '')}">
  <meta property="article:section" content="${escHtml(artikel.kategorie)}">
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
    ${cfg.img ? `<div style="position:absolute;inset:0;background:url('${escHtml(cfg.img)}') center/cover no-repeat;opacity:.15"></div>` : ''}
    <div style="max-width:760px;margin:0 auto;position:relative">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:16px">
        <a href="/ratgeber" style="color:rgba(255,255,255,.7);text-decoration:none;font-size:.82rem">← Ratgeber</a>
        <span style="color:rgba(255,255,255,.4)">/</span>
        <span style="background:rgba(255,255,255,.2);color:#fff;border-radius:20px;padding:3px 12px;font-size:.75rem;font-weight:700">${cfg.icon} ${escHtml(artikel.kategorie)}</span>
      </div>
      <h1 style="font-size:clamp(1.5rem,4vw,2rem);font-weight:800;color:#fff;line-height:1.25;margin-bottom:16px">${escHtml(artikel.titel)}</h1>
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
    // Slug streng validieren: keine Pfad-Trenner/Punkte → kein Path-Traversal.
    if (typeof slug !== 'string' || !/^[a-z0-9-]+$/.test(slug)) return null;
    const dir = path.join(__dirname, 'scripts');
    const p = path.join(dir, `beispiel-plan-${slug}.json`);
    // Belt-and-suspenders: aufgelöster Pfad muss im scripts/-Verzeichnis bleiben.
    if (path.dirname(path.resolve(p)) !== path.resolve(dir)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch { return null; }
}

// HINWEIS: identisch mit BLOOM_COLORS in stauden-portal.html (Client) halten — bei Änderung beide anpassen.
// Farb-Keys KLEINGESCHRIEBEN (DB liefert gemischte Groß-/Kleinschreibung: "Gelb", "gelb",
// "Rosa", "rosa" …) — Lookup erfolgt case-insensitiv. Deckt alle in der DB vorkommenden
// Farbwerte ab. Muss mit BLOOM_COLORS in stauden-portal.html synchron bleiben.
const BLOOM_COLORS_SSR = {
  'rosa':'#f472b6','pink':'#f472b6','lachs':'#fb7185','aprikose':'#fdba74',
  'purpur':'#a855f7','purpurrot':'#a21caf','lila':'#a855f7',
  'violett':'#818cf8','dunkelviolett':'#6d28d9','blauviolett':'#7c3aed','lavendel':'#c4b5fd',
  'blau':'#3b82f6','hellblau':'#7dd3fc',
  'weiß':'#e2e8f0','weiss':'#e2e8f0','creme':'#fef3c7','beige':'#e7d9b0',
  'gelb':'#facc15','gelbgrün':'#bef264','gelb-grün':'#bef264','gelbgruen':'#bef264',
  'orange':'#fb923c','karamell':'#d97706','bronze':'#d97706',
  'rot':'#ef4444','dunkelrot':'#991b1b','weinrot':'#b91c1c','rubinrot':'#be123c','burgunderrot':'#7f1d1d',
  'rotbraun':'#9a3412','braun':'#a16207',
  'grün':'#4ade80','gruen':'#4ade80','grünlich':'#86efac',
  'silber':'#d1d5db','silbrig':'#cbd5e1','silbrig-grün':'#c3d0c3','grau':'#cbd5e1',
  'schwarz':'#334155','mehrfarbig':'#e879f9',
};
function bloomColorSSR(farbe) {
  if (typeof farbe !== 'string' || !farbe) return '#cbd5e1';
  const k = (farbe.split(/[|,\/]/)[0] || '').trim().toLowerCase();
  const c = Object.prototype.hasOwnProperty.call(BLOOM_COLORS_SSR, k) ? BLOOM_COLORS_SSR[k] : null;
  return (typeof c === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(c)) ? c : '#cbd5e1';
}
function hexLightenSSR(hex, amt) {
  const n = parseInt(hex.replace('#',''), 16);
  return '#' + [n>>16, (n>>8)&0xff, n&0xff]
    .map(v => Math.min(255, v+amt).toString(16).padStart(2,'0')).join('');
}
function hexDarkenSSR(hex, amt) { return hexLightenSSR(hex, -amt); }

// Rolle einer Pflanze für die Visualisierung (identisch zur Client-Logik getRolleViz).
function plantRolleSSR(p) {
  if (p.rolle === 'Leitstaude') return 'leit';
  if (p.rolle === 'Begleitstaude') return 'begleit';
  if (p.rolle === 'Füllstaude') return 'fuell';
  return (p.hoehe_cm || 50) >= 80 ? 'leit' : (p.hoehe_cm || 50) >= 40 ? 'begleit' : 'fuell';
}

// Server-Port des Client-Placement-Algorithmus (stauden-portal.html calcPlacements),
// Rechteck- und Freihand-Beete (Saison = alle). Freihand über opts.constraintPolys —
// dieselben Punkt-in-Polygon-Schritte wie im Client. Deterministisch
// (pseudoRand, kein Math.random). WICHTIG: bei Änderungen am Client-Algorithmus hier
// nachziehen, damit geteilte Pläne & Beispielseiten wie die App aussehen.
function calcPlacementsSSR(pflanzen, bedW, bedH, opts) {
  opts = opts || {};
  const constraintPolys = Array.isArray(opts.constraintPolys) ? opts.constraintPolys : null;
  const hasConstraint = !!(constraintPolys && constraintPolys.length);
  const gartW_m = Number(opts.gartW) > 0 ? Number(opts.gartW) : 4;
  const dichte = ['locker', 'normal', 'dicht'].includes(opts.dichte) ? opts.dichte : 'normal';
  const gartenflaeche = Number(opts.gartenflaeche) > 0 ? Number(opts.gartenflaeche) : 10;
  const sichtseite = typeof opts.sichtseite === 'string' ? opts.sichtseite : '';
  const pxPerM = bedW / Math.max(0.5, gartW_m);
  const rScale = Math.min(1, (bedW + 32) / 700);
  const isRund = /rundbeet|inselbeet/i.test(sichtseite);
  const cxBed = bedW / 2, cyBed = bedH / 2;

  const SICHT_TEXTS = ['von hinten','von hinten-rechts','von rechts-hinten','von rechts','von rechts-vorne','von vorne-rechts','von vorne','von vorne-links','von links-vorne','von links','von links-hinten','von hinten-links'];
  let sichtIdx = 6;
  if (!isRund && sichtseite) { const f = SICHT_TEXTS.findIndex(t => sichtseite.includes(t)); if (f >= 0) sichtIdx = f; }
  const rotAngle = sichtIdx / 12 * 2 * Math.PI - Math.PI;

  function rotateAroundCenter(x, y, angle) {
    const dx = x - bedW / 2, dy = y - bedH / 2;
    return { x: bedW / 2 + dx * Math.cos(angle) - dy * Math.sin(angle),
             y: bedH / 2 + dx * Math.sin(angle) + dy * Math.cos(angle) };
  }
  function pseudoRand(seed) { return Math.abs(Math.sin(seed * 127.1 + 1.3)) % 1; }
  function yZone(p) {
    const h = p.hoehe_cm || 50;
    const st = (p.standort || '').toLowerCase().trim();
    if (st.includes('hintergrund') || st === 'ecke/hintergrund') return { yMin: 0.00, yMax: 0.36 };
    if (st === 'mitte' || st === 'mittelzone')                   return { yMin: 0.28, yMax: 0.62 };
    if (st.includes('vordergrund'))                              return { yMin: 0.56, yMax: 1.00 };
    if (h >= 100) return { yMin: 0.00, yMax: 0.45 };
    if (h >= 70)  return { yMin: 0.08, yMax: 0.62 };
    if (h >= 40)  return { yMin: 0.32, yMax: 0.82 };
    return              { yMin: 0.55, yMax: 1.00 };
  }
  function rZone(p) {
    const h = p.hoehe_cm || 50;
    const st = (p.standort || '').toLowerCase().trim();
    if (st === 'mitte')      return { rMin: 0.00, rMax: 0.36 };
    if (st === 'mittelzone') return { rMin: 0.25, rMax: 0.62 };
    if (st === 'rand')       return { rMin: 0.55, rMax: 1.00 };
    if (h >= 100) return { rMin: 0.00, rMax: 0.36 };
    if (h >= 70)  return { rMin: 0.18, rMax: 0.55 };
    if (h >= 40)  return { rMin: 0.40, rMax: 0.76 };
    return              { rMin: 0.60, rMax: 1.00 };
  }
  const getRolle = plantRolleSSR;
  function getR(p) {
    const spacing_cm = p.pflanzabstand_cm || Math.max(20, Math.min(90, (p.hoehe_cm || 50) * 0.55 + 10));
    return Math.max(7, Math.min(36 * rScale, (spacing_cm / 200) * pxPerM));
  }

  // ── 1. Leit- & Begleitstauden: Goldener-Schnitt-Platzierung ──────────────
  const PHI = 0.6180339887;
  const all = [];
  const kombiIdx = {};
  pflanzen.forEach((p, pi) => {
    if (p.name_botanisch) kombiIdx[String(p.name_botanisch).toLowerCase()] = pi;
    if (p.name_deutsch) kombiIdx[String(p.name_deutsch).toLowerCase()] = pi;
  });
  const nonFuellXIdx = {};
  let _nfxCount = 0;
  pflanzen.forEach((p, pi) => { if (getRolle(p) !== 'fuell') nonFuellXIdx[pi] = _nfxCount++; });
  const anchorX = pflanzen.map((p, pi) => getRolle(p) === 'fuell' ? 0.5 : (nonFuellXIdx[pi] * PHI + 0.05) % 1);
  function partnerAnchorX(p, pi) {
    if (!p.kombinationspartner) return null;
    for (const raw of String(p.kombinationspartner).split(/[,;|]/)) {
      const s = raw.trim().toLowerCase();
      if (kombiIdx[s] !== undefined && kombiIdx[s] !== pi) return anchorX[kombiIdx[s]];
      const genus = s.split(' ')[0];
      const match = Object.keys(kombiIdx).find(k => k.startsWith(genus + ' ') || k === genus);
      if (match && kombiIdx[match] !== pi) return anchorX[kombiIdx[match]];
    }
    return null;
  }

  pflanzen.forEach((p, pi) => {
    if (getRolle(p) === 'fuell') return;
    if (all.length >= 400) return; // DoS-Schutz: Platzierungen deckeln (reale Pläne erreichen das nie)
    const n = Math.min(p.stueckzahl || 1, 120);
    const rolle = getRolle(p);
    const nDrifts = n <= 3 ? 1 : n <= 8 ? 2 : 3;
    const sX = rolle === 'leit' ? 0.09 : 0.18;
    const sY = rolle === 'leit' ? 0.07 : 0.13;
    const r = getR(p);
    const pX = partnerAnchorX(p, pi);
    let drifts;
    if (isRund) {
      const maxRad = Math.min(bedW, bedH) * 0.48;
      const zone = rZone(p);
      drifts = Array.from({ length: nDrifts }, (_, di) => {
        const angle = (pi * PHI + di * 0.31) * Math.PI * 2;
        const rFrac = zone.rMin + pseudoRand(pi * 53 + di * 31 + 5) * (zone.rMax - zone.rMin);
        return { xFrac: 0.5 + Math.cos(angle) * rFrac * (maxRad / bedW) * 1.8,
                 yFrac: 0.5 + Math.sin(angle) * rFrac * (maxRad / bedH) * 1.8, rFrac, angle, zone };
      });
    } else {
      const zone = yZone(p);
      const nfi = nonFuellXIdx[pi] ?? 0;
      drifts = Array.from({ length: nDrifts }, (_, di) => {
        const rawX = 0.12 + ((nfi * PHI + di * 0.31) % 0.76);
        return { xFrac: (pX !== null && di === 0) ? rawX * 0.5 + pX * 0.5 : rawX,
                 yFrac: zone.yMin + pseudoRand(pi * 53 + di * 31 + 5) * (zone.yMax - zone.yMin), zone };
      });
    }
    for (let i = 0; i < n; i++) {
      if (all.length >= 400) break;
      const seed = pi * 127 + i * 37;
      const dr = drifts[i % drifts.length];
      const xFrac = Math.min(0.96, Math.max(0.04, dr.xFrac + (pseudoRand(seed) - 0.5) * 2 * sX));
      let yFrac;
      if (isRund) {
        yFrac = Math.min(0.96, Math.max(0.04, dr.yFrac + (pseudoRand(seed + 13) - 0.5) * 2 * sY));
      } else {
        const zone = dr.zone;
        yFrac = Math.min(zone.yMax, Math.max(zone.yMin, dr.yFrac + (pseudoRand(seed + 13) - 0.5) * 2 * sY));
      }
      let x = xFrac * bedW, y = yFrac * bedH, placed = false;
      const pZone = isRund ? null : dr.zone;
      if (hasConstraint) {
        // Pass 1: in der Nähe des Zieldrift-Punkts suchen (zonengebunden)
        for (let att = 0; att < 60 && !placed; att++) {
          const s2 = seed + att * 17;
          const cx = (xFrac + (pseudoRand(s2 + 5) - 0.5) * 0.5) * bedW;
          const cy = pZone
            ? (pZone.yMin + pseudoRand(s2 + 9) * (pZone.yMax - pZone.yMin)) * bedH
            : (yFrac + (pseudoRand(s2 + 9) - 0.5) * 0.2) * bedH;
          if (pointInAnyPolygonWithMarginSSR(cx, cy, constraintPolys, r * 0.5)) { x = cx; y = cy; placed = true; }
        }
        // Pass 2: Ziel-x beibehalten, y komplett aufmachen (findet Platz in schmalen Polygon-Bereichen)
        if (!placed) for (let att = 0; att < 60 && !placed; att++) {
          const cx = Math.max(0, Math.min(bedW, (xFrac + (pseudoRand(seed + att * 53 + 300) - 0.5) * 0.22) * bedW));
          const cy = pseudoRand(seed + att * 31 + 300) * bedH;
          if (pointInAnyPolygonWithMarginSSR(cx, cy, constraintPolys, r * 0.5)) { x = cx; y = cy; placed = true; }
        }
        // Pass 3: letzter Ausweg — irgendwo im Polygon (sehr schmale Polygone)
        if (!placed) for (let att = 0; att < 20 && !placed; att++) {
          const cx = pseudoRand(seed + att * 71 + 600) * bedW;
          const cy = pseudoRand(seed + att * 43 + 600) * bedH;
          if (pointInAnyPolygonSSR(cx, cy, constraintPolys)) { x = cx; y = cy; placed = true; }
        }
      }
      all.push({ x: Math.max(r, Math.min(bedW - r, x)), y: Math.max(r, Math.min(bedH - r, y)), r, pflanze: p, pi });
    }
  });

  function applyZoneForce(strength) {
    const maxRad = Math.min(bedW, bedH) * 0.48;
    all.forEach(pl => {
      if (isRund) {
        const zone = rZone(pl.pflanze);
        const targetR = (zone.rMin + zone.rMax) / 2 * maxRad;
        const dx = pl.x - cxBed, dy = pl.y - cyBed;
        const currR = Math.hypot(dx, dy) || 0.1;
        const pull = (targetR - currR) * strength;
        pl.x += (dx / currR) * pull; pl.y += (dy / currR) * pull;
      } else {
        const zone = yZone(pl.pflanze);
        const targetY = (zone.yMin + zone.yMax) / 2 * bedH;
        pl.y += (targetY - pl.y) * strength;
      }
    });
  }

  const GAP = 3;
  for (let iter = 0; iter < 80; iter++) {
    let moved = false;
    for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) {
      const dx = all[j].x - all[i].x, dy = all[j].y - all[i].y;
      const dist2 = dx * dx + dy * dy, minDist = all[i].r + all[j].r + GAP;
      if (dist2 < minDist * minDist) {
        const dist = Math.sqrt(dist2) || 0.1, push = (minDist - dist) / 2;
        const nx = dx / dist, ny = dy / dist;
        all[i].x -= nx * push * 0.5; all[i].y -= ny * push * 0.5;
        all[j].x += nx * push * 0.5; all[j].y += ny * push * 0.5;
        moved = true;
      }
    }
    applyZoneForce(0.022);
    all.forEach(p => { p.x = Math.max(p.r, Math.min(bedW - p.r, p.x)); p.y = Math.max(p.r, Math.min(bedH - p.r, p.y)); if (hasConstraint) snapInsidePolygonSSR(p, constraintPolys); });
    if (!moved) break;
  }

  // Anti-Kollinearitäts-Pass: verhindert dass Pflanzen direkt hintereinander stehen
  for (let colIter = 0; colIter < 14; colIter++) {
    for (let i = 0; i < all.length; i++) {
      const p = all[i];
      const near = [];
      for (let j = 0; j < all.length; j++) {
        if (j === i) continue;
        const d = Math.hypot(all[j].x - p.x, all[j].y - p.y);
        if (d < (p.r + all[j].r) * 3.8) near.push({ j, d });
      }
      if (near.length < 2) continue;
      for (let a = 0; a < near.length; a++) {
        for (let b = a + 1; b < near.length; b++) {
          const ja = near[a].j, jb = near[b].j;
          const ax = all[ja].x - p.x, ay = all[ja].y - p.y;
          const bx = all[jb].x - p.x, by = all[jb].y - p.y;
          const da = near[a].d, db = near[b].d;
          if (da < 1 || db < 1) continue;
          const dot = (ax * bx + ay * by) / (da * db);
          if (dot < -0.80) {
            const lineX = all[jb].x - all[ja].x, lineY = all[jb].y - all[ja].y;
            const lineLen = Math.hypot(lineX, lineY);
            if (lineLen < 1) continue;
            const perpX = -lineY / lineLen, perpY = lineX / lineLen;
            const side = (i + ja + jb) % 2 === 0 ? 1 : -1;
            const strength = (-dot - 0.80) / 0.20;
            p.x += perpX * side * p.r * 0.55 * strength;
            p.y += perpY * side * p.r * 0.55 * strength;
          }
        }
      }
    }
    all.forEach(p => { p.x = Math.max(p.r, Math.min(bedW - p.r, p.x)); p.y = Math.max(p.r, Math.min(bedH - p.r, p.y)); if (hasConstraint) snapInsidePolygonSSR(p, constraintPolys); });
    for (let si = 0; si < 10; si++) {
      for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) {
        const dx = all[j].x - all[i].x, dy = all[j].y - all[i].y;
        const d2 = dx * dx + dy * dy, md = all[i].r + all[j].r + GAP;
        if (d2 < md * md) {
          const d = Math.sqrt(d2) || 0.1, push = (md - d) / 2;
          const nx = dx / d, ny = dy / d;
          all[i].x -= nx * push * 0.5; all[i].y -= ny * push * 0.5;
          all[j].x += nx * push * 0.5; all[j].y += ny * push * 0.5;
        }
      }
      all.forEach(p => { p.x = Math.max(p.r, Math.min(bedW - p.r, p.x)); p.y = Math.max(p.r, Math.min(bedH - p.r, p.y)); if (hasConstraint) snapInsidePolygonSSR(p, constraintPolys); });
    }
  }

  // ── Artengruppen-Spread: Rand-Gruppen zur Kante, innere gleichmäßig verteilen ──
  if (!isRund && all.length >= 2) {
    const xGroups = {};
    all.forEach(pl => { const key = pl.pi; if (!xGroups[key]) xGroups[key] = { pls: [], cx: 0 }; xGroups[key].pls.push(pl); });
    const grps = Object.values(xGroups);
    const recalc = () => grps.forEach(g => { g.cx = g.pls.reduce((s, p) => s + p.x, 0) / g.pls.length; });
    recalc();
    for (let xIter = 0; xIter < 40; xIter++) {
      grps.sort((a, b) => a.cx - b.cx);
      if (grps.length >= 2) {
        // Randgruppen zur Beetkante ziehen: stark für Rechteck, sanft für Freihand
        // (Freihand: snapInsidePolygonSSR hält Pflanzen am Polygonrand statt in der Mitte)
        const edgePull = hasConstraint ? 0.025 : 0.06;
        const r0 = grps[0].pls.reduce((m, p) => Math.max(m, p.r), 0);
        const rL = grps[grps.length - 1].pls.reduce((m, p) => Math.max(m, p.r), 0);
        grps[0].cx += (r0 * 2.5 - grps[0].cx) * edgePull;
        grps[grps.length - 1].cx += (bedW - rL * 2.5 - grps[grps.length - 1].cx) * edgePull;
      }
      for (let i = 1; i < grps.length - 1; i++) {
        const ideal = (grps[i - 1].cx + grps[i + 1].cx) / 2;
        grps[i].cx += (ideal - grps[i].cx) * 0.09;
      }
      grps.forEach(g => {
        const currCx = g.pls.reduce((s, p) => s + p.x, 0) / g.pls.length;
        const dx = g.cx - currCx;
        g.pls.forEach(pl => { pl.x = Math.max(pl.r, Math.min(bedW - pl.r, pl.x + dx)); });
      });
      if (hasConstraint) all.forEach(p => snapInsidePolygonSSR(p, constraintPolys));
      recalc();
      for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) {
        const dx = all[j].x - all[i].x, dy = all[j].y - all[i].y;
        const d2 = dx * dx + dy * dy, md = all[i].r + all[j].r + GAP;
        if (d2 < md * md) {
          const d = Math.sqrt(d2) || 0.1, push = (md - d) / 2;
          all[i].x -= (dx / d) * push * 0.5; all[i].y -= (dy / d) * push * 0.5;
          all[j].x += (dx / d) * push * 0.5; all[j].y += (dy / d) * push * 0.5;
        }
      }
      all.forEach(p => { p.x = Math.max(p.r, Math.min(bedW - p.r, p.x)); p.y = Math.max(p.r, Math.min(bedH - p.r, p.y)); if (hasConstraint) snapInsidePolygonSSR(p, constraintPolys); });
      recalc();
    }
  }

  // ── 2. Füllstauden: Jitter-Grid in freie Flächen (Matrixbepflanzung) ──────
  const fuellArten = pflanzen.filter(p => getRolle(p) === 'fuell');
  if (fuellArten.length > 0) {
    const plantsPerM2 = dichte === 'locker' ? 2.5 : dichte === 'dicht' ? 7 : 4;
    const aiTotal = fuellArten.reduce((s, p) => s + (p.stueckzahl || 1), 0);
    const minByDichte = Math.round(gartenflaeche * plantsPerM2) - all.length;
    const totalFuell = Math.min(600, Math.max(aiTotal, Math.max(0, minByDichte)));
    const cellSize = Math.sqrt((bedW * bedH) / Math.max(1, totalFuell)) * 0.88;
    const candidates = [];
    const cols = Math.ceil(bedW / cellSize), rows = Math.ceil(bedH / cellSize);
    const clearance = Math.min(...fuellArten.map(p => getR(p))) * 0.8;
    for (let col = 0; col < cols; col++) {
      for (let row = 0; row < rows; row++) {
        const seed = col * 997 + row * 31;
        const jx = (col + 0.15 + pseudoRand(seed) * 0.7) * cellSize;
        const jy = (row + 0.15 + pseudoRand(seed + 500) * 0.7) * cellSize;
        if (jx < bedW * 0.97 && jy < bedH * 0.97 && jx > bedW * 0.03 && jy > bedH * 0.03) {
          if (hasConstraint && !pointInAnyPolygonWithMarginSSR(jx, jy, constraintPolys, cellSize * 0.3)) continue;
          if (!all.some(pl => Math.hypot(jx - pl.x, jy - pl.y) < pl.r + clearance)) {
            candidates.push({ x: jx, y: jy });
          }
        }
      }
    }
    candidates.sort((a, b) => a.x + a.y * 0.15 - b.x - b.y * 0.15);
    const nSpecies = fuellArten.length;
    const aiTotalCheck = fuellArten.reduce((s, p) => s + (p.stueckzahl || 1), 0);
    const scale = aiTotalCheck > 0 ? totalFuell / aiTotalCheck : 1;
    fuellArten.forEach((p, fi) => {
      const pi = pflanzen.indexOf(p);
      const r = getR(p);
      const mine = candidates.filter((_, ci) => ci % nSpecies === fi);
      const n = Math.min(Math.round((p.stueckzahl || 1) * scale), mine.length);
      for (let i = 0; i < n; i++) {
        const idx = Math.round(i * (mine.length - 1) / Math.max(1, n - 1));
        const c = mine[Math.min(idx, mine.length - 1)];
        if (c) all.push({ x: c.x, y: c.y, r, pflanze: p, pi });
      }
    });
  }

  // (Layout-Rotation nach Blickrichtung entfernt — quetschte bei schrägen Winkeln die
  //  Pflanzen in eine Ecke. Beettyp wirkt nur noch über die Höhenzonen: einseitig = hoch
  //  hinten, Rundbeet = hoch Mitte. Muss mit dem Client synchron bleiben.)
  return all;
}

// Grafischer Draufsicht-Plan (SSR) — spiegelt renderGrafisch aus stauden-portal.html:
// echtes Placement (calcPlacementsSSR), Füllstauden als weiche Drift-Patches (Blur),
// Leit-/Begleitstauden als Einzelkreise. opts: { beetLaenge, beetBreite, sichtseite, dichte }.
function renderGrafischSSR(pflanzen, flaeche, opts) {
  opts = opts || {};
  const W = 720, PAD = 16;
  const bedW = W - PAD * 2;
  // Maße robust aus (ggf. untrusted) opts ableiten: immer endliche, positive Zahlen (>=0.1 m),
  // damit meterPxX/Y nie 0/negativ/Infinity werden (sonst Endlosschleife bei den Gitterlinien).
  const blNum = Number(opts.beetLaenge), bbNum = Number(opts.beetBreite);
  let gartW = parseFloat(((blNum > 0 ? blNum : Math.sqrt((flaeche || 15) * 3))).toFixed(1));
  if (!(gartW >= 0.1)) gartW = 0.1;
  let gartH = parseFloat(((bbNum > 0 ? bbNum : (flaeche || 15) / gartW)).toFixed(1));
  if (!(gartH >= 0.1)) gartH = 0.1;
  const aspect = Math.max(0.18, Math.min(1.2, gartH / gartW));
  const bedH = Math.round(bedW * aspect);
  const H = bedH + PAD * 2;

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
    return `<circle cx="${(PAD+sx).toFixed(1)}" cy="${(PAD+sy).toFixed(1)}" r="1.2" fill="rgba(0,0,0,.12)"/>`;
  }).join('');

  const meterPxX = bedW / gartW, meterPxY = bedH / gartH;
  const gridLines = [];
  for (let x = meterPxX; x < bedW; x += meterPxX)
    gridLines.push(`<line x1="${(PAD+x).toFixed(1)}" y1="${PAD}" x2="${(PAD+x).toFixed(1)}" y2="${PAD+bedH}" stroke="rgba(255,255,255,.12)" stroke-width="1" stroke-dasharray="4,4"/>`);
  for (let y = meterPxY; y < bedH; y += meterPxY)
    gridLines.push(`<line x1="${PAD}" y1="${(PAD+y).toFixed(1)}" x2="${PAD+bedW}" y2="${(PAD+y).toFixed(1)}" stroke="rgba(255,255,255,.12)" stroke-width="1" stroke-dasharray="4,4"/>`);

  // Gezeichnete Freihandfläche: Beetform und Platzierungsgrenze. Die Platzierung rechnet
  // ohne PAD-Offset (Koordinaten sind relativ zum Beet), gezeichnet wird mit.
  const drawnPolys = opts.form === 'zeichnen' ? scaledPolygonsSSR(opts.polygons, bedW, bedH, PAD, PAD) : null;
  const placementPolys = opts.form === 'zeichnen' ? scaledPolygonsSSR(opts.polygons, bedW, bedH, 0, 0) : null;
  const istFreihand = !!(drawnPolys && drawnPolys.length);

  // Wenn der Browser seine Platzierung mitgeschickt hat, wird sie übernommen — der geteilte
  // Plan zeigt dann exakt dieselbe Anordnung wie der Plan beim Ersteller. Nachrechnen führt
  // sonst zu sichtbaren Abweichungen, weil die Zeichenfläche hier fest 720 px breit ist,
  // im Browser aber bis zu 800 px, und daran Radien und Kollisionsauflösung hängen.
  // Nur für Pläne, die vor dieser Änderung geteilt wurden, wird weiterhin gerechnet.
  const uebernommen = Array.isArray(opts.platzierungen) && opts.platzierungen.length
    ? opts.platzierungen
        .filter(p => p.i < pflanzen.length)
        .map(p => ({ x: p.x * bedW, y: p.y * bedH, r: p.r * bedW, pflanze: pflanzen[p.i], pi: p.i }))
    : null;

  const placements = (uebernommen && uebernommen.length) ? uebernommen : calcPlacementsSSR(pflanzen, bedW, bedH, {
    gartW, gartenflaeche: (flaeche || 15), dichte: opts.dichte, sichtseite: opts.sichtseite,
    constraintPolys: placementPolys
  });
  const sorted = [...placements].sort((a, b) => a.y - b.y);
  const numOf = (pflanze) => pflanzen.findIndex(pp => pp.name_botanisch === pflanze.name_botanisch) + 1;

  // Füllstauden: weiche Drift-Patches (Blur) — unter Leit-/Begleitstauden.
  // Nach Art (pi) gruppieren wie der Client, damit die Z-Reihenfolge bei überlappenden
  // (halbtransparenten) Patches identisch zur App ist.
  const fuellGroups = {};
  sorted.forEach(pl => {
    if (plantRolleSSR(pl.pflanze) !== 'fuell') return;
    (fuellGroups[pl.pi] = fuellGroups[pl.pi] || []).push(pl);
  });
  const driftPatches = Object.values(fuellGroups).map(pts => pts.map(({ x, y, r: fr, pflanze }) => {
    const c = bloomColorSSR(pflanze.farbe);
    const num = numOf(pflanze);
    return `<g>
      <circle cx="${(PAD+x).toFixed(1)}" cy="${(PAD+y).toFixed(1)}" r="${(fr+1).toFixed(1)}" fill="rgba(0,0,0,.15)"/>
      <circle cx="${(PAD+x).toFixed(1)}" cy="${(PAD+y).toFixed(1)}" r="${fr.toFixed(1)}" fill="${c}" filter="url(#fuellBlur)" stroke="rgba(255,255,255,.5)" stroke-width="1"/>
      <text x="${(PAD+x).toFixed(1)}" y="${(PAD+y+3).toFixed(1)}" text-anchor="middle" font-size="${Math.max(7, fr*0.65).toFixed(1)}px" font-weight="700" fill="rgba(0,0,0,.6)" font-family="system-ui">${num}</text>
    </g>`;
  }).join('')).join('');

  // Leit- & Begleitstauden: Einzelkreise (Leit größer + dickerer Rand)
  const circles = sorted.filter(({ pflanze }) => plantRolleSSR(pflanze) !== 'fuell').map(({ x, y, r: rBase, pflanze, pi }) => {
    const rolle = plantRolleSSR(pflanze);
    const r = rolle === 'leit' ? rBase * 1.1 : rBase;
    const strokeW = rolle === 'leit' ? '2.5' : '1.5';
    const strokeC = rolle === 'leit' ? 'rgba(255,255,255,.95)' : 'rgba(255,255,255,.6)';
    const num = numOf(pflanze);
    return `<g>
      <circle cx="${(PAD+x).toFixed(1)}" cy="${(PAD+y).toFixed(1)}" r="${(r+2).toFixed(1)}" fill="rgba(0,0,0,.2)"/>
      <circle cx="${(PAD+x).toFixed(1)}" cy="${(PAD+y).toFixed(1)}" r="${r.toFixed(1)}" fill="url(#pg${pi})" stroke="${strokeC}" stroke-width="${strokeW}"/>
      <text x="${(PAD+x).toFixed(1)}" y="${(PAD+y+4).toFixed(1)}" text-anchor="middle" font-size="${Math.max(8, r*0.55).toFixed(1)}px" font-weight="800" fill="rgba(0,0,0,.6)" font-family="system-ui">${num}</text>
    </g>`;
  }).join('');

  const scaleY = PAD + bedH + 8;
  const sichtseite = typeof opts.sichtseite === 'string' ? opts.sichtseite : '';
  const topLabel = sichtseite.includes('von hinten') ? 'Vorne' : 'Hinten';
  const blickText = sichtseite.includes('Blick ') ? sichtseite.replace(/.*Blick /, 'Blick ')
    : sichtseite.includes('Rundbeet') ? 'Rundbeet'
    : sichtseite.includes('Eckbeet') ? 'Eckbeet' : 'Blick von vorne';

  // Beetform: gezeichnetes Polygon, sonst Rechteck. Bei Freihand entfallen die
  // Kantenmaße (es gibt keine Länge/Breite) und stattdessen steht die Fläche darunter.
  const bedShape = istFreihand
    ? drawnPolys.map(p => `<polygon points="${polyPointsAttrSSR(p.svgPoints)}" fill="url(#soilGrad)"/>`).join('')
    : `<rect x="${PAD}" y="${PAD}" width="${bedW}" height="${bedH}" rx="8" fill="url(#soilGrad)"/>`;
  const bedClipContent = istFreihand
    ? drawnPolys.map(p => `<polygon points="${polyPointsAttrSSR(p.svgPoints)}"/>`).join('')
    : `<rect x="${PAD}" y="${PAD}" width="${bedW}" height="${bedH}" rx="8"/>`;
  const bedOutline = istFreihand
    ? drawnPolys.map(p => `<polygon points="${polyPointsAttrSSR(p.svgPoints)}" fill="none" stroke="#a0714f" stroke-width="2.5" stroke-linejoin="round"/>`).join('')
    : `<rect x="${PAD}" y="${PAD}" width="${bedW}" height="${bedH}" rx="8" fill="none" stroke="#a0714f" stroke-width="2.5"/>`;
  const massLabels = istFreihand ? '' :
    `<text x="${W/2}" y="${PAD-4}" text-anchor="middle" font-size="10" fill="#888" font-family="system-ui">↑ ${topLabel} (${gartW.toFixed(1)} m)</text>
    <text x="8" y="${PAD+bedH/2}" text-anchor="middle" font-size="10" fill="#888" font-family="system-ui" transform="rotate(-90,8,${PAD+bedH/2})">${gartH.toFixed(1)} m</text>`;
  const bedLabel = istFreihand
    ? `<text x="${W/2}" y="${scaleY+26}" text-anchor="middle" font-size="10" fill="#aaa" font-family="system-ui">Freihandfläche · ${Number(flaeche || 0).toFixed(1)} m²</text>`
    : '';

  // viewBox ist auf einem Handy nicht optional: Ohne sie hat das SVG kein eigenes
  // Koordinatensystem, das mitskaliert. max-width:100% verkleinert dann nur den Rahmen,
  // der Inhalt bleibt in 720 Nutzereinheiten stehen und wird rechts abgeschnitten — auf
  // einem 380-px-Gerät fehlte fast die Hälfte des Beets. height:auto gehört dazu, sonst
  // bleibt die Höhe am Attribut kleben und das Seitenverhältnis kippt.
  const svgH = H + 24 + (istFreihand ? 14 : 0);
  const svg = `<svg width="${W}" height="${svgH}" viewBox="0 0 ${W} ${svgH}" preserveAspectRatio="xMidYMid meet" xmlns="http://www.w3.org/2000/svg" style="max-width:100%;height:auto;border-radius:12px;display:block">
    <defs>
      ${gradDefs}
      <filter id="fuellBlur" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur in="SourceGraphic" stdDeviation="2.5"/></filter>
      <linearGradient id="soilGrad" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#7a5230"/>
        <stop offset="100%" stop-color="#4e3019"/>
      </linearGradient>
      <clipPath id="bedClip">${bedClipContent}</clipPath>
    </defs>
    ${bedShape}
    <g clip-path="url(#bedClip)">${soilDots}${gridLines.join('')}</g>
    ${bedOutline}
    <g clip-path="url(#bedClip)">${driftPatches}</g>
    <g clip-path="url(#bedClip)">${circles}</g>
    ${massLabels}
    <rect x="${PAD+10}" y="${scaleY}" width="${Math.round(meterPxX)}" height="5" rx="2" fill="#666"/>
    <text x="${PAD+10}" y="${scaleY+14}" font-size="10" fill="#888" font-family="system-ui">1 m</text>
    <text x="${W/2}" y="${scaleY+14}" text-anchor="middle" font-size="10" fill="#aaa" font-family="system-ui">&#128065; ${escHtml(blickText)} · ↓ Vordergrund</text>
    ${bedLabel}
  </svg>`;

  const legend = pflanzen.map((p, i) => {
    const c = bloomColorSSR(p.farbe);
    const rolle = plantRolleSSR(p);
    const dotStyle = rolle === 'fuell' ? `background:${c};opacity:.7;border-radius:3px;` : `background:${c};border-radius:50%;`;
    const rolleLabel = rolle === 'leit' ? '⭐' : rolle === 'begleit' ? '🌿' : '▪';
    return `<div class="vl-item">
      <span class="vl-num">${i+1}</span>
      <span class="vl-dot" style="${dotStyle}"></span>
      <span>${escHtml(p.name_deutsch)}</span>
      <span style="color:#bbb;font-size:.7rem">${rolleLabel}</span>
      ${p.bluehzeit ? `<span class="vl-bluehzeit" style="color:#999;font-size:.72rem">${escHtml(p.bluehzeit)}</span>` : ''}
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

// quelle: landet als Plausible-Property am Kaufklick, damit sichtbar wird, welche Fläche verkauft.
function renderBeispielPlanSSR(plan, flaeche, grafikOpts, quelle = '') {
  if (!plan || !plan.pflanzen) return '';
  const emojis = ['🌸','🌺','🌼','🌻','🌹','💐','🌷','🌿','🍃','🌾'];
  const jez = {'Frühling':'🌱','Sommer':'☀️','Herbst':'🍂','Winter':'❄️'};
  const pflanzen = plan.pflanzen;

  const gesamt = pflanzen.reduce((s,p) => s + (Number(p.stueckzahl) || 0), 0);
  // Die Beträge stammen aus preis_stueck_eur — Kalkulationsgrößen für die Plansumme, KEINE
  // Handelspreise (Echinacea purpurea 8,00 € in der DB gegen 5,10 € bei Gaißmayer). Auf den
  // Pflanzenseiten heißt derselbe Wert deshalb längst „💶 Richtpreis · ca. …". Hier stand
  // bis 08/2026 ein blanker Eurobetrag unmittelbar über dem Button „Bei Gaißmayer ansehen",
  // was sich unweigerlich als Preis des verlinkten Angebots liest. Die Zahlen bleiben — für
  // die Budgetplanung sind sie der Sinn der Seite —, aber sie sagen jetzt, was sie sind.
  // gesamtkosten_geschaetzt kommt je nach Aufrufer in zwei Formaten, und BEIDE müssen stimmen:
  //   /plan/:id   → rohe JS-Zahl aus dem Browser-reduce, oft mit Fließkomma-Rest
  //                 (474.59999999999997 liegt dreimal echt in geteilte_plaene)
  //   /beispiel/… → eingefrorener Modell-String, mal mit, mal ohne Euro-Zeichen
  //                 ("179.50€" gegen "406.5")
  // Der frühere Code hatte nur den Zahl-Zweig und zeigte deshalb auf fünf von acht
  // Beispielseiten live "179.50€ €". Eine reine String-Auswertung wäre der umgekehrte Fehler:
  // aus 474.59999999999997 würde "47460000000000000 €", weil die 14 Nachkommastellen wie
  // Tausendergruppen aussehen. Also erst der Typ, dann die Zeichenkette.
  const kostenWert = plan.gesamtkosten_geschaetzt;
  let kostenZahl;
  if (typeof kostenWert === 'number') {
    kostenZahl = kostenWert;
  } else {
    // Trennzeichen am Rand stammen aus Wörtern, nicht aus der Zahl: "ca. 180" hinterlässt
    // beim Filtern ".180" und würde sonst als 0,18 gelesen. Ebenso "180,-" → "180,".
    const roh = String(kostenWert ?? '').replace(/[^\d.,]/g, '').replace(/^[.,]+/, '').replace(/[.,]+$/, '');
    if (/^\d{1,3}(?:[.,]\d{3})+$/.test(roh)) {
      // Nur Tausendergruppen, keine Nachkommastelle: "1.234" → 1234
      kostenZahl = Number(roh.replace(/[.,]/g, ''));
    } else {
      // Letztes Trennzeichen ist die Dezimalstelle, davor stehende sind Tausendertrenner:
      // "179.50" → 179.5, "1.234,50" → 1234.5
      const i = Math.max(roh.lastIndexOf('.'), roh.lastIndexOf(','));
      kostenZahl = Number(i < 0 ? roh : roh.slice(0, i).replace(/[.,]/g, '') + '.' + roh.slice(i + 1));
    }
  }
  const kostenText = Number.isFinite(kostenZahl) && kostenZahl > 0 ? `${Math.round(kostenZahl)} €` : '–';
  const meta = `<div class="em-bar">
    <div class="em-item"><strong>${pflanzen.length}</strong> Pflanzenarten</div>
    <div class="em-item"><strong>${gesamt}</strong> Pflanzen gesamt</div>
    <div class="em-item"><strong>${escHtml(kostenText)}</strong> Richtpreis gesamt</div>
  </div>
  <p style="font-size:.78rem;color:#888;line-height:1.5;margin:-16px 0 20px">Alle Beträge sind Richtwerte zur Budgetplanung — nicht die Preise der verlinkten Gärtnerei.</p>`;

  const cards = pflanzen.map((p, i) => {
    const c = bloomColorSSR(p.farbe);
    const cLight = hexLightenSSR(c, 40);
    const farbenTag = p.farbe
      ? `<span class="tag" style="background:${hexLightenSSR(c,50)};color:${hexDarkenSSR(c,40)}">${escHtml(p.farbe)}</span>` : '';
    const st = Math.max(0, Math.min(Math.floor(Number(p.pflege_sterne) || 1), 3));
    const stars = '★'.repeat(st) + '☆'.repeat(3 - st);
    const preis = ((p.preis_stueck_eur||0) * (p.stueckzahl||1)).toFixed(2);
    const imgTop = p.bild_url
      ? `<img src="${escHtml(safeUrl(p.bild_url))}" alt="${escHtml(p.name_deutsch)}" style="width:100%;height:100%;object-fit:cover;display:block" loading="lazy">`
      : `<div style="font-size:2.2rem;display:flex;align-items:center;justify-content:center;height:100%">${emojis[i%10]}</div>`;
    const kaufHref = p.name_botanisch ? goLink(p.name_botanisch) : safeUrl(p.kauflink || '/');
    return `<div class="pflanze-card">
      <div class="pflanze-card-top" style="background:linear-gradient(135deg,${cLight},${c})">${imgTop}</div>
      <div class="pflanze-card-body">
        <div class="pflanze-name">${escHtml(p.name_deutsch)}</div>
        <div class="pflanze-botanisch">${escHtml(p.name_botanisch||'')}</div>
        <div class="pflanze-beschreibung">${escHtml(p.beschreibung||'')}</div>
        <div class="pflanze-tags">
          <span class="tag">☀️ ${escHtml(p.standort||'')}</span>
          <span class="tag">🌸 ${escHtml(p.bluehzeit||'')}</span>
          ${farbenTag}
          <span class="tag tag-erde">↕ ${escHtml(String(p.hoehe_cm||'?'))} cm</span>
          <span class="tag tag-stueck">× ${escHtml(String(p.stueckzahl||1))} Stück</span>
        </div>
        <div class="pflanze-preis">
          <span>Pflege: <span class="pflege-sterne">${stars}</span></span>
          <span>Richtpreis <strong>ca. ${preis} €</strong></span>
        </div>
        <a class="btn-kaufen" href="${escHtml(kaufHref)}" target="_blank" rel="noopener nofollow" data-kauf="${escHtml(p.name_botanisch || p.name_deutsch || '')}" data-quelle="${escHtml(quelle)}">Bei Gaißmayer ansehen ↗</a>
        <div style="text-align:center;font-size:.7rem;color:#999;margin-top:4px;line-height:1.4">Staudengärtnerei Gaißmayer · öffnet in neuem Tab</div>
      </div>
    </div>`;
  }).join('');

  const kal = Object.entries(plan.pflanzkalender || {}).map(([jz, items]) => {
    const icon = jez[jz] || '📅';
    const liItems = (Array.isArray(items) ? items : [items]).map(it => `<li>${escHtml(String(it))}</li>`).join('');
    return `<div class="kalender-card"><h4>${icon} ${escHtml(jz)}</h4><ul>${liItems}</ul></div>`;
  }).join('');

  const tippsAll = (plan.tipps||[]).concat(plan.pflanzabstand_hinweis ? [plan.pflanzabstand_hinweis] : []);
  const tippsList = tippsAll.map(t => `<li>${escHtml(String(t))}</li>`).join('');

  const grafisch = flaeche ? renderGrafischSSR(pflanzen, flaeche, grafikOpts) : '';

  // Giftige Arten im geteilten Plan. Der Befund wird hier NEU berechnet statt aus dem
  // gespeicherten Plan gelesen: Pläne, die vor dem 08.08.2026 geteilt wurden, tragen das
  // Feld nicht — sie bekommen die Warnung so trotzdem. Der Empfänger eines geteilten Links
  // hat den Plan nicht selbst erstellt und kennt die Pflanzen oft nicht.
  const giftListe = pflanzen.map(p => ({ p, g: giftigkeit(p.name_botanisch) })).filter(x => x.g);
  let giftBlock = '';
  if (giftListe.length) {
    const nachStufe = {};
    giftListe.forEach(x => (nachStufe[x.g.stufe] = nachStufe[x.g.stufe] || []).push(x));
    giftBlock = `<div style="margin:12px 0;padding:12px 14px;background:#fef2f2;border:1px solid #fca5a5;border-radius:8px;font-size:.85rem;line-height:1.6;color:#991b1b">`
      + GIFT_REIHENFOLGE.filter(s => nachStufe[s]).map(s => {
        const arten = nachStufe[s].map(x => escHtml(x.p.name_deutsch)).join(', ');
        // Der Erklärtext kommt aus der kuratierten Liste, nicht aus eigener Formulierung:
        // „katzen" heißt lebensgefährlich durch Nierenversagen, „reizend" betrifft die Haut —
        // eine Sammelformulierung würde beides zu „nicht in den Mund nehmen" verflachen.
        const text = escHtml(nachStufe[s][0].g.text.split('. ').slice(0, 2).join('. '));
        return `<strong>${GIFT_LABEL[s]}:</strong> ${arten}. ${text}`;
      }).join('<br>')
      + `</div>`;
  }

  return `<div class="card-wrap">
    <h2 class="sec-title">🌿 KI-Pflanzplan für dieses Beet</h2>
    ${meta}
    ${giftBlock}
    ${grafisch}
    <p class="sec-title" style="font-size:.95rem;margin-top:8px">Pflanzenauswahl</p>
    <div class="pflanzen-grid">${cards}</div>
    ${kal ? `<p class="sec-title" style="font-size:.95rem">Jahreskalender</p><div class="kalender-grid">${kal}</div>` : ''}
    ${tippsList ? `<p class="sec-title" style="font-size:.95rem">Pflegetipps</p><ul class="tipps-list">${tippsList}</ul>` : ''}
    ${plan.beetbeschreibung ? `<p style="color:#444;line-height:1.75;font-size:.92rem;margin-top:16px;padding-top:16px;border-top:1px solid #eee">${escHtml(plan.beetbeschreibung)}</p>` : ''}
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

  const breadcrumb = escJsonLd({
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
@media(max-width:600px){.vl-bluehzeit{display:none}}
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

  ${renderBeispielPlanSSR(plan, b.flaeche, undefined, 'beispielbeet')}

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

// ─── Admin-Auth per signiertem Session-Cookie (kein Passwort mehr in der URL) ──
const ADMIN_COOKIE = 'sp_admin';
const ADMIN_TTL_MS = 7 * 24 * 3600 * 1000;
const adminSecret = () => process.env.ADMIN_PASSWORT || 'kein-admin-passwort-gesetzt';
function signAdminToken() {
  const payload = `admin.${Date.now() + ADMIN_TTL_MS}`;
  const sig = crypto.createHmac('sha256', adminSecret()).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}
function verifyAdminToken(token) {
  if (typeof token !== 'string' || token.length < 10) return false;
  const i = token.lastIndexOf('.');
  if (i < 1) return false;
  const payload = token.slice(0, i), sig = token.slice(i + 1);
  const expected = crypto.createHmac('sha256', adminSecret()).update(payload).digest('base64url');
  const a = Buffer.from(sig), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  const exp = parseInt(payload.split('.')[1], 10);
  return Number.isFinite(exp) && exp > Date.now();
}
function parseCookies(header) {
  const out = {};
  (header || '').split(';').forEach(part => {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}
// Reine Prüfung ohne Response-Seiteneffekt (Seiten-Routen leiten auf /admin/login um).
function isAdmin(req) {
  return verifyAdminToken(parseCookies(req.headers.cookie)[ADMIN_COOKIE]);
}
// Für API-Routen: prüft und antwortet bei Fehlschlag mit 401.
function checkAdminPw(req, res) {
  if (!isAdmin(req)) {
    res.status(401).json({ error: 'Nicht angemeldet.' });
    return false;
  }
  return true;
}

// Login-Seite
app.get('/admin/login', (req, res) => {
  const next = typeof req.query.next === 'string' && /^\/admin[a-z/-]*$/i.test(req.query.next)
    ? req.query.next : '/admin/anfragen';
  res.send(`<!DOCTYPE html><html lang="de"><head><meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
  <title>Admin-Login · Staudenplan</title>
  <style>body{font-family:'Segoe UI',system-ui,sans-serif;background:#f8f4ef;color:#1a1a1a;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
  .box{background:#fff;border-radius:16px;padding:32px 28px;box-shadow:0 8px 32px rgba(0,0,0,.12);width:320px;max-width:90vw}
  h1{font-size:1.2rem;color:#1b4332;margin:0 0 6px}p{color:#888;font-size:.85rem;margin:0 0 18px}
  input{width:100%;box-sizing:border-box;padding:12px 14px;border:2px solid #e0d9cf;border-radius:10px;font-size:1rem;outline:none}
  input:focus{border-color:#2d6a4f}button{width:100%;margin-top:12px;background:linear-gradient(135deg,#2d6a4f,#1b4332);color:#fff;border:none;border-radius:12px;padding:13px;font-size:1rem;font-weight:700;cursor:pointer}
  .err{color:#e53e3e;font-size:.82rem;min-height:18px;margin-top:8px}</style></head><body>
  <form class="box" onsubmit="return doLogin(event)">
    <h1>🌿 Admin-Login</h1><p>Bitte Admin-Passwort eingeben.</p>
    <input type="password" id="pw" placeholder="Passwort" autofocus autocomplete="current-password">
    <button type="submit">Anmelden</button>
    <div class="err" id="err"></div>
  </form>
  <script>
    async function doLogin(e){
      e.preventDefault();
      const err=document.getElementById('err');err.textContent='';
      const r=await fetch('/admin/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({pw:document.getElementById('pw').value})});
      if(r.ok){location.href=${JSON.stringify(next)};}else{err.textContent='Falsches Passwort.';}
      return false;
    }
  </script>
  </body></html>`);
});

// Login prüfen → signiertes Cookie setzen (timing-safe Passwortvergleich, rate-limited)
const loginLimiter = rl({ windowMs: 15 * 60 * 1000, max: 10, message: { error: 'Zu viele Versuche.' } });
app.post('/admin/login', loginLimiter, (req, res) => {
  const pw = (req.body && typeof req.body.pw === 'string') ? req.body.pw : '';
  const expected = process.env.ADMIN_PASSWORT || '';
  const a = Buffer.from(pw), b = Buffer.from(expected);
  const ok = expected.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b);
  if (!ok) return res.status(401).json({ error: 'Falsches Passwort.' });
  res.cookie(ADMIN_COOKIE, signAdminToken(), {
    httpOnly: true, secure: req.secure, sameSite: 'lax', maxAge: ADMIN_TTL_MS, path: '/',
  });
  res.json({ success: true });
});

// Logout
app.get('/admin/logout', (req, res) => {
  res.clearCookie(ADMIN_COOKIE, { path: '/' });
  res.redirect('/admin/login');
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

// Globaler Error-Handler: verhindert rohe HTML-Fehlerseiten (die das Frontend als
// „Generierungsfehler" zeigt). PayloadTooLarge → 413-JSON; jeder uncaught Fehler in
// einer Route → sauberes 500-JSON + Log (mit Pfad, damit die Ursache auffindbar ist).
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err && (err.type === 'entity.too.large' || err.status === 413)) {
    return res.status(413).json({ error: 'Anfrage zu groß.' });
  }
  console.error(`Unbehandelter Fehler bei ${req.method} ${req.originalUrl}:`, err && (err.stack || err.message));
  res.status(500).json({ error: 'Serverfehler. Bitte versuche es erneut.' });
});

// ─── Start ────────────────────────────────────────────────────────────────────

const server = app.listen(PORT, async () => {
  const pflanzenN = db.prepare("SELECT COUNT(*) as n FROM pflanzen WHERE name_deutsch != 'Test-Pflanze'").get().n;
  let wissenN = 0;
  try { wissenN = db.prepare('SELECT COUNT(*) as n FROM wissen').get().n; } catch {}
  console.log(`Stauden-Portal läuft auf http://localhost:${PORT}`);
  console.log(`Datenbank: ${pflanzenN} Pflanzen, ${wissenN} Wissens-Einträge`);

  // IndexNow: alle URLs bei Bing einreichen. Nur wenn SITE_URL gesetzt ist (also in
  // Produktion) — sonst meldet ein lokaler Testlauf den Inhalt der Entwickler-Datenbank
  // unter der Produktions-Domain an und schickt Bing URLs, die live gar nicht existieren.
  const BASE = process.env.SITE_URL;
  if (!BASE) {
    console.log('IndexNow: übersprungen (SITE_URL nicht gesetzt — kein Produktionsbetrieb)');
    return;
  }
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

// ─── Fehler-Sicherheitsnetz + Graceful Shutdown ───────────────────────────────
// Log-only (kein forcierter Exit): ein einzelner async-Fehler soll nicht alle
// Nutzer treffen; better-sqlite3 ist synchron/crashsicher, pm2 fängt echte Crashes.
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled Rejection:', reason instanceof Error ? reason.stack || reason.message : reason);
});
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err.stack || err.message);
});
function shutdown(signal) {
  console.log(`${signal} empfangen — fahre sauber herunter.`);
  server.close(() => { try { db.close(); } catch {} process.exit(0); });
  setTimeout(() => process.exit(0), 8000).unref(); // Notausstieg falls Verbindungen hängen
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
