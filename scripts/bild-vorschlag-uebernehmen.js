/* Übernimmt Bild-Vorschläge im Stapel — dieselbe Wirkung wie der Knopf „übernehmen" im
 * Admin, aber ohne 79 Klicks.
 *
 * Ausführen:
 *   node scripts/bild-vorschlag-uebernehmen.js --ids=226,231       nur diese
 *   node scripts/bild-vorschlag-uebernehmen.js --alle              alles mit offenem Vorschlag
 *   node scripts/bild-vorschlag-uebernehmen.js --alle --dry-run    nur zeigen
 *
 * WARUM DIESES SKRIPT UND NICHT EINE VIERTE ABLEITUNG: Die Kennzeichnung entsteht
 * ausschließlich in bildFelderAusFund() aus scripts/bild-herkunft.js — derselben Funktion,
 * die /api/bild-approve und /api/ki-bild-ablehnen benutzen. Hier steht nur die Schleife.
 * Wer die Regel ändert, ändert sie dort und trifft alle drei Wege.
 *
 * Reihenfolge im Ablauf „erzeugen → prüfen → übernehmen":
 *   1. node scripts/generate-ki-bilder.js --ids=… --keep-live      Vorschlag anlegen
 *   2. node scripts/check-plant-images.js --vorschlag --ids=…      Vorschlag beurteilen
 *   3. node scripts/bild-vorschlag-uebernehmen.js --ids=…          nur die tragfähigen
 * Schritt 2 ist nicht optional: Ein Vorschlag, den niemand angesehen hat, ist auf einem
 * Pflanzenportal eine Falschauskunft, sobald er die falsche Art zeigt.
 *
 * WO ES NICHTS FINDET: Das Skript prüft die Bildqualität NICHT. Es übernimmt, was man ihm
 * nennt. Die Beurteilung steckt in Schritt 2 und wird hier nur vorausgesetzt.
 */
const path = require('path');
const Database = require('better-sqlite3');
const { bildFelderAusFund, bildHerkunft, BILD_SPALTEN_SQL } = require('./bild-herkunft');

const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const ALLE = args.includes('--alle');
const IDS = (() => {
  const i = args.find(a => a.startsWith('--ids='));
  return i ? i.split('=')[1].split(',').map(Number).filter(Boolean) : null;
})();

if (!ALLE && (!IDS || !IDS.length)) {
  console.error('Bitte --ids=1,2,3 oder --alle angeben.');
  process.exit(1);
}

const db = new Database(process.env.DB_PFAD || path.join(__dirname, '..', 'stauden.db'));

let where = "bild_vorschlag IS NOT NULL AND bild_vorschlag != ''";
if (IDS && IDS.length) where += ` AND id IN (${IDS.join(',')})`;
const zeilen = db.prepare(
  `SELECT id, name_deutsch, name_botanisch, bild_vorschlag, bild_check_info, ${BILD_SPALTEN_SQL}
   FROM pflanzen WHERE ${where} ORDER BY id`
).all();

console.log(`\n=== Vorschläge übernehmen ${DRY ? '[DRY RUN]' : ''} ===`);
console.log(`Gefunden: ${zeilen.length}${IDS ? ` (von ${IDS.length} genannten IDs)` : ''}\n`);

if (IDS) {
  const fehlend = IDS.filter(id => !zeilen.some(z => z.id === id));
  if (fehlend.length) console.log(`Ohne offenen Vorschlag, übersprungen: ${fehlend.join(',')}\n`);
}

const UPDATE = db.prepare(
  `UPDATE pflanzen SET bild_url=?, bild_ki=?, bild_lizenz=?, bild_vorschlag=NULL,
          bild_check_info=NULL, bild_geprueft=1 WHERE id=?`
);

let uebernommen = 0;
const widersprueche = [];
for (const z of zeilen) {
  let info = {};
  try { info = JSON.parse(z.bild_check_info || '{}') || {}; } catch { info = {}; }
  const felder = bildFelderAusFund({ url: z.bild_vorschlag, lizenz: info.lizenz, ki: info.ki === true });

  // Gegenprobe mit der Leseableitung, bevor geschrieben wird: Was die Seite später über das
  // Bild sagen wird, steht hier schon fest. Ein Widerspruch wird gemeldet, nicht geschluckt.
  const h = bildHerkunft({ ...felder, bild_url: z.bild_vorschlag });
  if (h.widerspruch) widersprueche.push(`[${z.id}] ${z.name_botanisch}: ${h.widerspruch}`);

  console.log(`[${z.id}] ${String(z.name_deutsch).padEnd(34)} ${z.bild_url || '(kein Bild)'} -> ${z.bild_vorschlag}`);
  console.log(`      bild_ki ${z.bild_ki} -> ${felder.bild_ki} | Lizenz ${JSON.stringify(z.bild_lizenz)} -> ${JSON.stringify(felder.bild_lizenz)} | Seite sagt: ${h.text || '(nichts)'}`);

  if (!DRY) { UPDATE.run(z.bild_vorschlag, felder.bild_ki, felder.bild_lizenz, z.id); uebernommen++; }
}

console.log(`\n${DRY ? 'Würde übernehmen' : 'Übernommen'}: ${DRY ? zeilen.length : uebernommen}`);
if (widersprueche.length) {
  console.log(`\nWidersprüche (gemeldet, nicht aufgelöst):`);
  for (const w of widersprueche) console.log('  ' + w);
}
db.close();
