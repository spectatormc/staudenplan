/*
 * DER BILDAUFTRAG FUER DIE WINTERBILDER — eine Fassung fuer Testlauf und Produktion.
 *
 * Warum dieses Modul existiert: Der Testlauf (scripts/winterbild-test.js) hat die Auftraege
 * zuerst selbst gefuehrt. Sobald daneben ein Erzeuger steht, der dieselben Auftraege noch
 * einmal formuliert, belegt der Testlauf nichts mehr — er zeigt dann, was der Testlauf tut,
 * nicht, was die Produktion tut. Beide requiren deshalb diese Datei, und keiner haelt eine
 * eigene Kopie.
 *
 * WAS HIER STEHT
 *   ASPEKT           — was im Winter ZU SEHEN ist, je Winteraspekt. Ein Samenstand, ein
 *                      trockener Grashorst und eine wintergruene Rosette sehen voellig
 *                      verschieden aus; ein gemeinsamer "im Winter"-Auftrag beschriebe fuer
 *                      drei von vier das Falsche.
 *   FASSUNGEN        — zwei Bildauftraege, A und B. ENTSCHIEDEN IST A (Raureif, tiefes Licht,
 *                      kahles Beet, Blueten ausdruecklich verboten). B bleibt als Schalter
 *                      erhalten, ist aber nicht die Vorgabe.
 *   kannWinterbild   — bekommt diese Pflanze ueberhaupt ein Winterbild?
 *   winterbildPfad   — wohin die Datei gehoert, und woran man sie wiedererkennt.
 *   winterBildQuelle — welche Bilddatei der Winter-Pin benutzt (Winterbild, sonst Bluehbild).
 *
 * DIE WERTELISTE IST NICHT DIE UNSRIGE. Die Schluessel von ASPEKT sind die Schluessel von
 * WINTER_WERT (scripts/pin-saison.js) — dieselbe Liste, die entscheidet, welche Pflanze
 * ueberhaupt einen Winter-Pin bekommt, und die die deutsche Beschriftung liefert. Hier steht
 * nur, WIE der Zustand im Bild aussieht. Damit die beiden nicht auseinanderlaufen koennen,
 * wird die Deckung beim Laden dieses Moduls geprueft und im Fehlerfall GEWORFEN, in beide
 * Richtungen:
 *   - ein WINTER_WERT-Schluessel ohne Bildauftrag hiesse: Diese Pflanzen bekommen einen
 *     Winter-Pin, aber still das Bluehbild — genau der Zustand, gegen den diese Pipeline
 *     gebaut ist.
 *   - ein Bildauftrag ohne WINTER_WERT-Schluessel waere ein Auftrag, den niemand je abruft.
 * Der Preis dieser Strenge steht hier, damit ihn niemand suchen muss: scripts/pin-bild.js
 * requirt dieses Modul, und pins-erzeugen.js requirt pin-bild.js. Eine auseinandergelaufene
 * Liste legt deshalb den ganzen Pin-Lauf still, nicht nur den Winterteil. Das ist gewollt —
 * die Reparatur ist eine Zeile in einer der beiden Listen, der stille Ausfall waeren 163 Pins
 * mit dem falschen Bild.
 *
 * KEINE BILDERZEUGUNG HIER. Dieses Modul formuliert nur; erzeugt wird in
 * scripts/winterbilder-erzeugen.js (das kostet Geld) und im Testlauf.
 */
'use strict';

// WINTER_WERT und winterAspekt() kommen aus pin-saison.js. Das laedt pin-layout.js und damit
// die Suche nach ImageMagick und den Schriften — zwei Prozessaufrufe beim Import, im Zweifel
// zwei Warnzeilen. Das ist der Preis dafuer, die Werteliste NICHT ein zweites Mal zu fuehren;
// er wird hier bewusst bezahlt (pin-layout wirft beim Import nie, es warnt nur).
const saison = require('./pin-saison');
// slugify aus pin-sorten.js — dem abhaengigkeitsfreien Modul, in dem die Slug-Regel des
// Pin-Kanals steht. Eine dritte Fassung dafuer entsteht hier nicht.
const { slugify } = require('./pin-sorten');

/* Was im Winter ZU SEHEN ist. Englisch, weil der Bildauftrag englisch ist; die deutsche
 * Beschriftung kommt unveraendert aus WINTER_WERT (pin-saison.js). */
const ASPEKT = {
  'samenstand dekorativ': 'The plant has finished flowering: dry, brown and beige seed heads on stiff standing stems, no petals left, foliage withered. The dried seed heads are the subject.',
  'gräser struktur': 'The ornamental grass is dormant: straw-coloured and golden-brown dry blades and flower plumes, still upright and arching, no green growth. The dry winter silhouette is the subject.',
  'blätter immergrün': 'The plant is evergreen and keeps its foliage through winter: firm green leaves, no flowers, surrounded by the bare dormant garden.',
  'rosetten wintergrün': 'The plant overwinters as a flat evergreen rosette of leaves close to the ground, no flowers, no tall stems.',
  'blätter halbimmergrün': 'The plant is semi-evergreen in winter: a low mound of leathery leaves, some tinged bronze or reddish from the cold, no flowers.',
  'struktur': 'The plant is dormant but keeps its structure: dry standing stems and remains of foliage, no flowers.',
};

/* Die Gegenprobe beim Laden — siehe Kopf. Gemeldet werden die Schluessel selbst, damit die
 * Meldung schon sagt, welche Zeile fehlt. */
(function deckungPruefen() {
  const ohneAuftrag = Object.keys(saison.WINTER_WERT).filter(k => !ASPEKT[k]);
  const ohneWert = Object.keys(ASPEKT).filter(k => !saison.WINTER_WERT[k]);
  if (!ohneAuftrag.length && !ohneWert.length) return;
  const zeilen = [];
  if (ohneAuftrag.length) zeilen.push('ohne Bildauftrag in ASPEKT (scripts/winterbild-auftrag.js): '
    + ohneAuftrag.map(k => `"${k}"`).join(', '));
  if (ohneWert.length) zeilen.push('ohne Eintrag in WINTER_WERT (scripts/pin-saison.js): '
    + ohneWert.map(k => `"${k}"`).join(', '));
  throw new Error('Winteraspekte laufen auseinander — ' + zeilen.join('; ')
    + '. Beide Listen beschreiben dieselbe Regel und muessen dieselben Schluessel tragen.');
})();

/*
 * DIE ZWEI FASSUNGEN. Welcher Auftrag ein brauchbares Bild ergibt, ist nicht herleitbar,
 * sondern nur zu sehen — deshalb gab es zwei und einen Testlauf mit zehn Bildern.
 * Fassung A beschreibt den ZUSTAND der Pflanze im Winter und verbietet Blueten ausdruecklich,
 * Fassung B eine WINTERSZENE mit Schnee und truebem Licht. Entschieden ist A (22.09.2026);
 * B bleibt als Schalter stehen, damit sich die Entscheidung an einem Einzelfall noch einmal
 * nachsehen laesst, ohne den Auftrag neu zu erfinden.
 * Beide bekommen denselben Satz zum Winteraspekt — den, der auch auf der Kachel steht.
 */
const FASSUNGEN = {
  a: (p, aspekt) => `Photorealistic garden photograph of ${p.name_botanisch} (${p.name_deutsch}) in WINTER, in a German garden in December. `
    + `${aspekt} `
    + `Hoar frost on the plant, low winter sunlight, bare dormant garden bed behind it, muted winter colours. `
    + `IMPORTANT: absolutely no flowers, no blossoms, no fresh green spring growth — this is the winter state of the plant. `
    + `Show the whole plant and its shape. No text, no watermarks, no people. High quality plant photography.`,

  b: (p, aspekt) => `Photorealistic winter garden scene, close view of ${p.name_botanisch} (${p.name_deutsch}) as the subject. `
    + `${aspekt} `
    + `A light dusting of snow and frost, overcast cold daylight, a quiet winter garden with bare soil and dormant perennials behind. `
    + `IMPORTANT: no flowers and no blossoms of any kind. `
    + `Show the whole plant and its shape. No text, no watermarks, no people. High quality plant photography.`,
};

const FASSUNG_VORGABE = 'a';

/* Bildparameter und Preis stehen hier, weil zwei Laeufe sie brauchen (Testlauf und Erzeuger)
 * und beide dasselbe Bild erzeugen muessen — ein Testbild in anderer Groesse oder Qualitaet
 * belegte nichts ueber die Produktion.
 * output_format jpeg und das unveraenderte Wegschreiben der Bytes sind KEINE Nebensache: Nur
 * so bleibt das C2PA-Manifest von OpenAI in der Datei erhalten. Wer hier ein Nachbearbeiten
 * einbaut (skalieren, neu kodieren), verliert es still. */
const BILD_PARAMETER = { model: 'gpt-image-1', n: 1, size: '1024x1024', quality: 'medium', output_format: 'jpeg' };
const KOSTEN_JE_BILD = 0.04;              // $, gpt-image-1 medium 1024x1024
const RATE_PAUSE_MS = 13000;              // 5 Bilder/Minute

// ─── Die Spalte ──────────────────────────────────────────────────────────────
/* Der Name der Spalte steht an EINER Stelle und wird von dort in die Abfragen gesetzt
 * (pin-saison.js ladePflanzen, winterbilder-erzeugen.js, check-plant-images.js).
 * Angelegt wird sie in der Migrationsliste von stauden-server.js. */
const WINTERBILD_SPALTE = 'bild_winter_url';

// ─── Wer bekommt ein Winterbild? ─────────────────────────────────────────────
/*
 * DIESELBE BEDINGUNG, DIE UEBER DIE SORTE pflanze-winter ENTSCHEIDET.
 *
 * Nachgesehen, wie das heute entschieden wird: scripts/pins-erzeugen.js baut die Sorte fuer
 *     saisonModul.ladePflanzen(db).filter(p => saisonModul.winterAspekt(p))
 * — also fuer jede Pflanze des Pin-Pools, deren `winteraspekt` EXAKT einem Schluessel aus
 * WINTER_WERT entspricht. Die Prosa der Spalte ("die Pflanze zieht sich im Winter zurueck…",
 * rund 22 Zeilen) und "unauffaellig" (128 Zeilen) werden NICHT nach Stichwoertern durchsucht.
 * Genau diese Bedingung wird hier weiterverwendet und nicht nachgebaut: Ein Winterbild fuer
 * eine Pflanze ohne Winter-Pin waere bezahltes Nichts, ein Winter-Pin ohne Winterbild bliebe
 * still beim Bluehbild.
 *
 * Die zweite Haelfte der Bedingung — steht die Pflanze ueberhaupt im Pin-Pool — bleibt beim
 * Pool selbst (saison.ladePflanzen): eigener deutscher Name, Beetstaude, hier winterhart,
 * eigenes Bild vorhanden. Sie hier zu wiederholen waere die zweite Fassung.
 */
function kannWinterbild(p) {
  return Boolean(saison.winterAspekt(p));
}

/* Der englische Bildauftrag zu einer Pflanze. Wirft, statt einen Auftrag ohne Winteraspekt zu
 * bilden: Ein "im Winter"-Bild ohne Angabe, WAS im Winter zu sehen ist, waere geraten. */
function auftrag(p, fassung = FASSUNG_VORGABE) {
  const f = String(fassung || FASSUNG_VORGABE).toLowerCase();
  if (!FASSUNGEN[f]) throw new Error(`Unbekannte Fassung "${fassung}" — bekannt sind: ${Object.keys(FASSUNGEN).join(', ')}`);
  const text = ASPEKT[saison.winterSchluessel(p)];
  if (!text) throw new Error('Kein Bildauftrag fuer diesen Winteraspekt (WINTER_WERT/ASPEKT): '
    + `${p && p.name_botanisch} — winteraspekt="${(p && p.winteraspekt) || ''}"`);
  return FASSUNGEN[f](p, text);
}

// ─── Datei und Wiedererkennung ───────────────────────────────────────────────
const WINTERBILD_ORDNER = '/images/pflanzen/';
const WINTERBILD_PRAEFIX = 'ki-winter-';

/* Der Zielpfad, wie er in bild_winter_url steht. Aufbau wie bei den vorhandenen KI-Bildern
 * (ki-<slug>-<id>.jpg, scripts/generate-ki-bilder.js), nur mit eigenem Praefix — so ist an
 * der Datei selbst zu sehen, dass sie ein Winterbild ist und nicht das Bild der Pflanzenseite.
 * Die Id steht hinten und macht den Namen eindeutig, auch wenn zwei Arten denselben deutschen
 * Namen tragen. */
function winterbildDatei(p) {
  const slug = slugify(p.name_deutsch || p.name_botanisch || 'pflanze').slice(0, 40);
  return `${WINTERBILD_PRAEFIX}${slug}-${p.id}.jpg`;
}
function winterbildPfad(p) {
  return WINTERBILD_ORDNER + winterbildDatei(p);
}

/*
 * Gehoert dieser Pfad zu einem selbst erzeugten Winterbild DIESER Pflanze?
 *
 * Gefragt wird das im Ausgabepfad (winterBildQuelle), und zwar aus einem Grund: Neben dem
 * Winterbild steht bewusst KEINE Lizenzspalte, weil ein Winterbild per Konstruktion immer
 * selbst erzeugt ist. Eine Zusage, die kein Code durchsetzt, ist keine — deshalb wird sie
 * hier durchgesetzt: Was nicht wie ein erzeugtes Winterbild heisst, wird nicht als eines
 * benutzt. Sonst truege ein von Hand eingetragenes fremdes Foto im Pin die Fusszeile
 * "Illustration" und die maschinenlesbare KI-Kennzeichnung.
 *
 * Verglichen wird NICHT auf Gleichheit mit winterbildPfad(): Der Slug haengt am deutschen
 * Namen, und Namenskorrekturen gibt es in diesem Projekt regelmaessig (114 im August 2026).
 * Eine Umbenennung wuerde sonst jedes liegende Winterbild ungueltig machen. Gebunden wird
 * deshalb an das Praefix und an die Id — die aendert sich nie.
 */
function istWinterbildPfad(url, id) {
  const u = String(url || '');
  if (!u.startsWith(WINTERBILD_ORDNER + WINTERBILD_PRAEFIX)) return false;
  if (!Number.isFinite(Number(id))) return false;
  return new RegExp(`-${Number(id)}\\.jpg$`).test(u);
}

/*
 * WELCHES BILD BENUTZT DER WINTER-PIN?
 *
 * Antwort in einem Satz: das Winterbild, wenn es eines gibt — sonst wie bisher das Bild der
 * Pflanzenseite. Der Rueckfall ist ausdruecklich erlaubt: Die Pipeline wird schrittweise
 * gefuellt, und ein Winter-Pin mit Bluehbild ist der Zustand von heute, also keine
 * Verschlechterung.
 *
 * DIE EINE STELLE, AN DER ES STILL SCHIEFGEHEN KOENNTE, IST DIE SPALTENLISTE DER ABFRAGE.
 * Liefert der Lader bild_winter_url gar nicht mit, saehe jede Pflanze aus wie eine ohne
 * Winterbild — der Rueckfall griffe bei allen 163 Pins, ohne eine einzige Meldung, und die
 * bezahlten Bilder laegen ungenutzt auf der Platte. Deshalb wird zwischen "Feld nicht
 * geladen" und "Feld leer" unterschieden (wie `bekannt` in scripts/bild-herkunft.js) und im
 * ersten Fall geworfen. Ein lauter Abbruch ist hier richtig: Der Fehler steckt dann in der
 * Abfrage, nicht in den Daten.
 *
 * @returns {{url: string, eigen: boolean}} eigen=true heisst: das Winterbild wird benutzt.
 */
function winterBildQuelle(p) {
  const q = (p && typeof p === 'object') ? p : {};
  if (!(WINTERBILD_SPALTE in q)) {
    throw new Error(`Der Lader liefert die Spalte ${WINTERBILD_SPALTE} nicht mit `
      + `(${q.name_botanisch || q.id || '?'}) — der Rueckfall auf bild_url waere still. `
      + 'Spalte in die SELECT-Liste aufnehmen (WINTERBILD_SPALTE in scripts/winterbild-auftrag.js).');
  }
  const winter = String(q[WINTERBILD_SPALTE] || '').trim();
  if (!winter) return { url: q.bild_url, eigen: false };
  if (!istWinterbildPfad(winter, q.id)) {
    throw new Error(`${WINTERBILD_SPALTE} ist kein selbst erzeugtes Winterbild dieser Pflanze: `
      + `"${winter}" (erwartet ${WINTERBILD_ORDNER}${WINTERBILD_PRAEFIX}…-${q.id}.jpg). `
      + 'Geschrieben wird die Spalte nur von scripts/winterbilder-erzeugen.js; ein fremdes Bild '
      + 'truege im Pin faelschlich die KI-Kennzeichnung.');
  }
  return { url: winter, eigen: true };
}

module.exports = {
  ASPEKT, FASSUNGEN, FASSUNG_VORGABE, BILD_PARAMETER, KOSTEN_JE_BILD, RATE_PAUSE_MS,
  WINTERBILD_SPALTE, WINTERBILD_ORDNER, WINTERBILD_PRAEFIX,
  kannWinterbild, auftrag, winterbildDatei, winterbildPfad, istWinterbildPfad, winterBildQuelle,
};
