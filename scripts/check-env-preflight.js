const fs = require('fs');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..');
const envExamplePath = path.join(projectRoot, '.env.example');
const envPath = path.join(projectRoot, '.env');
const strictMode = process.argv.includes('--strict') || process.env.STRICT_MODE === '1';

function parseEnv(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const raw = fs.readFileSync(filePath, 'utf8');
  const out = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
    const idx = trimmed.indexOf('=');
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim();
    out[key] = value;
  }
  return out;
}

const expected = parseEnv(envExamplePath);
const actual = { ...expected, ...parseEnv(envPath), ...process.env };

let errors = 0;
let warnings = 0;

const requiredHard = ['PORT', 'SITE_URL', 'ADMIN_PASSWORT'];
for (const key of requiredHard) {
  if (!actual[key] || actual[key].includes('...')) {
    console.error(`ERROR: Required key '${key}' is missing or placeholder.`);
    errors += 1;
  }
}

if (!actual.OPENAI_API_KEY || actual.OPENAI_API_KEY.includes('...')) {
  console.warn('WARN: OPENAI_API_KEY missing or placeholder. KI features may fail.');
  warnings += 1;
}

const smtpFields = ['EMAIL_HOST', 'EMAIL_PORT', 'EMAIL_USER', 'EMAIL_PASS', 'EMAIL_BETREIBER'];
const smtpSet = smtpFields.filter((k) => actual[k] && !String(actual[k]).includes('...'));
if (smtpSet.length > 0 && smtpSet.length < smtpFields.length) {
  const msg = 'SMTP is partially configured. Set all EMAIL_* fields or none.';
  if (strictMode) {
    console.error(`ERROR: ${msg}`);
    errors += 1;
  } else {
    console.warn(`WARN: ${msg}`);
    warnings += 1;
  }
}

if (!fs.existsSync(envPath)) {
  console.warn('WARN: .env not found. Using process env / defaults only.');
  warnings += 1;
}

console.log('--- Stauden Env Preflight ---');
console.log(`Found .env.example: ${fs.existsSync(envExamplePath) ? 'yes' : 'no'}`);
console.log(`Found .env: ${fs.existsSync(envPath) ? 'yes' : 'no'}`);
console.log(`Warnings: ${warnings}`);
console.log(`Errors: ${errors}`);

process.exit(errors > 0 ? 1 : 0);
