/*
 * DAS VOKABULAR DER LEBENSBEREICHE — an einer Stelle.
 *
 * WARUM DIESE DATEI AM 23.09.2026 ENTSTANDEN IST:
 *
 * Die Spalte `lebensbereich` ist nicht importiert, sondern von gpt-4o erzeugt worden
 * (scripts/enrich-pflanzen.js). Der Prompt bot dem Modell wörtlich diese Beispiele an:
 *
 *     'Freifläche', 'Gehölzrand', 'Waldsaum', 'Quellflur', 'Steppenheide',
 *     'Staudenheide', 'Offener Rohboden' — bis zu 2 kommagetrennt
 *
 * Fünf Bereiche fehlten darin: GEHÖLZ, BEET, STEINANLAGE, TEICHRAND, WASSERFLÄCHE. Und die
 * Verteilung im Bestand ist genau das Abbild dieser Liste, nicht der Pflanzen:
 *
 *     Gehölzrand 448 · Freifläche 430 · Steppenheide 192 · Waldsaum 184 · Quellflur 62
 *     -------- ab hier die fünf, die nicht angeboten wurden ---------------------------
 *     Beet 24 · Gehölz 18 · Wasserfläche 11 · Steinanlage 4 · Teichrand 2
 *
 * Eine externe Stichprobe über 35 Arten (23.09.2026, mit Gegenprobe) fand 17 von 20
 * Beanstandungen an genau dieser Stelle: Es fehlte einer der fünf nicht angebotenen Bereiche.
 * Wurmfarn, Frauenfarn und Königsfarn stehen auf „Gehölzrand,Waldsaum", weil „Gehölz" nie
 * zur Auswahl stand.
 *
 * DAZU ZWEI EINZELNE WÖRTER, die das Ergebnis systematisch verzogen haben:
 *   - WALDSAUM ist im Kürzelsystem kein eigener Bereich; der Saum fällt unter Gehölzrand.
 *     Er stand trotzdem im Prompt und trägt heute 184 Zeilen. In zehn von elf geprüften
 *     Fällen nannte ihn keine einzige Fachquelle.
 *   - STAUDENHEIDE gibt es als Lebensbereich nicht. Das Modell hat die Vokabel ignoriert:
 *     0 Zeilen. Sie stand trotzdem in der Liste.
 *
 * UND EIN FORMATZWANG: „bis zu 2" — Hansen/Stahl vergibt regelmäßig drei Bereiche, gestaffelt
 * nach „vorwiegend" und „zusätzlich". 672 der 711 Zeilen tragen genau zwei Werte, 39 einen,
 * keine einzige drei. Das ist keine Eigenschaft der Pflanzen.
 *
 * DESHALB STEHT DAS VOKABULAR JETZT HIER. Wer eine Vokabel ändert, ändert damit den
 * Erzeugungslauf, die Normalisierung und die Prüfung zugleich — vorher gab es zwei Listen
 * im selben Projekt, deren Schnittmenge aus drei Wörtern bestand, und genau diese drei
 * bilden die drei häufigsten Kombinationen des Bestands.
 */

/* Die Bereiche nach Hansen/Stahl, mit dem Kürzel der Staudensystematik und der Eigenschaft,
 * die der Planer und die Prüfungen daraus ableiten.
 *   licht:   'hell' (voll besonnt) · 'rand' (lichter Rand) · 'dunkel' (unter Gehölzen) · null
 *   pol:     'trocken' | 'nass' | null — die beiden Pole, die sich ausschliessen
 *   wasser:  true, wenn der Bereich offenes Wasser voraussetzt */
const BEREICHE = {
  'Freifläche':      { kuerzel: 'Fr', licht: 'hell',   pol: null,      wasser: false,
                       was: 'baumfreie, vollsonnige Fläche mit Wildstaudencharakter' },
  'Beet':            { kuerzel: 'B',  licht: 'hell',   pol: null,      wasser: false,
                       was: 'gepflegter, gegossener Gartenboden — Zuchtsorten und Prachtstauden' },
  'Steppenheide':    { kuerzel: 'SH', licht: 'hell',   pol: 'trocken', wasser: false,
                       was: 'trocken-warm, mager, meist kalkreich' },
  'Steinanlage':     { kuerzel: 'St', licht: 'hell',   pol: null,      wasser: false,
                       was: 'mager, kiesig, wasserdurchlässig — Steinfugen, Tröge, Schotterbeete' },
  'Offener Rohboden':{ kuerzel: '',   licht: 'hell',   pol: 'trocken', wasser: false,
                       was: 'vegetationsfreier Pionierstandort' },
  'Gehölzrand':      { kuerzel: 'GR', licht: 'rand',   pol: null,      wasser: false,
                       was: 'der helle Rand von Gehölzgruppen, oft humos — der Saum gehört hierher' },
  'Gehölz':          { kuerzel: 'G',  licht: 'dunkel', pol: null,      wasser: false,
                       was: 'der beschattete Bereich unter Bäumen und großen Sträuchern' },
  'Quellflur':       { kuerzel: '',   licht: null,     pol: 'nass',    wasser: false,
                       was: 'dauerfeuchter bis sickernasser Boden OHNE offenes Wasser' },
  'Teichrand':       { kuerzel: 'WR', licht: null,     pol: 'nass',    wasser: true,
                       was: 'die Flachwasserzone am Ufer, rund 0 bis 20 cm Wassertiefe' },
  'Wasserfläche':    { kuerzel: 'W',  licht: null,     pol: 'nass',    wasser: true,
                       was: 'im Wasser — Schwimmblatt- und Unterwasserpflanzen' },
};

/* Schreibvarianten und das, was wir nicht mehr schreiben wollen. „Waldsaum" wird auf
 * Gehölzrand abgebildet, weil der Saum dort hingehört; „Staudenheide" und „Heide" sind
 * Pflanzungstypen, keine Lebensbereiche. Die Abbildung greift NICHT rückwirkend auf die
 * Datenbank — sie sorgt nur dafür, dass kein neuer Lauf diese Wörter wieder hineinschreibt. */
const SYNONYM = {
  'waldsaum': 'Gehölzrand',
  'gehölzränder': 'Gehölzrand',
  'saum': 'Gehölzrand',
  'freiflächen': 'Freifläche',
  'steingarten': 'Steinanlage',
  'staudenheide': 'Freifläche',
  'heide': 'Freifläche',
  'wasserrand': 'Teichrand',
  'sumpf': 'Quellflur',
  'wasser': 'Wasserfläche',
};

const NAMEN = Object.keys(BEREICHE);
const KUERZEL = Object.fromEntries(
  NAMEN.filter(n => BEREICHE[n].kuerzel).map(n => [BEREICHE[n].kuerzel.toUpperCase(), n]));

/** Ein einzelner Wert in die kanonische Schreibweise, oder null. */
function bereichNormalisieren(wert) {
  const roh = String(wert == null ? '' : wert).trim();
  if (!roh) return null;
  const kuerzelTreffer = roh.match(/^([A-Za-zÄÖÜäöü]{1,3})\s*\d?$/);     // „G2", „FR1", „B"
  if (kuerzelTreffer && KUERZEL[kuerzelTreffer[1].toUpperCase()]) return KUERZEL[kuerzelTreffer[1].toUpperCase()];
  const genau = NAMEN.find(n => n.toLowerCase() === roh.toLowerCase());
  if (genau) return genau;
  return SYNONYM[roh.toLowerCase()] || null;
}

/** Eine ganze Zelle („Gehölzrand, Waldsaum") in die kanonische Form. Alphabetisch sortiert,
 *  weil dieselbe Kombination sonst in zwei Reihenfolgen doppelt gezählt wird. */
function zelleNormalisieren(zelle) {
  const teile = String(zelle == null ? '' : zelle).split(/[,/|]/)
    .map(bereichNormalisieren).filter(Boolean);
  return [...new Set(teile)].sort((a, b) => a.localeCompare(b, 'de')).join(',');
}

/** Die Bereiche einer Zelle als Namen. Unbekanntes fällt weg — wer es zählen will, nimmt
 *  `unbekannteBereiche`. */
function bereicheVon(zelle) {
  return String(zelle == null ? '' : zelle).split(/[,/|]/)
    .map(bereichNormalisieren).filter(Boolean);
}

/** Was in einer Zelle steht und in keinem Vokabular vorkommt. Für Prüfungen. */
function unbekannteBereiche(zelle) {
  return String(zelle == null ? '' : zelle).split(/[,/|]/)
    .map(t => t.trim()).filter(Boolean)
    .filter(t => !bereichNormalisieren(t));
}

/** Die Vokabelliste für einen Prompt — aus derselben Tabelle, nicht abgetippt. */
function promptVokabular() {
  return NAMEN.map(n => `'${n}' (${BEREICHE[n].was})`).join(', ');
}

if (typeof require !== 'undefined' && require.main === module && process.argv.includes('--selbsttest')) {
  let fehler = 0;
  const ok = (bed, was) => { console.log((bed ? 'ok    ' : 'FEHLER') + '  ' + was); if (!bed) fehler++; };

  ok(bereichNormalisieren('Waldsaum') === 'Gehölzrand', 'Waldsaum wird auf Gehölzrand abgebildet');
  ok(bereichNormalisieren('Staudenheide') === 'Freifläche', 'Staudenheide (kein echter Bereich) faellt auf Freiflaeche');
  ok(bereichNormalisieren('G2') === 'Gehölz' && bereichNormalisieren('FR1') === 'Freifläche'
     && bereichNormalisieren('WR') === 'Teichrand', 'Kuerzel mit und ohne Feuchtestufe werden erkannt');
  ok(bereichNormalisieren('Mondwiese') === null, 'ein erfundener Bereich wird NICHT geraten');
  ok(zelleNormalisieren('Gehölzrand, Waldsaum') === 'Gehölzrand',
     'doppelte Bedeutung faellt beim Normalisieren zusammen ("Gehölzrand, Waldsaum" ist einmal Gehölzrand)');
  ok(zelleNormalisieren('Waldsaum,Freifläche') === 'Freifläche,Gehölzrand', 'alphabetisch sortiert');
  ok(unbekannteBereiche('Gehölzrand,Mondwiese').join(',') === 'Mondwiese', 'Unbekanntes wird gemeldet, nicht verschluckt');

  /* Die Bereiche, die im Erzeugungs-Prompt gefehlt haben, MUESSEN im Vokabular stehen — das
   * ist der ganze Grund fuer diese Datei. Ohne diese Probe koennte jemand einen davon
   * wieder herausnehmen, ohne dass etwas auffaellt. */
  for (const n of ['Gehölz', 'Beet', 'Steinanlage', 'Teichrand', 'Wasserfläche']) {
    ok(NAMEN.includes(n), `"${n}" steht im Vokabular (fehlte im Erzeugungs-Prompt bis 23.09.2026)`);
  }
  ok(!NAMEN.includes('Waldsaum'), '"Waldsaum" ist KEIN eigener Bereich mehr');
  ok(promptVokabular().includes('Gehölz') && promptVokabular().includes('Wasserfläche')
     && !promptVokabular().includes('Waldsaum'), 'die Prompt-Liste kommt aus derselben Tabelle');

  const pole = NAMEN.filter(n => BEREICHE[n].pol);
  ok(pole.length === 5, `fuenf Bereiche tragen einen Pol (${pole.join(', ')})`);

  /* Die Gegenprobe steht in scripts/plan-pruefen.js: Dort kodiert LB_UNVERTRAEGLICH dieselben
   * Pole ein zweites Mal, weil die Datei im Browser ohne require laeuft. Hier wird nur
   * festgehalten, dass es diese zweite Stelle GIBT — wer den Pol eines Bereichs aendert,
   * muss dort nachziehen, und der dortige Selbsttest faellt sonst durch. */
  ok(true, 'HINWEIS: die Pole stehen ein zweites Mal in scripts/plan-pruefen.js (LB_UNVERTRAEGLICH) — dessen Selbsttest vergleicht beide');

  console.log(fehler ? `\n${fehler} Fehler` : '\n--- Selbsttest bestanden ---');
  process.exit(fehler ? 1 : 0);
}

if (typeof module !== 'undefined' && module.exports) module.exports = {
  BEREICHE, SYNONYM, NAMEN, KUERZEL,
  bereichNormalisieren, zelleNormalisieren, bereicheVon, unbekannteBereiche, promptVokabular,
};
