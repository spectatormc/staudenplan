/*
 * Erzeugt Titel, Beschreibung und Ziellink zu einem Pin.
 *
 *   node scripts/pin-text.js --probe        Beispieltexte aller vier Pin-Sorten
 *
 * KEINE SPRACHMODELL-TEXTE. Das ist eine bewusste Entscheidung, kein Sparzwang: Ein
 * unbeaufsichtigtes Skript, das täglich frei formulierte Pflanzenaussagen im Namen der
 * Gartenschmiede GmbH veröffentlicht, lässt sich nicht wie eine Webseite per Deploy
 * zurücknehmen — ein Pin ist draußen, sobald er draußen ist. Alles hier steht in Vorlagen,
 * gefüllt aus geprüften Datenbankfeldern. Jede Aussage im Text ist damit nachprüfbar, und
 * die Vorschau unter /admin/pins zeigt vorab exakt das, was veröffentlicht wird.
 *
 * Die Abwechslung kommt aus den Daten, nicht aus der Formulierung: Bei 287 Pflanzen,
 * 151634 Kombinationen und zwölf Monaten wiederholt sich der Satzbau, aber nie der Inhalt.
 * Zusätzlich gibt es je Sorte mehrere Vorlagen, die fest aus den Daten ausgewählt werden —
 * derselbe Pin ergibt immer denselben Text, was für die Vorschau nötig ist.
 *
 * Pinterest ist eine Suchmaschine, keine Zeitleiste: Die Beschreibung enthält deshalb die
 * Begriffe, nach denen dort tatsächlich gesucht wird („Beetplan", „Bepflanzungsplan",
 * „Staudenbeet", „Schattenbeet"), in ganzen Sätzen statt als Schlagwortliste.
 */
const L = require('./pin-layout');

const BASIS = 'https://www.staudenplan.de';
const HERKUNFT = '?utm_source=pinterest&utm_medium=pin';

// Pinterest kappt hart. Lieber selbst an einer Wortgrenze kürzen als mitten im Wort.
const TITEL_MAX = 100, BESCHREIBUNG_MAX = 500;

function kuerzen(text, max) {
  const t = String(text).replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  const schnitt = t.slice(0, max - 1);
  return schnitt.slice(0, schnitt.lastIndexOf(' ')).replace(/[,;–-]$/, '').trim() + '…';
}

const slugify = s => String(s).toLowerCase()
  .replace(/ä/g,'ae').replace(/ö/g,'oe').replace(/ü/g,'ue').replace(/ß/g,'ss')
  .replace(/['']/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

// Feste Auswahl aus den Daten statt Zufall — die Vorschau muss zeigen, was später kommt.
const wahl = (liste, zahl) => liste[Math.abs(Math.round(zahl)) % liste.length];

const LICHT_ORT = { sonne: 'sonnige Beete', halbschatten: 'den Halbschatten', schatten: 'schattige Ecken' };
const LICHT_SEITE = { sonne: '/stauden-fuer-sonne', halbschatten: '/staudenbeet-planen', schatten: '/stauden-fuer-schatten' };
// Die Standortwerte stehen kleingeschrieben in der Datenbank. Ungefiltert stand im Text
// „für schatten" und „Standort: halbschatten" — in einem Fließtext ist das schlicht falsch.
const LICHT_DATIV = { sonne: 'sonnige Standorte', halbschatten: 'den Halbschatten', schatten: 'den Schatten' };
const gross = s => { const t = String(s || '').trim(); return t.charAt(0).toUpperCase() + t.slice(1); };

/* Giftbefund als ganzer Satz. Steht im Text, nicht nur im Bild: Wer den Pin teilt, gibt oft
 * nur die Beschreibung weiter, und die Warnung darf dabei nicht verloren gehen. */
function giftSatz(pflanzen, giftigkeit) {
  const treffer = pflanzen.map(p => ({ p, g: giftigkeit(p.name_botanisch) })).filter(x => x.g);
  if (!treffer.length) return '';
  treffer.sort((a, b) => (L.GIFT_RANG[a.g.stufe] ?? 9) - (L.GIFT_RANG[b.g.stufe] ?? 9));
  if (treffer.length === 1) {
    const { p, g } = treffer[0];
    return g.stufe === 'stark'
      ? `Achtung: ${p.name_deutsch} ist stark giftig — in Gärten mit kleinen Kindern besser weglassen.`
      : `Hinweis: ${L.GIFT_LABEL[g.stufe]} — ${p.name_deutsch}.`;
  }
  const stark = treffer.filter(x => x.g.stufe === 'stark').map(x => x.p.name_deutsch);
  const rest = treffer.filter(x => x.g.stufe !== 'stark').map(x => x.p.name_deutsch);
  return (stark.length ? `Achtung, stark giftig: ${stark.join(', ')}. ` : '')
       + (rest.length ? `Giftig: ${rest.join(', ')}.` : '').trim();
}

/*
 * Bei „stark giftig" gehört die Warnung an den Anfang, sonst ans Ende. Grund: Pinterest
 * zeigt in der Vorschau nur die ersten Zeilen der Beschreibung. Ein Hinweis auf Eisenhut,
 * der erst hinter Standort und Blütezeit steht, wird von den meisten nie gelesen. Bei den
 * schwächeren Stufen bleibt er hinten — sonst wirkt jede zweite Staude wie eine Warnung
 * und die ernsten Fälle gehen im Rauschen unter.
 */
function vornAnstellen(teile, satz) {
  if (!satz) return teile;
  if (/^Achtung/.test(satz)) teile.unshift(satz); else teile.splice(teile.length - 1, 0, satz);
  return teile;
}

/* ── Einzelpflanze ───────────────────────────────────────────────────────────── */
function textPflanze(p, giftigkeit) {
  const licht = [...L.mengeAus(p.licht)][0] || 'sonne';
  const hoehe = p.hoehe_cm_max ? `${p.hoehe_cm_max} cm` : null;
  const bluehzeit = L.spanne(p.bluehzeit) ? String(p.bluehzeit).replace(/\s*-\s*/, ' bis ') : null;

  const titel = wahl([
    `${p.name_deutsch} pflanzen: Standort, Blütezeit und Pflege`,
    bluehzeit ? `${p.name_deutsch}: blüht ${bluehzeit}${hoehe ? `, ${hoehe} hoch` : ''}` : `${p.name_deutsch} im Staudenbeet`,
    `${p.name_deutsch} für ${LICHT_ORT[licht] || 'das Staudenbeet'}`,
  ], p.id);

  const teile = [
    `${p.name_deutsch} (${p.name_botanisch})${bluehzeit ? ` blüht ${bluehzeit}` : ''}${hoehe ? ` und wird ${hoehe} hoch` : ''}.`,
    p.licht ? `Standort: ${String(p.licht).replace(/\|/g, ' oder ')}${p.feuchtigkeit ? `, ${String(p.feuchtigkeit).split('|')[0]}er Boden` : ''}.` : '',
    p.bienen_freundlich ? 'Bienenfreundlich.' : '',
    p.heimisch ? 'Heimische Art.' : '',
    'Passendes Staudenbeet dazu planen: kostenlos auf staudenplan.de, mit Pflanzplan zum Ausdrucken.',
  ].filter(Boolean);
  vornAnstellen(teile, giftSatz([p], giftigkeit));

  return fertig({
    titel, beschreibung: teile.join(' '),
    pfad: `/pflanze/${slugify(p.name_botanisch)}`,
    alt: `${p.name_deutsch}, ${p.name_botanisch} — Illustration`,
    board: brett(licht),
    kiBild: true,
  });
}

/* Derselbe Befund wie in giftSatz(), aber aus den Gruppen, die pin-beetplan.js aus der Seite
 * liest. Der Beetplan kennt nur deutsche Namen — die Legende der Beispielseite führt keine
 * botanischen —, deshalb kann giftigkeit() hier nicht angewandt werden. Die Einstufung hat die
 * Seite bereits vorgenommen; hier wird sie nur noch in einen Satz gegossen.
 */
function giftSatzAusGruppen(gift) {
  if (!gift || !gift.length) return '';
  const sortiert = [...gift].sort((a, b) => (L.GIFT_RANG[a.stufe] ?? 9) - (L.GIFT_RANG[b.stufe] ?? 9));
  const stark = sortiert.filter(g => g.stufe === 'stark');
  const rest = sortiert.filter(g => g.stufe !== 'stark');
  // Einzelfall wie in giftSatz() ausformuliert: "Eisenhut ist stark giftig" liest sich als
  // Warnung, "Stark giftig: Eisenhut" eher wie eine Rubrik.
  if (stark.length === 1 && !rest.length && !stark[0].namen.includes(',')) {
    return `Achtung: ${stark[0].namen} ist stark giftig — in Gärten mit kleinen Kindern besser weglassen.`;
  }
  return ((stark.length ? `Achtung, stark giftig: ${stark.map(g => g.namen).join(', ')}. ` : '')
       + rest.map(g => `${g.beschriftung}: ${g.namen}.`).join(' ')).trim();
}

/* ── Beetplan ────────────────────────────────────────────────────────────────── */
function textBeetplan(b, arten, gift) {
  const titel = wahl([
    `${b.h1 || b.title}`,
    `${b.title}: fertiger Bepflanzungsplan mit ${arten} Stauden`,
    `Beetplan zum Nachpflanzen: ${b.title}`,
  ], (b.slug || '').length);

  const teile = [
    `Fertiger Bepflanzungsplan mit ${arten} Stauden${b.flaeche ? ` auf ${b.flaeche} m²` : ''}${b.licht ? ` für ${LICHT_DATIV[String(b.licht).toLowerCase()] || String(b.licht).toLowerCase()}` : ''}.`,
    'Alle Pflanzen mit Namen, Blütezeit und Stückzahl — zum Nachpflanzen oder als Anregung fürs eigene Beet.',
    'Den kompletten Plan mit Skizze gibt es kostenlos auf staudenplan.de.',
  ];

  // Bis zum 18.08.2026 war der Beetplan die einzige der vier Textsorten ohne Giftsatz — die
  // Signatur bekam nur eine ANZAHL statt der Pflanzen, es gab schlicht nichts zu prüfen.
  const teileMitGift = vornAnstellen(teile, giftSatzAusGruppen(gift));

  return fertig({
    titel, beschreibung: teileMitGift.join(' '),
    pfad: `/beispiel/${b.slug}`,
    alt: `Bepflanzungsplan ${b.title} mit ${arten} Stauden — Skizze mit nummerierten Pflanzen`,
    board: 'Bepflanzungspläne',
  });
}

/* ── Kombination ─────────────────────────────────────────────────────────────── */
function textKombination(k, giftigkeit) {
  const d = k.pflanzen;
  const von = L.MON_NAME[k.von - 1], bis = L.MON_NAME[k.bis - 1];
  const ort = LICHT_ORT[k.licht] || 'das Staudenbeet';

  const titel = wahl([
    `3 Stauden, die von ${von} bis ${bis} blühen`,
    `Staudenkombination für ${ort}: ${von} bis ${bis} in Blüte`,
    `${von} bis ${bis} durchgehend Blüte — 3 Stauden, die zusammenpassen`,
  ], d[0].id + k.monate);

  const teile = [
    `${d.map(p => p.name_deutsch).join(', ')} — drei Stauden für ${ort}, die nacheinander blühen.`,
    `Erst ${d[0].name_deutsch}, dann ${d[1].name_deutsch}, ab ${L.MON_NAME[L.spanne(d[2].bluehzeit)[0] - 1]} ${d[2].name_deutsch}. So steht das Beet von ${von} bis ${bis} nie leer.`,
    `Alle drei wollen denselben Standort: ${gross(k.licht)}, ${k.feuchte}er Boden.`,
    'Eigenen Beetplan mit passenden Stauden erstellen: kostenlos auf staudenplan.de.',
  ].filter(Boolean);
  vornAnstellen(teile, giftSatz(d, giftigkeit));

  return fertig({
    titel, beschreibung: teile.join(' '),
    pfad: '/stauden-kombinieren',
    alt: `Staudenkombination ${d.map(p => p.name_deutsch).join(', ')} mit Blühkalender von ${von} bis ${bis}`,
    board: brett(k.licht),
    kiBild: true,
  });
}

/* ── Saison ──────────────────────────────────────────────────────────────────── */
function textSaison(s, giftigkeit) {
  const monat = L.MON_NAME[s.monat - 1];
  const pflanzen = s.auswahl.map(x => x.p);

  const titel = s.winter
    ? wahl([`Struktur im Winterbeet: 6 Stauden, die nach der Blüte stehen bleiben`,
            `Winterbeet: 6 Stauden mit Samenständen und Gräserstruktur`], s.monat)
    : wahl([`Was im ${monat} blüht: 6 Stauden fürs Beet`,
            `${monat}: 6 Stauden, die jetzt blühen`,
            `Blüht im ${monat} — 6 Stauden mit Höhe und Standort`], s.monat);

  const teile = s.winter ? [
    `${pflanzen.map(p => p.name_deutsch).join(', ')} — sechs Stauden, die auch nach der Blüte etwas hermachen.`,
    'Samenstände und Gräser erst im Frühjahr zurückschneiden: Sie halten den Winter über Struktur und bieten Insekten Quartier.',
    'Eigenes Staudenbeet planen: kostenlos auf staudenplan.de.',
  ] : [
    `Sechs Stauden, die im ${monat} blühen: ${pflanzen.map(p => p.name_deutsch).join(', ')}.`,
    'Mit Höhe und Standort, damit sie sich direkt einplanen lassen.',
    `Passendes Staudenbeet zusammenstellen: kostenlos auf staudenplan.de, mit Pflanzplan zum Ausdrucken.`,
  ];
  vornAnstellen(teile, giftSatz(pflanzen, giftigkeit));

  return fertig({
    titel, beschreibung: teile.filter(Boolean).join(' '),
    pfad: s.standort ? LICHT_SEITE[s.standort] : (s.winter ? '/staudenbeet-planen' : '/staudenbeet-planen'),
    alt: s.winter ? 'Sechs Stauden mit Winterstruktur' : `Sechs Stauden, die im ${monat} blühen`,
    board: s.winter ? 'Winterbeet' : `Was blüht wann`,
    kiBild: true,
  });
}

const brett = licht => ({ sonne: 'Stauden für sonnige Beete', halbschatten: 'Stauden für den Halbschatten',
                          schatten: 'Stauden für den Schatten' })[licht] || 'Staudenbeet planen';

/* Der KI-Hinweis wird VOR dem Kuerzen vom Budget abgezogen, nicht hinterher angehaengt.
 * Sonst faellt genau die Kennzeichnung als Erstes weg, wenn eine Beschreibung ans Limit
 * stoesst — und zwar unbemerkt, weil kuerzen() still arbeitet. Betroffen sind die drei
 * Sorten mit erzeugtem Pflanzenbild; der Beetplan-Pin zeigt eine gezeichnete Beetskizze
 * und keine Illustration, dort waere der Satz schlicht falsch. */
const KI_HINWEIS = ' Bild: KI-erzeugte Illustration.';

function fertig({ titel, beschreibung, pfad, alt, board, kiBild }) {
  const hinweis = kiBild ? KI_HINWEIS : '';
  return {
    titel: kuerzen(titel, TITEL_MAX),
    beschreibung: kuerzen(beschreibung, BESCHREIBUNG_MAX - hinweis.length) + hinweis,
    link: BASIS + pfad + HERKUNFT,
    alt: kuerzen(alt, 500),
    board,
  };
}

if (require.main === module) {
  const Database = require('better-sqlite3');
  const path = require('path');
  const { giftigkeit } = require('./pflanzen-giftigkeit');
  const db = new Database(process.env.DB_PFAD || path.join(__dirname, '..', 'stauden.db'), { readonly: true });

  const zeig = (was, t) => {
    console.log(`\n── ${was} ──`);
    console.log(`Titel (${t.titel.length}/${TITEL_MAX}):  ${t.titel}`);
    console.log(`Beschreibung (${t.beschreibung.length}/${BESCHREIBUNG_MAX}):\n  ${t.beschreibung}`);
    console.log(`Link:  ${t.link}`);
    console.log(`Pinnwand:  ${t.board}`);
  };

  const kombiModul = require('./pin-kombination');
  const saisonModul = require('./pin-saison');
  const beetModul = require('./pin-beetplan');

  (async () => {
    const p = db.prepare("SELECT * FROM pflanzen WHERE name_botanisch = 'Aconitum napellus'").get()
           || db.prepare('SELECT * FROM pflanzen WHERE bild_ki = 1 LIMIT 1').get();
    zeig('Einzelpflanze', textPflanze(p, giftigkeit));

    // Der Beetplan-Text wird aus der LAUFENDEN SEITE gebaut, nicht aus Beispielwerten. Bis zum
    // 18.08.2026 standen hier feste Zahlen (8 m², Schatten) — das echte Schattenbeet hat 6 m²
    // und Halbschatten. Die Vorschau widersprach also dem Bild, das daneben erzeugt wurde.
    // Eine Vorschau, die etwas anderes zeigt als die Veröffentlichung, ist keine.
    try {
      const html = await beetModul.holeSeite('/beispiel/schattenbeet');
      const { namen, gift } = beetModul.ausSeiteLesen(html);
      const beispiel = {
        slug: 'schattenbeet',
        h1: (html.match(/<h1[^>]*>([^<]+)/) || [])[1],
        title: (html.match(/<title>([^<|]+)/) || [])[1] || '',
        flaeche: (html.match(/Fläche<\/div>\s*<div[^>]*>([\d.,]+) m²/) || [])[1],
        licht: (html.match(/Licht<\/div>\s*<div[^>]*>([^<]+)/) || [])[1],
      };
      beispiel.title = beispiel.title.trim();
      zeig('Beetplan', textBeetplan(beispiel, namen.length, gift));
    } catch (e) {
      console.log('\n── Beetplan ──');
      console.log('  übersprungen: ' + e.message);
      console.log('  (braucht den laufenden Server — PIN_PORT setzen, wenn er nicht auf 3003 läuft.');
      console.log('   Feste Beispielwerte gibt es hier bewusst nicht mehr: Sie widersprachen dem Pin.)');
    }

    const k = kombiModul.findeKombinationen(kombiModul.ladePflanzen(db), { anzahl: 1 })[0];
    if (k) zeig('Kombination', textKombination(k, giftigkeit));

    const sp = saisonModul.ladePflanzen(db);
    for (const m of [8, 12]) {
      const s = saisonModul.saisonAuswahl(sp, { monat: m });
      if (s) zeig(`Saison (${L.MON_NAME[m - 1]})`, textSaison(s, giftigkeit));
    }
  })().catch(e => { console.error('Fehler:', e.message); process.exit(1); });
}

module.exports = { textPflanze, textBeetplan, textKombination, textSaison, kuerzen, slugify };
