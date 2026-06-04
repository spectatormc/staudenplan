// Erstmalige Produktions-Einrichtung: Erstellt DB und importiert Seed-Daten aus JSON.
// Ausfuehren auf dem Server nach dem ersten Clone: node scripts/setup-production.js

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const db = new Database(path.join(__dirname, '..', 'stauden.db'));

// Tabellen erstellen
db.exec(`
  CREATE TABLE IF NOT EXISTS anfragen (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    erstellt_am TEXT DEFAULT (datetime('now')),
    name TEXT, email TEXT, plz TEXT, telefon TEXT, anmerkungen TEXT,
    gartenflaeche REAL, licht TEXT, boden TEXT, stil TEXT, farbe TEXT, saison TEXT,
    ki_plan TEXT
  );
  CREATE TABLE IF NOT EXISTS pflanzen (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name_deutsch TEXT NOT NULL,
    name_botanisch TEXT UNIQUE NOT NULL,
    beschreibung TEXT, licht TEXT, boden TEXT, stil TEXT, bluehzeit TEXT, farbe TEXT,
    hoehe_cm_min INTEGER, hoehe_cm_max INTEGER, pflege_sterne INTEGER,
    preis_stueck_eur REAL, winterhart_zone INTEGER,
    bienen_freundlich INTEGER DEFAULT 0, heimisch INTEGER DEFAULT 0,
    bild_url TEXT, bild_lizenz TEXT,
    aktualisiert_am TEXT DEFAULT (datetime('now'))
  );
  CREATE VIRTUAL TABLE IF NOT EXISTS wissen USING fts5(
    titel, inhalt, kategorie, quelle, datum
  );
  CREATE TABLE IF NOT EXISTS wissen_quellen (
    id INTEGER PRIMARY KEY AUTOINCREMENT, url TEXT UNIQUE, titel TEXT,
    abgerufen_am TEXT DEFAULT (datetime('now')), eintraege_erstellt INTEGER DEFAULT 0
  );
`);

// Pflanzen importieren
const pflanzenFile = path.join(__dirname, '..', 'data', 'pflanzen-seed.json');
if (fs.existsSync(pflanzenFile)) {
  const pflanzen = JSON.parse(fs.readFileSync(pflanzenFile, 'utf8'));
  const ins = db.prepare(`
    INSERT OR IGNORE INTO pflanzen
    (name_deutsch, name_botanisch, beschreibung, licht, boden, stil, bluehzeit, farbe,
     hoehe_cm_min, hoehe_cm_max, pflege_sterne, preis_stueck_eur, winterhart_zone,
     bienen_freundlich, heimisch, bild_url, bild_lizenz)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `);
  const insertMany = db.transaction((rows) => {
    let n = 0;
    for (const p of rows) {
      const r = ins.run(
        p.name_deutsch, p.name_botanisch, p.beschreibung||null,
        p.licht||null, p.boden||null, p.stil||null, p.bluehzeit||null, p.farbe||null,
        p.hoehe_cm_min||null, p.hoehe_cm_max||null, p.pflege_sterne||2,
        p.preis_stueck_eur||7.90, p.winterhart_zone||6,
        p.bienen_freundlich?1:0, p.heimisch?1:0,
        p.bild_url||null, p.bild_lizenz||null
      );
      if (r.changes) n++;
    }
    return n;
  });
  const n = insertMany(pflanzen);
  console.log(`✓ Pflanzen: ${n} importiert (${pflanzen.length} gesamt)`);
}

// Wissen importieren
const wissenFile = path.join(__dirname, '..', 'data', 'wissen-seed.json');
if (fs.existsSync(wissenFile)) {
  const wissen = JSON.parse(fs.readFileSync(wissenFile, 'utf8'));
  const existing = db.prepare('SELECT COUNT(*) as n FROM wissen').get().n;
  if (existing === 0) {
    const ins = db.prepare('INSERT INTO wissen (titel, inhalt, kategorie, quelle, datum) VALUES (?,?,?,?,?)');
    const insertMany = db.transaction((rows) => {
      for (const w of rows) ins.run(w.titel, w.inhalt, w.kategorie, w.quelle, w.datum);
    });
    insertMany(wissen);
    console.log(`✓ Wissen: ${wissen.length} Eintraege importiert`);
  } else {
    console.log(`- Wissen: ${existing} Eintraege bereits vorhanden`);
  }
}

const pCount = db.prepare('SELECT COUNT(*) as n FROM pflanzen').get().n;
let wCount = 0;
try { wCount = db.prepare('SELECT COUNT(*) as n FROM wissen').get().n; } catch {}

console.log(`\n✅ Setup abgeschlossen: ${pCount} Pflanzen, ${wCount} Wissenseintraege`);
db.close();
