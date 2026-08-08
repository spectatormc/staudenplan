/*
 * Prüft RATGEBER_ALIASE und SLUG_ALIASE in stauden-server.js gegen die Datenbank.
 *
 * Drei Fehlerklassen, die beim Zusammenführen von Artikeln entstehen können:
 *   1. Ziel existiert nicht  → die Weiterleitung landet auf einer 404.
 *   2. Weiterleitungskette   → das Ziel ist selbst wieder ein Alias (301 auf 301).
 *      Google folgt Ketten zwar, wertet sie aber ab und crawlt sie seltener.
 *   3. Quelle existiert noch → der Alias verdeckt einen echten Artikel.
 *
 *   node scripts/check-ratgeber-aliase.js
 *
 * Beendet sich mit exit(1), sobald ein Fehler gefunden wird — so kann der Aufruf in
 * einem Deploy-Schritt hängen, ohne dass jemand die Ausgabe lesen muss.
 */
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const dbPfad = process.env.DB_PFAD || path.join(__dirname, '..', 'stauden.db');
const serverPfad = path.join(__dirname, '..', 'stauden-server.js');
const src = fs.readFileSync(serverPfad, 'utf8');
const db = new Database(dbPfad, { readonly: true });

const slugify = (s) => s.toLowerCase()
  .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

// Den Objektliteral-Block aus dem Quelltext holen, statt den Server zu starten:
// so lässt sich die Prüfung auch gegen eine Datenbankkopie fahren.
function aliasBlock(name) {
  const start = src.indexOf(`const ${name} = Object.assign(Object.create(null), {`);
  if (start < 0) throw new Error(`${name} nicht gefunden`);
  const open = src.indexOf('{', src.indexOf('Object.create(null),', start));
  let tiefe = 0, i = open;
  for (; i < src.length; i++) {
    if (src[i] === '{') tiefe++;
    else if (src[i] === '}') { tiefe--; if (tiefe === 0) break; }
  }
  return eval('(' + src.slice(open, i + 1) + ')');
}

const faelle = [
  { name: 'RATGEBER_ALIASE', pfad: '/ratgeber/',
    vorhanden: new Set(db.prepare('SELECT titel FROM wissen').all().map(r => slugify(r.titel))) },
  { name: 'SLUG_ALIASE', pfad: '/pflanze/',
    vorhanden: new Set(db.prepare('SELECT name_botanisch FROM pflanzen').all().map(r => slugify(r.name_botanisch))) },
];

let fehler = 0;
for (const f of faelle) {
  const aliase = aliasBlock(f.name);
  const quellen = new Set(Object.keys(aliase));
  console.log(`\n=== ${f.name} — ${quellen.size} Weiterleitungen, ${f.vorhanden.size} Artikel/Pflanzen ===`);
  for (const [von, nach] of Object.entries(aliase)) {
    if (!f.vorhanden.has(nach)) {
      console.log(`  ZIEL FEHLT:     ${f.pfad}${von}  →  ${nach}`); fehler++;
    }
    if (quellen.has(nach)) {
      console.log(`  KETTE:          ${f.pfad}${von}  →  ${nach}  →  ${aliase[nach]}`); fehler++;
    }
    if (f.vorhanden.has(von)) {
      console.log(`  QUELLE LEBT:    ${f.pfad}${von} existiert noch, die Weiterleitung verdeckt sie`); fehler++;
    }
  }
  if (!fehler) console.log('  alle Ziele vorhanden, keine Ketten, keine verdeckten Artikel');
}

// RATGEBER_ZU_SEITE führt aus dem Ratgeber heraus auf eine Landingpage. Quellen davon
// dürfen — wie bei RATGEBER_ALIASE — nicht mehr als Artikel existieren.
const wissenSlugs = faelle[0].vorhanden;
const ratgeberAliase = aliasBlock('RATGEBER_ALIASE');
const zuSeite = aliasBlock('RATGEBER_ZU_SEITE');
console.log(`\n=== RATGEBER_ZU_SEITE — ${Object.keys(zuSeite).length} Weiterleitungen auf Landingpages ===`);
for (const [von, nach] of Object.entries(zuSeite)) {
  if (wissenSlugs.has(von)) { console.log(`  QUELLE LEBT:    /ratgeber/${von} existiert noch, die Weiterleitung verdeckt sie`); fehler++; }
  if (ratgeberAliase[von]) { console.log(`  DOPPELT:        /ratgeber/${von} steht auch in RATGEBER_ALIASE`); fehler++; }
  if (!nach.startsWith('/') || nach.startsWith('/ratgeber/')) { console.log(`  ZIEL UNGÜLTIG:  ${von} → ${nach} (erwartet: Pfad oberster Ebene)`); fehler++; }
}
if (!Object.keys(zuSeite).length) console.log('  (keine)');

// Hartkodierte Ratgeber-Links im Servercode dürfen nicht auf Weiterleitungen zeigen:
// interne Links sollen direkt auf das Ziel gehen, sonst verschenkt jede Seite einen Hop.
const hartkodiert = [...new Set((src.match(/\/ratgeber\/[a-z0-9-]{6,}/g) || []))].map(s => s.replace('/ratgeber/', ''));
console.log(`\n=== Hartkodierte Ratgeber-Links im Servercode — ${hartkodiert.length} ===`);
let hartFehler = 0;
for (const s of hartkodiert) {
  if (ratgeberAliase[s]) { console.log(`  ZEIGT AUF WEITERLEITUNG: /ratgeber/${s}  →  /ratgeber/${ratgeberAliase[s]}`); hartFehler++; }
  else if (zuSeite[s]) { console.log(`  ZEIGT AUF WEITERLEITUNG: /ratgeber/${s}  →  ${zuSeite[s]}`); hartFehler++; }
  else if (!wissenSlugs.has(s)) { console.log(`  TOTER LINK:              /ratgeber/${s}`); hartFehler++; }
}
fehler += hartFehler;
if (!hartFehler) console.log('  alle zeigen direkt auf existierende Artikel');

console.log(fehler ? `\n${fehler} PROBLEME` : '\nALLES IN ORDNUNG');
process.exit(fehler ? 1 : 0);
