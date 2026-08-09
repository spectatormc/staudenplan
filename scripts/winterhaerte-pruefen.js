/*
 * Vergleicht das Feld `winterhart_zone` mit dem, was die Pflanze im eigenen Fließtext sagt.
 *
 *   node scripts/winterhaerte-pruefen.js
 *
 * Die ausführlichen Texte (`inhalt_lang`) enthalten bei vielen Arten einen Satz wie
 * „ist bis circa -15°C winterhart (Zone 7)". Beides — Temperatur und Zone — steht damit
 * ZWEIMAL in der Datenbank, an zwei Stellen, die zu verschiedenen Zeiten entstanden sind.
 * Wo sie sich widersprechen, ist mindestens eine Angabe falsch, und das lässt sich ohne
 * jede externe Quelle feststellen.
 *
 * Anlass: Santolina chamaecyparissus steht im Feld auf Zone 6, im eigenen Text auf Zone 7.
 *
 * Zonen-Untergrenzen nach USDA, in °C:
 *   Zone 3 −40 · 4 −34 · 5 −29 · 6 −23 · 7 −18 · 8 −12 · 9 −7 · 10 −1
 */
const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(process.env.DB_PFAD || path.join(__dirname, '..', 'stauden.db'), { readonly: true });

const ZONE_MIN = { 3: -40, 4: -34, 5: -29, 6: -23, 7: -18, 8: -12, 9: -7, 10: -1 };
// Zu welcher Zone gehört eine Frosthärte-Angabe in °C? Die Zone, deren Bereich sie trifft.
function zoneAusGrad(grad) {
  const stufen = Object.entries(ZONE_MIN).map(([z, g]) => [Number(z), g]).sort((a, b) => a[1] - b[1]);
  for (let i = 0; i < stufen.length; i++) {
    const [z, g] = stufen[i], naechste = stufen[i + 1];
    if (grad >= g && (!naechste || grad < naechste[1])) return z;
  }
  return null;
}

const alle = db.prepare(`SELECT id, name_deutsch, name_botanisch, winterhart_zone, inhalt_lang
                         FROM pflanzen WHERE inhalt_lang IS NOT NULL AND TRIM(inhalt_lang) <> ''`).all();

const abweichung = [], nurGrad = [], keineAngabe = [];

for (const p of alle) {
  const text = String(p.inhalt_lang);
  const zoneImText = (text.match(/Zone\s*(\d{1,2})/i) || [])[1];
  // „bis -25°C", „bis circa −15 °C", „bis etwa -28 Grad"
  const gradImText = (text.match(/bis\s+(?:zu\s+|circa\s+|etwa\s+|ca\.?\s+)?[-–−]\s*(\d{1,2})\s*(?:°\s*C|Grad)/i) || [])[1];

  if (!zoneImText && !gradImText) { keineAngabe.push(p); continue; }

  const feld = p.winterhart_zone;
  if (zoneImText) {
    const z = Number(zoneImText);
    if (z !== feld) abweichung.push({ p, feld, textZone: z, grad: gradImText ? -Number(gradImText) : null });
  } else {
    const z = zoneAusGrad(-Number(gradImText));
    if (z && z !== feld) nurGrad.push({ p, feld, grad: -Number(gradImText), abgeleitet: z });
  }
}

console.log(`${alle.length} Pflanzen mit ausführlichem Text geprüft\n`);

console.log(`■ Feld und eigener Text nennen VERSCHIEDENE Zonen: ${abweichung.length}`);
abweichung.sort((a, b) => (b.textZone - b.feld) - (a.textZone - a.feld)).forEach(a => {
  console.log(`   ${String(a.p.id).padStart(4)}  ${String(a.p.name_deutsch).padEnd(30)}${String(a.p.name_botanisch).padEnd(32)}`
            + `Feld: Zone ${a.feld}  ↔  Text: Zone ${a.textZone}${a.grad ? ` (${a.grad} °C)` : ''}`);
});

console.log(`\n■ Nur eine Temperatur im Text, daraus abgeleitete Zone weicht ab: ${nurGrad.length}`);
nurGrad.forEach(a => {
  console.log(`   ${String(a.p.id).padStart(4)}  ${String(a.p.name_deutsch).padEnd(30)}`
            + `Feld: Zone ${a.feld}  ↔  Text: ${a.grad} °C → Zone ${a.abgeleitet}`);
});

console.log(`\n■ Text ohne jede Winterhärte-Angabe: ${keineAngabe.length}`);
console.log(`\n${'─'.repeat(70)}`);
console.log(`Widersprüche insgesamt: ${abweichung.length + nurGrad.length} von ${alle.length - keineAngabe.length} prüfbaren Texten`);
