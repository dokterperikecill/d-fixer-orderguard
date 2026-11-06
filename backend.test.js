const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { Pool } = require('pg');
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
    assert.match(await home.text(), /rel="manifest" href="\/manifest\.webmanifest"/);
    assert.equal((await fetch(`http://127.0.0.1:${port}/app.js`)).status, 200);
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
    assert.match(await serviceWorker.text(), /url\.pathname\.startsWith\("\/api\/"\)/);
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
    assert.equal(state.manifests[0].shop, 'North Store Operations');

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
