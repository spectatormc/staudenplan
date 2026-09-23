/*
 * Preise als SPANNE, nicht als Betrag.
 *
 * WARUM (23.09.2026): Die Werte in preis_stueck_eur sind Kalkulationsgrößen für die Plansumme,
 * keine Kassenpreise — das stand bisher schon in Kommentaren und im Wort „Richtpreis". Auf der
 * Seite sah man trotzdem „6,90 €", und ein Betrag mit zwei Nachkommastellen liest sich wie ein
 * Preis, egal was daneben steht. Eine Spanne sagt dasselbe wie der Kommentar, nur dort, wo der
 * Kunde hinsieht.
 *
 * Dazu kommt die Herkunft: Die Beträge stammen seit dem 01.09.2026 aus den Listenpreisen einer
 * Gärtnerei, die am 23.09.2026 mitgeteilt hat, dass sie nicht mit uns in Verbindung gebracht
 * werden will. Eine Spanne nimmt der Zahl den Charakter einer übernommenen Preisliste.
 *
 * WARUM NICHT ZUFÄLLIG STREUEN: Naheliegend wäre, jeden Betrag um ein paar Prozent zu
 * verrauschen. Das macht die Zahl aber schlechter statt besser — sie bleibt abgeleitet, ist
 * danach aber nachweislich falsch, und zwar in zufälliger Richtung. Eine Spanne ist ehrlich:
 * Sie behauptet genau die Genauigkeit, die die Daten hergeben.
 *
 * DETERMINISTISCH: Gleicher Betrag, gleiche Spanne. Kein Math.random(). Sonst zeigte dieselbe
 * Pflanze auf der Pflanzenseite und im Plan verschiedene Spannen, und ein geteilter Plan wäre
 * beim zweiten Aufruf ein anderer.
 */

/* Eine Breite für alles. Zwei Werte (einer für Einzelpreise, einer für Summen) wären zwei
 * Regeln, die auseinanderlaufen können — und die Summe einer Spanne muss zur Spanne der Summe
 * passen, sonst widersprechen sich Stückliste und Kopfzeile. */
const BREITE = 0.12;

const zahl = w => {
  const n = Number(w);
  return Number.isFinite(n) && n > 0 ? n : null;
};

/* Nach außen runden, nie nach innen: Die Spanne soll den wahren Wert einschließen, nicht
 * knapp verfehlen. Bei 0,50-Schritten wird aus 6,07–7,73 also 6,00–8,00 und nicht 6,50–7,50.
 *
 * GEGEN FLIESSKOMMA-RESTE wird vor und nach dem Anlegen der Stufe geglaettet: 5000 * 1,12
 * ergibt in JavaScript 5600.000000000001, und aufRunden() schoebe das eine ganze Stufe
 * weiter — aus „ca. 4.400–5.600 €" wurde so „ca. 4.400–5.650 €". An jedem glatten
 * Vielfachen passiert dasselbe. */
const genau = w => Math.round(w * 1e10) / 1e10;
const abRunden  = (w, schritt) => genau(Math.floor(genau(w / schritt)) * schritt);
const aufRunden = (w, schritt) => genau(Math.ceil(genau(w / schritt)) * schritt);

const euro = w => (Number.isInteger(w) ? String(w) : w.toFixed(2).replace('.', ','));

/* Die Breite, auf die sich die Aufrufer verlassen. Sie ist die eigentliche Zusage dieser
 * Datei — „der Betrag liegt in der Spanne" erfuellt auch „ca. 0–1000 €". 0,35 statt 0,24
 * (= 2 × BREITE) laesst Raum fuer die Rundung nach aussen. */
const MAX_BREITE = 0.35;

/* Die moeglichen Schrittweiten, von grob nach fein. Eine Leiter und nicht zwei: Stueckpreise
 * und Plansummen unterscheiden sich nur darin, wie grob sie hoechstens werden duerfen. */
const STUFEN = [50, 25, 10, 5, 2, 1, 0.5, 0.25, 0.1, 0.05, 0.01];

/**
 * Die Spanne zu einem Betrag, gerundet in der GROEBSTEN Stufe, die MAX_BREITE noch einhaelt.
 *
 * WARUM GEMESSEN UND NICHT HERGELEITET: Bis zum 23.09.2026 stand die Stufe in einer Treppe
 * („unter 5 € in Viertelschritten"), und die Treppe lag dreimal daneben. Zuletzt bekamen
 * 321 von 711 Preisen eine Spanne ueber einem Drittel des Betrags, und sieben Zeilen lagen
 * ausserhalb ihrer eigenen Spanne: 0,16 € stand live als „ca. 0,25–0,50 €" auf der Seite.
 * Ursache war ein Boden Math.max(schritt, …), der `von` ueber den Betrag heben konnte.
 * Jetzt entscheidet die Eigenschaft selbst ueber die Rundung, die der Selbsttest zusichert.
 * Eine zweite Formel, die „ungefaehr passen" soll, liefe frueher oder spaeter von ihr weg.
 *
 * `von` bekommt keinen Boden mehr. Damit liegt der Betrag IMMER in seiner Spanne, in jeder
 * Stufe — abRunden(n × 0,88) ist nie groesser als n, aufRunden(n × 1,12) nie kleiner.
 *
 * WO DIE ZUSAGE ENDET, ehrlich: Unter rund 0,15 € ist eine Spanne von ±12 % in ganzen Cent
 * nicht mehr darstellbar — bei 0,10 € sind 0,08–0,12 € bereits 40 % breit. Dort gilt nur
 * noch, dass der Betrag drinliegt. Der guenstigste Preis im Bestand ist 0,16 €.
 */
function spanne(n, maxSchritt) {
  let letzte = null;
  for (const schritt of STUFEN) {
    if (schritt > maxSchritt) continue;
    const von = abRunden(n * (1 - BREITE), schritt);
    const bis = Math.max(aufRunden(n * (1 + BREITE), schritt), genau(von + schritt));
    letzte = { von, bis };
    if (bis - von <= n * MAX_BREITE) return letzte;
  }
  return letzte;   // feinste Stufe: der Betrag liegt drin, nur die Breite reicht nicht
}

/**
 * Spanne fuer einen Einzelpreis. Hoechstens Fuenferschritte — ein Stueckpreis von 90 € in
 * Fuenfzigerschritten waere keine Aussage mehr.
 * @returns {{von:number, bis:number, text:string}|null} null, wenn kein Preis hinterlegt ist
 */
function einzelSpanne(betrag) {
  const n = zahl(betrag);
  if (n === null) return null;
  const { von, bis } = spanne(n, 5);
  return { von, bis, text: `ca. ${euro(von)}–${euro(bis)} €` };
}

/**
 * Spanne fuer eine Summe. Hoechstens Fuenfzigerschritte: „ca. 330–430 €" ist eine Aussage,
 * „ca. 1.237–1.556 €" waere Scheingenauigkeit.
 */
function summeSpanne(betrag) {
  const n = zahl(betrag);
  if (n === null) return null;
  const { von, bis } = spanne(n, 50);
  const tausend = w => w.toLocaleString('de-DE');
  return { von, bis, text: `ca. ${tausend(von)}–${tausend(bis)} €` };
}

/* Selbsttest: node scripts/preis-spanne.js --selbsttest
 *
 * ER LAEUFT UEBER BEREICHE, NICHT UEBER WUNSCHWERTE, und das ist der Kern.
 * Bis zum 23.09.2026 prueften hier neun handverlesene Betraege, und alle neun lagen in den
 * Luecken zwischen den Fehlern: 321 von 711 Live-Preisen verletzten die Breitenschranke,
 * sieben lagen ausserhalb ihrer eigenen Spanne — und der Selbsttest meldete „bestanden".
 * Eine Pruefung, die ihre Stichproben selbst aussucht, prueft das, woran der Autor gedacht
 * hat. Jetzt wird jeder Cent-Betrag durchgerechnet, den die Seite ausgeben kann. */
if (typeof require !== 'undefined' && require.main === module && process.argv.includes('--selbsttest')) {
  let fehler = 0;
  const ok = (bedingung, was) => { console.log((bedingung ? 'ok    ' : 'FEHLER') + '  ' + was); if (!bedingung) fehler++; };

  /* AB HIER GILT DIE BREITENZUSAGE — darunter nicht, und zwar aus Arithmetik, nicht aus
   * Nachlaessigkeit: ±12 % von 17 Cent sind 14,96 bis 19,04; nach aussen auf ganze Cent
   * gerundet 14 bis 20, also 6 Cent = 35,3 %. Feiner als ein Cent geht Geld nicht.
   * Nachgemessen ueber alle Cent-Betraege bis 5 €: oberhalb von 0,17 € reisst die Schranke
   * kein einziges Mal, und 0,17 € ist der einzige Wert zwischen 0,15 und 0,18 €, der sie
   * ueberschreitet — um 0,3 Prozentpunkte. Der guenstigste Preis im Bestand ist 0,16 € und
   * landet bei 0,14–0,18 €, also 25 %. Die Einschlusszusage gilt bei JEDEM Betrag. */
  const CENT_GRENZE = 0.18;

  const durchlauf = (name, fn, von, bis, schritt, breiteAb) => {
    let drinFehler = 0, breitFehler = 0, schlimmster = { n: null, anteil: 0 };
    for (let i = Math.round(von / schritt); i <= Math.round(bis / schritt); i++) {
      const n = Math.round(i * schritt * 100) / 100;
      const s = fn(n);
      if (!(s.von <= n && n <= s.bis)) { if (drinFehler++ === 0) console.log(`        erster Ausreisser: ${n} € liegt nicht in ${s.text}`); }
      const anteil = (s.bis - s.von) / n;
      if (n >= breiteAb) {
        if (anteil > MAX_BREITE + 1e-9) { if (breitFehler++ === 0) console.log(`        erste zu breite: ${n} € → ${s.text} (${(anteil * 100).toFixed(0)} %)`); }
        if (anteil > schlimmster.anteil) schlimmster = { n, anteil, text: s.text };
      }
    }
    ok(drinFehler === 0, `${name}: jeder Betrag von ${von} bis ${bis} € liegt in seiner eigenen Spanne (${drinFehler} Ausreisser)`);
    ok(breitFehler === 0, `${name}: keine Spanne breiter als ${MAX_BREITE * 100} % ab ${breiteAb} € (${breitFehler} Verletzungen, schlimmste ${schlimmster.n} € → ${schlimmster.text || '—'} = ${(schlimmster.anteil * 100).toFixed(0)} %)`);
  };

  // Stueckpreise: jeder Cent von 1 Cent bis 200 €. Der Bestand reicht von 0,16 bis rund 30 €.
  durchlauf('Stueckpreis', einzelSpanne, 0.01, 200, 0.01, CENT_GRENZE);
  // Plansummen: jeder Euro bis 10.000. Gemessene Plaene liegen zwischen 45 und 900 €.
  durchlauf('Plansumme', summeSpanne, 1, 10000, 1, 1);

  ok(einzelSpanne(6.9).text === einzelSpanne(6.9).text, 'derselbe Betrag ergibt dieselbe Spanne');
  ok(einzelSpanne(0) === null && einzelSpanne(null) === null && einzelSpanne('x') === null,
     'ohne Preis kommt null zurueck, kein "ca. 0–0 €"');

  /* UEBERLAPPUNG statt Monotonie. Naheliegend waere die Probe „die Untergrenze faellt nie,
   * wenn der Betrag steigt". Sie ist hier falsch: Weil die groebste noch zulaessige Stufe
   * gewaehlt wird, darf ein Cent mehr eine groebere Stufe erlauben und die Untergrenze
   * dadurch etwas tiefer setzen (0,42 € → 0,36–0,48 €, 0,43 € → 0,35–0,50 €). Das ist
   * kein Fehler, solange beide Spannen ihren Betrag enthalten und die Breite halten — beides
   * wird oben geprueft.
   * Was wirklich nicht passieren darf, ist ein SPRUNG: zwei benachbarte Betraege, deren
   * Spannen einander nicht mehr beruehren. Dann saehe dieselbe Pflanze einen Cent teurer
   * aus wie eine voellig andere Preisklasse. Genau das war der alte 499/500-Fehler. */
  let sprung = null;
  for (let c = 16; c <= 20000 && !sprung; c++) {
    const a = einzelSpanne(c / 100), b = einzelSpanne((c + 1) / 100);
    if (b.von > a.bis + 1e-9 || a.von > b.bis + 1e-9) {
      sprung = `${(c / 100).toFixed(2)} € → ${a.text}, aber ${((c + 1) / 100).toFixed(2)} € → ${b.text}`;
    }
  }
  ok(!sprung, `benachbarte Betraege haben ueberlappende Spannen${sprung ? ' — ' + sprung : ''}`);

  /* Fliesskomma: glatte Vielfache duerfen die Obergrenze nicht eine Stufe weiter schieben. */
  ok(summeSpanne(5000).bis === 5600, `5000 € ergibt ${summeSpanne(5000).text}, nicht eine Stufe weiter`);

  // Die Summe muss zur Kopfzeile passen: Eine Plansumme aus lauter Einzelpreisen liegt in
  // ihrer eigenen Summenspanne — sonst widersprechen sich Stueckliste und Gesamtangabe.
  const posten = [[6.9, 8], [3.5, 40], [12.4, 6]];
  const summe = posten.reduce((s, [p, n]) => s + p * n, 0);
  const sp = summeSpanne(summe);
  ok(sp.von <= summe && summe <= sp.bis, `Plansumme ${summe.toFixed(2)} € liegt in ${sp.text}`);

  console.log(fehler ? `\n${fehler} Fehler` : '\n--- Selbsttest bestanden ---');
  process.exit(fehler ? 1 : 0);
}

/* Laeuft in BEIDEN Umgebungen: unter Node als Modul, im Browser als eingebetteter Text.
 * stauden-server.js setzt diese Datei beim Ausliefern von stauden-portal.html dort ein, wo
 * der Platzhalter steht (in einer IIFE gekapselt). Grund: Der Browser rechnet Plansumme und
 * Kartenpreise nach jedem Dichte-Klick neu — mit einer zweiten, abgetippten Fassung der
 * Spannenregel wuerden Stueckliste und Kopfzeile frueher oder spaeter auseinanderlaufen.
 * Deshalb sind die beiden Zeilen oben und unten typgeprueft statt roh. */
if (typeof module !== 'undefined' && module.exports) module.exports = { einzelSpanne, summeSpanne, BREITE };
