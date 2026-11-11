#!/usr/bin/env node
/*
 * Create synthetic staging tenant and users. Idempotent.
 *
 * Required env:
 *   STAGING_BASE_URL
 *   STAGING_ADMIN_USERNAME, STAGING_ADMIN_PASSWORD
 *   STAGING_STORE_PASSWORD, STAGING_HANDOVER_PASSWORD
 * Optional:
 *   STAGING_SECOND_TENANT_ID   default maya-commerce
 *   STAGING_SECOND_TENANT_NAME default Maya Commerce
 *   STAGING_STORE_USERNAME     default staging-store
 *   STAGING_HANDOVER_USERNAME  default staging-handover
 */
const baseUrl = (process.env.STAGING_BASE_URL || '').replace(/\/+$/, '');
const adminUsername = process.env.STAGING_ADMIN_USERNAME || '';
const adminPassword = process.env.STAGING_ADMIN_PASSWORD || '';
const tenantId = process.env.STAGING_SECOND_TENANT_ID || 'maya-commerce';
const tenantName = process.env.STAGING_SECOND_TENANT_NAME || 'Maya Commerce';
const storeUsername = process.env.STAGING_STORE_USERNAME || 'staging-store';
const handoverUsername = process.env.STAGING_HANDOVER_USERNAME || 'staging-handover';
const storePassword = process.env.STAGING_STORE_PASSWORD || '';
const handoverPassword = process.env.STAGING_HANDOVER_PASSWORD || '';
const timeoutMs = Number.parseInt(process.env.STAGING_TIMEOUT_MS || '', 10) || 10000;

if (!baseUrl) throw new Error('STAGING_BASE_URL wajib diatur.');
if (!adminUsername || !adminPassword) throw new Error('STAGING_ADMIN_USERNAME/PASSWORD wajib diatur.');
if (!storePassword || !handoverPassword) throw new Error('STAGING_STORE_PASSWORD dan STAGING_HANDOVER_PASSWORD wajib diatur.');

let cookie = '';
let csrf = '';

async function request(path, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = { ...(options.headers || {}), ...(cookie ? { Cookie: cookie } : {}) };
    if (options.method && options.method !== 'GET' && csrf) headers['X-CSRF-Token'] = csrf;
    const response = await fetch(`${baseUrl}${path}`, { ...options, headers, signal: controller.signal });
    const setCookie = response.headers.getSetCookie?.() || [];
    const session = setCookie.find((value) => /^orderguard_session=/i.test(value));
    if (session) cookie = session.split(';')[0];
    return response;
  } finally {
    clearTimeout(timer);
  }
}

async function json(response) {
  const text = await response.text();
  try { return JSON.parse(text); } catch { return null; }
}

async function main() {
  const login = await request('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: adminUsername, password: adminPassword }),
  });
  const loginBody = await json(login);
  if (!login.ok || !loginBody?.csrfToken) throw new Error(`login admin staging gagal: HTTP ${login.status}`);
  csrf = loginBody.csrfToken;

  const tenantsResponse = await request('/api/tenants');
  const tenantsBody = await json(tenantsResponse);
  const tenants = tenantsBody?.tenants || [];
  const result = { tenantCreated: false, usersCreated: [], usersExisting: [] };

  if (!tenants.some((tenant) => tenant.id === tenantId)) {
    const created = await request('/api/tenants', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: tenantId, name: tenantName }),
    });
    if (!created.ok) throw new Error(`gagal membuat tenant ${tenantId}: HTTP ${created.status} ${JSON.stringify(await json(created))}`);
    result.tenantCreated = true;
  }

  const usersResponse = await request('/api/users');
  const usersBody = await json(usersResponse);
  const usernames = new Set((usersBody?.users || []).map((user) => user.username));

  const desired = [
    { username: storeUsername, name: 'Staging Store Admin', role: 'store-admin', tenantId, password: storePassword },
    { username: handoverUsername, name: 'Staging Handover Staff', role: 'handover-staff', tenantId: 'dfixer-store', password: handoverPassword },
  ];

  for (const user of desired) {
    if (usernames.has(user.username)) {
      result.usersExisting.push(user.username);
      continue;
    }
    const created = await request('/api/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(user),
    });
    if (!created.ok) throw new Error(`gagal membuat user ${user.username}: HTTP ${created.status} ${JSON.stringify(await json(created))}`);
    result.usersCreated.push(user.username);
  }

  console.log(JSON.stringify({ status: 'ok', tenantId, tenantName, ...result }, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({ status: 'error', message: error?.message || String(error) }, null, 2));
  process.exitCode = 1;
});
