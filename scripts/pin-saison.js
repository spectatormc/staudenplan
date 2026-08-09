/*
 * Erzeugt einen Pinterest-Pin (1000 × 1500) zur Jahreszeit: sechs Pflanzen als Bildraster
 * mit Namen und Giftmarkierung.
 *
 *   node scripts/pin-saison.js                          aktueller Monat
 *   node scripts/pin-saison.js --monat 10 --standort sonne [ziel.jpg]
 *   node scripts/pin-saison.js --monat 12               Winterfassung
 *   node scripts/pin-saison.js --liste                  nur anzeigen
 *
 * WARUM ZWEI FASSUNGEN — und warum das VOR dem Bauen geprüft gehört:
 * Ein reiner „Was blüht jetzt"-Pin fällt vier Monate im Jahr aus. Gezählt über alle
 * Pflanzen mit eigenem Bild und echtem deutschen Namen:
 *
 *   Jan 1   Feb 3   Mär 11   Apr 34   Mai 74   Jun 144
 *   Jul 172 Aug 155 Sep 99   Okt 32   Nov 0    Dez 0
 *
 * November und Dezember haben KEINE blühende Art. Ein Zeitplan, der stur jeden Monat
 * „Was blüht jetzt" postet, läuft im November ins Leere — und zwar unbeaufsichtigt.
 * Deshalb übernimmt von November bis Februar der `winteraspekt`: 131 Pflanzen mit
 * dekorativem Samenstand, Gräserstruktur, immergrünem oder wintergrünem Laub. Das ist
 * gärtnerisch der richtige Inhalt für die Zeit — im Winterbeet zählt Struktur, nicht Blüte.
 *
 * Bewusst KEINE „aktuellen Trends": Ein unbeaufsichtigtes Skript, das auf Trends reagiert
 * und dazu Pflanzenaussagen im Namen der Gartenschmiede veröffentlicht, lässt sich nicht
 * wie eine Webseite per Deploy zurücknehmen. Der Kalender ist die belegbare Fassung
 * derselben Idee: Er wiederholt sich jedes Jahr und braucht keine externe Quelle.
 *
 * Nur selbst erzeugte KI-Bilder (bild_ki = 1), daher „Illustrationen" in der Fußzeile.
 */
const Database = require('better-sqlite3');
const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const { giftigkeit } = require('./pflanzen-giftigkeit');
const L = require('./pin-layout');

const WURZEL = path.join(__dirname, '..');
const { B, H, FONT, FONT_B, GRUEN, MON_NAME } = L;
const KOPF = 240, SPALTE = B / 2, ZEILE = 310, RASTER = 6;

// Winteraspekt-Werte, die tatsächlich etwas hermachen. „unauffällig" (140 Pflanzen) und die
// Prosa-Varianten über Einziehen und Wiederaustrieb gehören nicht dazu — die beschreiben,
// dass im Winter nichts zu sehen ist.
const WINTER_WERT = {
  'samenstand dekorativ': 'Samenstände bleiben stehen',
  'gräser struktur':      'Gräserstruktur im Winter',
  'blätter immergrün':    'immergrünes Laub',
  'rosetten wintergrün':  'wintergrüne Rosetten',
  'blätter halbimmergrün':'halbimmergrünes Laub',
  'struktur':             'Struktur im Winterbeet',
};

function ladePflanzen(db) {
  return db.prepare(`SELECT id, name_deutsch, name_botanisch, farbe, licht, feuchtigkeit, bluehzeit,
                            hoehe_cm_max, winteraspekt, bienen_freundlich, heimisch,
                            lebensbereich, bild_url
                     FROM pflanzen WHERE bild_ki = 1 AND bild_url IS NOT NULL`).all()
           .filter(L.hatDeutschenNamen)
           .filter(L.istBeetpflanze)
           .filter(p => fs.existsSync(path.join(WURZEL, 'public', p.bild_url.replace(/^\//, ''))));
}

/*
 * Stellt die Auswahl für einen Monat zusammen. `versatz` verschiebt die Auswahl, damit
 * derselbe Monat im nächsten Jahr — oder ein zweiter Pin im selben Monat — andere Pflanzen
 * zeigt, ohne dass dafür ein Zufallsgenerator nötig wäre.
 */
function saisonAuswahl(pflanzen, { monat, standort, versatz = 0 } = {}) {
  const winter = monat >= 11 || monat <= 2;

  let kandidaten;
  if (winter) {
    kandidaten = pflanzen
      .map(p => ({ p, aspekt: WINTER_WERT[String(p.winteraspekt || '').trim().toLowerCase()] }))
      .filter(x => x.aspekt)
      .map(x => ({ ...x, zeile2: x.aspekt }));
  } else {
    kandidaten = pflanzen
      .filter(p => L.bluehtIm(p.bluehzeit, monat))
      .map(p => ({ p, zeile2: String(p.bluehzeit).replace(/\s*-\s*/, ' – ') }));
  }
  if (standort) kandidaten = kandidaten.filter(x => L.mengeAus(x.p.licht).has(standort));
  if (kandidaten.length < RASTER) return null;

  // Bewertung: heimisch und bienenfreundlich bevorzugt, im Blühmonat zusätzlich die Arten,
  // die GERADE ERST aufblühen — das ist die Nachricht, nicht „blüht schon seit Juni".
  const bewertet = kandidaten.map(x => {
    let punkte = (x.p.heimisch ? 2 : 0) + (x.p.bienen_freundlich ? 2 : 0);
    if (!winter) {
      const s = L.spanne(x.p.bluehzeit);
      if (s[0] === monat) punkte += 4;                      // beginnt jetzt
      if (s[1] === monat) punkte += 1;                      // letzter Monat
      punkte += Math.min(s[1] - s[0], 4) * 0.3;             // lange Blüher sind nützlich
    }
    return { ...x, punkte };
  }).sort((a, b) => b.punkte - a.punkte || a.p.id - b.p.id);

  // Im Winter hängt die Auswahl an keinem Monat — ohne Verschiebung zeigten November,
  // Dezember, Januar und Februar viermal hintereinander exakt dieselben sechs Pflanzen.
  // Aus dem Monat abgeleitet statt zufällig, damit ein Pin reproduzierbar bleibt.
  const versch = (versatz || (winter ? (monat * 11) % bewertet.length : 0)) % bewertet.length;

  // Sechs auswählen, aber keine Gattung doppelt — sonst stehen sechs Storchschnäbel im Raster.
  // Und höchstens zwei Gräser: Unter „Was im August blüht" standen vier davon. Botanisch
  // richtig, aber wer die Überschrift liest, erwartet Blüten. Im Winterbeet sind Gräser
  // dagegen der Punkt, dort sind drei erlaubt.
  const grasGrenze = winter ? 3 : 2;
  const gewaehlt = [], gattungen = new Set();
  let graeser = 0;
  const reihe = bewertet.slice(versch).concat(bewertet.slice(0, versch));
  for (const durchgang of [0, 1]) {                    // zweiter Durchgang hebt die Grenze auf
    for (const x of reihe) {
      if (gewaehlt.length === RASTER) break;
      if (gewaehlt.includes(x)) continue;
      const gattung = x.p.name_botanisch.split(' ')[0];
      if (gattungen.has(gattung)) continue;
      const gras = L.istGras(x.p);
      if (!durchgang && gras && graeser >= grasGrenze) continue;
      if (gras) graeser++;
      gattungen.add(gattung); gewaehlt.push(x);
    }
    if (gewaehlt.length === RASTER) break;             // sonst lieber Gräser als ein leeres Feld
  }
  if (gewaehlt.length < RASTER) return null;

  return { monat, winter, standort, auswahl: gewaehlt };
}

function saisonPin(s, ziel) {
  const tmp = [];
  const args = ['-size', `${B}x${H}`, `xc:${GRUEN}`, '-gravity', 'northwest'];
  const innen = B - 120;

  const titel = s.winter ? 'Struktur im Winterbeet' : `Was im ${MON_NAME[s.monat - 1]} blüht`;
  const titelGr = L.passendeGroesse(titel, FONT_B, 58, 38, innen);
  args.push('-font', FONT_B, '-pointsize', String(titelGr), '-fill', 'white');
  args.push('-annotate', `+60+68`, titel);

  const ort = s.standort ? ({ sonne:'für die Sonne', halbschatten:'für den Halbschatten', schatten:'für den Schatten' })[s.standort] : 'für Beet und Rabatte';
  // „…nach der Blüte…" statt „…ohne Blüte…": Die Bilder zeigen die Pflanzen blühend, denn
  // andere gibt es nicht. Unter der Überschrift „Struktur im Winterbeet" sahen sechs
  // Sommerfotos nach Versehen aus. So beschreibt der Untertitel, was die Pflanze DANACH
  // tut — und das Bild zeigt genau die Pflanze, um die es geht.
  const unter = s.winter ? '6 Stauden, die nach der Blüte Struktur halten' : `6 Stauden ${ort}`;
  args.push('-font', FONT, '-pointsize', String(L.passendeGroesse(unter, FONT, 32, 22, innen)), '-fill', '#95d5b2');
  args.push('-annotate', `+60+${68 + titelGr + 22}`, unter);

  // Bildraster, zwei Spalten. Die Namen liegen als Leiste auf dem Bild statt darunter —
  // so bleibt bei sechs Pflanzen genug Platz für die Bilder selbst.
  s.auswahl.forEach((x, i) => {
    const sx = (i % 2) * SPALTE, sy = KOPF + Math.floor(i / 2) * ZEILE;
    const quelle = path.join(WURZEL, 'public', x.p.bild_url.replace(/^\//, ''));
    const datei = `/tmp/pin-saison-${x.p.id}-${i}.png`;
    execFileSync('convert', [quelle, '-resize', `${SPALTE}x${ZEILE}^`, '-gravity', 'center',
                             '-extent', `${SPALTE}x${ZEILE}`, datei], { stdio: 'pipe' });
    tmp.push(datei);
    args.push('-draw', `image over ${sx},${sy} 0,0 "${datei}"`);
  });

  s.auswahl.forEach((x, i) => {
    const sx = (i % 2) * SPALTE, sy = KOPF + Math.floor(i / 2) * ZEILE;
    const leiste = sy + ZEILE - 84;
    args.push('-fill', 'rgba(27,67,50,0.86)', '-draw', `rectangle ${sx},${leiste} ${sx + SPALTE},${sy + ZEILE}`);

    const name = x.p.name_deutsch;
    args.push('-font', FONT_B, '-pointsize', String(L.passendeGroesse(name, FONT_B, 27, 17, SPALTE - 36)), '-fill', 'white');
    args.push('-annotate', `+${sx + 18}+${leiste + 12}`, name);
    const zwei = `${x.zeile2}   ·   ${x.p.hoehe_cm_max} cm`;
    args.push('-font', FONT, '-pointsize', String(L.passendeGroesse(zwei, FONT, 22, 15, SPALTE - 36)), '-fill', '#95d5b2');
    args.push('-annotate', `+${sx + 18}+${leiste + 48}`, zwei);

    // Giftmarkierung direkt auf der betroffenen Kachel. In einem Raster aus sechs Pflanzen
    // wäre eine Sammelwarnung am Fuß nicht zuzuordnen — man wüsste nicht, welche gemeint ist.
    const g = giftigkeit(x.p.name_botanisch);
    if (g) {
      const stark = g.stufe === 'stark';
      const text = L.GIFT_LABEL[g.stufe] || 'Giftig';
      const br = L.textBreite(text, FONT_B, 20) + 24;
      args.push('-fill', stark ? 'rgba(178,58,58,0.94)' : 'rgba(217,164,65,0.94)');
      args.push('-draw', `roundrectangle ${sx + 14},${sy + 14} ${sx + 14 + br},${sy + 48} 6,6`);
      args.push('-font', FONT_B, '-pointsize', '20', '-fill', stark ? 'white' : '#3d2c00');
      args.push('-annotate', `+${sx + 26}+${sy + 21}`, text);
    }
  });

  let y = KOPF + 3 * ZEILE + 34;

  // Ein Satz, der die Auswahl einordnet. Im Winter ist der Pflegehinweis der eigentliche
  // Nutzen — wer die Samenstände im Herbst abschneidet, hat den ganzen Effekt nicht.
  const hinweis = s.winter
    ? 'Samenstände und Gräser erst im Frühjahr zurückschneiden: Sie halten den Winter über Struktur und bieten Insekten Quartier.'
    : `Alle sechs blühen im ${MON_NAME[s.monat - 1]} — Höhe und Standort stehen dabei, damit sie sich einplanen lassen.`;
  args.push('-font', FONT, '-pointsize', '27', '-fill', '#b7e4c7');
  for (const z of L.umbrechenBreit(hinweis, FONT, 27, innen)) { args.push('-annotate', `+60+${y}`, z); y += 38; }

  args.push('-font', FONT_B, '-pointsize', '31', '-fill', '#95d5b2');
  args.push('-annotate', `+60+${H - 120}`, 'Eigenen Beetplan erstellen — kostenlos');
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

  if (argv.includes('--liste')) {
    for (let m = 1; m <= 12; m++) {
      const s = saisonAuswahl(pflanzen, { monat: m });
      console.log(String(MON_NAME[m - 1]).padEnd(10) + (s
        ? (s.winter ? '[Winter]  ' : '[Blüte]   ') + s.auswahl.map(x => x.p.name_deutsch).join(', ')
        : 'ZU WENIGE KANDIDATEN'));
    }
    process.exit(0);
  }

  const monat = Number(opt('monat')) || (new Date().getMonth() + 1);
  const s = saisonAuswahl(pflanzen, { monat, standort: opt('standort'), versatz: Number(opt('versatz')) || 0 });
  if (!s) {
    console.error(`zu wenige Kandidaten für ${MON_NAME[monat - 1]}${opt('standort') ? ' / ' + opt('standort') : ''}`);
    process.exit(1);
  }
  const ziel = argv.find(a => a.endsWith('.jpg')) || `/tmp/pin-saison-${monat}${opt('standort') ? '-' + opt('standort') : ''}.jpg`;
  saisonPin(s, ziel);
  console.log('erzeugt:', ziel, '·', s.winter ? 'Winterfassung' : 'Blühfassung', '·', s.auswahl.map(x => x.p.name_deutsch).join(', '));
}

module.exports = { ladePflanzen, saisonAuswahl, saisonPin };
