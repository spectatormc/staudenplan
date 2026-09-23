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
 * etwa vertragen sich mit fast allem und stehen deshalb nicht drin. */
const LB_UNVERTRAEGLICH = [
  ['steppenheide', 'quellflur'],
  ['steppenheide', 'wasserfläche'],
  ['steppenheide', 'teichrand'],
  ['offener rohboden', 'quellflur'],
  ['offener rohboden', 'wasserfläche'],
];

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
    const maxArten = Math.max(3, Math.floor(flaeche / FLAECHE_JE_ART));
    if (stauden.length > maxArten) {
      melde('artenzahl', 'hart',
        `${stauden.length} Arten auf ${flaeche.toFixed(1)} m². Auf dieser Fläche tragen höchstens `
        + `${maxArten}, wenn jede Art als Gruppe wirken soll (rund ${FLAECHE_JE_ART} m² je Art). `
        + `Mehr Arten ergeben einen Flickenteppich statt einer Pflanzung.`);
    }
  }

  // ── 2. Endhöhe zur Beetkante ───────────────────────────────────────────────────────────
  if (flaeche) {
    const kante = Math.sqrt(flaeche);
    const maxHoehe = Math.round(kante * 100 * HOEHE_ZU_KANTE);
    const zuHoch = stauden.filter(p => (zahl(p.hoehe_cm_max) || 0) > maxHoehe);
    if (zuHoch.length) {
      melde('endhoehe', 'hart',
        `${zuHoch.length} Art(en) werden höher als ${maxHoehe} cm und erschlagen ein Beet von `
        + `${flaeche.toFixed(1)} m² (Kante rund ${kante.toFixed(1)} m): `
        + zuHoch.map(p => `${p.name_deutsch || p.name_botanisch} (${p.hoehe_cm_max} cm)`).join(', ') + '.');
    }
  }

  // ── 3. Pflanzdichte ────────────────────────────────────────────────────────────────────
  if (flaeche && gesamtStueck) {
    const dichte = gesamtStueck / flaeche;
    if (dichte < DICHTE_MIN) {
      melde('dichte', 'weich',
        `${dichte.toFixed(1)} Pflanzen je m² (${gesamtStueck} auf ${flaeche.toFixed(1)} m²). `
        + `Unter ${DICHTE_MIN} bleibt der Boden jahrelang offen und verkrautet.`);
    } else if (dichte > DICHTE_MAX) {
      melde('dichte', 'weich',
        `${dichte.toFixed(1)} Pflanzen je m². Über ${DICHTE_MAX} stehen die Stauden sich im Weg.`);
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
if (require.main === module && process.argv.includes('--selbsttest')) {
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
  ok(planPruefen({ pflanzen: [{ name_deutsch: 'X', stueckzahl: 3 }] }, {}).befunde.length === 0,
     'ohne Flaechenangabe werden die flaechenabhaengigen Regeln uebersprungen statt geraten');

  console.log(fehler ? `\n${fehler} Fehler` : '\n--- Selbsttest bestanden ---');
  process.exit(fehler ? 1 : 0);
}

module.exports = { planPruefen, GRUPPE_MIN, FLAECHE_JE_ART, HOEHE_ZU_KANTE, DICHTE_MIN, DICHTE_MAX };
