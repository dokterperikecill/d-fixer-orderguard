const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

function createTestServer(port, prepareDatabase) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orderguard-test-'));
  const dbPath = path.join(directory, 'orderguard.db');
  if (prepareDatabase) prepareDatabase(dbPath);
  const child = spawn(process.execPath, ['server.js'], {
    cwd: __dirname,
    env: { ...process.env, PORT: String(port), ORDERGUARD_DB_PATH: dbPath, NODE_ENV: 'test' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return { child, directory };
}

async function stopTestServer(server) {
  const exited = new Promise((resolve) => server.child.once('exit', resolve));
  server.child.kill('SIGTERM');
  await exited;
  fs.rmSync(server.directory, { recursive: true, force: true });
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
  const server = createTestServer(port);

  try {
    await waitForServer(port);
    const health = await fetch(`http://127.0.0.1:${port}/api/health`);
    const unauthenticatedState = await fetch(`http://127.0.0.1:${port}/api/state`);

    assert.equal(health.status, 200);
    const healthJson = await health.json();
    assert.equal(healthJson.status, 'ok');
    assert.equal(unauthenticatedState.status, 401);

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
  } finally {
    await stopTestServer(server);
  }
});

test('handover staff is allowed to access and update manifest state', async () => {
  const port = 4311;
  const server = createTestServer(port);

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

    const stateBefore = await fetch(`http://127.0.0.1:${port}/api/state`, {
      headers: { Cookie: `orderguard_session=${sessionCookie}` },
    });

    assert.equal(stateBefore.status, 200);
    const state = await stateBefore.json();
    assert.ok(Array.isArray(state.manifests));

    const update = await fetch(`http://127.0.0.1:${port}/api/state`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: `orderguard_session=${sessionCookie}`,
      },
      body: JSON.stringify({ ...state, updatedAt: new Date().toISOString() }),
    });

    assert.equal(update.status, 200);
    const updateJson = await update.json();
    assert.equal(updateJson.ok, true);
  } finally {
    await stopTestServer(server);
  }
});

test('tenant state is isolated and legacy D\'Fixer data is preserved', async () => {
  const port = 4312;
  const server = createTestServer(port, (dbPath) => {
    const db = new Database(dbPath);
    db.exec(`CREATE TABLE app_state (id TEXT PRIMARY KEY, payload TEXT NOT NULL, updated_at TEXT NOT NULL)`);
    db.prepare('INSERT INTO app_state (id, payload, updated_at) VALUES (?, ?, ?)').run(
      'state',
      JSON.stringify({ manifests: [{ id: 'legacy-dfixer' }], incidents: [], audit: [], importJobs: [], marker: 'legacy-state' }),
      new Date().toISOString(),
    );
    db.close();
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

    const raniUpdate = { manifests: [{ id: 'rani-only' }], incidents: [], audit: [], importJobs: [], marker: 'rani-state' };
    await fetch(`http://127.0.0.1:${port}/api/state`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `orderguard_session=${raniCookie}` },
      body: JSON.stringify(raniUpdate),
    });

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
    assert.equal(mayaInitialState.marker, undefined);
    assert.equal(mayaInitialState.manifests[0].shop, 'Maya Commerce');
    assert.equal(mayaInitialState.manifests.some((manifest) => manifest.id === 'rani-only'), false);

    await fetch(`http://127.0.0.1:${port}/api/state`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `orderguard_session=${mayaCookie}` },
      body: JSON.stringify({ manifests: [], incidents: [], audit: [], importJobs: [], tenantId: 'dfixer-store', marker: 'maya-state' }),
    });

    const raniAfterMayaUpdate = await fetch(`http://127.0.0.1:${port}/api/state`, {
      headers: { Cookie: `orderguard_session=${raniCookie}` },
    }).then((response) => response.json());
    assert.equal(raniAfterMayaUpdate.marker, 'rani-state');

    const mayaAfterUpdate = await fetch(`http://127.0.0.1:${port}/api/state`, {
      headers: { Cookie: `orderguard_session=${mayaCookie}` },
    }).then((response) => response.json());
    assert.equal(mayaAfterUpdate.marker, 'maya-state');
  } finally {
    await stopTestServer(server);
  }
});

test('employee management is super-admin only and updates credentials and access', async () => {
  const port = 4313;
  const server = createTestServer(port);

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

test('tenant creation and rename are restricted and reflected in employee accounts', async () => {
  const port = 4314;
  const server = createTestServer(port);

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
