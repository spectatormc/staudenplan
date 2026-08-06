// Überführt die Prosa-Einträge in pflanzen.inhalt_lang ins Feldschema.
//
// Hintergrund: /pflanze/:slug liest inhalt_lang per JSON.parse. 288 der 713 Zeilen enthalten
// aber Fließtext. Diese Seiten zeigen deshalb kein Pflegeraster und nur 3 statt 7 FAQ-Einträge.
//
// Methode: Die Pflegefelder werden aus den Stammdaten GENERIERT, nicht aus dem Prosatext
// extrahiert (ein Extraktionslauf lieferte nur 2 von 7 Feldern — die Prosa beschreibt Herkunft
// und Wuchsform, keine Pflege). So sind auch die anderen 425 Einträge entstanden
// (scripts/enrich-plant-pages.js). Der vorhandene Text geht als Kontext in den Prompt und
// bleibt als "freitext" in der DB — die Umstellung ist verlustfrei umkehrbar.
//
// ─── Was der erste Lauf am 06.08.2026 falsch gemacht hat (Fachprüfung einer 24er-Stichprobe) ──
// 1. Das Format-BEISPIEL im Prompt ("Format exakt 35-45 cm") wurde wörtlich zum Inhalt:
//    276 von 285 Einträgen sagten 35-45 cm, vom 5-cm-Teppichphlox bis zum 150-cm-Gras.
//    → pflanzabstand wird jetzt NICHT MEHR generiert, sondern aus breite_cm_max und wuchs
//      gerechnet. Merke: in Format-Vorgaben nie einen konkreten Wert nennen.
// 2. Von 288 Einträgen erwähnten 5 die Giftigkeit — die Herbstzeitlose wurde über acht
//    Pflegefelder ohne ein Wort zu Colchicin beschrieben.
//    → giftig kommt aus der kuratierten Liste in scripts/pflanzen-giftigkeit.js, nicht vom Modell.
// 3. "Regt neues Wachstum an / zweite Blüte" landete auf nicht remontierenden Arten; bei
//    Paeonia kostet der empfohlene Schnitt die Blüte des Folgejahres.
//    → artspezifische Verbote im Prompt + Nachprüfung, die den Lauf für die Zeile wiederholt.
//
// Ausführen (immer erst gegen eine Kopie, nie direkt gegen die Produktions-DB):
//   node scripts/inhalt-lang-nach-schema.js --db=/pfad/kopie.db --limit=5 --dry-run
//   node scripts/inhalt-lang-nach-schema.js --db=/pfad/kopie.db --export=updates.json
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const Database = require('better-sqlite3');
const { OpenAI } = require('openai');
const path = require('path');
const fs = require('fs');
const { giftigkeit } = require('./pflanzen-giftigkeit');
// Regeln liegen im gemeinsamen Modul, damit Erst- und Nachbesserungslauf identisch prüfen.
const { pflanzabstandRechnen, verboteFuer, verstoesse, satzOk } = require('./pflanzen-regeln');

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

const alle = db.prepare(`
  SELECT id, name_deutsch, name_botanisch, licht, boden, feuchtigkeit, bluehzeit, wuchs,
         hoehe_cm_min, hoehe_cm_max, breite_cm_max, winterhart_zone, trockenheitstoleranz, inhalt_lang
  FROM pflanzen WHERE inhalt_lang IS NOT NULL AND inhalt_lang != ''
`).all();

const offen = alle.filter(p => {
  try { JSON.parse(p.inhalt_lang); return false; } catch { return true; }
});
// --nur=Colchicum,Paeonia : gezielt einzelne Arten laufen lassen (für Stichproben an
// den heiklen Fällen, statt gleichverteilt zu prüfen).
const NUR = opt('nur') ? opt('nur').split(',').map(s => s.trim().toLowerCase()).filter(Boolean) : null;
const gefiltert = NUR ? offen.filter(p => NUR.some(n => String(p.name_botanisch || '').toLowerCase().includes(n))) : offen;
const arbeitsliste = LIMIT ? gefiltert.slice(0, LIMIT) : gefiltert;
console.log(`${offen.length} Prosa-Zeilen gefunden, ${arbeitsliste.length} werden verarbeitet (Modell ${MODELL}${DRY_RUN ? ', DRY-RUN' : ''}).`);

// ── Feldschema ───────────────────────────────────────────────────────────────
// Ohne pflanzabstand (wird gerechnet), ohne giftig (kuratiert), ohne kombinationen
// (Pflanzenpaarungen zu erfinden ist etwas anderes als Pflegehinweise zu formulieren —
// dafür gibt es die kuratierte Spalte kombinationspartner).
const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    pflanzzeit:     { type: ['string', 'null'] },
    giessen:        { type: ['string', 'null'] },
    duengen:        { type: ['string', 'null'] },
    rueckschnitt:   { type: ['string', 'null'] },
    ueberwinterung: { type: ['string', 'null'] },
    tipp:           { type: ['string', 'null'] },
    fehler:         { type: 'array', items: { type: 'string' } },
  },
  required: ['pflanzzeit', 'giessen', 'duengen', 'rueckschnitt', 'ueberwinterung', 'tipp', 'fehler'],
};

const SYSTEM = `Du bist ein erfahrener deutscher Staudenspezialist und schreibst Pflegeinformationen
für eine Pflanzendatenbank.

Regeln:
- Je Feld 1-2 vollständige deutsche Sätze, gärtnerisch präzise, praxisnah, ohne Marketingfloskeln.
- Die Angaben müssen zu den gelieferten Stammdaten passen (Licht, Boden, Feuchtigkeit, Höhe,
  Blütezeit, Wuchsform). Widersprich ihnen nicht.
- Der mitgelieferte vorhandene Text beschreibt dieselbe Pflanze. Nimm Herkunft, Wuchsform und
  Verwendungshinweise daraus auf, wo sie zum Feld passen, und widersprich ihm nicht.
- Schreibe artspezifisch. Sätze, die auf jede beliebige Staude passen, sind wertlos.
- "duengen" und "fehler" dürfen einander nicht widersprechen: Wenn du vor Überdüngung warnst,
  empfiehl keine regelmäßige Düngung.
- Bist du dir bei einer Art unsicher, bleib bei der gattungstypischen Praxis statt zu erfinden.
- Nenne KEINE Pflanzabstände, keine Zentimeterangaben zum Abstand und keine Giftigkeitshinweise —
  diese Felder werden getrennt gepflegt.
- "fehler": die 2-3 häufigsten Pflegefehler GENAU BEI DIESER Pflanze, jeweils ein Satz.`;


const UPDATE = db.prepare('UPDATE pflanzen SET inhalt_lang = ? WHERE id = ?');
const updates = [];
let ok = 0, nachgebessert = 0, zuDuenn = 0, fehlgeschlagen = 0, mitGift = 0;

async function erzeugen(p, zusatzverbot = '') {
  const stammdaten = [
    `Botanisch: ${p.name_botanisch}`,
    p.licht && `Licht: ${p.licht}`,
    p.boden && `Boden: ${p.boden}`,
    p.feuchtigkeit && `Feuchtigkeit: ${p.feuchtigkeit}`,
    p.bluehzeit && `Blütezeit: ${p.bluehzeit}`,
    p.wuchs && `Wuchsform: ${p.wuchs}`,
    (p.hoehe_cm_min || p.hoehe_cm_max) && `Höhe: ${p.hoehe_cm_min || '?'}-${p.hoehe_cm_max || '?'} cm`,
    p.breite_cm_max && `Breite im Alter: ${p.breite_cm_max} cm`,
    p.winterhart_zone && `Winterhärtezone: ${p.winterhart_zone}`,
  ].filter(Boolean).join('\n');

  const verbote = verboteFuer(p);
  const verbotText = (verbote.length || zusatzverbot)
    ? `\n\nZWINGEND BEACHTEN:\n${verbote.map(v => '- ' + v).join('\n')}${zusatzverbot ? '\n- ' + zusatzverbot : ''}`
    : '';

  const res = await openai.chat.completions.create({
    model: MODELL,
    temperature: 0.2,
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: `Pflanze: ${p.name_deutsch}\n${stammdaten}\n\nVorhandene Beschreibung dieser Pflanze (als Kontext, nicht als einzige Quelle):\n"""\n${p.inhalt_lang}\n"""${verbotText}` },
    ],
    response_format: { type: 'json_schema', json_schema: { name: 'pflegefelder', strict: true, schema: SCHEMA } },
  });
  return JSON.parse(res.choices[0].message.content);
}

(async () => {
  for (const [i, p] of arbeitsliste.entries()) {
    let felder = null, probleme = [];

    for (let versuch = 1; versuch <= 3; versuch++) {
      let roh;
      try {
        roh = await erzeugen(p, versuch > 1 ? `Der vorige Entwurf war fehlerhaft: ${probleme.join('; ')}. Korrigiere das.` : '');
      } catch (e) {
        if (versuch === 3) { console.log(`  ✗ ${p.name_deutsch}: ${e.message}`); }
        await new Promise(r => setTimeout(r, 1200 * versuch));
        continue;
      }
      const sauber = {};
      for (const feld of ['pflanzzeit', 'giessen', 'duengen', 'rueckschnitt', 'ueberwinterung', 'tipp']) {
        if (satzOk(roh[feld])) sauber[feld] = roh[feld].trim();
      }
      if (Array.isArray(roh.fehler)) {
        const fl = roh.fehler.filter(x => satzOk(x)).map(x => x.trim()).slice(0, 5);
        if (fl.length) sauber.fehler = fl;
      }
      probleme = verstoesse(sauber, p);
      if (!probleme.length) { felder = sauber; break; }
      if (versuch === 1) nachgebessert++;
      console.log(`  ↻ ${p.name_deutsch}: ${probleme.join('; ')} — neuer Versuch`);
      felder = sauber; // falls auch der letzte Versuch scheitert, unten aussortiert
    }

    if (!felder) { fehlgeschlagen++; continue; }
    if (probleme.length) {
      console.log(`  ✗ ${p.name_deutsch}: bleibt fehlerhaft (${probleme.join('; ')}) — als Freitext belassen`);
      fehlgeschlagen++;
      continue;
    }

    const anzahl = Object.keys(felder).filter(k => k !== 'fehler').length;
    if (anzahl < 3) { console.log(`  – ${p.name_deutsch}: nur ${anzahl} Felder, bleibt Freitext`); zuDuenn++; continue; }

    felder.pflanzabstand = pflanzabstandRechnen(p);
    const gift = giftigkeit(p.name_botanisch);
    if (gift) { felder.giftig = gift.text; felder.giftstufe = gift.stufe; mitGift++; }

    const neu = JSON.stringify({ ...felder, freitext: p.inhalt_lang });
    updates.push({ id: p.id, name: p.name_deutsch, botanisch: p.name_botanisch, felder: anzahl, inhalt_lang: neu });
    if (!DRY_RUN) UPDATE.run(neu, p.id);
    ok++;
    if ((i + 1) % 25 === 0 || i === arbeitsliste.length - 1) {
      console.log(`  … ${i + 1}/${arbeitsliste.length} (${ok} übernommen, ${nachgebessert} nachgebessert, ${zuDuenn} zu dünn, ${fehlgeschlagen} fehlgeschlagen, ${mitGift} mit Gifthinweis)`);
    }
  }

  if (EXPORT) {
    fs.writeFileSync(EXPORT, JSON.stringify(updates, null, 0));
    console.log(`Updates nach ${EXPORT} geschrieben (${updates.length} Zeilen).`);
  }
  console.log(`\nFertig: ${ok} übernommen, ${nachgebessert} nach Verstoß nachgebessert, ${zuDuenn} zu dünn, ${fehlgeschlagen} fehlgeschlagen, ${mitGift} mit Giftigkeitshinweis.`);
  if (DRY_RUN) console.log('DRY-RUN — nichts in die DB geschrieben.');
})();
