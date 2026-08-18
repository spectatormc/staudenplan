/*
 * Erzeugt alle Pinterest-Pins als Dateien unter public/pins/ und schreibt daneben
 * public/pins/liste.json mit Titel, Beschreibung, Ziellink und Pinnwand je Pin.
 *
 *   node scripts/pins-erzeugen.js                 alles, vorhandene Dateien bleiben stehen
 *   node scripts/pins-erzeugen.js --neu           vorhandene überschreiben
 *   node scripts/pins-erzeugen.js --nur pflanze   nur eine Sorte (pflanze|beetplan|saison|kombi|ratgeber)
 *   node scripts/pins-erzeugen.js --limit 5       höchstens N je Sorte, für Probeläufe
 *
 * WARUM DATEIEN UND NICHT AUF ZURUF: Pinterest lädt das Bild selbst von einer öffentlichen
 * Adresse — beim RSS-Weg wie über die API. Eine Route, die den Pin erst beim Abruf rendert,
 * hieße ImageMagick im Anfragepfad, und ein Pin braucht ein bis zwei Sekunden. Erzeugen ist
 * ein Stapellauf, Ausliefern macht express.static.
 *
 * DIE LISTE IST DIE QUELLE FÜR DEN FEED. Sie entsteht im selben Lauf wie die Bilder, damit
 * Bild und Text nicht auseinanderlaufen können — genau der Fehler, der am 18.08.2026 auffiel,
 * als die Vorschau 8 m² behauptete und der Pin daneben 6 m² zeigte.
 *
 * pubDate WIRD ÜBERNOMMEN, NICHT NEU GESETZT: Pinterest veröffentlicht aus einem Feed das
 * Älteste zuerst. Wer die Bilder neu erzeugt, darf die Reihenfolge nicht durcheinanderbringen
 * und schon veröffentlichte Pins nicht wieder nach vorn holen.
 */
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const WURZEL = path.join(__dirname, '..');
const ZIEL = path.join(WURZEL, 'public', 'pins');
const LISTE = path.join(ZIEL, 'liste.json');
const BASIS = 'https://www.staudenplan.de';

const argv = process.argv.slice(2);
const wert = name => {
  const gleich = argv.find(x => x.startsWith(`--${name}=`));
  if (gleich) return gleich.split('=').slice(1).join('=');
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : null;
};
const NEU = argv.includes('--neu');
const NUR = wert('nur');
const LIMIT = Number(wert('limit')) || 0;

const db = new Database(process.env.DB_PFAD || path.join(WURZEL, 'stauden.db'), { readonly: true });
const { giftigkeit } = require('./pflanzen-giftigkeit');
const txt = require('./pin-text');
const bildModul = require('./pin-bild');
const beetModul = require('./pin-beetplan');
const kombiModul = require('./pin-kombination');
const saisonModul = require('./pin-saison');
const ratgeberModul = require('./pin-ratgeber');

fs.mkdirSync(ZIEL, { recursive: true });
const vorher = fs.existsSync(LISTE) ? JSON.parse(fs.readFileSync(LISTE, 'utf8')) : [];
const frueher = Object.fromEntries(vorher.map(e => [e.guid, e]));

const liste = [];
let erzeugt = 0, vorhanden = 0, fehler = 0;

/*
 * Ein Eintrag entsteht nur, wenn die Bilddatei danach wirklich existiert. Ein Feed, der auf
 * ein fehlendes Bild zeigt, wird von Pinterest stillschweigend übergangen — der Pin fehlt
 * dann einfach, ohne dass irgendwo ein Fehler steht.
 */
async function bauen({ guid, datei, typ, machen, text }) {
  const pfad = path.join(ZIEL, datei);
  const dawar = fs.existsSync(pfad);
  if (!dawar || NEU) {
    try {
      await machen(pfad);
      erzeugt++;
    } catch (e) {
      console.error(`  ! ${datei}: ${e.message}`);
      fehler++;
      return;
    }
  } else {
    vorhanden++;
  }
  if (!fs.existsSync(pfad)) {
    console.error(`  ! Datei fehlt nach dem Erzeugen: ${datei}`);
    fehler++;
    return;
  }
  const t = text();
  liste.push({
    guid, typ, datei,
    bild: `${BASIS}/pins/${datei}`,
    titel: t.titel,
    beschreibung: t.beschreibung,
    link: t.link,
    alt: t.alt,
    board: t.board,
    bytes: fs.statSync(pfad).size,
    pubDate: frueher[guid]?.pubDate || new Date().toUTCString(),
    // Einmal vergebener Termin bleibt. Ein Neulauf der Bilder darf einen Pin nicht
    // umterminieren — und schon veroeffentlichte schon gar nicht.
    ...(frueher[guid]?.geplant_am ? { geplant_am: frueher[guid].geplant_am } : {}),
  });
}

(async () => {
  // ── Einzelpflanzen ─────────────────────────────────────────────────────────
  // ladePflanzen aus pin-saison bringt die vollständige Auswahlkette mit: bild_ki, eigener
  // deutscher Name, Beetstaude, hier winterhart, Bilddatei vorhanden.
  if (!NUR || NUR === 'pflanze') {
    let pflanzen = saisonModul.ladePflanzen(db);
    if (LIMIT) pflanzen = pflanzen.slice(0, LIMIT);
    console.log(`Einzelpflanzen: ${pflanzen.length}`);
    for (const p of pflanzen) {
      const slug = txt.slugify(p.name_botanisch);
      await bauen({
        guid: `pflanze-${slug}`, datei: `pflanze-${slug}.jpg`, typ: 'pflanze',
        machen: z => bildModul.pinBild(p, z),
        text: () => txt.textPflanze(p, giftigkeit),
      });
    }
  }

  // ── Beetpläne ──────────────────────────────────────────────────────────────
  if (!NUR || NUR === 'beetplan') {
    const uebersicht = await beetModul.holeSeite('/beispiele');
    let slugs = [...new Set([...uebersicht.matchAll(/href="\/beispiel\/([a-z-]+)"/g)].map(m => m[1]))];
    if (LIMIT) slugs = slugs.slice(0, LIMIT);
    console.log(`Beetpläne: ${slugs.length}`);
    for (const slug of slugs) {
      const html = await beetModul.holeSeite(`/beispiel/${slug}`);
      const gelesen = beetModul.ausSeiteLesen(html);
      const b = {
        slug,
        h1: (html.match(/<h1[^>]*>([^<]+)/) || [])[1],
        title: ((html.match(/<title>([^<|]+)/) || [])[1] || '').trim(),
        flaeche: (html.match(/Fläche<\/div>\s*<div[^>]*>([\d.,]+) m²/) || [])[1],
        licht: (html.match(/Licht<\/div>\s*<div[^>]*>([^<]+)/) || [])[1],
      };
      await bauen({
        guid: `beetplan-${slug}`, datei: `beetplan-${slug}.jpg`, typ: 'beetplan',
        machen: z => beetModul.beetPin(b, z),
        text: () => txt.textBeetplan(b, gelesen.namen.length, gelesen.gift),
      });
    }
  }

  // ── Saison ─────────────────────────────────────────────────────────────────
  if (!NUR || NUR === 'saison') {
    const pool = saisonModul.ladePflanzen(db);
    let monate = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
    if (LIMIT) monate = monate.slice(0, LIMIT);
    console.log(`Saison: ${monate.length} Monate`);
    for (const m of monate) {
      const s = saisonModul.saisonAuswahl(pool, { monat: m });
      if (!s) { console.error(`  ! Monat ${m}: keine Auswahl`); fehler++; continue; }
      await bauen({
        guid: `saison-${m}`, datei: `saison-${String(m).padStart(2, '0')}.jpg`, typ: 'saison',
        machen: z => saisonModul.saisonPin(s, z),
        text: () => txt.textSaison(s, giftigkeit),
      });
    }
  }

  // ── Kombinationen ──────────────────────────────────────────────────────────
  // Je Standort die bestbewertete statt der besten N insgesamt: Sonst entstünden zwanzig
  // Varianten derselben Schattenpflanzung, und Pinterest wertet Fast-Dubletten als Spam.
  if (!NUR || NUR === 'kombi') {
    const pool = kombiModul.ladePflanzen(db);
    const jeStandort = {};
    for (const k of kombiModul.findeKombinationen(pool, { anzahl: 200 })) {
      const s = `${k.licht}/${k.feuchte}`;
      if (!jeStandort[s]) jeStandort[s] = k;
    }
    let kombis = Object.entries(jeStandort);
    if (LIMIT) kombis = kombis.slice(0, LIMIT);
    console.log(`Kombinationen: ${kombis.length} (eine je Standort)`);
    for (const [standort, k] of kombis) {
      const slug = txt.slugify(standort);
      await bauen({
        guid: `kombi-${slug}`, datei: `kombi-${slug}.jpg`, typ: 'kombi',
        machen: z => kombiModul.kombiPin(k, z),
        text: () => txt.textKombination(k, giftigkeit),
      });
    }
  }

  // ── Ratgeber ───────────────────────────────────────────────────────────────
  // Trägt November bis Februar: Der Blühbeginn der 278 pinnbaren Stauden ballt sich im Juni,
  // im Winter gäbe es aus der Pflanzentabelle fast nichts zu zeigen.
  if (!NUR || NUR === 'ratgeber') {
    let artikel = ratgeberModul.ladeArtikel(db);
    if (LIMIT) artikel = artikel.slice(0, LIMIT);
    console.log(`Ratgeber: ${artikel.length}`);
    for (const a of artikel) {
      const slug = txt.slugify(a.titel);
      const teaser = ratgeberModul.ersterSatz(a.inhalt, 60, 480);
      await bauen({
        guid: `ratgeber-${slug}`, datei: `ratgeber-${slug}.jpg`, typ: 'ratgeber',
        machen: z => ratgeberModul.ratgeberPin(a, z),
        text: () => txt.textRatgeber(a, teaser),
      });
    }
  }

  /* Bei --nur <sorte> nur DIESE Sorte neu aufbauen und die uebrigen aus der alten Liste
   * uebernehmen. Ohne das loescht ein "--nur ratgeber" die 306 anderen Eintraege aus der
   * Liste — der Feed liefert dann nichts mehr, obwohl alle Bilder noch da liegen. */
  if (NUR) {
    const behalten = vorher.filter(e => e.typ !== NUR && fs.existsSync(path.join(ZIEL, e.datei)));
    console.log(`--nur ${NUR}: ${behalten.length} Eintraege anderer Sorten uebernommen`);
    liste.push(...behalten);
  }

  liste.sort((a, b) => a.guid.localeCompare(b.guid));
  fs.writeFileSync(LISTE, JSON.stringify(liste, null, 1));

  const jeBrett = {};
  for (const e of liste) jeBrett[e.board] = (jeBrett[e.board] || 0) + 1;
  const zuGross = liste.filter(e => e.bytes > 20 * 1024 * 1024);

  console.log(`\n${liste.length} Pins in der Liste · ${erzeugt} neu · ${vorhanden} unverändert · ${fehler} Fehler`);
  for (const [b, n] of Object.entries(jeBrett).sort((x, y) => y[1] - x[1])) {
    console.log(`  ${String(n).padStart(4)}  ${b}`);
  }
  // Pinterest nimmt Bilder bis 20 MB. Die Pins liegen bei 150-300 kB, aber eine stille
  // Überschreitung wäre ein Pin, der ohne Meldung nie erscheint.
  if (zuGross.length) console.log(`\n! ${zuGross.length} Pin(s) über 20 MB — Pinterest lehnt die ab.`);
  console.log(`\nListe: ${LISTE}`);
  if (fehler) process.exitCode = 1;
})().catch(e => { console.error('Abbruch:', e.stack || e.message); process.exit(1); });
