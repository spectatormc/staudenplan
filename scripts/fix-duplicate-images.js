// Generiert neue KI-Bilder fuer Pflanzen mit Duplikat-Bildern. Direkt live, kein Staging.
require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const Database = require("better-sqlite3");
const { OpenAI } = require("openai");
const fs   = require("fs");
const path = require("path");

const db     = new Database(path.join(__dirname, "..", "stauden.db"));
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const IMG_DIR = path.join(__dirname, "..", "public", "images", "pflanzen");

const args = process.argv.slice(2);
const IDS  = (() => { const i = args.find(a => a.startsWith("--ids=")); return i ? i.split("=")[1].split(",").map(Number) : null; })();

if (!IDS?.length) { console.error("Bitte --ids=1,2,3 angeben"); process.exit(1); }

const pflanzen = db.prepare(
  `SELECT id, name_deutsch, name_botanisch, farbe FROM pflanzen WHERE id IN (${IDS.join(",")})`
).all();

console.log(`\n=== KI-Neugenerierung fuer ${pflanzen.length} Pflanzen ===`);
console.log(`Kosten: ~${(pflanzen.length * 0.04).toFixed(2)} $\n`);

function buildPrompt(p) {
  const farbe = (p.farbe || "").split(/[|,]/).slice(0,2).map(s=>s.trim()).filter(Boolean).join(" and ");
  const farbeHinweis = farbe ? ` with ${farbe} flowers` : "";
  return `Photorealistic garden photograph of the full plant ${p.name_botanisch} (${p.name_deutsch})${farbeHinweis}. `
    + `Show the entire plant including stems, leaves and flowers to reveal its natural shape and growth habit. `
    + `Plant in a garden bed, natural daylight, blurred green garden background. `
    + `No text, no watermarks, no people. High quality plant photography.`;
}

const UPDATE = db.prepare("UPDATE pflanzen SET bild_url=?, bild_lizenz=\"KI-generiert / OpenAI\", bild_ki=1 WHERE id=?");

async function main() {
  let ok=0, fail=0;
  for (const p of pflanzen) {
    process.stdout.write(`[${p.id}] ${p.name_deutsch.padEnd(40)} `);
    try {
      const resp = await openai.images.generate({
        model:"gpt-image-1", prompt:buildPrompt(p), n:1,
        size:"1024x1024", quality:"medium", output_format:"jpeg",
      });
      const slug = p.name_deutsch.toLowerCase()
        .replace(/ae/g,"ae").replace(/oe/g,"oe").replace(/ue/g,"ue")
        .replace(/ae/g,"ae").replace(/oe/g,"oe").replace(/ue/g,"ue")
        .replace(/a/g,"a").replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"").slice(0,40);
      const filename = `ki-${slug}-${p.id}.jpg`;
      const b64 = resp.data[0].b64_json;
      if (!b64) throw new Error("Kein b64_json");
      fs.writeFileSync(path.join(IMG_DIR, filename), Buffer.from(b64,"base64"));
      UPDATE.run(`/images/pflanzen/${filename}`, p.id);
      console.log("OK -> " + filename); ok++;
    } catch(e) { console.log("FEHLER: " + e.message); fail++; }
    await new Promise(r=>setTimeout(r,13000));
  }
  console.log(`\n=== Fertig. ${ok} ersetzt, ${fail} Fehler. ===`);
  db.close();
}
main().catch(console.error);
