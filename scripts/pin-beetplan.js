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
const { execFileSync } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');

const B = 1000, H = 1500;
const FONT = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf';
const FONT_B = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf';
const GRUEN = '#1b4332';
const PORT = process.env.PIN_PORT || 3003;

// Die Seite beschriftet die Giftstufen mit Emoji davor (GIFT_LABEL in stauden-server.js).
// Hier steht die Rückabbildung auf die Stufe — daran hängt nur noch die Farbe der Leiste.
const STUFE_AUS_LABEL = {
  'Stark giftig': 'stark',
  'Giftig': 'giftig',
  'Für Katzen lebensgefährlich': 'katzen',
  'Für Haustiere giftig': 'haustiere',
  'Hautreizend': 'reizend',
};

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

  // Die Giftwarnung wird NICHT neu berechnet, sondern aus der Seite gelesen — wie das SVG und
  // die Legende. Die Alternative wäre, die Pflanzen erneut zu laden und giftigkeit() ein zweites
  // Mal anzuwenden; genau solche Zweitlogik läuft irgendwann auseinander. Die Seite hatte den
  // Befund die ganze Zeit korrekt, der Pin hat ihn bis zum 18.08.2026 weggeworfen: Der
  // Schattenbeet-Pin zeigte vier als giftig geführte Arten ohne ein Wort dazu.
  // Bewusst ohne regulären Ausdruck zerlegt: Der Block ist flach, und eine Kette aus split()
  // ist hier leichter zu prüfen als ein Muster mit mehreren Maskierungsebenen.
  const rohBlock = html.split('background:#fef2f2')[1];
  const block = rohBlock ? rohBlock.split('</div>')[0] : '';
  const gift = block.split('<strong>').slice(1).map(teil => {
    const trenn = teil.indexOf(':</strong>');
    if (trenn < 0) return null;
    // Die Seite stellt jeder Stufe ein Emoji voran ("⚠️ Giftig"). Der Pin nutzt DejaVu, die
    // keine Emoji zeichnet — also abtrennen. Fällt die Zuordnung durch, bleibt der volle Text.
    const roh = teil.slice(0, trenn).trim();
    const ohneEmoji = roh.split(' ').slice(1).join(' ').trim();
    const beschriftung = STUFE_AUS_LABEL[ohneEmoji] ? ohneEmoji : roh;
    const namen = teil.slice(trenn + 10).split('.')[0].trim();
    return namen ? { stufe: STUFE_AUS_LABEL[beschriftung] || 'giftig', beschriftung, namen } : null;
  }).filter(Boolean);
  // Laut scheitern statt stumm ohne Warnung pinnen: Wenn die Seite einen Giftblock hat, ihn aber
  // niemand mehr lesen kann, ist das Markup gewandert. Ein Pin ist nicht zurückholbar — deshalb
  // bricht der Lauf ab, statt ein Bild ohne die Warnung zu erzeugen.
  if (block && !gift.length) {
    throw new Error('Giftblock gefunden, aber nicht lesbar — Markup geändert? Abbruch, damit kein ungewarnter Pin entsteht.');
  }

  return { svg, namen, intro, gift };
}

function umbrechen(text, max) {
  const worte = String(text).split(/\s+/); const zeilen = []; let z = '';
  for (const w of worte) {
    if ((z + ' ' + w).trim().length > max) { if (z) zeilen.push(z.trim()); z = w; } else z = (z + ' ' + w).trim();
  }
  if (z) zeilen.push(z); return zeilen;
}

async function beetPin(beispiel, ziel) {
  // Erst hier laden: Ohne diese native Abhängigkeit bleibt das Modul trotzdem nutzbar für
  // holeSeite() und ausSeiteLesen(), die pin-text.js für die Vorschau braucht.
  const { Resvg } = require('@resvg/resvg-js');
  const html = await holeSeite('/beispiel/' + beispiel.slug);
  const { svg, namen, intro, gift } = ausSeiteLesen(html);

  const titelZeilen = umbrechen(beispiel.h1 || beispiel.title || beispiel.slug, 26);
  const fakten = [beispiel.flaeche ? beispiel.flaeche + ' m²' : null, beispiel.licht, beispiel.feuchtigkeit]
    .filter(Boolean).join('   ·   ');

  // Erst den Platz ausrechnen, dann die Grafik hineinlegen. Ein flaches Beet (4,2 × 1,4 m)
  // ergibt bei fester Breite einen schmalen Streifen — in der ersten Fassung blieb dadurch
  // das untere Drittel des Pins leer. Jetzt bekommt die Grafik den Raum, der nach Titel,
  // Liste und Fußzeile übrig ist, und wird notfalls über die Höhe eingepasst.
  const kopfH = 70 + titelZeilen.length * (titelZeilen.length > 1 ? 64 : 72) + (fakten ? 62 : 0);
  const listeH = 46 + Math.min(namen.length, 12) * 40 + 30;
  // Die Giftleiste bekommt ihren Platz VOR der Grafik zugeteilt, nicht was hinterher übrig ist.
  // Sonst wäre sie das Erste, was bei einem vollen Beet unter den Tisch fällt.
  const giftH = gift.length ? 26 + gift.reduce((n, g) => n + umbrechen(g.beschriftung + ': ' + g.namen, 52).length, 0) * 36 : 0;
  const frei = H - kopfH - listeH - giftH - 90 - 60;         // 90 Fußzeile, 60 Abstände
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

  // Giftleiste direkt unter der Pflanzenliste — dort, wo die Namen stehen, auf die sie sich
  // bezieht. Am Fuß unter dem Aufruf wäre sie nicht mehr zuzuordnen. Kein Emoji: Die Schrift
  // im Pin ist DejaVu, die zeichnet keine Emoji und setzte an ihrer Stelle leere Kästen.
  if (gift.length) {
    y += 14;
    for (const g of gift) {
      const stark = g.stufe === 'stark';
      args.push('-font', FONT_B, '-pointsize', '27', '-fill', stark ? '#ff9b8a' : '#ffd166');
      for (const z of umbrechen('! ' + g.beschriftung + ': ' + g.namen, 52)) {
        args.push('-annotate', `+60+${y}`, z);
        y += 36;
      }
    }
    y += 8;
  }

  // Bleibt danach noch Platz, füllt ihn der Einleitungssatz der Beispielseite. Ohne ihn
  // stand bei flachen Beeten mit wenigen Arten das untere Drittel des Pins leer.
  // NUR VOLLSTÄNDIGE SÄTZE: Der Teasertext der Seite ist selbst schon mit „…" gekürzt,
  // ein mitten im Wort abbrechender Satz auf einem Pin sieht nach Fehler aus.
  const saetze = String(intro).replace(/\s*[……].*$/, '').trim();
  // Ohne Satzzeichen KEIN Rückfall auf den Rohtext: Die Seitenlese kappt bei 300 Zeichen, oft
  // mitten im Wort ("und wenig W" auf dem Nordseite-Pin). Lieber gar kein Satz als ein halber —
  // der Platz bleibt dann leer, was niemandem auffällt, während ein Wortbruch nach Fehler aussieht.
  const ganzeSaetze = (saetze.match(/^.*[.!?](?=\s|$)/s) || [''])[0].trim();
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
  return { ziel, arten: namen.length, grafikH, gift };
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
  }).then(r => console.log('erzeugt:', r.ziel, '·', r.arten, 'Arten · Grafikhöhe', r.grafikH
      + (r.gift.length ? ' · Giftwarnung: ' + r.gift.map(g => g.beschriftung + ' (' + g.namen + ')').join(' / ') : ' · keine Giftpflanze')))
    .catch(e => { console.error('Fehler:', e.message); process.exit(1); });
}

module.exports = { beetPin, holeSeite, ausSeiteLesen };
