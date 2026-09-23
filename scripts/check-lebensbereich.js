/*
 * PRÜFUNG: Widerspricht sich eine Pflanzenzeile selbst?
 *
 * Der Lebensbereich nach Hansen/Stahl sagt, unter welchen Bedingungen eine Staude in der Natur
 * steht — und damit implizit auch, wieviel Licht und Wasser sie verträgt. Steht in derselben
 * Zeile ein Lebensbereich und eine Feuchte- oder Lichtangabe, die einander ausschließen, ist
 * mindestens eines der beiden Felder falsch.
 *
 * ANLASS (23.09.2026): Eine Staudengärtnerei hat die erzeugten Bepflanzungspläne fachlich
 * beanstandet. Beim Nachsehen trug Gentiana sino-ornata — eine Moorbeetpflanze mit
 * Rhododendron-Ansprüchen — den Lebensbereich „Steppenheide" (trocken, warm, kalkreich) und
 * den Stil „Mediterran". Der Planer hat korrekt gelesen, was falsch dort stand.
 *
 * WAS DIESE PRÜFUNG NICHT FINDET, und das ist der wichtigere Satz:
 * Sie findet nur WIDERSPRÜCHE INNERHALB einer Zeile. Ausgerechnet der Fall, der den Anlass
 * gab, entgeht ihr: Gentiana sino-ornata trägt feuchtigkeit='normal' und licht='Sonne|
 * Halbschatten' — zusammen mit „Steppenheide" ist das in sich stimmig und trotzdem komplett
 * falsch. Eine Zeile, die durchgehend dasselbe Falsche sagt, sieht von innen richtig aus.
 * Dafür braucht es einen Abgleich gegen eine Quelle außerhalb unserer Daten; die eigenen
 * Pflegetexte taugen dafür nicht, weil sie aus denselben Feldern erzeugt wurden.
 *
 * Aufrufen:  node scripts/check-lebensbereich.js
 *            node scripts/check-lebensbereich.js --alle     (auch die schwachen Hinweise)
 */
const path = require('path');
const Database = require('better-sqlite3');

const ALLE = process.argv.includes('--alle');
const db = new Database(process.env.DB_PFAD || path.join(__dirname, '..', 'stauden.db'), { readonly: true });

const hat = (feld, wert) => String(feld || '').toLowerCase().split(/[|,]/).map(s => s.trim()).includes(wert);
const nur = (feld, wert) => {
  const teile = String(feld || '').toLowerCase().split(/[|,]/).map(s => s.trim()).filter(Boolean);
  return teile.length > 0 && teile.every(t => t === wert);
};

/* Die Regeln. Jede nennt, WARUM die Kombination nicht zusammengeht — ohne diese Begründung
 * wäre die Prüfung eine Meinung. „hart" heißt: Die beiden Angaben schließen einander aus.
 * „weich" heißt: ungewöhnlich, aber es gibt Ausnahmen — die laufen nur mit --alle mit. */
const REGELN = [
  {
    name: 'Steppenheide + feucht/nass',
    hart: true,
    grund: 'Die Steppenheide ist der trocken-warme, magere, meist kalkreiche Lebensbereich. '
      + 'Eine Staude, die dort zu Hause ist, steht nicht in feuchtem oder nassem Boden.',
    trifft: p => hat(p.lebensbereich, 'steppenheide')
      && (hat(p.feuchtigkeit, 'feucht') || hat(p.feuchtigkeit, 'nass')),
  },
  {
    name: 'Steppenheide + nur Schatten',
    hart: true,
    grund: 'Die Steppenheide ist voll besonnt. Eine reine Schattenangabe widerspricht ihr.',
    trifft: p => hat(p.lebensbereich, 'steppenheide') && nur(p.licht, 'schatten'),
  },
  {
    name: 'Quellflur/Wasserfläche/Teichrand + trocken',
    hart: true,
    grund: 'Quellflur, Wasserfläche und Teichrand sind die dauerfeuchten bis nassen Bereiche. '
      + 'Eine Trockenangabe dazu kann nicht stimmen.',
    trifft: p => ['quellflur', 'wasserfläche', 'teichrand'].some(lb => hat(p.lebensbereich, lb))
      && nur(p.feuchtigkeit, 'trocken'),
  },
  {
    name: 'Gehölz + nur Sonne',
    hart: true,
    grund: 'Das Gehölz ist der Bereich unter Bäumen — schattig. Eine reine Sonnenangabe '
      + 'widerspricht ihm. (Gehölzrand und Waldsaum sind davon ausgenommen, die sind hell.)',
    trifft: p => hat(p.lebensbereich, 'gehölz') && !hat(p.lebensbereich, 'gehölzrand')
      && nur(p.licht, 'sonne'),
  },
  {
    name: 'Freifläche + nur Schatten',
    hart: true,
    grund: 'Die Freifläche ist die offene, besonnte Lage. Eine reine Schattenangabe widerspricht ihr.',
    trifft: p => hat(p.lebensbereich, 'freifläche') && nur(p.licht, 'schatten'),
  },
  {
    name: 'Steppenheide + humoser Boden ohne Sand',
    hart: false,
    grund: 'Steppenheidestauden wollen mager und durchlässig. Rein humos ohne sandigen Anteil '
      + 'ist ungewöhnlich — es gibt aber Arten, die beides vertragen.',
    trifft: p => hat(p.lebensbereich, 'steppenheide') && hat(p.boden, 'humos') && !hat(p.boden, 'sandig'),
  },
  {
    name: 'Wasserfläche/Teichrand + Stil Steingarten oder Mediterran',
    hart: false,
    grund: 'Ein Steingarten- oder Mediterranstil an einer Wasserpflanze deutet darauf hin, '
      + 'dass die Stilangabe geraten wurde.',
    trifft: p => ['wasserfläche', 'teichrand', 'quellflur'].some(lb => hat(p.lebensbereich, lb))
      && (hat(p.stil, 'steingarten') || hat(p.stil, 'mediterran')),
  },
];

const zeilen = db.prepare(
  'SELECT id, name_deutsch, name_botanisch, licht, boden, feuchtigkeit, lebensbereich, stil FROM pflanzen'
).all();

console.log(`\n--- Pruefung: widerspricht sich eine Pflanzenzeile selbst? ---`);
console.log(`Datenbank: ${db.name} (${zeilen.length} Zeilen)\n`);

if (zeilen.length < 400) {
  console.error('FEHLER: Weniger als 400 Zeilen — das ist nicht der Produktionsbestand.');
  console.error('Die Arbeitskopie ist ein alter Teilstand; ein bestandener Lauf gegen sie');
  console.error('belegt nur, dass wenig geprueft wurde. Auf dem Server im Deploy-Verzeichnis laufen lassen.');
  process.exit(1);
}

let treffer = 0;
for (const regel of REGELN) {
  if (!regel.hart && !ALLE) continue;
  const gefunden = zeilen.filter(regel.trifft);
  const marke = regel.hart ? 'WIDERSPRUCH' : 'hinweis    ';
  if (!gefunden.length) { console.log(`ok           ${regel.name}: keine`); continue; }
  console.log(`${marke}  ${regel.name}: ${gefunden.length}`);
  console.log(`             ${regel.grund}`);
  for (const p of gefunden.slice(0, 12)) {
    console.log(`             [${p.id}] ${p.name_deutsch} (${p.name_botanisch})`);
    console.log(`                  LB=${p.lebensbereich} · Licht=${p.licht} · Feuchte=${p.feuchtigkeit} · Boden=${p.boden}`);
  }
  if (gefunden.length > 12) console.log(`             … und ${gefunden.length - 12} weitere`);
  if (regel.hart) treffer += gefunden.length;
}

console.log(`\nHarte Widersprueche: ${treffer}`);
if (!ALLE) console.log('Mit --alle laufen zusaetzlich die schwachen Hinweise mit.');
console.log('\nWAS DIESER LAUF NICHT FINDET: Zeilen, die durchgehend dasselbe Falsche sagen.');
console.log('Gentiana sino-ornata (Moorbeetpflanze, hier als "Steppenheide" gefuehrt) ist in sich');
console.log('stimmig und entgeht dieser Pruefung. Dafuer braucht es eine Quelle ausserhalb der');
console.log('eigenen Daten — die eigenen Pflegetexte taugen nicht, sie stammen aus denselben Feldern.');

db.close();
process.exit(treffer ? 1 : 0);
