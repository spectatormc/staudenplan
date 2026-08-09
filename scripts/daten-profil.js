/*
 * Zeigt für jede Spalte der Pflanzentabelle, wie die Werte verteilt sind.
 *
 *   node scripts/daten-profil.js [spalte]
 *
 * Zweck: Vorgabewerte finden. Eine Füllquote von 100 % sagt nichts — `kombinationspartner`
 * war vollständig gefüllt und trotzdem unbrauchbar (2816 Nennungen auf 208 Partner),
 * `winterhart_zone` steht bei 223 von 299 Pflanzen auf exakt Zone 5. Beides fällt nur auf,
 * wenn man die VERTEILUNG misst und nicht die Vollständigkeit.
 *
 * Faustregel für die Auswertung: Stellt der häufigste Wert mehr als die Hälfte aller Zeilen,
 * ist es vermutlich ein Vorgabewert und keine Angabe.
 */
const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(process.env.DB_PFAD || path.join(__dirname, '..', 'stauden.db'), { readonly: true });
const spalten = db.prepare('PRAGMA table_info(pflanzen)').all().map(s => s.name);
const alle = db.prepare('SELECT * FROM pflanzen').all();
const N = alle.length;

const nurEine = process.argv[2];
console.log(`${N} Pflanzen, ${spalten.length} Spalten\n`);
console.log('Spalte                 gefüllt  verschieden  häufigster Wert (Anteil)');
console.log('─'.repeat(100));

for (const s of spalten) {
  if (nurEine && s !== nurEine) continue;
  if (/^(beschreibung|inhalt_lang|bild_kandidaten|bild_check_info|bild_vorschlag|kombinationspartner)$/.test(s) && !nurEine) {
    const gefuellt = alle.filter(p => p[s] !== null && String(p[s]).trim() !== '').length;
    console.log(`${s.padEnd(22)}${String(gefuellt).padStart(7)}  ${'(Fließtext, nicht ausgezählt)'.padStart(11)}`);
    continue;
  }
  const werte = alle.map(p => p[s]).filter(v => v !== null && String(v).trim() !== '');
  const z = new Map();
  werte.forEach(v => z.set(String(v), (z.get(String(v)) || 0) + 1));
  const top = [...z.entries()].sort((a, b) => b[1] - a[1]);
  const anteil = top.length ? Math.round(top[0][1] / N * 100) : 0;
  const marke = anteil >= 50 ? '  ← VERDACHT auf Vorgabewert' : '';
  const wert = top.length ? (top[0][0].length > 28 ? top[0][0].slice(0, 28) + '…' : top[0][0]) : '—';
  console.log(`${s.padEnd(22)}${String(werte.length).padStart(7)}  ${String(z.size).padStart(11)}  ${wert} (${anteil} %)${marke}`);

  if (nurEine) {
    console.log('\nalle Werte:');
    top.forEach(([v, c]) => console.log(`  ${String(c).padStart(5)}×  ${v}`));
  }
}
