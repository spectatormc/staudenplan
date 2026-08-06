// Bessert einen vorhandenen Updates-Satz nach, statt alles neu zu erzeugen.
//
// Zwei Klassen von Korrekturen:
// (a) deterministisch — Pflanzabstand und Giftigkeitshinweis werden für ALLE Einträge neu aus
//     den Regeln abgeleitet. Kostet nichts, kein Modellaufruf.
// (b) generiert — nur Einträge, bei denen die verschärften Prüfregeln anschlagen oder die zu
//     einer nachträglich korrigierten Gruppe gehören (Halbsträucher, sommergrüne Seggen,
//     wuchernde und selbstsäende Arten).
//
// Anlass (zweite Fachprüfung, 06.08.2026): fünf Einträge behaupteten, ein Rückschnitt fördere
// die Selbstaussaat — er verhindert sie. Eine gattungsweite Immergrün-Regel hat sommergrünen
// Seggen die Falschbehauptung "da sie immergrün ist" untergeschoben. Und die Stückzahl pro m²
// wurde aus dem Rohwert statt aus der Mitte der ausgegebenen Spanne gerechnet.
//
//   node scripts/inhalt-lang-nachbessern.js --db=kopie.db --in=updates2.json --out=updates3.json
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const Database = require('better-sqlite3');
const { OpenAI } = require('openai');
const path = require('path');
const fs = require('fs');
const { giftigkeit } = require('./pflanzen-giftigkeit');
const { pflanzabstandRechnen, verboteFuer, verstoesse, satzOk } = require('./pflanzen-regeln');

const args = process.argv.slice(2);
const opt = (n, d = null) => { const a = args.find(x => x.startsWith(`--${n}=`)); return a ? a.split('=').slice(1).join('=') : d; };
const DB_PFAD = opt('db', path.join(__dirname, '..', 'stauden.db'));
const EIN = opt('in'), AUS = opt('out');
const MODELL = opt('model', 'gpt-4o');
const NUR_TROCKEN = args.includes('--nur-deterministisch');
if (!EIN || !AUS) { console.error('--in und --out sind erforderlich.'); process.exit(1); }

const db = new Database(DB_PFAD, { readonly: true });
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const updates = JSON.parse(fs.readFileSync(EIN, 'utf8'));
const stamm = db.prepare(`SELECT id, name_deutsch, name_botanisch, licht, boden, feuchtigkeit, bluehzeit,
  wuchs, hoehe_cm_min, hoehe_cm_max, breite_cm_max, winterhart_zone FROM pflanzen WHERE id = ?`);

const SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    pflanzzeit: { type: ['string', 'null'] }, giessen: { type: ['string', 'null'] },
    duengen: { type: ['string', 'null'] }, rueckschnitt: { type: ['string', 'null'] },
    ueberwinterung: { type: ['string', 'null'] }, tipp: { type: ['string', 'null'] },
    fehler: { type: 'array', items: { type: 'string' } },
  },
  required: ['pflanzzeit', 'giessen', 'duengen', 'rueckschnitt', 'ueberwinterung', 'tipp', 'fehler'],
};

const SYSTEM = `Du bist ein erfahrener deutscher Staudenspezialist und schreibst Pflegeinformationen
für eine Pflanzendatenbank.

Regeln:
- Je Feld 1-2 vollständige deutsche Sätze, gärtnerisch präzise, praxisnah, ohne Marketingfloskeln.
- Die Angaben müssen zu den gelieferten Stammdaten passen und dürfen ihnen nicht widersprechen.
- Achte auf die WIRKUNGSRICHTUNG deiner Aussagen: Wer Blütenstände abschneidet, verhindert die
  Selbstaussaat. Ein oberirdischer Schnitt stoppt keine unterirdischen Ausläufer.
- Schreibe artspezifisch. Sätze, die auf jede beliebige Staude passen, sind wertlos.
- "duengen" und "fehler" dürfen einander nicht widersprechen.
- Nenne KEINE Pflanzabstände, keine Zentimeterangaben zum Abstand und keine Giftigkeitshinweise —
  diese Felder werden getrennt gepflegt.
- "fehler": die 2-3 häufigsten Pflegefehler GENAU BEI DIESER Pflanze, jeweils ein Satz.`;

async function erzeugen(p, freitext, zusatz = '') {
  const stammdaten = [
    `Botanisch: ${p.name_botanisch}`, p.licht && `Licht: ${p.licht}`, p.boden && `Boden: ${p.boden}`,
    p.feuchtigkeit && `Feuchtigkeit: ${p.feuchtigkeit}`, p.bluehzeit && `Blütezeit: ${p.bluehzeit}`,
    p.wuchs && `Wuchsform: ${p.wuchs}`,
    (p.hoehe_cm_min || p.hoehe_cm_max) && `Höhe: ${p.hoehe_cm_min || '?'}-${p.hoehe_cm_max || '?'} cm`,
    p.breite_cm_max && `Breite im Alter: ${p.breite_cm_max} cm`,
    p.winterhart_zone && `Winterhärtezone: ${p.winterhart_zone}`,
  ].filter(Boolean).join('\n');
  const verbote = verboteFuer(p);
  const vt = (verbote.length || zusatz) ? `\n\nZWINGEND BEACHTEN:\n${verbote.map(v => '- ' + v).join('\n')}${zusatz ? '\n- ' + zusatz : ''}` : '';
  const res = await openai.chat.completions.create({
    model: MODELL, temperature: 0.2,
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: `Pflanze: ${p.name_deutsch}\n${stammdaten}\n\nVorhandene Beschreibung (Kontext):\n"""\n${freitext}\n"""${vt}` },
    ],
    response_format: { type: 'json_schema', json_schema: { name: 'pflegefelder', strict: true, schema: SCHEMA } },
  });
  return JSON.parse(res.choices[0].message.content);
}

// Gruppen, deren Regel nachträglich korrigiert wurde — auch ohne aktuellen Verstoß neu erzeugen.
const KORRIGIERTE_GRUPPE = (p) =>
  /^(Lavandula|Santolina|Perovskia|Helianthemum|Caryopteris|Thymus|Hyssopus)\b/.test(p.name_botanisch) ||
  /^(Carex grayi|Carex muskingumensis|Carex pendula|Carex elata)/.test(p.name_botanisch) ||
  /(ausläufer|selbstsäend)/i.test(p.wuchs || '');

(async () => {
  let abstand = 0, gift = 0, neu = 0, hartnaeckig = 0;
  const zuGenerieren = [];

  for (const u of updates) {
    const o = JSON.parse(u.inhalt_lang);
    const p = stamm.get(u.id);
    if (!p) continue;

    const neuerAbstand = pflanzabstandRechnen(p);
    if (neuerAbstand !== o.pflanzabstand) { o.pflanzabstand = neuerAbstand; abstand++; }

    const g = giftigkeit(p.name_botanisch);
    const alt = o.giftig || null;
    if (g) { o.giftig = g.text; o.giftstufe = g.stufe; } else { delete o.giftig; delete o.giftstufe; }
    if ((g ? g.text : null) !== alt) gift++;

    const felder = { ...o };
    for (const k of ['freitext', 'giftig', 'giftstufe', 'pflanzabstand']) delete felder[k];
    const probleme = verstoesse(felder, p);
    if (probleme.length || KORRIGIERTE_GRUPPE(p)) {
      zuGenerieren.push({ u, p, o, grund: probleme.length ? probleme.join('; ') : 'Gruppe mit korrigierter Regel' });
    }
    u.inhalt_lang = JSON.stringify(o);
  }

  console.log(`Deterministisch: ${abstand} Pflanzabstände, ${gift} Giftigkeitshinweise geändert.`);
  console.log(`Neu zu generieren: ${zuGenerieren.length} von ${updates.length}`);
  if (NUR_TROCKEN) { fs.writeFileSync(AUS, JSON.stringify(updates, null, 0)); console.log('Nur deterministisch — fertig.'); return; }

  for (const [i, eintrag] of zuGenerieren.entries()) {
    const { u, p, o } = eintrag;
    let fertig = null, probleme = [];
    for (let versuch = 1; versuch <= 3; versuch++) {
      let roh;
      try {
        roh = await erzeugen(p, o.freitext, versuch > 1 ? `Der vorige Entwurf war fehlerhaft: ${probleme.join('; ')}. Korrigiere das.` : '');
      } catch (e) { await new Promise(r => setTimeout(r, 1200 * versuch)); continue; }
      const sauber = {};
      for (const f of ['pflanzzeit', 'giessen', 'duengen', 'rueckschnitt', 'ueberwinterung', 'tipp']) if (satzOk(roh[f])) sauber[f] = roh[f].trim();
      if (Array.isArray(roh.fehler)) { const fl = roh.fehler.filter(satzOk).map(x => x.trim()).slice(0, 5); if (fl.length) sauber.fehler = fl; }
      probleme = verstoesse(sauber, p);
      if (!probleme.length) { fertig = sauber; break; }
      console.log(`  ↻ ${p.name_deutsch}: ${probleme.join('; ')}`);
    }
    if (!fertig) { hartnaeckig++; console.log(`  ✗ ${p.name_deutsch}: bleibt fehlerhaft — Eintrag wird verworfen`); u.verwerfen = true; continue; }

    const zusammen = { ...fertig, pflanzabstand: o.pflanzabstand, freitext: o.freitext };
    if (o.giftig) { zusammen.giftig = o.giftig; zusammen.giftstufe = o.giftstufe; }
    u.inhalt_lang = JSON.stringify(zusammen);
    neu++;
    if ((i + 1) % 20 === 0) console.log(`  … ${i + 1}/${zuGenerieren.length} neu erzeugt`);
  }

  const behalten = updates.filter(u => !u.verwerfen);
  fs.writeFileSync(AUS, JSON.stringify(behalten, null, 0));
  console.log(`\nFertig: ${abstand} Abstände + ${gift} Gifthinweise deterministisch korrigiert, ${neu} Einträge neu erzeugt, ${hartnaeckig} verworfen.`);
  console.log(`${behalten.length} Einträge nach ${AUS} geschrieben.`);
})();
