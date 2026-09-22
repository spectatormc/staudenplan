/*
 * TESTLAUF: Wie sieht ein eigenes WINTERBILD je Staude aus?
 *
 * Hintergrund: Die Pin-Sorte pflanze-winter zeigt heute dasselbe Bild wie der Bluehzeit-Pin —
 * also die Pflanze in Bluete, waehrend der Pin von Winterstruktur spricht. Es gibt je Pflanze
 * nur ein KI-Bild. Dieses Skript prueft, ob sich ein brauchbares Winterbild ueberhaupt
 * erzeugen laesst, BEVOR dafuer eine Spalte, ein Ausgabepfad und eine Pipeline gebaut werden.
 *
 * WAS ES NICHT TUT: Es fasst die Datenbank nicht an — kein bild_vorschlag, kein bild_url,
 * keine Spalte. Die Bilder landen unter public/winterbild-test/ und sind von aussen
 * erreichbar, damit man sie ansehen kann; sie haengen an keinem Pin und an keiner Seite.
 *
 * Ausfuehren:
 *   node scripts/winterbild-test.js                 alle Testpflanzen, beide Fassungen
 *   node scripts/winterbild-test.js --ids=265,598   nur diese
 *   node scripts/winterbild-test.js --fassung=a     nur eine Fassung
 *   node scripts/winterbild-test.js --trocken       nur die Auftraege zeigen, nichts erzeugen
 *
 * WARUM ZWEI FASSUNGEN: Welcher Auftrag ein brauchbares Bild ergibt, ist nicht herleitbar,
 * sondern nur zu sehen. Fassung A beschreibt den ZUSTAND der Pflanze im Winter und verbietet
 * Blueten ausdruecklich; Fassung B beschreibt eine WINTERSZENE mit Raureif und tiefem Licht.
 * Beide bekommen denselben Satz zum Winteraspekt — den, der auch auf der Kachel steht.
 *
 * DIE AUFTRAEGE STEHEN SEIT DEM 22.09.2026 NICHT MEHR HIER, sondern in
 * scripts/winterbild-auftrag.js — zusammen mit der Aspektliste, den Bildparametern und dem
 * Preis. Daraus liest auch der Erzeuger scripts/winterbilder-erzeugen.js. Behielte dieser
 * Testlauf eine eigene Kopie, belegte er nur noch sich selbst: Was man hier ansieht, waere
 * nicht mehr das, was die Produktion erzeugt.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { OpenAI } = require('openai');
const W = require('./winterbild-auftrag');

const argv = process.argv.slice(2);
const wert = n => { const a = argv.find(x => x.startsWith(`--${n}=`)); return a ? a.split('=')[1] : null; };
const TROCKEN = argv.includes('--trocken');
const IDS = (wert('ids') || '').split(',').map(Number).filter(Boolean);
const FASSUNG = (wert('fassung') || '').toLowerCase();

const WURZEL = path.join(__dirname, '..');
const ZIEL = path.join(WURZEL, 'public', 'winterbild-test');
const db = new Database(path.join(WURZEL, 'stauden.db'), { readonly: true });
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const TEST_IDS = [265, 598, 448, 257, 90];
const auswahl = (IDS.length ? IDS : TEST_IDS);
const pflanzen = db.prepare(
  `SELECT id, name_deutsch, name_botanisch, winteraspekt FROM pflanzen WHERE id IN (${auswahl.join(',')})`
).all();

const fassungen = FASSUNG ? [FASSUNG] : Object.keys(W.FASSUNGEN);
console.log(`\n=== Winterbild-Test: ${pflanzen.length} Pflanzen x ${fassungen.length} Fassung(en) ===`);
if (!TROCKEN) console.log(`Geschaetzte Kosten: ~${(pflanzen.length * fassungen.length * W.KOSTEN_JE_BILD).toFixed(2)} $\n`);

fs.mkdirSync(ZIEL, { recursive: true });

(async () => {
  for (const p of pflanzen) {
    // Dieselbe Bedingung wie in der Produktion (kannWinterbild → winterAspekt in pin-saison.js):
    // Was dort keinen Winter-Pin bekommt, wird hier auch nicht erst angesehen.
    if (!W.kannWinterbild(p)) {
      console.log(`[${p.id}] ${p.name_deutsch}: winteraspekt "${p.winteraspekt}" ist kein bekannter Schluessel — uebersprungen.`);
      continue;
    }
    const schluessel = String(p.winteraspekt || '').trim().toLowerCase();
    for (const f of fassungen) {
      const prompt = W.auftrag(p, f);
      const datei = `winter-${f}-${p.id}.jpg`;
      process.stdout.write(`[${p.id}] ${String(p.name_deutsch).padEnd(28)} ${schluessel.padEnd(22)} Fassung ${f.toUpperCase()}  `);
      if (TROCKEN) { console.log('\n    ' + prompt + '\n'); continue; }
      try {
        const resp = await openai.images.generate({ ...W.BILD_PARAMETER, prompt });
        const b64 = resp.data[0].b64_json;
        if (!b64) throw new Error('kein b64_json');
        // Bytes unveraendert auf die Platte — nur so bleibt das C2PA-Manifest erhalten.
        fs.writeFileSync(path.join(ZIEL, datei), Buffer.from(b64, 'base64'));
        console.log(`OK -> /winterbild-test/${datei}`);
      } catch (e) {
        console.log(`FEHLER: ${e.message}`);
      }
      await new Promise(r => setTimeout(r, W.RATE_PAUSE_MS));
    }
  }
  console.log(`\nFertig. Dateien unter ${ZIEL}`);
  db.close();
})();
