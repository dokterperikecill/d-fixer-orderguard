const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { Pool } = require('pg');
const crypto = require('node:crypto');

// Test helper: keep CSRF handling out of individual test calls while still
// exercising the real server-side CSRF checks in dedicated negative tests.
const nativeFetch = globalThis.fetch;
const csrfTokensByCookie = new Map();
globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : String(input?.url || input);
  const method = String(init.method || input?.method || 'GET').toUpperCase();
  const headers = new Headers(init.headers || input?.headers || undefined);
  const cookie = headers.get('cookie') || '';
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method) && cookie && !headers.has('x-csrf-token')) {
    const token = csrfTokensByCookie.get(cookie);
    if (token) headers.set('x-csrf-token', token);
  }
  const response = await nativeFetch(input, { ...init, headers });
  if (url.endsWith('/api/login') && response.ok) {
    const payload = await response.clone().json().catch(() => null);
    const setCookie = response.headers.get('set-cookie') || '';
    const session = /orderguard_session=([^;]+)/.exec(setCookie);
    if (session && payload?.csrfToken) csrfTokensByCookie.set(`orderguard_session=${session[1]}`, payload.csrfToken);
  }
  if (url.endsWith('/api/session') && response.ok && cookie) {
    const payload = await response.clone().json().catch(() => null);
    if (payload?.csrfToken) csrfTokensByCookie.set(cookie, payload.csrfToken);
  }
  return response;
};

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
if (!TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL wajib menunjuk ke database PostgreSQL khusus untuk tes.');
const testDatabase = new Pool({ connectionString: TEST_DATABASE_URL });
test.after(async () => testDatabase.end());

const TEST_USERS = [
  { id: 'admin', username: 'admin', password: 'admin123', name: 'Platform Admin', role: 'super-admin', tenantId: 'dfixer-store' },
  { id: 'rani', username: 'rani', password: 'rani123', name: 'Rani Admin', role: 'store-admin', tenantId: 'dfixer-store' },
  { id: 'handover', username: 'handover', password: 'handover123', name: 'Budi Handover', role: 'handover-staff', tenantId: 'dfixer-store' },
  { id: 'maya', username: 'maya', password: 'maya123', name: 'Maya Admin', role: 'store-admin', tenantId: 'maya-commerce' },
];

function startTestServer(port, schema, extraEnv = {}) {
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
      TIKTOK_APP_KEY: '',
      TIKTOK_APP_SECRET: '',
      TIKTOK_REDIRECT_URI: '',
      ORDERGUARD_TOKEN_ENCRYPTION_KEY: '',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return child;
}

async function createTestServer(port, prepareDatabase, schema = `orderguard_test_${port}`) {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(schema)) throw new Error('Invalid test schema.');
  await testDatabase.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  await testDatabase.query(`CREATE SCHEMA "${schema}"`);
  if (prepareDatabase) await prepareDatabase(schema);
  return { child: startTestServer(port, schema), schema, port };
}

async function stopTestServer(server, removeSchema = true) {
  const exited = new Promise((resolve) => server.child.once('exit', resolve));
  server.child.kill('SIGTERM');
  await exited;
  if (removeSchema) await testDatabase.query(`DROP SCHEMA IF EXISTS "${server.schema}" CASCADE`);
}

function waitForServer(port) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      fetch(`http://127.0.0.1:${port}/api/health`)
        .then((response) => response.ok ? resolve() : reject(new Error(`health check failed: ${response.status}`)))
        .catch(() => {
          if (Date.now() - start > 5000) {
            reject(new Error('server did not start in time'));
            return;
          }
          setTimeout(tick, 150);
        });
    };
    tick();
  });
}

test('server exposes health endpoint and state API', async () => {
  const port = 4310;
  const server = await createTestServer(port);

  try {
    await waitForServer(port);
    const health = await fetch(`http://127.0.0.1:${port}/api/health`);
    const unauthenticatedState = await fetch(`http://127.0.0.1:${port}/api/state`);

    assert.equal(health.status, 200);
    const healthJson = await health.json();
    assert.equal(healthJson.status, 'ok');
    const config = await fetch(`http://127.0.0.1:${port}/api/config`).then((response) => response.json());
    assert.equal(config.environment, 'sandbox');
    assert.equal(unauthenticatedState.status, 401);
    const home = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(home.status, 200);
    const homeHtml = await home.text();
    assert.match(homeHtml, /rel="manifest" href="\/manifest\.webmanifest"/);
    assert.match(home.headers.get('content-security-policy') || '', /default-src 'self'/);
    assert.equal(home.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(home.headers.get('x-powered-by'), null);
    assert.equal((await fetch(`http://127.0.0.1:${port}/app.js`)).status, 200);
    assert.equal((await fetch(`http://127.0.0.1:${port}/evidence.js`)).status, 200);
    assert.equal((await fetch(`http://127.0.0.1:${port}/styles.css`)).status, 200);
    const manifestResponse = await fetch(`http://127.0.0.1:${port}/manifest.webmanifest`);
    assert.equal(manifestResponse.status, 200);
    const manifest = await manifestResponse.json();
    assert.equal(manifest.display, 'standalone');
    assert.deepEqual(manifest.icons.map((icon) => icon.sizes), ['192x192', '512x512']);
    for (const icon of manifest.icons) {
      assert.equal((await fetch(`http://127.0.0.1:${port}${icon.src}`)).status, 200);
    }
    const serviceWorker = await fetch(`http://127.0.0.1:${port}/service-worker.js`);
    assert.equal(serviceWorker.status, 200);
    assert.equal(serviceWorker.headers.get('service-worker-allowed'), '/');
    const serviceWorkerText = await serviceWorker.text();
    assert.match(serviceWorkerText, /url\.pathname\.startsWith\("\/api\/"\)/);
    assert.match(serviceWorkerText, /"\/evidence\.js"/);
    assert.equal((await fetch(`http://127.0.0.1:${port}/icons/unknown.png`)).status, 404);
    assert.equal((await fetch(`http://127.0.0.1:${port}/server.js`)).status, 404);
    assert.equal((await fetch(`http://127.0.0.1:${port}/data/orderguard.db`)).status, 404);
    assert.equal((await fetch(`http://127.0.0.1:${port}/package-lock.json`)).status, 404);

    const login = await fetch(`http://127.0.0.1:${port}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'rani', password: 'rani123' }),
    });

    assert.equal(login.status, 200);
    const cookies = login.headers.get('set-cookie') || '';
    const sessionCookie = /orderguard_session=([^;]+)/.exec(cookies)?.[1];
    assert.ok(sessionCookie);

    const state = await fetch(`http://127.0.0.1:${port}/api/state`, {
      headers: { Cookie: `orderguard_session=${sessionCookie}` },
    });

    assert.equal(state.status, 200);
    const stateJson = await state.json();
    assert.ok(Array.isArray(stateJson.manifests));

    const tiktokStatus = await fetch(`http://127.0.0.1:${port}/api/tiktok/status`, {
      headers: { Cookie: `orderguard_session=${sessionCookie}` },
    });
    assert.equal(tiktokStatus.status, 200);
    assert.equal((await tiktokStatus.json()).configured, false);
    const tiktokShops = await fetch(`http://127.0.0.1:${port}/api/tiktok/shops`, {
      headers: { Cookie: `orderguard_session=${sessionCookie}` },
    });
    assert.deepEqual(await tiktokShops.json(), { shops: [] });
    const tiktokSync = await fetch(`http://127.0.0.1:${port}/api/tiktok/sync`, {
      method: 'POST',
      headers: { Cookie: `orderguard_session=${sessionCookie}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ shopId: 'not-connected' }),
    });
    assert.equal(tiktokSync.status, 503);
  } finally {
    await stopTestServer(server);
  }
});

test('session remains valid after server restart and is removed on logout', async () => {
  const port = 4315;
  let server = await createTestServer(port);

  try {
    await waitForServer(port);
    const login = await fetch(`http://127.0.0.1:${port}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'rani', password: 'rani123' }),
    });
    const cookie = /orderguard_session=([^;]+)/.exec(login.headers.get('set-cookie') || '')?.[1];
    assert.ok(cookie);
    await stopTestServer(server, false);

    server = { ...server, child: startTestServer(port, server.schema) };
    await waitForServer(port);
    const session = await fetch(`http://127.0.0.1:${port}/api/session`, {
      headers: { Cookie: `orderguard_session=${cookie}` },
    }).then((response) => response.json());
    assert.equal(session.user.username, 'rani');

    const logout = await fetch(`http://127.0.0.1:${port}/api/logout`, {
      method: 'POST',
      headers: { Cookie: `orderguard_session=${cookie}` },
    });
    assert.equal(logout.status, 200);
    const expired = await fetch(`http://127.0.0.1:${port}/api/session`, {
      headers: { Cookie: `orderguard_session=${cookie}` },
    }).then((response) => response.json());
    assert.equal(expired.user, null);
  } finally {
    await stopTestServer(server);
  }
});

test('production requires explicit bootstrap credentials and marks session cookies secure', async () => {
  const port = 4316;
  const emptySchema = 'orderguard_test_4316_empty';
  const productionSchema = 'orderguard_test_4316_production';
  await testDatabase.query(`DROP SCHEMA IF EXISTS "${emptySchema}" CASCADE`);
  await testDatabase.query(`DROP SCHEMA IF EXISTS "${productionSchema}" CASCADE`);
  await testDatabase.query(`CREATE SCHEMA "${emptySchema}"`);
  await testDatabase.query(`CREATE SCHEMA "${productionSchema}"`);
  const missingBootstrap = spawn(process.execPath, ['server.js'], {
    cwd: __dirname,
    env: { ...process.env, NODE_ENV: 'production', PORT: String(port), DATABASE_URL: TEST_DATABASE_URL, DATABASE_SCHEMA: emptySchema },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let startupError = '';
  missingBootstrap.stderr.setEncoding('utf8').on('data', (chunk) => { startupError += chunk; });
  const exitCode = await new Promise((resolve) => missingBootstrap.once('exit', resolve));
  assert.equal(exitCode, 1);
  assert.match(startupError, /ORDERGUARD_BOOTSTRAP_PASSWORD/);

  const server = {
    child: spawn(process.execPath, ['server.js'], {
      cwd: __dirname,
      env: {
        ...process.env,
        NODE_ENV: 'production',
        PORT: String(port),
        DATABASE_URL: TEST_DATABASE_URL,
        DATABASE_SCHEMA: productionSchema,
        ORDERGUARD_BOOTSTRAP_USERNAME: 'production-owner',
        ORDERGUARD_BOOTSTRAP_NAME: 'Production Owner',
        ORDERGUARD_BOOTSTRAP_PASSWORD: 'production-test-password-123',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    }),
    schema: productionSchema,
  };

  try {
    await waitForServer(port);
    const config = await fetch(`http://127.0.0.1:${port}/api/config`).then((response) => response.json());
    assert.equal(config.environment, 'production');
    const login = await fetch(`http://127.0.0.1:${port}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'production-owner', password: 'production-test-password-123' }),
    });
    assert.equal(login.status, 200);
    assert.match(login.headers.get('set-cookie') || '', /; Secure(?:;|$)/i);
  } finally {
    await stopTestServer(server);
    await testDatabase.query(`DROP SCHEMA IF EXISTS "${emptySchema}" CASCADE`);
  }
});

test('handover staff can scan packages but cannot change administrative state', async () => {
  const port = 4311;
  const server = await createTestServer(port);

  try {
    await waitForServer(port);

    const login = await fetch(`http://127.0.0.1:${port}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'handover', password: 'handover123' }),
    });

    assert.equal(login.status, 200);
    const cookies = login.headers.get('set-cookie') || '';
    const sessionCookie = /orderguard_session=([^;]+)/.exec(cookies)?.[1];
    assert.ok(sessionCookie);

    const tiktokStatus = await fetch(`http://127.0.0.1:${port}/api/tiktok/status`, {
      headers: { Cookie: `orderguard_session=${sessionCookie}` },
    });
    assert.equal(tiktokStatus.status, 403);
    const tiktokConnect = await fetch(`http://127.0.0.1:${port}/api/tiktok/connect`, {
      headers: { Cookie: `orderguard_session=${sessionCookie}` },
      redirect: 'manual',
    });
    assert.equal(tiktokConnect.status, 403);

    const stateBefore = await fetch(`http://127.0.0.1:${port}/api/state`, {
      headers: { Cookie: `orderguard_session=${sessionCookie}` },
    });

    assert.equal(stateBefore.status, 200);
    const state = await stateBefore.json();
    assert.ok(Array.isArray(state.manifests));
    const manifest = state.manifests[0];
    const parcel = manifest.packages.find((item) => item.status === 'EXPECTED');
    const scannedAt = new Date().toISOString();
    parcel.status = 'SCANNED';
    parcel.scannedAt = scannedAt;
    manifest.scans.push({ tracking: parcel.tracking, result: 'MATCH', createdAt: scannedAt, actor: 'Budi Handover' });
    state.audit.unshift({ id: 'AU-HANDOVER-TEST', actor: 'Budi Handover', action: `Paket dipindai: ${parcel.tracking}`, object: manifest.id, createdAt: scannedAt });

    const update = await fetch(`http://127.0.0.1:${port}/api/state`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: `orderguard_session=${sessionCookie}`,
      },
      body: JSON.stringify(state),
    });

    assert.equal(update.status, 200);
    const updateJson = await update.json();
    assert.equal(updateJson.ok, true);

    let persistedState = await fetch(`http://127.0.0.1:${port}/api/state`, {
      headers: { Cookie: `orderguard_session=${sessionCookie}` },
    }).then((response) => response.json());

    const handoverState = structuredClone(persistedState);
    const handoverManifest = handoverState.manifests[0];
    const scannedPackages = handoverManifest.packages.filter((item) => item.status === 'SCANNED');
    const acceptedTracking = scannedPackages[0].tracking;
    const rejectedPackages = scannedPackages.slice(1);
    const sessionId = 'TR-TEST-HANDOVER';
    const handedOverAt = new Date().toISOString();
    handoverManifest.packages.forEach((item) => {
      if (item.status === 'SCANNED') item.status = item.tracking === acceptedTracking ? 'HANDED_OVER' : 'REJECTED';
    });
    handoverManifest.sessions.push({ id: sessionId, receiver: 'Kurir Test', actor: 'Budi Handover', createdAt: handedOverAt, note: '', items: [acceptedTracking], evidence: null });
    handoverManifest.status = 'PARTIALLY_HANDED_OVER';
    for (const item of rejectedPackages) {
      handoverState.incidents.unshift({ id: `INC-${item.tracking}`, category: 'Paket ditolak kurir', manifestId: handoverManifest.id, tracking: item.tracking, description: `Ditolak pada sesi ${sessionId}`, reportedBy: 'Budi Handover', createdAt: handedOverAt, status: 'OPEN', resolution: '' });
    }
    handoverState.audit.unshift({ id: 'AU-HANDOVER-CONFIRM', actor: 'Budi Handover', action: `Serah terima ${sessionId} dikonfirmasi: 1 diterima, ${rejectedPackages.length} ditolak`, object: handoverManifest.id, createdAt: handedOverAt });
    const handoverUpdate = await fetch(`http://127.0.0.1:${port}/api/state`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `orderguard_session=${sessionCookie}` },
      body: JSON.stringify(handoverState),
    });
    const handoverResult = await handoverUpdate.json();
    assert.equal(handoverUpdate.status, 200, handoverResult.error);
    persistedState = await fetch(`http://127.0.0.1:${port}/api/state`, {
      headers: { Cookie: `orderguard_session=${sessionCookie}` },
    }).then((response) => response.json());

    const maliciousPayload = { ...persistedState, importJobs: [{ id: 'forged-import' }] };
    const forbiddenUpdate = await fetch(`http://127.0.0.1:${port}/api/state`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `orderguard_session=${sessionCookie}` },
      body: JSON.stringify(maliciousPayload),
    });
    assert.equal(forbiddenUpdate.status, 403);

    const stateAfterAttack = await fetch(`http://127.0.0.1:${port}/api/state`, {
      headers: { Cookie: `orderguard_session=${sessionCookie}` },
    }).then((response) => response.json());
    assert.deepEqual(stateAfterAttack, persistedState);
  } finally {
    await stopTestServer(server);
  }
});

test('tenant state is isolated and legacy D\'Fixer data is preserved', async () => {
  const port = 4312;
  const server = await createTestServer(port, async (schema) => {
    await testDatabase.query(`CREATE TABLE "${schema}".app_state (id TEXT PRIMARY KEY, payload TEXT NOT NULL, updated_at TEXT NOT NULL)`);
    await testDatabase.query(`INSERT INTO "${schema}".app_state (id, payload, updated_at) VALUES ($1, $2, $3)`, [
      'state',
      JSON.stringify({ manifests: [{ id: 'legacy-dfixer' }], incidents: [], audit: [], importJobs: [], marker: 'legacy-state' }),
      new Date().toISOString(),
    ]);
  });

  try {
    await waitForServer(port);

    const raniLogin = await fetch(`http://127.0.0.1:${port}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'rani', password: 'rani123' }),
    });
    const raniUser = (await raniLogin.json()).user;
    const raniCookie = /orderguard_session=([^;]+)/.exec(raniLogin.headers.get('set-cookie') || '')?.[1];
    assert.equal(raniUser.tenantId, 'dfixer-store');
    assert.equal(raniUser.tenantName, "D'Fixer Store");

    const legacyState = await fetch(`http://127.0.0.1:${port}/api/state`, {
      headers: { Cookie: `orderguard_session=${raniCookie}` },
    }).then((response) => response.json());
    assert.equal(legacyState.marker, 'legacy-state');

    const raniUpdate = structuredClone(legacyState);
    const raniIncident = { id: 'INC-RANI-ONLY', category: 'Masalah lain', manifestId: '', tracking: '', description: 'Insiden tenant Rani saja', reportedBy: 'Rani Admin', createdAt: new Date().toISOString(), status: 'OPEN', resolution: '' };
    raniUpdate.incidents.unshift(raniIncident);
    raniUpdate.audit.unshift({ id: 'AU-RANI-ONLY', actor: 'Rani Admin', action: 'Insiden dicatat: Masalah lain', object: raniIncident.id, createdAt: raniIncident.createdAt });
    const raniSave = await fetch(`http://127.0.0.1:${port}/api/state`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `orderguard_session=${raniCookie}` },
      body: JSON.stringify(raniUpdate),
    });
    assert.equal(raniSave.status, 200);

    const tamperedManifestState = structuredClone(raniUpdate);
    tamperedManifestState.manifests[0].id = 'forged-manifest';
    const tamperedManifest = await fetch(`http://127.0.0.1:${port}/api/state`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `orderguard_session=${raniCookie}` },
      body: JSON.stringify(tamperedManifestState),
    });
    assert.equal(tamperedManifest.status, 403);

    const newManifestState = structuredClone(raniUpdate);
    const createdAt = new Date().toISOString();
    const newManifest = { id: 'OG-TEST-001', shop: "D'Fixer Store", courier: 'JNE', date: createdAt.slice(0, 10), location: 'Gudang', status: 'OPEN', createdAt, createdBy: 'Rani Admin', source: 'manual', packages: [{ order: 'ORD-TEST', tracking: 'JNE-TEST-001', status: 'EXPECTED', scannedAt: null }], scans: [], sessions: [] };
    newManifestState.manifests.unshift(newManifest);
    newManifestState.audit.unshift({ id: 'AU-MANIFEST-TEST', actor: 'Rani Admin', action: 'Manifest dibuat manual dengan 1 paket', object: newManifest.id, createdAt });
    const createManifest = await fetch(`http://127.0.0.1:${port}/api/state`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `orderguard_session=${raniCookie}` },
      body: JSON.stringify(newManifestState),
    });
    assert.equal(createManifest.status, 200);

    const importState = structuredClone(newManifestState);
    const importedAt = new Date().toISOString();
    const importJob = { id: 'IMP-TEST-001', fileName: 'orders.csv', total: 1, valid: 1, failed: 0, manifestCount: 1, createdAt: importedAt, errors: [] };
    importState.manifests.unshift({ id: 'OG-TEST-002', shop: "D'Fixer Store", courier: 'JNE', date: importedAt.slice(0, 10), location: 'Gudang', status: 'OPEN', createdAt: importedAt, createdBy: 'Rani Admin', source: importJob.fileName, packages: [{ order: 'ORD-IMPORT', tracking: 'JNE-IMPORT-001', status: 'EXPECTED', scannedAt: null }], scans: [], sessions: [] });
    importState.importJobs.unshift(importJob);
    importState.audit.unshift({ id: 'AU-IMPORT-TEST', actor: 'Rani Admin', action: 'Impor orders.csv: 1 valid, 0 ditolak', object: importJob.id, createdAt: importedAt });
    const importSave = await fetch(`http://127.0.0.1:${port}/api/state`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `orderguard_session=${raniCookie}` },
      body: JSON.stringify(importState),
    });
    assert.equal(importSave.status, 200);

    const mayaLogin = await fetch(`http://127.0.0.1:${port}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'maya', password: 'maya123' }),
    });
    const mayaUser = (await mayaLogin.json()).user;
    const mayaCookie = /orderguard_session=([^;]+)/.exec(mayaLogin.headers.get('set-cookie') || '')?.[1];
    assert.equal(mayaUser.tenantId, 'maya-commerce');
    assert.equal(mayaUser.tenantName, 'Maya Commerce');

    const mayaInitialState = await fetch(`http://127.0.0.1:${port}/api/state`, {
      headers: { Cookie: `orderguard_session=${mayaCookie}` },
    }).then((response) => response.json());
    assert.equal(mayaInitialState.manifests[0].shop, 'Maya Commerce');
    assert.equal(mayaInitialState.incidents.some((incident) => incident.id === raniIncident.id), false);

    const mayaState = structuredClone(mayaInitialState);
    const mayaIncident = { id: 'INC-MAYA-ONLY', category: 'Masalah lain', manifestId: '', tracking: '', description: 'Insiden tenant Maya saja', reportedBy: 'Maya Admin', createdAt: new Date().toISOString(), status: 'OPEN', resolution: '' };
    mayaState.incidents.unshift(mayaIncident);
    mayaState.audit.unshift({ id: 'AU-MAYA-ONLY', actor: 'Maya Admin', action: 'Insiden dicatat: Masalah lain', object: mayaIncident.id, createdAt: mayaIncident.createdAt });
    const mayaSave = await fetch(`http://127.0.0.1:${port}/api/state`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `orderguard_session=${mayaCookie}` },
      body: JSON.stringify(mayaState),
    });
    assert.equal(mayaSave.status, 200);

    const raniAfterMayaUpdate = await fetch(`http://127.0.0.1:${port}/api/state`, {
      headers: { Cookie: `orderguard_session=${raniCookie}` },
    }).then((response) => response.json());
    assert.equal(raniAfterMayaUpdate.incidents.some((incident) => incident.id === mayaIncident.id), false);

    const mayaAfterUpdate = await fetch(`http://127.0.0.1:${port}/api/state`, {
      headers: { Cookie: `orderguard_session=${mayaCookie}` },
    }).then((response) => response.json());
    assert.equal(mayaAfterUpdate.incidents.some((incident) => incident.id === mayaIncident.id), true);
  } finally {
    await stopTestServer(server);
  }
});

test('employee management is super-admin only and updates credentials and access', async () => {
  const port = 4313;
  const server = await createTestServer(port);

  try {
    await waitForServer(port);

    const loginAs = async (username, password) => {
      const response = await fetch(`http://127.0.0.1:${port}/api/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      const payload = await response.json();
      const cookie = /orderguard_session=([^;]+)/.exec(response.headers.get('set-cookie') || '')?.[1];
      return { response, payload, cookie };
    };

    const storeAdmin = await loginAs('rani', 'rani123');
    const forbidden = await fetch(`http://127.0.0.1:${port}/api/users`, {
      headers: { Cookie: `orderguard_session=${storeAdmin.cookie}` },
    });
    assert.equal(forbidden.status, 403);

    const storeState = await fetch(`http://127.0.0.1:${port}/api/state`, {
      headers: { Cookie: `orderguard_session=${storeAdmin.cookie}` },
    }).then((response) => response.json());
    const tamperedAudit = structuredClone(storeState);
    tamperedAudit.audit[0].action = 'Audit lama diubah';
    const auditTamper = await fetch(`http://127.0.0.1:${port}/api/state`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `orderguard_session=${storeAdmin.cookie}` },
      body: JSON.stringify(tamperedAudit),
    });
    assert.equal(auditTamper.status, 403);
    const stateAfterTamper = await fetch(`http://127.0.0.1:${port}/api/state`, {
      headers: { Cookie: `orderguard_session=${storeAdmin.cookie}` },
    }).then((response) => response.json());
    assert.deepEqual(stateAfterTamper, storeState);

    const platformAdmin = await loginAs('admin', 'admin123');
    const listResponse = await fetch(`http://127.0.0.1:${port}/api/users`, {
      headers: { Cookie: `orderguard_session=${platformAdmin.cookie}` },
    });
    assert.equal(listResponse.status, 200);
    const directory = await listResponse.json();
    assert.equal(directory.users.length, 4);
    assert.equal(directory.tenants.length, 2);
    assert.equal(Object.hasOwn(directory.users[0], 'password_hash'), false);

    const createResponse = await fetch(`http://127.0.0.1:${port}/api/users`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `orderguard_session=${platformAdmin.cookie}` },
      body: JSON.stringify({ username: 'staff-test', name: 'Test Staff', password: 'initial123', role: 'handover-staff', tenantId: 'maya-commerce' }),
    });
    assert.equal(createResponse.status, 201);
    const created = (await createResponse.json()).user;
    assert.equal(created.tenantId, 'maya-commerce');
    assert.equal(created.active, true);

    const duplicateResponse = await fetch(`http://127.0.0.1:${port}/api/users`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `orderguard_session=${platformAdmin.cookie}` },
      body: JSON.stringify({ username: 'staff-test', name: 'Duplicate', password: 'initial123', role: 'store-admin', tenantId: 'dfixer-store' }),
    });
    assert.equal(duplicateResponse.status, 409);

    const initialLogin = await loginAs('staff-test', 'initial123');
    assert.equal(initialLogin.response.status, 200);
    const updateResponse = await fetch(`http://127.0.0.1:${port}/api/users/${created.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: `orderguard_session=${platformAdmin.cookie}` },
      body: JSON.stringify({ role: 'store-admin', tenantId: 'dfixer-store', password: 'replacement123' }),
    });
    assert.equal(updateResponse.status, 200);

    const oldPassword = await loginAs('staff-test', 'initial123');
    assert.equal(oldPassword.response.status, 401);
    const revokedPasswordSession = await fetch(`http://127.0.0.1:${port}/api/state`, {
      headers: { Cookie: `orderguard_session=${initialLogin.cookie}` },
    });
    assert.equal(revokedPasswordSession.status, 401);
    const newPassword = await loginAs('staff-test', 'replacement123');
    assert.equal(newPassword.response.status, 200);
    assert.equal(newPassword.payload.user.tenantId, 'dfixer-store');

    const deactivateSelf = await fetch(`http://127.0.0.1:${port}/api/users/${platformAdmin.payload.user.id}`, {
      method: 'DELETE',
      headers: { Cookie: `orderguard_session=${platformAdmin.cookie}` },
    });
    assert.equal(deactivateSelf.status, 400);

    const deactivateResponse = await fetch(`http://127.0.0.1:${port}/api/users/${created.id}`, {
      method: 'DELETE',
      headers: { Cookie: `orderguard_session=${platformAdmin.cookie}` },
    });
    assert.equal(deactivateResponse.status, 200);
    const revokedSession = await fetch(`http://127.0.0.1:${port}/api/state`, {
      headers: { Cookie: `orderguard_session=${newPassword.cookie}` },
    });
    assert.equal(revokedSession.status, 401);

    const changePasswordResponse = await fetch(`http://127.0.0.1:${port}/api/users/${created.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: `orderguard_session=${platformAdmin.cookie}` },
      body: JSON.stringify({ password: 'short' }),
    });
    assert.equal(changePasswordResponse.status, 400);
  } finally {
    await stopTestServer(server);
  }
});

test('super-admin state updates are validated and duplicate tracking numbers are rejected', async () => {
  const port = 4317;
  const server = await createTestServer(port);

  try {
    await waitForServer(port);

    const login = await fetch(`http://127.0.0.1:${port}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin123' }),
    });
    const cookie = /orderguard_session=([^;]+)/.exec(login.headers.get('set-cookie') || '')?.[1];
    assert.equal(login.status, 200);
    assert.ok(cookie);

    const state = await fetch(`http://127.0.0.1:${port}/api/state`, {
      headers: { Cookie: `orderguard_session=${cookie}` },
    }).then((response) => response.json());

    const tampered = structuredClone(state);
    tampered.manifests[0].courier = 'DIUBAH-PLATFORM-ADMIN';
    const tamperedSave = await fetch(`http://127.0.0.1:${port}/api/state`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `orderguard_session=${cookie}` },
      body: JSON.stringify(tampered),
    });
    assert.equal(tamperedSave.status, 403);

    const duplicateTracking = state.manifests[0].packages[0].tracking;
    const createdAt = new Date().toISOString();
    const duplicateState = structuredClone(state);
    const duplicateManifest = { id: 'OG-DUPLICATE-TEST', shop: "D'Fixer Store", courier: 'JNE', date: createdAt.slice(0, 10), location: 'Gudang', status: 'OPEN', createdAt, createdBy: 'Platform Admin', source: 'manual', packages: [{ order: 'ORD-DUPLICATE', tracking: duplicateTracking, status: 'EXPECTED', scannedAt: null }], scans: [], sessions: [] };
    duplicateState.manifests.unshift(duplicateManifest);
    duplicateState.audit.unshift({ id: 'AU-DUPLICATE-TEST', actor: 'Platform Admin', action: 'Manifest dibuat manual dengan 1 paket', object: duplicateManifest.id, createdAt });
    const duplicateSave = await fetch(`http://127.0.0.1:${port}/api/state`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `orderguard_session=${cookie}` },
      body: JSON.stringify(duplicateState),
    });
    const duplicateResult = await duplicateSave.json();
    assert.equal(duplicateSave.status, 403);
    assert.match(duplicateResult.error, /sudah tercatat/);

    const validState = structuredClone(state);
    const validManifest = { ...structuredClone(duplicateManifest), id: 'OG-VALID-TEST', packages: [{ order: 'ORD-VALID', tracking: 'JNE-VALID-TEST-001', status: 'EXPECTED', scannedAt: null }] };
    validState.manifests.unshift(validManifest);
    validState.audit.unshift({ id: 'AU-VALID-TEST', actor: 'Platform Admin', action: 'Manifest dibuat manual dengan 1 paket', object: validManifest.id, createdAt });
    const validSave = await fetch(`http://127.0.0.1:${port}/api/state`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `orderguard_session=${cookie}` },
      body: JSON.stringify(validState),
    });
    const validResult = await validSave.json();
    assert.equal(validSave.status, 200, validResult.error);

    const persisted = await fetch(`http://127.0.0.1:${port}/api/state`, {
      headers: { Cookie: `orderguard_session=${cookie}` },
    }).then((response) => response.json());
    assert.equal(persisted.manifests.some((manifest) => manifest.id === 'OG-VALID-TEST'), true);
    assert.equal(persisted.manifests.some((manifest) => manifest.id === 'OG-DUPLICATE-TEST'), false);

    const storeLogin = await fetch(`http://127.0.0.1:${port}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'rani', password: 'rani123' }),
    });
    const storeCookie = /orderguard_session=([^;]+)/.exec(storeLogin.headers.get('set-cookie') || '')?.[1];
    const storeState = await fetch(`http://127.0.0.1:${port}/api/state`, {
      headers: { Cookie: `orderguard_session=${storeCookie}` },
    }).then((response) => response.json());
    const scannedManifest = storeState.manifests.find((manifest) => manifest.id === 'OG-VALID-TEST');
    const scannedParcel = scannedManifest.packages[0];
    const scannedAt = new Date().toISOString();
    scannedParcel.status = 'SCANNED';
    scannedParcel.scannedAt = scannedAt;
    scannedManifest.scans.push({ tracking: scannedParcel.tracking, result: 'MATCH', createdAt: scannedAt, actor: 'Rani Admin' });
    storeState.audit.unshift({ id: 'AU-SCAN-TEST', actor: 'Rani Admin', action: `Paket dipindai: ${scannedParcel.tracking}`, object: scannedManifest.id, createdAt: scannedAt });
    const scanSave = await fetch(`http://127.0.0.1:${port}/api/state`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `orderguard_session=${storeCookie}` },
      body: JSON.stringify(storeState),
    });
    const scanResult = await scanSave.json();
    assert.equal(scanSave.status, 200, scanResult.error);
  } finally {
    await stopTestServer(server);
  }
});

test('tenant creation and rename are restricted and reflected in employee accounts', async () => {
  const port = 4314;
  const server = await createTestServer(port);

  try {
    await waitForServer(port);

    const loginAs = async (username, password) => {
      const response = await fetch(`http://127.0.0.1:${port}/api/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      const cookie = /orderguard_session=([^;]+)/.exec(response.headers.get('set-cookie') || '')?.[1];
      return { response, cookie };
    };

    const admin = await loginAs('admin', 'admin123');
    const storeAdmin = await loginAs('rani', 'rani123');
    const forbidden = await fetch(`http://127.0.0.1:${port}/api/tenants`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `orderguard_session=${storeAdmin.cookie}` },
      body: JSON.stringify({ id: 'north-store', name: 'North Store' }),
    });
    assert.equal(forbidden.status, 403);

    const invalidTenant = await fetch(`http://127.0.0.1:${port}/api/tenants`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `orderguard_session=${admin.cookie}` },
      body: JSON.stringify({ id: 'North Store', name: 'North Store' }),
    });
    assert.equal(invalidTenant.status, 400);

    const createTenant = await fetch(`http://127.0.0.1:${port}/api/tenants`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `orderguard_session=${admin.cookie}` },
      body: JSON.stringify({ id: 'north-store', name: 'North Store' }),
    });
    assert.equal(createTenant.status, 201);

    const duplicateTenant = await fetch(`http://127.0.0.1:${port}/api/tenants`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `orderguard_session=${admin.cookie}` },
      body: JSON.stringify({ id: 'north-store', name: 'Different Name' }),
    });
    assert.equal(duplicateTenant.status, 409);

    const tenant = (await createTenant.json()).tenant;
    const createEmployee = await fetch(`http://127.0.0.1:${port}/api/users`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `orderguard_session=${admin.cookie}` },
      body: JSON.stringify({ username: 'northstaff', name: 'North Staff', password: 'northpass123', role: 'handover-staff', tenantId: tenant.id }),
    });
    assert.equal(createEmployee.status, 201);

    const renameTenant = await fetch(`http://127.0.0.1:${port}/api/tenants/${tenant.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: `orderguard_session=${admin.cookie}` },
      body: JSON.stringify({ name: 'North Store Operations' }),
    });
    assert.equal(renameTenant.status, 200);

    const staff = await loginAs('northstaff', 'northpass123');
    assert.equal(staff.response.status, 200);
    const session = await fetch(`http://127.0.0.1:${port}/api/session`, {
      headers: { Cookie: `orderguard_session=${staff.cookie}` },
    }).then((response) => response.json());
    assert.equal(session.user.tenantName, 'North Store Operations');
    const state = await fetch(`http://127.0.0.1:${port}/api/state`, {
      headers: { Cookie: `orderguard_session=${staff.cookie}` },
    }).then((response) => response.json());
    assert.deepEqual(state.manifests, []);
    assert.deepEqual(state.incidents, []);
    assert.deepEqual(state.importJobs, []);
    assert.deepEqual(state.orderEvents, []);
    const registry = await testDatabase.query(`SELECT COUNT(*)::INTEGER AS count FROM "${server.schema}".tenant_manifest_ids WHERE tenant_id = $1`, [tenant.id]);
    assert.equal(registry.rows[0].count, 0);

    const directory = await fetch(`http://127.0.0.1:${port}/api/users`, {
      headers: { Cookie: `orderguard_session=${admin.cookie}` },
    }).then((response) => response.json());
    assert.equal(directory.tenants.length, 3);
    assert.equal(directory.tenants.find((item) => item.id === tenant.id).employeeCount, 1);
  } finally {
    await stopTestServer(server);
  }
});

test('order events support cancellation, return receipt, rejection, and unknown tracking rejection', async () => {
  const port = 4318;
  const server = await createTestServer(port);

  try {
    await waitForServer(port);
    const loginAs = async (username, password) => {
      const response = await fetch(`http://127.0.0.1:${port}/api/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      return { response, cookie: /orderguard_session=([^;]+)/.exec(response.headers.get('set-cookie') || '')?.[1] };
    };
    const postEvent = (cookie, body) => fetch(`http://127.0.0.1:${port}/api/order-events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `orderguard_session=${cookie}` },
      body: JSON.stringify(body),
    });
    const readState = (cookie) => fetch(`http://127.0.0.1:${port}/api/state`, {
      headers: { Cookie: `orderguard_session=${cookie}` },
    }).then((response) => response.json());

    const admin = await loginAs('admin', 'admin123');
    const handover = await loginAs('handover', 'handover123');
    assert.equal(admin.response.status, 200);
    assert.equal(handover.response.status, 200);

    const unknown = await postEvent(admin.cookie, { tracking: 'RESI-TIDAK-ADA', type: 'CANCELLATION_AFTER_HANDOVER', reason: 'Uji' });
    assert.equal(unknown.status, 404);

    const handoverCancel = await postEvent(handover.cookie, { tracking: 'JNE0008114201', type: 'CANCELLATION_AFTER_HANDOVER', reason: 'Uji' });
    assert.equal(handoverCancel.status, 403);

    const cancel = await postEvent(admin.cookie, { tracking: 'JNE0008114201', type: 'CANCELLATION_AFTER_HANDOVER', reason: 'Pembeli membatalkan' });
    assert.equal(cancel.status, 201);
    let state = await readState(admin.cookie);
    let parcel = state.manifests.flatMap((manifest) => manifest.packages).find((item) => item.tracking === 'JNE0008114201');
    assert.equal(parcel.status, 'CANCELLATION_AFTER_HANDOVER');
    assert.equal(state.orderEvents[0].type, 'CANCELLATION_AFTER_HANDOVER');

    const startReturn = await postEvent(admin.cookie, { tracking: 'JNE0008114201', type: 'RETURN_IN_TRANSIT', note: 'Kurir menjemput retur' });
    assert.equal(startReturn.status, 201);

    const noPhoto = await postEvent(handover.cookie, { tracking: 'JNE0008114201', type: 'RETURN_RECEIVED' });
    assert.equal(noPhoto.status, 400);

    const received = await postEvent(handover.cookie, { tracking: 'JNE0008114201', type: 'RETURN_RECEIVED', evidence: 'data:image/png;base64,iVBORw0KGgo=' });
    assert.equal(received.status, 201);
    state = await readState(admin.cookie);
    parcel = state.manifests.flatMap((manifest) => manifest.packages).find((item) => item.tracking === 'JNE0008114201');
    assert.equal(parcel.status, 'RETURN_RECEIVED');
    assert.ok(parcel.returnReceivedAt);

    const cancelSecond = await postEvent(admin.cookie, { tracking: 'JNE0008114202', type: 'CANCELLATION_AFTER_HANDOVER', reason: 'Pembeli membatalkan' });
    assert.equal(cancelSecond.status, 201);
    const reject = await postEvent(admin.cookie, { tracking: 'JNE0008114202', type: 'CANCELLATION_REJECTED', reason: 'Marketplace menolak pembatalan' });
    assert.equal(reject.status, 201);
    state = await readState(admin.cookie);
    parcel = state.manifests.flatMap((manifest) => manifest.packages).find((item) => item.tracking === 'JNE0008114202');
    assert.equal(parcel.status, 'HANDED_OVER');
    assert.equal(state.orderEvents[0].type, 'CANCELLATION_REJECTED');

    const cancelBefore = await postEvent(admin.cookie, { tracking: 'JNE0008114203', type: 'CANCELLED_BEFORE_HANDOVER', reason: 'Batal sebelum pickup' });
    assert.equal(cancelBefore.status, 201);
    state = await readState(admin.cookie);
    parcel = state.manifests.flatMap((manifest) => manifest.packages).find((item) => item.tracking === 'JNE0008114203');
    assert.equal(parcel.status, 'CANCELLED_BEFORE_HANDOVER');
  } finally {
    await stopTestServer(server);
  }
});

test('evidence is validated on return receipts and handover sessions', async () => {
  const port = 4320;
  const server = await createTestServer(port);

  try {
    await waitForServer(port);
    const loginAs = async (username, password) => {
      const response = await fetch(`http://127.0.0.1:${port}/api/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      return { response, cookie: /orderguard_session=([^;]+)/.exec(response.headers.get('set-cookie') || '')?.[1] };
    };
    const readState = (cookie) => fetch(`http://127.0.0.1:${port}/api/state`, {
      headers: { Cookie: `orderguard_session=${cookie}` },
    }).then(async (response) => ({ response, state: await response.json(), version: response.headers.get('x-state-version') }));
    const postEvent = (cookie, body) => fetch(`http://127.0.0.1:${port}/api/order-events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `orderguard_session=${cookie}` },
      body: JSON.stringify(body),
    });
    const postState = (cookie, state, version) => fetch(`http://127.0.0.1:${port}/api/state`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `orderguard_session=${cookie}`, 'If-Match': `"state-${version}"` },
      body: JSON.stringify(state),
    });
    const validPhoto = 'data:image/png;base64,iVBORw0KGgo=';
    const maliciousPhotos = [
      'data:image/png;base64,AAAA" onerror="alert(1)',
      'data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9YWxlcnQoMSk+PC9zdmc+',
      'javascript:alert(1)',
      'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==',
    ];

    const admin = await loginAs('admin', 'admin123');
    const handover = await loginAs('handover', 'handover123');
    assert.equal(admin.response.status, 200);
    assert.equal(handover.response.status, 200);

    assert.equal((await postEvent(admin.cookie, { tracking: 'JNE0008114201', type: 'CANCELLATION_AFTER_HANDOVER', reason: 'Uji evidence' })).status, 201);
    assert.equal((await postEvent(admin.cookie, { tracking: 'JNE0008114201', type: 'RETURN_IN_TRANSIT' })).status, 201);
    for (const evidence of maliciousPhotos) {
      const rejected = await postEvent(handover.cookie, { tracking: 'JNE0008114201', type: 'RETURN_RECEIVED', evidence });
      assert.equal(rejected.status, 400, evidence);
    }
    const acceptedEvent = await postEvent(handover.cookie, { tracking: 'JNE0008114201', type: 'RETURN_RECEIVED', evidence: validPhoto });
    assert.equal(acceptedEvent.status, 201);
    let snapshot = await readState(admin.cookie);
    assert.equal(snapshot.state.orderEvents[0].evidence, validPhoto);

    const buildHandover = (base, evidence) => {
      const next = structuredClone(base);
      const manifest = next.manifests.find((item) => item.packages.some((parcel) => parcel.status === 'SCANNED'));
      const scanned = manifest.packages.filter((parcel) => parcel.status === 'SCANNED');
      const createdAt = new Date().toISOString();
      const session = {
        id: 'TR-EVIDENCE-TEST',
        receiver: 'Kurir Test',
        actor: 'Budi Handover',
        createdAt,
        note: '',
        items: scanned.map((parcel) => parcel.tracking),
        evidence,
      };
      for (const parcel of scanned) {
        parcel.status = 'HANDED_OVER';
        parcel.handedOverAt = createdAt;
        parcel.handedOverSessionId = session.id;
      }
      manifest.sessions.push(session);
      manifest.status = manifest.packages.some((parcel) => ['EXPECTED', 'SCANNED', 'REJECTED', 'EXCEPTION', 'CANCELLATION_AFTER_HANDOVER', 'RETURN_IN_TRANSIT'].includes(parcel.status))
        ? 'PARTIALLY_HANDED_OVER'
        : 'CONFIRMED';
      next.audit.unshift({ id: 'AU-EVIDENCE-TEST', actor: 'Budi Handover', action: `Serah terima ${session.id} dikonfirmasi: ${scanned.length} diterima`, object: manifest.id, createdAt });
      return { next, manifestId: manifest.id };
    };

    snapshot = await readState(handover.cookie);
    for (const evidence of maliciousPhotos) {
      const attempt = buildHandover(snapshot.state, evidence);
      const rejected = await postState(handover.cookie, attempt.next, snapshot.version);
      assert.equal(rejected.status, 403, evidence);
    }
    const afterRejected = await readState(handover.cookie);
    assert.equal(afterRejected.version, snapshot.version);
    assert.equal(afterRejected.state.manifests.flatMap((manifest) => manifest.sessions).some((session) => session.id === 'TR-EVIDENCE-TEST'), false);

    const acceptedHandover = buildHandover(snapshot.state, validPhoto);
    const saved = await postState(handover.cookie, acceptedHandover.next, snapshot.version);
    assert.equal(saved.status, 200, JSON.stringify(await saved.json().catch(() => ({}))));
    const persisted = await readState(handover.cookie);
    const session = persisted.state.manifests.find((manifest) => manifest.id === acceptedHandover.manifestId).sessions.find((item) => item.id === 'TR-EVIDENCE-TEST');
    assert.equal(session.evidence, validPhoto);
  } finally {
    await stopTestServer(server);
  }
});

test('concurrent state updates with the same version reject the loser without losing data', async () => {
  const port = 4322;
  const server = await createTestServer(port);

  try {
    await waitForServer(port);
    const login = await fetch(`http://127.0.0.1:${port}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin123' }),
    });
    const cookie = /orderguard_session=([^;]+)/.exec(login.headers.get('set-cookie') || '')?.[1];
    assert.equal(login.status, 200);
    assert.ok(cookie);

    const read = async () => {
      const response = await fetch(`http://127.0.0.1:${port}/api/state`, { headers: { Cookie: `orderguard_session=${cookie}` } });
      return { state: await response.json(), version: Number(response.headers.get('x-state-version')) };
    };
    const post = (state, version) => fetch(`http://127.0.0.1:${port}/api/state`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `orderguard_session=${cookie}`, 'If-Match': `"state-${version}"` },
      body: JSON.stringify(state),
    });
    const withIncident = (base, suffix) => {
      const next = structuredClone(base);
      const createdAt = new Date().toISOString();
      const incident = { id: `INC-CONCURRENT-${suffix}`, category: 'Masalah lain', manifestId: '', tracking: '', description: `Insiden paralel ${suffix}`, reportedBy: 'Platform Admin', createdAt, status: 'OPEN', resolution: '' };
      next.incidents.unshift(incident);
      next.audit.unshift({ id: `AU-CONCURRENT-${suffix}`, actor: 'Platform Admin', action: `Insiden dicatat: ${incident.category}`, object: incident.id, createdAt });
      return next;
    };

    const base = await read();
    const [first, second] = await Promise.all([
      post(withIncident(base.state, 'A'), base.version),
      post(withIncident(base.state, 'B'), base.version),
    ]);
    const statuses = [first.status, second.status].sort((a, b) => a - b);
    assert.deepEqual(statuses, [200, 409]);

    let current = await read();
    assert.equal(current.version, base.version + 1);
    const present = current.state.incidents.filter((incident) => incident.id.startsWith('INC-CONCURRENT-'));
    assert.equal(present.length, 1);

    const missingSuffix = present[0].id.endsWith('A') ? 'B' : 'A';
    const retry = await post(withIncident(current.state, missingSuffix), current.version);
    assert.equal(retry.status, 200, JSON.stringify(await retry.json().catch(() => ({}))));
    current = await read();
    assert.equal(current.state.incidents.filter((incident) => incident.id.startsWith('INC-CONCURRENT-')).length, 2);
    assert.equal(current.version, base.version + 2);
  } finally {
    await stopTestServer(server);
  }
});

test('parallel order events and scan/handover operations are serialized without lost updates', async () => {
  const port = 4324;
  const server = await createTestServer(port);

  try {
    await waitForServer(port);
    const login = await fetch(`http://127.0.0.1:${port}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'handover', password: 'handover123' }),
    });
    const cookie = /orderguard_session=([^;]+)/.exec(login.headers.get('set-cookie') || '')?.[1];
    assert.equal(login.status, 200);
    assert.ok(cookie);
    const adminLogin = await fetch(`http://127.0.0.1:${port}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin123' }),
    });
    const adminCookie = /orderguard_session=([^;]+)/.exec(adminLogin.headers.get('set-cookie') || '')?.[1];
    assert.equal(adminLogin.status, 200);
    assert.ok(adminCookie);

    const read = async () => {
      const response = await fetch(`http://127.0.0.1:${port}/api/state`, { headers: { Cookie: `orderguard_session=${cookie}` } });
      return { state: await response.json(), version: Number(response.headers.get('x-state-version')) };
    };
    const postState = (state, version) => fetch(`http://127.0.0.1:${port}/api/state`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `orderguard_session=${cookie}`, 'If-Match': `"state-${version}"` },
      body: JSON.stringify(state),
    });
    const postEvent = (tracking) => fetch(`http://127.0.0.1:${port}/api/order-events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `orderguard_session=${adminCookie}` },
      body: JSON.stringify({ tracking, type: 'CANCELLATION_AFTER_HANDOVER', reason: 'Uji paralel' }),
    });

    const base = await read();
    const eventResults = await Promise.all([postEvent('JNE0008114201'), postEvent('JNE0008114202')]);
    assert.deepEqual(eventResults.map((response) => response.status), [201, 201]);
    let afterEvents = await read();
    assert.equal(afterEvents.state.orderEvents.filter((event) => event.type === 'CANCELLATION_AFTER_HANDOVER').length >= 2, true);

    const buildScan = (baseState) => {
      const next = structuredClone(baseState);
      const manifest = next.manifests.find((item) => item.packages.some((parcel) => parcel.status === 'EXPECTED'));
      const parcel = manifest.packages.find((item) => item.status === 'EXPECTED');
      const createdAt = new Date().toISOString();
      parcel.status = 'SCANNED';
      parcel.scannedAt = createdAt;
      manifest.scans.push({ tracking: parcel.tracking, result: 'MATCH', createdAt, actor: 'Budi Handover' });
      next.audit.unshift({ id: `AU-CONCURRENT-SCAN-${parcel.tracking}`, actor: 'Budi Handover', action: `Paket dipindai: ${parcel.tracking}`, object: manifest.id, createdAt });
      return { next, manifestId: manifest.id, tracking: parcel.tracking };
    };
    const buildHandover = (baseState) => {
      const next = structuredClone(baseState);
      const manifest = next.manifests.find((item) => item.packages.some((parcel) => parcel.status === 'SCANNED'));
      const parcel = manifest.packages.find((item) => item.status === 'SCANNED');
      const createdAt = new Date().toISOString();
      const session = { id: 'TR-CONCURRENT-HANDOVER', receiver: 'Kurir Paralel', actor: 'Budi Handover', createdAt, note: '', items: [parcel.tracking], evidence: null };
      parcel.status = 'HANDED_OVER';
      parcel.handedOverAt = createdAt;
      parcel.handedOverSessionId = session.id;
      manifest.sessions.push(session);
      manifest.status = manifest.packages.some((item) => ['EXPECTED', 'SCANNED', 'REJECTED', 'EXCEPTION', 'CANCELLATION_AFTER_HANDOVER', 'RETURN_IN_TRANSIT'].includes(item.status))
        ? 'PARTIALLY_HANDED_OVER'
        : 'CONFIRMED';
      next.audit.unshift({ id: 'AU-CONCURRENT-HANDOVER', actor: 'Budi Handover', action: `Serah terima ${session.id} dikonfirmasi: 1 diterima`, object: manifest.id, createdAt });
      return { next, manifestId: manifest.id, sessionId: session.id, tracking: parcel.tracking };
    };

    const concurrentBase = await read();
    const scanPlan = buildScan(concurrentBase.state);
    const handoverPlan = buildHandover(concurrentBase.state);
    const [scanResponse, handoverResponse] = await Promise.all([
      postState(scanPlan.next, concurrentBase.version),
      postState(handoverPlan.next, concurrentBase.version),
    ]);
    assert.deepEqual([scanResponse.status, handoverResponse.status].sort((a, b) => a - b), [200, 409]);

    let current = await read();
    const currentManifest = current.state.manifests.find((manifest) => manifest.id === scanPlan.manifestId);
    const scanApplied = currentManifest.scans.some((scan) => scan.tracking === scanPlan.tracking && scan.actor === 'Budi Handover');
    const handoverApplied = currentManifest.sessions.some((session) => session.id === handoverPlan.sessionId);
    if (!scanApplied) {
      const retryScan = buildScan(current.state);
      const retry = await postState(retryScan.next, current.version);
      assert.equal(retry.status, 200, JSON.stringify(await retry.json().catch(() => ({}))));
      current = await read();
    }
    if (!handoverApplied) {
      const retryHandover = buildHandover(current.state);
      const retry = await postState(retryHandover.next, current.version);
      assert.equal(retry.status, 200, JSON.stringify(await retry.json().catch(() => ({}))));
      current = await read();
    }
    const finalManifest = current.state.manifests.find((manifest) => manifest.id === scanPlan.manifestId);
    assert.equal(finalManifest.scans.some((scan) => scan.tracking === scanPlan.tracking), true);
    assert.equal(finalManifest.sessions.some((session) => session.id === handoverPlan.sessionId), true);
    assert.ok(afterEvents.version <= current.version);
  } finally {
    await stopTestServer(server);
  }
});

test('failed transactions roll back and corrupted state is never overwritten', async () => {
  const port = 4325;
  const server = await createTestServer(port);

  try {
    await waitForServer(port);
    const login = await fetch(`http://127.0.0.1:${port}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin123' }),
    });
    const cookie = /orderguard_session=([^;]+)/.exec(login.headers.get('set-cookie') || '')?.[1];
    assert.equal(login.status, 200);
    assert.ok(cookie);

    const read = async () => {
      const response = await fetch(`http://127.0.0.1:${port}/api/state`, { headers: { Cookie: `orderguard_session=${cookie}` } });
      return { status: response.status, state: await response.json(), version: response.headers.get('x-state-version') };
    };
    const base = await read();
    assert.equal(base.status, 200);

    const rejectedEvent = await fetch(`http://127.0.0.1:${port}/api/order-events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `orderguard_session=${cookie}` },
      body: JSON.stringify({ tracking: 'RESI-TIDAK-ADA', type: 'CANCELLATION_AFTER_HANDOVER', reason: 'Uji rollback' }),
    });
    assert.equal(rejectedEvent.status, 404);
    let current = await read();
    assert.equal(current.version, base.version);

    const tampered = structuredClone(base.state);
    tampered.manifests[0].courier = 'DIUBAH';
    const rejectedState = await fetch(`http://127.0.0.1:${port}/api/state`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `orderguard_session=${cookie}`, 'If-Match': `"state-${base.version}"` },
      body: JSON.stringify(tampered),
    });
    assert.equal(rejectedState.status, 403);
    current = await read();
    assert.equal(current.version, base.version);

    const corruptPayload = '{ini-bukan-json';
    await testDatabase.query(`UPDATE "${server.schema}".tenant_state SET payload = $1 WHERE tenant_id = $2`, [corruptPayload, 'dfixer-store']);
    const corruptRead = await fetch(`http://127.0.0.1:${port}/api/state`, { headers: { Cookie: `orderguard_session=${cookie}` } });
    assert.equal(corruptRead.status, 503);
    assert.equal((await corruptRead.json()).code, 'STATE_CORRUPTED');
    const row = await testDatabase.query(`SELECT payload FROM "${server.schema}".tenant_state WHERE tenant_id = $1`, ['dfixer-store']);
    assert.equal(row.rows[0].payload, corruptPayload);
  } finally {
    await stopTestServer(server);
  }
});

test('legacy tenant_state tables gain a version column without losing data', async () => {
  const port = 4326;
  const legacyPayload = JSON.stringify({ manifests: [], incidents: [], audit: [], importJobs: [], orderEvents: [], marker: 'legacy-version-test' });
  const server = await createTestServer(port, async (schema) => {
    await testDatabase.query(`CREATE TABLE "${schema}".tenant_state (tenant_id TEXT PRIMARY KEY, payload TEXT NOT NULL, updated_at TEXT NOT NULL)`);
    await testDatabase.query(`INSERT INTO "${schema}".tenant_state (tenant_id, payload, updated_at) VALUES ($1, $2, $3)`, [
      'dfixer-store',
      legacyPayload,
      new Date().toISOString(),
    ]);
  });

  try {
    await waitForServer(port);
    const login = await fetch(`http://127.0.0.1:${port}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin123' }),
    });
    const cookie = /orderguard_session=([^;]+)/.exec(login.headers.get('set-cookie') || '')?.[1];
    assert.equal(login.status, 200);
    assert.ok(cookie);

    const initial = await fetch(`http://127.0.0.1:${port}/api/state`, { headers: { Cookie: `orderguard_session=${cookie}` } });
    assert.equal(initial.status, 200);
    assert.equal(initial.headers.get('x-state-version'), '0');
    const initialState = await initial.json();
    assert.equal(initialState.marker, 'legacy-version-test');

    const createdAt = new Date().toISOString();
    const incident = { id: 'INC-LEGACY-VERSION', category: 'Masalah lain', manifestId: '', tracking: '', description: 'Uji migrasi versi', reportedBy: 'Platform Admin', createdAt, status: 'OPEN', resolution: '' };
    const nextState = structuredClone(initialState);
    nextState.incidents.unshift(incident);
    nextState.audit.unshift({ id: 'AU-LEGACY-VERSION', actor: 'Platform Admin', action: `Insiden dicatat: ${incident.category}`, object: incident.id, createdAt });
    const saved = await fetch(`http://127.0.0.1:${port}/api/state`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `orderguard_session=${cookie}`, 'If-Match': '"state-0"' },
      body: JSON.stringify(nextState),
    });
    assert.equal(saved.status, 200, JSON.stringify(await saved.json().catch(() => ({}))));
    const after = await fetch(`http://127.0.0.1:${port}/api/state`, { headers: { Cookie: `orderguard_session=${cookie}` } });
    assert.equal(after.headers.get('x-state-version'), '1');
    assert.equal((await after.json()).incidents.some((item) => item.id === incident.id), true);
  } finally {
    await stopTestServer(server);
  }
});

function withTestIncident(state, suffix, actor = 'Platform Admin') {
  const next = structuredClone(state);
  const createdAt = new Date().toISOString();
  const incident = { id: `INC-AUTH-${suffix}`, category: 'Masalah lain', manifestId: '', tracking: '', description: `Uji auth ${suffix}`, reportedBy: actor, createdAt, status: 'OPEN', resolution: '' };
  next.incidents.unshift(incident);
  next.audit.unshift({ id: `AU-AUTH-${suffix}`, actor, action: `Insiden dicatat: ${incident.category}`, object: incident.id, createdAt });
  return next;
}

test('CSRF, Origin validation, cookie flags, and API error consistency', async () => {
  const port = 4327;
  const server = await createTestServer(port);
  const origin = `http://127.0.0.1:${port}`;

  try {
    await waitForServer(port);
    const login = await nativeFetch(`http://127.0.0.1:${port}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin123' }),
    });
    assert.equal(login.status, 200);
    const loginBody = await login.json();
    assert.ok(loginBody.csrfToken);
    const sessionCookie = /orderguard_session=([^;]+)/.exec(login.headers.get('set-cookie') || '')?.[1];
    assert.ok(sessionCookie);
    const cookies = login.headers.getSetCookie ? login.headers.getSetCookie() : [login.headers.get('set-cookie') || ''];
    const sessionSetCookie = cookies.find((value) => value.startsWith('orderguard_session='));
    const csrfSetCookie = cookies.find((value) => value.startsWith('orderguard_csrf='));
    assert.match(sessionSetCookie, /HttpOnly/i);
    assert.match(sessionSetCookie, /SameSite=Lax/i);
    assert.match(sessionSetCookie, /Path=\//i);
    assert.ok(csrfSetCookie);
    assert.doesNotMatch(csrfSetCookie, /HttpOnly/i);

    const evilLogin = await nativeFetch(`http://127.0.0.1:${port}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' },
      body: JSON.stringify({ username: 'admin', password: 'admin123' }),
    });
    assert.equal(evilLogin.status, 403);

    const secondLogin = await nativeFetch(`http://127.0.0.1:${port}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin123' }),
    });
    assert.equal(secondLogin.status, 200);
    const secondBody = await secondLogin.json();
    const secondCookie = /orderguard_session=([^;]+)/.exec(secondLogin.headers.get('set-cookie') || '')?.[1];
    assert.ok(secondCookie);
    assert.notEqual(secondCookie, sessionCookie);
    assert.notEqual(secondBody.csrfToken, loginBody.csrfToken);

    const stateResponse = await fetch(`http://127.0.0.1:${port}/api/state`, { headers: { Cookie: `orderguard_session=${sessionCookie}` } });
    const state = await stateResponse.json();
    const version = Number(stateResponse.headers.get('x-state-version'));

    const noToken = await nativeFetch(`http://127.0.0.1:${port}/api/state`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `orderguard_session=${sessionCookie}`, Origin: origin },
      body: JSON.stringify(withTestIncident(state, 'NO-TOKEN')),
    });
    assert.equal(noToken.status, 403);
    assert.equal((await noToken.json()).code, 'CSRF_INVALID');

    const noTokenNoOrigin = await nativeFetch(`http://127.0.0.1:${port}/api/state`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `orderguard_session=${sessionCookie}` },
      body: JSON.stringify(withTestIncident(state, 'NO-TOKEN-NO-ORIGIN')),
    });
    assert.equal(noTokenNoOrigin.status, 403);

    const untrusted = await nativeFetch(`http://127.0.0.1:${port}/api/state`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `orderguard_session=${sessionCookie}`, Origin: 'https://evil.example', 'X-CSRF-Token': loginBody.csrfToken },
      body: JSON.stringify(withTestIncident(state, 'UNTRUSTED')),
    });
    assert.equal(untrusted.status, 403);
    assert.equal((await untrusted.json()).code, 'ORIGIN_REJECTED');

    const refererUntrusted = await nativeFetch(`http://127.0.0.1:${port}/api/state`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `orderguard_session=${sessionCookie}`, Referer: 'https://evil.example/page', 'X-CSRF-Token': loginBody.csrfToken },
      body: JSON.stringify(withTestIncident(state, 'UNTRUSTED-REFERER')),
    });
    assert.equal(refererUntrusted.status, 403);
    assert.equal((await refererUntrusted.json()).code, 'ORIGIN_REJECTED');

    const crossSessionToken = await nativeFetch(`http://127.0.0.1:${port}/api/state`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `orderguard_session=${sessionCookie}`, Origin: origin, 'X-CSRF-Token': secondBody.csrfToken },
      body: JSON.stringify(withTestIncident(state, 'CROSS-SESSION-TOKEN')),
    });
    assert.equal(crossSessionToken.status, 403);
    assert.equal((await crossSessionToken.json()).code, 'CSRF_INVALID');

    const valid = await nativeFetch(`http://127.0.0.1:${port}/api/state`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `orderguard_session=${sessionCookie}`, Origin: origin, 'X-CSRF-Token': loginBody.csrfToken },
      body: JSON.stringify(withTestIncident(state, 'VALID')),
    });
    assert.equal(valid.status, 200, JSON.stringify(await valid.clone().json().catch(() => ({}))));

    const wrongToken = await nativeFetch(`http://127.0.0.1:${port}/api/state`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `orderguard_session=${sessionCookie}`, Origin: origin, 'X-CSRF-Token': 'wrong-token' },
      body: JSON.stringify(withTestIncident(state, 'WRONG-TOKEN')),
    });
    assert.equal(wrongToken.status, 403);
    assert.equal((await wrongToken.json()).code, 'CSRF_INVALID');

    const logoutNoToken = await nativeFetch(`http://127.0.0.1:${port}/api/logout`, {
      method: 'POST',
      headers: { Cookie: `orderguard_session=${sessionCookie}`, Origin: origin },
    });
    assert.equal(logoutNoToken.status, 403);
    const logout = await nativeFetch(`http://127.0.0.1:${port}/api/logout`, {
      method: 'POST',
      headers: { Cookie: `orderguard_session=${sessionCookie}`, Origin: origin, 'X-CSRF-Token': loginBody.csrfToken },
    });
    assert.equal(logout.status, 200);

    const malformedCookie = await nativeFetch(`http://127.0.0.1:${port}/api/session`, { headers: { Cookie: 'orderguard_session=%E0%A4%A' } });
    assert.equal(malformedCookie.status, 200);
    assert.deepEqual(await malformedCookie.json(), { user: null, csrfToken: null });

    const missingApi = await nativeFetch(`http://127.0.0.1:${port}/api/does-not-exist`);
    assert.equal(missingApi.status, 404);
    assert.match(missingApi.headers.get('content-type') || '', /application\/json/);

    const session = await nativeFetch(`http://127.0.0.1:${port}/api/session`, { headers: { Cookie: `orderguard_session=${sessionCookie}` } });
    assert.equal(session.status, 200);
    assert.deepEqual(await session.json(), { user: null, csrfToken: null });
  } finally {
    await stopTestServer(server);
  }
});

test('login rate limiting and authentication audit log', async () => {
  const port = 4328;
  const server = await createTestServer(port);
  const origin = `http://127.0.0.1:${port}`;

  try {
    await waitForServer(port);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await nativeFetch(`http://127.0.0.1:${port}/api/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'rani', password: `wrong-${attempt}` }),
      });
      assert.equal(response.status, 401);
    }
    const blocked = await nativeFetch(`http://127.0.0.1:${port}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'rani', password: 'rani123' }),
    });
    assert.equal(blocked.status, 429);
    assert.equal(blocked.headers.get('retry-after'), '60');
    const blockedBody = await blocked.json();
    assert.equal(blockedBody.code, 'LOGIN_RATE_LIMITED');

    const adminLogin = await nativeFetch(`http://127.0.0.1:${port}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin123' }),
    });
    assert.equal(adminLogin.status, 200);
    const adminBody = await adminLogin.json();
    const adminCookie = /orderguard_session=([^;]+)/.exec(adminLogin.headers.get('set-cookie') || '')?.[1];
    assert.ok(adminCookie);

    const adminLogout = await nativeFetch(`http://127.0.0.1:${port}/api/logout`, {
      method: 'POST',
      headers: { Cookie: `orderguard_session=${adminCookie}`, Origin: origin, 'X-CSRF-Token': adminBody.csrfToken },
    });
    assert.equal(adminLogout.status, 200);

    const handoverLogin = await nativeFetch(`http://127.0.0.1:${port}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'handover', password: 'handover123' }),
    });
    assert.equal(handoverLogin.status, 200);
    const handoverBody = await handoverLogin.json();
    const handoverCookie = /orderguard_session=([^;]+)/.exec(handoverLogin.headers.get('set-cookie') || '')?.[1];
    assert.ok(handoverCookie);
    await testDatabase.query(`UPDATE "${server.schema}".sessions SET expires_at = $1 WHERE user_id = $2`, [new Date(Date.now() - 1000).toISOString(), 'handover']);
    const expiredSession = await nativeFetch(`http://127.0.0.1:${port}/api/session`, { headers: { Cookie: `orderguard_session=${handoverCookie}` } });
    assert.equal(expiredSession.status, 200);
    assert.deepEqual(await expiredSession.json(), { user: null, csrfToken: null });

    const invalidSession = await nativeFetch(`http://127.0.0.1:${port}/api/session`, { headers: { Cookie: 'orderguard_session=invalid-session-token' } });
    assert.equal(invalidSession.status, 200);
    assert.deepEqual(await invalidSession.json(), { user: null, csrfToken: null });

    const adminLoginAgain = await nativeFetch(`http://127.0.0.1:${port}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin123' }),
    });
    assert.equal(adminLoginAgain.status, 200);
    const adminAgainBody = await adminLoginAgain.json();
    const adminAgainCookie = /orderguard_session=([^;]+)/.exec(adminLoginAgain.headers.get('set-cookie') || '')?.[1];
    assert.ok(adminAgainCookie);
    const change = await nativeFetch(`http://127.0.0.1:${port}/api/users/handover`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: `orderguard_session=${adminAgainCookie}`, Origin: origin, 'X-CSRF-Token': adminAgainBody.csrfToken },
      body: JSON.stringify({ password: 'newpassword123' }),
    });
    assert.equal(change.status, 200, JSON.stringify(await change.clone().json().catch(() => ({}))));

    const weak = await nativeFetch(`http://127.0.0.1:${port}/api/users`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `orderguard_session=${adminAgainCookie}`, Origin: origin, 'X-CSRF-Token': adminAgainBody.csrfToken },
      body: JSON.stringify({ username: 'weakpass', password: '12345678', name: 'Weak Pass', role: 'handover-staff', tenantId: 'dfixer-store' }),
    });
    assert.equal(weak.status, 400);

    const audit = await testDatabase.query(`SELECT action, username, user_id, tenant_id, metadata FROM "${server.schema}".auth_audit ORDER BY created_at`);
    const actions = audit.rows.map((row) => row.action);
    for (const action of ['LOGIN_FAILED', 'LOGIN_BLOCKED', 'LOGIN_SUCCESS', 'LOGOUT', 'SESSION_EXPIRED', 'SESSION_INVALID', 'CREDENTIAL_CHANGED', 'SESSIONS_REVOKED']) {
      assert.equal(actions.includes(action), true, `missing auth audit action ${action}`);
    }
    const serialized = JSON.stringify(audit.rows);
    for (const secret of ['admin123', 'rani123', 'handover123', 'newpassword123', adminBody.csrfToken, handoverBody.csrfToken, adminCookie, handoverCookie]) {
      assert.equal(serialized.includes(secret), false, 'auth audit contains secret material');
    }

    const attempts = await testDatabase.query(`SELECT COUNT(*)::INTEGER AS count FROM "${server.schema}".login_attempts`);
    assert.ok(attempts.rows[0].count >= 5);
  } finally {
    await stopTestServer(server);
  }
});

test('existing sessions tables gain CSRF storage during startup migration', async () => {
  const port = 4329;
  const server = await createTestServer(port, async (schema) => {
    await testDatabase.query(`CREATE TABLE "${schema}".sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires_at TEXT NOT NULL, created_at TEXT NOT NULL)`);
  });

  try {
    await waitForServer(port);
    const login = await nativeFetch(`http://127.0.0.1:${port}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin123' }),
    });
    assert.equal(login.status, 200);
    const body = await login.json();
    assert.ok(body.csrfToken);
    const cookie = /orderguard_session=([^;]+)/.exec(login.headers.get('set-cookie') || '')?.[1];
    const session = await nativeFetch(`http://127.0.0.1:${port}/api/session`, { headers: { Cookie: `orderguard_session=${cookie}` } });
    const sessionBody = await session.json();
    assert.equal(sessionBody.csrfToken, body.csrfToken);
    const columns = await testDatabase.query(`SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'sessions' AND column_name = 'csrf_token'`, [server.schema]);
    assert.equal(columns.rowCount, 1);
  } finally {
    await stopTestServer(server);
  }
});

test('configured production origins are accepted while wildcard-style/untrusted origins are rejected', async () => {
  const port = 4331;
  const schema = 'orderguard_test_4331_origins';
  await testDatabase.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  await testDatabase.query(`CREATE SCHEMA "${schema}"`);
  const child = startTestServer(port, schema, { ORDERGUARD_ALLOWED_ORIGINS: 'https://app.example.com' });
  const server = { child, schema, port };

  try {
    await waitForServer(port);
    const login = await nativeFetch(`http://127.0.0.1:${port}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin123' }),
    });
    assert.equal(login.status, 200);
    const body = await login.json();
    const cookie = /orderguard_session=([^;]+)/.exec(login.headers.get('set-cookie') || '')?.[1];
    const stateResponse = await nativeFetch(`http://127.0.0.1:${port}/api/state`, { headers: { Cookie: `orderguard_session=${cookie}` } });
    const state = await stateResponse.json();
    const version = Number(stateResponse.headers.get('x-state-version'));
    const allowed = await nativeFetch(`http://127.0.0.1:${port}/api/state`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `orderguard_session=${cookie}`, Origin: 'https://app.example.com', 'X-CSRF-Token': body.csrfToken },
      body: JSON.stringify(withTestIncident(state, 'ALLOWED-ORIGIN')),
    });
    assert.equal(allowed.status, 200);
    const untrusted = await nativeFetch(`http://127.0.0.1:${port}/api/state`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `orderguard_session=${cookie}`, Origin: 'https://other.example', 'X-CSRF-Token': body.csrfToken },
      body: JSON.stringify(withTestIncident(state, 'OTHER-ORIGIN')),
    });
    assert.equal(untrusted.status, 403);
    assert.equal((await untrusted.json()).code, 'ORIGIN_REJECTED');
    assert.equal(version, 0);
  } finally {
    await stopTestServer(server);
  }
});

test('concurrent failed logins cannot bypass the rate limit', async () => {
  const port = 4332;
  const server = await createTestServer(port);

  try {
    await waitForServer(port);
    const attempts = await Promise.all(Array.from({ length: 10 }, (_, index) => nativeFetch(`http://127.0.0.1:${port}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'rani', password: `parallel-wrong-${index}` }),
    })));
    for (const attempt of attempts) assert.ok([401, 429].includes(attempt.status), `unexpected status ${attempt.status}`);
    const afterBatch = await nativeFetch(`http://127.0.0.1:${port}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'rani', password: 'rani123' }),
    });
    assert.equal(afterBatch.status, 429);
  } finally {
    await stopTestServer(server);
  }
});

async function loginCookie(port, username, password) {
  const response = await fetch(`http://127.0.0.1:${port}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  assert.equal(response.status, 200);
  return /orderguard_session=([^;]+)/.exec(response.headers.get('set-cookie') || '')?.[1];
}

async function readStateForTest(port, cookie) {
  const response = await fetch(`http://127.0.0.1:${port}/api/state`, { headers: { Cookie: `orderguard_session=${cookie}` } });
  return { response, state: await response.json(), version: Number(response.headers.get('x-state-version')) };
}

function wave2ManifestState(base, manifestId, tracking, suffix) {
  const next = structuredClone(base);
  const createdAt = new Date().toISOString();
  next.manifests.unshift({
    id: manifestId,
    shop: "D'Fixer Store",
    courier: 'JNE',
    date: createdAt.slice(0, 10),
    location: 'Gudang',
    status: 'OPEN',
    createdAt,
    createdBy: 'Platform Admin',
    source: 'manual',
    packages: [{ order: `ORD-${suffix}`, tracking, status: 'EXPECTED', scannedAt: null }],
    scans: [],
    sessions: [],
  });
  next.audit.unshift({ id: `AU-${suffix}`, actor: 'Platform Admin', action: 'Manifest dibuat manual dengan 1 paket', object: manifestId, createdAt });
  return next;
}

function wave2ScanState(base, manifestId, tracking, includeAudit = true, result = 'MATCH') {
  const next = structuredClone(base);
  const manifest = next.manifests.find((item) => item.id === manifestId);
  const parcel = manifest.packages.find((item) => item.tracking === tracking);
  const createdAt = new Date().toISOString();
  if (result === 'MATCH') {
    parcel.status = 'SCANNED';
    parcel.scannedAt = createdAt;
  }
  manifest.scans.push({ tracking, result, createdAt, actor: 'Budi Handover' });
  if (includeAudit) {
    const action = {
      MATCH: `Paket dipindai: ${tracking}`,
      DUPLICATE_SCAN: `Pemindaian duplikat: ${tracking}`,
      NOT_IN_MANIFEST: `Pemindaian di luar manifest: ${tracking}`,
      ALREADY_HANDED_OVER: `Paket sudah diserahkan: ${tracking}`,
      INVALID_PACKAGE: `Paket tidak valid: ${tracking}`,
    }[result] || `Pemindaian: ${tracking}`;
    next.audit.unshift({ id: `AU-SCAN-${result}-${tracking}`, actor: 'Budi Handover', action, object: manifest.id, createdAt });
  }
  return next;
}

function wave2HandoverState(base, manifestId, includeAudit = true, evidence = null) {
  const next = structuredClone(base);
  const manifest = next.manifests.find((item) => item.id === manifestId);
  const scanned = manifest.packages.filter((parcel) => parcel.status === 'SCANNED');
  const createdAt = new Date().toISOString();
  const session = {
    id: `TR-W2-${Date.now().toString(36).toUpperCase()}`,
    receiver: 'Kurir Wave2',
    actor: 'Budi Handover',
    createdAt,
    note: '',
    items: scanned.map((parcel) => parcel.tracking),
    evidence,
  };
  for (const parcel of scanned) {
    parcel.status = 'HANDED_OVER';
    parcel.handedOverAt = createdAt;
    parcel.handedOverSessionId = session.id;
  }
  manifest.sessions.push(session);
  manifest.status = manifest.packages.some((parcel) => ['EXPECTED', 'SCANNED', 'REJECTED', 'EXCEPTION', 'CANCELLATION_AFTER_HANDOVER', 'RETURN_IN_TRANSIT'].includes(parcel.status))
    ? 'PARTIALLY_HANDED_OVER'
    : 'CONFIRMED';
  if (includeAudit) {
    next.audit.unshift({ id: `AU-HANDOVER-${session.id}`, actor: 'Budi Handover', action: `Serah terima ${session.id} dikonfirmasi: ${scanned.length} diterima`, object: manifest.id, createdAt });
  }
  return { next, sessionId: session.id, manifestId: manifest.id };
}

test('manifest IDs are unique in validation, database registry, and concurrent creation', async () => {
  const port = 4335;
  const server = await createTestServer(port);

  try {
    await waitForServer(port);
    const cookie = await loginCookie(port, 'admin', 'admin123');
    let base = await readStateForTest(port, cookie);
    const uniqueId = 'OG-WAVE2-UNIQUE-001';
    const created = wave2ManifestState(base.state, uniqueId, 'JNE-WAVE2-001', 'W2-UNIQUE');
    const createResponse = await fetch(`http://127.0.0.1:${port}/api/state`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `orderguard_session=${cookie}`, 'If-Match': `"state-${base.version}"` },
      body: JSON.stringify(created),
    });
    assert.equal(createResponse.status, 200);
    base = await readStateForTest(port, cookie);
    assert.equal(base.state.manifests.filter((manifest) => manifest.id === uniqueId).length, 1);

    const duplicate = wave2ManifestState(base.state, uniqueId, 'JNE-WAVE2-DUPLICATE', 'W2-DUPLICATE');
    const duplicateResponse = await fetch(`http://127.0.0.1:${port}/api/state`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `orderguard_session=${cookie}`, 'If-Match': `"state-${base.version}"` },
      body: JSON.stringify(duplicate),
    });
    assert.equal(duplicateResponse.status, 403);

    const concurrentId = 'OG-WAVE2-CONCURRENT-001';
    const firstState = wave2ManifestState(base.state, concurrentId, 'JNE-WAVE2-CONCURRENT-A', 'W2-CONCURRENT-A');
    const secondState = wave2ManifestState(base.state, concurrentId, 'JNE-WAVE2-CONCURRENT-B', 'W2-CONCURRENT-B');
    const [firstResponse, secondResponse] = await Promise.all([
      fetch(`http://127.0.0.1:${port}/api/state`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: `orderguard_session=${cookie}`, 'If-Match': `"state-${base.version}"` },
        body: JSON.stringify(firstState),
      }),
      fetch(`http://127.0.0.1:${port}/api/state`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: `orderguard_session=${cookie}`, 'If-Match': `"state-${base.version}"` },
        body: JSON.stringify(secondState),
      }),
    ]);
    assert.deepEqual([firstResponse.status, secondResponse.status].sort((a, b) => a - b), [200, 409]);
    const afterConcurrent = await readStateForTest(port, cookie);
    assert.equal(afterConcurrent.state.manifests.filter((manifest) => manifest.id === concurrentId).length, 1);
    const registry = await testDatabase.query(
      `SELECT manifest_id FROM "${server.schema}".tenant_manifest_ids WHERE tenant_id = $1 AND manifest_id = ANY($2::text[])`,
      ['dfixer-store', [uniqueId, concurrentId]],
    );
    assert.equal(registry.rows.length, 2);
  } finally {
    await stopTestServer(server);
  }
});

test('corrupted JSON is quarantined without replacing the original state', async () => {
  const port = 4336;
  const server = await createTestServer(port);

  try {
    await waitForServer(port);
    const cookie = await loginCookie(port, 'admin', 'admin123');
    const corruptPayload = '{ini-bukan-json';
    await testDatabase.query(`UPDATE "${server.schema}".tenant_state SET payload = $1 WHERE tenant_id = $2`, [corruptPayload, 'dfixer-store']);
    const response = await fetch(`http://127.0.0.1:${port}/api/state`, { headers: { Cookie: `orderguard_session=${cookie}` } });
    assert.equal(response.status, 503);
    assert.equal((await response.json()).code, 'STATE_CORRUPTED');
    const row = await testDatabase.query(`SELECT payload FROM "${server.schema}".tenant_state WHERE tenant_id = $1`, ['dfixer-store']);
    assert.equal(row.rows[0].payload, corruptPayload);
    const quarantine = await testDatabase.query(`SELECT payload, tenant_id FROM "${server.schema}".state_quarantine WHERE tenant_id = $1`, ['dfixer-store']);
    assert.equal(quarantine.rowCount, 1);
    assert.equal(quarantine.rows[0].payload, corruptPayload);
  } finally {
    await stopTestServer(server);
  }
});

test('final manifests reject scan and handover changes', async () => {
  const port = 4337;
  const server = await createTestServer(port);

  try {
    await waitForServer(port);
    const cookie = await loginCookie(port, 'handover', 'handover123');
    const base = await readStateForTest(port, cookie);
    const target = base.state.manifests.find((manifest) => manifest.packages.some((parcel) => parcel.status === 'EXPECTED') && manifest.packages.some((parcel) => parcel.status === 'SCANNED'));
    const corrupted = structuredClone(base.state);
    corrupted.manifests.find((manifest) => manifest.id === target.id).status = 'CLOSED';
    await testDatabase.query(`UPDATE "${server.schema}".tenant_state SET payload = $1 WHERE tenant_id = $2`, [JSON.stringify(corrupted), 'dfixer-store']);
    const loaded = await readStateForTest(port, cookie);
    const expected = loaded.state.manifests.find((manifest) => manifest.id === target.id).packages.find((parcel) => parcel.status === 'EXPECTED');
    const scan = wave2ScanState(loaded.state, target.id, expected.tracking, true);
    const scanResponse = await fetch(`http://127.0.0.1:${port}/api/state`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `orderguard_session=${cookie}`, 'If-Match': `"state-${loaded.version}"` },
      body: JSON.stringify(scan),
    });
    assert.equal(scanResponse.status, 403);

    const handover = wave2HandoverState(loaded.state, target.id, true);
    const handoverResponse = await fetch(`http://127.0.0.1:${port}/api/state`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `orderguard_session=${cookie}`, 'If-Match': `"state-${loaded.version}"` },
      body: JSON.stringify(handover.next),
    });
    assert.equal(handoverResponse.status, 403);
  } finally {
    await stopTestServer(server);
  }
});

test('every scan and handover requires audit and existing evidence cannot be changed', async () => {
  const port = 4338;
  const server = await createTestServer(port);

  try {
    await waitForServer(port);
    const cookie = await loginCookie(port, 'handover', 'handover123');
    let base = await readStateForTest(port, cookie);
    const target = base.state.manifests.find((manifest) => manifest.packages.some((parcel) => parcel.status === 'EXPECTED') && manifest.packages.some((parcel) => parcel.status === 'SCANNED'));
    const expected = target.packages.find((parcel) => parcel.status === 'EXPECTED');
    const scanWithoutAudit = wave2ScanState(base.state, target.id, expected.tracking, false);
    const rejectedScan = await fetch(`http://127.0.0.1:${port}/api/state`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `orderguard_session=${cookie}`, 'If-Match': `"state-${base.version}"` },
      body: JSON.stringify(scanWithoutAudit),
    });
    assert.equal(rejectedScan.status, 403);

    const scanWithAudit = wave2ScanState(base.state, target.id, expected.tracking, true);
    const acceptedScan = await fetch(`http://127.0.0.1:${port}/api/state`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `orderguard_session=${cookie}`, 'If-Match': `"state-${base.version}"` },
      body: JSON.stringify(scanWithAudit),
    });
    assert.equal(acceptedScan.status, 200);

    base = await readStateForTest(port, cookie);
    const currentManifest = base.state.manifests.find((manifest) => manifest.id === target.id);
    const scanned = currentManifest.packages.find((parcel) => parcel.status === 'SCANNED');
    const duplicateWithoutAudit = wave2ScanState(base.state, target.id, scanned.tracking, false, 'DUPLICATE_SCAN');
    const rejectedDuplicate = await fetch(`http://127.0.0.1:${port}/api/state`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `orderguard_session=${cookie}`, 'If-Match': `"state-${base.version}"` },
      body: JSON.stringify(duplicateWithoutAudit),
    });
    assert.equal(rejectedDuplicate.status, 403);
    const duplicateWithAudit = wave2ScanState(base.state, target.id, scanned.tracking, true, 'DUPLICATE_SCAN');
    const acceptedDuplicate = await fetch(`http://127.0.0.1:${port}/api/state`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `orderguard_session=${cookie}`, 'If-Match': `"state-${base.version}"` },
      body: JSON.stringify(duplicateWithAudit),
    });
    assert.equal(acceptedDuplicate.status, 200);

    base = await readStateForTest(port, cookie);
    const handoverWithoutAudit = wave2HandoverState(base.state, target.id, false);
    const rejectedHandover = await fetch(`http://127.0.0.1:${port}/api/state`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `orderguard_session=${cookie}`, 'If-Match': `"state-${base.version}"` },
      body: JSON.stringify(handoverWithoutAudit.next),
    });
    assert.equal(rejectedHandover.status, 403);

    const handoverWithAudit = wave2HandoverState(base.state, target.id, true, 'data:image/png;base64,iVBORw0KGgo=');
    const acceptedHandover = await fetch(`http://127.0.0.1:${port}/api/state`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `orderguard_session=${cookie}`, 'If-Match': `"state-${base.version}"` },
      body: JSON.stringify(handoverWithAudit.next),
    });
    assert.equal(acceptedHandover.status, 200);

    const afterHandover = await readStateForTest(port, cookie);
    const tampered = structuredClone(afterHandover.state);
    const session = tampered.manifests.find((manifest) => manifest.id === target.id).sessions.find((item) => item.id === handoverWithAudit.sessionId);
    session.evidence = 'data:image/png;base64,AAAA" onerror="alert(1)';
    const tamperedResponse = await fetch(`http://127.0.0.1:${port}/api/state`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `orderguard_session=${cookie}`, 'If-Match': `"state-${afterHandover.version}"` },
      body: JSON.stringify(tampered),
    });
    assert.equal(tamperedResponse.status, 403);
  } finally {
    await stopTestServer(server);
  }
});

test('database has tenant foreign keys, operational indexes, and rejects orphan users', async () => {
  const port = 4339;
  const server = await createTestServer(port);

  try {
    await waitForServer(port);
    const constraints = await testDatabase.query(
      `SELECT conname FROM pg_constraint WHERE connamespace = $1::regnamespace AND contype = 'f' ORDER BY conname`,
      [server.schema],
    );
    const names = new Set(constraints.rows.map((row) => row.conname));
    for (const name of ['users_tenant_fk', 'sessions_user_fk', 'tenant_state_tenant_fk', 'tenant_manifest_ids_tenant_fk', 'state_quarantine_tenant_fk']) {
      assert.equal(names.has(name), true, `missing foreign key ${name}`);
    }
    const indexes = await testDatabase.query(
      `SELECT indexname FROM pg_indexes WHERE schemaname = $1`,
      [server.schema],
    );
    const indexNames = new Set(indexes.rows.map((row) => row.indexname));
    for (const name of ['users_tenant_id_idx', 'tenant_audit_created_idx', 'employee_audit_created_idx', 'tenant_manifest_ids_pkey']) {
      assert.equal(indexNames.has(name), true, `missing index ${name}`);
    }
    await assert.rejects(
      testDatabase.query(
        `INSERT INTO "${server.schema}".users (id, username, name, password_salt, password_hash, role, tenant_id, active, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, TRUE, $8, $9)`,
        ['orphan-user', 'orphan-user', 'Orphan', 'salt', 'hash', 'handover-staff', 'missing-tenant', new Date().toISOString(), new Date().toISOString()],
      ),
      (error) => error.code === '23503',
    );
    const now = new Date().toISOString();
    await testDatabase.query(`INSERT INTO "${server.schema}".tenants (id, name, created_at, updated_at) VALUES ($1, $2, $3, $4)`, ['tenant-extra', 'Tenant Extra', now, now]);
    await assert.rejects(
      testDatabase.query(
        `INSERT INTO "${server.schema}".tiktok_oauth_states (state_hash, tenant_id, user_id, expires_at, created_at) VALUES ($1, $2, $3, $4, $5)`,
        ['cross-tenant-state', 'tenant-extra', 'admin', now, now],
      ),
      (error) => error.code === '23503',
    );
    await testDatabase.query(
      `INSERT INTO "${server.schema}".tiktok_connections (id, tenant_id, open_id, access_token, refresh_token, access_token_expires_at, refresh_token_expires_at, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      ['cross-conn', 'dfixer-store', 'cross-open', 'access', 'refresh', 1, 1, now, now],
    );
    await assert.rejects(
      testDatabase.query(
        `INSERT INTO "${server.schema}".tiktok_shops (id, tenant_id, connection_id, shop_id, shop_cipher, name, region, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        ['cross-shop', 'tenant-extra', 'cross-conn', 'cross-shop-id', 'cipher', 'Cross Shop', '', now],
      ),
      (error) => error.code === '23503',
    );
    await testDatabase.query(
      `INSERT INTO "${server.schema}".sessions (token_hash, user_id, csrf_token, expires_at, created_at) VALUES ($1, $2, $3, $4, $5)`,
      ['session-for-tenant-change', 'admin', 'csrf', new Date(Date.now() + 60000).toISOString(), now],
    );
    await testDatabase.query(`UPDATE "${server.schema}".users SET tenant_id = $1 WHERE id = $2`, ['tenant-extra', 'admin']);
    const sessionsAfterTenantChange = await testDatabase.query(`SELECT COUNT(*)::INTEGER AS count FROM "${server.schema}".sessions WHERE user_id = $1`, ['admin']);
    assert.equal(sessionsAfterTenantChange.rows[0].count, 0);
  } finally {
    await stopTestServer(server);
  }
});

test('official manifest close workflow remains allowed after final-state guards', async () => {
  const port = 4340;
  const server = await createTestServer(port);

  try {
    await waitForServer(port);
    const cookie = await loginCookie(port, 'admin', 'admin123');
    const base = await readStateForTest(port, cookie);
    const target = base.state.manifests.find((manifest) => !base.state.incidents.some((incident) => incident.manifestId === manifest.id && incident.status === 'OPEN'));
    assert.ok(target);
    const prepared = structuredClone(base.state);
    const preparedManifest = prepared.manifests.find((manifest) => manifest.id === target.id);
    preparedManifest.packages.forEach((parcel) => { parcel.status = 'HANDED_OVER'; });
    preparedManifest.status = 'PARTIALLY_HANDED_OVER';
    await testDatabase.query(`UPDATE "${server.schema}".tenant_state SET payload = $1 WHERE tenant_id = $2`, [JSON.stringify(prepared), 'dfixer-store']);
    const current = await readStateForTest(port, cookie);
    const closed = structuredClone(current.state);
    closed.manifests.find((manifest) => manifest.id === target.id).status = 'CLOSED';
    const createdAt = new Date().toISOString();
    closed.audit.unshift({ id: 'AU-W2-CLOSE', actor: 'Platform Admin', action: 'Manifest ditutup', object: target.id, createdAt });
    const response = await fetch(`http://127.0.0.1:${port}/api/state`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `orderguard_session=${cookie}`, 'If-Match': `"state-${current.version}"` },
      body: JSON.stringify(closed),
    });
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json().catch(() => ({}))));
    const after = await readStateForTest(port, cookie);
    assert.equal(after.state.manifests.find((manifest) => manifest.id === target.id).status, 'CLOSED');
  } finally {
    await stopTestServer(server);
  }
});

test('quarantine recovery is tenant-scoped, explicit, audited, and rollback-safe', async () => {
  const port = 4341;
  const server = await createTestServer(port);

  const quarantineHash = (payload) => crypto.createHash('sha256').update(payload).digest('hex');
  try {
    await waitForServer(port);
    const admin = await loginCookie(port, 'admin', 'admin123');
    const adminBase = await readStateForTest(port, admin);
    const recoveredState = withTestIncident(adminBase.state, 'QUARANTINE-RECOVERY');
    const payload = JSON.stringify(recoveredState);
    await testDatabase.query(
      `INSERT INTO "${server.schema}".state_quarantine (id, tenant_id, payload, payload_hash, reason, created_at) VALUES ($1, $2, $3, $4, $5, $6)`,
      ['Q-W2-VALID', 'dfixer-store', payload, quarantineHash(payload), 'test quarantine', new Date().toISOString()],
    );
    const mayaState = await readStateForTest(port, await loginCookie(port, 'maya', 'maya123'));
    const mayaPayload = JSON.stringify(withTestIncident(mayaState.state, 'QUARANTINE-MAYA', 'Maya Admin'));
    await testDatabase.query(
      `INSERT INTO "${server.schema}".state_quarantine (id, tenant_id, payload, payload_hash, reason, created_at) VALUES ($1, $2, $3, $4, $5, $6)`,
      ['Q-W2-MAYA', 'maya-commerce', mayaPayload, quarantineHash(mayaPayload), 'test maya quarantine', new Date().toISOString()],
    );

    const adminList = await fetch(`http://127.0.0.1:${port}/api/admin/quarantine`, { headers: { Cookie: `orderguard_session=${admin}` } });
    assert.equal(adminList.status, 200);
    const adminListBody = await adminList.json();
    assert.equal(adminListBody.quarantine.some((row) => row.id === 'Q-W2-MAYA'), true);

    const rani = await loginCookie(port, 'rani', 'rani123');
    const raniList = await fetch(`http://127.0.0.1:${port}/api/admin/quarantine`, { headers: { Cookie: `orderguard_session=${rani}` } });
    assert.equal(raniList.status, 200);
    const raniListBody = await raniList.json();
    assert.equal(raniListBody.quarantine.some((row) => row.id === 'Q-W2-MAYA'), false);
    const crossTenantPreview = await fetch(`http://127.0.0.1:${port}/api/admin/quarantine/Q-W2-MAYA`, { headers: { Cookie: `orderguard_session=${rani}` } });
    assert.equal(crossTenantPreview.status, 404);

    const preview = await fetch(`http://127.0.0.1:${port}/api/admin/quarantine/Q-W2-VALID`, { headers: { Cookie: `orderguard_session=${admin}` } });
    assert.equal(preview.status, 200);
    const previewBody = await preview.json();
    assert.equal(previewBody.quarantine.valid, true);
    assert.equal(previewBody.quarantine.preview.manifestCount, adminBase.state.manifests.length);

    const noConfirm = await fetch(`http://127.0.0.1:${port}/api/admin/quarantine/Q-W2-VALID/recover`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `orderguard_session=${admin}` },
      body: JSON.stringify({}),
    });
    assert.equal(noConfirm.status, 400);
    assert.equal((await noConfirm.json()).code, 'RECOVERY_CONFIRMATION_REQUIRED');

    const recover = await fetch(`http://127.0.0.1:${port}/api/admin/quarantine/Q-W2-VALID/recover`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `orderguard_session=${admin}` },
      body: JSON.stringify({ confirm: true, expectedPayloadHash: quarantineHash(payload) }),
    });
    assert.equal(recover.status, 200, JSON.stringify(await recover.clone().json().catch(() => ({}))));
    const after = await readStateForTest(port, admin);
    assert.equal(after.state.incidents.some((incident) => incident.id === 'INC-AUTH-QUARANTINE-RECOVERY'), true);
    const quarantineRows = await testDatabase.query(`SELECT COUNT(*)::INTEGER AS count FROM "${server.schema}".state_quarantine WHERE tenant_id = $1`, ['dfixer-store']);
    assert.ok(quarantineRows.rows[0].count >= 2);
    const recoveryAudit = await testDatabase.query(`SELECT action, before_hash, after_hash FROM "${server.schema}".quarantine_recovery_audit WHERE quarantine_id = $1`, ['Q-W2-VALID']);
    assert.equal(recoveryAudit.rowCount, 1);
    assert.equal(recoveryAudit.rows[0].action, 'QUARANTINE_RECOVERY');
    assert.ok(recoveryAudit.rows[0].after_hash);
    await assert.rejects(testDatabase.query(`UPDATE "${server.schema}".quarantine_recovery_audit SET action = 'changed'`), /append-only/);

    const invalidPayload = JSON.stringify({ manifests: [{ id: 'dup', packages: [], scans: [], sessions: [] }, { id: 'dup', packages: [], scans: [], sessions: [] }], incidents: [], audit: [], importJobs: [], orderEvents: [] });
    await testDatabase.query(
      `INSERT INTO "${server.schema}".state_quarantine (id, tenant_id, payload, payload_hash, reason, created_at) VALUES ($1, $2, $3, $4, $5, $6)`,
      ['Q-W2-INVALID', 'dfixer-store', invalidPayload, quarantineHash(invalidPayload), 'invalid test quarantine', new Date().toISOString()],
    );
    const invalidPreview = await fetch(`http://127.0.0.1:${port}/api/admin/quarantine/Q-W2-INVALID`, { headers: { Cookie: `orderguard_session=${admin}` } });
    assert.equal((await invalidPreview.json()).quarantine.valid, false);
    const invalidRecover = await fetch(`http://127.0.0.1:${port}/api/admin/quarantine/Q-W2-INVALID/recover`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `orderguard_session=${admin}` },
      body: JSON.stringify({ confirm: true }),
    });
    assert.equal(invalidRecover.status, 422);
    const unchanged = await readStateForTest(port, admin);
    assert.equal(unchanged.state.incidents.some((incident) => incident.id === 'INC-AUTH-QUARANTINE-RECOVERY'), true);
  } finally {
    await stopTestServer(server);
  }
});

test('operational scan and handover endpoints are transactional, audited, and tenant-scoped', async () => {
  const port = 4342;
  const server = await createTestServer(port);

  try {
    await waitForServer(port);
    const handover = await loginCookie(port, 'handover', 'handover123');
    const base = await readStateForTest(port, handover);
    const manifest = base.state.manifests.find((item) => item.packages.filter((parcel) => parcel.status === 'EXPECTED').length >= 2 && item.packages.some((parcel) => parcel.status === 'SCANNED'));
    const expected = manifest.packages.filter((parcel) => parcel.status === 'EXPECTED').slice(0, 2);
    const scanResponses = await Promise.all(expected.map((parcel) => fetch(`http://127.0.0.1:${port}/api/manifests/${encodeURIComponent(manifest.id)}/scans`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `orderguard_session=${handover}` },
      body: JSON.stringify({ tracking: parcel.tracking }),
    })));
    assert.deepEqual(scanResponses.map((response) => response.status), [201, 201]);
    let current = await readStateForTest(port, handover);
    let currentManifest = current.state.manifests.find((item) => item.id === manifest.id);
    for (const parcel of expected) {
      assert.equal(currentManifest.packages.find((item) => item.tracking === parcel.tracking).status, 'SCANNED');
      assert.equal(currentManifest.scans.some((scan) => scan.tracking === parcel.tracking && scan.result === 'MATCH'), true);
      assert.equal(current.state.audit.some((entry) => entry.action === `Paket dipindai: ${parcel.tracking}`), true);
    }

    const duplicate = await fetch(`http://127.0.0.1:${port}/api/manifests/${encodeURIComponent(manifest.id)}/scans`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `orderguard_session=${handover}` },
      body: JSON.stringify({ tracking: expected[0].tracking }),
    });
    assert.equal(duplicate.status, 201);
    assert.equal((await duplicate.json()).result, 'DUPLICATE_SCAN');
    current = await readStateForTest(port, handover);
    currentManifest = current.state.manifests.find((item) => item.id === manifest.id);
    assert.equal(currentManifest.packages.filter((item) => item.tracking === expected[0].tracking).length, 1);
    assert.equal(currentManifest.scans.some((scan) => scan.tracking === expected[0].tracking && scan.result === 'DUPLICATE_SCAN'), true);

    const accepted = currentManifest.packages.filter((item) => item.status === 'SCANNED').slice(0, 2).map((item) => item.tracking);
    const handoverResponse = await fetch(`http://127.0.0.1:${port}/api/manifests/${encodeURIComponent(manifest.id)}/handovers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `orderguard_session=${handover}` },
      body: JSON.stringify({ receiver: 'Kurir Endpoint', items: accepted, note: 'Endpoint test', evidence: 'data:image/png;base64,iVBORw0KGgo=' }),
    });
    assert.equal(handoverResponse.status, 201, JSON.stringify(await handoverResponse.clone().json().catch(() => ({}))));
    const handoverBody = await handoverResponse.json();
    assert.ok(handoverBody.sessionId);
    current = await readStateForTest(port, handover);
    currentManifest = current.state.manifests.find((item) => item.id === manifest.id);
    assert.equal(currentManifest.sessions.some((session) => session.id === handoverBody.sessionId), true);
    assert.equal(currentManifest.packages.filter((item) => accepted.includes(item.tracking)).every((item) => item.status === 'HANDED_OVER'), true);
    assert.equal(current.state.audit.some((entry) => entry.action.startsWith(`Serah terima ${handoverBody.sessionId} dikonfirmasi:`)), true);

    const admin = await loginCookie(port, 'admin', 'admin123');
    const adminBase = await readStateForTest(port, admin);
    const isolatedManifestState = wave2ManifestState(adminBase.state, 'OG-ENDPOINT-DFIXER', 'TRK-ENDPOINT-DFIXER', 'ENDPOINT');
    const createIsolated = await fetch(`http://127.0.0.1:${port}/api/state`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `orderguard_session=${admin}`, 'If-Match': `"state-${adminBase.version}"` },
      body: JSON.stringify(isolatedManifestState),
    });
    assert.equal(createIsolated.status, 200);
    const maya = await loginCookie(port, 'maya', 'maya123');
    const crossTenant = await fetch(`http://127.0.0.1:${port}/api/manifests/OG-ENDPOINT-DFIXER/scans`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `orderguard_session=${maya}` },
      body: JSON.stringify({ tracking: 'TRK-ENDPOINT-DFIXER' }),
    });
    assert.equal(crossTenant.status, 404);
  } finally {
    await stopTestServer(server);
  }
});
