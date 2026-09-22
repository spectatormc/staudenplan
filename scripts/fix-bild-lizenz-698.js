/*
 * Einmalige Datenkorrektur: bild_lizenz von id 698 (Bergenia 'Silberlicht').
 *
 * Befund (Produktionsdaten, 21.09.2026):
 *   Die Zeile trägt bild_ki = 1, aber bild_lizenz = 'Pixabay License'. Es ist die EINZIGE
 *   Zeile mit dieser Kombination — die übrigen 298 KI-Bilder stehen auf 'DALL-E 3 / OpenAI'
 *   (215) oder 'KI-generiert / OpenAI' (83).
 *
 * Warum bild_ki richtig ist und bild_lizenz falsch:
 *   - Die Datei heißt ki-weisse-bergenie-698.jpg. Dieses Namensmuster vergeben ausschließlich
 *     die Bildgeneratoren (scripts/generate-ki-bilder.js, scripts/fix-live-broken-images.js).
 *   - Die Datei trägt ein C2PA-Manifest, also die Herkunftssignatur des Generators.
 *   Ein Pixabay-Foto hätte weder das eine noch das andere. Die Lizenzangabe ist offensichtlich
 *   ein Rest aus dem vorherigen Bild derselben Zeile (das Bild wurde ersetzt, die Lizenz nicht).
 *
 * Warum die Korrektur überhaupt nötig ist, obwohl die Ausgabe bereits stimmt:
 *   Die Kennzeichnung auf der Website folgt bild_ki (scripts/bild-herkunft.js) und zeigt für
 *   diese Zeile schon heute "KI-erzeugte Illustration". Falsch ist trotzdem der Datensatz:
 *   Er behauptet an einem KI-Bild eine Fotolizenz, und jede spätere Auswertung, die auf
 *   bild_lizenz statt bild_ki schaut, zählt ihn wieder falsch. bildHerkunft() meldet die
 *   Zeile deshalb bis dahin als Widerspruch im Server-Log.
 *
 * AUSFÜHRUNG:
 *   Gehört auf die produktive Datenbank auf dem Server. Die lokale stauden.db ist ein
 *   veralteter Teilstand (226 statt 711 Zeilen, keine Zeile mit bild_ki=1) — dort ist nichts
 *   zu korrigieren, und eine Ausführung dort belegt auch nichts.
 *   Aufruf:  node scripts/fix-bild-lizenz-698.js          (nur prüfen und anzeigen)
 *            node scripts/fix-bild-lizenz-698.js --schreiben   (Änderung schreiben)
 *   Ohne --schreiben wird NICHTS geschrieben. Geschrieben wird außerdem nur, wenn die Zeile
 *   tatsächlich so aussieht wie oben beschrieben — nicht blind nach id.
 */
'use strict';

const Database = require('better-sqlite3');
const path = require('path');

const ID = 698;
const NEUE_LIZENZ = 'KI-generiert / OpenAI';

const db = new Database(path.join(__dirname, '..', 'stauden.db'));
const schreiben = process.argv.includes('--schreiben');

const p = db.prepare('SELECT id, name_deutsch, name_botanisch, bild_url, bild_ki, bild_lizenz FROM pflanzen WHERE id = ?').get(ID);

if (!p) {
  console.error(`Keine Zeile mit id ${ID} in dieser Datenbank — vermutlich die lokale Teilkopie. Abbruch.`);
  process.exit(1);
}

console.log(`[${p.id}] ${p.name_deutsch} (${p.name_botanisch})`);
console.log(`  bild_url    : ${p.bild_url}`);
console.log(`  bild_ki     : ${p.bild_ki}`);
console.log(`  bild_lizenz : ${p.bild_lizenz}`);

// Gegenproben, bevor geschrieben wird. Jede einzelne muss zutreffen, sonst ist es nicht der
// Fall, für den dieses Skript geschrieben wurde.
const proben = [
  [p.bild_ki === 1, 'bild_ki ist 1'],
  [/bergenia/i.test(p.name_botanisch || ''), 'name_botanisch ist eine Bergenie'],
  [/\/ki-[^/]*$/i.test(p.bild_url || ''), 'Dateiname beginnt mit "ki-"'],
  [p.bild_lizenz !== NEUE_LIZENZ, 'bild_lizenz steht noch nicht auf dem KI-Wert'],
];
const durchgefallen = proben.filter(([ok]) => !ok).map(([, was]) => was);

if (durchgefallen.length) {
  console.error('\nAbbruch — diese Erwartungen treffen nicht zu:');
  for (const d of durchgefallen) console.error(`  - ${d}`);
  console.error('Die Zeile ist nicht (mehr) der beschriebene Fall. Erst prüfen, dann anpassen.');
  process.exit(1);
}

if (!schreiben) {
  console.log(`\nWürde setzen: bild_lizenz = "${NEUE_LIZENZ}" (bild_ki bleibt 1, bild_url bleibt unverändert).`);
  console.log('Zum Schreiben erneut mit --schreiben aufrufen.');
  process.exit(0);
}

const info = db.prepare('UPDATE pflanzen SET bild_lizenz = ? WHERE id = ?').run(NEUE_LIZENZ, ID);
console.log(`\nGeändert: ${info.changes} Zeile(n). bild_lizenz = "${NEUE_LIZENZ}".`);
