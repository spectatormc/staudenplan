/*
 * Prüft die Preise NACH dem Abgleich — die zweite Stufe zu scripts/preise-gaissmayer.js.
 *
 * STAND 23.09.2026: Die Zusammenarbeit mit der Gärtnerei ist beendet (Begründung im Kopf von
 * preise-gaissmayer.js). Diese Prüfung arbeitet weiter gegen den eingefrorenen Katalog vom
 * 31.08.2026, weil die Preise in der Datenbank aus ihm stammen. Sie belegt damit die
 * Herkunft der Zahlen — nicht eine bestehende Geschäftsbeziehung.
 *
 *   node scripts/check-preise.js
 *
 * Der Abgleich selbst kann nicht sein eigener Zeuge sein: Er hat die Zahlen geschrieben, also
 * findet ein Bericht aus derselben Rechnung auch keinen Fehler darin. Diese Prüfung geht
 * deshalb vom Ergebnis aus und fragt zurück — steht jeder Preis in der DB so auch im Katalog,
 * und zwar bei DIESER Art? Erfundene, gerundete oder aus einer Nachbarart übernommene Werte
 * fallen hier auf, auch wenn der Abgleich sie für richtig hielt.
 *
 * Zusätzlich die Verteilung statt bloßer Wertebereiche: Gaißmayer verkauft auf einer kurzen
 * Preisleiter (3,60 / 4,60 / 5,10 / 5,60 / 6,30 / 6,90 / 8,30 …). Preise daneben sind
 * entweder Zwiebel-Stückpreise (legitim) oder alte Schätzwerte, die kein Angebot bestätigt.
 *
 * Exit-Code 1, wenn ein Preis nicht belegt ist — damit taugt die Prüfung für CI.
 */
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const { binomial, istPflanze, indexBauen, KATALOG } = require('./preise-gaissmayer.js');

if (!fs.existsSync(KATALOG)) {
  console.error('Kein Katalog — erst: node scripts/preise-gaissmayer.js --holen');
  process.exit(1);
}
const katalog = JSON.parse(fs.readFileSync(KATALOG, 'utf8'));
const { nachArt } = indexBauen(katalog.produkte);

const db = new Database(process.env.DB_PFAD || path.join(__dirname, '..', 'stauden.db'), { readonly: true });
const pflanzen = db.prepare("SELECT id, name_botanisch, name_deutsch, preis_stueck_eur FROM pflanzen WHERE name_deutsch != 'Test-Pflanze'").all();

const cent = n => Math.round(Number(n || 0) * 100);
const f = n => Number(n || 0).toFixed(2).replace('.', ',');

let belegt = 0, unbelegt = [], ohneAngebot = [], unplausibel = [];
for (const p of pflanzen) {
  const b = binomial(p.name_botanisch);
  const angebote = (b && nachArt.get(b)) || [];
  if (!angebote.length) { ohneAngebot.push(p); continue; }
  // Der Preis muss einem echten Angebot DIESER Art entsprechen — auf den Cent.
  if (angebote.some(a => cent(a.preis) === cent(p.preis_stueck_eur))) belegt++;
  else unbelegt.push({ ...p, moeglich: [...new Set(angebote.map(a => a.preis))].sort((x, y) => x - y) });
  if (!(p.preis_stueck_eur > 0)) unplausibel.push({ ...p, grund: 'kein Preis' });
  else if (p.preis_stueck_eur > 60) unplausibel.push({ ...p, grund: 'über 60 €' });
}

console.log(`Katalog vom ${katalog.geholt_am.slice(0, 10)} · ${pflanzen.length} Arten in der DB\n`);
console.log(`Durch ein Angebot derselben Art belegt: ${belegt}`);
console.log(`Preis weicht von allen Angeboten ab:    ${unbelegt.length}`);
console.log(`Kein Angebot im Katalog (Preis bleibt Schätzung): ${ohneAngebot.length}`);
console.log(`Unplausibel (0 € oder über 60 €):       ${unplausibel.length}\n`);

for (const u of unbelegt.slice(0, 15)) {
  console.log(`  ✗ ${u.name_botanisch.padEnd(34)} DB ${f(u.preis_stueck_eur).padStart(6)} €  ·  Shop: ${u.moeglich.map(f).join(' / ')}`);
}
if (unbelegt.length > 15) console.log(`  … und ${unbelegt.length - 15} weitere`);

// Verteilung: Gaißmayers Leiter gegen unsere. Ein einzelner Wertebereich („3,50–20 €")
// verrät nichts — erst die Häufung je Stufe zeigt, ob die Zahlen aus dem Sortiment stammen.
const stufen = m => {
  const z = {};
  for (const v of m) z[f(v)] = (z[f(v)] || 0) + 1;
  return Object.entries(z).sort((a, b) => b[1] - a[1]).slice(0, 8)
    .map(([k, n]) => `${k} €×${n}`).join('  ');
};
console.log(`\nUnsere häufigsten Preise: ${stufen(pflanzen.map(p => p.preis_stueck_eur))}`);
console.log(`Shop-Angebote (Töpfe):    ${stufen(katalog.produkte.filter(p => istPflanze(p) && p.packung === 1).map(p => p.preis))}`);

// Wirkung auf die acht Beispielpläne: Die JSONs tragen die alten, eingefrorenen Preise —
// damit lässt sich nach dem Schreiben noch sagen, was sich für einen fertigen Plan ändert.
const preisDb = new Map(pflanzen.map(p => [p.name_botanisch, p.preis_stueck_eur]));
console.log('\nBeispielpläne (eingefrorener Stand → Datenbank):');
let sAlt = 0, sNeu = 0;
for (const datei of fs.readdirSync(__dirname).filter(x => /^beispiel-plan-.*\.json$/.test(x))) {
  const plan = JSON.parse(fs.readFileSync(path.join(__dirname, datei), 'utf8'));
  let alt = 0, neu = 0, unbekannt = 0;
  for (const pf of plan.pflanzen || []) {
    const stk = Number(pf.stueckzahl) || 1;
    const a = Number(pf.preis_stueck_eur) || 0;
    const n = preisDb.has(pf.name_botanisch) ? preisDb.get(pf.name_botanisch) : a;
    if (!preisDb.has(pf.name_botanisch)) unbekannt++;
    alt += a * stk; neu += n * stk;
  }
  sAlt += alt; sNeu += neu;
  const pfeil = alt > 0 ? `${Math.round((neu / alt - 1) * 100)} %` : '—';
  console.log(`  ${datei.replace('beispiel-plan-', '').replace('.json', '').padEnd(16)} ${f(alt).padStart(8)} € → ${f(neu).padStart(8)} €  ${pfeil.padStart(6)}${unbekannt ? `  (${unbekannt} Art(en) nicht in der DB)` : ''}`);
}
console.log(`  ${'zusammen'.padEnd(16)} ${f(sAlt).padStart(8)} € → ${f(sNeu).padStart(8)} €  ${(sAlt > 0 ? Math.round((sNeu / sAlt - 1) * 100) + ' %' : '—').padStart(6)}`);

if (unbelegt.length || unplausibel.length) {
  for (const u of unplausibel) console.log(`  ✗ ${u.name_botanisch}: ${u.grund}`);
  console.log('\nNicht belegte Preise gefunden.');
  process.exit(1);
}
console.log('\nAlle zugeordneten Preise sind durch ein Angebot derselben Art belegt.');
