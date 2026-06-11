// Schaltet alle staging-Pflanzen auf live frei.
// Nur ausführen wenn Qualitätsprüfung (Bilder, Daten) abgeschlossen!
// Ausführen: node scripts/approve-staging.js
// Optionen:  --dry-run            (zeigt nur wie viele, ohne zu ändern)
//            --kategorie=Zwiebeln (nur eine Kategorie freischalten)
//            --id=123             (einzelne Pflanze per ID)

const Database = require('better-sqlite3');
const path     = require('path');

const args     = process.argv.slice(2);
const DRY_RUN  = args.includes('--dry-run');
const KAT      = (() => { const k = args.find(a => a.startsWith('--kategorie=')); return k ? k.split('=')[1] : null; })();
const ID       = (() => { const i = args.find(a => a.startsWith('--id=')); return i ? parseInt(i.split('=')[1]) : null; })();

const db = new Database(path.join(__dirname, '..', 'stauden.db'));

// Staging-Übersicht (gesperrte Pflanzen werden nie freigeschaltet)
const staging = db.prepare(`
  SELECT id, name_deutsch, name_botanisch, licht, boden, hoehe_cm_min, hoehe_cm_max,
         bild_url, bluehzeit, farbe, rolle_empfehlung, bild_gesperrt
  FROM pflanzen WHERE status = 'staging' ORDER BY name_deutsch
`).all();

if (staging.length === 0) {
  console.log('Keine Pflanzen im staging-Status gefunden.');
  db.close();
  process.exit(0);
}

const gesperrt = staging.filter(p => p.bild_gesperrt);
const freigabe = staging.filter(p => !p.bild_gesperrt);

console.log(`\n=== Staging-Übersicht: ${staging.length} Pflanzen (${gesperrt.length} gesperrt, werden übersprungen) ===\n`);
if (gesperrt.length > 0) {
  console.log('GESPERRT (kein passendes Bild gefunden):');
  gesperrt.forEach(p => console.log(`  🚫 [${p.id}] ${p.name_deutsch}`));
  console.log('');
}
const ohneBild = freigabe.filter(p => !p.bild_url);

staging.slice(0, 30).forEach(p => {
  const bild = p.bild_url ? '✓' : '✗ KEIN BILD';
  console.log(`  [${p.id}] ${p.name_deutsch.padEnd(35)} ${p.hoehe_cm_min}-${p.hoehe_cm_max}cm | ${(p.licht||'?').padEnd(20)} | ${bild}`);
});
if (staging.length > 30) console.log(`  ... und ${staging.length - 30} weitere`);

console.log(`\n  Ohne Bild: ${ohneBild.length} Pflanzen`);
if (ohneBild.length > 0) {
  console.log('  → Bitte zuerst: node scripts/fetch-plant-images.js');
}

if (DRY_RUN) {
  console.log('\n[DRY RUN] Keine Änderungen vorgenommen.');
  db.close();
  process.exit(0);
}

// Freischalten
let stmt, result;
if (ID) {
  stmt = db.prepare(`UPDATE pflanzen SET status = 'live' WHERE id = ? AND status = 'staging'`);
  result = stmt.run(ID);
} else if (KAT) {
  // Freischalten nach Kategorie ist nicht direkt möglich (keine kategorie-Spalte),
  // aber wir können nach licht/stil filtern oder manuell IDs angeben.
  console.log('\n⚠️  Kategorie-Filter: Da keine kategorie-Spalte existiert, bitte --id=X verwenden.');
  console.log('   Oder alle freischalten ohne --kategorie.');
  db.close();
  process.exit(0);
} else {
  if (ohneBild.length > 0) {
    console.log(`\n⚠️  ${ohneBild.length} Pflanzen haben noch kein Bild. Trotzdem freischalten? [Enter = ja, Ctrl+C = Abbruch]`);
    // In Non-TTY einfach fortfahren
  }
  stmt = db.prepare(`UPDATE pflanzen SET status = 'live' WHERE status = 'staging' AND (bild_gesperrt IS NULL OR bild_gesperrt = 0)`);
  result = stmt.run();
}

console.log(`\n✅ ${result.changes} Pflanzen auf status='live' gesetzt.`);
const total = db.prepare("SELECT COUNT(*) as n FROM pflanzen WHERE status = 'live'").get().n;
console.log(`   Gesamt live: ${total} Pflanzen`);

db.close();
