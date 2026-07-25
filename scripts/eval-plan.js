// Eval-Harness: misst gpt-4o vs gpt-4o-mini für /api/plan an festen Briefs.
// Startet den echten Server im Eval-Modus (Rate-Limits aus), fährt jeden Brief
// N-mal je Modell durch die ECHTE Pipeline (?model=), und bewertet jeden Plan
// objektiv/maschinell gegen die DB. Ausgabe: Pass-Raten-Tabelle je Modell.
//
// Nutzung:  node scripts/eval-plan.js
// Env:      EVAL_RUNS (Default 2), EVAL_PORT (Default 3321), EVAL_MODELS (kommagetrennt)
// Voraussetzung: gültiger OPENAI_API_KEY in .env (kostet echtes Geld: Briefs×Modelle×Runs Calls).

const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const Database = require('better-sqlite3');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.EVAL_PORT || 3321);
const BASE = `http://127.0.0.1:${PORT}`;
const RUNS = Number(process.env.EVAL_RUNS || 2);
const MODELS = (process.env.EVAL_MODELS || 'gpt-4o,gpt-4o-mini').split(',').map(s => s.trim());

// ── DB für Halluzinations-/Ø-Checks (read-only) ──
const db = new Database(path.join(ROOT, 'stauden.db'), { readonly: true });
const DB_PFLANZEN = db.prepare("SELECT name_botanisch, breite_cm_max FROM pflanzen WHERE name_botanisch IS NOT NULL").all();
function dbMatch(botanisch) {
  if (!botanisch) return null;
  const b = String(botanisch).toLowerCase().trim();
  const binomial = b.split(' ').slice(0, 2).join(' ');
  return DB_PFLANZEN.find(p => p.name_botanisch.toLowerCase() === b)
      || DB_PFLANZEN.find(p => binomial.split(' ').length >= 2 && p.name_botanisch.toLowerCase().startsWith(binomial))
      || DB_PFLANZEN.find(p => p.name_botanisch.toLowerCase().split(' ')[0] === b.split(' ')[0])
      || null;
}

// ── Test-Briefs (RAG-korrekte Werte laut LICHT_MAP/BODEN_MAP/STIL_MAP) ──
const BRIEFS = [
  { name: 'standard-sonne', body: { gartenflaeche: 8, licht: 'Vollsonne (6+ h)', boden: 'Normal / humos', stil: 'Naturgarten / Wildgarten', vielfalt: 'normal', dichte: 'normal' } },
  { name: 'schatten-lehm', body: { gartenflaeche: 10, licht: 'Schatten (unter 3 h)', boden: 'Lehmig / schwer', stil: 'Naturgarten / Wildgarten', vielfalt: 'normal', dichte: 'normal' } },
  { name: 'budget-knapp', body: { gartenflaeche: 12, licht: 'Vollsonne (6+ h)', boden: 'Normal / humos', stil: 'Bauerngarten / Romantisch', budget: 150, vielfalt: 'normal', dichte: 'normal' } },
  { name: 'lieblingspflanze-mismatch', body: { gartenflaeche: 10, licht: 'Schatten (unter 3 h)', boden: 'Lehmig / schwer', stil: 'Naturgarten / Wildgarten', lieblingspflanzen: [{ name_deutsch: 'Lavendel', name_botanisch: 'Lavandula angustifolia' }], vielfalt: 'normal', dichte: 'normal' } },
  { name: 'gross-vielfalt', body: { gartenflaeche: 40, licht: 'Vollsonne (6+ h)', boden: 'Normal / humos', stil: 'Cottage-Garten / Englisch', vielfalt: 'viel', dichte: 'normal' } },
  { name: 'geophyten', body: { gartenflaeche: 15, licht: 'Halbschatten (3–6 h)', boden: 'Normal / humos', stil: 'Naturgarten / Wildgarten', geophyten: true, vielfalt: 'normal', dichte: 'normal' } },
];

const SEASON_KEYS = {
  fruehling: ['jan', 'feb', 'mär', 'mar', 'apr', 'mai', 'frühjahr', 'frühling'],
  sommer:    ['jun', 'jul', 'aug', 'sommer'],
  herbst:    ['sep', 'okt', 'nov', 'herbst'],
};
function bloomsIn(bluehzeit, season) {
  const s = String(bluehzeit || '').toLowerCase();
  return SEASON_KEYS[season].some(k => s.includes(k));
}

// ── Bewertung eines Plans → { kriterium: 'pass'|'fail'|'na' } ──
function scorePlan(brief, plan) {
  const R = {};
  const ps = Array.isArray(plan && plan.pflanzen) ? plan.pflanzen : null;
  R.json_valide = ps && ps.length > 0 ? 'pass' : 'fail';
  if (!ps || !ps.length) {
    ['rollen_minima', 'arten_band', 'stueckzahl_ok', 'dichte_plausibel', 'budget_ok', 'lieblinge_ok', 'bluete_folge', 'keine_halluzination'].forEach(k => R[k] = 'fail');
    return R;
  }
  const stauden = ps.filter(p => p.rolle !== 'Geophyt');
  const leit = stauden.filter(p => p.rolle === 'Leitstaude').length;
  const begleit = stauden.filter(p => p.rolle === 'Begleitstaude').length;
  const fuell = stauden.filter(p => p.rolle === 'Füllstaude').length;
  R.rollen_minima = (leit >= 1 && leit <= 3 && begleit >= 3 && fuell >= 2) ? 'pass' : 'fail';

  const n = stauden.length;
  const band = brief.body.vielfalt === 'viel' ? [8, 99] : brief.body.vielfalt === 'wenig' ? [6, 7] : [5, 8];
  R.arten_band = (n >= band[0] && n <= band[1]) ? 'pass' : 'fail';

  R.stueckzahl_ok = stauden.every(p => Number(p.stueckzahl) > 0) ? 'pass' : 'fail';

  const ppm2 = brief.body.dichte === 'locker' ? 2.5 : brief.body.dichte === 'dicht' ? 7 : 4;
  const ziel = brief.body.gartenflaeche * ppm2;
  const summe = stauden.reduce((s, p) => s + (Number(p.stueckzahl) || 0), 0);
  R.dichte_plausibel = (summe >= ziel * 0.5 && summe <= ziel * 1.8) ? 'pass' : 'fail';

  if (brief.body.budget == null) R.budget_ok = 'na';
  else {
    const kosten = ps.reduce((s, p) => s + (Number(p.preis_stueck_eur) || 0) * (Number(p.stueckzahl) || 0), 0);
    R.budget_ok = kosten <= brief.body.budget * 1.1 ? 'pass' : 'fail';
  }

  const lieb = brief.body.lieblingspflanzen;
  if (!Array.isArray(lieb) || !lieb.length) R.lieblinge_ok = 'na';
  else {
    const bots = ps.map(p => String(p.name_botanisch || '').toLowerCase());
    const tipps = JSON.stringify(plan.tipps || []).toLowerCase();
    R.lieblinge_ok = lieb.every(l => {
      const gen = String(l.name_botanisch || '').toLowerCase().split(' ')[0];
      const de = String(l.name_deutsch || '').toLowerCase();
      return bots.some(b => b.startsWith(gen)) || tipps.includes(gen) || tipps.includes(de);
    }) ? 'pass' : 'fail';
  }

  const seasons = ['fruehling', 'sommer', 'herbst'];
  R.bluete_folge = seasons.every(se => ps.filter(p => bloomsIn(p.bluehzeit, se)).length >= 2) ? 'pass' : 'fail';

  const unmatched = ps.filter(p => !dbMatch(p.name_botanisch)).length;
  R.keine_halluzination = unmatched === 0 ? 'pass' : 'fail';
  R._halluziniert = unmatched;
  return R;
}

function post(route, body) {
  return new Promise((resolve) => {
    const data = JSON.stringify(body);
    const req = http.request(BASE + route, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      timeout: 90000,
    }, (res) => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => { try { resolve({ status: res.statusCode, json: JSON.parse(buf) }); } catch { resolve({ status: res.statusCode, json: null }); } });
    });
    req.on('error', () => resolve({ status: 0, json: null }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, json: null }); });
    req.write(data); req.end();
  });
}
function waitForServer(timeoutMs = 30000) {
  const start = Date.now();
  return new Promise((resolve) => {
    (function ping() {
      const req = http.get(BASE + '/robots.txt', (res) => { res.resume(); resolve(true); });
      req.on('error', () => { if (Date.now() - start > timeoutMs) resolve(false); else setTimeout(ping, 500); });
    })();
  });
}

const CRITERIA = ['json_valide', 'rollen_minima', 'arten_band', 'stueckzahl_ok', 'dichte_plausibel', 'budget_ok', 'lieblinge_ok', 'bluete_folge', 'keine_halluzination'];

(async () => {
  console.log(`\nEval-Harness: ${MODELS.join(' vs ')} · ${BRIEFS.length} Briefs × ${RUNS} Läufe = ${BRIEFS.length * RUNS} Pläne/Modell\n`);
  const child = spawn('node', ['stauden-server.js'], {
    cwd: ROOT, env: { ...process.env, PORT: String(PORT), RATE_LIMIT_DISABLED: '1' }, stdio: ['ignore', 'ignore', 'pipe'],
  });
  child.stderr.on('data', d => { const s = d.toString(); if (/Fehler|Error/i.test(s) && !/Deprecation/.test(s)) process.stderr.write('[server] ' + s); });

  const up = await waitForServer();
  if (!up) { console.error('Server nicht erreichbar.'); child.kill(); process.exit(1); }

  const results = {};
  for (const model of MODELS) {
    results[model] = [];
    for (const brief of BRIEFS) {
      for (let run = 1; run <= RUNS; run++) {
        const t0 = Date.now();
        const res = await post(`/api/plan?model=${encodeURIComponent(model)}`, brief.body);
        const score = scorePlan(brief, res.json && res.json.plan);
        results[model].push({ brief: brief.name, score });
        const passed = CRITERIA.filter(c => score[c] === 'pass').length;
        const applic = CRITERIA.filter(c => score[c] !== 'na').length;
        console.log(`  ${model.padEnd(12)} ${brief.name.padEnd(26)} #${run}  ${passed}/${applic} ok${score._halluziniert ? `  (${score._halluziniert} nicht-DB)` : ''}${res.status !== 200 ? `  [HTTP ${res.status}]` : ''}  ${((Date.now() - t0) / 1000).toFixed(1)}s`);
      }
    }
  }
  child.kill('SIGINT');
  setTimeout(() => child.kill('SIGKILL'), 2000);

  // ── Pass-Raten-Tabelle ──
  const pct = (arr, c) => {
    const app = arr.filter(r => r.score[c] !== 'na');
    if (!app.length) return '  – ';
    const p = app.filter(r => r.score[c] === 'pass').length;
    return String(Math.round(p / app.length * 100)).padStart(3) + '%';
  };
  console.log('\n─── Pass-Raten je Kriterium ' + '─'.repeat(40));
  console.log('Kriterium'.padEnd(22) + MODELS.map(m => m.padStart(10)).join(''));
  for (const c of CRITERIA) console.log(c.padEnd(22) + MODELS.map(m => pct(results[m], c).padStart(10)).join(''));
  console.log('─'.repeat(66));
  const overall = m => {
    const all = results[m].flatMap(r => CRITERIA.filter(c => r.score[c] !== 'na').map(c => r.score[c] === 'pass'));
    return Math.round(all.filter(Boolean).length / all.length * 100) + '%';
  };
  console.log('GESAMT'.padEnd(22) + MODELS.map(m => overall(m).padStart(10)).join(''));
  console.log('\nEntscheidungsregel: liegt mini bei den harten Kriterien (keine_halluzination,');
  console.log('rollen_minima, lieblinge_ok) innerhalb ~5pp von 4o → mini(-Hybrid) ist tragbar.\n');
  process.exit(0);
})();
