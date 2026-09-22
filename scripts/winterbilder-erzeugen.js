/*
 * ERZEUGT DIE WINTERBILDER und schreibt sie nach bild_winter_url.
 *
 * Wozu: Die Pin-Sorte pflanze-winter spricht von Samenstaenden, Graeserstruktur und
 * wintergruenen Rosetten — und zeigte dasselbe Bild wie der Bluehzeit-Pin, also die Pflanze
 * in BLUETE. Es gab je Pflanze nur ein Bild. Dieses Skript erzeugt das zweite.
 *
 * Ausfuehren:
 *   node scripts/winterbilder-erzeugen.js --trocken        nur die Auftraege zeigen, nichts erzeugen
 *   node scripts/winterbilder-erzeugen.js --limit=10       erst einmal zehn
 *   node scripts/winterbilder-erzeugen.js --nur-fehlende   Wiederaufnahme nach Abbruch
 *   node scripts/winterbilder-erzeugen.js --ids=265,598    genau diese Pflanzen
 *   node scripts/winterbilder-erzeugen.js --fassung=b      Bildauftrag B statt der Vorgabe A
 *
 * WAS GESCHRIEBEN WIRD, UND WAS NICHT:
 * Geschrieben wird AUSSCHLIESSLICH bild_winter_url. NICHT bild_url, NICHT bild_ki, NICHT
 * bild_lizenz und NICHT bild_vorschlag — die beschreiben das Bild, das auf der PFLANZENSEITE
 * ausgeliefert wird (scripts/bild-herkunft.js), und daran aendert ein Winterbild nichts. Das
 * ist dieselbe Trennung, die scripts/generate-ki-bilder.js seit 09/2026 durchhaelt: Ein Bild,
 * das anderswo benutzt wird, darf die Aussage ueber das ausgelieferte Bild nicht verstellen.
 *
 * WARUM ES KEINEN FREIGABESCHRITT GIBT (anders als bei generate-ki-bilder.js):
 * Ein KI-Bild fuer die Pflanzenseite ersetzt ein vorhandenes Bild und geht sofort an alle
 * Besucher — deshalb liegt es erst als bild_vorschlag daneben und wird von Hand uebernommen.
 * Ein Winterbild ersetzt nichts: Es wird nur in Pins gezeichnet, die noch nicht faellig sind
 * (fruehester Termin 01.11.2026), und jeder dieser Pins durchlaeuft vor der Veroeffentlichung
 * ohnehin npm run ci:daten. Die Beurteilung macht der eigene Modus
 * `node scripts/check-plant-images.js --winter` — der schreibt nie und ist damit der
 * Freigabeschritt, nur an der richtigen Stelle.
 *
 * DIE BYTES GEHEN UNVERAENDERT AUF DIE PLATTE. Kein Skalieren, kein Neukodieren: Nur so
 * bleibt das C2PA-Manifest von OpenAI in der Datei. Die Bildparameter kommen aus
 * scripts/winterbild-auftrag.js, damit Testlauf und Produktion dasselbe Bild erzeugen.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const W = require('./winterbild-auftrag');
// Der Pool der Pin-Pflanzen. Aus demselben Lader holt pins-erzeugen.js die Pflanzen fuer die
// Sorte pflanze-winter — wer hier ein Bild bekommt, bekommt dort einen Pin.
const saison = require('./pin-saison');

const WURZEL = path.join(__dirname, '..');
const BILD_ORDNER = path.join(WURZEL, 'public', 'images', 'pflanzen');

const argv = process.argv.slice(2);
const wert = n => { const a = argv.find(x => x.startsWith(`--${n}=`)); return a ? a.split('=').slice(1).join('=') : null; };
const TROCKEN = argv.includes('--trocken');
const NUR_FEHLENDE = argv.includes('--nur-fehlende');
const IDS = (wert('ids') || '').split(',').map(Number).filter(Boolean);
const LIMIT = Number(wert('limit')) || 0;
const FASSUNG = (wert('fassung') || W.FASSUNG_VORGABE).toLowerCase();

if (!W.FASSUNGEN[FASSUNG]) {
  console.error(`Unbekannte Fassung "${FASSUNG}" — bekannt sind: ${Object.keys(W.FASSUNGEN).join(', ')}`);
  process.exit(1);
}

/* DB_PFAD wird geachtet wie in den uebrigen Pin-Skripten (pin-saison.js, pins-erzeugen.js):
 * So laesst sich der Lauf gegen eine nachgestellte Datenbank trocken pruefen, ohne die
 * produktive anzufassen. Geoeffnet wird SCHREIBEND — dieser Lauf setzt bild_winter_url. */
const DB_DATEI = process.env.DB_PFAD || path.join(WURZEL, 'stauden.db');
const db = new Database(DB_DATEI);

/* Spalte anlegen, falls die Datenbank sie noch nicht fuehrt. Die MASSGEBLICHE Liste steht in
 * stauden-server.js ("Schema-Migrationen, idempotent") und laeuft bei jedem Serverstart; hier
 * steht sie nur als Notbehelf, damit dieser Lauf auch auf einer Datenbank durchkommt, auf der
 * der Server seit der Aenderung nicht gestartet ist. Wer eine Spalte ergaenzt, traegt sie
 * dort ein, nicht nur hier. */
try { db.exec(`ALTER TABLE pflanzen ADD COLUMN ${W.WINTERBILD_SPALTE} TEXT`); }
catch (e) { if (!/duplicate column/i.test(e.message)) throw e; }

// ─── Auswahl ─────────────────────────────────────────────────────────────────
/*
 * DIE AUSWAHL IST DIESELBE WIE DIE DER SORTE pflanze-winter, nicht eine aehnliche:
 * der Pin-Pool (saison.ladePflanzen: bild_ki=1, eigener deutscher Name, Beetstaude, hier
 * winterhart, Bilddatei vorhanden) UND ein winteraspekt aus WINTER_WERT (W.kannWinterbild).
 * Ein Winterbild fuer eine Pflanze ohne Winter-Pin waere bezahltes Nichts.
 *
 * --ids setzt den POOL ausser Kraft, nicht die Aspektbedingung: Wer eine Id nennt, will genau
 * diese Pflanze (so haelt es auch generate-ki-bilder.js). Ohne Winteraspekt gibt es aber
 * keinen Bildauftrag — dann wuerde geraten, was im Winter zu sehen ist. Gemeldet wird beides.
 */
const felder = `id, name_deutsch, name_botanisch, winteraspekt, bild_url, ${W.WINTERBILD_SPALTE}`;
let kandidaten;
if (IDS.length) {
  const poolIds = new Set(saison.ladePflanzen(db).map(p => p.id));
  kandidaten = db.prepare(`SELECT ${felder} FROM pflanzen WHERE id IN (${IDS.join(',')})`).all();
  for (const id of IDS) if (!kandidaten.some(p => p.id === id)) console.log(`  ! Id ${id}: in der Datenbank nicht gefunden.`);
  for (const p of kandidaten) {
    if (!poolIds.has(p.id)) console.log(`  ! [${p.id}] ${p.name_deutsch}: steht nicht im Pin-Pool — bekommt keinen Winter-Pin, das Bild waere ungenutzt.`);
  }
} else {
  kandidaten = saison.ladePflanzen(db);
}

const ohneAspekt = kandidaten.filter(p => !W.kannWinterbild(p));
for (const p of ohneAspekt) {
  console.log(`  ! [${p.id}] ${p.name_deutsch}: winteraspekt "${p.winteraspekt || ''}" ist kein Schluessel aus WINTER_WERT — uebersprungen.`);
}
let auswahl = kandidaten.filter(p => W.kannWinterbild(p));

/* "Vorhanden" heisst: Spalte gesetzt UND Datei da. Ein Eintrag ohne Datei ist ein
 * abgebrochener Lauf, kein fertiges Bild — den nimmt die Wiederaufnahme mit. */
const hatWinterbild = p => {
  const url = String(p[W.WINTERBILD_SPALTE] || '').trim();
  return Boolean(url) && fs.existsSync(path.join(WURZEL, 'public', url.replace(/^\//, '')));
};
const schonDa = auswahl.filter(hatWinterbild);
if (NUR_FEHLENDE) auswahl = auswahl.filter(p => !hatWinterbild(p));
if (LIMIT) auswahl = auswahl.slice(0, LIMIT);

const kosten = (auswahl.length * W.KOSTEN_JE_BILD).toFixed(2);
console.log(`\n=== Winterbilder erzeugen — Fassung ${FASSUNG.toUpperCase()}${TROCKEN ? ' [TROCKEN]' : ''} ===`);
console.log(`Datenbank: ${DB_DATEI}`);
console.log(`Kandidaten mit Winteraspekt: ${kandidaten.length - ohneAspekt.length}, davon mit fertigem Winterbild: ${schonDa.length}`);
console.log(`Zu erzeugen: ${auswahl.length} Bild(er)  ·  geschaetzte Kosten: ~${kosten} $ (${auswahl.length} x ${W.KOSTEN_JE_BILD.toFixed(2)} $)`);
if (!NUR_FEHLENDE && schonDa.length && !LIMIT) {
  console.log(`Hinweis: ${schonDa.length} davon haben schon ein Winterbild und werden NEU erzeugt (kostet erneut).`);
  console.log('         Mit --nur-fehlende werden sie uebersprungen — das ist die Wiederaufnahme nach einem Abbruch.');
}
console.log('');

if (!auswahl.length) { db.close(); process.exit(0); }

/* Der Schluessel wird erst gebraucht, wenn wirklich erzeugt wird. So laeuft --trocken auch
 * auf einem Rechner ohne OPENAI_API_KEY durch — und genau dort wird der Auftrag gelesen. */
const openai = TROCKEN ? null : new (require('openai').OpenAI)({ apiKey: process.env.OPENAI_API_KEY });
const SETZE = db.prepare(`UPDATE pflanzen SET ${W.WINTERBILD_SPALTE} = ? WHERE id = ?`);

if (!TROCKEN) fs.mkdirSync(BILD_ORDNER, { recursive: true });

(async () => {
  let erzeugt = 0, fehler = 0;
  for (const p of auswahl) {
    const prompt = W.auftrag(p, FASSUNG);
    const url = W.winterbildPfad(p);
    const schluessel = saison.winterSchluessel(p);
    process.stdout.write(`[${p.id}] ${String(p.name_deutsch).padEnd(30)} ${schluessel.padEnd(22)} `);

    if (TROCKEN) {
      console.log(`-> ${url}`);
      console.log(`    ${prompt}\n`);
      continue;
    }

    try {
      const resp = await openai.images.generate({ ...W.BILD_PARAMETER, prompt });
      const b64 = resp.data[0].b64_json;
      if (!b64) throw new Error('kein b64_json in der Antwort');
      // Unveraendert wegschreiben — siehe Kopf (C2PA).
      fs.writeFileSync(path.join(BILD_ORDNER, W.winterbildDatei(p)), Buffer.from(b64, 'base64'));
      SETZE.run(url, p.id);
      erzeugt++;
      console.log(`OK -> ${url}`);
    } catch (e) {
      fehler++;
      console.log(`FEHLER: ${e.message}`);
    }
    await new Promise(r => setTimeout(r, W.RATE_PAUSE_MS));   // 5 Bilder/Minute
  }

  console.log('\n---');
  if (TROCKEN) {
    console.log(`Trockenlauf: ${auswahl.length} Auftraege gezeigt, nichts erzeugt, nichts geschrieben.`);
    console.log(`Ein echter Lauf kostete ~${kosten} $.`);
  } else {
    console.log(`${erzeugt} Winterbild(er) erzeugt, ${fehler} Fehler.`);
    console.log(`Kosten dieses Laufs: ~${(erzeugt * W.KOSTEN_JE_BILD).toFixed(2)} $ (${erzeugt} x ${W.KOSTEN_JE_BILD.toFixed(2)} $).`);
    const gesamt = db.prepare(`SELECT COUNT(*) AS n FROM pflanzen WHERE ${W.WINTERBILD_SPALTE} IS NOT NULL AND ${W.WINTERBILD_SPALTE} != ''`).get().n;
    console.log(`In der Datenbank stehen jetzt ${gesamt} Winterbilder.`);
    console.log('Naechste Schritte: beurteilen mit  node scripts/check-plant-images.js --winter');
    console.log('                   in die Pins mit node scripts/pins-erzeugen.js --neu-unveroeffentlicht');
    if (fehler) process.exitCode = 1;
  }
  db.close();
})();
