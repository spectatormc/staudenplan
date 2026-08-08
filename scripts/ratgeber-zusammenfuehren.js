/*
 * Führt doppelte Ratgeber-Artikel zusammen.
 *
 * Eingabe ist eine JSON-Datei mit einer Liste von Einträgen. Drei Formen:
 *   { gewinner_slug, verlierer_slugs: [...], neuer_titel?, fusionstext? }
 *       Zusammenführung: der Gewinner bekommt den Fusionstext (und ggf. einen korrigierten
 *       Titel), die Verlierer werden gelöscht.
 *   { gewinner_slug, neuer_titel, fusionstext? }   (ohne verlierer_slugs)
 *       Reine Umbenennung. Ändert sich dabei der Slug, wird die alte URL weitergeleitet.
 *   { loeschen: [...], ziel_seite: '/pfad' }
 *       Löschung mit Weiterleitung auf eine Seite außerhalb des Ratgebers — etwa eine
 *       SEO-Landingpage, die dasselbe Keyword bedient und im Servercode steht.
 *
 * Die Weiterleitungen gehören in RATGEBER_ALIASE bzw. RATGEBER_ZU_SEITE in
 * stauden-server.js — dieses Skript gibt sie am Ende fertig aus, setzt sie aber NICHT
 * selbst, damit die Umleitungen im Code nachvollziehbar bleiben.
 *
 *   node scripts/ratgeber-zusammenfuehren.js <plan.json> [--anwenden]
 *
 * Ohne --anwenden läuft nur die Vorschau (Trockenlauf), es wird nichts geschrieben.
 *
 * `wissen` ist eine FTS5-Tabelle mit eigenem Inhalt; UPDATE und DELETE über rowid sind
 * dort regulär möglich, der Suchindex wird dabei mitgeführt.
 */
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const planPfad = process.argv[2];
const anwenden = process.argv.includes('--anwenden');
if (!planPfad) {
  console.error('Aufruf: node scripts/ratgeber-zusammenfuehren.js <plan.json> [--anwenden]');
  process.exit(1);
}

const dbPfad = process.env.DB_PFAD || path.join(__dirname, '..', 'stauden.db');
const db = new Database(dbPfad);
const plan = JSON.parse(fs.readFileSync(planPfad, 'utf8'));

// Muss zeichengleich zu slugify() in stauden-server.js sein, sonst zeigen die
// erzeugten Weiterleitungen auf URLs, die es gar nicht gibt.
const slugify = (s) => s.toLowerCase()
  .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

const alle = db.prepare('SELECT rowid, titel, inhalt FROM wissen').all();
const nachSlug = new Map(alle.map(r => [slugify(r.titel), r]));

const aliase = [];
const seitenAliase = [];
const fehler = [];
let geaendert = 0, geloescht = 0;

for (const eintrag of plan) {
  // Löschung mit Ziel außerhalb des Ratgebers (Landingpage).
  if (Array.isArray(eintrag.loeschen)) {
    if (!eintrag.ziel_seite || !eintrag.ziel_seite.startsWith('/')) {
      fehler.push(`ziel_seite fehlt oder ist kein Pfad: ${JSON.stringify(eintrag.loeschen)}`); continue;
    }
    console.log(`\n→ ${eintrag.ziel_seite}   (Seite außerhalb des Ratgebers)`);
    for (const s of eintrag.loeschen) {
      const v = nachSlug.get(s);
      if (!v) { fehler.push(`Zu löschender Artikel nicht gefunden: ${s}`); continue; }
      console.log(`  löschen:    ${s}  (${v.inhalt.length} Zeichen)`);
      seitenAliase.push([s, eintrag.ziel_seite]);
      if (anwenden) { db.prepare('DELETE FROM wissen WHERE rowid = ?').run(v.rowid); geloescht++; }
    }
    continue;
  }

  const { gewinner_slug, verlierer_slugs = [], neuer_titel, fusionstext } = eintrag;
  const gewinner = nachSlug.get(gewinner_slug);
  if (!gewinner) { fehler.push(`Gewinner nicht gefunden: ${gewinner_slug}`); continue; }

  const zielSlug = neuer_titel ? slugify(neuer_titel) : gewinner_slug;
  if (neuer_titel && zielSlug !== gewinner_slug) {
    // Titeländerung verschiebt die URL — die alte muss selbst weitergeleitet werden.
    aliase.push([gewinner_slug, zielSlug]);
  }

  console.log(`\n${gewinner_slug}`);
  if (neuer_titel) console.log(`  Titel neu:  ${neuer_titel}${zielSlug !== gewinner_slug ? '   (URL ändert sich → ' + zielSlug + ')' : '   (URL bleibt)'}`);
  if (fusionstext) console.log(`  Inhalt:     ${gewinner.inhalt.length} → ${fusionstext.length} Zeichen`);

  for (const vs of verlierer_slugs) {
    const v = nachSlug.get(vs);
    if (!v) { fehler.push(`Verlierer nicht gefunden: ${vs}`); continue; }
    if (v.rowid === gewinner.rowid) { fehler.push(`Verlierer ist der Gewinner: ${vs}`); continue; }
    console.log(`  löschen:    ${vs}  (${v.inhalt.length} Zeichen)`);
    aliase.push([vs, zielSlug]);
    if (anwenden) { db.prepare('DELETE FROM wissen WHERE rowid = ?').run(v.rowid); geloescht++; }
  }

  if (anwenden && (fusionstext || neuer_titel)) {
    db.prepare('UPDATE wissen SET titel = ?, inhalt = ? WHERE rowid = ?')
      .run(neuer_titel || gewinner.titel, fusionstext || gewinner.inhalt, gewinner.rowid);
    geaendert++;
  }
}

if (fehler.length) {
  console.log('\n=== FEHLER ===');
  fehler.forEach(f => console.log('  ' + f));
}

console.log(`\n=== ${anwenden ? 'ANGEWANDT' : 'TROCKENLAUF'} ===`);
console.log(`Artikel geändert: ${geaendert}, gelöscht: ${geloescht}, Artikel jetzt: ${db.prepare('SELECT COUNT(*) n FROM wissen').get().n}`);

if (aliase.length) {
  console.log('\n=== Für RATGEBER_ALIASE in stauden-server.js ===');
  const breite = Math.max(...aliase.map(([a]) => a.length), 0);
  aliase.sort((a, b) => a[0].localeCompare(b[0]))
    .forEach(([von, nach]) => console.log(`  '${von}':${' '.repeat(breite - von.length)} '${nach}',`));
}

if (seitenAliase.length) {
  console.log('\n=== Für RATGEBER_ZU_SEITE in stauden-server.js ===');
  const breite2 = Math.max(...seitenAliase.map(([a]) => a.length), 0);
  seitenAliase.sort((a, b) => a[0].localeCompare(b[0]))
    .forEach(([von, nach]) => console.log(`  '${von}':${' '.repeat(breite2 - von.length)} '${nach}',`));
}

if (fehler.length) process.exit(1);
