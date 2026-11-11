#!/usr/bin/env node
/*
 * Staging smoke + security verification.
 *
 * Read-only against the staging host except:
 * - one login/logout session,
 * - one rejected CSRF request,
 * - optional failed-login rate-limit probe for a dedicated user.
 *
 * Required env:
 *   STAGING_BASE_URL, STAGING_USERNAME, STAGING_PASSWORD
 * Optional:
 *   STAGING_ALLOW_HTTP=1            allow http:// (local rehearsal only)
 *   STAGING_INSECURE_TLS=1          skip TLS verification (never for real staging)
 *   STAGING_EXPECT_ENVIRONMENT      default: production
 *   STAGING_RATE_LIMIT_USERNAME     dedicated user for 429 check
 *   STAGING_RATE_LIMIT_ATTEMPTS     default: 6
 */
const baseUrl = (process.env.STAGING_BASE_URL || '').replace(/\/+$/, '');
const username = process.env.STAGING_USERNAME || '';
const password = process.env.STAGING_PASSWORD || '';
const allowHttp = process.env.STAGING_ALLOW_HTTP === '1';
const expectEnvironment = process.env.STAGING_EXPECT_ENVIRONMENT || 'production';
const timeoutMs = Number.parseInt(process.env.STAGING_TIMEOUT_MS || '', 10) || 10000;

if (process.env.STAGING_INSECURE_TLS === '1') {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  console.warn('PERINGATAN: verifikasi TLS dinonaktifkan (STAGING_INSECURE_TLS=1).');
}

const results = [];
let sessionCookie = '';
let csrfToken = '';

function record(name, pass, detail = '') {
  results.push({ name, pass: Boolean(pass), detail });
  if (!results.at(-1).pass) console.error(`FAIL ${name}${detail ? ` — ${detail}` : ''}`);
}

function assert(name, condition, detail = '') {
  record(name, condition, detail);
  return Boolean(condition);
}

function cookieHeader(setCookieHeaders) {
  return setCookieHeaders
    .map((value) => String(value).split(';')[0])
    .filter(Boolean)
    .join('; ');
}

async function request(path, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${baseUrl}${path}`, { redirect: 'manual', ...options, signal: controller.signal });
    return response;
  } finally {
    clearTimeout(timer);
  }
}

function getSetCookies(response) {
  if (typeof response.headers.getSetCookie === 'function') return response.headers.getSetCookie();
  const raw = response.headers.get('set-cookie');
  return raw ? [raw] : [];
}

async function readJson(response) {
  const text = await response.text();
  try { return JSON.parse(text); } catch { return null; }
}

async function main() {
  if (!baseUrl) throw new Error('STAGING_BASE_URL wajib diatur.');
  if (!username || !password) throw new Error('STAGING_USERNAME dan STAGING_PASSWORD wajib diatur.');
  const parsed = new URL(baseUrl);
  if (parsed.protocol !== 'https:' && !allowHttp) {
    throw new Error('STAGING_BASE_URL harus https://. Set STAGING_ALLOW_HTTP=1 hanya untuk rehearsal lokal.');
  }

  const health = await request('/api/health');
  const healthBody = await readJson(health);
  assert('GET /api/health = 200', health.status === 200, `status ${health.status}`);
  assert('health.status = ok', healthBody?.status === 'ok', JSON.stringify(healthBody));

  const ready = await request('/api/ready');
  const readyBody = await readJson(ready);
  assert('GET /api/ready = 200', ready.status === 200, `status ${ready.status}`);
  assert('readiness database = ok', readyBody?.status === 'ready' && readyBody?.database === 'ok', JSON.stringify(readyBody));

  const home = await request('/');
  const headers = home.headers;
  const csp = headers.get('content-security-policy') || '';
  const isHttps = parsed.protocol === 'https:';
  assert('security header: X-Frame-Options DENY', (headers.get('x-frame-options') || '').toUpperCase() === 'DENY');
  assert('security header: X-Content-Type-Options nosniff', (headers.get('x-content-type-options') || '').toLowerCase() === 'nosniff');
  assert('security header: Referrer-Policy', Boolean(headers.get('referrer-policy')));
  assert('security header: Permissions-Policy', Boolean(headers.get('permissions-policy')));
  assert('security header: CSP default-src self', /default-src 'self'/.test(csp));
  assert('security header: CSP frame-ancestors none', /frame-ancestors 'none'/.test(csp));
  if (isHttps) {
    assert('security header: HSTS', /max-age=\d+/.test(headers.get('strict-transport-security') || ''));
  }

  const config = await readJson(await request('/api/config'));
  assert('config.environment sesuai', config?.environment === expectEnvironment, `didapat ${config?.environment}`);

  const login = await request('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const loginBody = await readJson(login);
  const setCookies = getSetCookies(login);
  sessionCookie = cookieHeader(setCookies);
  csrfToken = loginBody?.csrfToken || '';
  assert('login berhasil', login.status === 200, `status ${login.status}`);
  assert('login mengembalikan csrfToken', typeof csrfToken === 'string' && csrfToken.length >= 20);
  const sessionSetCookie = setCookies.find((value) => /^orderguard_session=/i.test(value)) || '';
  assert('cookie session HttpOnly', /httponly/i.test(sessionSetCookie));
  assert('cookie session SameSite=Lax', /samesite=lax/i.test(sessionSetCookie));
  assert('cookie session Path=/', /path=\//i.test(sessionSetCookie));
  if (isHttps) assert('cookie session Secure', /;\s*secure/i.test(sessionSetCookie));

  const session = await request('/api/session', { headers: { Cookie: sessionCookie } });
  const sessionBody = await readJson(session);
  assert('GET /api/session dengan cookie = 200', session.status === 200);
  assert('session mengembalikan user', Boolean(sessionBody?.user?.username));
  assert('session mengembalikan csrfToken', Boolean(sessionBody?.csrfToken));

  const noCsrf = await request('/api/state', {
    method: 'POST',
    headers: { Cookie: sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ probe: true }),
  });
  const noCsrfBody = await readJson(noCsrf);
  assert('POST tanpa CSRF ditolak 403', noCsrf.status === 403, `status ${noCsrf.status}`);
  assert('kode CSRF_INVALID', noCsrfBody?.code === 'CSRF_INVALID', JSON.stringify(noCsrfBody));

  const badOrigin = await request('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://attacker.invalid' },
    body: JSON.stringify({ username, password }),
  });
  const badOriginBody = await readJson(badOrigin);
  assert('origin asing ditolak 403', badOrigin.status === 403, `status ${badOrigin.status}`);
  assert('kode ORIGIN_REJECTED', badOriginBody?.code === 'ORIGIN_REJECTED', JSON.stringify(badOriginBody));

  const unauthenticated = await request('/api/state');
  assert('GET /api/state tanpa sesi = 401', unauthenticated.status === 401, `status ${unauthenticated.status}`);

  const rateLimitUser = process.env.STAGING_RATE_LIMIT_USERNAME || '';
  if (rateLimitUser) {
    const attempts = Math.max(2, Number.parseInt(process.env.STAGING_RATE_LIMIT_ATTEMPTS || '', 10) || 6);
    const statuses = [];
    for (let index = 0; index < attempts; index += 1) {
      const response = await request('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: rateLimitUser, password: `invalid-${index}-${Date.now()}` }),
      });
      statuses.push(response.status);
      await response.text();
    }
    assert('login rate limit menghasilkan 429', statuses.includes(429), `statuses ${statuses.join(',')}`);
  }

  const logout = await request('/api/logout', {
    method: 'POST',
    headers: { Cookie: sessionCookie, 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
    body: JSON.stringify({}),
  });
  assert('logout = 200', logout.status === 200, `status ${logout.status}`);
  const afterLogout = await request('/api/session', { headers: { Cookie: sessionCookie } });
  const afterLogoutBody = await readJson(afterLogout);
  assert('sesi lama tidak berlaku setelah logout', afterLogoutBody?.user === null);

  const failed = results.filter((item) => !item.pass);
  const report = {
    generatedAt: new Date().toISOString(),
    target: parsed.host,
    environment: config?.environment || null,
    total: results.length,
    passed: results.length - failed.length,
    failed: failed.length,
    results,
  };
  console.log(JSON.stringify(report, null, 2));
  if (failed.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error(JSON.stringify({ level: 'error', event: 'staging_smoke_error', message: error?.message || String(error) }, null, 2));
  process.exitCode = 1;
});
