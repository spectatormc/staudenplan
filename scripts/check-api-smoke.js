const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

const projectRoot = path.resolve(__dirname, '..');
const port = Number(process.env.SMOKE_PORT || 3310);
const baseUrl = `http://127.0.0.1:${port}`;

function request(route) {
  return new Promise((resolve, reject) => {
    const req = http.request(baseUrl + route, { method: 'GET' }, (res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk.toString()));
      res.on('end', () => resolve({ status: res.statusCode || 0, body }));
    });
    req.on('error', reject);
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

(async () => {
  const child = spawn('node', ['stauden-server.js'], {
    cwd: projectRoot,
    env: { ...process.env, PORT: String(port) },
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

    process.exitCode = errors > 0 ? 1 : 0;
  } finally {
    child.kill('SIGINT');
    setTimeout(() => {
      if (!child.killed) child.kill('SIGKILL');
    }, 1500);
  }
})();
