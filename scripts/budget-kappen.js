/*
 * DAS BUDGET DURCHSETZEN — an einer Stelle, für Server und Browser.
 *
 * WARUM DIESE DATEI AM 23.09.2026 ENTSTANDEN IST, in zwei Sätzen:
 *
 * 1. Die Kappung im Server trug ein Exemplar je Schleifendurchlauf ab und brach nach 1000
 *    Durchläufen ab. Solange das Modell rund 70 Stück lieferte, war diese Sicherung
 *    folgenlos. Seit die Pflanzdichte davor deterministisch nachgezogen wird, sind es auf
 *    großen Flächen mehrere tausend — und die Kappung gab mitten in der Arbeit stillschweigend
 *    auf. Nachgerechnet: 200 m² „dicht" bei Budget 600 € ergaben 2.924 €, 400 m² sogar
 *    10.914 €, und `gesamtkosten_geschaetzt` wurde aus genau diesen Zahlen gebildet. Der
 *    Kunde las einen Betrag, der sein Budget um ein Vielfaches übersteigt, ohne ein Wort dazu.
 *
 * 2. Der Dichteschalter im Browser rechnet seit derselben Änderung auf eine Zielzahl — und
 *    kannte das Budget nicht. Ein Klick auf den bereits markierten Knopf „Normal" machte aus
 *    einem auf 300 € gekappten Plan mit 56 Stück wieder 320 Stück und rund 1.700 €. Die Zahl
 *    reiste weiter in PDF, geteilten Plan, Anfrage-Mail und Admin.
 *
 * Beides ist derselbe Fehler: Eine Regel stand an einer Stelle, und ein zweiter Weg lief
 * daran vorbei. Deshalb steht sie jetzt hier, und beide Seiten setzen dieselbe Datei ein —
 * wie scripts/preis-spanne.js und scripts/plan-pruefen.js.
 *
 * WIE GEKAPPT WIRD, und warum in dieser Reihenfolge:
 *   a) PROPORTIONAL. Alles wird mit demselben Faktor heruntergerechnet. Das erhält die
 *      Verhältnisse, die der Plan setzt, und braucht einen Schritt statt tausend.
 *   b) DANACH FEIN, in der Reihenfolge Füll → Begleit → Leit. Die Rundung nach unten lässt
 *      meist noch Luft; wo nach dem proportionalen Schritt noch etwas fehlt, wird immer das
 *      teuerste reduzierbare Exemplar der niedrigsten Rolle genommen. Leitstauden geben die
 *      Struktur und gehen zuletzt.
 *   c) UNTERGRENZEN. Eine Art mit null Exemplaren ist keine Art mehr — das Streichen einer
 *      Art ist eine Gestaltungsentscheidung und gehört nicht in eine Preisrechnung.
 *      Leitstauden behalten drei (Profipraxis, dieselbe Zahl wie im Planer und im Browser).
 *   d) WENN ES NICHT REICHT, sagt die Funktion das (`erreicht: false`). Sie senkt dann NICHT
 *      weiter, sondern der Aufrufer sagt es dem Kunden. Ein Budget still zu überschreiten
 *      ist eine Zusage ohne Regel.
 */

/* Untergrenzen beim KAPPEN — bewusst niedriger als die Mindestmengen, mit denen ein Plan
 * ZUSAMMENGESTELLT wird (buildNotplan: Leit 3 / Begleit 2 / Füll 5). Beim Zusammenstellen
 * geht es darum, dass eine Gruppe wirkt; beim Kappen darum, dass die Art überhaupt im Plan
 * bleibt. Die drei Leitstauden stehen in beiden Listen, weil eine einzelne Leitstaude in
 * einem Beet nicht als Struktur liest, sondern als Zufall. */
const KAPP_MIN = { Leitstaude: 3, Begleitstaude: 1, 'Füllstaude': 1, Geophyt: 1 };
const KAPP_PRIO = ['Füllstaude', 'Begleitstaude', 'Leitstaude', 'Geophyt'];

const zahl = w => { const n = Number(w); return Number.isFinite(n) ? n : 0; };
const preis = p => Math.max(0, zahl(p.preis_stueck_eur));
const stueck = p => Math.max(0, Math.round(zahl(p.stueckzahl)));
const mindest = p => KAPP_MIN[String(p.rolle || '')] || 1;

/** Summe aus Stückpreis × Stückzahl. Eine fehlende Stückzahl zählt als 1, wie überall sonst. */
function planSumme(pflanzen) {
  return (pflanzen || []).reduce((s, p) => s + preis(p) * Math.max(1, stueck(p)), 0);
}

/**
 * Kappt die Stückzahlen auf das Budget. ÄNDERT `stueckzahl` IN DEN ÜBERGEBENEN OBJEKTEN —
 * beide Aufrufer arbeiten auf dem Plan, den sie gerade ausliefern.
 *
 * @param {Array} pflanzen  Einträge mit rolle, stueckzahl, preis_stueck_eur
 * @param {number|string} budget  Obergrenze in Euro; alles Unbrauchbare heisst „kein Budget"
 * @returns {{noetig:boolean, erreicht:boolean, vorher:number, nachher:number, stueckVorher:number, stueckNachher:number}}
 */
function budgetKappen(pflanzen, budget) {
  const liste = Array.isArray(pflanzen) ? pflanzen.filter(p => p && typeof p === 'object') : [];
  const grenze = Number(budget);
  const vorher = planSumme(liste);
  const stueckVorher = liste.reduce((s, p) => s + Math.max(1, stueck(p)), 0);
  const nichts = { noetig: false, erreicht: true, vorher, nachher: vorher, stueckVorher, stueckNachher: stueckVorher };

  if (!liste.length || !Number.isFinite(grenze) || grenze <= 0 || vorher <= grenze) return nichts;

  // a) proportional
  const faktor = grenze / vorher;
  for (const p of liste) {
    const roh = Math.floor(Math.max(1, stueck(p)) * faktor);
    p.stueckzahl = Math.max(mindest(p), roh);
  }

  // b) der Rest, einzeln und in Prioritätsfolge. Die Schleife kann jetzt nur noch wenige
  //    Schritte brauchen; der Zähler bleibt trotzdem stehen — als Sicherung, nicht als Regel.
  let wache = 0;
  while (planSumme(liste) > grenze && wache++ < 5000) {
    let ziel = null;
    for (const rolle of KAPP_PRIO) {
      const kandidaten = liste.filter(p => String(p.rolle || '') === rolle
        && stueck(p) > mindest(p) && preis(p) > 0);
      if (kandidaten.length) { ziel = kandidaten.sort((a, b) => preis(b) - preis(a))[0]; break; }
    }
    /* Auch Arten ohne bekannte Rolle müssen reduzierbar sein — sonst bliebe ein Plan, dessen
     * Rollen das Modell anders benannt hat, ungekappt und die Funktion meldete trotzdem
     * „erreicht". Genau diese Art stiller Ausnahme sucht dieses Projekt sonst. */
    if (!ziel) {
      const rest = liste.filter(p => !KAPP_PRIO.includes(String(p.rolle || ''))
        && stueck(p) > mindest(p) && preis(p) > 0);
      if (rest.length) ziel = rest.sort((a, b) => preis(b) - preis(a))[0];
    }
    if (!ziel) break;                       // alles auf der Untergrenze
    ziel.stueckzahl = stueck(ziel) - 1;
  }

  const nachher = planSumme(liste);
  return {
    noetig: true,
    erreicht: nachher <= grenze,
    vorher, nachher,
    stueckVorher,
    stueckNachher: liste.reduce((s, p) => s + Math.max(1, stueck(p)), 0),
  };
}

/* Selbsttest: node scripts/budget-kappen.js --selbsttest
 *
 * Er rechnet über BEREICHE, nicht über Wunschwerte — aus demselben Grund wie in
 * scripts/preis-spanne.js: Neun ausgesuchte Beträge lagen dort sämtlich in den Lücken
 * zwischen den Fehlern. Der wichtigste Fall hier ist der, an dem die alte Fassung
 * gescheitert ist: sehr viele Exemplare bei kleinem Budget. */
if (typeof require !== 'undefined' && require.main === module && process.argv.includes('--selbsttest')) {
  let fehler = 0;
  const ok = (bed, was) => { console.log((bed ? 'ok    ' : 'FEHLER') + '  ' + was); if (!bed) fehler++; };

  const plan = (n) => [
    { rolle: 'Leitstaude',    stueckzahl: Math.round(n * 0.1), preis_stueck_eur: 9.5 },
    { rolle: 'Leitstaude',    stueckzahl: Math.round(n * 0.1), preis_stueck_eur: 12.0 },
    { rolle: 'Begleitstaude', stueckzahl: Math.round(n * 0.3), preis_stueck_eur: 6.5 },
    { rolle: 'Füllstaude',    stueckzahl: Math.round(n * 0.4), preis_stueck_eur: 4.2 },
    { rolle: 'Geophyt',       stueckzahl: Math.round(n * 0.1), preis_stueck_eur: 0.8 },
  ];

  /* DER FALL, DER DIE DATEI AUSGELOEST HAT: mehrere tausend Exemplare, kleines Budget.
   * Die alte Fassung trug ein Stueck je Durchlauf ab und gab nach 1000 auf. */
  let ueberschritten = 0, untergrenzeVerletzt = 0, nichtErreicht = 0, laeufe = 0;
  let schlimmster = null;
  for (let n = 50; n <= 8000; n += 50) {
    for (const grenze of [100, 300, 600]) {
      const p = plan(n);
      const r = budgetKappen(p, grenze);
      laeufe++;
      if (r.erreicht && r.nachher > grenze + 1e-9) {
        ueberschritten++;
        if (!schlimmster || r.nachher > schlimmster.nachher) schlimmster = { n, grenze, nachher: r.nachher };
      }
      if (!r.erreicht) nichtErreicht++;
      if (p.some(x => x.stueckzahl < (KAPP_MIN[x.rolle] || 1))) untergrenzeVerletzt++;
    }
  }
  ok(ueberschritten === 0, `${laeufe} Kombinationen aus Stueckzahl und Budget: "erreicht" heisst immer wirklich erreicht`
     + (schlimmster ? ` — schlimmster Ausreisser ${schlimmster.n} Stueck / ${schlimmster.grenze} EUR → ${schlimmster.nachher.toFixed(2)} EUR` : ''));
  ok(untergrenzeVerletzt === 0, `keine Art faellt unter ihre Untergrenze (${untergrenzeVerletzt} Verletzungen in ${laeufe} Laeufen)`);

  /* DER ZWEIG "ES REICHT NICHT" MUSS AUCH AUSLOESEN KOENNEN, sonst ist `erreicht` ein Feld,
   * das immer true ist. Der Durchlauf oben hat ihn kein einziges Mal getroffen — mit zwei
   * Leitstauden à 3 Exemplaren und drei weiteren Arten liegt die Untergrenze bei rund
   * 70 EUR, also unter dem kleinsten getesteten Budget. Hier wird er erzwungen. */
  const zuTeuer = plan(1000);
  const rTeuer = budgetKappen(zuTeuer, 20);
  ok(rTeuer.erreicht === false, `bei 20 EUR ist das Budget nicht erreichbar und wird als nicht erreicht gemeldet (${rTeuer.nachher.toFixed(2)} EUR)`);
  ok(rTeuer.nachher < rTeuer.vorher, 'auch im unerreichbaren Fall wird so weit gekappt, wie es geht');
  ok(nichtErreicht === 0, `im gemessenen Bereich (ab 100 EUR) wurde das Budget immer erreicht (${nichtErreicht} Ausnahmen)`);

  // Ohne Budget wird nichts angefasst.
  const unberuehrt = plan(400);
  const kopie = unberuehrt.map(p => p.stueckzahl);
  for (const b of [null, undefined, 0, -5, 'abc', NaN]) {
    budgetKappen(unberuehrt, b);
    if (unberuehrt.some((p, i) => p.stueckzahl !== kopie[i])) { ok(false, `Budget ${String(b)} hat Stueckzahlen veraendert`); break; }
  }
  ok(unberuehrt.every((p, i) => p.stueckzahl === kopie[i]), 'ohne brauchbares Budget bleibt jede Stueckzahl unveraendert');

  // Liegt der Plan schon unter dem Budget, wird nicht "aufgefuellt".
  const guenstig = plan(20);
  const vor = guenstig.map(p => p.stueckzahl);
  const r2 = budgetKappen(guenstig, 100000);
  ok(!r2.noetig && guenstig.every((p, i) => p.stueckzahl === vor[i]), 'ein Plan unter dem Budget bleibt unveraendert');

  // Leitstauden gehen zuletzt und behalten ihre drei.
  const eng = plan(1000);
  budgetKappen(eng, 80);
  ok(eng.filter(p => p.rolle === 'Leitstaude').every(p => p.stueckzahl === 3),
     'Leitstauden bleiben bei drei Exemplaren stehen, auch wenn das Budget nicht reicht');
  ok(eng.filter(p => p.rolle === 'Füllstaude').every(p => p.stueckzahl >= 1),
     'keine Art wird auf null gesetzt');

  // Bestimmtheit: gleicher Plan, gleiches Ergebnis.
  const a = plan(900), b = plan(900);
  budgetKappen(a, 250); budgetKappen(b, 250);
  ok(a.every((p, i) => p.stueckzahl === b[i].stueckzahl), 'derselbe Plan ergibt dieselbe Kappung');

  // Unbekannte Rolle: darf nicht dazu fuehren, dass "erreicht" faelschlich gemeldet wird.
  const fremd = [{ rolle: 'Zwiebel', stueckzahl: 500, preis_stueck_eur: 3 }];
  const r3 = budgetKappen(fremd, 60);
  ok(r3.erreicht && planSumme(fremd) <= 60, 'auch Arten mit unbekannter Rolle werden gekappt');

  console.log(fehler ? `\n${fehler} Fehler` : '\n--- Selbsttest bestanden ---');
  process.exit(fehler ? 1 : 0);
}

/* Laeuft in BEIDEN Umgebungen — unter Node als Modul, im Browser als eingesetzter Quelltext
 * (stauden-server.js ersetzt den Platzhalter beim Ausliefern von stauden-portal.html).
 * Deshalb sind die Zeile oben und diese hier typgeprueft statt roh. */
if (typeof module !== 'undefined' && module.exports) module.exports = { budgetKappen, planSumme, KAPP_MIN, KAPP_PRIO };
