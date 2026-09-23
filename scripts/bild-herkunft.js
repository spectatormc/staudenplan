/*
 * Bildherkunft — EINE Ableitung für alle Ausgabepfade.
 *
 * Warum diese Datei existiert:
 * Bis 09/2026 stand die Kennzeichnung nur auf der Pflanzenseite (stauden-server.js), und zwar
 * als dreistufiger Ausdruck direkt im Template: bild_ki → "KI-generiert · OpenAI", sonst
 * Wikimedia → "Foto: …", sonst "Foto: Pixabay". Alle übrigen Bildausgaben — Saison-Landeseiten,
 * Lexikon, Kategorieseiten, Ratgeber, Planerkarten, Beispielpläne, Quiz — trugen gar keine
 * Kennzeichnung. Damit lief dieselbe Aussage an neun Stellen auseinander, und an acht davon
 * fehlte sie ganz. Die Ableitung gehört deshalb an EINE Stelle, wie escHtml/escJsonLd in
 * stauden-server.js:186 ff.
 *
 * Was hier als verlässlich gilt (an den Produktionsdaten vom 21.09.2026 gemessen, 711 Zeilen):
 *   - bild_ki ist das verlässliche Feld: 299 Zeilen auf 1, 410 auf 0, keine Zeile mit
 *     DALL-E-Lizenz und bild_ki=0.
 *   - bild_lizenz ist es NICHT: id 698 (Bergenia 'Silberlicht') trägt "Pixabay License",
 *     obwohl die Datei ki-weisse-bergenie-698.jpg heißt und ein C2PA-Manifest trägt.
 *     Das Lizenzfeld ist dort falsch, nicht bild_ki (siehe scripts/fix-bild-lizenz-698.js).
 *   - Wikimedia/Wikipedia kommt in bild_lizenz in KEINER Zeile vor. Der entsprechende Zweig
 *     der alten Kennzeichnung war toter Code und ist ersatzlos gestrichen.
 *
 * Grundregel: bild_ki entscheidet, bild_lizenz und der Dateiname sind die Gegenprobe.
 * Widersprüche werden GEMELDET (Feld `widerspruch`), nicht still aufgelöst.
 * Was nicht positiv belegt ist, bekommt KEINEN Herkunftssatz — der frühere Else-Zweig
 * "Foto: Pixabay" war geraten, nicht belegt.
 * Widerspricht im Zweig bild_ki=0 etwas, wird das Bild zusätzlich gar nicht ausgegeben
 * (Feld `belegt`, siehe bildHerkunft): Ein mutmaßliches KI-Bild ohne Kennzeichnung ist der
 * Fall, den diese Datei verhindern soll.
 *
 * Diese Datei darf stauden-server.js NICHT requiren: der startet beim Laden sofort den
 * Server (stauden-server.js, app.listen am Dateiende) und exportiert nichts. Umgekehrt
 * requirt der Server diese Datei.
 *
 * HTML-Kodierung: alle von hier ausgegebenen Texte sind Konstanten DIESER Datei (KI_TEXT,
 * FOTO_PIXABAY, KI_MARKE_TEXT). Deshalb ist hier kein escHtml nötig. Wer hier einen Wert
 * aus der Datenbank in das HTML einsetzt, muss ihn vorher kodieren.
 */
'use strict';

// ─── SQL-Spalten ──────────────────────────────────────────────────────────────
// Damit keine Abfrage die Herkunftsfelder vergessen kann. Jede SELECT-Liste, die ein Bild
// auf eine Seite bringt, benutzt BILD_SPALTEN_SQL statt eines nackten "bild_url".
const BILD_SPALTEN = 'bild_ki, bild_lizenz';
const BILD_SPALTEN_SQL = 'bild_url, bild_ki, bild_lizenz';
const BILD_SPALTEN_LISTE = ['bild_url', 'bild_ki', 'bild_lizenz'];

// ─── Texte ────────────────────────────────────────────────────────────────────
// "Illustration", nicht "Foto": Die KI-Bilder zeigen die Art typisiert, nicht das Exemplar,
// das später im Garten steht. Derselbe Wortlaut steht im Haftungsausschluss (/impressum) —
// dort stand bis zum 23.09.2026 "das die Gärtnerei versendet"; die Website nennt seither
// keine Bezugsquelle mehr, und der Satz darf keine voraussetzen.
const KI_TEXT = 'KI-erzeugte Illustration';
const KI_MARKE_TEXT = 'KI-Bild';
const FOTO_PIXABAY = 'Foto: Pixabay';
// Der Wert, den bild_lizenz für ein selbst erzeugtes Bild trägt. Steht hier, weil der
// Schreibweg (/api/bild-approve) ihn setzt und der Lesepfad ihn wiedererkennen muss.
// scripts/generate-ki-bilder.js schreibt ihn nach bild_check_info und holt ihn seit 09/2026
// von hier. Andere Skripte (fix-live-broken-images.js, fix-duplicate-images.js,
// add-teichpflanzen.js) führen ihn noch als eigenes Literal — beim nächsten Eingriff dort
// ebenfalls auf diese Konstante umstellen.
const KI_LIZENZ = 'KI-generiert / OpenAI';

// KI-Werkzeuge, wie sie in bild_lizenz real vorkommen: "DALL-E 3 / OpenAI" (215 Zeilen),
// "KI-generiert / OpenAI" (83 Zeilen).
const RX_KI_LIZENZ = /(dall\s*-?\s*e|openai|ki[-\s]?generiert|ki[-\s]?erzeugt)/i;
// Positiv belegter Fotonachweis. "lokal gecacht" (79 Zeilen) belegt NUR, dass die Datei
// heruntergeladen wurde, nicht woher sie stammt (scripts/cache-plant-images.js:84) — diese
// Bilder bekommen bewusst keinen Nachweis am Bild. Die Sammelaussage dazu steht im
// Haftungsausschluss.
const RX_PIXABAY = /pixabay/i;
// Alle selbst erzeugten Bilder werden als "ki-<slug>-<id>.jpg" abgelegt
// (scripts/generate-ki-bilder.js, scripts/fix-live-broken-images.js).
const RX_KI_DATEI = /(^|\/)ki-[^/]*$/i;

const txt = (v) => String(v == null ? '' : v).trim();

/**
 * Die Ableitung. Alles andere in dieser Datei baut darauf auf.
 *
 * @param {object} p Datensatz mit bild_ki, bild_lizenz, bild_url (bild_url optional)
 * @returns {{ki: boolean, text: string|null, widerspruch: string|null, bekannt: boolean,
 *            belegt: boolean}}
 *   ki          — Boolean(p.bild_ki)
 *   text        — Herkunftssatz oder null, wenn nichts positiv belegt ist
 *   widerspruch — Klartext für das Log, wenn bild_ki und bild_lizenz/bild_url einander
 *                 widersprechen oder die Herkunftsfelder ganz fehlen; sonst null
 *   bekannt     — false, wenn bild_ki im Datensatz gar nicht vorkommt. Dann ist NICHTS
 *                 bekannt, und der Aufrufer muss die Ausgabe verweigern oder nachschlagen —
 *                 undefined ist falsy und würde sonst still zu "kein KI-Bild".
 *   belegt      — false, wenn über die Herkunft nichts Belastbares dasteht. Das sind ZWEI
 *                 Fälle, und sie werden gleich behandelt (bildZeigbar → kein Bild):
 *                   (a) bild_ki fehlt ganz (bekannt=false),
 *                   (b) bild_ki=0, aber Lizenz oder Dateiname sprechen für ein KI-Bild.
 *                 (b) war bis 09/2026 der laxere Fall: Der KONKRETE Verdacht führte nur
 *                 dazu, dass der Fotonachweis wegfiel — das mutmaßliche KI-Bild ging
 *                 ungekennzeichnet hinaus, während der schwächere Fall (a) den Platzhalter
 *                 bekam. Der stärkere Verdacht darf nicht die mildere Folge haben.
 *                 bild_ki=1 mit widersprechender Lizenz ist KEIN solcher Fall: Dort steht
 *                 die strengere Aussage ohnehin am Bild (id 698), der Widerspruch wird
 *                 gemeldet, das Bild bleibt sichtbar.
 *                 Wie viele Zeilen (b) in der Produktion betrifft, ist nicht gemessen:
 *                 SELECT COUNT(*) FROM pflanzen WHERE (bild_ki IS NULL OR bild_ki=0)
 *                   AND (bild_url LIKE '%/ki-%' OR bild_lizenz LIKE '%OpenAI%');
 */
function bildHerkunft(p) {
  const q = (p && typeof p === 'object') ? p : {};
  const bekannt = q.bild_ki !== undefined && q.bild_ki !== null;
  const ki = Boolean(q.bild_ki);
  const lizenz = txt(q.bild_lizenz);
  const url = txt(q.bild_url);

  const wid = [];
  if (!bekannt) {
    if (url) wid.push('bild_url ist gesetzt, bild_ki fehlt im Datensatz — Herkunft unbekannt');
  } else if (ki) {
    if (lizenz && !RX_KI_LIZENZ.test(lizenz)) {
      wid.push(`bild_ki=1, aber bild_lizenz nennt kein KI-Werkzeug ("${lizenz}")`);
    }
  } else {
    if (lizenz && RX_KI_LIZENZ.test(lizenz)) {
      wid.push(`bild_ki=0, aber bild_lizenz nennt ein KI-Werkzeug ("${lizenz}")`);
    }
    if (url && RX_KI_DATEI.test(url)) {
      wid.push(`bild_ki=0, aber der Dateiname weist auf ein KI-Bild ("${url}")`);
    }
  }

  /* Belastbar ist die Aussage nur, wenn bild_ki dasteht UND ihr im Nicht-KI-Zweig nichts
   * widerspricht. Ein Widerspruch bei bild_ki=1 zählt nicht dagegen: Dort ist die Folge die
   * Kennzeichnung, und die ist die vorsichtige Richtung. */
  const belegt = bekannt && (ki || wid.length === 0);

  /* Der Text.
   * bild_ki=1 → KI-Satz, auch wenn die Lizenz etwas anderes sagt: bild_ki ist das
   *   verlässliche Feld, die Lizenz ist es nicht (id 698). Der Widerspruch wird gemeldet.
   * bild_ki=0 → Fotonachweis nur, wenn die Lizenz ihn positiv belegt. Widerspricht in
   *   diesem Zweig etwas (KI-Lizenz oder "ki-"-Dateiname), wird gar nichts behauptet und
   *   das Bild gar nicht erst gezeigt (belegt=false): "Foto: Pixabay" an einer Zeile, deren
   *   Dateiname auf ein KI-Bild zeigt, wäre derselbe Fehler wie eine fehlende
   *   KI-Kennzeichnung, nur in die andere Richtung. */
  let text = null;
  if (bekannt) {
    if (ki) text = KI_TEXT;
    else if (belegt && RX_PIXABAY.test(lizenz)) text = FOTO_PIXABAY;
  }

  return { ki, text, widerspruch: wid.length ? wid.join('; ') : null, bekannt, belegt };
}

/**
 * Darf dieses Bild überhaupt ausgegeben werden?
 * Ein Bild ohne belegte Herkunft bekommt keine geratene Kennzeichnung — es wird gar nicht
 * erst gezeigt (Platzhalter statt Bild). Das betrifft vor allem geteilte Pläne aus
 * geteilte_plaene, deren plan_json vor dieser Änderung entstanden ist.
 *
 * DIESE FUNKTION IST DIE EINZIGE STELLE, an der die Zulassung entschieden wird. Bis 09/2026
 * stand dieselbe Bedingung an neun Stellen von Hand nachgebaut (fünf SSR-Templates im
 * Server, drei Browser-Templates, einmal hier) — eine Verschärfung wie `belegt` hätte
 * neunmal nachgezogen werden müssen. Server-Templates rufen bildZeigbar(); die drei
 * Browser-Templates bekommen die Antwort als Merkmal bild_herkunft mitgeliefert
 * (bildHerkunftOeffentlich → null heißt "nicht zeigen") und formulieren die Regel nicht
 * noch einmal.
 */
function bildZeigbar(p) {
  return Boolean(p && txt(p.bild_url) && bildHerkunft(p).belegt);
}

/**
 * Zusatz für den alt-Text. Kommt aus derselben Ableitung wie Unterschrift und Kachelmarke,
 * damit alt-Text und sichtbare Beschriftung am selben Bild nie Verschiedenes behaupten —
 * genau das war auf den Saison-Landeseiten der Fall, wo ein fest verdrahtetes
 * "— Illustration" an JEDEM Bild stand, unabhängig von bild_ki.
 * Für Fotos bleibt der Zusatz leer: Der Nachweis steht in der Unterschrift, und der alt-Text
 * soll das Bild beschreiben, nicht die Quelle.
 */
function bildAltZusatz(p) {
  return bildHerkunft(p).ki ? ` — ${KI_TEXT}` : '';
}

/**
 * Bildunterschrift (überall dort, wo unter dem Bild Platz ist: Pflanzenseite, Quiz).
 * Ohne belegte Herkunft bleibt die Zeile leer — kein geratener Satz.
 */
function bildUnterschriftHTML(p, stil) {
  const h = bildHerkunft(p);
  if (!h.text) return '';
  const s = stil || 'font-size:.68rem;color:#bbb;margin-top:6px;text-align:right';
  return `<p style="${s}">${h.text}</p>`;
}

/**
 * Markierung PRO KACHEL für gemischte Raster (KI-Bild und Foto nebeneinander).
 * Ein Sammelhinweis über dem Raster wäre eine Zusage ohne Regel: Er behauptet etwas über
 * Bilder, das für die Hälfte davon nicht gilt. Aufbau wie die Giftmarkierung in
 * stauden-server.js (saisonSeiteHTML) — dort links oben, hier rechts oben, damit sich beide
 * auf derselben Kachel nicht überdecken.
 * Nur KI-Bilder bekommen eine Marke; ein Pixabay-Foto so zu markieren wäre derselbe Fehler
 * in der anderen Richtung.
 * Der umgebende Container braucht position:relative.
 */
function bildMarkeHTML(p, pos) {
  if (!bildHerkunft(p).ki) return '';
  const p2 = pos || 'top:8px;right:8px';
  // print-color-adjust: Die Karten werden gedruckt (stauden-portal.html, @media print).
  // Ohne diese Angabe lässt der Browser den dunklen Hintergrund beim Drucken weg — übrig
  // bliebe weiße Schrift auf weißem Papier, also eine unsichtbare Kennzeichnung.
  return `<span class="ki-marke" title="${KI_TEXT}" style="position:absolute;${p2};background:rgba(27,67,50,.82);color:#fff;`
       + `font-weight:700;font-size:.66rem;letter-spacing:.02em;padding:3px 7px;border-radius:6px;`
       + `line-height:1.2;pointer-events:none;-webkit-print-color-adjust:exact;print-color-adjust:exact">${KI_MARKE_TEXT}</span>`;
}

/**
 * Das Herkunftsmerkmal für JSON-Antworten. Wer bild_url ausliefert, liefert das hier mit —
 * sonst kann der Empfänger (Planer im Browser, Lexikon, Quiz) gar nicht kennzeichnen.
 * Abgeleitet wird auf dem Server: Der Browser bekommt das Ergebnis, nicht die Regel.
 *
 * null heißt „dieses Bild wird nicht ausgegeben" — dieselbe Antwort wie bildZeigbar(), nur
 * als Datenfeld. Der Empfänger prüft deshalb NUR, ob das Merkmal da ist, und baut die
 * Bedingung nicht noch einmal nach.
 *
 * `alt` ist der fertige Zusatz für den alt-Text (leer bei Fotos). Er reist mit dem Datensatz,
 * damit kein Client den Trenner „ — " selbst tippt; der Wortlaut kommt aus bildAltZusatz.
 * Der Kurztext der Kachelmarke wird NICHT mitgegeben: Wer eine Marke setzt, braucht neben
 * dem Wort auch ihr Aussehen (Farbe, print-color-adjust) — beides kommt als fertiges Markup
 * aus bildMarkeHTML und steht als EINE Seitenkonstante im Template (KI_MARKE), statt an
 * jedem Datensatz zu hängen.
 */
function bildHerkunftOeffentlich(p) {
  if (!bildZeigbar(p)) return null;
  const h = bildHerkunft(p);
  return { ki: h.ki, text: h.text, alt: bildAltZusatz(p) };
}

/**
 * Gegenprobe für den nachträglichen Nachschlag: Stammt die nachgeschlagene Zeile wirklich
 * von dem Bild, das hier gezeigt wird?
 * Der Nachschlag in der Plan-Anreicherung matcht über drei abgestufte LIKE-Muster bis hinunter
 * auf die Gattung. Ein späterer Nachschlag über denselben botanischen Namen kann deshalb eine
 * ANDERE Zeile treffen als die, aus der das Bild stammt — deren bild_ki würde dann eine
 * Aussage über ein fremdes Bild machen. Übernommen wird nur, wenn die Bildpfade gleich sind.
 */
function passtZurBildzeile(p, zeile) {
  const a = txt(p && p.bild_url);
  const b = txt(zeile && zeile.bild_url);
  return Boolean(a && b && a === b);
}

/**
 * Die Ableitung für den SCHREIBWEG: Welche Herkunftsfelder gehören zu einem NEU
 * übernommenen Bild?
 *
 * Warum das hier steht und nicht in der Route: Die Kennzeichnung liest bild_ki. Ein
 * Schreibweg, der bild_ki aus dem ALTEN Zustand fortschreibt, kann die Aussage am neuen Bild
 * verfälschen — /api/bild-approve übernahm bis 09/2026 jeden bild_vorschlag und setzte die
 * Lizenz allein danach, ob die Pflanze vorher bild_ki=1 hatte. Vorschläge kommen aber aus
 * zwei Quellen: scripts/generate-ki-bilder.js (erzeugtes Bild) und
 * scripts/check-plant-images.js (gefundenes Pixabay-Foto). Ein Foto, das ein verworfenes
 * KI-Bild ersetzt, trug danach auf allen Ausgabepfaden die Marke „KI-Bild".
 *
 * Entschieden wird deshalb am NEUEN Bild: die Angabe des Fundes (ki), sonst die Lizenz,
 * sonst der Dateiname — dieselben Kriterien, mit denen bildHerkunft() später gegenprüft.
 * Ist keine Lizenz bekannt und das Bild kein KI-Bild, bleibt bild_lizenz leer: geraten wird
 * nichts (siehe FOTO_PIXABAY/RX_PIXABAY).
 *
 * @param {{url: string, lizenz?: string, ki?: boolean}} fund
 * @returns {{bild_ki: 0|1, bild_lizenz: string|null}}
 */
function bildFelderAusFund(fund) {
  const f = (fund && typeof fund === 'object') ? fund : {};
  const url = txt(f.url);
  const lizenz = txt(f.lizenz);
  const ki = f.ki === true || (lizenz && RX_KI_LIZENZ.test(lizenz)) || (url && RX_KI_DATEI.test(url));
  return {
    bild_ki: ki ? 1 : 0,
    bild_lizenz: lizenz || (ki ? KI_LIZENZ : null),
  };
}

module.exports = {
  BILD_SPALTEN,
  BILD_SPALTEN_SQL,
  BILD_SPALTEN_LISTE,
  KI_TEXT,
  KI_MARKE_TEXT,
  FOTO_PIXABAY,
  KI_LIZENZ,
  bildHerkunft,
  bildFelderAusFund,
  bildZeigbar,
  bildAltZusatz,
  bildUnterschriftHTML,
  bildMarkeHTML,
  bildHerkunftOeffentlich,
  passtZurBildzeile,
};
