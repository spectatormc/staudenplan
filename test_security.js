/*
 * Sicherheitstest-Suite — prüft die im Sicherheitscheck vom 2026-07-18 behobenen Lücken:
 * Admin-Auth (kein hartcodierter Key mehr, Passwortschutz auf allen Admin-Aktions-
 * Endpoints), serverseitige E-Mail-Validierung bei /api/anfrage, robuste Fehler-
 * behandlung bei kaputtem KI-Plan (Regressionstest) sowie grundlegende Security-Header.
 * Läuft lokal gegen den eigenen Server (http://localhost:PORT), räumt seine Test-Anfrage
 * aus der DB danach wieder auf. Kein Test-Framework nötig, exit(1) bei einem Fehlschlag
 * (gleiche Konvention wie gruenos' test_sso.js/test_module_access.js).
 *
 *   node stauden-server.js   (in einem Terminal laufen lassen)
 *   node test_security.js    (in einem zweiten)
 */
require('dotenv').config();
const Database = require('better-sqlite3');
const path = require('path');

const PORT = process.env.PORT || 3000;
const BASE = `http://localhost:${PORT}`;
const ADMIN_PW = process.env.ADMIN_PASSWORT;

let failed = 0;
function ok(label) { console.log('  ✓ ' + label); }
function fail(label, detail) { failed++; console.error('  ✗ ' + label + (detail ? ' — ' + detail : '')); }
function expect(label, cond, detail) { cond ? ok(label) : fail(label, detail); }

async function main() {
  console.log('=== Sicherheitstest-Suite ===\n');
  if (!ADMIN_PW) { console.error('FATAL: ADMIN_PASSWORT fehlt in .env'); process.exit(1); }

  // Seit Commit 31d2f90 läuft die Admin-Anmeldung über ein signiertes Cookie statt über ?pw= in
  // der URL. Die Seiten-Routen antworten deshalb mit 302 auf /admin/login, nicht mehr mit 403,
  // und ?pw= wird gar nicht mehr gelesen. Die Suite prüfte bis 06.08.2026 noch den alten Stand
  // und meldete sechs Fehlschläge, die keine waren.
  console.log('1) Admin-Übersicht (/admin) — Zugriffsschutz …');
  const ohneFolgen = { redirect: 'manual' };
  let r = await fetch(BASE + '/admin', ohneFolgen);
  expect('Ohne Anmeldung: Weiterleitung auf /admin/login', r.status === 302 && String(r.headers.get('location')).startsWith('/admin/login'), 'status=' + r.status + ' location=' + r.headers.get('location'));

  r = await fetch(BASE + '/admin?pw=definitiv-falsch', ohneFolgen);
  expect('Passwort in der URL öffnet nichts mehr', r.status === 302, 'status=' + r.status);

  r = await fetch(BASE + '/admin?key=preview2026', ohneFolgen);
  expect('Alter hartcodierter Key "preview2026" wirkungslos (Regressionstest)', r.status === 302, 'status=' + r.status);

  r = await fetch(BASE + '/admin?pw=' + encodeURIComponent(ADMIN_PW), ohneFolgen);
  expect('Auch das RICHTIGE Passwort in der URL öffnet nichts — nur das Cookie zählt', r.status === 302, 'status=' + r.status);

  // Anmeldung wie ein echter Nutzer, dann mit dem Cookie weiterarbeiten.
  const login = await fetch(BASE + '/admin/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pw: ADMIN_PW }),
  });
  const loginBody = await login.json().catch(() => ({}));
  expect('Login mit richtigem Passwort: success', login.status === 200 && loginBody.success === true, 'status=' + login.status);
  const cookie = String(login.headers.get('set-cookie') || '').split(';')[0];
  expect('Login setzt ein Cookie', /^sp_admin=/.test(cookie), 'cookie=' + cookie);
  const alsAdmin = { headers: { Cookie: cookie } };

  r = await fetch(BASE + '/admin', { ...alsAdmin, redirect: 'manual' });
  expect('Mit Cookie: /admin liefert die Seite (200)', r.status === 200, 'status=' + r.status);

  for (const pfad of ['/admin/klicks', '/admin/anfragen', '/admin/quiz']) {
    const ohne = await fetch(BASE + pfad, ohneFolgen);
    const mit = await fetch(BASE + pfad, { ...alsAdmin, redirect: 'manual' });
    expect(pfad + ': ohne Cookie Weiterleitung, mit Cookie 200', ohne.status === 302 && mit.status === 200, `ohne=${ohne.status} mit=${mit.status}`);
  }

  const falschesCookie = { headers: { Cookie: 'sp_admin=' + 'a'.repeat(64) } };
  r = await fetch(BASE + '/admin', { ...falschesCookie, redirect: 'manual' });
  expect('Gefälschtes Cookie wird abgewiesen', r.status === 302, 'status=' + r.status);

  console.log('\n2) Admin-Aktions-Endpoints — vorher komplett offen & ohne Rate-Limit, jetzt geschützt …');
  const adminActionRoutes = [
    '/api/ki-bild-vorschlag/999999',
    '/api/ki-bild-ablehnen/999999',
    '/api/ki-bilder-starten',
    '/api/bildcheck-starten',
    '/api/kandidaten-starten',
    '/api/bild-approve/999999',
    '/api/antwort-generieren',
  ];
  for (const route of adminActionRoutes) {
    r = await fetch(BASE + route, { method: 'POST' });
    expect(route + ' ohne Passwort: 401', r.status === 401, 'status=' + r.status);
  }
  // Auch hier zählt das Cookie, nicht ?pw= — die Aktionen sollen mit Anmeldung erreichbar sein.
  r = await fetch(BASE + '/api/kandidaten-starten', { method: 'POST', ...alsAdmin });
  expect('Mit Cookie funktioniert die Aktion weiterhin (200)', r.status === 200, 'status=' + r.status);
  r = await fetch(BASE + '/api/bild-approve/999999', { method: 'POST', ...alsAdmin });
  expect('bild-approve mit Cookie erreicht die Route (404 statt 401 — kein offener Vorschlag für die Fake-ID)', r.status === 404, 'status=' + r.status);
  r = await fetch(BASE + '/api/antwort-generieren', {
    method: 'POST', headers: { ...alsAdmin.headers, 'Content-Type': 'application/json' }, body: '{}',
  });
  expect('antwort-generieren mit Cookie erreicht die Route (400 statt 401 — "frage" fehlt; kein echter KI-Call im Test)', r.status === 400, 'status=' + r.status);
  r = await fetch(BASE + '/api/kandidaten-starten?pw=' + encodeURIComponent(ADMIN_PW), { method: 'POST' });
  expect('Passwort in der URL öffnet auch die Aktions-Endpunkte nicht (401)', r.status === 401, 'status=' + r.status);

  console.log('\n3) /api/anfrage — serverseitige E-Mail-Validierung …');
  r = await fetch(BASE + '/api/anfrage', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'SecTest', email: 'a@x.invalid,b@y.invalid', plz: '11111' }),
  });
  expect('Kommagetrennte Multi-Adresse wird abgelehnt (400) — sonst Spam-Relay-Missbrauch von info@staudenplan.de möglich', r.status === 400, 'status=' + r.status);

  r = await fetch(BASE + '/api/anfrage', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'SecTest', email: 'ohne-at.invalid', plz: '11111' }),
  });
  expect('E-Mail ohne @ wird abgelehnt (400)', r.status === 400, 'status=' + r.status);

  console.log('\n4) /api/anfrage — darf bei kaputtem KI-Plan nicht mit Express-HTML-Fehlerseite crashen (Regressionstest) …');
  r = await fetch(BASE + '/api/anfrage', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'SecTest', email: 'sectest@example.invalid', plz: '11111', ki_plan: { pflanzen: 'kaputt-kein-array' } }),
  });
  const ct = r.headers.get('content-type') || '';
  expect('Antwort ist JSON, keine Express-HTML-Fehlerseite', ct.includes('application/json'), 'content-type=' + ct);
  expect('Status 200 trotz kaputtem Plan', r.status === 200, 'status=' + r.status);

  console.log('\n5) Security-Header auf normalen Seiten …');
  r = await fetch(BASE + '/');
  expect('X-Frame-Options gesetzt (Klickjacking-Schutz)', r.headers.get('x-frame-options') === 'SAMEORIGIN');
  expect('X-Content-Type-Options gesetzt', r.headers.get('x-content-type-options') === 'nosniff');
  expect('Strict-Transport-Security gesetzt', !!r.headers.get('strict-transport-security'));
  expect('X-Powered-By nicht gesetzt (kein Express-Fingerprinting)', !r.headers.get('x-powered-by'));
  const csp = r.headers.get('content-security-policy') || '';
  expect('CSP gesetzt mit default-src \'self\'', csp.includes("default-src 'self'"), 'csp=' + csp);
  expect('CSP erlaubt Plausible (script+connect), sonst keine fremden Hosts', csp.includes('https://plausible.io'));
  expect('CSP blockt object-src (Plugin-Angriffe)', csp.includes("object-src 'none'"));

  console.log('\nAufräumen: Test-Anfrage aus der DB entfernen …');
  const db = new Database(path.join(__dirname, 'stauden.db'));
  const info = db.prepare("DELETE FROM anfragen WHERE name = 'SecTest'").run();
  ok(info.changes + ' Test-Anfrage(n) entfernt');

  console.log('\n' + (failed ? `✗ ${failed} Test(s) fehlgeschlagen` : '✓ Alle Tests bestanden'));
  process.exit(failed ? 1 : 0);
}

main().catch(e => {
  console.error('FEHLER:', e);
  process.exit(1);
});
