const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const Database = require('better-sqlite3');
const { spawn } = require('child_process');

const projectRoot = path.resolve(__dirname, '..');
const port = Number(process.env.SMOKE_PORT || 3310);
const baseUrl = `http://127.0.0.1:${port}`;

function request(route, body) {
  return new Promise((resolve, reject) => {
    const daten = body ? Buffer.from(JSON.stringify(body)) : null;
    const req = http.request(baseUrl + route, {
      method: daten ? 'POST' : 'GET',
      headers: daten ? { 'Content-Type': 'application/json', 'Content-Length': daten.length } : {},
    }, (res) => {
      let text = '';
      res.on('data', (chunk) => (text += chunk.toString()));
      res.on('end', () => resolve({ status: res.statusCode || 0, body: text }));
    });
    req.on('error', reject);
    if (daten) req.write(daten);
    req.end();
  });
}

async function waitForServer(timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await request('/');
      if (res.status >= 200 && res.status < 500) return true;
    } catch (_) {}
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

/*
 * EIGENE KOPIE DER DATENBANK, und zwar aus zwei Gruenden.
 *
 * 1. Der Lauf SCHREIBT seit dem 23.09.2026: Jeder /api/plan-Aufruf legt eine Zeile in
 *    plan_statistik an. Ohne Kopie landeten drei Testzeilen je Durchgang in derselben
 *    Datei wie die echten Plaene — im Deploy-Verzeichnis also in der Statistik, die
 *    /admin/plaene auswertet, mit Flaechen von 1 bis 2 m². Testdaten gehoeren nicht in
 *    die Produktionsdaten, auch nicht schreibend "nur ein bisschen".
 * 2. Die Kopie kann fehlen. stauden.db steht in .gitignore; auf einem frischen CI-Runner
 *    gibt es sie nicht. Dann laeuft dieser Lauf OHNE die Planpruefungen weiter und sagt
 *    es — CI.md sagt an dieser Stelle zu, dass check:smoke ohne Produktionsdaten laeuft.
 *    Ein "UEBERSPRUNGEN" mit Grund ist ehrlich; ein FAIL waere falsch, und ein stilles
 *    Bestehen waere schlimmer als beides.
 */
const quellDb = path.join(projectRoot, 'stauden.db');
const testDb = path.join(os.tmpdir(), `staudenplan-smoke-${process.pid}.db`);
let planPruefbar = false;
try {
  if (fs.existsSync(quellDb)) {
    fs.copyFileSync(quellDb, testDb);
    const n = new Database(testDb, { readonly: true });
    const zeilen = n.prepare("SELECT COUNT(*) AS n FROM pflanzen WHERE name_deutsch != 'Test-Pflanze'").get().n;
    n.close();
    planPruefbar = zeilen >= 50;
    if (!planPruefbar) console.log(`(Planpruefungen uebersprungen: nur ${zeilen} Pflanzen in stauden.db)`);
  } else {
    console.log('(Planpruefungen uebersprungen: stauden.db ist nicht vorhanden — steht in .gitignore)');
  }
} catch (err) {
  console.log(`(Planpruefungen uebersprungen: stauden.db nicht lesbar — ${err.message})`);
}

(async () => {
  /* Der Schluessel wird bewusst unbrauchbar gemacht. Dann faellt /api/plan in den Notplan,
   * und genau der ist hier zu pruefen: Er ist der Ausgabepfad ohne Modell, er kostet nichts,
   * und er ist reproduzierbar. Mit echtem Schluessel wuerde dieser Lauf Geld ausgeben und
   * bei jedem Durchgang etwas anderes pruefen. */
  const child = spawn('node', ['stauden-server.js'], {
    cwd: projectRoot,
    env: {
      ...process.env,
      PORT: String(port),
      OPENAI_API_KEY: 'sk-smoke-ungueltig-erzwingt-notplan',
      ...(planPruefbar ? { DB_PFAD: testDb } : {}),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  child.stdout.on('data', () => {});
  child.stderr.on('data', () => {});

  let errors = 0;

  try {
    const up = await waitForServer();
    if (!up) {
      console.error('ERROR: Server did not become reachable in time.');
      process.exitCode = 1;
      return;
    }

    const checks = [
      ['/', 200],
      ['/robots.txt', 200],
      ['/sitemap.xml', 200],
      ['/api/pflanzen', 200],
      ['/ratgeber', 200],
    ];

    console.log('--- Stauden API Smoke ---');
    for (const [route, expected] of checks) {
      try {
        const res = await request(route);
        const ok = res.status === expected;
        console.log(`${ok ? 'OK' : 'FAIL'} ${route} -> ${res.status}`);
        if (!ok) errors += 1;
      } catch (err) {
        console.log(`FAIL ${route} -> request error`);
        errors += 1;
      }
    }

    /*
     * KLEINE BEETE — der Fall, an dem die Endhoehengrenze am 23.09.2026 das Auffangnetz
     * zerrissen hat. maxHoeheFuer() liegt unter 1,78 m² unter 100 cm, notplanRolle() macht
     * eine Leitstaude an >= 100 cm fest: Die gefilterte Kandidatenliste hatte dann KEINE
     * Leitstaude mehr, buildNotplan() gab null zurueck, und der Kunde bekam statt eines
     * Plans HTTP 502. Gemessen damals: 1,0 und 1,5 m² scheiterten, ab 2,0 m² ging es.
     *
     * Geprueft wird deshalb nicht nur der Status, sondern die ROLLENABDECKUNG — eine
     * Stueckzahlprobe haette den Fehler nicht gefunden, weil genug Kandidaten da waren,
     * nur keine einzige hohe.
     */
    console.log('--- Notplan auf kleinen Beeten (Rollenabdeckung) ---');
    if (!planPruefbar) console.log('UEBERSPRUNGEN (keine Pflanzendaten) — siehe Hinweis oben');
    for (const flaeche of (planPruefbar ? [1.0, 1.5, 2.0] : [])) {
      try {
        const res = await request('/api/plan', {
          gartenflaeche: flaeche, licht: 'Vollsonne (6+ h)', boden: 'Lehmig / schwer',
          stil: 'Naturgarten / Wildgarten', vielfalt: 'ausgewogen',
        });
        if (res.status !== 200) {
          console.log(`FAIL /api/plan ${flaeche} m² -> ${res.status}`);
          errors += 1;
          continue;
        }
        const daten = JSON.parse(res.body);
        const rollen = new Set((daten.plan && daten.plan.pflanzen || [])
          .map(p => p.rolle).filter(r => r && r !== 'Geophyt'));
        const vollstaendig = ['Leitstaude', 'Begleitstaude', 'Füllstaude'].every(r => rollen.has(r));
        console.log(`${vollstaendig ? 'OK  ' : 'FAIL'} /api/plan ${flaeche} m² -> 200, Rollen: ${[...rollen].join(', ') || 'keine'}`);
        if (!vollstaendig) errors += 1;
      } catch (err) {
        console.log(`FAIL /api/plan ${flaeche} m² -> ${err.message}`);
        errors += 1;
      }
    }

    process.exitCode = errors > 0 ? 1 : 0;
  } finally {
    child.kill('SIGINT');
    setTimeout(() => {
      if (!child.killed) child.kill('SIGKILL');
      // Die Kopie samt WAL-Beidateien wegraeumen. Ein Fehlschlag hier darf den Lauf nicht
      // umwerten — das Ergebnis steht schon fest.
      for (const datei of [testDb, `${testDb}-wal`, `${testDb}-shm`]) {
        try { if (fs.existsSync(datei)) fs.unlinkSync(datei); } catch (_) {}
      }
    }, 1500);
  }
})();
