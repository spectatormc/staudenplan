/*
 * Repariert transliterierte Umlaute und Eszett in Ratgeber-Texten.
 *
 * Hintergrund: Beim Zusammenführen doppelter Artikel hat ein generierter Text die Umlaute
 * als ae/oe/ue und das ß als ss ausgeschrieben ("Moeglichkeit", "aeusserst"). Das ist im
 * Fließtext ein sichtbarer Qualitätsmangel.
 *
 * Bewusst keine Blindersetzung von ae/oe/ue: In "Bauerngarten", "Feuerkombination",
 * "Nahrungsquelle" oder in botanischen Namen wie "Agastache foeniculum" und "Paeonia"
 * ist die Buchstabenfolge korrekt. Deshalb eine explizite Wortliste, die sich einzeln
 * prüfen lässt. Nach dem Ersetzen läuft eine Gegenkontrolle, die meldet, wenn noch ein
 * verdächtiges Wort übrig ist.
 *
 *   node scripts/umlaute-reparieren.js            (Trockenlauf)
 *   node scripts/umlaute-reparieren.js --anwenden
 */
const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(process.env.DB_PFAD || path.join(__dirname, '..', 'stauden.db'));
const anwenden = process.argv.includes('--anwenden');

const ERSETZUNGEN = {
  Blaettern: 'Blättern', Bluehfreudigkeit: 'Blühfreudigkeit', Bluehstauden: 'Blühstauden',
  Bluehzeiten: 'Blühzeiten', Bluete: 'Blüte', Blueten: 'Blüten', Bluetenaehren: 'Blütenähren',
  Bluetenstaende: 'Blütenstände', Bluetenteller: 'Blütenteller', Bluetenformen: 'Blütenformen',
  Bluetenkerzen: 'Blütenkerzen', Bluetezeiten: 'Blütezeiten', Bodenverhaeltnissen: 'Bodenverhältnissen',
  Dauerbluete: 'Dauerblüte', Dueften: 'Düften', Einzelstuecken: 'Einzelstücken',
  Ergaenzt: 'Ergänzt', Faerberkamille: 'Färberkamille', Flaeche: 'Fläche', Fuer: 'Für',
  Gewoehnlicher: 'Gewöhnlicher', Graeser: 'Gräser', Grosser: 'Großer', Haustuer: 'Haustür',
  Hoehe: 'Höhe', Hoehen: 'Höhen', Kernflaeche: 'Kernfläche', Knoepfchen: 'Knöpfchen',
  Lilatoenen: 'Lilatönen', Luecke: 'Lücke', Maerz: 'März', Masse: 'Maße',
  Moeglichkeit: 'Möglichkeit', Praerie: 'Prärie', Praeriecharakter: 'Präriecharakter',
  Purpurtoenen: 'Purpurtönen', Quirlblueten: 'Quirlblüten', Rueckgrat: 'Rückgrat',
  Rueckzugsraeume: 'Rückzugsräume', Samenstaende: 'Samenstände', Samenstaenden: 'Samenständen',
  Spaetherbst: 'Spätherbst', Spaetsommer: 'Spätsommer', Stueckzahl: 'Stückzahl',
  Toene: 'Töne', Traeumen: 'Träumen', Versaeumnis: 'Versäumnis', Voegeln: 'Vögeln',
  Weisstoenen: 'Weißtönen', Wuerzduft: 'Würzduft', Zurueckgeschnitten: 'Zurückgeschnitten',
  aeusserst: 'äußerst', auszuwaehlen: 'auszuwählen', beruecksichtigen: 'berücksichtigen',
  bewaehrt: 'bewährt', blueht: 'blüht', duennen: 'dünnen', duerfen: 'dürfen',
  einlaedt: 'einlädt', ergaenzen: 'ergänzen', erhaelt: 'erhält', fuenf: 'fünf', fuer: 'für',
  groesser: 'größer', grossen: 'großen', haelt: 'hält', huebschen: 'hübschen',
  kraeftigste: 'kräftigste', moegen: 'mögen', natuerliche: 'natürliche',
  natuerliches: 'natürliches', oeffnet: 'öffnet', praechtig: 'prächtig', praesent: 'präsent',
  regelmaessig: 'regelmäßig', schliesst: 'schließt', schoenen: 'schönen', stuetzen: 'stützen',
  ueber: 'über', uebernehmen: 'übernehmen', ueppigen: 'üppigen', unterdrueckt: 'unterdrückt',
  verwoehnt: 'verwöhnt', vielfaeltig: 'vielfältig', vielfaeltigen: 'vielfältigen',
  waehrend: 'während', weissen: 'weißen', wohlfuehlen: 'wohlfühlen',
  zusaetzliche: 'zusätzliche', zuverlaessig: 'zuverlässig', zuverlaessigste: 'zuverlässigste',
};

// Korrekt geschrieben, obwohl die Buchstabenfolge verdächtig aussieht — dürfen nicht angefasst
// und bei der Gegenkontrolle nicht gemeldet werden.
const UNVERDAECHTIG = new Set([
  'foeniculum', 'Paeonia',                                   // botanische Namen
  'Nahrungsquelle', 'steuert', 'individuelles',              // "quelle", "steuer", "duell"
  'himmelblauen', 'lavendelblauen',                          // "blau"
  'Bodenschluss', 'Duftnessel', 'Indianernessel', 'eingeschlossen', 'gegossen',
  'geschlossen', 'lassen', 'faassenii', 'Gestaltungsstile', 'Kaukasusvergissmeinnicht',
  'Klassiker', 'Lass', 'interessantes', 'klassisches', 'passen', 'passende',
]);

const rows = db.prepare('SELECT rowid, titel, inhalt FROM wissen').all();
let betroffen = 0, ersetzungen = 0;

for (const r of rows) {
  let neu = r.inhalt;
  let n = 0;
  for (const [falsch, richtig] of Object.entries(ERSETZUNGEN)) {
    const re = new RegExp(`\\b${falsch}\\b`, 'g');
    const treffer = (neu.match(re) || []).length;
    if (treffer) { neu = neu.replace(re, richtig); n += treffer; }
  }
  if (!n) continue;
  betroffen++; ersetzungen += n;
  console.log(`rowid ${r.rowid}: ${n} Ersetzungen — ${r.titel}`);
  if (anwenden) db.prepare('UPDATE wissen SET inhalt = ? WHERE rowid = ?').run(neu, r.rowid);
}

console.log(`\n=== ${anwenden ? 'ANGEWANDT' : 'TROCKENLAUF'} === ${betroffen} Artikel, ${ersetzungen} Ersetzungen`);

// Gegenkontrolle: bleibt irgendwo ein verdächtiges Wort stehen, das die Liste nicht kennt?
const verdaechtig = /\b[A-Za-z]*(ae|oe|ue)[A-Za-z]*\b/g;
const offen = new Map();
for (const r of db.prepare('SELECT rowid, titel, inhalt FROM wissen').all()) {
  for (const w of (r.inhalt.match(verdaechtig) || [])) {
    if (UNVERDAECHTIG.has(w) || ERSETZUNGEN[w]) continue;
    // Wörter, in denen der Buchstabendreher über eine Silbengrenze läuft, sind unauffällig
    // (Bauerngarten, Feuerkombination, Trauer…). Nur melden, was danach noch übrig ist.
    if (/auer|aue|eue|oue|queue|quell|duell|steuer|blau|grau|neue|treue/i.test(w)) continue;
    offen.set(w, (offen.get(w) || 0) + 1);
  }
}
if (offen.size) {
  console.log('\nNoch verdächtig (bitte einzeln prüfen und ggf. in die Liste aufnehmen):');
  [...offen.entries()].sort((a, b) => b[1] - a[1]).forEach(([w, n]) => console.log(`  ${n}x  ${w}`));
} else {
  console.log('\nGegenkontrolle: kein verdächtiges Wort mehr offen.');
}
