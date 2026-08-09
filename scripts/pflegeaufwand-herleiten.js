/*
 * Leitet `pflege_sterne` aus den Merkmalen her, die tatsächlich Arbeit verursachen.
 *
 *   node scripts/pflegeaufwand-herleiten.js              nur zeigen
 *   node scripts/pflegeaufwand-herleiten.js --anwenden   schreiben
 *
 * Der bisherige Wert war als Unterscheidung wertlos: 531 von 709 Pflanzen hatten 2 Sterne,
 * 175 einen und DREI drei. Die Auswahl „Pflegeaufwand intensiv" hätte also drei Arten
 * ergeben. Und er korrelierte mit nichts: Bei 1 und 2 Sternen waren Ausläuferbildung,
 * Selbstaussaat und Wuchshöhe fast gleich verteilt.
 *
 * Statt zu raten, wird gezählt, was im Garten wirklich Zeit kostet. Jedes Merkmal ist eine
 * nachvollziehbare Gartenpraxis, kein Gefühl:
 *
 *   Ausläufer treibend      +2   muss eingedämmt und regelmäßig geteilt werden
 *   selbstsäend             +1   Ausputzen vor der Samenreife, sonst sät es sich überall aus
 *   über 120 cm             +1   kann bei Wind und Regen umkippen, braucht ggf. Stütze
 *   feuchter/nasser Boden   +1   muss in Trockenperioden gegossen werden
 *   zweijährig              +1   muss nachgesät oder nachgekauft werden
 *   trockenheitstolerant    −1   kommt ohne Gießen aus
 *   Text nennt „pflegeleicht"/„anspruchslos"/„robust"  −1
 *
 * Die Schwellen sind so gewählt, dass alle drei Stufen besetzt sind — eine Skala, bei der
 * eine Stufe leer bleibt, ist keine Skala.
 */
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const WURZEL = path.join(__dirname, '..');

function aufwand(p) {
  const gruende = [];
  let punkte = 0;
  const wuchs = String(p.wuchs || '');
  const text = String(p.beschreibung || '') + String(p.inhalt_lang || '');

  if (/ausläufer/i.test(wuchs))                  { punkte += 2; gruende.push('treibt Ausläufer'); }
  if (/selbstsäend/i.test(wuchs))                { punkte += 1; gruende.push('sät sich selbst aus'); }
  if (p.hoehe_cm_max >= 120)                     { punkte += 1; gruende.push('über 120 cm, ggf. Stütze'); }
  if (/nass|feucht/i.test(String(p.feuchtigkeit || ''))) { punkte += 1; gruende.push('braucht gleichmäßige Feuchte'); }
  if (p.lebensdauer === 'zweijaehrig')           { punkte += 1; gruende.push('zweijährig'); }
  if (/hoch/i.test(String(p.trockenheitstoleranz || ''))) { punkte -= 1; gruende.push('trockenheitstolerant'); }
  if (/pflegeleicht|anspruchslos|robust/i.test(text))     { punkte -= 1; gruende.push('gilt als pflegeleicht'); }

  const sterne = punkte <= 0 ? 1 : punkte <= 2 ? 2 : 3;
  return { sterne, punkte, gruende };
}

if (require.main === module) {
  const anwenden = process.argv.includes('--anwenden');
  const db = new Database(process.env.DB_PFAD || path.join(WURZEL, 'stauden.db'), { readonly: !anwenden });
  const alle = db.prepare('SELECT * FROM pflanzen').all();

  const neu = alle.map(p => ({ p, ...aufwand(p) }));
  const verteilung = {}, alt = {};
  neu.forEach(x => { verteilung[x.sterne] = (verteilung[x.sterne] || 0) + 1; alt[x.p.pflege_sterne] = (alt[x.p.pflege_sterne] || 0) + 1; });

  console.log('Stufe   bisher   neu');
  [1, 2, 3].forEach(s => console.log(`  ${s}    ${String(alt[s] || 0).padStart(5)}  ${String(verteilung[s] || 0).padStart(5)}`));

  const geaendert = neu.filter(x => x.sterne !== x.p.pflege_sterne);
  console.log(`\nÄnderungen: ${geaendert.length} von ${alle.length}`);
  console.log('\nStichprobe je Stufe:');
  [1, 2, 3].forEach(s => {
    neu.filter(x => x.sterne === s).slice(0, 4).forEach(x =>
      console.log(`  ${s}★  ${String(x.p.name_deutsch).padEnd(30)}${x.gruende.join(', ') || 'keine Auffälligkeit'}`));
  });

  if (!anwenden) { console.log('\nZum Schreiben: --anwenden'); process.exit(0); }

  const schreiben = db.transaction(() => {
    const stmt = db.prepare('UPDATE pflanzen SET pflege_sterne = ? WHERE id = ?');
    geaendert.forEach(x => stmt.run(x.sterne, x.p.id));
  });
  schreiben();

  const beleg = path.join(WURZEL, 'data', `pflegeaufwand-${new Date().toISOString().slice(0, 10)}.json`);
  fs.mkdirSync(path.dirname(beleg), { recursive: true });
  fs.writeFileSync(beleg, JSON.stringify(geaendert.map(x => ({
    id: x.p.id, name: x.p.name_deutsch, alt: x.p.pflege_sterne, neu: x.sterne, punkte: x.punkte, gruende: x.gruende,
  })), null, 2) + '\n');
  console.log(`\n${geaendert.length} Werte geschrieben. Beleg: ${path.relative(WURZEL, beleg)}`);
}

module.exports = { aufwand };
