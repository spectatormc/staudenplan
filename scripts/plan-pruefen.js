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

/* Pflanzdichte je m² — NACH DER GEWÄHLTEN STUFE, nicht pauschal.
 *
 * Hier standen bis zum 23.09.2026 zwei feste Zahlen: unter 4 zu dünn, über 12 zu dicht. Das
 * Formular bietet aber drei Stufen an und nennt je Karte eine eigene Spanne — „Locker
 * 2–3 Pfl./m²". Ein Kunde, der locker wählte und 2,5 bekam, löste damit zwangsläufig den
 * Befund „Unter 4 bleibt der Boden jahrelang offen" aus: Die Seite beanstandete, was sie
 * selbst angeboten hatte.
 *
 * DIE ZAHLEN SPIEGELN DIE AUSWAHLKARTEN in stauden-portal.html (2–3 / 3–5 / 6–8), mit etwas
 * Luft nach aussen für die Rundung. Wer dort eine Spanne ändert, ändert sie hier mit — und
 * umgekehrt. Aus demselben Satz Zahlen kommen drei Dinge: die Vorgabe im Prompt, die
 * deterministische Korrektur danach und dieser Befund.
 *
 * `ziel` ist die Mitte, an der die Korrektur ausrichtet; `min`/`max` ist das Band, innerhalb
 * dessen nichts gemeldet und nichts korrigiert wird. */
/* ZWEI ZAHLENPAARE JE STUFE, und der Unterschied ist wichtig:
 *   zusage    was dem Kunden auf der Auswahlkarte versprochen wird („Locker 2–3 Pfl./m²").
 *             Diese Zahlen gehen in den Prompt und in jeden Text, den er liest.
 *   min/max   die Spanne, innerhalb derer NICHTS beanstandet und NICHTS korrigiert wird.
 *             Sie ist etwas weiter, weil zwischen Vorgabe, Modell und Rundung Luft liegt.
 * Beides auseinanderzuhalten ist nötig, weil sonst eines von beidem falsch wäre: Wer dem
 * Kunden „2–4" sagt, widerspricht der Karte; wer bei 3,9 in der Stufe „locker" einen Befund
 * meldet, beanstandet eine Rundung. */
const DICHTE_STUFEN = {
  locker: { ziel: 2.5, zusage: [2, 3], min: 2,   max: 4  },
  normal: { ziel: 4,   zusage: [3, 5], min: 3,   max: 6  },
  dicht:  { ziel: 7,   zusage: [6, 8], min: 5.5, max: 10 },
};
const DICHTE_STANDARD = 'normal';

/** Der NAME der Stufe, die tatsächlich gilt. Unbekanntes fällt auf „normal" — und der
 *  Befundtext muss dann auch „normal" nennen, nicht den unbekannten Wert: Sonst begründet
 *  er die Zahlen mit einer Stufe, nach der gar nicht gerechnet wurde. */
function dichteStufeName(stufe) {
  const k = String(stufe == null ? '' : stufe).trim().toLowerCase();
  return DICHTE_STUFEN[k] ? k : DICHTE_STANDARD;
}

/** Die Dichtewerte zur gewählten Stufe. Unbekannte Stufe → „normal", nie geraten. */
function dichteStufe(stufe) {
  return DICHTE_STUFEN[dichteStufeName(stufe)];
}

/** Wie viele Pflanzen gehören auf diese Fläche? Einzige Ableitung im Projekt. */
function dichteZielFuer(flaeche, stufe) {
  const f = zahl(flaeche);
  return f ? Math.round(f * dichteStufe(stufe).ziel) : null;
}

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
/* Nachlaufende Nullen ALLE abschneiden, nicht nur eine: .replace(/0$/) machte aus "1,00"
 * die Zeichenkette "1,0", und der Kundentext las "ein Beet mit 1,0 m kurzer Kante". */
const mZahl = (n, stellen = 1) => n.toFixed(stellen).replace(/0+$/, '').replace(/\.$/, '').replace('.', ',');

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
  /* `mehr` haengt maschinenlesbar an, was der Text nur in Prosa nennt — der Aufrufer soll
   * die Namen nicht aus dem Satz zurueckparsen muessen, wenn er ihn anders einleiten will. */
  const melde = (regel, schwere, text, mehr) => befunde.push({ regel, schwere, text, ...mehr });

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
      const namen = zuHoch.map(p => `${p.name_deutsch || p.name_botanisch} (${p.hoehe_cm_max} cm)`);
      melde('endhoehe', 'hart',
        `${zuHoch.length} Art(en) werden höher als ${maxHoehe} cm und erschlagen ${wo}: `
        + namen.join(', ') + '.',
        { arten: namen, maxHoehe });
    }
  }

  // ── 3. Pflanzdichte ────────────────────────────────────────────────────────────────────
  // Gemessen wird gegen die Spanne der GEWÄHLTEN Stufe. Ohne Angabe gilt „normal", wie im
  // Formular vorausgewählt.
  if (flaeche && gesamtStueck) {
    const stufe = dichteStufe(anfrage.dichte);
    const wieGewaehlt = dichteStufeName(anfrage.dichte);
    const dichte = gesamtStueck / flaeche;
    if (dichte < stufe.min) {
      melde('dichte', 'weich',
        `${mZahl(dichte)} Pflanzen je m² (${gesamtStueck} auf ${mZahl(flaeche)} m²). `
        + `Für die Stufe „${wieGewaehlt}" sind ${mZahl(stufe.zusage[0])} bis ${mZahl(stufe.zusage[1])} vorgesehen; `
        + `darunter bleibt der Boden jahrelang offen und verkrautet.`,
        { jeM2: dichte, ziel: stufe.ziel, richtung: 'zu_duenn' });
    } else if (dichte > stufe.max) {
      melde('dichte', 'weich',
        `${mZahl(dichte)} Pflanzen je m². Für die Stufe „${wieGewaehlt}" sind höchstens `
        + `${mZahl(stufe.zusage[1])} vorgesehen; darüber stehen die Stauden sich im Weg.`,
        { jeM2: dichte, ziel: stufe.ziel, richtung: 'zu_dicht' });
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

  /*
   * DIE DICHTE IN BEIDE RICHTUNGEN UND JE STUFE. Geprueft wurde bis zum 23.09.2026 nur der
   * untere Zweig ueber Anfrage 15; der obere hatte keinen einzigen Testfall, und die Stufen
   * gab es noch nicht. Der wichtigste Fall ist der dritte: Wer „locker" waehlt und 2,5
   * Pflanzen je m² bekommt, hat genau das bestellt — und bekam trotzdem den Befund.
   */
  const dichtePlan = (stueckGesamt) => ({ pflanzen: [
    { name_deutsch: 'A', hoehe_cm_max: 60, stueckzahl: Math.round(stueckGesamt / 2), feuchtigkeit: 'normal', lebensbereich: 'Freifläche' },
    { name_deutsch: 'B', hoehe_cm_max: 40, stueckzahl: Math.round(stueckGesamt / 2), feuchtigkeit: 'normal', lebensbereich: 'Freifläche' },
  ] });
  const dichteBefund = (stueckGesamt, flaeche, stufe) =>
    planPruefen(dichtePlan(stueckGesamt), { gartenflaeche: flaeche, dichte: stufe })
      .befunde.find(b => b.regel === 'dichte') || null;

  ok(dichteBefund(200, 10, 'normal'), '20 Pflanzen je m² werden als zu dicht gemeldet (oberer Zweig)');
  ok(dichteBefund(200, 10, 'normal').richtung === 'zu_dicht', 'der obere Zweig meldet richtung=zu_dicht');
  ok(!dichteBefund(25, 10, 'locker'), '2,5 Pflanzen je m² bei Stufe „locker" sind KEIN Befund — genau das wurde gewaehlt');
  ok(dichteBefund(25, 10, 'normal'), 'dieselben 2,5 Pflanzen je m² bei Stufe „normal" sind ein Befund');
  ok(!dichteBefund(70, 10, 'dicht'), '7 Pflanzen je m² bei Stufe „dicht" sind kein Befund');
  ok(dichteBefund(70, 10, 'locker'), 'dieselben 7 Pflanzen je m² bei Stufe „locker" sind ein Befund');
  ok(dichteBefund(25, 10, 'fantasiestufe') && dichteBefund(25, 10, 'fantasiestufe').text.includes('normal'),
     'eine unbekannte Stufe faellt auf „normal" zurueck, statt geraten zu werden');
  ok(dichteZielFuer(80, 'normal') === 320 && dichteZielFuer(80, 'locker') === 200 && dichteZielFuer(80, 'dicht') === 560,
     'dichteZielFuer rechnet die Stufen richtig um (80 m² → 320 / 200 / 560)');

  /*
   * GRUPPENGROESSE — vorher ohne jeden Testfall. Sie greift, wenn mehr als ein Drittel der
   * Arten in weniger als drei Exemplaren steht; Leitstauden sind ausgenommen, weil dort das
   * Einzelstueck gewollt ist.
   */
  const rGruppen = planPruefen({ pflanzen: [
    { name_deutsch: 'Leitstaude einzeln', hoehe_cm_max: 120, stueckzahl: 1, rolle: 'Leitstaude', feuchtigkeit: 'normal' },
    { name_deutsch: 'Einzelstueck 1', hoehe_cm_max: 40, stueckzahl: 1, rolle: 'Füllstaude', feuchtigkeit: 'normal' },
    { name_deutsch: 'Einzelstueck 2', hoehe_cm_max: 40, stueckzahl: 2, rolle: 'Füllstaude', feuchtigkeit: 'normal' },
    { name_deutsch: 'Einzelstueck 3', hoehe_cm_max: 40, stueckzahl: 1, rolle: 'Füllstaude', feuchtigkeit: 'normal' },
    { name_deutsch: 'Gruppe', hoehe_cm_max: 40, stueckzahl: 9, rolle: 'Füllstaude', feuchtigkeit: 'normal' },
  ] }, { gartenflaeche: 4 });
  ok(rGruppen.befunde.some(b => b.regel === 'gruppen'), 'drei von fünf Arten als Einzelstueck werden als Sammlung gemeldet');
  ok(!planPruefen({ pflanzen: [
    { name_deutsch: 'Leitstaude einzeln', hoehe_cm_max: 120, stueckzahl: 1, rolle: 'Leitstaude', feuchtigkeit: 'normal' },
    { name_deutsch: 'Gruppe A', hoehe_cm_max: 40, stueckzahl: 5, rolle: 'Füllstaude', feuchtigkeit: 'normal' },
    { name_deutsch: 'Gruppe B', hoehe_cm_max: 40, stueckzahl: 5, rolle: 'Füllstaude', feuchtigkeit: 'normal' },
  ] }, { gartenflaeche: 4 }).befunde.some(b => b.regel === 'gruppen'),
     'die einzelne Leitstaude allein loest den Gruppenbefund NICHT aus');

  /*
   * DER L×B-ZWEIG von kanteFuer() — der Grund, aus dem die Kante nicht mehr geraten wird.
   * Ohne Testfall waere er nach dem naechsten Umbau still wieder die Wurzel aus der Flaeche.
   */
  const schmal = { gartenflaeche: 2.56, beetLaenge: 4.0, beetBreite: 0.64 };
  const quadratisch = { gartenflaeche: 2.56 };
  const hoch = { pflanzen: [{ name_deutsch: 'Hoch', hoehe_cm_max: 100, stueckzahl: 3, feuchtigkeit: 'normal' }] };
  ok(kanteFuer(schmal).gemessen === true && Math.abs(kanteFuer(schmal).kante - 0.64) < 1e-9,
     'mit L×B ist die kurze Kante gemessen (0,64 m), nicht gewurzelt');
  ok(kanteFuer(quadratisch).gemessen === false && Math.abs(kanteFuer(quadratisch).kante - 1.6) < 1e-9,
     'ohne L×B bleibt die Wurzel aus der Flaeche (1,6 m) — und sie gilt als geschaetzt');
  ok(maxHoeheFuer(2.56, kanteFuer(schmal).kante) === 48 && maxHoeheFuer(2.56) === 120,
     'die Endhoehengrenze folgt der Kante: 48 cm bei 0,64 m, 120 cm bei angenommenem Quadrat');
  ok(planPruefen(hoch, schmal).befunde.some(b => b.regel === 'endhoehe')
     && !planPruefen(hoch, quadratisch).befunde.some(b => b.regel === 'endhoehe'),
     'eine 100-cm-Staude ist auf 0,64 m Kante ein Befund, auf 1,6 m nicht');
  ok(planPruefen(hoch, schmal).befunde.find(b => b.regel === 'endhoehe').text.includes('0,64 m kurzer Kante'),
     'der Kundentext nennt die gemessene Kante');
  ok(!planPruefen(hoch, { gartenflaeche: 0.41 }).befunde.find(b => b.regel === 'endhoehe').text.includes('Kante'),
     'ohne gemessene Kante wird im Kundentext KEINE Kante genannt');

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

  /*
   * DIE ZWEITE POL-LISTE. scripts/lebensbereiche.js fuehrt `pol` je Bereich; hier stehen die
   * Paare. Beide kodieren dasselbe und koennen auseinanderlaufen — diese Probe faengt das ab.
   * Sie laeuft nur unter Node: Im Browser ist diese Datei eingesetzter Quelltext ohne require,
   * und genau deshalb gibt es die Doppelung ueberhaupt.
   */
  try {
    const lb = require('./lebensbereiche');
    const polVon = art => Object.keys(lb.BEREICHE)
      .filter(n => lb.BEREICHE[n].pol === art).map(n => n.toLowerCase()).sort();
    const hierTrocken = [...LB_POL_TROCKEN].sort();
    const hierNass = [...LB_POL_NASS].sort();
    ok(JSON.stringify(polVon('trocken')) === JSON.stringify(hierTrocken),
       `trockener Pol deckungsgleich mit lebensbereiche.js (hier: ${hierTrocken.join(', ')} — dort: ${polVon('trocken').join(', ')})`);
    ok(JSON.stringify(polVon('nass')) === JSON.stringify(hierNass),
       `nasser Pol deckungsgleich mit lebensbereiche.js (hier: ${hierNass.join(', ')} — dort: ${polVon('nass').join(', ')})`);
    const unbekannt = [...LB_POL_TROCKEN, ...LB_POL_NASS]
      .filter(n => !Object.keys(lb.BEREICHE).some(b => b.toLowerCase() === n));
    ok(unbekannt.length === 0, `jeder Pol-Name ist ein Bereich aus dem Vokabular${unbekannt.length ? ' — unbekannt: ' + unbekannt.join(', ') : ''}`);
  } catch (e) {
    ok(false, `Abgleich mit scripts/lebensbereiche.js nicht moeglich: ${e.message}`);
  }

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
  dichteStufe, dichteStufeName, dichteZielFuer,
  GRUPPE_MIN, FLAECHE_JE_ART, HOEHE_ZU_KANTE, DICHTE_STUFEN, DICHTE_STANDARD,
  LB_UNVERTRAEGLICH, LB_POL_TROCKEN, LB_POL_NASS };
