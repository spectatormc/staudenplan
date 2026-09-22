/*
 * Erzeugt aus einer Pflanze der Datenbank ein fertiges Pinterest-Bild (1000 × 1500).
 *
 *   node scripts/pin-bild.js <id|botanischer Name> [zielpfad.jpg] [--winter]
 *
 * ZWEI FASSUNGEN DESSELBEN BILDES (--winter seit 21.09.2026): Die Blühfassung nennt in der
 * Faktenzeile die Blühzeit, die Winterfassung stattdessen den Winteraspekt („Samenstände
 * bleiben stehen") und trägt darüber die Zeile WINTERBEET. Der Grund steht in pin-text.js:
 * Die Einzelpflanzen-Pins bringen die Klicks und schweigen von November bis Februar.
 *
 * SEIT DEM 22.09.2026 ZEIGT DIE WINTERFASSUNG AUCH EIN ANDERES BILD — wenn es eines gibt.
 * Bis dahin unterschieden sich die beiden Pins nur im Text: Das Bild zeigte in beiden Fällen
 * die Pflanze in BLÜTE, während der Winterpin von Samenständen und Gräserstruktur sprach.
 * Die Spalte bild_winter_url trägt jetzt ein eigenes, im Ruhezustand erzeugtes Bild
 * (scripts/winterbilder-erzeugen.js); welches der beiden benutzt wird, entscheidet
 * winterBildQuelle() in scripts/winterbild-auftrag.js — die Blühfassung fasst es nie an.
 * Solange eine Pflanze kein Winterbild hat, bleibt es beim Blühbild, also beim Stand von
 * vorher. Dass sich die beiden Pins auch ohne Winterbild sichtbar unterscheiden, bleibt
 * deshalb wichtig (Zeile WINTERBEET, andere Faktenzeile): zwei fast gleiche Bilder wertet
 * Pinterest als Dublette.
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
const L = require('./pin-layout');
// Die Beschriftung des Winteraspekts kommt aus pin-saison.js (WINTER_WERT) — dieselbe Zeile,
// die im Sechser-Raster unter der Kachel und auf der Landeseite steht. Keine zweite Liste.
const saison = require('./pin-saison');
// Welche Bilddatei die Winterfassung benutzt, entscheidet winterBildQuelle() — dieselbe
// Stelle, die auch den Bildauftrag und den Dateinamen der Winterbilder führt.
const WA = require('./winterbild-auftrag');
// Werkzeug und Schriften kommen aus dem geteilten Modul, damit ein Wechsel von
// ImageMagick 6 auf 7 nur an EINER Stelle nachgezogen werden muss.
const { MAGICK, FONT, FONT_B } = L;

const WURZEL = path.join(__dirname, '..');
const db = new Database(process.env.DB_PFAD || path.join(WURZEL, 'stauden.db'), { readonly: true });

const B = 1000, H = 1500, BILD_H = 1000;      // Bildfläche oben, Textfläche unten
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

/*
 * Die erste Angabe der Faktenzeile.
 *
 * Blühfassung: die Blühzeit — ABER NUR, WENN SIE SICH LESEN LÄSST. Bis zum 21.09.2026 stand
 * hier `p.bluehzeit` ungeprüft. Im Bild von 25 Pflanzen des Pin-Pools stand dadurch „kein
 * Blüteschmuck", „keine" oder „N/A" als Tatsache neben Höhe und Standort, während der Pin-Text
 * zu derselben Pflanze die Blühzeit stillschweigend weglässt (pin-text.js prüft L.spanne).
 * Bild und Text sagten also Verschiedenes, und „N/A" sagt gar nichts. Jetzt entscheidet
 * dieselbe Prüfung beide Wege: Was sich nicht in Monate zerlegen lässt, steht auch nicht im
 * Bild. Die Zeile wird dann kürzer, nicht falsch.
 *
 * Winterfassung: der Winteraspekt. Fehlt er, wird geworfen statt gedruckt — ein Winter-Pin
 * ohne Winteraspekt hätte nichts zu sagen, was er nicht schon als Blühfassung sagt.
 */
function ersteFakt(p, winter) {
  if (!winter) return L.spanne(p.bluehzeit) ? p.bluehzeit : null;
  const aspekt = saison.winterAspekt(p);
  if (!aspekt) throw new Error('Kein Winteraspekt aus der Werteliste (WINTER_WERT): '
    + `${p.name_botanisch} — winteraspekt="${p.winteraspekt || ''}"`);
  return aspekt;
}

/*
 * BEIDE EINZELPFLANZEN-SORTEN LAUFEN HIER DURCH: 'pflanze' und 'pflanze-winter' (Schalter
 * 'winter'). Sie zeigen DIESELBE PFLANZE, seit dem 22.09.2026 aber nicht mehr zwingend
 * dieselbe Datei: Die Winterfassung nimmt bild_winter_url, wenn es eines gibt.
 *
 * FUER DEN BILDKOMMENTAR AENDERT DAS NICHTS, und das ist der Punkt: Er haelt fest, WELCHE
 * PFLANZEN auf dem Bild zu sehen sind, nicht welche Datei benutzt wurde. Auf dem Winterbild
 * ist dieselbe eine Pflanze zu sehen wie auf dem Bluehbild, also steht dort dieselbe eine ID.
 * scripts/check-pin-deckung.js haelt diese ID gegen die Pflanzennamen der Beschreibung — die
 * Rechnung geht damit unveraendert auf. Nachgerechnet und nicht nur angenommen: Die ID kommt
 * aus p.id (unten, beim Zeichnen eingesammelt), der Name in der Beschreibung aus
 * p.name_deutsch (pin-text.js, textPflanzeWinter) — beides aus derselben Zeile, unabhaengig
 * davon, welche Bilddatei in die Bildflaeche gelaufen ist.
 *
 * Auseinander haelt die beiden Pins die 'guid', die der Stapellauf hereinreicht
 * (pflanze-<slug> bzw. pflanze-winter-<slug>).
 *
 * 'guid' wird hereingereicht und nicht hier gebildet: Die Kennung entsteht in
 * pins-erzeugen.js, ein Nachbau waere eine zweite Fassung derselben Regel. Ohne sie traegt
 * das Bild nur die ID; die Pruefung kommt damit aus (guid ist dort optional) und kann dann
 * nur keine vertauschte Datei erkennen. Aufbau: bildKommentarArgs() in pin-layout.js.
 */
function pinBild(p, ziel, { winter = false, guid = null } = {}) {
  /* Die Bildwahl. In der Blühfassung ist es immer bild_url — die Spalte bild_winter_url wird
   * dort nicht einmal gelesen, denn das Bild der Pflanzenseite ändert sich durch sie nicht.
   * In der Winterfassung antwortet winterBildQuelle(): das Winterbild, sonst bild_url.
   * Der Rückfall ist dort AUSDRÜCKLICH und nicht still — fehlt die Spalte in der Abfrage,
   * wirft die Funktion, statt jede Pflanze wie eine ohne Winterbild aussehen zu lassen. */
  const bild = winter ? WA.winterBildQuelle(p) : { url: p.bild_url, eigen: false };
  if (!bild.url) throw new Error('Kein Bildpfad hinterlegt: ' + p.name_botanisch);
  const quelle = path.join(WURZEL, 'public', String(bild.url).replace(/^\//, ''));
  if (!fs.existsSync(quelle)) throw new Error('Bilddatei fehlt: ' + quelle);

  const gift = giftigkeit(p.name_botanisch);
  const hoehe = p.hoehe_cm_min && p.hoehe_cm_max ? `${p.hoehe_cm_min}–${p.hoehe_cm_max} cm` : null;
  const fakten = [ersteFakt(p, winter), hoehe, (p.licht || '').split('|')[0]].filter(Boolean);

  const nameZeilen = umbrechen(p.name_deutsch, 24);
  const args = [
    // Bild oben: quadratisch füllen und mittig beschneiden
    quelle, '-resize', `${B}x${BILD_H}^`, '-gravity', 'center', '-extent', `${B}x${BILD_H}`,
    // Textfläche unten anfügen
    '(', '-size', `${B}x${H - BILD_H}`, `xc:${GRUEN}`, ')', '-append',
    '-gravity', 'northwest',
  ];

  let y = BILD_H + 46;

  // Die Winterfassung sagt oben, worum es geht. Ohne diese Zeile unterschieden sich die beiden
  // Pins derselben Pflanze nur in einer einzigen Textzeile weit unten — für Pinterest zwei
  // fast gleiche Bilder, für den Betrachter ein Rätsel.
  if (winter) {
    args.push('-font', FONT_B, '-pointsize', '28', '-fill', '#74c69d');
    args.push('-annotate', `+60+${y}`, 'WINTERBEET');
    y += 44;
  }

  args.push('-font', FONT_B, '-pointsize', nameZeilen.length > 1 ? '58' : '66', '-fill', 'white');
  for (const z of nameZeilen) { args.push('-annotate', `+60+${y}`, z); y += nameZeilen.length > 1 ? 66 : 74; }

  args.push('-font', FONT, '-pointsize', '34', '-fill', '#95d5b2');
  args.push('-annotate', `+60+${y + 6}`, p.name_botanisch);
  y += 62;

  if (fakten.length) {
    // Gemessene statt fester Schriftgröße: „Samenstände bleiben stehen   ·   80 cm   ·
    // halbschatten" ist deutlich länger als „Juli - September   ·   80 cm   ·   sonne" und
    // liefe bei festen 31 pt rechts aus dem Bild. passendeGroesse() verkleinert nur, wenn es
    // nötig ist — kurze Zeilen bleiben bei 31 pt und damit unverändert.
    const zeile = fakten.join('   ·   ');
    args.push('-font', FONT, '-pointsize', String(L.passendeGroesse(zeile, FONT, 31, 22, B - 120)), '-fill', '#d8f3dc');
    args.push('-annotate', `+60+${y + 14}`, zeile);
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

  /* Die ID der einen Pflanze in die Datei selbst — es ist die, deren Bilddatei oben als
   * 'quelle' oben in die Bildflaeche gelaufen ist. Wozu: bildKommentarArgs() in
   * pin-layout.js. */
  args.push(...L.bildKommentarArgs({ guid, ids: [p.id] }));

  args.push('-quality', '88', ziel);
  execFileSync(MAGICK, args, { stdio: 'pipe' });
  return ziel;
}

if (require.main === module) {
  const arg = process.argv[2];
  if (!arg) { console.error('Aufruf: node scripts/pin-bild.js <id|botanischer Name> [ziel.jpg] [--winter] [--trotzdem]'); process.exit(1); }
  const trotzdem = process.argv.includes('--trotzdem');
  const p = /^\d+$/.test(arg)
    ? db.prepare('SELECT * FROM pflanzen WHERE id = ?').get(Number(arg))
    : db.prepare('SELECT * FROM pflanzen WHERE name_botanisch = ?').get(arg);
  if (!p) { console.error('Pflanze nicht gefunden: ' + arg); process.exit(1); }
  if (!p.bild_ki) { console.error('Kein selbst erzeugtes Bild — für Pinterest nicht verwendbar: ' + p.name_botanisch); process.exit(1); }
  if (!p.bild_url) { console.error('bild_ki gesetzt, aber kein Bildpfad hinterlegt: ' + p.name_botanisch); process.exit(1); }

  /* Dieselbe Auswahlkette wie in pin-saison.js und pin-kombination.js. Sie fehlte hier als
   * einziger der vier Pin-Sorten: pin-bild.js prüfte nur, ob ein eigenes Bild da ist, und
   * erzeugte auf Zuruf einen Pin für den Ananas-Salbei (Zone 9) — unter einem Absender, der
   * an sieben Stellen winterharte Stauden zusagt. Weil dieses Skript im Gegensatz zu den
   * anderen mit einer benannten Pflanze aufgerufen wird, ist der Verstoß hier keine
   * Auswahlpanne, sondern eine bewusste Eingabe: Deshalb nennt die Meldung den Grund und
   * --trotzdem lässt ihn zu. Im unbeaufsichtigten Betrieb wird der Schalter nie gesetzt. */
  const gruende = [];
  if (!L.hatDeutschenNamen(p)) gruende.push('kein eigener deutscher Name, nur die Gattung');
  if (!L.istBeetpflanze(p))    gruende.push('keine Beetstaude (Wasser-, Kübel- oder Sonderfall)');
  if (!L.istWinterhartHier(p)) gruende.push(`hier nicht winterhart (Zone ${p.winterhart_zone})`);
  if (gruende.length) {
    console.error('Für einen Pin nicht geeignet: ' + p.name_botanisch);
    for (const g of gruende) console.error('  · ' + g);
    if (!trotzdem) { console.error('  (mit --trotzdem trotzdem erzeugen)'); process.exit(1); }
    console.error('  --trotzdem gesetzt, wird erzeugt.');
  }

  const winter = process.argv.includes('--winter');
  const ziel = process.argv[3] && !process.argv[3].startsWith('--') ? process.argv[3]
             : `/tmp/pin-${winter ? 'winter-' : ''}${p.id}.jpg`;
  pinBild(p, ziel, { winter });
  /* Welche Bilddatei benutzt wurde, steht in der Meldung — sonst sieht ein Winter-Pin mit
   * Bluehbild genauso aus wie einer mit Winterbild, und der Rueckfall bliebe unbemerkt. */
  const bild = winter ? WA.winterBildQuelle(p) : { url: p.bild_url, eigen: false };
  console.log('erzeugt:', ziel, winter
    ? `· Winterfassung: ${saison.winterAspekt(p)} · Bild: ${bild.url}${bild.eigen ? ' (eigenes Winterbild)' : ' (Bluehbild — noch kein Winterbild erzeugt)'}`
    : '');
}

module.exports = { pinBild, ersteFakt, umbrechen };
