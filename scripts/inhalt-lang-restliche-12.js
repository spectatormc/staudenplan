/*
 * Spielt die überarbeiteten Pflegeraster für die letzten 12 Pflanzen ein, deren inhalt_lang
 * noch Freitext war (die übrigen 697 wurden am 2026-08-06 umgestellt).
 *
 *   node scripts/inhalt-lang-restliche-12.js <felder.json> [--anwenden]
 *
 * Ohne --anwenden nur Vorschau. Eingabe ist eine Liste
 *   [{ id, pflanzzeit, giessen, duengen, rueckschnitt, ueberwinterung, kombinationen, fehler, tipp }, …]
 *
 * pflanzabstand wird NICHT aus der Eingabe übernommen, sondern hier aus der Endbreite gerechnet
 * (scripts/pflanzen-regeln.js). Grund: Das Feld steuert über pflanzabstand_cm den Abstand in der
 * SVG-Draufsicht — ein generierter Wert würde eine funktionierende Heuristik still ersetzen.
 * Beim großen Lauf im Juli trugen 276 von 285 Einträgen denselben Wert, weil im Prompt ein
 * Beispiel stand.
 *
 * Vor dem Schreiben laufen vier mechanische Tore:
 *   1. verstoesse() aus dem Regelmodul (zweite Blüte bei nicht remontierenden Arten,
 *      cm-Angaben im falschen Feld, umgedrehte Wirkungsrichtung bei Aussaat/Ausbreitung)
 *   2. Giftigkeit gesetzt → Hinweis muss in tipp oder fehler vorkommen
 *   3. Kombinationspartner müssen als Pflanze in der Datenbank existieren
 *   4. Die Zeile muss noch Freitext sein — wurde sie zwischenzeitlich geändert, wird sie
 *      übersprungen statt überschrieben
 */
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const R = require('./pflanzen-regeln.js');
const G = require('./pflanzen-giftigkeit.js');

const eingabe = process.argv[2];
const anwenden = process.argv.includes('--anwenden');
if (!eingabe) {
  console.error('Aufruf: node scripts/inhalt-lang-restliche-12.js <felder.json> [--anwenden]');
  process.exit(1);
}

const db = new Database(process.env.DB_PFAD || path.join(__dirname, '..', 'stauden.db'));
const felderListe = JSON.parse(fs.readFileSync(eingabe, 'utf8'));

const alleNamen = new Set(db.prepare('SELECT name_botanisch FROM pflanzen').all().map(r => r.name_botanisch.toLowerCase()));
const istFreitext = (s) => { try { const j = JSON.parse(s); return !(j && typeof j === 'object' && j.pflanzzeit); } catch { return true; } };

// Feldreihenfolge wie in den bestehenden 697 Einträgen.
const REIHENFOLGE = ['pflanzzeit', 'pflanzabstand', 'giessen', 'duengen', 'rueckschnitt',
                     'ueberwinterung', 'kombinationen', 'fehler', 'tipp'];

let geschrieben = 0;
const abgelehnt = [];

for (const f of felderListe) {
  const p = db.prepare('SELECT * FROM pflanzen WHERE id = ?').get(f.id);
  if (!p) { abgelehnt.push([f.id, 'Pflanze nicht gefunden']); continue; }
  if (!istFreitext(p.inhalt_lang)) { abgelehnt.push([f.id, 'inhalt_lang ist bereits Schema — übersprungen']); continue; }

  const felder = {
    pflanzzeit: f.pflanzzeit,
    pflanzabstand: R.pflanzabstandRechnen(p),   // deterministisch, nie aus der Eingabe
    giessen: f.giessen,
    duengen: f.duengen,
    rueckschnitt: f.rueckschnitt,
    ueberwinterung: f.ueberwinterung,
    kombinationen: f.kombinationen,
    fehler: f.fehler,
    tipp: f.tipp,
  };

  const maengel = [];

  const v = R.verstoesse(felder, p);
  if (v.length) maengel.push(...v.map(x => 'Regelverstoß: ' + x));

  const gift = G.giftigkeit(p.name_botanisch);
  if (gift) {
    const text = (felder.tipp || '') + ' ' + (felder.fehler || []).join(' ');
    if (!/gift|toxisch|reizend|nicht verzehren|hautreiz/i.test(text)) {
      maengel.push(`Giftigkeit gepflegt (${gift.stufe || 'ja'}), aber kein Hinweis in tipp/fehler`);
    }
  }

  for (const k of (felder.kombinationen || [])) {
    if (!alleNamen.has(String(k.name_botanisch || '').toLowerCase())) {
      maengel.push(`Kombinationspartner nicht in der Datenbank: ${k.name_botanisch}`);
    }
  }

  if (maengel.length) { abgelehnt.push([f.id, maengel.join(' | ')]); continue; }

  const json = JSON.stringify(Object.fromEntries(REIHENFOLGE.map(k => [k, felder[k]])));
  console.log(`\n${p.id}  ${p.name_botanisch}  (${p.name_deutsch})`);
  console.log(`   Abstand (gerechnet): ${felder.pflanzabstand}`);
  console.log(`   ${Object.keys(felder).length} Felder, ${json.length} Zeichen, ${felder.kombinationen.length} Partner, ${felder.fehler.length} Fehlerpunkte`);
  if (anwenden) { db.prepare('UPDATE pflanzen SET inhalt_lang = ? WHERE id = ?').run(json, p.id); geschrieben++; }
}

if (abgelehnt.length) {
  console.log('\n=== ABGELEHNT ===');
  abgelehnt.forEach(([id, grund]) => console.log(`  ${id}: ${grund}`));
}

console.log(`\n=== ${anwenden ? 'ANGEWANDT' : 'VORSCHAU'} === geschrieben: ${geschrieben}, abgelehnt: ${abgelehnt.length}`);

// Gegenkontrolle: wie viele Zeilen sind jetzt noch Freitext?
const rest = db.prepare('SELECT id, name_botanisch, inhalt_lang FROM pflanzen').all().filter(r => istFreitext(r.inhalt_lang));
console.log(`Noch Freitext in der Datenbank: ${rest.length}`);
rest.forEach(r => console.log(`  ${r.id} ${r.name_botanisch}`));

process.exit(abgelehnt.length ? 1 : 0);
