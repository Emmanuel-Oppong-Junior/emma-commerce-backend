const { spawnSync } = require('node:child_process');
const path = require('node:path');

const BLOCKING_SEVERITY = 'critical';
const allowlist = require(path.join(__dirname, 'audit-allowlist.json'));

function runNpmAudit() {
  const result = spawnSync('npm audit --omit=dev --json', { encoding: 'utf8', shell: true });
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error(`npm audit did not return JSON (exit ${result.status}): ${result.stderr || result.stdout}`);
  }
}

function blockingAdvisories(report) {
  if (report.error) throw new Error(`npm audit failed: ${JSON.stringify(report.error)}`);
  const advisories = new Map();
  for (const vulnerability of Object.values(report.vulnerabilities ?? {})) {
    for (const via of vulnerability.via) {
      if (typeof via === 'object' && via.severity === BLOCKING_SEVERITY) {
        advisories.set(via.url, `${via.name} ${via.range}: ${via.title}`);
      }
    }
  }
  return advisories;
}

const found = blockingAdvisories(runNpmAudit());
const allowed = new Set(allowlist.map((entry) => entry.advisory));
const unexpected = [...found].filter(([url]) => !allowed.has(url));
const stale = allowlist.filter((entry) => !found.has(entry.advisory));

for (const entry of stale) {
  console.log(`Allowlisted advisory no longer reported, remove it from audit-allowlist.json: ${entry.advisory}`);
}
console.log(`${found.size} ${BLOCKING_SEVERITY} production advisories, ${found.size - unexpected.length} allowlisted.`);

if (unexpected.length > 0) {
  console.error(`New ${BLOCKING_SEVERITY} production advisories (not in scripts/audit-allowlist.json):`);
  for (const [url, summary] of unexpected) console.error(`  ${url}  ${summary}`);
  process.exit(1);
}
