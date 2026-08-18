/*
 * Geteilte Bausteine der Pin-Erzeugung: Maße, Schriften, Monatsrechnung, Textumbruch.
 *
 * Herausgezogen, nachdem `umbrechen` in der dritten Datei stand und die Schätzung der
 * Textbreite zweimal zu abgeschnittenen Überschriften geführt hat. Wer hier etwas ändert,
 * ändert es für alle Pin-Sorten — das ist der Zweck.
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

/*
 * Werkzeug und Schriften werden GESUCHT, nicht angenommen.
 *
 * Der Server läuft auf ImageMagick 6, wo das Programm "convert" heißt. In Version 7 heißt es
 * "magick"; die Debian-Pakete für 7 legen "convert" nicht mehr an. Ein einziges apt upgrade
 * hätte damit alle fünf Pin-Sorten und die Ratgeber-Vorschaubilder gleichzeitig stillgelegt —
 * und zwar in einem Stapellauf, wo es niemandem sofort auffällt. Dasselbe gilt für die
 * Schriftpfade: /usr/share/fonts/truetype/dejavu ist Debian-Konvention, kein Standard.
 *
 * Beim Import wird BEWUSST NICHT geworfen, nur gewarnt: pin-text.js lädt dieses Modul auch
 * für die reine Textvorschau, die weder ImageMagick noch Schriften braucht. Ein harter Abbruch
 * hier würde die Vorschau auf jedem Rechner ohne ImageMagick unbenutzbar machen. Fehlt das
 * Werkzeug wirklich, scheitert der Aufruf später — dann aber mit dieser Warnung davor.
 */
function findeWerkzeug() {
  if (process.env.PIN_MAGICK) return process.env.PIN_MAGICK;
  for (const kandidat of ['magick', 'convert']) {          // 7 vor 6: magick ist die Zukunft
    try { execFileSync(kandidat, ['-version'], { stdio: 'ignore' }); return kandidat; } catch { /* weiter */ }
  }
  console.warn('WARNUNG: Weder "magick" noch "convert" aufrufbar — ImageMagick fehlt. '
    + 'Bildbefehle werden scheitern. Pfad notfalls über PIN_MAGICK vorgeben.');
  return 'convert';
}

const SCHRIFT_ORDNER = [
  '/usr/share/fonts/truetype/dejavu',   // Debian, Ubuntu
  '/usr/share/fonts/dejavu',            // Fedora, RHEL
  '/usr/share/fonts/TTF',               // Arch
  '/usr/local/share/fonts/dejavu',
  '/opt/homebrew/share/fonts',
];
function findeSchrift(umgebungsname, ...dateinamen) {
  if (process.env[umgebungsname]) return process.env[umgebungsname];
  for (const ordner of SCHRIFT_ORDNER) {
    for (const name of dateinamen) {
      const p = path.join(ordner, name);
      try { if (fs.existsSync(p)) return p; } catch { /* weiter */ }
    }
  }
  console.warn(`WARNUNG: Schrift ${dateinamen[0]} in keinem bekannten Ordner gefunden. `
    + `Notfalls über ${umgebungsname} einen Pfad vorgeben.`);
  return path.join(SCHRIFT_ORDNER[0], dateinamen[0]);   // Debian-Pfad als letzte Annahme
}

const MAGICK = findeWerkzeug();

const B = 1000, H = 1500;                       // Pinterest: hochkant 2:3
const FONT = findeSchrift('PIN_FONT', 'DejaVuSans.ttf');
const FONT_B = findeSchrift('PIN_FONT_BOLD', 'DejaVuSans-Bold.ttf');
const GRUEN = '#1b4332';

const MONATE = { Januar:1, Februar:2, 'März':3, April:4, Mai:5, Juni:6,
                 Juli:7, August:8, September:9, Oktober:10, November:11, Dezember:12 };
const MON_KURZ = ['J','F','M','A','M','J','J','A','S','O','N','D'];
const MON_NAME = ['Januar','Februar','März','April','Mai','Juni','Juli','August','September','Oktober','November','Dezember'];

// Blütenfarbe als Balken- und Punktfarbe. Ohne Zuordnung wäre alles dreimal dasselbe Grün.
const FARBTON = {
  'weiß':'#f8f9fa', 'gelb':'#ffd166', 'rosa':'#f4a3c0', 'grün':'#74c69d', 'blau':'#6ba3d6',
  'rot':'#e5544b', 'lila':'#b18ad4', 'violett':'#a17ac9', 'orange':'#f79154', 'purpur':'#c264a0',
  'braun':'#b08968', 'silbrig':'#ced4da', 'beige':'#e6d9b8', 'rotbraun':'#a9564b',
  'silbrig-grün':'#c2d5c0', 'dunkelviolett':'#8b6bb1', 'karamell':'#d49a5c',
  'blauviolett':'#8a8ad0', 'schwarz':'#6c757d', 'lachs':'#f0917c', 'dunkelrot':'#b23a3a',
  'burgunderrot':'#9d3b52', 'lavendel':'#c3b1e1', 'silber':'#dee2e6',
};

const GIFT_LABEL = { stark:'Stark giftig', giftig:'Giftig', katzen:'Für Katzen lebensgefährlich',
                     haustiere:'Für Haustiere giftig', reizend:'Hautreizend' };
const GIFT_RANG = { stark:0, giftig:1, katzen:2, haustiere:3, reizend:4 };

/* Blühzeit „Juli - September" → [7, 9]; null, wenn nicht lesbar („keine Blüte"). */
function spanne(bluehzeit) {
  const t = String(bluehzeit || '').split(/\s*(?:–|—|-|bis)\s*/).map(s => s.trim());
  const a = MONATE[t[0]], e = MONATE[t[1]] || MONATE[t[0]];
  return (a && e && e >= a) ? [a, e] : null;
}

const bluehtIm = (bluehzeit, monat) => { const s = spanne(bluehzeit); return !!s && s[0] <= monat && monat <= s[1]; };
const farbeVon = p => String(p.farbe || '').split(/[|,]/)[0].trim().toLowerCase();
const mengeAus = s => new Set(String(s || '').split('|').map(x => x.trim().toLowerCase()).filter(Boolean));
const schnitt = (a, b) => [...mengeAus(a)].filter(x => mengeAus(b).has(x));

/*
 * Neun Arten tragen als deutschen Namen nur ihre Gattung („Muhlenbergia"). Auf einem Pin
 * liest sich das als „Muhlenbergia · Muhlenbergia capillaris". Sie werden ausgelassen;
 * einen deutschen Namen zu erfinden wäre schlimmer, als sie wegzulassen. Sobald die Namen
 * gepflegt sind, fallen sie von selbst wieder herein.
 */
function hatDeutschenNamen(p) {
  const d = String(p.name_deutsch || '').trim().toLowerCase();
  const b = String(p.name_botanisch || '').toLowerCase();
  return !!d && d !== b.split(' ')[0] && d !== b;
}

/*
 * Echte Wasserpflanzen aussortieren. Sie stehen völlig zu Recht in der Datenbank, aber ein
 * Pin mit der Überschrift „6 Stauden für Beet und Rabatte" hatte im Juni die Weiße Seerose
 * und die Seekanne im Raster — die wachsen in der Wasserfläche, nicht im Beet.
 *
 * Zwei Merkmale, weil eines nicht reicht: Der Lebensbereich „Wasserfläche" fängt Seerose,
 * Froschbiss und Wasserlinse; „nass" fängt zusätzlich die Flachwasserarten wie das
 * Pfeilkraut, die nur als „Quellflur" geführt sind. Betrifft 14 der 299 Arten mit eigenem
 * Bild. Feuchte Beetränder („feucht") bleiben ausdrücklich drin.
 */
const istBeetpflanze = p => !/wasserfläche/i.test(String(p.lebensbereich || ''))
                         && !mengeAus(p.feuchtigkeit).has('nass');

/*
 * Was ein Pin zeigen darf: winterhart in Deutschland und mehrjährig.
 *
 * Bis zum 09.08.2026 stand hier eine hartcodierte Liste von fünf Arten, weil das Feld
 * `winterhart_zone` unbrauchbar war — 223 von 299 Pflanzen mit Bild standen auf exakt
 * Zone 5, keine über Zone 7, und Salvia elegans aus Mexiko trug dieselbe Zone 6 wie der
 * heimische Buschklee. Seit der Datenkorrektur stimmen die Felder, und die Regel liest
 * sie, statt sie zu umgehen. Dieselbe Bedingung wie PLANBAR in stauden-server.js.
 */
const istWinterhartHier = p => (p.winterhart_zone == null || p.winterhart_zone <= 7)
                            && (p.lebensdauer == null || p.lebensdauer !== 'einjaehrig');

/*
 * Gräser, Seggen und Binsen erkennen. Nötig, weil sie unter „Was im August blüht" zwar
 * korrekt, aber irreführend sind: Vier Gräser in einem Sechserraster sehen aus, als hätte
 * die Auswahl versagt — wer die Überschrift liest, erwartet Blüten. Im Winterbeet sind sie
 * dagegen genau der Punkt, dort gilt eine höhere Grenze.
 *
 * Zwei Wege, weil keiner allein reicht: Der deutsche Name erkennt 39 der 42 Gräser in der
 * Datenbank, die Gattungsliste holt Riesenschwingel, Riesen-Chinaschilf und Muhlenbergia
 * nach. Die Liste enthält auch Gattungen, die noch nicht vorkommen — dann greift sie eben
 * später.
 */
const GRAS_GATTUNG = new Set(['Achnatherum','Andropogon','Anemanthele','Arrhenatherum','Bouteloua',
  'Briza','Bromus','Calamagrostis','Carex','Chasmanthium','Cortaderia','Deschampsia','Elymus',
  'Eragrostis','Festuca','Glyceria','Hakonechloa','Helictotrichon','Imperata','Juncus','Koeleria',
  'Luzula','Melica','Melinis','Milium','Miscanthus','Molinia','Muhlenbergia','Nassella','Panicum',
  'Pennisetum','Phalaris','Phragmites','Poa','Schizachyrium','Schoenoplectus','Scirpus','Sesleria',
  'Sorghastrum','Spartina','Spodiopogon','Sporobolus','Stipa','Typha']);
const GRAS_WORT = /gras|schmiele|hirse|segge|binse|quecke|trespe|rohrkolben|lampenputzer|schwaden|zwenke|riedgras|marbel|simse|hafer|schilf|schwingel/i;
// „Gras" im deutschen Namen heißt nicht Gras: Die Grasnelke ist ein Bleiwurzgewächs, das
// Blauäugige Gras ein Schwertliliengewächs. Beide blühen und sind Bienenweiden — sie über
// den Namen zu Gräsern zu erklären, wäre genau der Fehler, den diese Prüfung finden soll.
const KEIN_GRAS = new Set(['Armeria', 'Sisyrinchium']);
const istGras = p => {
  const gattung = String(p.name_botanisch || '').split(' ')[0];
  if (KEIN_GRAS.has(gattung)) return false;
  return GRAS_GATTUNG.has(gattung) || GRAS_WORT.test(String(p.name_deutsch || ''));
};

/*
 * Textbreite bei ImageMagick erfragen statt aus der Zeichenzahl schätzen. Eine geschätzte
 * Breite hat den Titel schon rechts aus dem Bild laufen lassen — Monatsnamen und
 * Pflanzennamen sind zu unterschiedlich lang für eine Faustregel.
 */
function textBreite(text, font, size) {
  const out = execFileSync(MAGICK, ['-font', font, '-pointsize', String(size),
                                       `label:${text}`, '-format', '%w', 'info:'], { encoding: 'utf8' });
  return Number(String(out).trim()) || 0;
}

/* Größte Schriftgröße, bei der der Text noch in die Breite passt. */
function passendeGroesse(text, font, start, min, maxBreite) {
  let s = start;
  while (s > min && textBreite(text, font, s) > maxBreite) s -= 2;
  return s;
}

/* Zeichen pro Zeile aus einer echten Messung ableiten (ein Aufruf statt einer je Wort). */
function zeichenProZeile(text, font, size, maxBreite) {
  const b = textBreite(text, font, size);
  return b ? Math.max(8, Math.floor(String(text).length * maxBreite / b)) : 40;
}

function umbrechen(text, max) {
  const worte = String(text).split(/\s+/); const zeilen = []; let z = '';
  for (const w of worte) {
    if ((z + ' ' + w).trim().length > max) { if (z) zeilen.push(z.trim()); z = w; } else z = (z + ' ' + w).trim();
  }
  if (z) zeilen.push(z); return zeilen;
}

/* Umbruch mit gemessener statt geratener Breite. */
function umbrechenBreit(text, font, size, maxBreite) {
  return umbrechen(text, zeichenProZeile(text, font, size, maxBreite));
}

module.exports = { B, H, MAGICK, FONT, FONT_B, GRUEN, MONATE, MON_KURZ, MON_NAME, FARBTON,
                   GIFT_LABEL, GIFT_RANG, spanne, bluehtIm, farbeVon, mengeAus, schnitt,
                   hatDeutschenNamen, istBeetpflanze, istGras, istWinterhartHier, textBreite, passendeGroesse,
                   zeichenProZeile, umbrechen, umbrechenBreit };
