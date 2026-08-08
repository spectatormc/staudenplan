/*
 * Erzeugt aus drei zusammenpassenden Stauden ein Pinterest-Bild (1000 × 1500) mit
 * Blühkalender.
 *
 *   node scripts/pin-kombination.js [--standort sonne/normal] [--nr 0] [ziel.jpg]
 *   node scripts/pin-kombination.js --ids 12,88,301 [ziel.jpg]
 *   node scripts/pin-kombination.js --liste 20           (nur anzeigen, nichts erzeugen)
 *
 * WARUM NICHT DAS FELD `kombinationspartner`:
 * Es ist zwar für alle 709 Pflanzen gefüllt, aber unbrauchbar konzentriert — 2816 Nennungen
 * verteilen sich auf 208 verschiedene Partner, die zehn häufigsten stellen die Hälfte aller
 * Nennungen, Echinacea purpurea allein wird 263-mal genannt. 77 genannte Partner stehen gar
 * nicht in der Datenbank (teils nur Gattungen wie „Hosta"). Verlangt man zusätzlich, dass alle
 * Beteiligten ein eigenes Bild haben, bleiben ganze 15 Dreier übrig — davon fast alles Farne.
 * Ein Kanal, der immer dieselben drei Pflanzen zeigt, ist nach zwei Wochen tot.
 *
 * Stattdessen werden die Kombinationen aus geprüften Eigenschaften GEBILDET: gemeinsamer
 * Licht- und Feuchteanspruch, lückenlos aneinander anschließende Blütezeiten, erkennbare
 * Höhenstaffelung, drei verschiedene Gattungen. Das ergibt 151634 gültige Dreier. Der
 * Unterschied ist nicht nur die Menge: „Diese drei blühen nacheinander von Mai bis Oktober"
 * ist aus der Datenbank BEWEISBAR, „diese passen gut zusammen" wäre eine Meinung.
 * `kombinationspartner` fließt nur noch als Bonus in die Bewertung ein — wo es die Auswahl
 * bestätigt, steigt die Punktzahl.
 *
 * Es werden AUSSCHLIESSLICH selbst erzeugte KI-Bilder verwendet (bild_ki = 1), wie bei
 * scripts/pin-bild.js — fremde Fotos unter eigenem Namen zu verbreiten ist das Risiko nicht
 * wert. Daher der Hinweis „Illustrationen" in der Fußzeile.
 */
const Database = require('better-sqlite3');
const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const { giftigkeit } = require('./pflanzen-giftigkeit');

const WURZEL = path.join(__dirname, '..');
const B = 1000, H = 1500, BILD_H = 580;
const FONT = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf';
const FONT_B = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf';
const GRUEN = '#1b4332';

const MONATE = { Januar:1, Februar:2, 'März':3, April:4, Mai:5, Juni:6,
                 Juli:7, August:8, September:9, Oktober:10, November:11, Dezember:12 };
const MON_KURZ = ['J','F','M','A','M','J','J','A','S','O','N','D'];
const MON_NAME = ['Januar','Februar','März','April','Mai','Juni','Juli','August','September','Oktober','November','Dezember'];

// Die Blütenfarbe wird als Balkenfarbe im Kalender benutzt. Ohne Zuordnung wäre der Kalender
// dreimal dieselbe Farbe und würde nichts über die Kombination verraten.
const FARBTON = {
  'weiß':'#f8f9fa', 'gelb':'#ffd166', 'rosa':'#f4a3c0', 'grün':'#74c69d', 'blau':'#6ba3d6',
  'rot':'#e5544b', 'lila':'#b18ad4', 'violett':'#a17ac9', 'orange':'#f79154', 'purpur':'#c264a0',
  'braun':'#b08968', 'silbrig':'#ced4da', 'beige':'#e6d9b8', 'rotbraun':'#a9564b',
  'silbrig-grün':'#c2d5c0', 'dunkelviolett':'#8b6bb1', 'karamell':'#d49a5c',
  'blauviolett':'#8a8ad0', 'schwarz':'#6c757d', 'lachs':'#f0917c', 'dunkelrot':'#b23a3a',
  'burgunderrot':'#9d3b52', 'lavendel':'#c3b1e1', 'silber':'#dee2e6',
};

function spanne(bluehzeit) {
  const t = String(bluehzeit || '').split(/\s*(?:–|—|-|bis)\s*/).map(s => s.trim());
  const a = MONATE[t[0]], e = MONATE[t[1]] || MONATE[t[0]];
  return (a && e && e >= a) ? [a, e] : null;
}
const mengeAus = s => new Set(String(s || '').split('|').map(x => x.trim().toLowerCase()).filter(Boolean));
const schnitt = (a, b) => [...mengeAus(a)].filter(x => mengeAus(b).has(x));
const farbeVon = p => String(p.farbe || '').split(/[|,]/)[0].trim().toLowerCase();

/*
 * Textbreite bei ImageMagick erfragen statt aus der Zeichenzahl schätzen. Die Monatsnamen
 * unterscheiden sich stark („Mai bis Juli" gegen „September bis November"), und eine
 * geschätzte Breite hat den Titel schon rechts aus dem Bild laufen lassen.
 */
function textBreite(text, font, size) {
  const out = execFileSync('convert', ['-font', font, '-pointsize', String(size),
                                       `label:${text}`, '-format', '%w', 'info:'], { encoding: 'utf8' });
  return Number(String(out).trim()) || 0;
}

// Größte Schriftgröße, bei der der Text noch in die Breite passt.
function passendeGroesse(text, font, start, min, maxBreite) {
  let s = start;
  while (s > min && textBreite(text, font, s) > maxBreite) s -= 2;
  return s;
}

// Zeichen pro Zeile aus einer echten Messung ableiten (ein Aufruf statt einer je Wort).
function zeichenProZeile(text, font, size, maxBreite) {
  const b = textBreite(text, font, size);
  return b ? Math.max(8, Math.floor(text.length * maxBreite / b)) : 40;
}

function umbrechen(text, max) {
  const worte = String(text).split(/\s+/); const zeilen = []; let z = '';
  for (const w of worte) {
    if ((z + ' ' + w).trim().length > max) { if (z) zeilen.push(z.trim()); z = w; } else z = (z + ' ' + w).trim();
  }
  if (z) zeilen.push(z); return zeilen;
}

function ladePflanzen(db) {
  return db.prepare(`SELECT id, name_deutsch, name_botanisch, farbe, licht, feuchtigkeit, bluehzeit,
                            hoehe_cm_min, hoehe_cm_max, bienen_freundlich, heimisch, kombinationspartner, bild_url
                     FROM pflanzen
                     WHERE bild_ki = 1 AND bild_url IS NOT NULL AND hoehe_cm_max > 0`).all()
           .filter(p => spanne(p.bluehzeit) && fs.existsSync(path.join(WURZEL, 'public', p.bild_url.replace(/^\//, ''))))
           // Pflanzen ohne echten deutschen Namen aussortieren: Bei ihnen steht die Gattung im
           // Feld name_deutsch, der Pin liest sich dann „Muhlenbergia · Muhlenbergia capillaris".
           // Betrifft neun Arten. Einen deutschen Namen dafür zu erfinden wäre schlimmer als sie
           // wegzulassen — sobald die Namen gepflegt sind, fallen sie von selbst wieder herein.
           .filter(p => {
             const deutsch = String(p.name_deutsch || '').trim().toLowerCase();
             return deutsch && deutsch !== String(p.name_botanisch || '').split(' ')[0].toLowerCase()
                            && deutsch !== String(p.name_botanisch || '').toLowerCase();
           });
}

/*
 * Prüft die harten Bedingungen und bewertet, wie gut die drei zusammenpassen.
 * Gibt null zurück, wenn die Kombination gärtnerisch nicht taugt.
 */
function bewerte(d) {
  const L = schnitt(schnitt(d[0].licht, d[1].licht).join('|'), d[2].licht);
  if (!L.length) return null;                                   // kein gemeinsamer Lichtanspruch
  const F = schnitt(schnitt(d[0].feuchtigkeit, d[1].feuchtigkeit).join('|'), d[2].feuchtigkeit);
  if (!F.length) return null;                                   // kein gemeinsamer Wasserbedarf
  if (new Set(d.map(p => p.name_botanisch.split(' ')[0])).size < 3) return null;   // dreimal dieselbe Gattung

  const s = d.map(p => spanne(p.bluehzeit));
  const sortiert = d.map((p, i) => ({ p, s: s[i] })).sort((a, b) => a.s[0] - b.s[0]);
  const von = sortiert[0].s[0], bis = Math.max(...s.map(x => x[1]));
  if (bis - von < 4) return null;                               // unter fünf Monaten lohnt die Aussage nicht
  // Lücke: eine Kombination, die im August pausiert, ist keine durchgehende Blüte.
  for (let i = 1; i < 3; i++) if (sortiert[i].s[0] - Math.max(...sortiert.slice(0, i).map(x => x.s[1])) > 1) return null;

  const h = d.map(p => p.hoehe_cm_max).sort((a, b) => b - a);
  if (h[0] < h[2] * 1.6) return null;                           // ohne Staffelung sieht es nicht nach Planung aus

  // Bewertung. Je später eine Zeile, desto weicher das Kriterium.
  const monate = new Set();
  s.forEach(([a, e]) => { for (let m = a; m <= e; m++) monate.add(m); });
  let ueberlappung = 0;
  for (let i = 0; i < 3; i++) for (let j = i + 1; j < 3; j++)
    ueberlappung += Math.max(0, Math.min(s[i][1], s[j][1]) - Math.max(s[i][0], s[j][0]) + 1);
  const farben = new Set(d.map(farbeVon).filter(Boolean));
  // Bestätigung durch das kuratierte Feld: zählt, reicht aber nicht als Bedingung (s. o.).
  let kuratiert = 0;
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) if (i !== j)
    if (String(d[i].kombinationspartner || '').includes(d[j].name_botanisch)) kuratiert++;
  const bienen = d.filter(p => p.bienen_freundlich).length;
  const heimisch = d.filter(p => p.heimisch).length;

  const punkte = monate.size * 3 - ueberlappung * 1.5 + farben.size * 2.5
               + kuratiert * 3 + bienen * 1.2 + heimisch * 0.8 + Math.min(h[0] / h[2], 4);

  return { punkte, licht: L[0], feuchte: F[0], von, bis, monate: monate.size,
           kuratiert, pflanzen: sortiert.map(x => x.p) };
}

/*
 * Sucht die besten Kombinationen. `benutzt` verhindert, dass dieselbe Pflanze den halben
 * Kanal bestreitet — genau der Fehler, an dem das Feld `kombinationspartner` scheitert.
 */
function findeKombinationen(pflanzen, { standort, anzahl = 20 } = {}) {
  const treffer = [];
  for (let i = 0; i < pflanzen.length; i++)
    for (let j = i + 1; j < pflanzen.length; j++)
      for (let k = j + 1; k < pflanzen.length; k++) {
        const b = bewerte([pflanzen[i], pflanzen[j], pflanzen[k]]);
        if (!b) continue;
        if (standort && `${b.licht}/${b.feuchte}` !== standort) continue;
        treffer.push(b);
      }
  treffer.sort((a, b) => b.punkte - a.punkte);

  const benutzt = new Map(), gewaehlt = [];
  for (const t of treffer) {
    if (gewaehlt.length >= anzahl) break;
    // Höchstens zweimal dieselbe Pflanze in der Auswahl.
    if (t.pflanzen.some(p => (benutzt.get(p.id) || 0) >= 2)) continue;
    t.pflanzen.forEach(p => benutzt.set(p.id, (benutzt.get(p.id) || 0) + 1));
    gewaehlt.push(t);
  }
  return gewaehlt;
}

function kombiPin(kombi, ziel) {
  const d = kombi.pflanzen;
  const tmp = [];

  // Die drei Bilder nebeneinander als Kopfband. Bei 1000 px teilt sich das nicht glatt,
  // die dritte Kachel bekommt den Rest.
  const breiten = [333, 333, 334];
  let x = 0;
  const kacheln = d.map((p, i) => {
    const quelle = path.join(WURZEL, 'public', p.bild_url.replace(/^\//, ''));
    const datei = `/tmp/pin-kombi-${p.id}-${i}.png`;
    execFileSync('convert', [quelle, '-resize', `${breiten[i]}x${BILD_H}^`, '-gravity', 'center',
                             '-extent', `${breiten[i]}x${BILD_H}`, datei], { stdio: 'pipe' });
    tmp.push(datei);
    const eintrag = { datei, x, breite: breiten[i] };
    x += breiten[i];
    return eintrag;
  });

  const args = ['-size', `${B}x${H}`, `xc:${GRUEN}`, '-gravity', 'northwest'];
  kacheln.forEach(k => args.push('-draw', `image over ${k.x},0 0,0 "${k.datei}"`));

  // Nummern auf den Kacheln, dieselben wie in der Liste darunter.
  kacheln.forEach((k, i) => {
    const cx = k.x + 34, cy = 34;
    args.push('-fill', 'rgba(27,67,50,0.88)', '-draw', `circle ${cx},${cy} ${cx},${cy + 23}`);
    args.push('-fill', 'white', '-font', FONT_B, '-pointsize', '30',
              '-annotate', `+${cx - 9}+${cy - 15}`, String(i + 1));
  });

  let y = BILD_H + 44;

  const innen = B - 120;
  const titel = `Von ${MON_NAME[kombi.von - 1]} bis ${MON_NAME[kombi.bis - 1]} in Blüte`;
  const titelGr = passendeGroesse(titel, FONT_B, 54, 38, innen);
  args.push('-font', FONT_B, '-pointsize', String(titelGr), '-fill', 'white');
  args.push('-annotate', `+60+${y}`, titel);
  y += titelGr + 12;

  const unter = `3 Stauden für ${kombi.licht === 'sonne' ? 'die Sonne' : kombi.licht === 'schatten' ? 'den Schatten' : 'den Halbschatten'}   ·   ${kombi.feuchte}er Boden`;
  const unterGr = passendeGroesse(unter, FONT, 31, 22, innen);
  args.push('-font', FONT, '-pointsize', String(unterGr), '-fill', '#95d5b2');
  args.push('-annotate', `+60+${y}`, unter);
  y += 62;

  // Blühkalender. Das ist der eigentliche Nutzen des Pins: „was blüht wann" auf einen Blick,
  // und der Beleg für die Aussage in der Überschrift.
  const kx = 60, kb = B - 120, spalte = kb / 12;
  args.push('-font', FONT, '-pointsize', '23', '-fill', '#74c69d');
  MON_KURZ.forEach((m, i) => args.push('-annotate', `+${Math.round(kx + i * spalte + spalte / 2 - 6)}+${y}`, m));
  y += 34;                                    // Höhe der Beschriftung, sonst liegt sie im ersten Balken

  d.forEach((p, i) => {
    const [a, e] = spanne(p.bluehzeit);
    const x1 = Math.round(kx + (a - 1) * spalte), x2 = Math.round(kx + e * spalte) - 4;
    const ton = FARBTON[farbeVon(p)] || '#95d5b2';
    args.push('-fill', 'rgba(255,255,255,0.10)', '-draw', `roundrectangle ${kx},${y} ${kx + kb},${y + 30} 6,6`);
    args.push('-fill', ton, '-draw', `roundrectangle ${x1},${y} ${x2},${y + 30} 6,6`);
    // Nummer im Balken, damit die Zeile ohne Nachzählen der Liste zuzuordnen ist.
    args.push('-fill', 'rgba(27,67,50,0.75)', '-font', FONT_B, '-pointsize', '20',
              '-annotate', `+${x1 + 10}+${y + 6}`, String(i + 1));
    y += 40;
  });
  y += 18;

  // Die drei Pflanzen mit Name, Höhe und Blütezeit.
  d.forEach((p, i) => {
    const ton = FARBTON[farbeVon(p)] || '#95d5b2';
    args.push('-fill', ton, '-draw', `circle ${74},${y + 14} ${74},${y + 24}`);
    const zeile = `${i + 1}  ${p.name_deutsch}`;
    args.push('-font', FONT_B, '-pointsize', String(passendeGroesse(zeile, FONT_B, 30, 22, B - 160)), '-fill', 'white');
    args.push('-annotate', `+100+${y}`, zeile);
    const daten = `${p.name_botanisch}   ·   ${p.hoehe_cm_max} cm   ·   ${p.bluehzeit.replace(/\s*-\s*/, ' – ')}`;
    args.push('-font', FONT, '-pointsize', String(passendeGroesse(daten, FONT, 25, 19, B - 160)), '-fill', '#95d5b2');
    args.push('-annotate', `+100+${y + 36}`, daten);
    y += 76;
  });

  // Giftwarnung. Bei drei Pflanzen auf einem Bild ist nicht erkennbar, welche gemeint ist —
  // deshalb steht der Name dabei. Ohne diese Zeile könnte der Pin Eisenhut oder
  // Herbstzeitlose als hübsche Beetidee zeigen, ohne ein Wort dazu.
  const giftig = d.map((p, i) => ({ i, p, g: giftigkeit(p.name_botanisch) })).filter(x => x.g);
  if (giftig.length) {
    const rang = { stark: 0, giftig: 1, katzen: 2, haustiere: 3, reizend: 4 };
    giftig.sort((a, b) => (rang[a.g.stufe] ?? 9) - (rang[b.g.stufe] ?? 9));
    const label = { stark:'Stark giftig', giftig:'Giftig', katzen:'Für Katzen lebensgefährlich',
                    haustiere:'Für Haustiere giftig', reizend:'Hautreizend' };
    const stark = giftig[0].g.stufe === 'stark';
    const text = giftig.map(x => `${label[x.g.stufe] || 'Giftig'}: ${x.p.name_deutsch}`).join('   ·   ');
    args.push('-font', FONT_B, '-pointsize', '26', '-fill', stark ? '#fca5a5' : '#fde68a');
    for (const z of umbrechen('! ' + text, zeichenProZeile('! ' + text, FONT_B, 26, innen))) {
      args.push('-annotate', `+60+${y}`, z); y += 34;
    }
  }

  // Die Blühfolge noch einmal in Worten. Der Kalender zeigt sie, aber der Satz ist das,
  // was jemand beim Weiterreichen des Pins wiedergeben kann — und er füllte den Raum, der
  // sonst zwischen Liste und Aufruf leer blieb.
  if (H - 150 - y > 80) {
    const [a, b, c] = d;
    const satz = `Erst ${a.name_deutsch}, dann ${b.name_deutsch}, ab ${MON_NAME[spanne(c.bluehzeit)[0] - 1]} ${c.name_deutsch}. So steht das Beet nie leer.`;
    args.push('-font', FONT, '-pointsize', '29', '-fill', '#b7e4c7');
    let sy = y + 24;
    for (const z of umbrechen(satz, zeichenProZeile(satz, FONT, 29, innen))) {
      args.push('-annotate', `+60+${sy}`, z); sy += 40;
    }
  }

  args.push('-font', FONT_B, '-pointsize', '31', '-fill', '#95d5b2');
  args.push('-annotate', `+60+${H - 120}`, 'Passenden Beetplan erstellen — kostenlos');
  args.push('-font', FONT, '-pointsize', '25', '-fill', '#74c69d');
  args.push('-annotate', `+60+${H - 40}`, 'staudenplan.de   ·   Illustrationen');

  args.push('-quality', '88', ziel);
  execFileSync('convert', args, { stdio: 'pipe' });
  tmp.forEach(f => { try { fs.unlinkSync(f); } catch {} });
  return ziel;
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  const opt = n => { const i = argv.indexOf('--' + n); return i < 0 ? null : argv[i + 1]; };
  const db = new Database(process.env.DB_PFAD || path.join(WURZEL, 'stauden.db'), { readonly: true });
  const pflanzen = ladePflanzen(db);

  if (opt('ids')) {
    const ids = opt('ids').split(',').map(Number);
    const d = ids.map(id => pflanzen.find(p => p.id === id));
    if (d.some(x => !x)) { console.error('Pflanze fehlt oder hat kein eigenes Bild: ' + ids.join(',')); process.exit(1); }
    const b = bewerte(d);
    if (!b) { console.error('Diese drei passen nach Standort, Blühfolge oder Höhe nicht zusammen.'); process.exit(1); }
    const ziel = argv.find(a => a.endsWith('.jpg')) || `/tmp/pin-kombi-${ids.join('-')}.jpg`;
    kombiPin(b, ziel);
    console.log('erzeugt:', ziel, '·', b.punkte.toFixed(1), 'Punkte');
    process.exit(0);
  }

  const anzahl = Number(opt('liste')) || 20;
  const gefunden = findeKombinationen(pflanzen, { standort: opt('standort'), anzahl });
  if (!gefunden.length) { console.error('keine Kombination gefunden' + (opt('standort') ? ' für ' + opt('standort') : '')); process.exit(1); }

  if (opt('liste')) {
    gefunden.forEach((k, i) => {
      console.log(`${String(i).padStart(2)}  ${k.punkte.toFixed(1)} Pkt  ${k.licht}/${k.feuchte}  ${MON_NAME[k.von-1]}–${MON_NAME[k.bis-1]}${k.kuratiert ? '  [kuratiert bestätigt]' : ''}`);
      console.log('      ' + k.pflanzen.map(p => `${p.name_deutsch} (${p.hoehe_cm_max}cm, ${p.bluehzeit})`).join('  +  '));
      console.log('      --ids ' + k.pflanzen.map(p => p.id).join(','));
    });
    process.exit(0);
  }

  const nr = Number(opt('nr')) || 0;
  const k = gefunden[nr];
  if (!k) { console.error(`nur ${gefunden.length} Kombinationen gefunden`); process.exit(1); }
  const ziel = argv.find(a => a.endsWith('.jpg')) || `/tmp/pin-kombi-${nr}.jpg`;
  kombiPin(k, ziel);
  console.log('erzeugt:', ziel, '·', k.pflanzen.map(p => p.name_deutsch).join(' + '), '·', k.punkte.toFixed(1), 'Punkte');
}

module.exports = { ladePflanzen, bewerte, findeKombinationen, kombiPin, spanne };
