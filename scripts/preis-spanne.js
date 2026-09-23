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
 * knapp verfehlen. Bei 0,50-Schritten wird aus 6,07–7,73 also 6,00–8,00 und nicht 6,50–7,50. */
const abRunden = (w, schritt) => Math.floor(w / schritt) * schritt;
const aufRunden = (w, schritt) => Math.ceil(w / schritt) * schritt;

const euro = w => (Number.isInteger(w) ? String(w) : w.toFixed(2).replace('.', ','));

/**
 * Spanne für einen Einzelpreis. Gerundet wird in 0,50-Schritten, unter 5 € in
 * 0,25-Schritten — feiner wäre Scheingenauigkeit, gröber würde bei Bodendeckern
 * (2–3 €) mehr verschlucken als die Spanne breit ist.
 * @returns {{von:number, bis:number, text:string}|null} null, wenn kein Preis hinterlegt ist
 */
function einzelSpanne(betrag) {
  const n = zahl(betrag);
  if (n === null) return null;
  /* Unter 5 € in Viertelschritten: Bei einem Bodendecker fuer 2,20 € verschluckt die
   * 0,50-Rundung sonst mehr als die Spanne selbst und behauptet eine Unsicherheit von
   * zwei Dritteln, wo zwoelf Prozent gemeint sind. */
  const schritt = n < 5 ? 0.25 : 0.5;
  const von = Math.max(schritt, abRunden(n * (1 - BREITE), schritt));
  const bis = Math.max(von + schritt, aufRunden(n * (1 + BREITE), schritt));
  return { von, bis, text: `ca. ${euro(von)}–${euro(bis)} €` };
}

/**
 * Spanne für eine Summe. Die Schrittweite wächst mit dem Betrag (siehe unten): „ca. 330–430 €"
 * ist eine Aussage, „ca. 1.237–1.556 €" wäre wieder Scheingenauigkeit — und „ca. 30–60 €"
 * für 45 € wäre keine mehr.
 */
function summeSpanne(betrag) {
  const n = zahl(betrag);
  if (n === null) return null;
  /* DIE SCHRITTWEITE FOLGT DEM BETRAG, sie steht nicht in einer Treppe.
   *
   * Feste Schwellen haben hier zweimal danebengelegen: Zuerst wechselte die Stufe bei 500 €,
   * und 499 € bekam mit 430–560 eine engere Spanne als 500 € mit 400–600 — der groessere
   * Betrag die groebere Aussage. Danach galt unter 1.000 € pauschal der Zehnerschritt, und
   * eine Plansumme von 45 € wurde zu „ca. 30–60 €": 67 % breit, wo zwoelf Prozent gemeint
   * sind. Kleine Plansummen sind bei kleinen Beeten der Normalfall (gemessen: 59,40 € und
   * 98,50 €), und diese Zahl steht in Kopfzeile, Stueckliste, PDF und auf der geteilten Seite.
   *
   * Die Rundung nach aussen verbreitert die Spanne um hoechstens zwei Schritte. Damit die
   * Gesamtbreite unter 35 % bleibt (2 × BREITE = 24 % plus Rundung), muss ein Schritt unter
   * 5,5 % des Betrags liegen — genau das waehlt die Zeile unten, und zwar die groebste
   * Stufe, die das noch einhaelt. Gedeckelt bei 50 €: „ca. 4.400–5.600 €" ist lesbar genug,
   * und Hunderterschritte wuerden bei kleinen Plaenen nie greifen, aber gross aussehen.
   * Der Selbsttest prueft seit 23.09.2026 die BREITE — dass der Betrag in der Spanne liegt,
   * war die schwaechere Frage, die auch „ca. 0–1.000 €" bestanden haette. */
  const STUFEN = [50, 25, 10, 5, 2, 1];
  const schritt = STUFEN.find(st => st <= n * 0.055) || 1;
  const von = Math.max(schritt, abRunden(n * (1 - BREITE), schritt));
  const bis = Math.max(von + schritt, aufRunden(n * (1 + BREITE), schritt));
  const tausend = w => w.toLocaleString('de-DE');
  return { von, bis, text: `ca. ${tausend(von)}–${tausend(bis)} €` };
}

/* Selbsttest: node scripts/preis-spanne.js --selbsttest
 * Prueft die Eigenschaften, auf die sich die Aufrufer verlassen — nicht einzelne Wunschwerte. */
if (typeof require !== 'undefined' && require.main === module && process.argv.includes('--selbsttest')) {
  let fehler = 0;
  const ok = (bedingung, was) => { console.log((bedingung ? 'ok    ' : 'FEHLER') + '  ' + was); if (!bedingung) fehler++; };

  for (const p of [2.2, 3.5, 6.9, 8, 12.4, 25, 99.9]) {
    const s = einzelSpanne(p);
    ok(s.von <= p && p <= s.bis, `${p} € liegt in der Spanne ${s.text}`);
    ok(s.bis > s.von, `${p} €: Spanne ist nicht leer (${s.text})`);
  }
  for (const g of [12, 45, 98.5, 180, 380, 499, 500, 1240, 5000]) {
    const s = summeSpanne(g);
    ok(s.von <= g && g <= s.bis, `${g} € liegt in der Summenspanne ${s.text}`);
  }
  /* DIE EIGENSCHAFT, AUF DIE SICH DIE AUFRUFER VERLASSEN, ist nicht „der Betrag liegt drin“
   * — das erfüllt auch „ca. 0–1000 €“. Es ist die Breite. 0,35 statt 0,24 (= 2 × BREITE)
   * lässt Raum für die Rundung nach aussen, die bei kleinen Beträgen relativ am meisten
   * zulädt; mehr ist keine Spanne mehr, sondern eine Ausrede. */
  const MAX_BREITE = 0.35;
  for (const p of [2.2, 3.5, 6.9, 8, 12.4, 25, 99.9]) {
    const s = einzelSpanne(p);
    ok((s.bis - s.von) / p <= MAX_BREITE,
       `${p} €: Spanne ${s.text} ist höchstens ${MAX_BREITE * 100} % breit (${(((s.bis - s.von) / p) * 100).toFixed(0)} %)`);
  }
  for (const g of [12, 45, 98.5, 180, 380, 499, 500, 1240, 5000]) {
    const s = summeSpanne(g);
    ok((s.bis - s.von) / g <= MAX_BREITE,
       `${g} €: Summenspanne ${s.text} ist höchstens ${MAX_BREITE * 100} % breit (${(((s.bis - s.von) / g) * 100).toFixed(0)} %)`);
  }
  ok(einzelSpanne(6.9).text === einzelSpanne(6.9).text, 'derselbe Betrag ergibt dieselbe Spanne');
  ok(einzelSpanne(0) === null && einzelSpanne(null) === null && einzelSpanne('x') === null,
     'ohne Preis kommt null zurueck, kein "ca. 0–0 €"');
  ok(einzelSpanne(3).von < einzelSpanne(9).von, 'groesserer Betrag ergibt groessere Spanne');
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
