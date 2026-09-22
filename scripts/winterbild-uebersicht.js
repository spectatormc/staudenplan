/*
 * Vergleichsseite zum Winterbild-Test.
 *
 * Die eigentliche Frage ist nicht "sieht das Winterbild gut aus", sondern "ist es besser als
 * das, was der Winterpin HEUTE zeigt". Deshalb steht in jeder Zeile zuerst das aktuelle
 * Bluehzeit-Bild und daneben die erzeugten Fassungen.
 *
 * express.static liefert kein Verzeichnislisting — ohne diese index.html endet ein Aufruf von
 * /winterbild-test/ auf "Cannot GET".
 *
 * Der ganze Ordner ist Wegwerfware: Er haengt an keinem Pin, an keiner Seite und an keiner
 * Zeile der Datenbank. Loeschen genuegt, es bleibt nichts zurueck.
 *
 * Ausfuehren:  node scripts/winterbild-uebersicht.js
 */
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const WURZEL = path.join(__dirname, '..');
const ZIEL = path.join(WURZEL, 'public', 'winterbild-test');
const db = new Database(path.join(WURZEL, 'stauden.db'), { readonly: true });

const esc = s => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Welche Pflanzen im Ordner liegen, sagt der Ordner selbst — keine zweite Liste.
const ids = [...new Set(fs.readdirSync(ZIEL)
  .map(f => /^winter-[ab]-(\d+)\.jpg$/.exec(f))
  .filter(Boolean).map(m => Number(m[1])))].sort((a, b) => a - b);

if (!ids.length) {
  console.error(`Keine Testbilder in ${ZIEL} — erst node scripts/winterbild-test.js laufen lassen.`);
  process.exit(1);
}

const pflanzen = db.prepare(
  `SELECT id, name_deutsch, name_botanisch, winteraspekt, bild_url FROM pflanzen WHERE id IN (${ids.join(',')})`
).all();

const FASSUNG = { a: 'Fassung A — Raureif, tiefes Licht', b: 'Fassung B — Schnee, trübes Licht' };

const karten = pflanzen.map(p => {
  const bilder = [];
  if (p.bild_url) bilder.push({ titel: 'heute im Winterpin (Blütenbild)', quelle: p.bild_url, alt: true });
  for (const f of ['a', 'b']) {
    const datei = `winter-${f}-${p.id}.jpg`;
    if (fs.existsSync(path.join(ZIEL, datei))) bilder.push({ titel: FASSUNG[f], quelle: `/winterbild-test/${datei}` });
  }
  const figuren = bilder.map(b =>
    `      <figure${b.alt ? ' class="alt"' : ''}>`
    + `<img src="${esc(b.quelle)}" alt="${esc(p.name_deutsch)} — ${esc(b.titel)}" loading="lazy">`
    + `<figcaption>${esc(b.titel)}</figcaption></figure>`).join('\n');
  return `    <section>
      <h2>${esc(p.name_deutsch)} <em>${esc(p.name_botanisch)}</em></h2>
      <p class="aspekt">winteraspekt: ${esc(p.winteraspekt)}</p>
      <div class="reihe">
${figuren}
      </div>
    </section>`;
}).join('\n');

const html = `<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>Winterbild-Test</title>
<style>
  body{background:#14201a;color:#e8f0ea;font-family:system-ui,-apple-system,sans-serif;margin:0;padding:24px 16px;line-height:1.5}
  .kopf{max-width:70ch;margin:0 auto 30px}
  h1{font-size:1.45rem;margin:0 0 8px}
  .hin{color:#9db5a6;font-size:.92rem;margin:0}
  main{max-width:1180px;margin:0 auto}
  section{margin-bottom:36px}
  h2{font-size:1.06rem;margin:0 0 2px;font-weight:700}
  h2 em{font-weight:400;color:#9db5a6;font-style:italic;font-size:.9rem}
  .aspekt{color:#7fbf9a;font-size:.82rem;margin:0 0 10px}
  .reihe{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:12px}
  figure{margin:0}
  img{width:100%;aspect-ratio:1;object-fit:cover;border-radius:10px;display:block;background:#0d1712}
  figure.alt img{opacity:.75;filter:saturate(.85)}
  figcaption{font-size:.78rem;color:#9db5a6;margin-top:5px}
  figure.alt figcaption{color:#c58a6a}
</style>
</head>
<body>
  <div class="kopf">
    <h1>Winterbild-Test</h1>
    <p class="hin">Ganz links das Bild, das der Winterpin <strong>heute</strong> zeigt — die Pflanze in Blüte, obwohl der Pin von Winterstruktur spricht. Daneben zwei erzeugte Fassungen. Der Auftrag verzweigt sich am <code>winteraspekt</code>: Samenstand, Gräserstruktur und wintergrüne Rosette sehen völlig verschieden aus. Testordner ohne Verbindung zu Pins, Seiten oder Datenbank.</p>
  </div>
  <main>
${karten}
  </main>
</body>
</html>
`;

fs.writeFileSync(path.join(ZIEL, 'index.html'), html, 'utf8');
console.log(`Vergleichsseite geschrieben: ${path.join(ZIEL, 'index.html')} (${pflanzen.length} Pflanzen)`);
db.close();
