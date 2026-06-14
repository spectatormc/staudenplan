// Fügt echte Teich- und Wasserpflanzen in die DB ein.
// Danach werden KI-Bilder generiert und die Pflanzen direkt live gesetzt.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const Database = require('better-sqlite3');
const { OpenAI } = require('openai');
const fs   = require('fs');
const path = require('path');

const db     = new Database(path.join(__dirname, '..', 'stauden.db'));
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const IMG_DIR = path.join(__dirname, '..', 'public', 'images', 'pflanzen');

const INSERT = db.prepare(`
  INSERT INTO pflanzen (
    name_deutsch, name_botanisch, beschreibung, inhalt_lang,
    licht, boden, stil, bluehzeit, farbe,
    hoehe_cm_min, hoehe_cm_max, breite_cm_max,
    pflege_sterne, preis_stueck_eur, winterhart_zone,
    bienen_freundlich, heimisch, feuchtigkeit, wuchs,
    lebensbereich, rolle_empfehlung, kombinationspartner,
    winteraspekt, trockenheitstoleranz, status
  ) VALUES (
    ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?
  )
`);

const pflanzen = [
  {
    name_deutsch: 'Weiße Seerose',
    name_botanisch: 'Nymphaea alba',
    beschreibung: 'Die klassische heimische Seerose mit großen weißen Blüten und runden schwimmenden Blättern — das Symbol des Gartenteichs schlechthin.',
    inhalt_lang: 'Nymphaea alba ist die einheimische Weiße Seerose und der unbestrittene Star jedes Gartenteichs. Ihre großen, reinweißen Blüten mit goldgelben Staubgefäßen öffnen sich von Juni bis September täglich von morgens bis nachmittags. Die runden, dunkelgrünen Schwimmblätter beschatten die Wasseroberfläche und unterdrücken damit Algenwachstum. Gepflanzt wird sie in Körben mit speziellem Teichsubstrat bei einer Wassertiefe von 60–120 cm. Im Winter zieht sie ein, die Rhizome überwintern sicher am Teichboden, solange der Teich nicht bis auf den Grund durchfriert. Alle 3–4 Jahre sollte sie geteilt werden, wenn die Blätter sich häufen und das Blühen nachlässt. Bienenfreundlich: Seerosen werden von Bienen und Käfern besucht. Als heimische Art ist sie ökologisch besonders wertvoll.',
    licht: 'Sonne',
    boden: 'lehmig|normal',
    stil: 'Naturgarten|Bauerngarten|Modern',
    bluehzeit: 'Juni - September',
    farbe: 'Weiß',
    hoehe_cm_min: 10, hoehe_cm_max: 20, breite_cm_max: 120,
    pflege_sterne: 2, preis_stueck_eur: 12.90, winterhart_zone: 5,
    bienen_freundlich: 1, heimisch: 1,
    feuchtigkeit: 'nass', wuchs: 'horstig',
    lebensbereich: 'Wasserfläche,Quellflur',
    rolle_empfehlung: 'Leitstaude',
    kombinationspartner: 'Rohrkolben,Teichschachtelhalm,Froschbiss,Seekanne',
    winteraspekt: 'unauffällig', trockenheitstoleranz: 'keine',
    status: 'live',
  },
  {
    name_deutsch: 'Zwerg-Seerose',
    name_botanisch: 'Nymphaea tetragona',
    beschreibung: 'Kleinste einheimische Seerose mit zierlichen weißen Blüten — ideal für kleine Teiche, Bottichgärten und Miniteiche ab 40 cm Wassertiefe.',
    inhalt_lang: 'Nymphaea tetragona ist die kleinste europäische Seerose und perfekt für Bottichgärten, Miniteiche und kleine Gartenteiche. Die zarten weißen Blüten erscheinen von Juli bis September und sind mit nur 5–7 cm Durchmesser deutlich kleiner als bei der großen weißen Seerose. Die kleinen runden Schwimmblätter bedecken einen Durchmesser von nur 40–60 cm — ideal wenn der Platz begrenzt ist. Wassertiefe 30–60 cm. Wie alle Seerosen benötigt sie mindestens 5–6 Stunden direkte Sonne täglich. Im Topf oder Teichkorb mit speziallem Seerosen-Substrat (lehmig) pflanzen und bis zum richtigen Wasserstand absenken. Winterhart bis Zone 5, Rhizome überwintern am Teichboden.',
    licht: 'Sonne',
    boden: 'lehmig|normal',
    stil: 'Naturgarten|Modern',
    bluehzeit: 'Juli - September',
    farbe: 'Weiß',
    hoehe_cm_min: 5, hoehe_cm_max: 15, breite_cm_max: 60,
    pflege_sterne: 2, preis_stueck_eur: 9.90, winterhart_zone: 5,
    bienen_freundlich: 1, heimisch: 1,
    feuchtigkeit: 'nass', wuchs: 'horstig',
    lebensbereich: 'Wasserfläche',
    rolle_empfehlung: 'Leitstaude',
    kombinationspartner: 'Wasserlinse,Froschbiss,Hornkraut',
    winteraspekt: 'unauffällig', trockenheitstoleranz: 'keine',
    status: 'live',
  },
  {
    name_deutsch: 'Gelbe Teichrose',
    name_botanisch: 'Nuphar lutea',
    beschreibung: 'Heimische Teichrose mit leuchtend gelben Blüten und mächtigen Schwimmblättern — robust und ideal für größere naturnahe Teiche.',
    inhalt_lang: 'Nuphar lutea, die Gelbe Teichrose oder Teichmummel, ist eine robuste heimische Wasserpflanze für naturnahe Gartenteiche. Ihre goldgelben, kugeligen Blüten erheben sich im Sommer über die Wasseroberfläche und duften leicht fruchtig. Die großen, herzförmigen Schwimmblätter (bis 30 cm) sind noch ausgeprägter als bei Nymphaea. Diese Art ist deutlich anspruchsloser als Seerosen: Sie verträgt auch fließendes Wasser, schlechte Lichtverhältnisse und tieferes Wasser (50–200 cm). Als heimische Art ist sie ökologisch unersetzlich — Seerosenkäfer und zahlreiche Insekten sind auf sie angewiesen. Stark ausbreitend in natürlichen Teichen — besser im Korb kultivieren. Winterhart ohne besondere Maßnahmen.',
    licht: 'Sonne|Halbschatten',
    boden: 'lehmig|normal',
    stil: 'Naturgarten',
    bluehzeit: 'Juni - August',
    farbe: 'Gelb',
    hoehe_cm_min: 10, hoehe_cm_max: 30, breite_cm_max: 150,
    pflege_sterne: 1, preis_stueck_eur: 8.90, winterhart_zone: 4,
    bienen_freundlich: 1, heimisch: 1,
    feuchtigkeit: 'nass', wuchs: 'ausläuferbildend',
    lebensbereich: 'Wasserfläche,Quellflur',
    rolle_empfehlung: 'Leitstaude',
    kombinationspartner: 'Rohrkolben,Seebinse,Teichschachtelhalm',
    winteraspekt: 'unauffällig', trockenheitstoleranz: 'keine',
    status: 'live',
  },
  {
    name_deutsch: 'Seekanne',
    name_botanisch: 'Nymphoides peltata',
    beschreibung: 'Zierliche Schwimmpflanze mit goldgelben Blüten und kleinen runden Blättern — weniger raumgreifend als Seerosen, ideal für kleinere Teiche.',
    inhalt_lang: 'Nymphoides peltata, die Seekanne, ist eine heimische Schwimmpflanze mit einer besonderen Eleganz: Kleine, rundliche Schwimmblätter und goldgelbe, fransig gewimperte Blüten von Juni bis September. Im Gegensatz zu Seerosen braucht sie weniger Platz (Blätter nur 5–8 cm) und ist daher ideal für kleinere Teiche. Wassertiefe 30–80 cm. Die Pflanze breitet sich über Ausläufer zügig aus und kann in naturnahen Teichen invasiv werden — im Korb kultivieren ist empfehlenswert. Sie ist heimisch und ökologisch wertvoll für Insekten und Kleinfische, die im Blattwerk Schutz suchen. Pflanzen Sie 3–5 Exemplare pro m² Wasserfläche für eine gute Bedeckung. Winterhart ohne besondere Maßnahmen.',
    licht: 'Sonne|Halbschatten',
    boden: 'lehmig|normal',
    stil: 'Naturgarten|Bauerngarten',
    bluehzeit: 'Juni - September',
    farbe: 'Gelb',
    hoehe_cm_min: 5, hoehe_cm_max: 10, breite_cm_max: 60,
    pflege_sterne: 2, preis_stueck_eur: 6.90, winterhart_zone: 5,
    bienen_freundlich: 1, heimisch: 1,
    feuchtigkeit: 'nass', wuchs: 'ausläuferbildend',
    lebensbereich: 'Wasserfläche,Quellflur',
    rolle_empfehlung: 'Begleitstaude',
    kombinationspartner: 'Weiße Seerose,Froschbiss,Wasserlinse',
    winteraspekt: 'unauffällig', trockenheitstoleranz: 'keine',
    status: 'live',
  },
  {
    name_deutsch: 'Froschbiss',
    name_botanisch: 'Hydrocharis morsus-ranae',
    beschreibung: 'Kleine heimische Schwimmpflanze mit weißen Blüten — treibt frei auf der Wasseroberfläche und bietet Fröschen und Molchen wichtige Laichhilfe.',
    inhalt_lang: 'Hydrocharis morsus-ranae, der Froschbiss, ist eine der charmantesten heimischen Schwimmpflanzen. Die kleinen, herzförmigen Blättchen (2–4 cm) und winzigen weißen Blüten treiben frei auf der Wasseroberfläche — ohne jede Verwurzelung im Boden. Von Juli bis August erscheinen die dreizähligen weißen Blüten. Diese Art ist einfach zu pflegen: Sie vermehrt sich durch Ausläufer (Stolonen) selbstständig und bildet im Lauf des Sommers dichte Matten. Im Herbst sinken Winterknospen (Turionen) auf den Teichboden und treiben im Frühjahr neu aus. Ökologisch enorm wertvoll: Laichplatz für Frösche, Molche und Fische. Für Teiche ab 30 cm Tiefe geeignet. Kein Substrat nötig — einfach einsetzen.',
    licht: 'Sonne|Halbschatten',
    boden: 'lehmig|normal',
    stil: 'Naturgarten',
    bluehzeit: 'Juli - August',
    farbe: 'Weiß',
    hoehe_cm_min: 2, hoehe_cm_max: 5, breite_cm_max: 30,
    pflege_sterne: 1, preis_stueck_eur: 4.90, winterhart_zone: 5,
    bienen_freundlich: 1, heimisch: 1,
    feuchtigkeit: 'nass', wuchs: 'ausläuferbildend',
    lebensbereich: 'Wasserfläche',
    rolle_empfehlung: 'Füllstaude',
    kombinationspartner: 'Weiße Seerose,Hornkraut,Wasserpest',
    winteraspekt: 'unauffällig', trockenheitstoleranz: 'keine',
    status: 'live',
  },
  {
    name_deutsch: 'Krebsschere',
    name_botanisch: 'Stratiotes aloides',
    beschreibung: 'Eindrucksvolle heimische Wasserpflanze mit stacheligen Blättern und weißen Blüten — steigt im Sommer auf und sinkt im Herbst wieder ab.',
    inhalt_lang: 'Stratiotes aloides, die Krebsschere, ist eine der eindrucksvollsten heimischen Wasserpflanzen. Im Winter liegt sie als Rosette am Teichboden, im Frühjahr steigt sie auf und treibt scharf gezähnte, aloeähnliche Blätter an die Oberfläche. Von Juni bis August erscheinen weiße Blüten. Die Art ist getrenntgeschlechtlich — für Samenbildung braucht man männliche und weibliche Exemplare. Im Herbst setzt sie Ausläufer und bildet Tochterpflanzen, die man leicht separieren kann. Wassertiefe 30–100 cm. Kein Substrat nötig — frei schwimmend. Ökologisch bedeutsam: Laichplatz für Amphibien, Versteck für Fischbrut. In manchen Bundesländern besonders geschützt — im Garten erlaubt, aber nur aus Gartenzucht kaufen.',
    licht: 'Sonne|Halbschatten',
    boden: 'lehmig|normal',
    stil: 'Naturgarten',
    bluehzeit: 'Juni - August',
    farbe: 'Weiß',
    hoehe_cm_min: 30, hoehe_cm_max: 50, breite_cm_max: 50,
    pflege_sterne: 1, preis_stueck_eur: 5.90, winterhart_zone: 5,
    bienen_freundlich: 1, heimisch: 1,
    feuchtigkeit: 'nass', wuchs: 'ausläuferbildend',
    lebensbereich: 'Wasserfläche',
    rolle_empfehlung: 'Begleitstaude',
    kombinationspartner: 'Froschbiss,Hornkraut,Weiße Seerose',
    winteraspekt: 'unauffällig', trockenheitstoleranz: 'keine',
    status: 'live',
  },
  {
    name_deutsch: 'Hornkraut',
    name_botanisch: 'Ceratophyllum demersum',
    beschreibung: 'Unverzichtbare Unterwasserpflanze zur Wasserklärung — produziert massenhaft Sauerstoff und verhindert Algenbildung im Gartenteich.',
    inhalt_lang: 'Ceratophyllum demersum, das Hornkraut oder Hornblatt, ist eine der wichtigsten Sauerstoffpflanzen für jeden Gartenteich. Ohne Wurzeln treibt es frei im Wasser, seine fein gefiederten, dunkelgrünen Quirlblätter sehen aus wie zarte Tannenzweige. Die Pflanze entzieht dem Wasser Nährstoffe und entzieht damit Algen die Lebensgrundlage. Außerdem produziert sie bei Sonne massenhaft Sauerstoff. Keine Blüten sichtbar (Windblüter). Im Winter sinken abgestorbene Triebe ab und treiben im Frühjahr neu aus. Einfach einwerfen — keine weitere Pflege nötig. Für jeden Teich ab 30 cm Tiefe geeignet. Heimische Art, ökologisch wertvoll als Laichsubstrat und Versteck für Fischbrut.',
    licht: 'Sonne|Halbschatten',
    boden: 'lehmig|normal',
    stil: 'Naturgarten|Modern',
    bluehzeit: 'kein Blüteschmuck',
    farbe: 'Grün',
    hoehe_cm_min: 30, hoehe_cm_max: 100, breite_cm_max: 50,
    pflege_sterne: 1, preis_stueck_eur: 3.90, winterhart_zone: 4,
    bienen_freundlich: 0, heimisch: 1,
    feuchtigkeit: 'nass', wuchs: 'ausläuferbildend',
    lebensbereich: 'Wasserfläche',
    rolle_empfehlung: 'Füllstaude',
    kombinationspartner: 'Weiße Seerose,Froschbiss,Krebsschere',
    winteraspekt: 'unauffällig', trockenheitstoleranz: 'keine',
    status: 'live',
  },
  {
    name_deutsch: 'Teich-Schachtelhalm',
    name_botanisch: 'Equisetum fluviatile',
    beschreibung: 'Archaisch wirkender Schachtelhalm für flache Uferzonen — wächst direkt im Wasser und verleiht dem Teich einen urzeitlichen Charakter.',
    inhalt_lang: 'Equisetum fluviatile, der Teich-Schachtelhalm oder Gewöhnliche Teich-Schachtelhalm, ist die einzige in Deutschland heimische Schachtelhalm-Art, die direkt im Wasser gedeiht. Die aufrechten, hohlen, grünen Triebe erscheinen ab April und bilden bis zum Sommer dichte Bestände in Wassertiefen von 10–50 cm. Die archaische Erscheinung — Schachtelhalme existieren seit dem Karbon — verleiht dem Teich einen besonderen Charakter. Kein nennenswerter Blüteschmuck (Sporen). Ausbreitung durch Rhizome — in kleinen Teichen mit Rhizomsperre begrenzen. Als heimische Art idealer Lebensraum für Kleinlebewesen, Insektenlarven und Amphibienlarven. Kombination mit Rohrkolben und Schwertlilie für ein natürliches Uferbild.',
    licht: 'Sonne|Halbschatten',
    boden: 'lehmig|normal',
    stil: 'Naturgarten',
    bluehzeit: 'kein Blüteschmuck',
    farbe: 'Grün',
    hoehe_cm_min: 50, hoehe_cm_max: 100, breite_cm_max: 60,
    pflege_sterne: 1, preis_stueck_eur: 5.90, winterhart_zone: 4,
    bienen_freundlich: 0, heimisch: 1,
    feuchtigkeit: 'nass', wuchs: 'ausläuferbildend',
    lebensbereich: 'Wasserfläche,Quellflur',
    rolle_empfehlung: 'Strukturpflanze',
    kombinationspartner: 'Rohrkolben,Sumpf-Schwertlilie,Seebinse',
    winteraspekt: 'Struktur', trockenheitstoleranz: 'keine',
    status: 'live',
  },
  {
    name_deutsch: 'Breitblättriger Rohrkolben',
    name_botanisch: 'Typha latifolia',
    beschreibung: 'Heimischer Röhrichtbestand-Klassiker mit markanten braunen Kolben — struktur gebend und für Vögel und Insekten enorm wertvoll.',
    inhalt_lang: 'Typha latifolia, der Breitblättrige Rohrkolben, ist das Symbol des natürlichen Uferbereichs. Seine bis zu 2,5 m hohen Triebe und die markanten schokoladenbraunen Blütenkolben prägen das Bild naturnaher Gewässer. Die Kolben stehen im Winter als elegante Silhouetten — einer der besten Winteraspekte unter allen Wasserpflanzen. Als heimische Art bietet er Lebensraum für Teichrohrsänger, Rohrammer und zahllosen Insekten. Im Herbst platzen die Kolben auf und entlassen wollene Samen-Massen. Stark ausbreitend durch Rhizome — in kleinen Gärten mit Rhizomsperre im Teich halten oder gegen den Zwerg-Rohrkolben (Typha laxmannii) tauschen. Wassertiefe 20–50 cm. Kombination mit Sumpf-Schwertlilie und Rohrglanzgras für ein authentisches Uferbild.',
    licht: 'Sonne',
    boden: 'lehmig|normal',
    stil: 'Naturgarten',
    bluehzeit: 'Juni - August',
    farbe: 'Braun',
    hoehe_cm_min: 150, hoehe_cm_max: 250, breite_cm_max: 80,
    pflege_sterne: 1, preis_stueck_eur: 6.90, winterhart_zone: 3,
    bienen_freundlich: 1, heimisch: 1,
    feuchtigkeit: 'nass', wuchs: 'ausläuferbildend',
    lebensbereich: 'Quellflur,Wasserfläche',
    rolle_empfehlung: 'Leitstaude',
    kombinationspartner: 'Sumpf-Schwertlilie,Teich-Schachtelhalm,Seebinse',
    winteraspekt: 'Struktur', trockenheitstoleranz: 'keine',
    status: 'live',
  },
  {
    name_deutsch: 'Seebinse',
    name_botanisch: 'Schoenoplectus lacustris',
    beschreibung: 'Elegante hohe Binse für den Teichrand — wächst bis ins Wasser und schafft authentisches Röhrichtflair mit schlanken grünen Halmen.',
    inhalt_lang: 'Schoenoplectus lacustris, die Seebinse oder Gemeine Teichbinse, ist eine eindrucksvolle heimische Röhrichtpflanze. Ihre runden, bis 3 m hohen grünen Halme sind unverzweigt und schlanker als die des Rohrkolbens — sie wirken dadurch eleganter und moderner. Kleine rötlichbraune Ähren erscheinen seitlich an den Halmen im Sommer. Die Art wächst in Wassertiefen von 0–100 cm. Als heimische Art ist sie ein Lebensraumersatz für natürliche Uferzonen und bietet Brutraum für Rohrsänger. Die Ausbreitung durch Rhizome kann intensiv sein — mit Rhizomsperre oder Korb kultivieren. Im Herbst können die Halme als Dekoration oder Mulchmaterial genutzt werden. Besonders schön in Kombination mit Sumpf-Schwertlilie und Rohrkolben.',
    licht: 'Sonne|Halbschatten',
    boden: 'lehmig|normal',
    stil: 'Naturgarten|Modern',
    bluehzeit: 'Juli - August',
    farbe: 'Braun',
    hoehe_cm_min: 150, hoehe_cm_max: 300, breite_cm_max: 60,
    pflege_sterne: 1, preis_stueck_eur: 7.90, winterhart_zone: 4,
    bienen_freundlich: 1, heimisch: 1,
    feuchtigkeit: 'nass', wuchs: 'ausläuferbildend',
    lebensbereich: 'Quellflur,Wasserfläche',
    rolle_empfehlung: 'Leitstaude',
    kombinationspartner: 'Rohrkolben,Sumpf-Schwertlilie,Teich-Schachtelhalm',
    winteraspekt: 'Struktur', trockenheitstoleranz: 'keine',
    status: 'live',
  },
  {
    name_deutsch: 'Wasserlinse',
    name_botanisch: 'Lemna minor',
    beschreibung: 'Winzige heimische Schwimmpflanze — bedeckt die Wasseroberfläche mit einem smaragdgrünen Teppich und klärt das Teichwasser.',
    inhalt_lang: 'Lemna minor, die Kleine Wasserlinse oder Entengrütze, ist die kleinste Blütenpflanze Europas. Winzige runde Blättchen von nur 2–4 mm treiben zu Millionen auf der Wasseroberfläche und bedecken sie bei Nährstoffreichtum vollständig mit einem smaragdgrünen Teppich. Die Pflanze wächst rasend schnell (Verdoppelung in 2–3 Tagen bei optimalen Bedingungen), entzieht dem Wasser dabei Nährstoffe und verhindert so Algenblüten. Enten und Fische fressen sie begierig — daher "Entengrütze". Übermäßige Ausbreitung deutet auf Nährstoffreichtum hin — dann regelmäßig abschöpfen und kompostieren. Kein Substrat nötig. Überlebt den Winter als Winterknospen am Teichboden. Heimisch und ökologisch wertvoll als Nahrungsquelle.',
    licht: 'Sonne|Halbschatten',
    boden: 'lehmig|normal',
    stil: 'Naturgarten',
    bluehzeit: 'kein Blüteschmuck',
    farbe: 'Grün',
    hoehe_cm_min: 0, hoehe_cm_max: 1, breite_cm_max: 5,
    pflege_sterne: 1, preis_stueck_eur: 2.90, winterhart_zone: 4,
    bienen_freundlich: 0, heimisch: 1,
    feuchtigkeit: 'nass', wuchs: 'ausläuferbildend',
    lebensbereich: 'Wasserfläche',
    rolle_empfehlung: 'Füllstaude',
    kombinationspartner: 'Weiße Seerose,Froschbiss,Hornkraut',
    winteraspekt: 'unauffällig', trockenheitstoleranz: 'keine',
    status: 'live',
  },
];

function buildPrompt(p) {
  const farbe = (p.farbe || '').split(',').slice(0,2).map(s => s.trim()).filter(Boolean).join(' and ');
  const farbeHinweis = farbe && farbe !== 'Grün' && farbe !== 'Braun' ? ` with ${farbe} flowers` : '';
  return `Photorealistic garden photograph of the aquatic plant ${p.name_botanisch} (${p.name_deutsch})${farbeHinweis}. `
    + `Show the entire plant in a natural garden pond setting, natural daylight. `
    + `No text, no watermarks, no people. High quality plant photography.`;
}

const UPDATE = db.prepare(
  "UPDATE pflanzen SET bild_url=?, bild_lizenz='KI-generiert / OpenAI', bild_ki=1 WHERE id=?"
);

async function main() {
  console.log(`\n=== Füge ${pflanzen.length} Teichpflanzen ein ===\n`);

  for (const p of pflanzen) {
    // Insert
    const result = INSERT.run(
      p.name_deutsch, p.name_botanisch, p.beschreibung, p.inhalt_lang,
      p.licht, p.boden, p.stil, p.bluehzeit, p.farbe,
      p.hoehe_cm_min, p.hoehe_cm_max, p.breite_cm_max,
      p.pflege_sterne, p.preis_stueck_eur, p.winterhart_zone,
      p.bienen_freundlich, p.heimisch, p.feuchtigkeit, p.wuchs,
      p.lebensbereich, p.rolle_empfehlung, p.kombinationspartner,
      p.winteraspekt, p.trockenheitstoleranz, p.status
    );
    const id = result.lastInsertRowid;
    process.stdout.write(`[${id}] ${p.name_deutsch.padEnd(35)} `);

    // KI-Bild generieren
    try {
      const resp = await openai.images.generate({
        model: 'gpt-image-1', prompt: buildPrompt(p),
        n: 1, size: '1024x1024', quality: 'medium', output_format: 'jpeg',
      });
      const b64 = resp.data[0].b64_json;
      if (!b64) throw new Error('kein b64_json');

      const slug = p.name_deutsch.toLowerCase()
        .replace(/ä/g,'ae').replace(/ö/g,'oe').replace(/ü/g,'ue').replace(/ß/g,'ss')
        .replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,40);
      const filename = `ki-${slug}-${id}.jpg`;
      fs.writeFileSync(path.join(IMG_DIR, filename), Buffer.from(b64, 'base64'));
      UPDATE.run(`/images/pflanzen/${filename}`, id);
      console.log(`✅ /images/pflanzen/${filename}`);
    } catch (e) {
      console.log(`❌ Bild: ${e.message}`);
    }

    await new Promise(r => setTimeout(r, 13000));
  }

  console.log(`\n=== Fertig. ${pflanzen.length} Teichpflanzen eingefügt. ===`);
  db.close();
}

main().catch(console.error);
