/*
 * Sucht Widersprüche INNERHALB der Pflanzendaten.
 *
 *   node scripts/daten-widersprueche.js [--csv]
 *
 * Bewusst nur Prüfungen, die ohne externe Quelle auskommen: Zwei Felder derselben Pflanze
 * sagen etwas, das nicht beides stimmen kann. Solche Funde sind objektiv falsch, ganz gleich
 * welcher Quelle man sonst glaubt — im Gegensatz zu „diese Zone kommt mir zu niedrig vor",
 * wofür es einen Beleg von außen braucht.
 *
 * Die Prüfungen sind aus Verdachtsmomenten des Spaltenprofils entstanden
 * (scripts/daten-profil.js): 83 % bienenfreundlich bei einer Datenbank, die Gräser und Farne
 * enthält, kann nicht stimmen — Gräser bestäubt der Wind, Farne blühen gar nicht.
 */
const Database = require('better-sqlite3');
const path = require('path');
const L = require('./pin-layout');

const db = new Database(process.env.DB_PFAD || path.join(__dirname, '..', 'stauden.db'), { readonly: true });
const alle = db.prepare('SELECT * FROM pflanzen').all();

const menge = s => new Set(String(s || '').split(/[|,]/).map(x => x.trim().toLowerCase()).filter(Boolean));
const hat = (feld, wort) => menge(feld).has(wort);
const enthaelt = (feld, teil) => new RegExp(teil, 'i').test(String(feld || ''));

/*
 * Farne und blütenlose Arten. Farne über die Gattung, weil „kein Blüteschmuck" nicht bei
 * allen steht.
 *
 * ZWEI FRAGEN, DIE BIS ZUM 21.09.2026 EINE WAREN:
 *
 *   sagtSelbstKeineBluete(p)  Die Pflanze ist als blütenlos GEFÜHRT — Farn oder ein
 *                             Blühzeit-Feld, das mit „kein…" beginnt. Das ist eine Aussage.
 *   !L.spanne(p.bluehzeit)    Die Blühzeit lässt sich nicht in Monate zerlegen. Das ist eine
 *                             Aussage ODER ein Datenfehler — über die Blüte selbst sagt es
 *                             nichts.
 *
 * Sie führen zu verschiedenen Korrekturen: dort gehört bienen_freundlich auf 0, hier die
 * Blühzeit nachgetragen. Der frühere Sammelbegriff ohneBluete() hat beides vermengt und ist
 * deshalb ersatzlos entfallen: Mit ihm meldete die Prüfung „bienenfreundlich, blüht aber gar
 * nicht" auch Zeilen, über deren Blüte nichts bekannt ist, und begründete das mit „Farne und
 * Arten ohne Blüteschmuck bieten Bienen nichts". Wer dem folgt, korrigiert das falsche Feld.
 * Im lokalen Stand sind das die Werte „null" und „keine Blüte" — „null" enthält kein „kein"
 * und fiel damit nur in den Sammelbegriff. Unlesbare Blühzeiten meldet jetzt ausschließlich
 * die Prüfung „Blühzeit weder lesbar noch als blütenlos geführt", unter ihrem eigenen Namen.
 *
 * Die Prüfung „Blühzeit nicht lesbar" fragte mit der zweiten Fassung nach der ersten und war
 * dadurch tautologisch tot: `!spanne(p) && !ohneBluete(p)` kann nicht wahr werden, weil
 * ohneBluete selbst `!spanne(p)` enthält. Sie meldete immer 0 — und genau deshalb ist jahrelang
 * niemandem aufgefallen, dass L.spanne() jede jahresübergreifende Blühzeit verworfen hat
 * („Dezember - März", Helleborus niger). Eine Prüfung, die nie anschlägt, sieht aus wie eine
 * bestandene Prüfung.
 */
const FARN_GATTUNG = new Set(['Adiantum','Asplenium','Athyrium','Blechnum','Cyrtomium','Dryopteris',
  'Gymnocarpium','Matteuccia','Onoclea','Osmunda','Phyllitis','Polypodium','Polystichum','Woodwardia']);
const istFarn = p => FARN_GATTUNG.has(String(p.name_botanisch).split(' ')[0]);
const sagtSelbstKeineBluete = p => istFarn(p) || /kein/i.test(String(p.bluehzeit || ''));

const PRUEFUNGEN = [
  {
    name: 'bienenfreundlich, blüht aber gar nicht',
    warum: 'Farne und Arten ohne Blüteschmuck bieten Bienen nichts. Ein Häkchen hier führt jeden in die Irre, der gezielt nach Bienenweiden sucht.',
    treffer: p => p.bienen_freundlich === 1 && sagtSelbstKeineBluete(p),
  },
  {
    name: 'bienenfreundlich, ist aber ein Gras',
    warum: 'Gräser, Seggen und Binsen werden vom Wind bestäubt und produzieren keinen Nektar.',
    treffer: p => p.bienen_freundlich === 1 && L.istGras(p) && !sagtSelbstKeineBluete(p),
  },
  {
    name: 'Mindesthöhe größer als Maximalhöhe',
    warum: 'Zahlendreher.',
    treffer: p => p.hoehe_cm_min && p.hoehe_cm_max && p.hoehe_cm_min > p.hoehe_cm_max,
  },
  {
    name: 'Blühzeit weder lesbar noch als blütenlos geführt',
    warum: 'Der Planer und alle Pin-Sorten rechnen mit Monaten. Was sich nicht zerlegen lässt und auch nicht „kein Blüteschmuck" sagt, fällt still aus jeder Blühfolge heraus — als hätte es die Pflanze nicht gegeben. Betrifft Werte wie „N/A" oder ein leeres Feld.',
    treffer: p => !L.spanne(p.bluehzeit) && !sagtSelbstKeineBluete(p),
  },
  {
    name: 'Blühzeit läuft über den Jahreswechsel',
    warum: 'Seit dem 21.09.2026 liest L.spanne() „Dezember - März" als [12, 3] statt als unlesbar — richtig für die Christrose, aber damit ist auch die einzige Sperre gegen VERDREHTE Spannen weggefallen: „September - Juli" ergibt jetzt elf Monate Blüte und setzt die Pflanze in zehn Monatsraster, statt wie vorher still aus jeder Pin-Sorte herauszufallen. Ein gewollter Jahreswechsel und ein Zahlendreher sehen in den Daten gleich aus, der Unterschied steckt in der Absicht. Deshalb wird hier jede Umbruchspanne einmal aufgelistet und einzeln eingestuft.',
    treffer: p => { const s = L.spanne(p.bluehzeit); return Boolean(s && L.ueberJahreswechsel(s)); },
  },
  {
    name: 'Schattenpflanze in der Steppenheide',
    warum: 'Steppenheide ist der trockenste, vollsonnigste Lebensbereich. Zusammen mit „Schatten" schließt sich das aus.',
    treffer: p => hat(p.licht, 'schatten') && !hat(p.licht, 'sonne') && !hat(p.licht, 'halbschatten') && enthaelt(p.lebensbereich, 'steppenheide'),
  },
  {
    name: 'trockener Standort in der Quellflur',
    warum: 'Quellflur ist quelliger, dauerfeuchter Boden. „trocken" passt dazu nicht.',
    treffer: p => hat(p.feuchtigkeit, 'trocken') && !hat(p.feuchtigkeit, 'normal') && enthaelt(p.lebensbereich, 'quellflur'),
  },
  {
    name: 'nasser Standort, aber trockenheitstolerant',
    warum: 'Eine Art, die nassen Boden braucht, ist nicht zugleich trockenheitstolerant.',
    treffer: p => hat(p.feuchtigkeit, 'nass') && /hoch/i.test(String(p.trockenheitstoleranz || '')),
  },
  {
    name: 'Lebensbereich als Kürzel statt als Name',
    warum: 'In derselben Spalte stehen zwei Systeme: ausgeschriebene Namen („Freifläche,Gehölzrand") und Kürzel der Lebensbereichs-Systematik („G2, GR2"). Auswertungen greifen nur bei einem von beiden.',
    treffer: p => /^[A-Z]{1,3}\d/.test(String(p.lebensbereich || '').trim()),
  },
  {
    name: 'Breite kleiner als ein Fünftel der Höhe',
    warum: 'Bei Stauden unplausibel schmal; die Fläche im Plan wird daraus gerechnet.',
    treffer: p => p.breite_cm_max && p.hoehe_cm_max && p.breite_cm_max * 5 < p.hoehe_cm_max,
  },
  {
    name: 'Farbe uneinheitlich geschrieben',
    warum: '92 verschiedene Farbwerte bei 709 Pflanzen — Groß- und Kleinschreibung gemischt. Filter und Farbzuordnung greifen dann nur zur Hälfte.',
    treffer: p => String(p.farbe || '') !== String(p.farbe || '').trim()
              || /[|,]\s*[a-zäöü]/.test(String(p.farbe || ''))
              || /^[a-zäöü]/.test(String(p.farbe || '')),
  },
];

const csv = process.argv.includes('--csv');
let gesamt = 0;
const zeilen = [];

for (const pr of PRUEFUNGEN) {
  const treffer = alle.filter(pr.treffer);
  gesamt += treffer.length;
  if (csv) { treffer.forEach(p => zeilen.push([pr.name, p.id, p.name_deutsch, p.name_botanisch].join(';'))); continue; }
  console.log(`\n■ ${pr.name}: ${treffer.length}`);
  console.log(`  ${pr.warum}`);
  treffer.slice(0, 12).forEach(p => console.log(`    ${String(p.id).padStart(4)}  ${String(p.name_deutsch).padEnd(32)}${p.name_botanisch}`));
  if (treffer.length > 12) console.log(`    … und ${treffer.length - 12} weitere`);
}

if (csv) console.log(zeilen.join('\n'));
else console.log(`\n${'─'.repeat(70)}\nBetroffene Datensätze insgesamt: ${gesamt} (Mehrfachnennung möglich) bei ${alle.length} Pflanzen`);
