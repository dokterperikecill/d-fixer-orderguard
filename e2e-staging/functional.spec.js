const { test, expect } = require('@playwright/test');
const { Client } = require('pg');
const fs = require('node:fs');
const crypto = require('node:crypto');
const XLSX = require('xlsx');

const ADMIN = {
  username: process.env.STAGING_ADMIN_USERNAME || process.env.STAGING_USERNAME || '',
  password: process.env.STAGING_ADMIN_PASSWORD || process.env.STAGING_PASSWORD || '',
};
const STORE = {
  username: process.env.STAGING_STORE_USERNAME || '',
  password: process.env.STAGING_STORE_PASSWORD || '',
};
const HANDOVER = {
  username: process.env.STAGING_HANDOVER_USERNAME || '',
  password: process.env.STAGING_HANDOVER_PASSWORD || '',
};
const PRIMARY_TENANT = process.env.STAGING_TENANT_NAME || "D'Fixer Store";
const SECOND_TENANT = process.env.STAGING_SECOND_TENANT_NAME || 'Maya Commerce';
const DB_URL = process.env.STAGING_DB_URL || '';
const DB_SCHEMA = process.env.STAGING_DB_SCHEMA || 'public';
const RUN = (process.env.STAGING_RUN_ID || Date.now().toString(36)).toUpperCase();

const functionalReady = Boolean(ADMIN.username && ADMIN.password && STORE.username && STORE.password && HANDOVER.username && HANDOVER.password);
test.skip(!functionalReady, 'STAGING_* credentials untuk functional suite belum lengkap.');

async function login(page, account) {
  await page.goto('/');
  await page.locator('#login-username').fill(account.username);
  await page.locator('#login-password').fill(account.password);
  await page.locator('#login-form button[type="submit"]').click();
  await expect(page.locator('#logout-button')).toBeVisible();
}

async function logout(page) {
  await page.locator('#logout-button').click();
  await expect(page.locator('#login-form')).toBeVisible();
}

async function goView(page, view) {
  await page.locator(`[data-view="${view}"]`).click();
}

async function stateFromApi(page) {
  const response = await page.request.get('/api/state');
  expect(response.ok()).toBeTruthy();
  return response.json();
}

function csvFile(tracking) {
  return {
    name: `staging-${RUN}.csv`,
    mimeType: 'text/csv',
    buffer: Buffer.from([
      'Nomor Pesanan,Nomor Resi,Kurir,Toko,Tanggal',
      `ORD-STG-${RUN}-CSV,${tracking},JNE,"${PRIMARY_TENANT}",2026-11-12`,
    ].join('\n')),
  };
}

function xlsxFile(testInfo, tracking) {
  const file = testInfo.outputPath(`staging-${RUN}.xlsx`);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
    ['Nomor Pesanan', 'Nomor Resi', 'Kurir', 'Toko', 'Tanggal'],
    [`ORD-STG-${RUN}-XLSX`, tracking, 'JNE', PRIMARY_TENANT, '2026-11-12'],
  ]), 'Orders');
  XLSX.writeFile(workbook, file);
  return {
    name: `staging-${RUN}.xlsx`,
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    buffer: fs.readFileSync(file),
  };
}

function photoFile() {
  return {
    name: 'staging-handover.png',
    mimeType: 'image/png',
    buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=', 'base64'),
  };
}

async function withDb(callback) {
  if (!DB_URL) return null;
  const client = new Client({ connectionString: DB_URL, ...(DB_SCHEMA !== 'public' ? { options: `-c search_path=${DB_SCHEMA}` } : {}) });
  await client.connect();
  try {
    return await callback(client);
  } finally {
    await client.end();
  }
}

test.describe.serial('OrderGuard staging functional', () => {
  test('login, tenant isolation, and logout', async ({ page }) => {
    await page.goto('/');
    await page.locator('#login-username').fill(ADMIN.username);
    await page.locator('#login-password').fill('wrong-password');
    await page.locator('#login-form button[type="submit"]').click();
    await expect(page.locator('.toast.error')).toBeVisible();

    await page.locator('#login-username').fill(STORE.username);
    await page.locator('#login-password').fill(STORE.password);
    await page.locator('#login-form button[type="submit"]').click();
    await expect(page.locator('#logout-button')).toBeVisible();
    await expect(page.locator('#workspace-tenant-name')).toHaveText(SECOND_TENANT);
    await logout(page);

    await login(page, ADMIN);
    await expect(page.locator('#workspace-tenant-name')).toHaveText(PRIMARY_TENANT);
  });

  test('CSV and XLSX import create validated manifests', async ({ page }, testInfo) => {
    const csvTracking = `TRK-STG-${RUN}-CSV`;
    const xlsxTracking = `TRK-STG-${RUN}-XLSX`;
    await login(page, ADMIN);

    await goView(page, 'imports');
    await page.locator('#import-file').setInputFiles(csvFile(csvTracking));
    await expect(page.locator('#import-preview')).toContainText('Siap dimanifestkan');
    await page.locator('[data-action="commit-import"]').click();
    await expect(page.locator('.toast').filter({ hasText: /paket dimasukkan|Impor/i })).toBeVisible();

    await goView(page, 'imports');
    await page.locator('#import-file').setInputFiles(xlsxFile(testInfo, xlsxTracking));
    await expect(page.locator('#import-preview')).toContainText('Siap dimanifestkan', { timeout: 30_000 });
    await page.locator('[data-action="commit-import"]').click();
    await expect(page.locator('.toast').filter({ hasText: /paket dimasukkan|Impor/i })).toBeVisible();

    const state = await stateFromApi(page);
    expect(state.manifests.some((manifest) => manifest.packages.some((parcel) => parcel.tracking === csvTracking))).toBeTruthy();
    expect(state.manifests.some((manifest) => manifest.packages.some((parcel) => parcel.tracking === xlsxTracking))).toBeTruthy();
  });

  test('scan, duplicate, out-of-manifest, handover, evidence, and finalization', async ({ page }) => {
    const csvTracking = `TRK-STG-${RUN}-CSV`;
    await login(page, ADMIN);
    const state = await stateFromApi(page);
    const manifest = state.manifests.find((item) => item.packages.some((parcel) => parcel.tracking === csvTracking));
    expect(manifest).toBeTruthy();

    await goView(page, 'manifests');
    await page.locator(`[data-action="open-manifest"][data-id="${manifest.id}"]`).first().click();
    await expect(page.locator('#scan-input')).toBeVisible();

    await page.locator('#scan-input').fill(`TRK-STG-${RUN}-UNKNOWN`);
    await page.locator('#scan-form button[type="submit"]').click();
    await expect(page.locator('#scan-feedback')).toContainText('Di luar manifest');

    await page.locator('#scan-input').fill(csvTracking);
    await page.locator('#scan-form button[type="submit"]').click();
    await expect(page.locator('#scan-feedback')).toContainText('Cocok');

    await page.locator('#scan-input').fill(csvTracking);
    await page.locator('#scan-form button[type="submit"]').click();
    await expect(page.locator('#scan-feedback')).toContainText('Pindai duplikat');

    await page.locator('#receiver-name').fill('Kurir Staging');
    await page.locator('#handover-photo').setInputFiles(photoFile());
    page.once('dialog', (dialog) => dialog.accept());
    await page.locator('#handover-form button[type="submit"]').click();
    await expect(page.locator('.toast').filter({ hasText: /Serah terima tersimpan/i })).toBeVisible();

    await page.locator('[data-action="view-evidence"]').first().click();
    await expect(page.locator('#evidence-modal-content img')).toBeVisible();
    await page.locator('[data-action="close-modal"]').last().click();

    page.once('dialog', (dialog) => dialog.accept());
    await page.locator('[data-action="close-manifest"]').click();
    await expect(page.locator('.toast').filter({ hasText: /Manifest ditutup/i })).toBeVisible();
  });

  test('reports are available after operational activity', async ({ page }) => {
    await login(page, ADMIN);
    await goView(page, 'reports');
    await expect(page.locator('#page-content')).toContainText('Laporan rekonsiliasi');
    await expect(page.locator('#page-content')).toContainText('Rekonsiliasi per manifest');
  });

  test('quarantine recovery and cross-tenant scoping', async ({ page }) => {
    test.skip(!DB_URL, 'STAGING_DB_URL tidak diatur.');
    const quarantineId = `Q-STG-${RUN}`;
    const crossTenantId = `Q-STG-${RUN}-OTHER`;
    await login(page, ADMIN);
    const current = await stateFromApi(page);
    const recovered = structuredClone(current);
    const createdAt = new Date().toISOString();
    const incident = { id: `INC-STG-${RUN}`, category: 'Masalah lain', manifestId: '', tracking: '', description: 'Staging quarantine recovery', reportedBy: 'Platform Admin', createdAt, status: 'OPEN', resolution: '' };
    recovered.incidents.unshift(incident);
    recovered.audit.unshift({ id: `AU-STG-${RUN}`, actor: 'Platform Admin', action: 'Insiden dicatat: Masalah lain', object: incident.id, createdAt });
    const payload = JSON.stringify(recovered);
    const hash = crypto.createHash('sha256').update(payload).digest('hex');
    const crossPayload = JSON.stringify({ manifests: [], incidents: [], audit: [], importJobs: [], orderEvents: [] });
    const crossHash = crypto.createHash('sha256').update(crossPayload).digest('hex');

    await withDb(async (db) => {
      await db.query(
        `INSERT INTO state_quarantine (id, tenant_id, payload, payload_hash, reason, created_at) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING`,
        [quarantineId, 'dfixer-store', payload, hash, 'Staging functional quarantine', createdAt],
      );
      await db.query(
        `INSERT INTO state_quarantine (id, tenant_id, payload, payload_hash, reason, created_at) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING`,
        [crossTenantId, 'dfixer-store', crossPayload, crossHash, 'Staging tenant scoping', createdAt],
      );
    });

    await goView(page, 'quarantine');
    await expect(page.locator('#page-content')).toContainText(quarantineId);
    await page.locator(`[data-action="view-quarantine"][data-id="${quarantineId}"]`).click();
    await expect(page.locator('#modal')).toContainText('Detail quarantine');
    page.once('dialog', (dialog) => dialog.accept());
    await page.locator('[data-action="recover-quarantine"]').click();
    await expect(page.locator('.toast').filter({ hasText: /berhasil dipulihkan/i })).toBeVisible();
    const after = await stateFromApi(page);
    expect(after.incidents.some((item) => item.id === `INC-STG-${RUN}`)).toBeTruthy();

    await logout(page);
    await login(page, STORE);
    await expect(page.locator('#workspace-tenant-name')).toHaveText(SECOND_TENANT);
    await goView(page, 'quarantine');
    await expect(page.locator('#page-content')).not.toContainText(crossTenantId);
    const list = await page.request.get('/api/admin/quarantine');
    expect(list.ok()).toBeTruthy();
    const listed = await list.json();
    expect(listed.quarantine.some((item) => item.id === crossTenantId)).toBeFalsy();
    const detail = await page.request.get(`/api/admin/quarantine/${crossTenantId}`);
    expect(detail.status()).toBe(404);
  });

  test('expired session is rejected', async ({ page }) => {
    test.skip(!DB_URL, 'STAGING_DB_URL tidak diatur.');
    await login(page, ADMIN);
    await withDb(async (db) => {
      await db.query(
        `UPDATE sessions SET expires_at = $1 WHERE user_id = (SELECT id FROM users WHERE username = $2)`,
        [new Date(Date.now() - 1000).toISOString(), ADMIN.username],
      );
    });
    await page.reload();
    await expect(page.locator('#login-form')).toBeVisible();
  });
});
