/*
 * Maschinenlesbare KI-Kennzeichnung in einer fertigen JPEG-Datei.
 *
 *   node scripts/pin-ki-metadaten.js public/pins/*.jpg              nur lesen
 *   node scripts/pin-ki-metadaten.js --schreiben datei.jpg          Kennzeichnung eintragen
 *   node scripts/pin-ki-metadaten.js --schreiben --trotzdem d.jpg   auch bei fremder Sorte
 *
 * GESCHRIEBEN WIRD NUR IN DIE SORTEN MIT KI-BILD. Welche das sind, steht als KI_PIN_SORTEN in
 * pin-layout.js; die Sorte selbst steht im Dateinamen (sorteAus() in pin-sorten.js). Gelesen
 * werden darf jede Datei, auch als Glob — geschrieben nicht.
 *
 * WAS GESCHRIEBEN WIRD: ein XMP-Paket mit dem IPTC-Feld DigitalSourceType und dem Wert
 * http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia. Das ist das Feld,
 * das Pinterest, Meta und Google auslesen, um ein Bild selbsttätig als KI-erzeugt zu
 * kennzeichnen. Der Satz "Bild: KI-erzeugte Illustration." in der Pin-Beschreibung
 * (pin-text.js) sagt dasselbe, aber nur an Menschen — dieses Feld sagt es an Maschinen.
 * Beide stammen aus derselben Liste KI_PIN_SORTEN in pin-layout.js, damit sie nicht
 * auseinanderlaufen können.
 *
 * WARUM NICHT MIT IMAGEMAGICK: Auf dem Server existiert nur /usr/bin/convert
 * (ImageMagick 6); exiftool, magick und c2patool fehlen, und dieser Kanal soll keine
 * Installation voraussetzen. convert könnte ein XMP-Profil zwar anhängen, würde die Datei
 * dabei aber ein zweites Mal JPEG-kodieren. Das kostet Qualität, und zwar bei jedem Lauf
 * erneut, weil die Kennzeichnung ausdrücklich auch über schon liegende Dateien läuft
 * (siehe bauen() in pins-erzeugen.js). Ein APP1-Segment in die fertige Datei einzufügen
 * lässt die Bilddaten Byte für Byte unangetastet.
 *
 * WAS AUSDRÜCKLICH NICHT PASSIERT: Es wird nichts entfernt. 278 der Einzelpflanzen-Pins
 * tragen ein von der OpenAI-Quelldatei geerbtes APP11/JUMBF-Segment mit C2PA-Manifest. Als
 * Signatur ist es tot — der Hash gilt für die Originalbytes, nach Skalieren und Beschriften
 * meldet ein Prüfer dataHash.mismatch. Es bleibt trotzdem stehen: Provenienzdaten
 * herauszuschneiden ist das Vorgehen von KI-Label-Entfernern, nicht unseres. Umgekehrt wird
 * es auch auf kein fremdes Bild übertragen — eingefügt wird nur das eigene XMP-Paket.
 */
const fs = require('fs');

// Namensraum-Kopf des XMP-Segments. Genau diese 29 Byte (28 Zeichen und ein Nullbyte) erwarten
// die Leser hinter der Segmentlänge; ohne sie ist das APP1 für sie ein Exif-Segment mit Müll.
const XMP_KOPF = Buffer.from('http://ns.adobe.com/xap/1.0/\0', 'latin1');
const EXIF_KOPF = Buffer.from('Exif\0\0', 'latin1');

const IPTC_NS = 'http://iptc.org/std/Iptc4xmpExt/2008-02-29/';
const KI_QUELLE = 'http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia';
const WERKZEUG = 'staudenplan.de/pin-ki-metadaten';

/*
 * Das Paket ist bewusst winzig: ein Feld, ein Namensraum, keine Polsterung. end="r" statt
 * end="w" heißt „nicht im Platz änderbar" und ist hier die Wahrheit — wir hängen keine
 * Leerbytes an, in die ein anderes Werkzeug hineinschreiben könnte.
 */
function xmpPaket() {
  return '<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>\n'
       + `<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="${WERKZEUG}">\n`
       + ' <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">\n'
       + `  <rdf:Description rdf:about="" xmlns:Iptc4xmpExt="${IPTC_NS}">\n`
       + `   <Iptc4xmpExt:DigitalSourceType>${KI_QUELLE}</Iptc4xmpExt:DigitalSourceType>\n`
       + '  </rdf:Description>\n'
       + ' </rdf:RDF>\n'
       + '</x:xmpmeta>\n'
       + '<?xpacket end="r"?>';
}

// Marker ohne Längenfeld: TEM, SOI, EOI und die acht Restart-Marker.
const ohneLaenge = m => m === 0x01 || m === 0xD8 || m === 0xD9 || (m >= 0xD0 && m <= 0xD7);

/*
 * Segmentliste bis zum Beginn der Bilddaten (SOS). Weiter zu lesen brauchen wir nicht: Alle
 * Metadaten stehen davor, und der entropiekodierte Datenstrom dahinter enthält Bytefolgen,
 * die wie Marker aussehen. Gibt null zurück, wenn die Datei kein JPEG ist.
 */
function segmente(buf) {
  if (buf.length < 4 || buf.readUInt16BE(0) !== 0xFFD8) return null;
  const liste = [];
  let i = 2;
  while (i + 1 < buf.length) {
    if (buf[i] !== 0xFF) break;                       // kein Marker mehr: hier endet das Lesbare
    let m = buf[i + 1];
    while (m === 0xFF && i + 2 < buf.length) { i++; m = buf[i + 1]; }   // FF-Füllbytes
    if (m === 0xDA || m === 0xD9) { liste.push({ marker: m, start: i, ende: i, nutz: null }); break; }
    if (ohneLaenge(m)) { i += 2; continue; }
    if (i + 4 > buf.length) break;
    const laenge = buf.readUInt16BE(i + 2);
    if (laenge < 2 || i + 2 + laenge > buf.length) break;               // abgeschnitten
    liste.push({ marker: m, start: i, ende: i + 2 + laenge, nutz: buf.slice(i + 4, i + 2 + laenge) });
    i += 2 + laenge;
  }
  return liste;
}

const beginntMit = (nutz, kopf) => !!nutz && nutz.length >= kopf.length && nutz.slice(0, kopf.length).equals(kopf);
const istXmp  = s => s.marker === 0xE1 && beginntMit(s.nutz, XMP_KOPF);
const istExif = s => s.marker === 0xE1 && beginntMit(s.nutz, EXIF_KOPF);

/*
 * Zustand der Datei:
 *   'ja'        Kennzeichnung ist da
 *   'nein'      kein XMP-Paket, kann geschrieben werden
 *   'xmp-fremd' ein XMP-Paket ist da, aber ohne unser Feld
 *   'kein-jpeg' keine JPEG-Datei
 *
 * 'xmp-fremd' wird GEMELDET und nicht stillschweigend aufgelöst: Ein zweites XMP-Paket
 * danebenzulegen macht die Datei mehrdeutig (Leser nehmen mal das erste, mal das letzte),
 * und in ein fremdes Paket hineinzuschreiben hieße, es per Textersetzung umzubauen.
 * Bei unseren Pins tritt der Fall nicht auf — ImageMagick 6 schreibt von sich aus kein XMP.
 */
function lesen(buf, segs = segmente(buf)) {
  if (!segs) return 'kein-jpeg';
  const xmp = segs.filter(istXmp);
  if (!xmp.length) return 'nein';
  const text = xmp.map(s => s.nutz.slice(XMP_KOPF.length).toString('utf8')).join('\n');
  return text.includes(KI_QUELLE) ? 'ja' : 'xmp-fremd';
}

/*
 * Einfügestelle. JFIF (APP0) und Exif (APP1) schreiben in ihren eigenen Normen vor, das ERSTE
 * Segment hinter dem SOI zu sein; ein davor eingefügtes APP1 macht die Datei formal ungültig,
 * auch wenn die meisten Leser daran nicht scheitern. Die XMP-Spezifikation sieht genau diese
 * Stelle vor: hinter einem vorhandenen JFIF/Exif, sonst direkt hinter dem SOI.
 * Ein APP11/JUMBF-Segment wird dabei nur übersprungen, nie angefasst.
 */
function einfuegePunkt(segs) {
  let pos = 2;
  for (const s of segs) {
    if (s.marker === 0xE0 || istExif(s)) { pos = s.ende; continue; }
    break;
  }
  return pos;
}

/*
 * Kennzeichnung in die Datei schreiben. Idempotent: Ein zweiter Lauf findet das Feld und
 * schreibt nichts. Gibt { status, bytes, zuwachs } zurück; status ist einer der Werte aus
 * lesen(), zusätzlich 'geschrieben' und 'vorhanden'.
 */
function kennzeichnen(pfad) {
  const buf = fs.readFileSync(pfad);
  const segs = segmente(buf);
  const zustand = lesen(buf, segs);
  if (zustand === 'ja') return { status: 'vorhanden', bytes: buf.length, zuwachs: 0 };
  if (zustand !== 'nein') return { status: zustand, bytes: buf.length, zuwachs: 0 };

  const nutz = Buffer.concat([XMP_KOPF, Buffer.from(xmpPaket(), 'utf8')]);
  // Die Segmentlänge ist ein 16-Bit-Feld und zählt sich selbst mit. Unser Paket liegt bei
  // rund 450 Byte; die Prüfung steht trotzdem hier, weil eine stille Überschreitung eine
  // unlesbare Datei ergäbe statt eines Fehlers.
  if (nutz.length + 2 > 65535) throw new Error(`XMP-Paket zu groß für ein APP1-Segment: ${nutz.length} Byte`);

  const kopf = Buffer.alloc(4);
  kopf.writeUInt16BE(0xFFE1, 0);
  kopf.writeUInt16BE(nutz.length + 2, 2);

  const pos = einfuegePunkt(segs);
  const neu = Buffer.concat([buf.slice(0, pos), kopf, nutz, buf.slice(pos)]);

  /* Erst daneben schreiben, dann umbenennen: Bricht der Lauf mitten im Schreiben ab, liegt die
   * alte Datei unversehrt da statt einer halben. Umbenennen ersetzt die Zieldatei.
   *
   * RECHTE UND EIGENTUEMER WERDEN DABEI UEBERNOMMEN. Die neue Datei entstuende sonst mit den
   * Standardrechten des laufenden Prozesses (0666 & ~umask) und dessen Eigentuemer, und der
   * erste echte Lauf betrifft mehrere hundert bereits veroeffentlichte Bilder auf einmal —
   * genau die, deren Adresse bei Pinterest steht. Laeuft der Stapel unter einer anderen umask
   * oder einem anderen Benutzer als bisher, waeren sie danach fuer den ausliefernden Prozess
   * (nginx oder node) nicht mehr lesbar. chown gelingt nur als root und auf Windows gar nicht;
   * schlaegt es fehl, bleibt es beim bisherigen Verhalten — das ist kein Grund, die
   * Kennzeichnung abzubrechen. */
  const zwischen = pfad + '.ki-tmp';
  try {
    const st = fs.statSync(pfad);
    fs.writeFileSync(zwischen, neu);
    try { fs.chmodSync(zwischen, st.mode & 0o7777); } catch { /* Dateisystem ohne Rechte */ }
    try { fs.chownSync(zwischen, st.uid, st.gid); } catch { /* nicht root, oder Windows */ }
    fs.renameSync(zwischen, pfad);
  } catch (e) {
    try { fs.unlinkSync(zwischen); } catch { /* war nie da */ }
    throw e;
  }
  return { status: 'geschrieben', bytes: neu.length, zuwachs: neu.length - buf.length };
}

if (require.main === module) {
  /*
   * WELCHE DATEI GEKENNZEICHNET WIRD, ENTSCHEIDET DIE SORTE — AUCH HIER.
   *
   * bauen() in pins-erzeugen.js fragt L.istKiPin(typ), bevor es kennzeichnet. Dieses CLI ist
   * der zweite Ausgabepfad derselben Entscheidung und hat bis zum 21.09.2026 gar nichts
   * geprueft: Ein "--schreiben public/pins/*.jpg" haette die maschinenlesbare Aussage
   * "trainedAlgorithmicMedia" auch in die gezeichneten Beetskizzen und in die reine
   * Ratgeber-Typografie geschrieben. Das ist keine ueberfluessige Angabe, sondern eine neue
   * Falschaussage an Pinterest, Meta und Google — und der naechste Stapellauf haette sie nur
   * gemeldet, nicht entfernt (das ist dort begruendet), der Lauf also ab da dauerhaft mit
   * Exitcode 1 geendet. Die Glob-Form steht eine Zeile ueber dem Schreib-Beispiel im
   * Modulkopf; sie ist der wahrscheinliche Aufruf, nicht der unwahrscheinliche.
   *
   * Die Sorte steht im Dateinamen, sorteAus() in pin-sorten.js liest sie heraus. Den
   * Notausgang fuer die bewusste Einzelentscheidung gibt es wie in pin-bild.js: --trotzdem.
   * Unbeaufsichtigt geht so nichts durch, ein begruendeter Einzelfall schon.
   *
   * pin-layout.js wird erst hier geladen und nur fuer den Schreibfall: Es sucht beim Import
   * ImageMagick und die Schriften und warnt, wenn beides fehlt. Ein reiner Leselauf soll das
   * nicht auf den Tisch legen, und das Modul selbst bleibt abhaengigkeitsfrei — im Stapellauf
   * haengt es ohnehin an einem Aufrufer, der pin-layout schon geladen hat.
   */
  const argv = process.argv.slice(2);
  const schreiben = argv.includes('--schreiben');
  const L = schreiben ? require('./pin-layout') : null;
  const S = schreiben ? require('./pin-sorten') : null;
  const trotzdem = argv.includes('--trotzdem');
  const dateien = argv.filter(a => !a.startsWith('--'));
  if (!dateien.length) {
    console.error('Aufruf: node scripts/pin-ki-metadaten.js [--schreiben] [--trotzdem] <datei.jpg ...>');
    process.exit(1);
  }
  let schlecht = 0;
  for (const d of dateien) {
    try {
      if (schreiben) {
        const sorte = S.sorteAus(d);
        if (!L.istKiPin(sorte)) {
          const wer = `Sorte "${sorte || 'unbekannt'}" zeigt kein KI-Bild`;
          if (!trotzdem) {
            schlecht++;
            console.error(`uebergangen ${d}: ${wer} — nicht gekennzeichnet (mit --trotzdem erzwingen).`);
            continue;
          }
          console.error(`--trotzdem  ${d}: ${wer}, wird auf ausdrueckliche Anweisung gekennzeichnet.`);
        }
      }
      const r = schreiben ? kennzeichnen(d) : { status: lesen(fs.readFileSync(d)) };
      if (r.status === 'xmp-fremd' || r.status === 'kein-jpeg') schlecht++;
      console.log(`${r.status.padEnd(11)} ${d}${r.zuwachs ? ` (+${r.zuwachs} Byte)` : ''}`);
    } catch (e) {
      schlecht++;
      console.error(`FEHLER      ${d}: ${e.message}`);
    }
  }
  if (schlecht) process.exitCode = 1;
}

module.exports = { KI_QUELLE, IPTC_NS, XMP_KOPF, xmpPaket, segmente, lesen, kennzeichnen };
