// Generiert KI-Bilder (DALL-E 3) für Pflanzen ohne gutes Foto.
// Ergebnis wird als bild_vorschlag gespeichert; dass dieser Vorschlag ein KI-Bild ist, steht
// in bild_check_info ({"ki":true,…}).
//
// bild_ki WIRD HIER NICHT GESETZT — und das ist der Kern dieser Datei:
// bild_ki ist die Aussage über das Bild, das unter bild_url AUSGELIEFERT wird
// (scripts/bild-herkunft.js). Solange der Vorschlag nur danebensteht, ist diese Aussage
// weiter das alte Bild. Bis 09/2026 setzten beide UPDATE-Varianten bild_ki=1 gemeinsam mit
// bild_vorschlag. Mit --keep-live (so ruft /api/ki-bild-vorschlag/:id auf) bleibt die Zeile
// live — ein Pixabay-Foto trug damit auf allen Ausgabepfaden die Marke „KI-Bild" und die
// Unterschrift „KI-erzeugte Illustration", von der Erzeugung bis zur Freigabe im Admin, also
// Stunden bis Tage. Geschrieben wird die Kennzeichnung dort, wo das Bild wirklich wechselt:
// /api/bild-approve leitet sie mit bildFelderAusFund() aus dem übernommenen Bild ab.
//
// Der Merker „für diese Pflanze wurde schon ein KI-Bild versucht" steht in der EIGENEN Spalte
// bild_ki_versucht. Eine Spalte, aus der die öffentliche Kennzeichnung gelesen wird, taugt
// nicht als Notizzettel des Arbeitsablaufs.
//
// Ausführen:  node scripts/generate-ki-bilder.js
// Optionen:
//   --limit=10       Anzahl Pflanzen (default: 10)
//   --ids=1,2,3      Bestimmte Pflanzen-IDs
//   --keep-live      Status nicht auf staging setzen (Pflanze bleibt online)
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const Database = require('better-sqlite3');
const { OpenAI } = require('openai');
// Wortlaut der Lizenz aus der EINEN Ableitung, die auch die Kennzeichnung liest.
const { KI_LIZENZ } = require('./bild-herkunft');
const https    = require('https');
const http     = require('http');
const fs       = require('fs');
const path     = require('path');

const db     = new Database(path.join(__dirname, '..', 'stauden.db'));
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/* Spalten anlegen, falls die Datenbank sie noch nicht führt.
 * Die MASSGEBLICHE Liste steht in stauden-server.js („Schema-Migrationen, idempotent") und
 * läuft bei jedem Serverstart. Hier steht sie nur als Notbehelf, damit dieser Lauf auch auf
 * einer Datenbank durchkommt, auf der der Server noch nie gestartet ist — wer eine Spalte
 * ergänzt, trägt sie dort ein, nicht nur hier. */
for (const sql of [
  'ALTER TABLE pflanzen ADD COLUMN bild_ki INTEGER DEFAULT 0',
  'ALTER TABLE pflanzen ADD COLUMN bild_ki_versucht INTEGER DEFAULT 0',
]) {
  try { db.exec(sql); } catch (e) { if (!e.message.includes('duplicate column')) throw e; }
}

const IMG_DIR = path.join(__dirname, '..', 'public', 'images', 'pflanzen');
if (!fs.existsSync(IMG_DIR)) fs.mkdirSync(IMG_DIR, { recursive: true });

const args      = process.argv.slice(2);
const LIMIT     = (() => { const l = args.find(a => a.startsWith('--limit=')); return l ? parseInt(l.split('=')[1]) : 10; })();
const IDS       = (() => { const i = args.find(a => a.startsWith('--ids=')); return i ? i.split('=')[1].split(',').map(Number).filter(Boolean) : null; })();
const KEEP_LIVE = args.includes('--keep-live'); // Status nicht auf staging setzen

/* Zwei Bedingungen, zwei Spalten, zwei verschiedene Aussagen — sie sahen bis 09/2026 nur
 * deshalb wie eine aus, weil bild_ki für beides benutzt wurde:
 *   bild_ki_versucht  — für diese Pflanze ist schon einmal ein Bild erzeugt worden. Der
 *                       Vorschlag kann noch offen sein oder abgelehnt worden sein; ein
 *                       zweiter Lauf soll ihn nicht wiederholen (und nicht noch einmal
 *                       0,04 $ kosten).
 *   bild_ki           — das AUSGELIEFERTE Bild ist KI-erzeugt. Dann braucht die Pflanze
 *                       ohnehin keins mehr. Das ist ein Lesen des Feldes in seiner
 *                       eigentlichen Bedeutung, kein Zweckentfremden.
 * --ids setzt beides außer Kraft: Wer eine ID nennt, will genau diese Pflanze. */
let where = "status='staging' AND (bild_ki_versucht IS NULL OR bild_ki_versucht=0) AND (bild_ki IS NULL OR bild_ki=0)";
if (IDS?.length) where = `id IN (${IDS.join(',')})`;

const pflanzen = db.prepare(`
  SELECT id, name_deutsch, name_botanisch, farbe
  FROM pflanzen WHERE ${where}
  ORDER BY id LIMIT ${LIMIT}
`).all();

if (!pflanzen.length) {
  console.log('Keine passenden Pflanzen gefunden.');
  db.close();
  process.exit(0);
}

console.log(`\n=== KI-Bildgenerierung (DALL-E 3) für ${pflanzen.length} Pflanzen ===`);
console.log(`Geschätzte Kosten: ~${(pflanzen.length * 0.04).toFixed(2)} $ (${pflanzen.length} × $0.04)\n`);

function buildPrompt(p) {
  const farbe = (p.farbe || '').split(',').slice(0,2).map(s => s.trim()).filter(Boolean).join(' and ');
  const farbeHinweis = farbe ? ` with ${farbe} flowers` : '';
  return `Photorealistic garden photograph of the full plant ${p.name_botanisch} (${p.name_deutsch})${farbeHinweis}. `
    + `Show the entire plant including stems, leaves and flowers to reveal its natural shape and growth habit. `
    + `Plant in a garden bed, natural daylight, blurred green garden background. `
    + `No text, no watermarks, no people. High quality plant photography.`;
}

function downloadImage(url, dest) {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith('https') ? https : http;
    const file  = fs.createWriteStream(dest);
    proto.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, res => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        file.close(); fs.unlink(dest, () => {});
        return downloadImage(res.headers.location, dest).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        file.close(); fs.unlink(dest, () => {});
        return reject(new Error('HTTP ' + res.statusCode));
      }
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(); });
    }).on('error', err => { fs.unlink(dest, () => {}); reject(err); });
  });
}

/* Geschrieben wird nur, was der Vorschlag betrifft: die Datei, ihre Begleitangabe und der
 * Merker. bild_ki und bild_lizenz bleiben unangetastet — sie beschreiben das Bild unter
 * bild_url, und das hat sich hier nicht geändert. Beim Übernehmen setzt
 * /api/bild-approve beide aus bildFelderAusFund(), beim Ablehnen stellt
 * /api/ki-bild-ablehnen sie mit derselben Funktion auf das ausgelieferte Bild zurück. */
const UPDATE = KEEP_LIVE
  ? db.prepare("UPDATE pflanzen SET bild_vorschlag=?, bild_check_info=?, bild_ki_versucht=1 WHERE id=?")
  : db.prepare("UPDATE pflanzen SET bild_vorschlag=?, bild_check_info=?, bild_ki_versucht=1, status='staging' WHERE id=?");

async function main() {
  for (const p of pflanzen) {
    process.stdout.write(`[${p.id}] ${p.name_deutsch.padEnd(38)} `);
    const prompt = buildPrompt(p);

    try {
      const resp = await openai.images.generate({
        model:          'gpt-image-1',
        prompt,
        n:              1,
        size:           '1024x1024',
        quality:        'medium',
        output_format:  'jpeg',
      });

      const slug     = (p.name_deutsch).toLowerCase()
        .replace(/ä/g,'ae').replace(/ö/g,'oe').replace(/ü/g,'ue').replace(/ß/g,'ss')
        .replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,40);
      const filename = `ki-${slug}-${p.id}.jpg`;
      const dest     = path.join(IMG_DIR, filename);
      const localUrl = `/images/pflanzen/${filename}`;

      // gpt-image-1 gibt base64 zurück, keine URL
      const b64 = resp.data[0].b64_json;
      if (!b64) throw new Error('Kein b64_json in Response');
      fs.writeFileSync(dest, Buffer.from(b64, 'base64'));

      /* bild_check_info ist die einzige Stelle, an der steht, dass dieser Vorschlag ein
       * KI-Bild ist. /api/bild-approve liest genau dieses {"ki":true,…} und leitet daraus
       * die Kennzeichnung ab — deshalb muss es hier geschrieben werden, auch wenn bild_ki
       * ungesetzt bleibt. Der Lizenz-Wortlaut kommt aus der gemeinsamen Ableitung, damit
       * Schreibweg und Lesepfad ihn nicht getrennt voneinander führen. */
      UPDATE.run(
        localUrl,
        JSON.stringify({ ki: true, prompt: prompt.slice(0, 200), lizenz: KI_LIZENZ }),
        p.id
      );
      console.log(`✅ gespeichert → ${localUrl}`);

    } catch (e) {
      console.log(`❌ Fehler: ${e.message}`);
    }

    // Rate-limit: DALL-E 3 = 5 img/min (Standard Tier)
    await new Promise(r => setTimeout(r, 13000));
  }

  /* Zwei Zahlen, weil es zwei Zustände sind — vorher stand hier nur „X KI-Bilder gesamt",
   * und das zählte die eben erzeugten Vorschläge mit, obwohl noch keiner ausgeliefert wird.
   * offen  = Vorschläge, die auf die Freigabe warten (bild_url zeigt weiter das alte Bild),
   * live   = Bilder, die wirklich als KI-Bild gekennzeichnet hinausgehen. */
  const offen = db.prepare("SELECT COUNT(*) as n FROM pflanzen WHERE bild_vorschlag IS NOT NULL AND bild_vorschlag != ''").get().n;
  const live  = db.prepare("SELECT COUNT(*) as n FROM pflanzen WHERE bild_ki=1").get().n;
  console.log(`\n=== Fertig. ${offen} Vorschlag/Vorschläge offen, ${live} KI-Bilder live gekennzeichnet. ===`);
  console.log('Ein Vorschlag ändert an der Kennzeichnung NICHTS — erst die Freigabe tut das.');
  console.log(`→ Review unter: /admin?key=preview2026  (Tab "KI Bild")`);
  db.close();
}

main().catch(console.error);
