/*
 * Nachtrag zur Winterhärte, 18.08.2026 — plus der Grund, warum es nur ein Nachtrag ist.
 *
 *   node scripts/winterhaerte-nachtrag.js --dry-run
 *   node scripts/winterhaerte-nachtrag.js
 *
 * ── WAS DIESE PRÜFUNG WERT IST, UND WAS NICHT ────────────────────────────────
 * Die Runden vom 06. und 09.08. haben die Winterhärte zweimal gegen den eigenen Fließtext
 * gegengeprüft und daraus Korrekturen abgeleitet. Diese Gegenprüfung ist ZIRKULÄR: Die
 * Pflegetexte wurden mit `Winterhärtezone: <wert>` im Prompt erzeugt
 * (scripts/inhalt-lang-nach-schema.js:122). Der Text bestätigt also das Feld, aus dem er
 * stammt. Über 711 Zeilen fanden sich nur zwei Widersprüche — und das ist kein Beleg für
 * Richtigkeit, sondern die erwartbare Folge der Zirkularität.
 *
 * Belastbar geprüft ist damit weiterhin nur die Grenze, an der der Filter schneidet
 * (PLANBAR lässt Zone <= 7 zu). Die rund 690 Werte am kalten Ende sind unverändert
 * Vorgabewerte; sie haben seit dem 18.08. allerdings auch keinen Ausgabepfad mehr, seit die
 * Zahl aus den strukturierten Daten der Pflanzenseiten entfernt wurde.
 *
 * ── DIE DREI BEFUNDE DIESER RUNDE ────────────────────────────────────────────
 */
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DRY = process.argv.includes('--dry-run');
const DB_PFAD = (process.argv.find(a => a.startsWith('--db=')) || '').split('=')[1]
  || path.join(__dirname, '..', 'stauden.db');

// 1. Falscher Zonenwert — die Pflanze steht im Planer, obwohl sie hier nicht durch den Winter kommt.
const ZONEN = [
  {
    bot: 'Artemisia arborescens', zone: 9,
    warum: 'Immergrüner Halbstrauch des Mittelmeerraums, verträgt etwa −5 bis −10 °C und wird in '
         + 'Deutschland als Kübelpflanze gehandelt. Stand auf Zone 6 (−23 °C) und war damit im '
         + 'Planer. Zum Vergleich in derselben Gattung: die Hybride "Powis Castle" ist mit Zone 6 '
         + 'deutlich härter, der heimische Wermut steht zu Recht auf 5.',
  },
];

/*
 * 2. Widersprüchliche Texte. Hier ist NICHT das Feld falsch, sondern der Text — beide Stellen
 *    behaupten Winterhärte für eine Art, die frostfrei überwintert werden muss. Agapanthus
 *    africanus ist die immergrüne südafrikanische Art; hart ist die sommergrüne Verwandtschaft
 *    (A. campanulatus), nicht diese. Der Text steht sichtbar auf der Pflanzenseite.
 */
const TEXTE = [
  {
    bot: 'Agapanthus africanus',
    feld: 'beschreibung',
    alt: /^Winterharte Sorte/,
    neu: 'Nicht winterharte Art mit großen, kugelförmigen Blütenständen. Ideal für sonnige Standorte '
       + 'im Kübel — die immergrüne Schmucklilie muss frostfrei überwintern.',
    warum: 'behauptete Winterhärte für eine Art, die das Feld zu Recht ausschließt',
  },
  {
    bot: 'Agapanthus africanus',
    feld: 'inhalt_lang.ueberwinterung',
    neu: 'Die immergrüne Schmucklilie ist nicht winterhart und muss frostfrei bei etwa 5 bis 10 °C '
       + 'überwintern — hell, kühl und deutlich sparsamer gegossen. Sommergrüne Arten der Gattung '
       + 'wie Agapanthus campanulatus vertragen dagegen Frost und können mit Schutz draußen bleiben.',
    warum: 'sagte "Diese Sorte ist winterhart" und empfahl Mulch statt frostfreier Überwinterung',
  },
  {
    bot: 'Artemisia arborescens',
    feld: 'inhalt_lang.ueberwinterung',
    neu: 'Der Strauch-Beifuß ist hier nicht winterhart und überwintert frostfrei bei etwa 5 bis 10 °C, '
       + 'hell und fast trocken. Im Freiland fällt er in normalen Wintern aus.',
    warum: 'sagte "In Winterhärtezone 6 ist der Strauch winterhart" — der Text zitierte den Feldwert, '
         + 'den er belegen sollte, und beide waren falsch',
  },
];

const db = new Database(DB_PFAD);
const aenderungen = [];

function finde(bot) {
  const p = db.prepare('SELECT * FROM pflanzen WHERE name_botanisch = ?').get(bot);
  if (!p) throw new Error('Nicht in der Datenbank: ' + bot);
  return p;
}

for (const z of ZONEN) {
  const p = finde(z.bot);
  if (p.winterhart_zone === z.zone) { console.log(`— ${z.bot}: steht schon auf ${z.zone}`); continue; }
  aenderungen.push({ art: 'Zone', bot: z.bot, name: p.name_deutsch, von: p.winterhart_zone, nach: z.zone, warum: z.warum,
    anwenden: () => db.prepare('UPDATE pflanzen SET winterhart_zone = ? WHERE name_botanisch = ?').run(z.zone, z.bot) });
}

for (const t of TEXTE) {
  const p = finde(t.bot);
  if (t.feld === 'beschreibung') {
    if (t.alt && !t.alt.test(p.beschreibung || '')) { console.log(`— ${t.bot}: Beschreibung schon geändert`); continue; }
    aenderungen.push({ art: 'Beschreibung', bot: t.bot, name: p.name_deutsch,
      von: String(p.beschreibung || '').slice(0, 60) + '…', nach: t.neu.slice(0, 60) + '…', warum: t.warum,
      anwenden: () => db.prepare('UPDATE pflanzen SET beschreibung = ? WHERE name_botanisch = ?').run(t.neu, t.bot) });
  } else {
    const schluessel = t.feld.split('.')[1];
    let il; try { il = JSON.parse(p.inhalt_lang || '{}'); } catch { il = {}; }
    if (il[schluessel] === t.neu) { console.log(`— ${t.bot}: ${schluessel} schon geändert`); continue; }
    aenderungen.push({ art: schluessel, bot: t.bot, name: p.name_deutsch,
      von: String(il[schluessel] || '').slice(0, 60) + '…', nach: t.neu.slice(0, 60) + '…', warum: t.warum,
      anwenden: () => {
        il[schluessel] = t.neu;
        db.prepare('UPDATE pflanzen SET inhalt_lang = ? WHERE name_botanisch = ?').run(JSON.stringify(il), t.bot);
      } });
  }
}

console.log(`\n${aenderungen.length} Änderung(en)${DRY ? ' — Trockenlauf, nichts geschrieben' : ''}:\n`);
for (const a of aenderungen) {
  console.log(`  [${a.art}] ${a.name} (${a.bot})`);
  console.log(`      vorher:  ${a.von}`);
  console.log(`      nachher: ${a.nach}`);
  console.log(`      Grund:   ${a.warum}\n`);
}

if (!DRY && aenderungen.length) {
  const tx = db.transaction(() => aenderungen.forEach(a => a.anwenden()));
  tx();
  const protokoll = path.join(__dirname, '..', 'data', 'winterhaerte-2026-08-18.json');
  fs.writeFileSync(protokoll, JSON.stringify(aenderungen.map(({ anwenden, ...r }) => r), null, 1));
  console.log(`geschrieben. Protokoll: ${protokoll}`);
}
db.close();
