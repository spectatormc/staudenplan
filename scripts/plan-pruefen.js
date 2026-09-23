/*
 * SCHLUSSPRÜFUNG EINES BEPFLANZUNGSPLANS.
 *
 * Bis zum 23.09.2026 wurde ein fertiger Plan nie geprüft. Der Planer filterte Kandidaten,
 * das Modell wählte aus, und was herauskam, ging ungesehen an den Kunden. Eine Staudengärtnerei
 * hat vier solcher Pläne beurteilt und geschrieben: „Unter Gärtnern: da ist richtiger Mist
 * dabei!" — zu Recht. In einem Plan standen zehn Arten auf 2,56 m², zwei davon mit 150 cm
 * Endhöhe auf einem Beet von anderthalb Metern Kante.
 *
 * WARUM HIER UND NICHT IM PROMPT: Das Projekt hat mehrfach erlebt, dass eine Bitte an das
 * Modell keine Regel ist. Was der Kunde nicht sehen soll, muss der Code abfangen — nicht der
 * Prompt erbitten. Diese Datei rechnet, sie bittet nicht.
 *
 * WAS SIE PRÜFT, und warum genau das:
 * Ausschliesslich Dinge, die sich aus Plan und Anfrage BERECHNEN lassen. Sie braucht kein
 * gärtnerisches Urteil über die einzelne Art und ist deshalb auch dann noch richtig, wenn eine
 * Zeile in der Datenbank falsch ist — und das ist der Normalfall: Ein Audit am 23.09.2026 hat
 * gezeigt, dass sich die 711 Zeilen fast nirgends selbst widersprechen, die Fehler aber
 * trotzdem da sind (Gentiana sino-ornata, eine Moorbeetpflanze, steht in sich stimmig als
 * „Steppenheide"). Eine Prüfung, die auf korrekte Einzeldaten angewiesen ist, hilft dort nicht.
 *
 * WAS SIE NICHT PRÜFT — ehrlich, nicht werbend:
 * - Ob eine Art an diesen Standort gehört. Dafür müssten die Felder stimmen.
 * - Ob die Kombination schön ist. Das ist kein Rechenproblem.
 * - Ob die Blütenfolge trägt. Machbar, aber hier bewusst nicht drin: Die Blühzeitdaten haben
 *   einen bekannten Parser-Blindfleck bei jahresübergreifenden Angaben.
 * Ein bestandener Lauf heisst also „nichts offensichtlich Unmögliches", nicht „gärtnerisch gut".
 */

/* ── Schwellen, jede mit Begründung ──────────────────────────────────────────────────────
 *
 * Die Zahlen sind gärtnerische Faustregeln, keine Naturgesetze. Sie stehen hier zusammen,
 * damit man sie ändern kann, ohne sie zu suchen — und mit Begründung, damit man weiss, was
 * man ändert. */

// Eine Art, die als Gruppe wirken soll, braucht mindestens drei Exemplare. Weniger ist ein
// Einzelstück — bei Leitstauden gewollt, bei Begleit- und Füllstauden ein Sammelsurium.
const GRUPPE_MIN = 3;

// Platzbedarf einer durchschnittlichen Staude als Gruppe: rund 0,55 m² je Art bei drei
// Exemplaren. Daraus folgt die Artenzahl, die auf eine Fläche passt, ohne dass daraus ein
// Flickenteppich wird.
const FLAECHE_JE_ART = 0.55;

// Endhöhe zur Beetkante: Eine Staude, die höher wird als drei Viertel der kürzesten Beetkante,
// erschlägt die Fläche optisch. Bei einem 2,5-m²-Beet (Kante rund 1,6 m) sind das 120 cm.
const HOEHE_ZU_KANTE = 0.75;

// Pflanzdichte je m². Unter 4 bleibt der Boden auf Jahre offen (Unkraut), über 12 stehen die
// Stauden sich gegenseitig im Weg. Die Spanne ist weit, weil Bodendecker und Leitstauden
// völlig verschieden dicht stehen.
const DICHTE_MIN = 4;
const DICHTE_MAX = 12;

/* Feuchte-Ansprüche, die einander ausschliessen. Wer für die eine Gruppe giesst, schadet der
 * anderen — das ist der Befund, an dem die Gärtnerei den Plan mit dem Enzian festgemacht hat.
 * „normal" und „wechselfeucht" vertragen sich mit beiden Seiten und stehen deshalb nicht hier. */
const FEUCHT_TROCKEN = new Set(['trocken']);
const FEUCHT_NASS = new Set(['feucht', 'nass']);

/* Lebensbereiche nach Hansen/Stahl, die nicht in dieselbe Pflanzung gehören. Die Paarung ist
 * bewusst knapp gehalten: nur was sich im Wasserhaushalt ausschliesst. Gehölzrand und Waldsaum
 * etwa vertragen sich mit fast allem und stehen deshalb nicht drin.
 *
 * DIE SPALTENFOLGE TRÄGT BEDEUTUNG: links der trockene Pol, rechts der nasse. Daraus leitet
 * lbAusschluss() ab, welcher Pol auf einem Standort nichts zu suchen hat — der Planer filtert
 * die Kandidaten damit VORHER, diese Datei prüft NACHHER. Wer hier ein Paar ergänzt, ändert
 * beides zugleich; eine zweite Liste im Server gibt es bewusst nicht. */
const LB_UNVERTRAEGLICH = [
  ['steppenheide', 'quellflur'],
  ['steppenheide', 'wasserfläche'],
  ['steppenheide', 'teichrand'],
  ['offener rohboden', 'quellflur'],
  ['offener rohboden', 'wasserfläche'],
];

/* Die beiden Pole, aus der Tabelle abgeleitet statt ein zweites Mal geschrieben. */
const LB_POL_TROCKEN = [...new Set(LB_UNVERTRAEGLICH.map(([a]) => a))];
const LB_POL_NASS    = [...new Set(LB_UNVERTRAEGLICH.map(([, b]) => b))];

/**
 * Welche Lebensbereiche gehören auf einen Standort dieser Feuchte NICHT?
 *
 * Es wird immer nur der GEGENPOL ausgeschlossen, nie positiv gefiltert. Positiv zu filtern
 * ("nur Steppenheide") würde die Kandidatenliste zusammenschnurren lassen, bis der Planer in
 * den Ausweichpfad fällt — und damit genau den Schaden anrichten, den er verhindern soll.
 * Der Ausschluss dagegen nimmt höchstens den kleineren der beiden Pole weg und macht es
 * unmöglich, dass beide zugleich im Topf liegen.
 *
 * Wechselfeucht und normal zählen zur trockenen Seite: Ein normales Gartenbeet ist keine
 * Quellflur, aber Steppenheide-Arten stehen dort regelmässig und zu Recht.
 *
 * @param {string} feuchtigkeit Wert aus getFeuchtigkeit(): trocken|normal|wechselfeucht|feucht|nass
 * @returns {string[]} kleingeschriebene Lebensbereiche, die auszuschliessen sind
 */
function lbAusschluss(feuchtigkeit) {
  const f = String(feuchtigkeit || '').toLowerCase();
  return (f === 'feucht' || f === 'nass') ? [...LB_POL_TROCKEN] : [...LB_POL_NASS];
}

/* Die beiden Grenzen, die sich allein aus der Beetfläche ergeben — als Funktion, nicht als
 * Rechnung mitten im Prüfcode. Der Planer in stauden-server.js stellt dem Modell damit VORHER
 * dieselben Zahlen als harte Vorgabe hin, die hier NACHHER geprüft werden. Stünde die Rechnung
 * zweimal da, wäre der Plan irgendwann genau an der Stelle ungültig, an der er der Vorgabe folgt.
 * Bis zum 23.09.2026 war das tatsächlich so: Die ROLLENPFLICHT im Prompt verlangte mindestens
 * sechs Arten, auf 2,56 m² tragen aber nur vier — jeder kleine Plan war damit zwangsläufig
 * regelwidrig. */
function maxArtenFuer(flaeche) {
  const f = zahl(flaeche);
  return f ? Math.max(3, Math.floor(f / FLAECHE_JE_ART)) : null;
}

/**
 * Die kürzeste Beetkante in Metern — gemessen, wenn es geht, sonst geschätzt.
 *
 * Das Formular kennt zwei Modi: entweder eine Fläche in m², oder Länge × Breite. Im zweiten
 * Fall liegt die echte kurze Kante vor, und dann ist jede Schätzung daneben: Bei 4,0 × 0,64 m
 * (2,56 m²) ergibt die Wurzel 1,6 m — mehr als das Doppelte der echten Kante, und der Kunde
 * las diese 1,6 m als Tatsache über SEIN Beet. `gemessen` unterscheidet die beiden Fälle,
 * damit der Befundtext die Zahl nur nennt, wenn sie vom Kunden stammt.
 */
function kanteFuer(anfrage = {}) {
  const l = zahl(anfrage.beetLaenge), b = zahl(anfrage.beetBreite);
  if (l > 0 && b > 0) return { kante: Math.min(l, b), gemessen: true };
  const f = zahl(anfrage.gartenflaeche);
  return { kante: f > 0 ? Math.sqrt(f) : null, gemessen: false };
}

/* Zweites Argument ist die kurze Kante in Metern. Fehlt sie, wird aus der Fläche ein Quadrat
 * angenommen. Der Planer MUSS dieselbe Kante einsetzen, mit der hier geprüft wird — sonst
 * filtert er nach 1,6 m und beanstandet nach 0,64 m. */
function maxHoeheFuer(flaeche, kante) {
  const k = zahl(kante) || kanteFuer({ gartenflaeche: flaeche }).kante;
  return k ? Math.round(k * 100 * HOEHE_ZU_KANTE) : null;
}

/* Deutsches Dezimalkomma. Die Befundtexte gehen seit 23.09.2026 an den Kunden — „2.6 m²“
 * liest sich dort wie ein Tippfehler, und „0.64 m“ wie eine Zahl aus einer Tabelle. */
const mZahl = (n, stellen = 1) => n.toFixed(stellen).replace(/0$/, '').replace(/\.$/, '').replace('.', ',');

const teile = feld => String(feld || '').toLowerCase().split(/[|,]/).map(s => s.trim()).filter(Boolean);
const zahl = w => { const n = Number(w); return Number.isFinite(n) ? n : null; };

/**
 * Prüft einen fertigen Plan gegen die Anfrage.
 * @param {{pflanzen: Array}} plan
 * @param {{gartenflaeche: number}} anfrage
 * @returns {{befunde: Array<{regel, schwere, text}>, hart: number}}
 *   schwere: 'hart' = so nicht ausliefern · 'weich' = auffällig, aber vertretbar
 */
function planPruefen(plan, anfrage = {}) {
  const befunde = [];
  const melde = (regel, schwere, text) => befunde.push({ regel, schwere, text });

  const pflanzen = Array.isArray(plan && plan.pflanzen) ? plan.pflanzen : [];
  const flaeche = zahl(anfrage.gartenflaeche);
  if (!pflanzen.length) return { befunde: [{ regel: 'leer', schwere: 'hart', text: 'Der Plan enthält keine Pflanzen.' }], hart: 1 };

  // Geophyten (Zwiebeln) stehen ZWISCHEN den Stauden und brauchen keine eigene Fläche —
  // sie zählen deshalb bei Artenzahl, Dichte und Höhe nicht mit.
  const stauden = pflanzen.filter(p => (p.rolle || '') !== 'Geophyt');
  const stueck = p => Math.max(1, zahl(p.stueckzahl) || 1);
  const gesamtStueck = stauden.reduce((s, p) => s + stueck(p), 0);

  // ── 1. Artenzahl zur Fläche ────────────────────────────────────────────────────────────
  if (flaeche) {
    const maxArten = maxArtenFuer(flaeche);
    if (stauden.length > maxArten) {
      melde('artenzahl', 'hart',
        `${stauden.length} Arten auf ${mZahl(flaeche)} m². Auf dieser Fläche tragen höchstens `
        + `${maxArten}, wenn jede Art als Gruppe wirken soll (rund ${FLAECHE_JE_ART} m² je Art). `
        + `Mehr Arten ergeben einen Flickenteppich statt einer Pflanzung.`);
    }
  }

  // ── 2. Endhöhe zur Beetkante ───────────────────────────────────────────────────────────
  // Die Kante wird nur dann im Text genannt, wenn der Kunde sie selbst eingegeben hat. Eine
  // aus der Fläche gewurzelte Kante ist eine Annahme, und dieser Text behauptet sonst eine
  // Tatsache über ein Beet, das der Kunde anders kennt. Der Satz trägt auch ohne sie.
  const { kante, gemessen } = kanteFuer(anfrage);
  if (flaeche || kante) {
    const maxHoehe = maxHoeheFuer(flaeche, kante);
    const zuHoch = stauden.filter(p => (zahl(p.hoehe_cm_max) || 0) > maxHoehe);
    if (zuHoch.length) {
      const wo = gemessen ? `ein Beet mit ${mZahl(kante, 2)} m kurzer Kante`
               : `ein Beet von ${mZahl(flaeche)} m²`;
      melde('endhoehe', 'hart',
        `${zuHoch.length} Art(en) werden höher als ${maxHoehe} cm und erschlagen ${wo}: `
        + zuHoch.map(p => `${p.name_deutsch || p.name_botanisch} (${p.hoehe_cm_max} cm)`).join(', ') + '.');
    }
  }

  // ── 3. Pflanzdichte ────────────────────────────────────────────────────────────────────
  if (flaeche && gesamtStueck) {
    const dichte = gesamtStueck / flaeche;
    if (dichte < DICHTE_MIN) {
      melde('dichte', 'weich',
        `${mZahl(dichte)} Pflanzen je m² (${gesamtStueck} auf ${mZahl(flaeche)} m²). `
        + `Unter ${DICHTE_MIN} bleibt der Boden jahrelang offen und verkrautet.`);
    } else if (dichte > DICHTE_MAX) {
      melde('dichte', 'weich',
        `${mZahl(dichte)} Pflanzen je m². Über ${DICHTE_MAX} stehen die Stauden sich im Weg.`);
    }
  }

  // ── 4. Gruppengrösse ───────────────────────────────────────────────────────────────────
  const einzelgaenger = stauden.filter(p => (p.rolle || '') !== 'Leitstaude' && stueck(p) < GRUPPE_MIN);
  if (einzelgaenger.length > Math.max(1, Math.floor(stauden.length / 3))) {
    melde('gruppen', 'weich',
      `${einzelgaenger.length} von ${stauden.length} Arten stehen in weniger als ${GRUPPE_MIN} `
      + `Exemplaren. Einzelstücke wirken als Sammlung, nicht als Pflanzung.`);
  }

  // ── 5. Unvereinbare Feuchteansprüche ───────────────────────────────────────────────────
  const trocken = stauden.filter(p => teile(p.feuchtigkeit).some(t => FEUCHT_TROCKEN.has(t)));
  const nass = stauden.filter(p => teile(p.feuchtigkeit).some(t => FEUCHT_NASS.has(t)));
  if (trocken.length && nass.length) {
    melde('feuchte', 'hart',
      `Der Plan mischt Trockenheitszeiger und Feuchtezeiger in einem Beet: `
      + `${trocken.map(p => p.name_deutsch || p.name_botanisch).slice(0, 3).join(', ')} wollen es trocken, `
      + `${nass.map(p => p.name_deutsch || p.name_botanisch).slice(0, 3).join(', ')} feucht. `
      + `Es gibt keine Giessweise, die beiden gerecht wird.`);
  }

  // ── 6. Unvereinbare Lebensbereiche ─────────────────────────────────────────────────────
  const lbVorhanden = new Set(stauden.flatMap(p => teile(p.lebensbereich)));
  for (const [a, b] of LB_UNVERTRAEGLICH) {
    if (lbVorhanden.has(a) && lbVorhanden.has(b)) {
      const einA = stauden.filter(p => teile(p.lebensbereich).includes(a)).map(p => p.name_deutsch || p.name_botanisch);
      const einB = stauden.filter(p => teile(p.lebensbereich).includes(b)).map(p => p.name_deutsch || p.name_botanisch);
      melde('lebensbereich', 'hart',
        `Der Plan mischt die Lebensbereiche „${a}" und „${b}", die sich im Wasserhaushalt `
        + `ausschliessen: ${einA.slice(0, 2).join(', ')} gegen ${einB.slice(0, 2).join(', ')}.`);
    }
  }

  return { befunde, hart: befunde.filter(b => b.schwere === 'hart').length };
}

/* ── Selbsttest ───────────────────────────────────────────────────────────────────────────
 * Geprüft wird an den ECHTEN Plänen, die die Gärtnerei beanstandet hat — nicht an erfundenen.
 * Eine Prüfung, die den Anlassfall nicht findet, ist keine.
 *   node scripts/plan-pruefen.js --selbsttest
 */
if (typeof require !== 'undefined' && require.main === module && process.argv.includes('--selbsttest')) {
  let fehler = 0;
  const ok = (bed, was) => { console.log((bed ? 'ok    ' : 'FEHLER') + '  ' + was); if (!bed) fehler++; };

  // Anfrage 17: 10 Arten auf 2,56 m², Liatris 150 cm, Heliopsis 150 cm.
  const a17 = { gartenflaeche: 2.56 };
  const p17 = { pflanzen: [
    { name_deutsch: 'Sonnenauge', hoehe_cm_max: 150, stueckzahl: 3, feuchtigkeit: 'normal', lebensbereich: 'Freifläche' },
    { name_deutsch: 'Dichte Prachtscharte', hoehe_cm_max: 150, stueckzahl: 3, feuchtigkeit: 'normal', lebensbereich: 'Freifläche' },
    { name_deutsch: 'Purpur-Sonnenhut', hoehe_cm_max: 90, stueckzahl: 3, feuchtigkeit: 'normal', lebensbereich: 'Freifläche' },
    { name_deutsch: 'Wiesenknopf', hoehe_cm_max: 100, stueckzahl: 3, feuchtigkeit: 'feucht', lebensbereich: 'Quellflur' },
    { name_deutsch: 'Katzenminze', hoehe_cm_max: 90, stueckzahl: 3, feuchtigkeit: 'trocken', lebensbereich: 'Steppenheide' },
    { name_deutsch: 'Storchschnabel', hoehe_cm_max: 60, stueckzahl: 3, feuchtigkeit: 'normal', lebensbereich: 'Gehölzrand' },
    { name_deutsch: 'Mittagsblume', hoehe_cm_max: 10, stueckzahl: 6, feuchtigkeit: 'trocken', lebensbereich: 'Steppenheide' },
    { name_deutsch: 'Färber-Hundskamille', hoehe_cm_max: 60, stueckzahl: 6, feuchtigkeit: 'trocken', lebensbereich: 'Steppenheide' },
    { name_deutsch: 'Goldlack-Krokus', hoehe_cm_max: 10, stueckzahl: 6, rolle: 'Geophyt' },
    { name_deutsch: 'Prärielilie', hoehe_cm_max: 60, stueckzahl: 6, rolle: 'Geophyt' },
  ] };
  const r17 = planPruefen(p17, a17);
  ok(r17.befunde.some(b => b.regel === 'artenzahl'), 'Anfrage 17: 8 Stauden auf 2,56 m² werden als zu viele Arten gemeldet');
  ok(r17.befunde.some(b => b.regel === 'endhoehe'), 'Anfrage 17: 150-cm-Stauden auf 2,56 m² werden gemeldet');
  ok(r17.befunde.some(b => b.regel === 'feuchte'), 'Anfrage 17: trocken und feucht im selben Beet werden gemeldet');
  ok(r17.befunde.some(b => b.regel === 'lebensbereich'), 'Anfrage 17: Steppenheide neben Quellflur wird gemeldet');
  ok(r17.hart >= 3, `Anfrage 17 hat harte Befunde (${r17.hart})`);

  // Anfrage 15: 80 m², 8 Arten, 220 Pflanzen — gärtnerisch weitgehend in Ordnung laut
  // Gegenprobe. Die Dichte ist niedrig, das darf auffallen, aber nichts davon ist hart.
  const p15 = { pflanzen: [
    { name_deutsch: 'Bartfaden', hoehe_cm_max: 80, stueckzahl: 10, feuchtigkeit: 'trocken', lebensbereich: 'Freifläche,Steppenheide' },
    { name_deutsch: 'Königskerze', hoehe_cm_max: 120, stueckzahl: 10, feuchtigkeit: 'trocken', lebensbereich: 'Steppenheide' },
    { name_deutsch: 'Fetthenne', hoehe_cm_max: 50, stueckzahl: 15, feuchtigkeit: 'trocken', lebensbereich: 'Steppenheide' },
    { name_deutsch: 'Prachtkerze', hoehe_cm_max: 90, stueckzahl: 15, feuchtigkeit: 'trocken', lebensbereich: 'Steppenheide' },
    { name_deutsch: 'Lavendel', hoehe_cm_max: 60, stueckzahl: 40, feuchtigkeit: 'trocken', lebensbereich: 'Steppenheide' },
    { name_deutsch: 'Thymian', hoehe_cm_max: 10, stueckzahl: 100, feuchtigkeit: 'trocken', lebensbereich: 'Steppenheide' },
    { name_deutsch: 'Ziströschen', hoehe_cm_max: 60, stueckzahl: 15, feuchtigkeit: 'trocken', lebensbereich: 'Steppenheide' },
    { name_deutsch: 'Pfriemengras', hoehe_cm_max: 70, stueckzahl: 15, feuchtigkeit: 'trocken', lebensbereich: 'Steppenheide' },
  ] };
  const r15 = planPruefen(p15, { gartenflaeche: 80 });
  ok(r15.hart === 0, `Anfrage 15 hat KEINE harten Befunde (${r15.hart}) — der Plan war fachlich in Ordnung`);
  ok(r15.befunde.some(b => b.regel === 'dichte'), 'Anfrage 15: die niedrige Dichte faellt als weicher Befund auf');

  // Ein unauffaelliger Plan darf gar nichts melden.
  const rGut = planPruefen({ pflanzen: [
    { name_deutsch: 'A', hoehe_cm_max: 60, stueckzahl: 5, feuchtigkeit: 'normal', lebensbereich: 'Freifläche' },
    { name_deutsch: 'B', hoehe_cm_max: 40, stueckzahl: 7, feuchtigkeit: 'normal', lebensbereich: 'Freifläche' },
    { name_deutsch: 'C', hoehe_cm_max: 90, stueckzahl: 3, rolle: 'Leitstaude', feuchtigkeit: 'normal', lebensbereich: 'Freifläche' },
  ] }, { gartenflaeche: 3 });   // 15 Pflanzen auf 3 m² = 5/m², mitten im Zielband
  ok(rGut.befunde.length === 0, `ein stimmiger Plan meldet nichts (gemeldet: ${rGut.befunde.length})`);

  ok(planPruefen({ pflanzen: [] }, {}).hart === 1, 'ein leerer Plan ist ein harter Befund');

  // Die abgeleiteten Grenzen. Sie gehen VOR dem Modelllauf in den Prompt und MUESSEN
  // dieselbe Zahl liefern wie die Pruefung, sonst folgt der Plan einer Vorgabe, die ihn
  // anschliessend durchfallen laesst.
  ok(maxArtenFuer(2.56) === 4, `2,56 m² tragen 4 Arten (${maxArtenFuer(2.56)})`);
  ok(maxArtenFuer(80) === 145, `80 m² tragen 145 Arten (${maxArtenFuer(80)})`);
  ok(maxArtenFuer(0.5) === 3, 'unter der Schwelle bleiben 3 Arten das Minimum');
  ok(maxArtenFuer(null) === null && maxHoeheFuer(0) === null, 'ohne Flaeche gibt es keine Grenze, keine geratene');
  ok(maxHoeheFuer(2.56) === 120, `2,56 m² erlauben 120 cm (${maxHoeheFuer(2.56)})`);

  // Der Lebensbereich-Ausschluss: immer nur der Gegenpol, nie eine positive Auswahl.
  ok(lbAusschluss('nass').includes('steppenheide'), 'nasser Standort schliesst Steppenheide aus');
  ok(lbAusschluss('feucht').includes('offener rohboden'), 'feuchter Standort schliesst offenen Rohboden aus');
  ok(lbAusschluss('trocken').includes('quellflur') && lbAusschluss('trocken').includes('teichrand'),
     'trockener Standort schliesst Quellflur und Teichrand aus');
  ok(lbAusschluss('normal').includes('quellflur'), 'normaler Boden ist keine Quellflur');
  ok(!lbAusschluss('normal').includes('steppenheide'), 'normaler Boden behaelt die Steppenheide — sonst faellt der Topf zusammen');
  // Die Probe aufs Exempel: Wer den Gegenpol vorher wegnimmt, kann die Regel nicht mehr verletzen.
  for (const f of ['trocken', 'normal', 'wechselfeucht', 'feucht', 'nass']) {
    const weg = new Set(lbAusschluss(f));
    ok(LB_UNVERTRAEGLICH.every(([a, b]) => weg.has(a) || weg.has(b)),
       `Feuchte "${f}": jedes unvertraegliche Paar ist aufgetrennt`);
  }
  ok(planPruefen({ pflanzen: [{ name_deutsch: 'X', stueckzahl: 3 }] }, {}).befunde.length === 0,
     'ohne Flaechenangabe werden die flaechenabhaengigen Regeln uebersprungen statt geraten');

  console.log(fehler ? `\n${fehler} Fehler` : '\n--- Selbsttest bestanden ---');
  process.exit(fehler ? 1 : 0);
}

/* Laeuft in BEIDEN Umgebungen — wie scripts/preis-spanne.js und aus demselben Grund: Der
 * Browser aendert den Plan nach der Antwort noch (Alternative tauschen, Dichte umstellen) und
 * muss die Befunde dann neu bilden. Eine zweite, abgetippte Fassung der Schwellen wuerde
 * frueher oder spaeter von dieser hier abweichen, und dann behauptete der gelbe Kasten etwas,
 * das der Server nie gerechnet hat. stauden-server.js setzt den Quelltext dieser Datei beim
 * Ausliefern von stauden-portal.html an der dafuer vorgesehenen Stelle ein, in eine IIFE
 * gekapselt.
 * Deshalb sind die Zeile oben (require.main) und diese hier typgeprueft statt roh. */
if (typeof module !== 'undefined' && module.exports) module.exports = {
  planPruefen, lbAusschluss, maxArtenFuer, maxHoeheFuer, kanteFuer,
  GRUPPE_MIN, FLAECHE_JE_ART, HOEHE_ZU_KANTE, DICHTE_MIN, DICHTE_MAX,
  LB_UNVERTRAEGLICH, LB_POL_TROCKEN, LB_POL_NASS };
