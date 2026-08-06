// Überführt die Prosa-Einträge in pflanzen.inhalt_lang ins Feldschema.
//
// Hintergrund: /pflanze/:slug liest inhalt_lang per JSON.parse. 288 der 713 Zeilen enthalten
// aber Fließtext. Diese Seiten zeigen deshalb kein Pflegeraster und nur 3 statt 7 FAQ-Einträge
// (die vier fehlenden hängen an pflanzabstand/pflanzzeit/rueckschnitt/ueberwinterung).
// Gemessener Unterschied: 0,202 Google-Einstiege pro JSON-Seite gegen 0,094 pro Prosa-Seite.
//
// Methode: Die Pflegefelder werden aus den Stammdaten GENERIERT, nicht aus dem Prosatext
// extrahiert. Grund: ein Probelauf mit reiner Extraktion lieferte nur 2 von 7 Feldern — die
// Prosa beschreibt Herkunft, Wuchsform und Kombinationsideen, keine Pflege. Generieren ist
// zugleich der Weg, auf dem die anderen 425 Einträge entstanden sind (scripts/enrich-plant-pages.js,
// gpt-4o aus Stammdaten). Der vorhandene Text geht als Zusatzkontext in den Prompt und bleibt
// als "freitext" in der DB stehen — die Umstellung ist damit verlustfrei umkehrbar.
//
// Ausführen (immer erst gegen eine Kopie, nie direkt gegen die Produktions-DB):
//   node scripts/inhalt-lang-nach-schema.js --db=/pfad/zur/kopie.db --limit=5 --dry-run
//   node scripts/inhalt-lang-nach-schema.js --db=/pfad/zur/kopie.db
//   node scripts/inhalt-lang-nach-schema.js --db=/pfad/zur/kopie.db --export=updates.json
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const Database = require('better-sqlite3');
const { OpenAI } = require('openai');
const path = require('path');
const fs = require('fs');

const args = process.argv.slice(2);
const opt = (name, fallback = null) => {
  const a = args.find(x => x.startsWith(`--${name}=`));
  return a ? a.split('=').slice(1).join('=') : fallback;
};
const DRY_RUN = args.includes('--dry-run');
const DB_PFAD = opt('db', path.join(__dirname, '..', 'stauden.db'));
const LIMIT = opt('limit') ? parseInt(opt('limit'), 10) : null;
const EXPORT = opt('export');
// gpt-4o wie bei den bestehenden 425 Einträgen (enrich-plant-pages.js): der Katalog soll
// einheitlich klingen, und bei 288 einmaligen Aufrufen fällt der Preisunterschied nicht ins Gewicht.
const MODELL = opt('model', 'gpt-4o');

const db = new Database(DB_PFAD);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ── Auswahl: nur Zeilen, deren inhalt_lang kein gültiges JSON ist ────────────
const alle = db.prepare(`
  SELECT id, name_deutsch, name_botanisch, licht, boden, feuchtigkeit, bluehzeit,
         hoehe_cm_min, hoehe_cm_max, winterhart_zone, inhalt_lang
  FROM pflanzen WHERE inhalt_lang IS NOT NULL AND inhalt_lang != ''
`).all();

const offen = alle.filter(p => {
  try { JSON.parse(p.inhalt_lang); return false; } catch { return true; }
});
const arbeitsliste = LIMIT ? offen.slice(0, LIMIT) : offen;

console.log(`${offen.length} Prosa-Zeilen gefunden, ${arbeitsliste.length} werden verarbeitet (Modell ${MODELL}${DRY_RUN ? ', DRY-RUN' : ''}).`);

// ── Feldschema ───────────────────────────────────────────────────────────────
// Bewusst OHNE "kombinationen": Kombinationspartner aus einem Pflegetext zu erraten hieße,
// Pflanzenpaarungen zu erfinden. Die Seite hat dafür bereits die Sektion "Passt gut zu",
// die aus der separaten, kuratierten Spalte kombinationspartner gespeist wird.
const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    pflanzzeit:     { type: ['string', 'null'] },
    pflanzabstand:  { type: ['string', 'null'] },
    giessen:        { type: ['string', 'null'] },
    duengen:        { type: ['string', 'null'] },
    rueckschnitt:   { type: ['string', 'null'] },
    ueberwinterung: { type: ['string', 'null'] },
    tipp:           { type: ['string', 'null'] },
    fehler:         { type: 'array', items: { type: 'string' } },
  },
  required: ['pflanzzeit', 'pflanzabstand', 'giessen', 'duengen', 'rueckschnitt', 'ueberwinterung', 'tipp', 'fehler'],
};

const SYSTEM = `Du bist ein erfahrener deutscher Staudenspezialist und schreibst Pflegeinformationen
für eine Pflanzendatenbank.

Regeln:
- Je Feld 1-2 vollständige deutsche Sätze, gärtnerisch präzise, praxisnah, ohne Marketingfloskeln.
- Die Angaben müssen zu den gelieferten Stammdaten passen (Licht, Boden, Feuchtigkeit, Höhe,
  Blütezeit). Widersprich ihnen nicht.
- Der mitgelieferte vorhandene Text beschreibt dieselbe Pflanze. Nimm Herkunft, Wuchsform und
  Verwendungshinweise daraus auf, wo sie zum Feld passen, und widersprich ihm nicht.
- Bist du dir bei einer Art unsicher, bleib bei der gattungstypischen Praxis statt zu erfinden.
  Lieber null als eine falsche Angabe.
- "pflanzabstand": Format exakt "35-45 cm" plus erklärender Satz. Die Spanne muss zur
  angegebenen Wuchshöhe und Wuchsform passen.
- "fehler": die 2-3 häufigsten Pflegefehler bei dieser Pflanze, jeweils ein Satz.`;

// ── Validierung ──────────────────────────────────────────────────────────────
// pflanzabstand ist kein reines Textfeld: stauden-server.js liest daraus per Regex
// pflanzabstand_cm und steuert damit den Abstand in der SVG-Draufsicht. Fehlt der Wert,
// greift eine Heuristik aus der Wuchshöhe. Ein falscher Wert würde diese funktionierende
// Heuristik still ersetzen — deshalb nur übernehmen, wenn er plausibel dazu passt.
function pflanzabstandPruefen(text, pflanze) {
  if (!text) return null;
  const m = String(text).match(/(\d+)\s*[–\-]\s*(\d+)?\s*cm/i);
  if (!m) return null;                       // ohne parsebare Zahl bringt das Feld dem Layout nichts
  const wert = m[2] ? Math.round((parseInt(m[1]) + parseInt(m[2])) / 2) : parseInt(m[1]);
  if (!(wert >= 10 && wert <= 120)) return null;
  const hoehe = pflanze.hoehe_cm_max || pflanze.hoehe_cm_min || 50;
  const heuristik = Math.max(20, Math.min(90, hoehe * 0.55 + 10));
  const faktor = wert / heuristik;
  if (faktor < 0.4 || faktor > 2.5) {
    console.log(`  ! pflanzabstand verworfen (${wert} cm gegen Heuristik ${Math.round(heuristik)} cm)`);
    return null;
  }
  return text;
}

const satzOk = (s) => typeof s === 'string' && s.trim().length >= 15 && s.trim().length <= 600;

function ergebnisPruefen(roh, pflanze) {
  const sauber = {};
  for (const feld of ['pflanzzeit', 'giessen', 'duengen', 'rueckschnitt', 'ueberwinterung', 'tipp']) {
    if (satzOk(roh[feld])) sauber[feld] = roh[feld].trim();
  }
  const abstand = pflanzabstandPruefen(roh.pflanzabstand, pflanze);
  if (abstand && satzOk(abstand)) sauber.pflanzabstand = abstand.trim();
  if (Array.isArray(roh.fehler)) {
    const f = roh.fehler.filter(x => satzOk(x)).map(x => x.trim()).slice(0, 5);
    if (f.length) sauber.fehler = f;
  }
  return sauber;
}

// ── Lauf ─────────────────────────────────────────────────────────────────────
const UPDATE = db.prepare('UPDATE pflanzen SET inhalt_lang = ? WHERE id = ?');
const updates = [];
let ok = 0, zuDuenn = 0, fehlgeschlagen = 0;

(async () => {
  for (const [i, p] of arbeitsliste.entries()) {
    const stammdaten = [
      `Botanisch: ${p.name_botanisch}`,
      p.licht && `Licht: ${p.licht}`,
      p.boden && `Boden: ${p.boden}`,
      p.feuchtigkeit && `Feuchtigkeit: ${p.feuchtigkeit}`,
      p.bluehzeit && `Blütezeit: ${p.bluehzeit}`,
      (p.hoehe_cm_min || p.hoehe_cm_max) && `Höhe: ${p.hoehe_cm_min || '?'}-${p.hoehe_cm_max || '?'} cm`,
    ].filter(Boolean).join('\n');

    let antwort;
    for (let versuch = 1; versuch <= 3; versuch++) {
      try {
        const res = await openai.chat.completions.create({
          model: MODELL,
          temperature: 0.2,
          messages: [
            { role: 'system', content: SYSTEM },
            { role: 'user', content: `Pflanze: ${p.name_deutsch}\n${stammdaten}\n\nVorhandene Beschreibung dieser Pflanze (als Kontext, nicht als einzige Quelle):\n"""\n${p.inhalt_lang}\n"""` },
          ],
          response_format: { type: 'json_schema', json_schema: { name: 'pflegefelder', strict: true, schema: SCHEMA } },
        });
        antwort = JSON.parse(res.choices[0].message.content);
        break;
      } catch (e) {
        if (versuch === 3) { console.log(`  ✗ ${p.name_deutsch}: ${e.message}`); fehlgeschlagen++; }
        else await new Promise(r => setTimeout(r, 1200 * versuch));
      }
    }
    if (!antwort) continue;

    const felder = ergebnisPruefen(antwort, p);
    const anzahl = Object.keys(felder).filter(k => k !== 'fehler').length;

    // Unter drei Feldern lohnt die Umstellung nicht — dann bleibt der Freitext stehen,
    // der auf der Seite ohnehin gerendert wird.
    if (anzahl < 3) {
      console.log(`  – ${p.name_deutsch}: nur ${anzahl} Felder aus dem Text ableitbar, bleibt Freitext`);
      zuDuenn++;
      continue;
    }

    const neu = JSON.stringify({ ...felder, freitext: p.inhalt_lang });
    updates.push({ id: p.id, name: p.name_deutsch, felder: anzahl, inhalt_lang: neu });
    if (!DRY_RUN) UPDATE.run(neu, p.id);
    ok++;
    if ((i + 1) % 25 === 0 || i === arbeitsliste.length - 1) {
      console.log(`  … ${i + 1}/${arbeitsliste.length} verarbeitet (${ok} übernommen, ${zuDuenn} zu dünn, ${fehlgeschlagen} Fehler)`);
    }
  }

  if (EXPORT) {
    fs.writeFileSync(EXPORT, JSON.stringify(updates, null, 0));
    console.log(`Updates nach ${EXPORT} geschrieben (${updates.length} Zeilen).`);
  }
  console.log(`\nFertig: ${ok} übernommen, ${zuDuenn} als Freitext belassen, ${fehlgeschlagen} fehlgeschlagen.`);
  if (DRY_RUN) console.log('DRY-RUN — nichts in die DB geschrieben.');
})();
