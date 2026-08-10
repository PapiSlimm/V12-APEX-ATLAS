/**
 * Launch pre-flight check.
 *
 * Run against a deployment BEFORE letting anyone near it. Every check here
 * corresponds to something that would be embarrassing, expensive, or
 * disclosable in production — not style opinions.
 *
 * Exit codes: 0 clean, 1 blockers found, 2 could not reach the deployment.
 *
 * Usage: npm run preflight https://your-deployment
 */

const BASE = process.argv[2] || process.env.PREFLIGHT_URL || 'http://localhost:3000';

type Severity = 'blocker' | 'warning' | 'info';

interface Finding {
  severity: Severity;
  name: string;
  detail: string;
}

const findings: Finding[] = [];
const passes: string[] = [];

const fail = (severity: Severity, name: string, detail: string) => findings.push({ severity, name, detail });
const pass = (name: string) => passes.push(name);

async function main() {
  console.log(`Pre-flight: ${BASE}\n`);

  // ------------------------------------------------------------------ reachable
  let health: any;
  try {
    const res = await fetch(`${BASE}/api/health`);
    health = await res.json();
  } catch (err) {
    console.error(`Cannot reach ${BASE}/api/health — ${err instanceof Error ? err.message : err}`);
    process.exit(2);
  }

  console.log(
    `  storage=${health.storage} tenants=${health.tenants} status=${health.status} ` +
      `marketplaces=${(health.execution?.marketplaces ?? []).join(',') || 'none'}\n`,
  );

  // ------------------------------------------------------------------ TLS
  if (BASE.startsWith('https://')) {
    pass('Served over HTTPS');
  } else if (BASE.includes('localhost') || BASE.includes('127.0.0.1')) {
    fail('info', 'Not HTTPS', 'local deployment, expected');
  } else {
    // Session cookies are set `secure` in production, so over plain HTTP the
    // browser silently discards them and nobody can stay signed in.
    fail('blocker', 'Not served over HTTPS', 'secure cookies require TLS; sign-in will silently fail');
  }

  // ------------------------------------------------------------------ demo accounts
  // The single most common way a demo becomes a breach. Checked two ways: the
  // flag itself, and the documented default password. Testing only the password
  // gives a false pass whenever DEMO_PASSWORD was overridden — the accounts
  // still exist, they just have a different key.
  if (health.demoUsersEnabled) {
    fail(
      'blocker',
      'Demo accounts are seeded',
      'ENABLE_DEMO_USERS=true in production — these accounts and their default password are in the README',
    );
  } else {
    pass('Demo account seeding is disabled');
  }

  const demoLogin = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'alex.atlas@apex.v12', password: 'macaron2026' }),
  });
  if (demoLogin.ok) {
    fail('blocker', 'The documented demo password works', 'anyone who read the README can sign in');
  } else {
    pass('Documented demo credentials are rejected');
  }

  // ------------------------------------------------------------------ audit chain
  if (health.auditChain?.ok) {
    pass(`Audit chain intact across ${health.auditChain.tenants} tenant(s)`);
  } else {
    fail('blocker', 'Audit chain broken', `tenants affected: ${(health.auditChain?.broken ?? []).join(', ')}`);
  }

  // ------------------------------------------------------------------ storage
  if (health.storage === 'sqlite') {
    fail(
      'warning',
      'Running on SQLite',
      'fine for a single node or desktop; use Postgres if you need backups, replication, or more than one instance',
    );
  } else {
    pass('Running on Postgres');
  }

  // ------------------------------------------------------------------ marketplace
  // There is exactly one marketplace and it is internal. Anything else appearing
  // here means someone added an external adapter, which is a product decision
  // that should not arrive silently in a deploy.
  const marketplaces: string[] = health.execution?.marketplaces ?? [];
  const foreign = marketplaces.filter((m) => m !== 'internal');
  if (foreign.length > 0) {
    fail(
      'blocker',
      'A non-internal marketplace adapter is active',
      `unexpected: ${foreign.join(', ')} — Apex Atlas settles media assets internally and has no external exchange integration`,
    );
  } else {
    pass('Settling against the internal marketplace only');
  }

  if (health.execution?.discrepancies > 0) {
    fail(
      'blocker',
      'Ledger disagrees with the marketplace',
      `${health.execution.discrepancies} unresolved discrepancy(ies)`,
    );
  }

  // ------------------------------------------------------------------ the twin
  // The vault drives the risk layer now. A dangling link or an unparseable
  // frontmatter block is not a cosmetic problem — it is a production line the
  // breaker can no longer see.
  try {
    const twin = await fetch(`${BASE}/api/twin/graph`).then((r) => r.json());
    const errors = twin.valuation?.errors ?? 0;
    const warnings = twin.valuation?.warnings ?? 0;

    if (errors > 0) {
      const first = (twin.issues ?? []).find((i: any) => i.severity === 'error');
      fail(
        'blocker',
        'The digital twin has structural errors',
        `${errors} error(s), first: ${first?.slug} — ${first?.message}`,
      );
    } else if (warnings > 0) {
      fail('warning', 'The digital twin has warnings', `${warnings} — see /api/twin/graph`);
    } else {
      pass('Digital twin parses cleanly with no dangling references');
    }
  } catch (err) {
    fail('blocker', 'Cannot derive the digital twin', err instanceof Error ? err.message : String(err));
  }

  // ------------------------------------------------------------------ headers
  const root = await fetch(BASE);
  const csp = root.headers.get('content-security-policy') ?? '';
  const hsts = root.headers.get('strict-transport-security');

  if (!csp) {
    fail('blocker', 'No Content-Security-Policy header', 'helmet is not applying');
  } else if (csp.includes('unsafe-eval')) {
    fail(
      'blocker',
      "CSP allows 'unsafe-eval'",
      'that is the development policy — NODE_ENV is not set to production',
    );
  } else {
    pass("CSP present and forbids 'unsafe-eval'");
  }

  if (BASE.startsWith('https://') && !hsts) {
    fail('warning', 'No Strict-Transport-Security header', 'set it at your TLS terminator');
  }

  // The sandbox must keep its own, stricter policy.
  const sandboxCsp = (await fetch(`${BASE}/repl-sandbox`)).headers.get('content-security-policy') ?? '';
  if (sandboxCsp.includes("connect-src 'none'")) {
    pass('REPL sandbox blocks all network egress');
  } else {
    fail('blocker', 'REPL sandbox CSP is missing or weakened', 'generated code could reach the network');
  }

  // ------------------------------------------------------------------ indexing
  const robots = await fetch(`${BASE}/robots.txt`).then((r) => r.text());
  if (robots.includes('Disallow: /')) {
    pass('Crawlers disallowed on the application host');
  } else {
    fail('warning', 'robots.txt does not disallow crawling', 'app hosts should not be indexed');
  }

  // ------------------------------------------------------------------ auth gates
  const unauth = await fetch(`${BASE}/api/gemini/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: 'probe' }),
  });
  if (unauth.status === 401) {
    pass('Model endpoints require authentication');
  } else {
    fail('blocker', 'Model endpoints are reachable unauthenticated', `status ${unauth.status} — this spends your API budget`);
  }

  const unauthTrade = await fetch(`${BASE}/api/execution/order`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ assetId: 'X', side: 'buy', quantity: 1, type: 'market' }),
  });
  if (unauthTrade.status === 401) {
    pass('Asset instructions require authentication');
  } else {
    fail('blocker', 'Asset instructions reachable unauthenticated', `status ${unauthTrade.status}`);
  }

  // ------------------------------------------------------------------ commercial readiness
  // Not security, but the difference between "deployed" and "a business".
  fail(
    'warning',
    'No usage metering',
    'inference spend per account is not measured, so tier pricing is a guess and overage cannot be billed',
  );
  fail('warning', 'No billing integration', 'seats and entitlements are enforced, but nothing takes payment');
  fail(
    'warning',
    'Rate limits and kill switch are per-process',
    'two instances means two independent limiters and a halt that stops only one — move to Redis before scaling out',
  );

  // ------------------------------------------------------------------ report
  const blockers = findings.filter((f) => f.severity === 'blocker');
  const warnings = findings.filter((f) => f.severity === 'warning');

  for (const p of passes) console.log(`PASS     ${p}`);
  console.log('');
  for (const f of warnings) console.log(`WARN     ${f.name} — ${f.detail}`);
  for (const f of blockers) console.log(`BLOCKER  ${f.name} — ${f.detail}`);

  console.log(
    `\n${passes.length} passed · ${warnings.length} warning(s) · ${blockers.length} blocker(s)`,
  );

  if (blockers.length > 0) {
    console.log('\nDo not put users on this until the blockers are cleared.');
    process.exit(1);
  }

  console.log('\nNo blockers. Warnings above are business readiness, not safety —');
  console.log('a free or waitlisted launch can proceed; charging money cannot until metering and billing exist.');
}

main().catch((err) => {
  console.error('Pre-flight failed:', err instanceof Error ? err.message : err);
  process.exit(2);
});
