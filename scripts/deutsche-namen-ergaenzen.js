/*
 * Trägt deutsche Namen bei den Arten nach, die bisher nur ihre Gattung im Feld
 * name_deutsch stehen hatten — und korrigiert einen Grammatikfehler.
 *
 *   node scripts/deutsche-namen-ergaenzen.js              nur zeigen, nichts ändern
 *   node scripts/deutsche-namen-ergaenzen.js --anwenden   schreiben
 *
 * Aufgefallen beim Bau der Pinterest-Pins: Neun Arten trugen als deutschen Namen ihre
 * Gattung, ein Pin las sich dann „Muhlenbergia · Muhlenbergia capillaris". Sie waren
 * deshalb aus allen Pin-Sorten ausgeschlossen (siehe scripts/pin-layout.js).
 *
 * ACHT DER NEUN NAMEN STANDEN BEREITS IN DER DATENBANK — in der eigenen Beschreibung der
 * Pflanze („auch als Buschklee bekannt") oder als Konvention bei den Geschwistern derselben
 * Gattung. Nichts davon ist erfunden; die Herkunft steht bei jedem Eintrag. Nur bei Moltkia
 * petraea gab weder Beschreibung noch Gattung etwas her, der Name ist extern belegt.
 *
 * Das ist dasselbe Muster wie bei der Giftwarnung: Die Angabe war da, sie kam nur im
 * Ausgabepfad nie an.
 */
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const WURZEL = path.join(__dirname, '..');

/*
 * `botanisch` ist kein Beiwerk, sondern die Sicherung: Die id allein würde bei einer
 * verschobenen Datenbank die falsche Pflanze umbenennen. Stimmt der botanische Name nicht,
 * bricht das Skript ab, statt still etwas Falsches zu schreiben.
 */
const NAMEN = [
  { id: 205, botanisch: "Astilbe chinensis 'Pumila'", neu: 'Zwerg-Prachtspiere',
    quelle: 'Gattungskonvention in der Datenbank (Astilbe = Prachtspiere, Astilbe chinensis = Chinesische Prachtspiere) und die eigene Beschreibung „Niedrige Astilbe", 30 cm' },
  { id: 330, botanisch: 'Lespedeza thunbergii', neu: 'Buschklee',
    quelle: 'eigene Beschreibung: „auch als Buschklee bekannt"' },
  { id: 353, botanisch: 'Ligularia stenocephala', neu: 'Schmalkopf-Goldkolben',
    quelle: 'Gattungskonvention (Ligularia dentata = Gezähnter Goldkolben). NICHT „Schmalkopf-Ligularie" — den Namen trägt bereits die Sorte ‚The Rocket‘ (id 354), zwei gleiche Namen wären schlechter als gar keiner' },
  { id: 368, botanisch: 'Lamium orvala', neu: 'Großblütige Taubnessel',
    quelle: 'eigene Beschreibung: „auch bekannt als Großblütige Taubnessel"' },
  { id: 416, botanisch: 'Zizia aurea', neu: 'Gold-Alexander',
    quelle: 'eigene Beschreibung: „auch bekannt als Gold-Alexander"' },
  { id: 511, botanisch: 'Muhlenbergia capillaris', neu: 'Haargras',
    quelle: 'eigene Beschreibung: „auch als Haargras bekannt"' },
  { id: 690, botanisch: 'Trillium recurvatum', neu: 'Rotes Dreiblatt',
    quelle: 'eigene Beschreibung „auch als Rote Dreiblatt bekannt" (Endung korrigiert) und Gattungskonvention (Trillium grandiflorum = Großes Dreiblatt)' },
  { id: 726, botanisch: 'Moltkia petraea', neu: 'Felsen-Moltkie',
    quelle: 'EXTERN belegt — Wikipedia (de), stauden-ratgeber.de, Sarastro Stauden, Staudengärtnerei Forssman. Der einzige der neun Namen, den die Datenbank selbst nicht hergab' },
  { id: 740, botanisch: 'Jovibarba hirta', neu: 'Bärtige Hauswurz',
    quelle: 'eigene Beschreibung „auch bekannt als ‚Bärtige Hauswurz‘" und Gattungskonvention (Sempervivum = Hauswurz)' },

  // Kein fehlender Name, sondern ein Grammatikfehler — beim Prüfen der Gattung aufgefallen.
  { id: 194, botanisch: 'Sanguisorba minor', neu: 'Kleiner Wiesenknopf',
    quelle: 'Grammatik: „Kleine Wiesenknopf" ist falsch, der Wiesenknopf ist männlich. Die Geschwister heißen bereits „Großer Wiesenknopf" und „Japanischer Wiesenknopf"' },
];

function main() {
  const anwenden = process.argv.includes('--anwenden');
  const db = new Database(process.env.DB_PFAD || path.join(WURZEL, 'stauden.db'), { readonly: !anwenden });

  const geplant = [];
  for (const n of NAMEN) {
    const p = db.prepare('SELECT id, name_deutsch, name_botanisch FROM pflanzen WHERE id = ?').get(n.id);
    if (!p) throw new Error(`id ${n.id} gibt es nicht`);
    if (p.name_botanisch !== n.botanisch)
      throw new Error(`id ${n.id} ist „${p.name_botanisch}", erwartet war „${n.botanisch}" — abgebrochen, statt die falsche Pflanze umzubenennen`);
    // Doppelte deutsche Namen wären in Listen und Plänen nicht auseinanderzuhalten.
    const kollision = db.prepare('SELECT id, name_botanisch FROM pflanzen WHERE LOWER(name_deutsch) = LOWER(?) AND id <> ?').all(n.neu, n.id);
    if (kollision.length)
      throw new Error(`„${n.neu}" ist schon vergeben an id ${kollision[0].id} (${kollision[0].name_botanisch})`);
    // Schon erledigt: nicht noch einmal melden. Sonst behauptet ein zweiter Lauf zehn
    // offene Änderungen, obwohl nichts mehr zu tun ist.
    if (p.name_deutsch === n.neu) continue;
    geplant.push({ ...n, alt: p.name_deutsch });
  }

  if (!geplant.length) { console.log('Alle Namen sind bereits eingetragen — nichts zu tun.'); return; }

  geplant.forEach(g => {
    console.log(`${String(g.id).padStart(4)}  ${g.alt}  →  ${g.neu}`);
    console.log(`      ${g.botanisch}`);
    console.log(`      Quelle: ${g.quelle}`);
  });

  if (!anwenden) {
    console.log(`\n${geplant.length} Änderungen vorgemerkt. Zum Schreiben: --anwenden`);
    return;
  }

  const schreiben = db.transaction(() => {
    const stmt = db.prepare('UPDATE pflanzen SET name_deutsch = ?, aktualisiert_am = ? WHERE id = ?');
    const jetzt = new Date().toISOString().slice(0, 10);
    geplant.forEach(g => stmt.run(g.neu, jetzt, g.id));
  });
  schreiben();

  const beleg = path.join(WURZEL, 'data', `deutsche-namen-${new Date().toISOString().slice(0, 10)}.json`);
  fs.mkdirSync(path.dirname(beleg), { recursive: true });
  fs.writeFileSync(beleg, JSON.stringify(geplant, null, 2) + '\n');
  console.log(`\n${geplant.length} Namen geschrieben. Beleg: ${path.relative(WURZEL, beleg)}`);

  // Einfache Anführungszeichen: In SQLite ist "…" ein Spaltenname, nicht eine Zeichenkette.
  const rest = db.prepare(`SELECT COUNT(*) n FROM pflanzen
                           WHERE LOWER(TRIM(name_deutsch)) = LOWER(name_botanisch)
                              OR LOWER(TRIM(name_deutsch)) = LOWER(SUBSTR(name_botanisch, 1, INSTR(name_botanisch, ' ') - 1))`).get();
  console.log(`Arten ohne echten deutschen Namen danach: ${rest.n}`);
}

if (require.main === module) main();
module.exports = { NAMEN };
