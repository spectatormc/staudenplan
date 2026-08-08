/*
 * Erzeugt aus einer Pflanze der Datenbank ein fertiges Pinterest-Bild (1000 × 1500).
 *
 *   node scripts/pin-bild.js <id|botanischer Name> [zielpfad.jpg]
 *
 * Pinterest ist eine Bildsuchmaschine — hochkant im Verhältnis 2:3 ist das Format, das dort
 * überhaupt sichtbar wird. Die vorhandenen Pflanzenbilder sind quer (meist 640 × 427), das
 * Bild wird deshalb oben quadratisch eingepasst und unten um eine Textfläche ergänzt.
 *
 * Es werden AUSSCHLIESSLICH selbst erzeugte KI-Bilder verwendet (bild_ki = 1). Die übrigen
 * Fotos stammen von Pixabay; deren Lizenz erlaubt zwar viel, aber eine öffentliche Verbreitung
 * fremder Fotos unter eigenem Namen ist ein Risiko, das dieser Kanal nicht wert ist. Jedes
 * erzeugte Bild trägt deshalb den Hinweis "Illustration".
 *
 * Gebaut mit ImageMagick (auf dem Server vorhanden), nicht mit einer Node-Bibliothek —
 * sharp, canvas und resvg sind dort alle nicht installiert.
 */
const Database = require('better-sqlite3');
const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const { giftigkeit } = require('./pflanzen-giftigkeit');

const WURZEL = path.join(__dirname, '..');
const db = new Database(process.env.DB_PFAD || path.join(WURZEL, 'stauden.db'), { readonly: true });

const B = 1000, H = 1500, BILD_H = 1000;      // Bildfläche oben, Textfläche unten
const FONT = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf';
const FONT_B = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf';
const GRUEN = '#1b4332';

// Umbruch von Hand: ImageMagick bricht 'label:' zwar selbst um, dann lässt sich die Höhe
// aber nicht mehr vorhersagen — und die Textfläche ist auf 500 px fest.
function umbrechen(text, maxZeichen) {
  const worte = String(text).split(/\s+/);
  const zeilen = [];
  let z = '';
  for (const w of worte) {
    if ((z + ' ' + w).trim().length > maxZeichen) { if (z) zeilen.push(z.trim()); z = w; }
    else z = (z + ' ' + w).trim();
  }
  if (z) zeilen.push(z);
  return zeilen;
}

function pinBild(p, ziel) {
  const quelle = path.join(WURZEL, 'public', p.bild_url.replace(/^\//, ''));
  if (!fs.existsSync(quelle)) throw new Error('Bilddatei fehlt: ' + quelle);

  const gift = giftigkeit(p.name_botanisch);
  const hoehe = p.hoehe_cm_min && p.hoehe_cm_max ? `${p.hoehe_cm_min}–${p.hoehe_cm_max} cm` : null;
  const fakten = [p.bluehzeit, hoehe, (p.licht || '').split('|')[0]].filter(Boolean);

  const nameZeilen = umbrechen(p.name_deutsch, 24);
  const args = [
    // Bild oben: quadratisch füllen und mittig beschneiden
    quelle, '-resize', `${B}x${BILD_H}^`, '-gravity', 'center', '-extent', `${B}x${BILD_H}`,
    // Textfläche unten anfügen
    '(', '-size', `${B}x${H - BILD_H}`, `xc:${GRUEN}`, ')', '-append',
    '-gravity', 'northwest',
  ];

  let y = BILD_H + 46;
  args.push('-font', FONT_B, '-pointsize', nameZeilen.length > 1 ? '58' : '66', '-fill', 'white');
  for (const z of nameZeilen) { args.push('-annotate', `+60+${y}`, z); y += nameZeilen.length > 1 ? 66 : 74; }

  args.push('-font', FONT, '-pointsize', '34', '-fill', '#95d5b2');
  args.push('-annotate', `+60+${y + 6}`, p.name_botanisch);
  y += 62;

  if (fakten.length) {
    args.push('-font', FONT, '-pointsize', '31', '-fill', '#d8f3dc');
    args.push('-annotate', `+60+${y + 14}`, fakten.join('   ·   '));
    y += 56;
  }

  if (gift) {
    const label = { stark: 'Stark giftig', giftig: 'Giftig', katzen: 'Für Katzen lebensgefährlich',
                    haustiere: 'Für Haustiere giftig', reizend: 'Hautreizend' }[gift.stufe] || 'Giftig';
    args.push('-font', FONT_B, '-pointsize', '28', '-fill', gift.stufe === 'stark' ? '#fca5a5' : '#fde68a');
    args.push('-annotate', `+60+${y + 12}`, '! ' + label);
  }

  // Fußzeile: Herkunft und Quelle. "Illustration" ist Pflicht — es ist kein Foto.
  // Absolute Koordinate statt gravity southwest: Letzteres landete in der Bildfläche statt
  // auf der grünen Leiste, weil sich die Ausrichtung nicht auf die zusammengesetzte Höhe
  // bezog. Mit northwest und fester y-Position ist die Lage eindeutig.
  args.push('-font', FONT, '-pointsize', '25', '-fill', '#74c69d');
  args.push('-annotate', `+60+${H - 40}`, 'staudenplan.de   ·   Illustration');

  args.push('-quality', '88', ziel);
  execFileSync('convert', args, { stdio: 'pipe' });
  return ziel;
}

if (require.main === module) {
  const arg = process.argv[2];
  if (!arg) { console.error('Aufruf: node scripts/pin-bild.js <id|botanischer Name> [ziel.jpg]'); process.exit(1); }
  const p = /^\d+$/.test(arg)
    ? db.prepare('SELECT * FROM pflanzen WHERE id = ?').get(Number(arg))
    : db.prepare('SELECT * FROM pflanzen WHERE name_botanisch = ?').get(arg);
  if (!p) { console.error('Pflanze nicht gefunden: ' + arg); process.exit(1); }
  if (!p.bild_ki) { console.error('Kein selbst erzeugtes Bild — für Pinterest nicht verwendbar: ' + p.name_botanisch); process.exit(1); }
  const ziel = process.argv[3] || `/tmp/pin-${p.id}.jpg`;
  pinBild(p, ziel);
  console.log('erzeugt:', ziel);
}

module.exports = { pinBild, umbrechen };
