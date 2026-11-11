const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { Pool } = require('pg');

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
if (!TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL wajib menunjuk ke database PostgreSQL khusus untuk tes.');
const pool = new Pool({ connectionString: TEST_DATABASE_URL });
test.after(async () => pool.end());

const TEST_USERS = [
  { id: 'admin', username: 'admin', password: 'admin123', name: 'Platform Admin', role: 'super-admin', tenantId: 'dfixer-store' },
];

async function startServer({ port, schema, env = {} }) {
  await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  await pool.query(`CREATE SCHEMA "${schema}"`);
  const child = spawn(process.execPath, ['server.js'], {
    cwd: __dirname,
    env: {
      ...process.env,
      PORT: String(port),
      DATABASE_URL: TEST_DATABASE_URL,
      DATABASE_SCHEMA: schema,
      NODE_ENV: 'test',
      ORDERGUARD_TEST_USERS: JSON.stringify(TEST_USERS),
      ORDERGUARD_TEST_SEED_DEMO: '1',
      ORDERGUARD_ACCESS_LOG: '0',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
  child.stderr.setEncoding('utf8');
  const started = Date.now();
  while (Date.now() - started < 10000) {
    if (child.exitCode !== null) throw new Error(`server exited early with ${child.exitCode}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/ready`);
      if (response.ok) return { child, stdout: () => stdout, schema };
    } catch { /* not ready yet */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('server did not become ready in time');
}

async function stopServer(server) {
  const exited = new Promise((resolve) => server.child.once('exit', (code, signal) => resolve({ code, signal })));
  server.child.kill('SIGTERM');
  const result = await Promise.race([
    exited,
    new Promise((resolve) => setTimeout(() => resolve({ code: 'timeout', signal: null }), 15000)),
  ]);
  await pool.query(`DROP SCHEMA IF EXISTS "${server.schema}" CASCADE`);
  return result;
}

test('readiness, liveness, and gated metrics endpoint', async () => {
  const server = await startServer({ port: 4390, schema: 'orderguard_ops_ready', env: { ORDERGUARD_METRICS_TOKEN: 'ops-test-token' } });
  try {
    const health = await fetch('http://127.0.0.1:4390/api/health');
    assert.equal(health.status, 200);
    const healthBody = await health.json();
    assert.equal(healthBody.status, 'ok');
    assert.ok(Number.isInteger(healthBody.uptimeSeconds));

    const ready = await fetch('http://127.0.0.1:4390/api/ready');
    assert.equal(ready.status, 200);
    const readyBody = await ready.json();
    assert.equal(readyBody.status, 'ready');
    assert.equal(readyBody.database, 'ok');

    const unauthorized = await fetch('http://127.0.0.1:4390/api/metrics');
    assert.equal(unauthorized.status, 401);
    const wrongToken = await fetch('http://127.0.0.1:4390/api/metrics', { headers: { Authorization: 'Bearer wrong' } });
    assert.equal(wrongToken.status, 401);
    const metricsResponse = await fetch('http://127.0.0.1:4390/api/metrics', { headers: { Authorization: 'Bearer ops-test-token' } });
    assert.equal(metricsResponse.status, 200);
    const metricsBody = await metricsResponse.text();
    assert.match(metricsBody, /orderguard_up 1/);
    assert.match(metricsBody, /orderguard_requests_total \d+/);
    assert.match(metricsBody, /orderguard_db_up 1/);
  } finally {
    const exit = await stopServer(server);
    assert.equal(exit.code, 0);
    assert.match(server.stdout(), /shutdown_complete/);
  }
});

test('metrics endpoint is hidden when no token is configured', async () => {
  const server = await startServer({ port: 4391, schema: 'orderguard_ops_metrics_off' });
  try {
    const response = await fetch('http://127.0.0.1:4391/api/metrics');
    assert.equal(response.status, 404);
  } finally {
    await stopServer(server);
  }
});

test('SIGTERM performs graceful shutdown and closes the listener', async () => {
  const server = await startServer({ port: 4392, schema: 'orderguard_ops_shutdown', env: { ORDERGUARD_SHUTDOWN_TIMEOUT_MS: '5000' } });
  const exit = await stopServer(server);
  assert.equal(exit.code, 0);
  assert.match(server.stdout(), /shutdown_start/);
  assert.match(server.stdout(), /shutdown_complete/);
  await assert.rejects(fetch('http://127.0.0.1:4392/api/health'));
});
