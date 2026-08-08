/*
 * Erzeugt aus einem Beispielbeet ein Pinterest-Bild (1000 × 1500) mit Beetgrafik und
 * Pflanzenliste.
 *
 *   node scripts/pin-beetplan.js <slug> [ziel.jpg]     z. B. schattenbeet, kiesgarten
 *
 * Warum ein Beetplan und nicht nur eine Pflanze: „Bepflanzungsplan" ist auf Pinterest eine
 * eigene, stark nachgefragte Sorte Inhalt — ein fertiges Beet mit Pflanzenliste ist etwas,
 * das Leute sich aufheben. Die Einzelpflanze (scripts/pin-bild.js) ist die andere Sorte.
 *
 * Die Grafik wird NICHT nachgebaut, sondern vom laufenden Server als SVG geholt und
 * gerastert. Damit zeigt der Pin exakt dasselbe Beet wie die Seite, und es gibt keine
 * zweite Zeichenlogik, die auseinanderlaufen kann.
 *
 * Rastern über @resvg/resvg-js. ImageMagick allein reicht NICHT: Ohne rsvg-convert nutzt es
 * seinen internen Renderer, der weder die Farbverläufe noch die Beschneidungspfade auflöst —
 * das Beet kam schwarz und ohne Pflanzen heraus (nachgeprüft am 08.08.2026).
 */
const { Resvg } = require('@resvg/resvg-js');
const { execFileSync } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');

const B = 1000, H = 1500;
const FONT = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf';
const FONT_B = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf';
const GRUEN = '#1b4332';
const PORT = process.env.PIN_PORT || 3003;

function holeSeite(pfad) {
  return new Promise((ok, fehler) => {
    http.get({ host: '127.0.0.1', port: PORT, path: pfad, headers: { 'User-Agent': 'pin-generator' } }, r => {
      if (r.statusCode !== 200) { r.resume(); return fehler(new Error(pfad + ' → HTTP ' + r.statusCode)); }
      let s = ''; r.setEncoding('utf8');
      r.on('data', d => s += d).on('end', () => ok(s));
    }).on('error', fehler);
  });
}

// Aus der gerenderten Seite: das Beet-SVG und die Legendennamen in der Reihenfolge der Nummern.
function ausSeiteLesen(html) {
  const i = html.indexOf('<svg'), j = html.indexOf('</svg>');
  if (i < 0 || j < 0) throw new Error('kein SVG in der Seite gefunden');
  const svg = html.slice(i, j + 6);
  // Je Legendeneintrag Nummer, Name und — falls vorhanden — Blühzeit. Die Blühzeit steht in
  // einem eigenen span hinter dem Rollensymbol und fehlt bei Gräsern und Blattschmuck.
  const namen = [...html.matchAll(/<div class="vl-item">([\s\S]*?)<\/div>/g)].map(m => {
    const teil = m[1];
    const nr = Number((teil.match(/vl-num">(\d+)</) || [])[1]);
    const name = ((teil.match(/<span>([^<]+)<\/span>/) || [])[1] || '').trim();
    const bluehzeit = ((teil.match(/vl-bluehzeit[^>]*>([^<]+)/) || [])[1] || '').trim();
    return { nr, name, bluehzeit };
  }).filter(x => x.nr && x.name).sort((a, b) => a.nr - b.nr);
  const intro = ((html.match(/<p[^>]*>([^<]{60,300})<\/p>/) || [])[1] || '').trim();
  return { svg, namen, intro };
}

function umbrechen(text, max) {
  const worte = String(text).split(/\s+/); const zeilen = []; let z = '';
  for (const w of worte) {
    if ((z + ' ' + w).trim().length > max) { if (z) zeilen.push(z.trim()); z = w; } else z = (z + ' ' + w).trim();
  }
  if (z) zeilen.push(z); return zeilen;
}

async function beetPin(beispiel, ziel) {
  const html = await holeSeite('/beispiel/' + beispiel.slug);
  const { svg, namen, intro } = ausSeiteLesen(html);

  const titelZeilen = umbrechen(beispiel.h1 || beispiel.title || beispiel.slug, 26);
  const fakten = [beispiel.flaeche ? beispiel.flaeche + ' m²' : null, beispiel.licht, beispiel.feuchtigkeit]
    .filter(Boolean).join('   ·   ');

  // Erst den Platz ausrechnen, dann die Grafik hineinlegen. Ein flaches Beet (4,2 × 1,4 m)
  // ergibt bei fester Breite einen schmalen Streifen — in der ersten Fassung blieb dadurch
  // das untere Drittel des Pins leer. Jetzt bekommt die Grafik den Raum, der nach Titel,
  // Liste und Fußzeile übrig ist, und wird notfalls über die Höhe eingepasst.
  const kopfH = 70 + titelZeilen.length * (titelZeilen.length > 1 ? 64 : 72) + (fakten ? 62 : 0);
  const listeH = 46 + Math.min(namen.length, 12) * 40 + 30;
  const frei = H - kopfH - listeH - 90 - 60;                 // 90 Fußzeile, 60 Abstände
  const maxBreite = B - 80;

  let png = new Resvg(svg, { fitTo: { mode: 'width', value: maxBreite }, font: { loadSystemFonts: true } }).render();
  if (png.height > frei) {
    png = new Resvg(svg, { fitTo: { mode: 'height', value: frei }, font: { loadSystemFonts: true } }).render();
  } else if (png.height < frei * 0.75) {
    // Deutlich kleiner als der Platz: über die Höhe strecken, bis die Breite anschlägt.
    const versuch = new Resvg(svg, { fitTo: { mode: 'height', value: frei }, font: { loadSystemFonts: true } }).render();
    if (versuch.width <= maxBreite) png = versuch;
  }
  const grafikDatei = '/tmp/pin-grafik-' + beispiel.slug + '.png';
  fs.writeFileSync(grafikDatei, png.asPng());
  const grafikH = png.height, grafikB = png.width;

  // Aufbau von oben: Titel, Fakten, Grafik, Pflanzenliste, Fußzeile.
  const args = ['-size', `${B}x${H}`, `xc:${GRUEN}`, '-gravity', 'northwest'];
  let y = 70;

  args.push('-font', FONT_B, '-pointsize', titelZeilen.length > 1 ? '56' : '64', '-fill', 'white');
  for (const z of titelZeilen) { args.push('-annotate', `+60+${y}`, z); y += titelZeilen.length > 1 ? 64 : 72; }

  if (fakten) {
    args.push('-font', FONT, '-pointsize', '32', '-fill', '#95d5b2');
    args.push('-annotate', `+60+${y + 8}`, fakten);
    y += 62;
  }

  const grafikY = y + 10;
  const grafikX = Math.round((B - grafikB) / 2);   // mittig, falls schmaler als die Fläche
  args.push('-draw', `image over ${grafikX},${grafikY} 0,0 "${grafikDatei}"`);
  y = grafikY + grafikH + 44;

  // Pflanzenliste mit denselben Nummern wie die Kreise in der Grafik.
  args.push('-font', FONT_B, '-pointsize', '30', '-fill', '#d8f3dc');
  args.push('-annotate', `+60+${y}`, 'Die Pflanzen dazu');
  y += 46;
  // Nur so viele Zeilen, wie bis zur Fußzeile passen — abschneiden ist besser als überlappen.
  const platz = Math.max(0, Math.floor((H - 90 - y) / 44));
  for (const n of namen.slice(0, platz)) {
    args.push('-font', FONT, '-pointsize', '29', '-fill', 'white');
    args.push('-annotate', `+60+${y}`, `${n.nr}  ${n.name}`);
    if (n.bluehzeit) {
      // Blühzeit als zweite Spalte. Sie ist der eigentliche Nutzen einer Pflanzenliste —
      // „was blüht wann" ist die Frage, wegen der jemand so einen Plan aufhebt.
      args.push('-font', FONT, '-pointsize', '25', '-fill', '#95d5b2');
      args.push('-annotate', `+640+${y + 3}`, n.bluehzeit.replace(/\s*-\s*/, ' – '));
    }
    y += 44;
  }
  if (namen.length > platz) {
    args.push('-font', FONT, '-pointsize', '26', '-fill', '#74c69d');
    args.push('-annotate', `+60+${y}`, `und ${namen.length - platz} weitere`);
    y += 40;
  }

  // Bleibt danach noch Platz, füllt ihn der Einleitungssatz der Beispielseite. Ohne ihn
  // stand bei flachen Beeten mit wenigen Arten das untere Drittel des Pins leer.
  // NUR VOLLSTÄNDIGE SÄTZE: Der Teasertext der Seite ist selbst schon mit „…" gekürzt,
  // ein mitten im Wort abbrechender Satz auf einem Pin sieht nach Fehler aus.
  const saetze = String(intro).replace(/\s*[……].*$/, '').trim();
  const ganzeSaetze = (saetze.match(/^.*[.!?](?=\s|$)/s) || [saetze])[0].trim();
  if (ganzeSaetze.length > 30 && H - 90 - y > 120) {
    args.push('-font', FONT, '-pointsize', '29', '-fill', '#b7e4c7');
    let iy = y + 30;
    for (const z of umbrechen(ganzeSaetze, 44).slice(0, Math.floor((H - 200 - iy) / 40))) {
      args.push('-annotate', `+60+${iy}`, z);
      iy += 40;
    }
    y = iy;
  }

  // Aufruf am Fuß: Auf Pinterest ist der Pin selbst die Anzeige — ohne einen Grund zu klicken
  // bleibt der Nutzer dort. Steht bewusst über der Fußzeile, nicht in ihr.
  if (H - 90 - y > 70) {
    args.push('-font', FONT_B, '-pointsize', '31', '-fill', '#95d5b2');
    args.push('-annotate', `+60+${H - 120}`, 'Eigenen Plan erstellen — kostenlos, in 2 Minuten');
  }

  args.push('-font', FONT, '-pointsize', '25', '-fill', '#74c69d');
  args.push('-annotate', `+60+${H - 40}`, 'staudenplan.de   ·   kostenloser Beetplaner');

  args.push('-quality', '88', ziel);
  execFileSync('convert', args, { stdio: 'pipe' });
  try { fs.unlinkSync(grafikDatei); } catch {}
  return { ziel, arten: namen.length, grafikH };
}

if (require.main === module) {
  const slug = process.argv[2];
  if (!slug) { console.error('Aufruf: node scripts/pin-beetplan.js <slug> [ziel.jpg]'); process.exit(1); }
  // BEISPIELE stehen im Server; für das Skript reichen die Eckdaten aus der Seite selbst,
  // die restlichen Felder holen wir aus dem Modul, wenn es geladen werden kann.
  const beispiel = { slug };
  holeSeite('/beispiel/' + slug).then(html => {
    beispiel.h1 = (html.match(/<h1[^>]*>([^<]+)/) || [])[1];
    beispiel.flaeche = (html.match(/Fläche<\/div>\s*<div[^>]*>([\d.,]+) m²/) || [])[1];
    beispiel.licht = (html.match(/Licht<\/div>\s*<div[^>]*>([^<]+)/) || [])[1];
    return beetPin(beispiel, process.argv[3] || `/tmp/pin-beet-${slug}.jpg`);
  }).then(r => console.log('erzeugt:', r.ziel, '·', r.arten, 'Arten · Grafikhöhe', r.grafikH))
    .catch(e => { console.error('Fehler:', e.message); process.exit(1); });
}

module.exports = { beetPin, holeSeite, ausSeiteLesen };
