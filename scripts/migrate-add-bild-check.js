// Fügt bild_vorschlag + bild_check_info Spalten hinzu für die manuelle Bildprüfung.
// Ausführen: node scripts/migrate-add-bild-check.js
const Database = require('better-sqlite3');
const path = require('path');
const db = new Database(path.join(__dirname, '..', 'stauden.db'));

[['bild_vorschlag', 'TEXT'], ['bild_check_info', 'TEXT'], ['bild_geprueft', 'INTEGER DEFAULT 0'], ['bild_kandidaten', 'TEXT']].forEach(([name, type]) => {
  try {
    db.exec(`ALTER TABLE pflanzen ADD COLUMN ${name} ${type}`);
    console.log(`✅ Spalte "${name}" hinzugefügt.`);
  } catch (e) {
    if (e.message.includes('duplicate column')) console.log(`ℹ️  "${name}" existiert bereits.`);
    else throw e;
  }
});

db.close();
console.log('Fertig.');
