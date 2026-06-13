const Database = require('better-sqlite3');
const path = require('path');
const db = new Database(path.join(__dirname, '..', 'stauden.db'));

const ids = [5,7,55,64,94,111,139,162,164,181,185,190,191,196,207,212,225,233,241,274,277,280,281,284,287,309,310,317,328,333,341,344,348,351,356,357,367,376,388,392,404,425,426,446,450,460,480,496,501,559,577,608,609,636,652,677,717,734];

const rows = db.prepare(`SELECT id, name_deutsch, status, bild_ki, bild_url, bild_vorschlag FROM pflanzen WHERE id IN (${ids.join(',')})`).all();

const byStatus = {};
for (const r of rows) {
  const k = r.status || 'null';
  if (!byStatus[k]) byStatus[k] = [];
  byStatus[k].push(r);
}

for (const [status, plants] of Object.entries(byStatus)) {
  console.log(`\n=== status=${status} (${plants.length}) ===`);
  for (const p of plants) {
    const urlShort = (p.bild_url || '').slice(0, 60);
    const vorschlag = p.bild_vorschlag ? (p.bild_vorschlag).slice(0, 40) : 'NULL';
    console.log(`  [${p.id}] ki=${p.bild_ki} url=${urlShort} | vorschlag=${vorschlag}`);
  }
}

// Plants where we need to fix (live with external URL or still showing emoji placeholder)
const needFix = rows.filter(r =>
  (r.status === 'live' && (r.bild_url || '').startsWith('http')) ||
  (r.status === 'live' && (!r.bild_url || r.bild_url === '🌿'))
);
console.log(`\n=== Brauchen Fix (live + externe URL oder kein Bild): ${needFix.length} ===`);
for (const p of needFix) console.log(`  [${p.id}] ${p.name_deutsch} | url=${p.bild_url} | vorschlag=${p.bild_vorschlag}`);

// Plants in staging that should be live (were originally live)
const stagingWithKi = rows.filter(r => r.status === 'staging' && r.bild_ki === 1 && r.bild_vorschlag);
console.log(`\n=== Staging mit KI-Vorschlag (ursprünglich live): ${stagingWithKi.length} ===`);
for (const p of stagingWithKi) console.log(`  [${p.id}] ${p.name_deutsch}`);

db.close();
