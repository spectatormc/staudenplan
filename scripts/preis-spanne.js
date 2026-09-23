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
 * Spanne für eine Summe. Gerundet wird in Zehnerschritten, ab 1.000 € in Fünfzigerschritten:
 * „ca. 330–430 €" ist eine Aussage, „ca. 1.237–1.556 €" wäre wieder Scheingenauigkeit.
 */
function summeSpanne(betrag) {
  const n = zahl(betrag);
  if (n === null) return null;
  /* Die Schwelle lag zuerst bei 500 € und mit ihr ein Sprung: 499 € ergab 430–560,
   * 500 € dagegen 400–600 — der groessere Betrag bekam die groebere Spanne. Bei 1000 €
   * faellt der Wechsel nicht mehr auf, weil die Spanne dort ohnehin ueber 200 € breit ist. */
  const schritt = n >= 1000 ? 50 : 10;
  const von = Math.max(schritt, abRunden(n * (1 - BREITE), schritt));
  const bis = Math.max(von + schritt, aufRunden(n * (1 + BREITE), schritt));
  const tausend = w => w.toLocaleString('de-DE');
  return { von, bis, text: `ca. ${tausend(von)}–${tausend(bis)} €` };
}

/* Selbsttest: node scripts/preis-spanne.js --selbsttest
 * Prueft die Eigenschaften, auf die sich die Aufrufer verlassen — nicht einzelne Wunschwerte. */
if (require.main === module && process.argv.includes('--selbsttest')) {
  let fehler = 0;
  const ok = (bedingung, was) => { console.log((bedingung ? 'ok    ' : 'FEHLER') + '  ' + was); if (!bedingung) fehler++; };

  for (const p of [2.2, 3.5, 6.9, 8, 12.4, 25, 99.9]) {
    const s = einzelSpanne(p);
    ok(s.von <= p && p <= s.bis, `${p} € liegt in der Spanne ${s.text}`);
    ok(s.bis > s.von, `${p} €: Spanne ist nicht leer (${s.text})`);
  }
  for (const g of [45, 180, 380, 499, 500, 1240, 5000]) {
    const s = summeSpanne(g);
    ok(s.von <= g && g <= s.bis, `${g} € liegt in der Summenspanne ${s.text}`);
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

module.exports = { einzelSpanne, summeSpanne, BREITE };
