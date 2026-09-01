/*
 * Gleicht preis_stueck_eur mit den echten Listenpreisen der Staudengärtnerei Gaißmayer ab.
 *
 *   node scripts/preise-gaissmayer.js --holen        # Katalog laden (17 Abrufe, ~17 Min)
 *   node scripts/preise-gaissmayer.js                # Bericht, ändert nichts
 *   node scripts/preise-gaissmayer.js --schreiben    # Preise in die DB übernehmen
 *   node scripts/preise-gaissmayer.js --csv          # Bericht als CSV
 *
 * Warum überhaupt: Die Preise stammen aus den Seed-Läufen, in denen das Modell einen
 * „realistischen Gärtnerei-Preis" schätzen sollte (scripts/seed-pflanzen-500.js:313). Geprüft
 * hat sie nie jemand. Eine Stichprobe von 13 Arten gegen den Shop ergab einen Warenkorb von
 * 93,90 € bei uns gegen 69,20 € dort — und zwar nicht als gleichmäßiger Aufschlag, sondern
 * als Streuung in beide Richtungen: Aruncus dioicus +70 %, Ajuga reptans −24 %. Ein
 * Pauschalfaktor hätte die zu billigen Arten nur weiter nach unten gezogen. Deshalb der
 * Abgleich Art für Art.
 *
 * Die Preise wirken doppelt: Sie stehen im Plan („Richtpreis") UND begrenzen ihn — die
 * Budget-Kappung in stauden-server.js rechnet mit genau diesen Zahlen. Zu hohe Preise heißt
 * also nicht nur „sieht teuer aus", sondern auch „weniger Pflanzen fürs selbe Geld".
 *
 * Quelle ist die Produktliste des Shops, nicht 709 Einzelsuchen: Mit pagination[count]=200
 * liegt der gesamte Katalog in 17 Abrufen vor. Die robots.txt verlangt Crawl-Delay: 60 —
 * das hält --pause per Voreinstellung ein. Der Rohkatalog landet in data/, damit ein zweiter
 * Lauf ohne einen einzigen weiteren Abruf auskommt.
 */
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const arg = n => process.argv.includes(n);
const argWert = (n, std) => {
  const i = process.argv.indexOf(n);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : std;
};

const KATALOG = path.join(__dirname, '..', 'data', 'gaissmayer-katalog.json');
const OHNE_TREFFER = path.join(__dirname, '..', 'data', 'gaissmayer-ohne-treffer.json');
const BASIS = 'https://www.gaissmayer.de/web/shop/suche/produkte/';
const UA = 'staudenplan.de Preisabgleich (rohrhuberbastian@gmail.com)';
const PAUSE_MS = Number(argWert('--pause', 60000)); // robots.txt: Crawl-Delay: 60
const PRO_SEITE = 200;

// ─── Katalog holen ──────────────────────────────────────────────────────────

const seitenUrl = (seite) =>
  `${BASIS}?filter%5Bartikel%5D%5Btext_suche%5D%5Bwerte%5D%5B0%5D=&pagination%5Bpage%5D=${seite}&pagination%5Bcount%5D=${PRO_SEITE}`;

/*
 * Ein Produkt je Karte. Der Shop rendert jede Karte als <div id="artikel-NNNN">, deshalb
 * wird am Marker zerlegt und jede Karte einzeln gelesen — eine globale Regex über die ganze
 * Seite würde bei Karten ohne Preis (nicht lieferbar, Preis auf Anfrage) den Preis der
 * nächsten Karte danebenlegen.
 */
function parseSeite(html) {
  return html.split(/id="artikel-/).slice(1).map(block => {
    const t = block.replace(/\s+/g, ' ');
    const id = (t.match(/^(\d+)/) || [])[1] || null;
    const titel = t.match(/<h5 class="card-title[^>]*>\s*<a href="([^"]+)"[^>]*>([^<]*)<\/a>/);
    if (!titel) return null;
    const url = titel[1];
    // "Acaena buchananii &ndash; Blaugrünes Stachelnüsschen" → botanisch | deutsch
    const [botRoh, deutschRoh] = titel[2].split('&ndash;');
    const preisM = t.match(/<span class='h4'>\s*([\d.]*\d,\d{2})\s*€/);
    // Die Einheit steht im <small> neben dem Preis und darf ein <br> enthalten — bei
    // Zwiebeln lautet sie "Zwiebeln / Knollen<br>5 Stück pro Päckchen". Ein Muster, das an
    // jedem "<" abbricht, verlor genau diese Zeile und damit alle Geophyten.
    const einheitM = t.match(/<small class='ml-2 text-truncate'>([\s\S]*?)<\/small>/);
    const einheit = einheitM ? entschaerfe(einheitM[1].replace(/<br\s*\/?>/gi, ' · ').replace(/<[^>]+>/g, '')) : null;
    // Zwiebeln verkauft die Gärtnerei im Päckchen, Stauden im Topf. Unser preis_stueck_eur
    // wird im Plan mit der Stückzahl multipliziert — der Päckchenpreis muss also durch
    // seinen Inhalt geteilt werden, sonst kostet eine Allium-Zwiebel bei uns das Fünffache.
    const proM = einheit && einheit.match(/(\d+)\s*Stück/i);
    const packung = proM ? Number(proM[1]) : 1;
    const preis = preisM ? Number(preisM[1].replace(/\./g, '').replace(',', '.')) : null;
    return {
      id,
      name_botanisch: entschaerfe(botRoh),
      name_deutsch: entschaerfe(deutschRoh),
      preis: preis != null && packung > 1 ? Math.round(preis / packung * 100) / 100 : preis,
      packung,
      packungspreis: preis,
      einheit,
      lieferbar: /vorrätig/i.test(t) && !/nicht lieferbar/i.test(t),
      url: url ? 'https://www.gaissmayer.de' + url : null
    };
  }).filter(Boolean);
}

const entschaerfe = s => String(s || '')
  .replace(/&ndash;/g, '–').replace(/&amp;/g, '&').replace(/&quot;/g, '"')
  .replace(/&#0?39;|&apos;/g, "'").replace(/&nbsp;/g, ' ').trim();

async function holen() {
  const alle = [];
  const gesehen = new Set(); // Artikelnummern: eine Blätterung ohne feste Sortierung kann
  let gesamt = 0;            // dieselbe Karte zweimal liefern und eine andere auslassen
  let seiten = null;
  for (let seite = 1; seiten === null || seite <= seiten; seite++) {
    const res = await fetch(seitenUrl(seite), { headers: { 'User-Agent': UA } });
    if (!res.ok) throw new Error(`Seite ${seite}: HTTP ${res.status}`);
    const html = await res.text();
    if (seiten === null) {
      const tot = html.match(/data-pagination="total"[^>]*>\s*(\d+)/);
      gesamt = tot ? Number(tot[1]) : 0;
      if (!gesamt) throw new Error('Trefferzahl nicht gefunden — hat der Shop sein Markup geändert?');
      seiten = Math.ceil(gesamt / PRO_SEITE);
      console.log(`${gesamt} Produkte, ${seiten} Seiten à ${PRO_SEITE}, Pause ${PAUSE_MS / 1000} s`);
    }
    const teil = parseSeite(html).filter(p => p.id && !gesehen.has(p.id) && gesehen.add(p.id));
    alle.push(...teil);
    console.log(`  Seite ${seite}/${seiten}: ${teil.length} neue Karten (${alle.length} gesamt)`);
    if (seite < seiten) await new Promise(r => setTimeout(r, PAUSE_MS));
  }
  fs.writeFileSync(KATALOG, JSON.stringify({ geholt_am: new Date().toISOString(), gesamt, produkte: alle }, null, 1));
  console.log(`\n→ ${alle.length} von ${gesamt} angekündigten Produkten in ${path.relative(process.cwd(), KATALOG)}`);
  if (alle.length < gesamt * 0.98) console.warn(`  Achtung: ${gesamt - alle.length} Produkte fehlen — Blätterung erneut prüfen.`);
  return alle;
}

// ─── Zuordnung ──────────────────────────────────────────────────────────────

/*
 * Gattung + Art, Hybrid-Marker und Sortenname entfernt. Dieselbe Regel wie die
 * DB-Anreicherung in stauden-server.js: "Nepeta x faassenii 'Walkers Low'" und
 * "Nepeta faassenii" müssen zusammenfinden, "Salvia" allein darf keine fremde Art treffen.
 */
function binomial(name) {
  const ohneSorte = String(name || '')
    .replace(/'[^']*'/g, ' ')          // 'Walkers Low'
    .replace(/[®™]/g, ' ')
    .replace(/\bvar\.|\bsubsp\.|\bssp\.|\bf\./gi, ' ')
    .replace(/\(veg\.\)/gi, ' ');
  const tokens = ohneSorte.split(/\s+/).filter(t => t && t !== 'x' && t !== 'X' && t !== '×');
  if (tokens.length < 2) return null;
  // Zweites Wort muss ein Art-Epitheton sein. "Agapanthus Hybrid-Cultivar" und
  // "Hosta Hybride" sind Gattungsware ohne Art — dort gibt es keinen Artpreis.
  if (!/^[a-zäöüß-]+$/.test(tokens[1])) return null;
  return `${tokens[0]} ${tokens[1]}`.toLowerCase();
}

// Nur einzeln verkaufte Pflanzen. Bücher, Werkzeug und Dünger tragen ebenfalls Preise, und
// Sets ("Funkien für Einsteiger", 6 Pflanzen, 32,50 €; "4 Päckchen pro Set") würden als
// Stückpreis einer Art durchgehen — ihr Inhalt steht nirgends in Stück.
const PFLANZEN_EINHEIT = /Topf|Solitär|Zwiebel|Knolle|Ballen|Wurzelnackt/i;
const istPflanze = p => p.preis > 0 && p.einheit && PFLANZEN_EINHEIT.test(p.einheit) && !/pro Set/i.test(p.einheit);

function indexBauen(produkte) {
  const nachArt = new Map();
  const nachGattung = new Map();
  for (const p of produkte) {
    if (!istPflanze(p)) continue;
    const b = binomial(p.name_botanisch);
    const gat = String(p.name_botanisch || '').split(/\s+/)[0].toLowerCase();
    if (gat) { if (!nachGattung.has(gat)) nachGattung.set(gat, []); nachGattung.get(gat).push(p); }
    if (!b) continue;
    if (!nachArt.has(b)) nachArt.set(b, []);
    nachArt.get(b).push(p);
  }
  return { nachArt, nachGattung };
}

/*
 * Ein Preis je Art. Genommen wird das günstigste lieferbare Angebot: Der Plan nennt eine Art,
 * nicht eine Sorte — wer ihn nachkauft, greift zur Wildform. Bei Echinacea purpurea sind das
 * 5,10 € statt 8,30 € für die Züchtungen. Ist nichts lieferbar, zählt der Listenpreis
 * trotzdem; „gerade vergriffen" ändert nichts daran, was die Art kostet.
 *
 * Vorher wird aber die Ware-Art entschieden, sonst vergleicht man Äpfel mit Zwiebeln: Wo es
 * einen Topf gibt, zählt der Topf. Crocosmia x crocosmiiflora wird als Topfstaude geplant und
 * als Knolle verkauft (4,90 € je zehn Stück) — der reine Stückpreis von 0,49 € stünde sonst
 * unter einer Pflanzenkarte, die eine ausgewachsene Staude zeigt. Nur wo es die Art gar nicht
 * im Topf gibt (Tulpen, Allium, echte Geophyten), gilt der Zwiebel-Stückpreis.
 */
function preisFuer(angebote) {
  const topf = angebote.filter(a => /Topf|Solitär|Ballen|Wurzelnackt/i.test(a.einheit || ''));
  const klasse = topf.length ? topf : angebote;
  const lieferbar = klasse.filter(a => a.lieferbar);
  const menge = lieferbar.length ? lieferbar : klasse;
  return menge.reduce((min, a) => (a.preis < min.preis ? a : min), menge[0]);
}

// ─── Bericht ────────────────────────────────────────────────────────────────

function main() {
  if (!fs.existsSync(KATALOG)) {
    console.error(`Kein Katalog. Erst einmalig: node ${path.relative(process.cwd(), __filename)} --holen`);
    process.exit(1);
  }
  const katalog = JSON.parse(fs.readFileSync(KATALOG, 'utf8'));
  const { nachArt, nachGattung } = indexBauen(katalog.produkte);
  const angeboteGesamt = [...nachArt.values()].reduce((s, v) => s + v.length, 0);
  console.log(`Katalog vom ${katalog.geholt_am.slice(0, 10)}: ${katalog.produkte.length} Produkte, davon ${angeboteGesamt} Pflanzenangebote in ${nachArt.size} Arten\n`);

  const db = new Database(process.env.DB_PFAD || path.join(__dirname, '..', 'stauden.db'),
    { readonly: !arg('--schreiben') });
  const pflanzen = db.prepare('SELECT id, name_botanisch, name_deutsch, preis_stueck_eur FROM pflanzen ORDER BY name_botanisch').all();

  const treffer = [], ohne = [];
  for (const p of pflanzen) {
    const b = binomial(p.name_botanisch);
    const angebote = b ? nachArt.get(b) : null;
    if (angebote && angebote.length) {
      const beste = preisFuer(angebote);
      treffer.push({ ...p, neu: beste.preis, einheit: beste.einheit, quelle: beste.name_botanisch, url: beste.url, angebote: angebote.length });
    } else {
      // Kein Artpreis. Für den Bericht trotzdem nachsehen, ob die Gattung geführt wird —
      // dann liegt es am Namen, nicht am Sortiment, und der Kauflink zeigt ins Leere.
      const gat = String(p.name_botanisch || '').split(/\s+/)[0].toLowerCase();
      const gAngebote = nachGattung.get(gat) || [];
      ohne.push({ ...p, gattung_gefuehrt: gAngebote.length,
        beispiel: gAngebote.length ? gAngebote[0].name_botanisch : null });
    }
  }

  if (arg('--csv')) {
    console.log('name_botanisch;alt;neu;abweichung_prozent;einheit;quelle');
    for (const t of treffer) {
      console.log([t.name_botanisch, f(t.preis_stueck_eur), f(t.neu),
        t.preis_stueck_eur ? Math.round((t.preis_stueck_eur / t.neu - 1) * 100) : '',
        t.einheit, t.quelle].join(';'));
    }
    return;
  }

  const mitAlt = treffer.filter(t => t.preis_stueck_eur > 0);
  const summeAlt = mitAlt.reduce((s, t) => s + t.preis_stueck_eur, 0);
  const summeNeu = mitAlt.reduce((s, t) => s + t.neu, 0);
  const abw = mitAlt.map(t => t.preis_stueck_eur / t.neu).sort((a, b) => a - b);

  console.log(`Zugeordnet:   ${treffer.length} von ${pflanzen.length} Arten`);
  console.log(`Ohne Treffer: ${ohne.length} — davon ${ohne.filter(o => o.gattung_gefuehrt).length} mit geführter Gattung (Namensfrage, nicht Sortiment)\n`);
  console.log(`Warenkorb aller zugeordneten Arten: ${f(summeAlt)} € bei uns gegen ${f(summeNeu)} € dort  (${vz(summeAlt / summeNeu - 1)})`);
  console.log(`Median je Art: ${vz(abw[Math.floor(abw.length / 2)] - 1)}   ·   zu teuer: ${abw.filter(x => x > 1.05).length}   zu billig: ${abw.filter(x => x < 0.95).length}   passend: ${abw.filter(x => x >= 0.95 && x <= 1.05).length}\n`);

  const sortiert = [...mitAlt].sort((a, b) => (b.preis_stueck_eur / b.neu) - (a.preis_stueck_eur / a.neu));
  console.log('Die 10 größten Aufschläge:');
  for (const t of sortiert.slice(0, 10)) zeile(t);
  console.log('\nDie 10 größten Abschläge:');
  for (const t of sortiert.slice(-10).reverse()) zeile(t);

  fs.writeFileSync(OHNE_TREFFER, JSON.stringify(ohne, null, 1));
  console.log(`\n→ ${ohne.length} Arten ohne Artpreis in ${path.relative(process.cwd(), OHNE_TREFFER)}`);
  const namensfaelle = ohne.filter(o => o.gattung_gefuehrt).slice(0, 10);
  if (namensfaelle.length) {
    console.log('  Gattung geführt, Art nicht — hier läuft auch der Kauflink auf „0 Produkte":');
    for (const o of namensfaelle) console.log(`    ${o.name_botanisch.padEnd(34)} Shop führt z. B. ${o.beispiel}`);
  }

  if (arg('--schreiben')) {
    const upd = db.prepare('UPDATE pflanzen SET preis_stueck_eur = ? WHERE id = ?');
    const tx = db.transaction(rows => { for (const r of rows) upd.run(r.neu, r.id); });
    tx(treffer);
    console.log(`\n✓ ${treffer.length} Preise geschrieben. ${ohne.length} Arten unverändert (kein Artpreis im Shop).`);
  } else {
    console.log('\n(Nichts geändert — mit --schreiben übernehmen.)');
  }
}

const f = n => Number(n || 0).toFixed(2).replace('.', ',');
const vz = q => (q >= 0 ? '+' : '') + Math.round(q * 100) + ' %';
const zeile = t => console.log(`  ${t.name_botanisch.padEnd(34)} ${f(t.preis_stueck_eur).padStart(6)} € → ${f(t.neu).padStart(6)} €  ${vz(t.preis_stueck_eur / t.neu - 1).padStart(7)}  ${t.einheit || ''}`);

// Auch von scripts/check-preise.js benutzt — deshalb erst laufen, wenn direkt gestartet.
module.exports = { parseSeite, binomial, istPflanze, indexBauen, preisFuer, KATALOG };

if (require.main === module) {
  if (arg('--holen')) holen().then(() => main()).catch(e => { console.error(e.message); process.exit(1); });
  else main();
}
