// Fügt status-Spalte zur pflanzen-Tabelle hinzu.
// Bestehende Pflanzen erhalten status='live'.
// Neue Staging-Pflanzen werden mit status='staging' eingetragen.
// Ausführen: node scripts/migrate-add-status.js

const Database = require('better-sqlite3');
const path     = require('path');

const db = new Database(path.join(__dirname, '..', 'stauden.db'));

try {
  db.exec(`ALTER TABLE pflanzen ADD COLUMN status TEXT DEFAULT 'live'`);
  console.log('✅ Spalte "status" hinzugefügt.');
} catch (e) {
  if (e.message.includes('duplicate column')) {
    console.log('ℹ️  Spalte "status" existiert bereits — übersprungen.');
  } else {
    throw e;
  }
}

// Alle bestehenden Einträge explizit auf 'live' setzen (auch NULL-Werte absichern)
const updated = db.prepare(`UPDATE pflanzen SET status = 'live' WHERE status IS NULL OR status != 'staging'`).run();
console.log(`✅ ${updated.changes} Pflanzen auf status='live' gesetzt.`);

const counts = db.prepare(`SELECT status, COUNT(*) as n FROM pflanzen GROUP BY status`).all();
counts.forEach(r => console.log(`   ${r.status || 'NULL'}: ${r.n} Pflanzen`));

db.close();
console.log('\nFertig. Server neu starten für Wirkung.');
