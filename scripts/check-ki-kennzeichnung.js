/*
 * PRUEFUNG 1: Traegt jeder Ausgabepfad, der ein KI-Bild zeigt, die Kennzeichnung — und
 * traegt sie kein anderer?
 *
 *   npm run check:ki
 *   node scripts/check-ki-kennzeichnung.js --selbsttest   nur die Melder pruefen
 *
 * WARUM ES DIESE PRUEFUNG GIBT: Die Kennzeichnung ist im September 2026 von einer Stelle
 * (Pflanzenseite) auf alle Ausgabepfade gezogen worden — Lexikon, Planerkarten, Quiz,
 * Kategorieseiten, Saison-Landeseiten, Beispielplaene, og:image, JSON-LD. Die Fehlerklasse,
 * die dabei mehrfach aufgetreten ist, heisst nicht „die Regel ist falsch", sondern „ein
 * Ausgabepfad wurde uebersehen". Genau danach sucht dieser Lauf: Er fragt den laufenden
 * Server ab, nicht den Quelltext.
 *
 * BEIDE RICHTUNGEN, sonst waere es ein halber Rueckbau:
 *   (1) Bild mit bild_ki=1 ohne Marke  -> FEHLER (fehlende Kennzeichnung)
 *   (2) Bild mit bild_ki=0 MIT Marke   -> FEHLER (Falschaussage ueber ein Foto)
 *   (3) Bild ohne belegte Herkunft ueberhaupt ausgeliefert -> FEHLER (bildZeigbar)
 * Deshalb hat auch die Leerlaufsperre ZWEI Schwellen: Ein Lauf, der kein einziges Foto
 * gesehen hat, hat Richtung (2) nicht geprueft und darf nicht bestehen.
 *
 * SEIT 09/2026 zusaetzlich das, was die Seite ueber ihre Bilder SCHREIBT:
 *   (4) Das Impressum sagt, ein Teil des Bestandes habe keine belegbare Quelle. Diese
 *       Aussage wird gegen eine Zaehlung gehalten — in beide Richtungen, also auch
 *       "Aussage steht noch da, Bilder gibt es keine mehr". Siehe OHNE_QUELLE.
 *   (5) Kein unersetzter Platzhalter (__NAME__) auf den drei Seiten, die aus einer Datei
 *       mit Platzhaltern entstehen, und kein zweiter Ausgabepfad auf dieselbe Datei
 *       (/quiz.html muss auf /quiz umleiten).
 *
 * WOHER DIE ERWARTUNG KOMMT: aus scripts/bild-herkunft.js, der EINEN Ableitung, die auch
 * der Server benutzt. Hier wird nichts nachgebaut — stuende die Regel hier ein zweites Mal,
 * pruefte sich eine Fassung gegen die andere und keine gegen die Wirklichkeit.
 * stauden-server.js wird NICHT requiret: Die Datei hat kein module.exports und startet beim
 * Laden sofort den Listener. Sie wird deshalb als Kindprozess gestartet und ueber HTTP
 * befragt — dieselbe Bauart wie scripts/check-api-smoke.js.
 *
 * WELCHE DATENBANK: die Datei, die der Server selbst oeffnet, also <Repo>/stauden.db.
 * DB_PFAD WIRD BEWUSST IGNORIERT. Die Pin-Skripte lesen die Umgebungsvariable, der Server
 * nicht (stauden-server.js: `new Database(path.join(__dirname, 'stauden.db'))`). Wuerde
 * diese Pruefung DB_PFAD folgen, verglichen wir die Ausgabe des Servers mit Erwartungen aus
 * einer ANDEREN Datenbank — jede Abweichung waere dann ein Artefakt des Aufrufs und jeder
 * echte Befund unglaubwuerdig. Den Server auf DB_PFAD umzustellen waere eine Zeile,
 * betraefe aber den Produktionsstart: Eine in der Umgebung liegengebliebene Variable (die
 * Pin-Skripte setzen sie regelmaessig von Hand) liesse den Server still auf eine fremde
 * Datenbank zeigen — und der Server SCHREIBT dort (CREATE TABLE, anfragen, geteilte_plaene).
 * Dieses Risiko wiegt schwerer als der Gewinn. Die Pruefung laeuft deshalb dort, wo die
 * Daten liegen: im Deploy-Verzeichnis auf dem Server.
 *
 * WAS DIESE PRUEFUNG NICHT FINDET, OBWOHL EIN FEHLER VORLIEGT:
 *   - Sie prueft KONSISTENZ, nicht WAHRHEIT. Steht in der Datenbank bild_ki=0 an einem in
 *     Wahrheit erzeugten Bild, dessen Dateiname und Lizenz unauffaellig sind, dann ist die
 *     fehlende Marke hier „richtig". Die Wahrheit steht in den Daten, nicht im Ausgabepfad.
 *   - Die drei im Browser gerenderten Seiten (/, /pflanzen, /quiz) werden nur daraufhin
 *     geprueft, ob das Markup der Marke bzw. das Merkmal bild_herkunft ueberhaupt ankommt.
 *     Hier laeuft kein Browser: Ob das Skript die Marke dann auch setzt, sieht dieser Lauf
 *     nicht. Ein Fehler im Client-Template faellt nur auf, wenn er die Konstante verliert.
 *   - Sie liest Markup, nicht Bildschirm. Eine Marke, die per CSS verdeckt, ueberlagert oder
 *     beim Drucken weggelassen wird, besteht diese Pruefung.
 *   - Die Einzelpflanzenseiten werden als STICHPROBE abgefragt (sonst 711 SSR-Seiten je
 *     Lauf). Ein Fehler, der nur eine einzelne Pflanze trifft, kann durchrutschen; ein
 *     Fehler im Template trifft die Stichprobe sofort.
 *   - Geteilte Plaene (/plan/:id) und /api/plan kommen nicht vor: Der eine braucht einen
 *     gespeicherten Plan, der andere das Sprachmodell. Ihr Bildfeld stammt aus derselben
 *     Anreicherung wie /api/alternativ und /api/beispiel-plan, die hier geprueft werden.
 *   - Die Pin-Dateien unter /pins/ kommen hier nicht vor. Dafuer gibt es check:pin-meta.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const Database = require('better-sqlite3');
const BH = require('./bild-herkunft');

const WURZEL = path.resolve(__dirname, '..');
const DB_DATEI = path.join(WURZEL, 'stauden.db');
const PORT = Number(process.env.KI_PRUEF_PORT || 3311);
const BASIS = `http://127.0.0.1:${PORT}`;

/* LEERLAUFSPERRE: Ein Lauf, der nichts gesehen hat, besteht nicht.
 * Lokal fuehrt die Arbeitsdatenbank 226 Zeilen und KEINE einzige mit bild_ki=1 — eine
 * Pruefung ohne diese Schwellen meldete dort „alles in Ordnung" und sagte damit nur, dass
 * sie nichts gefunden hat. Die Zahlen sind bewusst niedrig gewaehlt: Sie sollen den
 * Leerlauf abfangen, nicht die Produktionsmenge nachbilden (299 KI-Bilder, 410 Fotos). */
const MIN_KI = Number(process.env.KI_PRUEF_MIN_KI || 20);
const MIN_FOTO = Number(process.env.KI_PRUEF_MIN_FOTO || 10);

let fehler = 0, offen = 0;
let gesehenKi = 0, gesehenFoto = 0, gesehenZurueckgehalten = 0;

const FEHLER = (wo, satz) => { fehler++; console.error(`FEHLER      ${wo}: ${satz}`); };
const UNGEPRUEFT = (wo, satz) => { offen++; console.warn(`UNGEPRUEFT  ${wo}: ${satz}`); };
const OK = (wo, satz) => console.log(`ok          ${wo}: ${satz}`);

// ─── HTTP ─────────────────────────────────────────────────────────────────────
function abrufen(pfad, { methode = 'GET', koerper = null } = {}) {
  return new Promise((loesen, ablehnen) => {
    const daten = koerper == null ? null : Buffer.from(JSON.stringify(koerper), 'utf8');
    const kopf = daten ? { 'Content-Type': 'application/json', 'Content-Length': daten.length } : {};
    const anfrage = http.request(BASIS + pfad, { method: methode, headers: kopf }, (antwort) => {
      const stuecke = [];
      antwort.on('data', c => stuecke.push(c));
      antwort.on('end', () => loesen({ status: antwort.statusCode || 0, text: Buffer.concat(stuecke).toString('utf8') }));
    });
    anfrage.on('error', ablehnen);
    if (daten) anfrage.write(daten);
    anfrage.end();
  });
}

async function warteAufServer(grenzeMs = 45000) {
  const start = Date.now();
  while (Date.now() - start < grenzeMs) {
    try {
      const a = await abrufen('/robots.txt');
      if (a.status >= 200 && a.status < 500) return true;
    } catch { /* noch nicht da */ }
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
}

const jsonAus = (antwort, wo) => {
  try { return JSON.parse(antwort.text); }
  catch { FEHLER(wo, `Antwort ist kein JSON (Status ${antwort.status}).`); return null; }
};

// ─── Datenbank: die Erwartung ────────────────────────────────────────────────
/* Der Selbsttest weiter unten prueft nur die Melder und braucht dafuer weder Datenbank noch
 * Server. Er muss deshalb an dieser Abbruchstelle vorbeikommen — nur so laeuft er auch auf
 * einem CI-Runner, der nach `npm ci` keine stauden.db hat (sie steht in .gitignore). */
const SELBSTTEST = process.argv.includes('--selbsttest');
if (!SELBSTTEST && !fs.existsSync(DB_DATEI)) {
  console.error(`FEHLER: ${DB_DATEI} fehlt — ohne die Datenbank des Servers ist nichts zu pruefen.`);
  console.error('Diese Pruefung gehoert auf den Server ins Deploy-Verzeichnis, nicht in den CI-Runner.');
  process.exit(1);
}
let zeilen = [];
if (fs.existsSync(DB_DATEI)) {
  const db = new Database(DB_DATEI, { readonly: true });
  zeilen = db.prepare(`SELECT id, name_deutsch, name_botanisch, ${BH.BILD_SPALTEN_SQL} FROM pflanzen`).all();
  db.close();
}

/* DIE DRITTE ZAEHLUNG: Fotos ohne belegte Quelle.
 *
 * Das Impressum sagt in Ziffer 4 und im Urheberrechtsabsatz, bei einem Teil des aelteren
 * Bestandes sei die urspruengliche Quelle beim lokalen Zwischenspeichern verloren gegangen.
 * Das ist eine Aussage im Praesens ueber eine MENGE — am 21.09.2026 sind das 79 Zeilen mit
 * bild_lizenz "lokal gecacht". Werden sie, wie geplant, durch eigene KI-Bilder ersetzt, ist
 * die Menge leer und der Satz beschreibt einen Bestand, den die Website nicht mehr fuehrt.
 * Ein solcher Rest faellt niemandem auf: Er ist nicht falsch genug, um jemandem zu schaden,
 * und niemand liest das Impressum gegen die Datenbank. Deshalb tut es dieser Lauf.
 *
 * Die Bedingung wird NICHT hier nachgebaut, sondern gefragt: kein KI-Bild, Herkunft
 * belastbar (bild_ki=0 ohne Widerspruch) und trotzdem KEIN Herkunftssatz — das ist genau
 * der Fall "die Datei liegt lokal, woher sie stammt, steht nirgends". Dieselbe Ableitung
 * entscheidet auch, dass am Bild kein Nachweis erscheint.
 */
const fotoOhneQuelle = (z) => {
  if (!String(z && z.bild_url || '').trim()) return false;
  const h = BH.bildHerkunft(z);
  return !h.ki && h.belegt && !h.text;
};
const OHNE_QUELLE = zeilen.filter(fotoOhneQuelle).length;
// Die Markierung, mit der das Impressum seine beiden Saetze dazu ausweist.
const IMPRESSUM_MARKER = 'data-beleg="fotos-ohne-quelle"';

const nachId = new Map(zeilen.map(z => [z.id, z]));
/* Mehrere Zeilen koennen dieselbe Bilddatei fuehren (Dubletten im Bestand). Deshalb eine
 * Liste je Adresse statt einer Zeile: Welche der Zeilen die Seite meint, sagt das Markup
 * nicht, und raten waere hier derselbe Fehler wie ein geratener Herkunftssatz. */
const nachBild = new Map();
for (const z of zeilen) {
  const u = String(z.bild_url || '').trim();
  if (!u) continue;
  if (!nachBild.has(u)) nachBild.set(u, []);
  nachBild.get(u).push(z);
}

/* Den Slug einer Adresse gegen den botanischen Namen halten, OHNE die Slug-Regel des Servers
 * nachzubauen: Beide Seiten werden auf reine Buchstaben und Ziffern heruntergekuerzt. Diese
 * Zuordnung entscheidet nichts ueber die Ausgabe, sie waehlt nur die Stichprobe aus; findet
 * sie nichts Eindeutiges, wird die Seite als ungeprueft gemeldet statt falsch bewertet. */
const kern = s => String(s || '').toLowerCase()
  .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
  .replace(/[^a-z0-9]+/g, '');
const nachKern = new Map();
for (const z of zeilen) {
  const k = kern(z.name_botanisch);
  if (!k) continue;
  if (!nachKern.has(k)) nachKern.set(k, []);
  nachKern.get(k).push(z);
}

const entRaus = s => String(s)
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&amp;/g, '&');

// ─── Die eine Kachelpruefung fuer jede server-gerenderte Seite ───────────────
/*
 * Jedes <img>, dessen Adresse in der Datenbank steht, wird gegen bild-herkunft.js gehalten.
 * Die Marke steht im Markup unmittelbar hinter ihrem Bild (so setzen es alle Templates);
 * gesucht wird deshalb nur im Fenster zwischen diesem <img> und dem naechsten — sonst wuerde
 * die Marke der Nachbarkachel dieser hier gutgeschrieben.
 */
const RX_IMG = /<img\b[^>]*?\bsrc="([^"]*)"[^>]*>/g;
function kachelnPruefen(html, wo) {
  const treffer = [...html.matchAll(RX_IMG)];
  let gezaehlt = 0;
  for (let i = 0; i < treffer.length; i++) {
    const m = treffer[i];
    const adresse = entRaus(m[1]);
    const kandidaten = nachBild.get(adresse);
    if (!kandidaten) continue;                       // Logo, Vorschaubild, Ratgeberbild
    const bis = i + 1 < treffer.length ? treffer[i + 1].index : html.length;
    const fenster = html.slice(m.index + m[0].length, bis);
    const hatMarke = fenster.includes('class="ki-marke"');
    const zeigbare = kandidaten.filter(BH.bildZeigbar);
    if (!zeigbare.length) {
      FEHLER(wo, `${adresse} wird ausgeliefert, obwohl die Herkunft nicht belegt ist (bildZeigbar=false).`);
      continue;
    }
    const erwartet = new Set(zeigbare.map(z => BH.bildHerkunft(z).ki));
    if (erwartet.size > 1) {
      UNGEPRUEFT(wo, `${adresse} steht an mehreren Zeilen mit verschiedenem bild_ki — welche die Seite meint, sagt das Markup nicht.`);
      continue;
    }
    const ki = [...erwartet][0];
    gezaehlt++;
    if (ki && !hatMarke) FEHLER(wo, `${adresse} ist ein KI-Bild (bild_ki=1), traegt aber keine Marke.`);
    else if (!ki && hatMarke) FEHLER(wo, `${adresse} ist kein KI-Bild, traegt aber die Marke „${BH.KI_MARKE_TEXT}".`);
    else if (ki) gesehenKi++;
    else gesehenFoto++;
  }
  return gezaehlt;
}

// ─── Die Merkmalspruefung fuer jede JSON-Antwort ─────────────────────────────
/*
 * Wer bild_url ausliefert, liefert bild_herkunft mit. `null` ist dabei eine gueltige
 * Antwort — sie heisst „nicht zeigen" (bildHerkunftOeffentlich). Das FEHLEN des Feldes ist
 * es nicht: Ein Empfaenger, der nur eine Adresse bekommt, kann nicht kennzeichnen.
 */
function merkmalPruefen(satz, wo, quelle) {
  if (!satz || typeof satz !== 'object') return;
  const adresse = String(satz.bild_url || '').trim();
  const hatFeld = Object.prototype.hasOwnProperty.call(satz, 'bild_herkunft');
  const ist = satz.bild_herkunft == null ? null : satz.bild_herkunft;
  if (!adresse) {
    /* Kein Bild, also auch keine Aussage ueber eines. Ein Merkmal ohne Adresse waere eine
     * Behauptung ins Leere — und im Planer der Fall, in dem Karte und Aussage auseinander
     * laufen. */
    if (ist !== null) FEHLER(wo, `liefert bild_herkunft (${JSON.stringify(ist)}), aber kein bild_url.`);
    return;
  }
  if (!hatFeld) {
    FEHLER(wo, `liefert bild_url (${adresse}) ohne das Feld bild_herkunft.`);
    return;
  }

  /* Die Erwartung kommt aus den Rohfeldern, wenn die Antwort sie mitschickt (/api/pflanzen,
   * /api/quiz-fragen), sonst aus den Datenbankzeilen zu dieser Bildadresse.
   * KEINE ZEILE ZUR ADRESSE ist dabei kein Grund zum Wegsehen, sondern eine Erwartung: Ueber
   * ein Bild, zu dem keine Zeile mehr steht, ist nichts belegt — das Merkmal MUSS dann null
   * sein. Genau so sieht ein eingefrorener Beispielplan aus, dessen Bildpfad von der
   * Datenbank abgewichen ist. */
  const erwartungen = quelle
    ? new Set([JSON.stringify(BH.bildHerkunftOeffentlich(quelle))])
    : new Set((nachBild.get(adresse) || []).map(z => JSON.stringify(BH.bildHerkunftOeffentlich(z))));
  if (erwartungen.size > 1) {
    UNGEPRUEFT(wo, `${adresse} steht an mehreren Zeilen mit verschiedener Herkunft — welche gemeint ist, sagt die Antwort nicht.`);
    return;
  }
  const erwartet = erwartungen.size ? JSON.parse([...erwartungen][0]) : null;
  if (JSON.stringify(erwartet) !== JSON.stringify(ist)) {
    FEHLER(wo, `bild_herkunft weicht ab fuer ${adresse}: erwartet ${JSON.stringify(erwartet)}, geliefert ${JSON.stringify(ist)}.`);
    return;
  }
  if (erwartet == null) { gesehenZurueckgehalten++; return; }
  if (erwartet.ki) gesehenKi++; else gesehenFoto++;
}

// ─── Selbsttest ──────────────────────────────────────────────────────────────
/*
 *   node scripts/check-ki-kennzeichnung.js --selbsttest
 *
 * Eine Pruefung, die noch nie etwas gefunden hat, ist eine Behauptung. Der Selbsttest haelt
 * den beiden Suchfunktionen erfundene Faelle hin — richtige und falsche — und prueft, ob sie
 * genau die falschen melden. Er braucht weder Server noch Produktionsdaten und laeuft
 * deshalb auch auf dem Arbeitsplatz durch. Er ersetzt den echten Lauf NICHT: Er belegt, dass
 * der Melder anschlaegt, nicht dass die Ausgabepfade in Ordnung sind.
 */
function selbsttest() {
  const kiZeile = { id: -1, name_botanisch: 'Testus kiensis', bild_url: '/t-ki.jpg', bild_ki: 1, bild_lizenz: BH.KI_LIZENZ };
  const fotoZeile = { id: -2, name_botanisch: 'Testus fotensis', bild_url: '/t-foto.jpg', bild_ki: 0, bild_lizenz: 'Pixabay License' };
  const stummZeile = { id: -3, name_botanisch: 'Testus ignotus', bild_url: '/t-stumm.jpg', bild_lizenz: null };
  for (const z of [kiZeile, fotoZeile, stummZeile]) nachBild.set(z.bild_url, [z]);
  const marke = BH.bildMarkeHTML({ bild_ki: 1 });
  const kachel = (url, mit) => `<div style="position:relative"><img src="${url}" alt="x">${mit ? marke : ''}</div>`;

  let schlecht = 0;
  const erwarte = (name, sollFehler, lauf) => {
    const vorher = fehler, vorherOffen = offen;
    lauf();
    const neu = fehler - vorher;
    offen = vorherOffen;
    fehler = vorher;
    const gut = neu === sollFehler;
    if (!gut) schlecht++;
    console.log(`${gut ? 'ok        ' : 'FEHLGESCHLAGEN'} ${name}: ${neu} Befund(e), erwartet ${sollFehler}`);
  };

  erwarte('richtige Kacheln melden nichts', 0,
    () => kachelnPruefen(kachel('/t-ki.jpg', true) + kachel('/t-foto.jpg', false), 'selbsttest'));
  erwarte('KI-Bild ohne Marke wird gefunden', 1,
    () => kachelnPruefen(kachel('/t-ki.jpg', false), 'selbsttest'));
  erwarte('Foto mit Marke wird gefunden', 1,
    () => kachelnPruefen(kachel('/t-foto.jpg', true), 'selbsttest'));
  erwarte('Marke der Nachbarkachel zaehlt nicht fuer diese', 2,
    () => kachelnPruefen(kachel('/t-ki.jpg', false) + kachel('/t-foto.jpg', true), 'selbsttest'));
  erwarte('Bild ohne belegte Herkunft wird gefunden', 1,
    () => kachelnPruefen(kachel('/t-stumm.jpg', false), 'selbsttest'));
  erwarte('JSON mit richtigem Merkmal meldet nichts', 0,
    () => merkmalPruefen({ bild_url: '/t-ki.jpg', bild_herkunft: BH.bildHerkunftOeffentlich(kiZeile) }, 'selbsttest', null));
  erwarte('JSON ohne Merkmal wird gefunden', 1,
    () => merkmalPruefen({ bild_url: '/t-foto.jpg' }, 'selbsttest', null));
  erwarte('JSON mit falschem Merkmal wird gefunden', 1,
    () => merkmalPruefen({ bild_url: '/t-foto.jpg', bild_herkunft: BH.bildHerkunftOeffentlich(kiZeile) }, 'selbsttest', null));
  erwarte('JSON, das ein zurueckgehaltenes Bild behauptet, wird gefunden', 1,
    () => merkmalPruefen({ bild_url: '/t-stumm.jpg', bild_herkunft: { ki: false, text: null, alt: '' } }, 'selbsttest', null));

  for (const z of [kiZeile, fotoZeile, stummZeile]) nachBild.delete(z.bild_url);
  console.log(schlecht ? `--- Selbsttest FEHLGESCHLAGEN (${schlecht}) ---` : '--- Selbsttest bestanden ---');
  process.exit(schlecht ? 1 : 0);
}

// ─── Lauf ────────────────────────────────────────────────────────────────────
if (SELBSTTEST) selbsttest();

(async () => {
  const kind = spawn('node', ['stauden-server.js'], {
    cwd: WURZEL,
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverLog = '';
  kind.stdout.on('data', d => { serverLog += d.toString(); });
  kind.stderr.on('data', d => { serverLog += d.toString(); });

  try {
    console.log('--- Pruefung: KI-Kennzeichnung auf allen Ausgabepfaden ---');
    console.log(`Datenbank: ${DB_DATEI} (${zeilen.length} Zeilen, davon ${zeilen.filter(z => BH.bildHerkunft(z).ki).length} mit bild_ki=1)`);

    if (!await warteAufServer()) {
      console.error('FEHLER: Der Server ist nicht erreichbar geworden.');
      console.error(serverLog.split(/\r?\n/).slice(-8).join('\n'));
      process.exitCode = 1;
      return;
    }

    // ── JSON: /api/pflanzen — vollstaendig, nicht als Stichprobe ─────────────
    {
      const wo = '/api/pflanzen';
      const antwort = await abrufen(wo);
      const liste = jsonAus(antwort, wo);
      if (Array.isArray(liste)) {
        for (const satz of liste) merkmalPruefen(satz, wo, satz.bild_ki !== undefined ? satz : null);
        OK(wo, `${liste.length} Datensaetze geprueft`);
      }
    }

    // ── JSON: /api/quiz-fragen ──────────────────────────────────────────────
    {
      const wo = '/api/quiz-fragen';
      const antwort = await abrufen('/api/quiz-fragen?n=20');
      const fragen = jsonAus(antwort, wo);
      if (Array.isArray(fragen)) {
        for (const f of fragen) merkmalPruefen(f, wo, nachId.get(f.id) || null);
        OK(wo, `${fragen.length} Fragen geprueft`);
      }
    }

    // ── JSON: /api/alternativ (Tausch einer Pflanze im Planer) ──────────────
    {
      const wo = 'POST /api/alternativ';
      const antwort = await abrufen('/api/alternativ', { methode: 'POST', koerper: { licht: 'Sonne', boden: 'normal', stil: 'Naturgarten' } });
      const daten = jsonAus(antwort, wo);
      if (daten && daten.pflanze) merkmalPruefen(daten.pflanze, wo, daten.pflanze.bild_ki !== undefined ? daten.pflanze : null);
      else if (daten) UNGEPRUEFT(wo, 'keine Pflanze in der Antwort — Ausgabepfad nicht geprueft.');
    }

    // ── JSON: /api/beispiel-plan/<slug> (acht SEO-Landeseiten) ──────────────
    for (const datei of fs.readdirSync(path.join(WURZEL, 'scripts')).filter(d => /^beispiel-plan-.*\.json$/.test(d))) {
      const slug = datei.replace(/^beispiel-plan-/, '').replace(/\.json$/, '');
      const wo = `/api/beispiel-plan/${slug}`;
      const antwort = await abrufen(wo);
      if (antwort.status !== 200) { UNGEPRUEFT(wo, `Status ${antwort.status}`); continue; }
      const plan = jsonAus(antwort, wo);
      const pflanzen = plan && (plan.pflanzen || (plan.plan && plan.plan.pflanzen));
      if (!Array.isArray(pflanzen)) { UNGEPRUEFT(wo, 'keine Pflanzenliste in der Antwort.'); continue; }
      for (const p of pflanzen) merkmalPruefen(p, wo, null);
    }

    // ── SSR: Kategorie-, Ratgeber-, Saison- und Beispielseiten ──────────────
    const seiten = ['/stauden-fuer-schatten', '/stauden-fuer-sonne', '/pflegeleichte-stauden',
                    '/bienenfreundliche-stauden', '/stauden-kombinieren', '/beispiele'];
    const karte = await abrufen('/sitemap.xml');
    const adressen = [...karte.text.matchAll(/<loc>https?:\/\/[^/]+([^<]*)<\/loc>/g)].map(m => m[1]);
    for (const vorsatz of ['/blueht-im/', '/winterbeet/', '/beispiel/', '/ratgeber/']) {
      const treffer = adressen.filter(a => a.startsWith(vorsatz)).slice(0, 2);
      if (!treffer.length) UNGEPRUEFT('sitemap.xml', `keine Adresse unter ${vorsatz} — dieser Ausgabepfad ist nicht geprueft.`);
      seiten.push(...treffer);
    }
    for (const seite of seiten) {
      const antwort = await abrufen(seite);
      if (antwort.status !== 200) { UNGEPRUEFT(seite, `Status ${antwort.status}`); continue; }
      OK(seite, `${kachelnPruefen(antwort.text, seite)} Bildkachel(n) geprueft`);
    }

    // ── SSR: Einzelpflanzenseiten als Stichprobe ────────────────────────────
    /* Die Adressen kommen aus der Sitemap des Servers, nicht aus einer hier nachgebauten
     * Slug-Regel. Ausgewaehlt wird je Fall: KI-Bild, Foto, zurueckgehaltenes Bild — sonst
     * belegt der Lauf nur die Richtung, die gerade haeufig vorkommt. */
    const pflanzenAdressen = adressen.filter(a => a.startsWith('/pflanze/'));
    const proben = { ki: [], foto: [], zurueck: [] };
    for (const adresse of pflanzenAdressen) {
      const kandidaten = nachKern.get(kern(adresse.slice('/pflanze/'.length))) || [];
      if (kandidaten.length !== 1) continue;                  // nicht eindeutig: keine Probe
      const z = kandidaten[0];
      if (!String(z.bild_url || '').trim()) continue;
      const fach = !BH.bildZeigbar(z) ? 'zurueck' : (BH.bildHerkunft(z).ki ? 'ki' : 'foto');
      if (proben[fach].length < 6) proben[fach].push({ adresse, z });
    }
    if (!proben.ki.length) UNGEPRUEFT('/pflanze/<slug>', 'keine Pflanzenseite mit KI-Bild in der Stichprobe.');
    if (!proben.foto.length) UNGEPRUEFT('/pflanze/<slug>', 'keine Pflanzenseite mit Foto in der Stichprobe.');
    OK('/pflanze/<slug>', `Stichprobe: ${proben.ki.length} mit KI-Bild, ${proben.foto.length} mit Foto, ${proben.zurueck.length} zurueckgehalten`);
    for (const fach of ['ki', 'foto', 'zurueck']) {
      for (const { adresse, z } of proben[fach]) {
        const antwort = await abrufen(adresse);
        if (antwort.status !== 200) { UNGEPRUEFT(adresse, `Status ${antwort.status}`); continue; }
        const html = antwort.text;
        /* Gegenprobe, dass die Seite wirklich diese Zeile zeigt: Die strukturierten Daten
         * fuehren den botanischen Namen. Passt er nicht, ist die Zuordnung falsch — dann
         * wird gemeldet statt bewertet. */
        const name = (html.match(/"name":\s*"([^"]*)"/) || [])[1];
        if (name && kern(name) !== kern(z.name_botanisch)) {
          UNGEPRUEFT(adresse, `zeigt „${name}", zugeordnet war „${z.name_botanisch}".`);
          continue;
        }
        kachelnPruefen(html, adresse);
        const ogBild = (html.match(/<meta property="og:image" content="([^"]*)"/) || [])[1] || '';
        const ogAlt = entRaus((html.match(/<meta property="og:image:alt" content="([^"]*)"/) || [])[1] || '');
        if (fach === 'zurueck') {
          /* og:image und JSON-LD sind eigene Ausgabepfade: Das Bild reist dort ohne Marke und
           * ohne Unterschrift zu Pinterest und in Messenger-Vorschauen. Was die Seite
           * zurueckhaelt, darf auch die Vorschau nicht verteilen. */
          gesehenZurueckgehalten++;
          if (html.includes(z.bild_url)) FEHLER(adresse, `haelt das Bild zurueck, gibt ${z.bild_url} aber trotzdem aus (og:image oder JSON-LD).`);
        } else {
          if (!ogBild.includes(z.bild_url)) FEHLER(adresse, `og:image zeigt nicht das Bild der Seite (${ogBild}).`);
          const kiTextDa = ogAlt.includes(BH.KI_TEXT);
          if (fach === 'ki' && !kiTextDa) FEHLER(adresse, 'og:image:alt nennt die Illustration nicht — in der Vorschau gibt es weder Marke noch Unterschrift.');
          if (fach === 'foto' && kiTextDa) FEHLER(adresse, 'og:image:alt nennt eine KI-Illustration, obwohl bild_ki=0 ist.');
          const unterschrift = BH.bildUnterschriftHTML(z);
          if (unterschrift && !html.includes(unterschrift)) FEHLER(adresse, 'die Bildunterschrift aus der gemeinsamen Ableitung fehlt.');
        }
      }
    }

    // ── Die drei im Browser gerenderten Seiten ──────────────────────────────
    /* Hier laeuft kein Browser. Geprueft wird nur, ob ueberhaupt ankommt, was der Client zum
     * Kennzeichnen braucht — dazu, dass KEIN Platzhalter stehengeblieben ist:
     * stauden-portal.html enthaelt `const KI_MARKE = __KI_MARKE__;`, unersetzt waere das ein
     * ReferenceError und das Planerskript tot; public/quiz.html nennt die Groesse des
     * Fragenvorrats als Platzhalter, unersetzt stuende die Zeichenkette im Fliesstext.
     * Gesucht wird nach dem MUSTER, nicht nach einzelnen Namen — sonst muesste jeder neue
     * Platzhalter hier nachgetragen werden, und genau das wuerde vergessen.
     * Beide Seiten setzen das Markenmarkup als JS-Zeichenkette ein (JSON.stringify), die
     * Anfuehrungszeichen darin stehen also maskiert im HTML. Gesucht wird deshalb nach
     * beiden Schreibweisen — die Marke ist dieselbe, nur einmal als Markup und einmal als
     * Literal. */
    const marke = BH.bildMarkeHTML({ bild_ki: 1 });
    const markeJs = JSON.stringify(marke).slice(1, -1);
    for (const [seite, was] of [['/', 'Kachelmarke'], ['/pflanzen', 'Kachelmarke'], ['/quiz', 'Merkmal bild_herkunft']]) {
      const antwort = await abrufen(seite);
      if (antwort.status !== 200) { UNGEPRUEFT(seite, `Status ${antwort.status}`); continue; }
      const offenePlatzhalter = [...new Set(antwort.text.match(/__[A-Z][A-Z0-9_]*__/g) || [])];
      if (offenePlatzhalter.length) FEHLER(seite, `Platzhalter nicht ersetzt: ${offenePlatzhalter.join(', ')}.`);
      const da = seite === '/quiz'
        ? antwort.text.includes('bild_herkunft')
        : (antwort.text.includes(marke) || antwort.text.includes(markeJs));
      if (!da) FEHLER(seite, `liefert die Kennzeichnung nicht mit (${was} fehlt).`);
      else OK(seite, `Kennzeichnung erreicht den Client (${was})`);
    }

    /* Die Datei public/quiz.html liegt unter public/ und waere ueber den statischen Ausleger
     * auch direkt erreichbar — dann mit unersetztem Platzhalter. Der zweite Ausgabepfad muss
     * deshalb auf den ersten zeigen. */
    {
      const wo = '/quiz.html';
      const antwort = await abrufen(wo);
      if (antwort.status === 301 || antwort.status === 302) OK(wo, 'leitet auf /quiz um (kein zweiter Ausgabepfad)');
      else FEHLER(wo, `liefert Status ${antwort.status} statt einer Umleitung auf /quiz — die Rohdatei geht mit Platzhalter hinaus.`);
    }

    // ── Impressum: die Aussage ueber Fotos ohne belegte Quelle ──────────────
    /* Zaehlung und Satz gehoeren zusammen; welcher von beiden fehlt, sagt die Meldung. Der
     * Vergleich steht weiter unten bei der Leerlaufsperre, weil die Richtung "keine solchen
     * Bilder mehr, Satz muss weg" nur gegen den vollen Bestand beurteilbar ist. */
    let markerImpressum = null;
    {
      const antwort = await abrufen('/impressum');
      if (antwort.status !== 200) UNGEPRUEFT('/impressum', `Status ${antwort.status}`);
      else markerImpressum = (antwort.text.match(new RegExp(IMPRESSUM_MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;
    }

    // ── Leerlaufsperre ──────────────────────────────────────────────────────
    console.log('---');
    console.log(`Geprueft: ${gesehenKi} KI-Bilder, ${gesehenFoto} Fotos, ${gesehenZurueckgehalten} zurueckgehaltene Bilder`);
    console.log(`Befunde: ${fehler} Fehler, ${offen} ungeprueft`);
    const genugGesehen = gesehenKi >= MIN_KI && gesehenFoto >= MIN_FOTO;

    /* Der Impressumssatz, in BEIDE Richtungen:
     *   Bilder da, Satz weg  -> FEHLER. Die Seite verschweigt, dass sie Bilder ohne
     *                           Quellenangabe zeigt.
     *   Bilder weg, Satz da  -> FEHLER. Die Seite beschreibt einen Bestand, den sie nicht
     *                           mehr fuehrt — die stehengebliebene Haelfte eines Rueckbaus.
     * Die zweite Richtung wird nur beurteilt, wenn der Lauf ueberhaupt gegen den vollen
     * Bestand lief: Auf dem alten Arbeitsstand waere "0 Bilder" kein Befund, sondern ein
     * Artefakt der Datenbank. */
    console.log(`Fotos ohne belegte Quelle: ${OHNE_QUELLE} (Impressum nennt sie an ${markerImpressum === null ? '?' : markerImpressum} Stelle(n))`);
    if (markerImpressum === null) {
      UNGEPRUEFT('/impressum', 'nicht abrufbar — die Aussage ueber Fotos ohne belegte Quelle ist ungeprueft.');
    } else if (OHNE_QUELLE > 0 && markerImpressum === 0) {
      FEHLER('/impressum', `${OHNE_QUELLE} Foto(s) ohne belegte Quelle im Bestand, aber das Impressum sagt dazu nichts (${IMPRESSUM_MARKER} fehlt).`);
    } else if (OHNE_QUELLE === 0 && markerImpressum > 0 && genugGesehen) {
      FEHLER('/impressum', `kein Foto ohne belegte Quelle mehr im Bestand, der Satz steht aber noch an ${markerImpressum} Stelle(n) (${IMPRESSUM_MARKER}) — beide entfernen.`);
    } else if (OHNE_QUELLE === 0 && markerImpressum > 0) {
      UNGEPRUEFT('/impressum', 'der Satz steht noch, im Bestand ist keine solche Zeile — nicht beurteilt, weil dieser Lauf nicht gegen den vollen Bestand lief.');
    } else {
      OK('/impressum', `${OHNE_QUELLE} Foto(s) ohne belegte Quelle, Satz an ${markerImpressum} Stelle(n) — passt zusammen.`);
    }

    if (!genugGesehen) {
      console.error(`FEHLER: Zu wenig gesehen (KI ${gesehenKi}/${MIN_KI}, Foto ${gesehenFoto}/${MIN_FOTO}).`);
      console.error('Diese Pruefung muss gegen die Produktionsdatenbank laufen — im Deploy-Verzeichnis auf');
      console.error('dem Server, wo stauden.db alle Zeilen fuehrt. Die Arbeitskopie hier ist ein alter');
      console.error('Teilstand ohne KI-Bilder; ein bestandener Lauf gegen sie wuerde nur belegen, dass');
      console.error('nichts geprueft wurde.');
      fehler++;
    }
    /* Ungeprueftes zaehlt nicht als bestanden, bricht den Lauf aber auch nicht ab: Wer eine
     * Seite nicht zuordnen kann, hat keinen Befund — er hat eine Luecke, und die gehoert
     * sichtbar in die Bilanz. */
    process.exitCode = fehler > 0 ? 1 : 0;
  } catch (e) {
    console.error(`FEHLER: Lauf abgebrochen — ${e.message}`);
    process.exitCode = 1;
  } finally {
    kind.kill('SIGINT');
    setTimeout(() => { if (!kind.killed) kind.kill('SIGKILL'); }, 1500);
  }
})();
