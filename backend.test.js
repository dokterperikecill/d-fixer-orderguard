const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');

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
  const child = spawn(process.execPath, ['server.js'], {
    cwd: __dirname,
    env: { ...process.env, PORT: String(port), NODE_ENV: 'test' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

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
    child.kill('SIGTERM');
  }
});

test('handover staff is allowed to access and update manifest state', async () => {
  const port = 4311;
  const child = spawn(process.execPath, ['server.js'], {
    cwd: __dirname,
    env: { ...process.env, PORT: String(port), NODE_ENV: 'test' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

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
    child.kill('SIGTERM');
  }
});
