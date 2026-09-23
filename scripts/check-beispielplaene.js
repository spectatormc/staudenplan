/*
 * PRÜFUNG: Halten die acht veröffentlichten Beispielpläne die Regeln ein, die der Planer
 * seinen Kunden seit dem 23.09.2026 vorrechnet?
 *
 * ANLASS: Mit scripts/plan-pruefen.js sagt die Seite jedem Planer-Kunden, wenn eine Art höher
 * wird als drei Viertel der kürzesten Beetkante oder zu viele Arten auf der Fläche stehen.
 * Die acht Beispielseiten (/beispiel/:slug) sind eingefroren und laufen an dieser Prüfung
 * vorbei — sie entstanden lange davor. Eine Marketingseite, die zeigt, was der Planer
 * beanstandet, ist ein Widerspruch in eigener Sache.
 *
 * WARUM DIE FACHWERTE AUS DER DATENBANK KOMMEN, nicht aus dem JSON:
 * Die eingefrorenen Dateien führen nur `hoehe_cm` — den GEMITTELTEN Wert aus Mindest- und
 * Endhöhe. Sie haben weder `hoehe_cm_max` noch `feuchtigkeit` noch `lebensbereich`. Ein Lauf
 * über das JSON allein würde drei der sechs Regeln stillschweigend überspringen und „keine
 * Befunde" melden — das sähe aus wie ein Freispruch und wäre ein blinder Fleck. Deshalb wird
 * jede Art in der Datenbank nachgeschlagen, genau wie /api/plan es tut.
 *
 * WARUM DIE FLÄCHEN AUS stauden-server.js GELESEN WERDEN:
 * Dort steht die Tabelle BEISPIELE, aus der die Seiten gebaut werden. Eine zweite Liste hier
 * wäre eine zweite Wahrheit, und die läuft irgendwann weg. Findet der Parser nicht alle acht
 * Einträge, bricht der Lauf ab, statt weniger zu prüfen und zu bestehen.
 *
 * Aufrufen:  node scripts/check-beispielplaene.js
 * Rückgabe:  0 = kein harter Befund · 1 = mindestens einer (oder die Prüfung lief nicht)
 */
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { planPruefen } = require('./plan-pruefen');

const WURZEL = path.join(__dirname, '..');

/* Slug → Fläche aus der Tabelle BEISPIELE im Server. Bewusst eng: Erst der Block, dann je
 * Eintrag slug und flaeche in der Reihenfolge, in der sie dort stehen. */
function beispieleLesen() {
  const quelle = fs.readFileSync(path.join(WURZEL, 'stauden-server.js'), 'utf8');
  const start = quelle.indexOf('const BEISPIELE = [');
  if (start < 0) throw new Error('BEISPIELE nicht in stauden-server.js gefunden');
  const block = quelle.slice(start, quelle.indexOf('\n];', start));
  const eintraege = [];
  const re = /slug: '([^']+)'[\s\S]*?flaeche: ([0-9.]+)/g;
  let m;
  while ((m = re.exec(block))) eintraege.push({ slug: m[1], flaeche: Number(m[2]) });
  return eintraege;
}

const beispiele = beispieleLesen();
if (beispiele.length < 8) {
  console.error(`FEHLER: nur ${beispiele.length} Beispiele aus stauden-server.js gelesen (erwartet: mindestens 8).`);
  console.error('Der Parser passt nicht mehr zur Tabelle. Ein Lauf ueber weniger Seiten waere kein bestandener Lauf.');
  process.exit(1);
}

const db = new Database(process.env.DB_PFAD || path.join(WURZEL, 'stauden.db'), { readonly: true });
const zeilenZahl = db.prepare('SELECT COUNT(*) AS n FROM pflanzen').get().n;
if (zeilenZahl < 400) {
  console.error(`FEHLER: nur ${zeilenZahl} Zeilen in der Datenbank — das ist nicht der Produktionsbestand.`);
  console.error('Die Arbeitskopie ist ein alter Teilstand; ohne die Fachwerte findet diese Pruefung nichts.');
  console.error('Auf dem Server im Deploy-Verzeichnis laufen lassen.');
  process.exit(1);
}

/* Nachschlag wie in /api/plan: erst exakt, dann auf Artebene (Gattung + Art), damit eine
 * Sortenangabe wie "Miscanthus sinensis 'Silberfeder'" die Werte der Art bekommt. Ein reiner
 * Gattungstreffer zaehlt NICHT — sonst erbte eine Art die Endhoehe einer fremden Schwester. */
const exakt = db.prepare('SELECT hoehe_cm_max, feuchtigkeit, lebensbereich FROM pflanzen WHERE name_botanisch = ?');
const artweise = db.prepare("SELECT hoehe_cm_max, feuchtigkeit, lebensbereich FROM pflanzen WHERE name_botanisch = ? OR name_botanisch LIKE ? ORDER BY LENGTH(name_botanisch) LIMIT 1");
function fachwerte(nameBot) {
  const name = String(nameBot || '').trim();
  if (!name) return null;
  const treffer = exakt.get(name);
  if (treffer) return treffer;
  const teile = name.split(/\s+/);
  if (teile.length < 2) return null;                       // reine Gattung: kein Artbezug
  const art = `${teile[0]} ${teile[1]}`;
  return artweise.get(art, `${art} %`) || null;
}

let hartGesamt = 0, ohneFachwerte = 0;
console.log('\n--- Pruefung: halten die Beispielplaene die Planerregeln ein? ---');
console.log(`Datenbank: ${db.name} (${zeilenZahl} Zeilen)\n`);

for (const { slug, flaeche } of beispiele) {
  const datei = path.join(WURZEL, 'scripts', `beispiel-plan-${slug}.json`);
  if (!fs.existsSync(datei)) { console.log(`FEHLT        ${slug}: ${path.basename(datei)}`); hartGesamt++; continue; }
  const roh = JSON.parse(fs.readFileSync(datei, 'utf8'));
  const pflanzen = (roh.pflanzen || []).map(p => {
    const f = fachwerte(p.name_botanisch);
    if (!f) ohneFachwerte++;
    return {
      name_deutsch: p.name_deutsch, name_botanisch: p.name_botanisch,
      rolle: p.rolle, stueckzahl: p.stueckzahl,
      // Wie im Server: der DB-Wert, sonst die gemittelte Hoehe aus der Datei.
      hoehe_cm_max: f && f.hoehe_cm_max != null ? f.hoehe_cm_max : p.hoehe_cm,
      feuchtigkeit: (f && f.feuchtigkeit) || null,
      lebensbereich: (f && f.lebensbereich) || null,
    };
  });

  // Die Beispielseiten nennen eine Flaeche, keine Kantenlaengen — die Pruefung nimmt also
  // ein Quadrat an, wie der Planer ohne L×B-Angabe auch.
  const ergebnis = planPruefen({ pflanzen }, { gartenflaeche: flaeche });
  const hart = ergebnis.befunde.filter(b => b.schwere === 'hart');
  const weich = ergebnis.befunde.filter(b => b.schwere === 'weich');
  hartGesamt += hart.length;

  const marke = hart.length ? 'BEFUND     ' : 'ok         ';
  console.log(`${marke}  ${slug} (${flaeche} m², ${pflanzen.length} Arten)`);
  for (const b of hart)  console.log(`             hart   ${b.regel}: ${b.text}`);
  for (const b of weich) console.log(`             weich  ${b.regel}: ${b.text}`);
}

if (ohneFachwerte) {
  console.log(`\nHinweis: ${ohneFachwerte} Art(en) aus den Beispieldateien stehen nicht in der Datenbank.`);
  console.log('Fuer sie galt nur die gemittelte Hoehe aus der Datei; Feuchte und Lebensbereich blieben leer.');
}

console.log(`\nHarte Befunde ueber alle Beispielseiten: ${hartGesamt}`);
if (hartGesamt) {
  console.log('Diese Seiten zeigen, was der Planer seinen Kunden beanstandet. Entweder die');
  console.log('ausgewiesene Flaeche anheben oder die beanstandete Art aus dem Plan nehmen.');
}
db.close();
process.exit(hartGesamt ? 1 : 0);
