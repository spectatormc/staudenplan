// Trägt Geranium macrorrhizum und Geranium wallichianum nach.
//
// Hintergrund: Beide Arten standen bis zum Namensaudit vom 06.08.2026 im Lexikon; seither
// liefern /pflanze/geranium-macrorrhizum und /pflanze/geranium-wallichianum 404 (nachgewiesen
// im nginx-Log, Googlebot ruft sie weiter auf). Anders als bei den übrigen weggefallenen Slugs
// gibt es hier keinen Nachfolger, auf den sich weiterleiten ließe: In der DB steht von der
// Verwandtschaft nur die Hybride Geranium x 'Rozanne'. Eine 301 auf eine andere Art wäre eine
// Falschauskunft — deshalb kommen die Arten zurück statt einer Weiterleitung.
//
// Die Stammdaten sind von Hand gesetzt und einzeln belegbar, nicht generiert. Der Pflanzabstand
// kommt aus scripts/pflanzen-regeln.js (gerechnet aus breite_cm_max und wuchs), damit er nach
// derselben Regel entsteht wie bei den 709 bestehenden Zeilen — das war der Fehler des ersten
// inhalt_lang-Laufs, dort stand bei 276 Zeilen derselbe Beispielwert.
//
// Ausführen (erst gegen eine Kopie, nie direkt gegen die Produktions-DB):
//   node scripts/geranium-nachtragen.js --db=/pfad/kopie.db --dry-run
//   node scripts/geranium-nachtragen.js --db=/pfad/kopie.db
const Database = require('better-sqlite3');
const path = require('path');
const { pflanzabstandRechnen, verstoesse } = require('./pflanzen-regeln');
const { giftigkeit } = require('./pflanzen-giftigkeit');

const args = process.argv.slice(2);
const opt = (name, fallback = null) => {
  const a = args.find(x => x.startsWith(`--${name}=`));
  return a ? a.split('=').slice(1).join('=') : fallback;
};
const DRY = args.includes('--dry-run');
const DB_PFAD = opt('db', path.join(__dirname, '..', 'stauden.db'));
const HEUTE = new Date().toISOString().split('T')[0];

const NEU = [
  {
    name_deutsch: 'Balkan-Storchschnabel',
    name_botanisch: 'Geranium macrorrhizum',
    beschreibung: 'Dichter, immergrüner Bodendecker mit aromatisch duftendem Laub und purpurrosa Blüten im Frühsommer. Eine der wenigen Stauden, die auch im trockenen Wurzeldruck unter Gehölzen dauerhaft deckt; im Herbst färbt sich das Laub rot.',
    licht: 'Sonne|Halbschatten|Schatten',
    boden: 'normal|humos|lehmig|sandig',
    stil: 'Naturgarten|Schattengarten|Cottage',
    bluehzeit: 'Mai - Juli',
    farbe: 'Rosa|Purpur',
    hoehe_cm_min: 25, hoehe_cm_max: 40, breite_cm_max: 60,
    pflege_sterne: 1, preis_stueck_eur: 5.5,
    winterhart_zone: 4, bienen_freundlich: 1, heimisch: 0,
    feuchtigkeit: 'trocken|normal', wuchs: 'ausläufer',
    lebensbereich: 'Gehölz,Gehölzrand',
    rolle_empfehlung: 'Füllstaude',
    kombinationspartner: 'Epimedium x versicolor, Waldsteinia ternata, Helleborus foetidus, Luzula sylvatica, Hosta sieboldiana',
    winteraspekt: 'Blätter halbimmergrün',
    trockenheitstoleranz: 'hoch',
    lebensdauer: 'staude',
    felder: {
      pflanzzeit: 'Am besten im Frühjahr von März bis Mai oder im Frühherbst von September bis Oktober. Herbstpflanzung ist die sicherere Wahl: Die Pflanze wurzelt über den Winter ein und übersteht die erste Sommertrockenheit dann bereits ohne Zusatzwasser.',
      giessen: 'In den ersten Wochen nach dem Pflanzen regelmäßig wässern. Danach ist der Balkan-Storchschnabel praktisch selbstversorgend und kommt auch unter Bäumen mit dem aus, was ankommt. Staunässe verträgt er dagegen schlecht.',
      duengen: 'Braucht keine Düngung. Eine dünne Kompostgabe im Frühjahr reicht völlig; auf mageren Böden bleibt der Bestand ohnehin dichter und standfester als auf gedüngten.',
      rueckschnitt: 'Kein Rückschnitt nötig. Das Laub bleibt über den Winter stehen und schützt den Boden — im Frühjahr nur vergilbte Blätter herausziehen. Nach der Blüte lassen sich überalterte, kahl gewordene Rhizomstücke abnehmen, damit der Teppich von innen heraus neu austreibt.',
      ueberwinterung: 'Vollkommen winterhart bis etwa -30 °C, ein Winterschutz ist überflüssig. Das halbimmergrüne Laub legt sich bei starkem Frost flach an den Boden und richtet sich im Frühjahr wieder auf.',
      kombinationen: [
        { name_botanisch: 'Epimedium x versicolor', name_deutsch: 'Elfenblume', grund: 'Deckt denselben trockenen Schatten unter Gehölzen, blüht aber vier Wochen früher — zusammen ergibt das eine durchgehende Blüte von April bis Juli.' },
        { name_botanisch: 'Waldsteinia ternata', name_deutsch: 'Waldsteinie', grund: 'Zweiter immergrüner Teppich fürs Gehölz; das Gelb der Waldsteinie im April setzt sich klar vom späteren Purpurrosa ab.' },
        { name_botanisch: 'Helleborus foetidus', name_deutsch: 'Stinkende Nieswurz', grund: 'Bringt aufrechte Höhe in die sonst flache Fläche und blüht schon im Spätwinter, wenn der Storchschnabel noch nichts zeigt.' },
        { name_botanisch: 'Luzula sylvatica', name_deutsch: 'Waldmarbel', grund: 'Grasartige Textur als Gegensatz zum breiten, gelappten Blatt — beide vertragen Wurzeldruck und Trockenheit im Schatten.' },
        { name_botanisch: 'Hosta sieboldiana', name_deutsch: 'Funkie', grund: 'Das große, blaugraue Funkienblatt kontrastiert mit dem kleinteiligen, matten Laub; die Funkie braucht allerdings den feuchteren Teil der Fläche.' },
      ],
      fehler: [
        'Zu nährstoffreicher oder zu feuchter Standort — die Pflanze wird mastig und fällt in der Mitte auseinander',
        'Zu weit gesetzt, sodass der Teppich jahrelang nicht schließt und sich in den Lücken Unkraut hält',
        'In Staunässe gepflanzt: die dicken Rhizome liegen dicht unter der Oberfläche und faulen dort schnell',
        'Beim Frühjahrsputz das ganze Laub abgeräumt, statt nur die vergilbten Blätter herauszuziehen',
      ],
      tipp: 'Das Laub duftet beim Berühren harzig-würzig; aus genau dieser Art wird das Geraniumöl der Parfümerie gewonnen. Deshalb an Wegkanten pflanzen, wo man im Vorbeigehen daran streift — und deshalb rühren Schnecken und Wild sie nicht an.',
    },
  },
  {
    name_deutsch: 'Wallich-Storchschnabel',
    name_botanisch: 'Geranium wallichianum',
    beschreibung: 'Flach ausgebreiteter Storchschnabel aus dem Himalaya mit blauvioletten, weiß geäugten Blüten. Blüht von Juli bis in den Oktober und damit deutlich länger als die meisten anderen Arten der Gattung.',
    licht: 'Sonne|Halbschatten',
    boden: 'normal|humos|lehmig',
    stil: 'Naturgarten|Cottage|Bauerngarten',
    bluehzeit: 'Juli - Oktober',
    farbe: 'Violett|Blau',
    hoehe_cm_min: 20, hoehe_cm_max: 30, breite_cm_max: 80,
    pflege_sterne: 1, preis_stueck_eur: 6.9,
    winterhart_zone: 5, bienen_freundlich: 1, heimisch: 0,
    feuchtigkeit: 'normal', wuchs: 'horstig',
    lebensbereich: 'Freifläche,Gehölzrand',
    rolle_empfehlung: 'Füllstaude',
    kombinationspartner: 'Aster amellus, Sedum spectabile, Calamagrostis x acutiflora, Nepeta faassenii, Alchemilla mollis',
    winteraspekt: 'unauffällig',
    trockenheitstoleranz: 'mittel',
    lebensdauer: 'staude',
    felder: {
      pflanzzeit: 'Im Frühjahr von April bis Mai pflanzen. Die Art treibt spät aus und wächst erst mit der Sommerwärme richtig los — eine Herbstpflanzung lässt ihr zu wenig Zeit, vor dem Winter Wurzeln zu machen.',
      giessen: 'Gleichmäßig feucht halten, ohne den Boden nass werden zu lassen. In langen Trockenperioden stellt die Pflanze die Blüte ein und treibt nach einem durchdringenden Wässern wieder neu — anders als der Balkan-Storchschnabel ist sie keine Trockenkünstlerin.',
      duengen: 'Eine Kompostgabe im Frühjahr genügt. Wer die lange Blüte ausreizen will, gibt Ende Juni eine zweite, sparsame Portion; mehr Stickstoff geht zulasten der Blüten und auf Kosten der Standfestigkeit.',
      rueckschnitt: 'Die Triebe wachsen aus einem Zentrum heraus flach in die Breite und blühen an ihrer ganzen Länge weiter — deshalb während der Saison nicht zurückschneiden, sondern nur ausgeblühte Einzeltriebe herausnehmen. Der komplette Rückschnitt gehört ins zeitige Frühjahr vor dem Neuaustrieb.',
      ueberwinterung: 'Winterhart bis etwa -23 °C. Die Pflanze zieht komplett ein und treibt spät wieder aus — die Stelle markieren, sonst wird im Frühjahr versehentlich darüber gehackt.',
      kombinationen: [
        { name_botanisch: 'Aster amellus', name_deutsch: 'Berg-Aster', grund: 'Beide blühen im Spätsommer und wollen denselben normal-durchlässigen Boden; die aufrechte Aster gibt dem flach wachsenden Storchschnabel die Höhe dazu.' },
        { name_botanisch: 'Sedum spectabile', name_deutsch: 'Fetthenne', grund: 'Die Triebe wachsen zwischen die Fetthennen-Horste und blühen dort weiter, während die Fetthenne erst im September ihre Farbe bringt.' },
        { name_botanisch: 'Calamagrostis x acutiflora', name_deutsch: 'Karl-Foerster-Gras', grund: 'Straff aufrechtes Gras als Gegenpol zum flachen Wuchs — der Kontrast trägt die Pflanzung bis in den Winter.' },
        { name_botanisch: 'Nepeta faassenii', name_deutsch: 'Katzenminze', grund: 'Ähnliche Blütenfarbe, aber früher: nach dem Rückschnitt der Katzenminze im Juli übernimmt der Storchschnabel die blauviolette Note.' },
        { name_botanisch: 'Alchemilla mollis', name_deutsch: 'Frauenmantel', grund: 'Klassischer Beetrandpartner; das gelbgrüne Frauenmantellaub hebt das Blauviolett und deckt die kahle Basis der Triebe.' },
      ],
      fehler: [
        'Zu eng gesetzt — was im Topf 15 cm misst, deckt nach zwei Jahren fast einen Quadratmeter',
        'Im Frühjahr für ausgefallen gehalten und ausgegraben, weil die Art sehr spät austreibt',
        'Während der Blüte komplett zurückgeschnitten, obwohl die Triebe an ihrer ganzen Länge weiterblühen',
        'Auf zu trockenem Standort gepflanzt: dort stellt sie die Blüte im Hochsommer ein',
      ],
      tipp: 'Die Sorte \'Buxton\'s Variety\' ist die bekannteste Auswahl dieser Art und trägt das kräftigste Weiß im Blütenauge. Wer Blüte bis zum Frost will, schneidet die Pflanze im Frühjahr nicht zu früh und lässt sie danach ungestört einwachsen.',
    },
  },
];

const db = new Database(DB_PFAD);
const spalten = new Set(db.prepare('PRAGMA table_info(pflanzen)').all().map(c => c.name));

let fehler = 0;
for (const p of NEU) {
  // Pflanzabstand rechnen statt schreiben — gleiche Regel wie bei allen anderen Zeilen.
  p.felder.pflanzabstand = pflanzabstandRechnen(p);

  // Gegen dieselbe Fachprüfung laufen lassen, die auch die generierten Texte passieren mussten.
  const raus = verstoesse(p.felder, p);
  if (raus.length) { console.error(`✗ ${p.name_botanisch}: ${raus.join('; ')}`); fehler++; }

  // Giftigkeit kommt aus der kuratierten Liste, nicht aus dem Text (beide Arten: nicht giftig).
  const gift = giftigkeit(p.name_botanisch);
  if (gift) { p.felder.giftig = gift.text; p.felder.giftstufe = gift.stufe; }
}
if (fehler) { console.error(`\n${fehler} Zeile(n) haben die Fachprüfung nicht bestanden — nichts geschrieben.`); process.exit(1); }

const einfuegen = db.transaction(() => {
  for (const p of NEU) {
    const vorhanden = db.prepare('SELECT id FROM pflanzen WHERE name_botanisch = ?').get(p.name_botanisch);
    if (vorhanden) { console.log(`— ${p.name_botanisch} steht schon drin (id ${vorhanden.id}), übersprungen`); continue; }
    const zeile = {
      name_deutsch: p.name_deutsch, name_botanisch: p.name_botanisch, beschreibung: p.beschreibung,
      licht: p.licht, boden: p.boden, stil: p.stil, bluehzeit: p.bluehzeit, farbe: p.farbe,
      hoehe_cm_min: p.hoehe_cm_min, hoehe_cm_max: p.hoehe_cm_max, breite_cm_max: p.breite_cm_max,
      pflege_sterne: p.pflege_sterne, preis_stueck_eur: p.preis_stueck_eur,
      winterhart_zone: p.winterhart_zone, bienen_freundlich: p.bienen_freundlich, heimisch: p.heimisch,
      feuchtigkeit: p.feuchtigkeit, wuchs: p.wuchs, lebensbereich: p.lebensbereich,
      rolle_empfehlung: p.rolle_empfehlung, kombinationspartner: p.kombinationspartner,
      winteraspekt: p.winteraspekt, trockenheitstoleranz: p.trockenheitstoleranz,
      lebensdauer: p.lebensdauer, inhalt_lang: JSON.stringify(p.felder),
      status: 'live', aktualisiert_am: HEUTE,
      // Bild bewusst leer: es wird über die normale Bildstrecke nachgezogen, nicht hier erfunden.
      bild_url: null, bild_lizenz: null, bild_geprueft: 0, bild_gesperrt: 0, bild_ki: 0,
    };
    for (const k of Object.keys(zeile)) if (!spalten.has(k)) throw new Error(`Spalte fehlt: ${k}`);
    const keys = Object.keys(zeile);
    const sql = `INSERT INTO pflanzen (${keys.join(', ')}) VALUES (${keys.map(k => '@' + k).join(', ')})`;
    const r = db.prepare(sql).run(zeile);
    console.log(`✓ ${p.name_botanisch} eingefügt (id ${r.lastInsertRowid}) — /pflanze/${p.name_botanisch.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`);
    console.log(`   Pflanzabstand: ${p.felder.pflanzabstand}`);
  }
});

if (DRY) {
  console.log('--dry-run: nichts geschrieben. Geprüfte Zeilen:');
  for (const p of NEU) console.log(`  ${p.name_botanisch} — Pflanzabstand: ${p.felder.pflanzabstand}`);
} else {
  einfuegen();
  console.log(`\nPflanzen gesamt: ${db.prepare('SELECT COUNT(*) n FROM pflanzen').get().n}`);
}
db.close();
