const { spawn } = require('node:child_process');
const { Client } = require('pg');
const path = require('node:path');

const APP_DIR = path.join(__dirname, '..');
const DATABASE_URL = process.env.TEST_DATABASE_URL;
const PORT = Number(process.env.LOAD_TEST_PORT || 4563);
const SCHEMA = process.env.LOAD_TEST_SCHEMA || 'orderguard_load_test';
const users = [
  { id: 'admin', username: 'admin', password: 'admin123', name: 'Platform Admin', role: 'super-admin', tenantId: 'dfixer-store' },
];
if (!DATABASE_URL) throw new Error('TEST_DATABASE_URL wajib diatur untuk load test.');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const now = () => performance.now();

async function waitForServer(child) {
  const started = Date.now();
  while (Date.now() - started < 20000) {
    if (child.exitCode !== null) throw new Error('load test server exited');
    try { if ((await fetch(`http://127.0.0.1:${PORT}/api/health`)).ok) return; } catch {}
    await sleep(100);
  }
  throw new Error('load test server start timeout');
}

function percentiles(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const pick = (p) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))] : 0;
  return { median: Number(pick(50).toFixed(2)), p95: Number(pick(95).toFixed(2)), p99: Number(pick(99).toFixed(2)) };
}

async function runQueue(tasks, fn, concurrency = 20) {
  const results = [];
  let cursor = 0;
  const worker = async () => {
    while (true) {
      const index = cursor++;
      if (index >= tasks.length) return;
      results[index] = await fn(tasks[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(tasks.length, concurrency) }, worker));
  return results;
}

async function main() {
  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();
  await client.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
  await client.query(`CREATE SCHEMA "${SCHEMA}"`);
  await client.end();

  const child = spawn(process.execPath, [path.join(APP_DIR, 'server.js')], {
    cwd: APP_DIR,
    env: {
      ...process.env,
      PORT: String(PORT),
      DATABASE_URL,
      DATABASE_SCHEMA: SCHEMA,
      NODE_ENV: 'test',
      ORDERGUARD_TEST_USERS: JSON.stringify(users),
      ORDERGUARD_TEST_SEED_DEMO: '1',
      TIKTOK_APP_KEY: '',
      TIKTOK_APP_SECRET: '',
      TIKTOK_REDIRECT_URI: '',
      ORDERGUARD_TOKEN_ENCRYPTION_KEY: '',
    },
    stdio: ['ignore', 'ignore', 'ignore'],
  });

  try {
    await waitForServer(child);
    const login = await fetch(`http://127.0.0.1:${PORT}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin123' }),
    });
    const loginBody = await login.json();
    const cookie = /orderguard_session=([^;]+)/.exec(login.headers.get('set-cookie') || '')?.[1];
    if (!login.ok || !cookie || !loginBody.csrfToken) throw new Error('load test login failed');
    const authHeaders = { Cookie: `orderguard_session=${cookie}` };
    const writeHeaders = { ...authHeaders, 'Content-Type': 'application/json', 'X-CSRF-Token': loginBody.csrfToken };

    const getState = async () => {
      const response = await fetch(`http://127.0.0.1:${PORT}/api/state`, { headers: authHeaders });
      return { response, body: await response.json(), version: Number(response.headers.get('x-state-version')) };
    };
    const postState = (state, version) => fetch(`http://127.0.0.1:${PORT}/api/state`, {
      method: 'POST',
      headers: { ...writeHeaders, 'If-Match': `"state-${version}"` },
      body: JSON.stringify(state),
    });

    const metrics = [];
    const measureRead = async (name, vus, requests, url, headers) => {
      const started = now();
      const latencies = [];
      const statuses = [];
      await runQueue(Array.from({ length: vus * requests }, (_, index) => index), async () => {
        const begin = now();
        try {
          const response = await fetch(`http://127.0.0.1:${PORT}${url}`, { headers });
          statuses.push(response.status);
          latencies.push(now() - begin);
        } catch {
          statuses.push(0);
          latencies.push(now() - begin);
        }
      }, vus);
      const duration = (now() - started) / 1000;
      metrics.push({ phase: name, virtualUsers: vus, transactions: statuses.length, throughput: Number((statuses.length / duration).toFixed(2)), errors: statuses.filter((status) => status !== 200).length, latencyMs: percentiles(latencies) });
    };

    await measureRead('GET /api/health', 20, 20, '/api/health', {});
    await measureRead('GET /api/state', 10, 20, '/api/state', authHeaders);

    const base = await getState();
    const loadManifestId = `OG-LOAD-${Date.now().toString(36).toUpperCase()}`;
    const packages = Array.from({ length: 20 }, (_, index) => ({ order: `ORD-LOAD-${index}`, tracking: `TRK-LOAD-${String(index).padStart(3, '0')}`, status: 'EXPECTED', scannedAt: null }));
    const loadState = structuredClone(base.body);
    loadState.manifests.unshift({ id: loadManifestId, shop: "D'Fixer Store", courier: 'JNE', date: new Date().toISOString().slice(0, 10), location: 'Load', status: 'OPEN', createdAt: new Date().toISOString(), createdBy: 'Platform Admin', source: 'manual', packages, scans: [], sessions: [] });
    loadState.audit.unshift({ id: `AU-LOAD-${Date.now()}`, actor: 'Platform Admin', action: 'Manifest dibuat manual dengan 20 paket', object: loadManifestId, createdAt: new Date().toISOString() });
    const loadCreate = await postState(loadState, base.version);
    if (loadCreate.status !== 200) throw new Error(`load manifest creation failed: ${loadCreate.status}`);

    const creationLatencies = [];
    const creationStatuses = [];
    let creationRetries = 0;
    const creationStarted = now();
    const creationTasks = Array.from({ length: 10 }, (_, index) => ({ id: `OG-LOAD-CREATE-${index}`, tracking: `TRK-LOAD-CREATE-${index}`, order: `ORD-LOAD-CREATE-${index}` }));
    await runQueue(creationTasks, async (task) => {
      const begin = now();
      let result = 0;
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const current = await getState();
        if (current.body.manifests.some((manifest) => manifest.id === task.id)) { result = 200; break; }
        const next = structuredClone(current.body);
        const createdAt = new Date().toISOString();
        next.manifests.unshift({ id: task.id, shop: "D'Fixer Store", courier: 'JNE', date: createdAt.slice(0, 10), location: 'Load', status: 'OPEN', createdAt, createdBy: 'Platform Admin', source: 'manual', packages: [{ order: task.order, tracking: task.tracking, status: 'EXPECTED', scannedAt: null }], scans: [], sessions: [] });
        next.audit.unshift({ id: `AU-${task.id}`, actor: 'Platform Admin', action: 'Manifest dibuat manual dengan 1 paket', object: task.id, createdAt });
        const response = await postState(next, current.version);
        result = response.status;
        if (response.status === 200) break;
        if (response.status === 409) { creationRetries += 1; continue; }
        break;
      }
      creationStatuses.push(result);
      creationLatencies.push(now() - begin);
    }, 10);
    const creationDuration = (now() - creationStarted) / 1000;
    metrics.push({ phase: 'POST /api/state concurrent manifest creation', virtualUsers: 10, transactions: creationStatuses.length, throughput: Number((creationStatuses.length / creationDuration).toFixed(2)), errors: creationStatuses.filter((status) => status !== 200).length, retries: creationRetries, latencyMs: percentiles(creationLatencies) });

    const scanLatencies = [];
    const scanStatuses = [];
    let scanRetries = 0;
    const scanStarted = now();
    await runQueue(packages.slice(0, 10), async (parcel) => {
      const begin = now();
      let result = 0;
      for (let attempt = 0; attempt < 30; attempt += 1) {
        const current = await getState();
        const manifest = current.body.manifests.find((item) => item.id === loadManifestId);
        const target = manifest.packages.find((item) => item.tracking === parcel.tracking);
        if (target.status !== 'EXPECTED') { result = 200; break; }
        const next = structuredClone(current.body);
        const nextManifest = next.manifests.find((item) => item.id === loadManifestId);
        const nextTarget = nextManifest.packages.find((item) => item.tracking === parcel.tracking);
        const createdAt = new Date().toISOString();
        nextTarget.status = 'SCANNED';
        nextTarget.scannedAt = createdAt;
        nextManifest.scans.push({ tracking: parcel.tracking, result: 'MATCH', createdAt, actor: 'Platform Admin' });
        next.audit.unshift({ id: `AU-SCAN-${parcel.tracking}`, actor: 'Platform Admin', action: `Paket dipindai: ${parcel.tracking}`, object: loadManifestId, createdAt });
        const response = await postState(next, current.version);
        result = response.status;
        if (response.status === 200) break;
        if (response.status === 409) { scanRetries += 1; continue; }
        break;
      }
      scanStatuses.push(result);
      scanLatencies.push(now() - begin);
    }, 10);
    const scanDuration = (now() - scanStarted) / 1000;
    metrics.push({ phase: 'POST /api/state concurrent package scanning', virtualUsers: 10, transactions: scanStatuses.length, throughput: Number((scanStatuses.length / scanDuration).toFixed(2)), errors: scanStatuses.filter((status) => status !== 200).length, retries: scanRetries, latencyMs: percentiles(scanLatencies) });

    const handoverLatencies = [];
    const handoverStatuses = [];
    let handoverRetries = 0;
    const handoverStarted = now();
    await runQueue(packages.slice(0, 5), async (parcel) => {
      const begin = now();
      let result = 0;
      for (let attempt = 0; attempt < 30; attempt += 1) {
        const current = await getState();
        const manifest = current.body.manifests.find((item) => item.id === loadManifestId);
        const target = manifest.packages.find((item) => item.tracking === parcel.tracking);
        if (target.status === 'HANDED_OVER') { result = 200; break; }
        if (target.status !== 'SCANNED') { result = 409; break; }
        const next = structuredClone(current.body);
        const nextManifest = next.manifests.find((item) => item.id === loadManifestId);
        const nextTarget = nextManifest.packages.find((item) => item.tracking === parcel.tracking);
        const createdAt = new Date().toISOString();
        const sessionId = `TR-LOAD-${parcel.tracking}`;
        nextTarget.status = 'HANDED_OVER';
        nextTarget.handedOverAt = createdAt;
        nextTarget.handedOverSessionId = sessionId;
        nextManifest.sessions.push({ id: sessionId, receiver: 'Kurir Load', actor: 'Platform Admin', createdAt, note: '', items: [parcel.tracking], evidence: null });
        nextManifest.status = 'PARTIALLY_HANDED_OVER';
        next.audit.unshift({ id: `AU-HANDOVER-${parcel.tracking}`, actor: 'Platform Admin', action: `Serah terima ${sessionId} dikonfirmasi: 1 diterima`, object: loadManifestId, createdAt });
        const response = await postState(next, current.version);
        result = response.status;
        if (response.status === 200) break;
        if (response.status === 409) { handoverRetries += 1; continue; }
        break;
      }
      handoverStatuses.push(result);
      handoverLatencies.push(now() - begin);
    }, 5);
    const handoverDuration = (now() - handoverStarted) / 1000;
    metrics.push({ phase: 'POST /api/state concurrent handover', virtualUsers: 5, transactions: handoverStatuses.length, throughput: Number((handoverStatuses.length / handoverDuration).toFixed(2)), errors: handoverStatuses.filter((status) => status !== 200).length, retries: handoverRetries, latencyMs: percentiles(handoverLatencies) });

    const memory = await new Promise((resolve) => {
      const fs = require('node:fs');
      try {
        const status = fs.readFileSync(`/proc/${child.pid}/status`, 'utf8');
        const rss = /VmRSS:\s+(\d+)/.exec(status);
        resolve({ rssKb: rss ? Number(rss[1]) : null });
      } catch { resolve({ rssKb: null }); }
    });

    console.log(JSON.stringify({
      generatedAt: new Date().toISOString(),
      database: 'PostgreSQL test database',
      connectionPoolMax: 10,
      serverRssKb: memory.rssKb,
      metrics,
      totalTransactions: metrics.reduce((sum, metric) => sum + metric.transactions, 0),
      totalErrors: metrics.reduce((sum, metric) => sum + metric.errors, 0),
      bottleneck: 'Full JSON tenant_state snapshot writes serialize per tenant via advisory lock; 409 retries increase under concurrent writes.',
    }, null, 2));
  } finally {
    if (child.exitCode === null) {
      const exited = new Promise((resolve) => child.once('exit', resolve));
      child.kill('SIGTERM');
      await exited;
    }
    const cleanup = new Client({ connectionString: DATABASE_URL });
    await cleanup.connect();
    await cleanup.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await cleanup.end();
  }
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
