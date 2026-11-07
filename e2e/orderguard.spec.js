const { test, expect } = require('@playwright/test');
const { Client } = require('pg');
const fs = require('node:fs');
const path = require('node:path');
const XLSX = require('xlsx');

const E2E_SCHEMA = process.env.E2E_SCHEMA || 'orderguard_e2e';
const DATABASE_URL = process.env.TEST_DATABASE_URL;
if (!DATABASE_URL) throw new Error('TEST_DATABASE_URL wajib diatur untuk E2E.');

async function login(page, username, password) {
  await page.goto('/');
  await page.locator('#login-username').fill(username);
  await page.locator('#login-password').fill(password);
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

function writeCsv() {
  return {
    name: 'orders.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from([
      'Nomor Pesanan,Nomor Resi,Kurir,Toko,Tanggal',
      'ORD-E2E-CSV,TRK-E2E-CSV-001,JNE,"D\'Fixer Store",2026-11-08',
    ].join('\n')),
  };
}

function writeXlsx(testInfo) {
  const file = testInfo.outputPath('orders.xlsx');
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
    ['Nomor Pesanan', 'Nomor Resi', 'Kurir', 'Toko', 'Tanggal'],
    ['ORD-E2E-XLSX', 'TRK-E2E-XLSX-001', 'JNE', "D'Fixer Store", '2026-11-08'],
  ]), 'Orders');
  XLSX.writeFile(workbook, file);
  return {
    name: 'orders.xlsx',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    buffer: fs.readFileSync(file),
  };
}

function writePhoto() {
  return {
    name: 'handover-proof.png',
    mimeType: 'image/png',
    buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=', 'base64'),
  };
}

test.describe.serial('OrderGuard browser E2E', () => {
  test('login, wrong credentials, logout, tenant isolation, and session expiration', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#login-form')).toBeVisible();
    await page.locator('#login-username').fill('admin');
    await page.locator('#login-password').fill('definitely-wrong');
    await page.locator('#login-form button[type="submit"]').click();
    await expect(page.locator('.toast.error')).toContainText(/Kredensial/i);

    await login(page, 'admin', 'admin123');
    await expect(page.locator('#workspace-tenant-name')).toHaveText("D'Fixer Store");
    await expect(page.locator('#profile-user-name')).toHaveText('Platform Admin');
    await logout(page);

    await login(page, 'maya', 'maya123');
    await expect(page.locator('#workspace-tenant-name')).toHaveText('Maya Commerce');
    await logout(page);

    await login(page, 'admin', 'admin123');
    const db = new Client({ connectionString: DATABASE_URL });
    await db.connect();
    try {
      await db.query(`UPDATE "${E2E_SCHEMA}".sessions SET expires_at = $1 WHERE user_id = $2`, [new Date(Date.now() - 1000).toISOString(), 'admin']);
    } finally {
      await db.end();
    }
    await page.reload();
    await expect(page.locator('#login-form')).toBeVisible();
    await login(page, 'admin', 'admin123');
  });

  test('CSV and XLSX import create validated manifests', async ({ page }, testInfo) => {
    await login(page, 'admin', 'admin123');
    await goView(page, 'imports');
    await page.locator('#import-file').setInputFiles(writeCsv());
    await expect(page.locator('#import-preview')).toContainText('Siap dimanifestkan');
    await page.locator('[data-action="commit-import"]').click();
    await expect(page.locator('.toast')).toContainText(/paket dimasukkan|Impor/i);
    let state = await stateFromApi(page);
    expect(state.manifests.some((manifest) => manifest.packages.some((parcel) => parcel.tracking === 'TRK-E2E-CSV-001'))).toBeTruthy();

    await goView(page, 'imports');
    await page.locator('#import-file').setInputFiles(writeXlsx(testInfo));
    await expect(page.locator('#import-preview')).toContainText('Siap dimanifestkan', { timeout: 30_000 });
    await page.locator('[data-action="commit-import"]').click();
    await expect(page.locator('.toast')).toContainText(/paket dimasukkan|Impor/i);
    state = await stateFromApi(page);
    expect(state.manifests.some((manifest) => manifest.packages.some((parcel) => parcel.tracking === 'TRK-E2E-XLSX-001'))).toBeTruthy();
  });

  test('scanning, duplicate scan prevention, handover, evidence, and finalization', async ({ page }, testInfo) => {
    await login(page, 'admin', 'admin123');
    const state = await stateFromApi(page);
    const manifest = state.manifests.find((item) => item.packages.some((parcel) => parcel.tracking === 'TRK-E2E-CSV-001'));
    expect(manifest).toBeTruthy();
    await goView(page, 'manifests');
    await page.locator(`[data-action="open-manifest"][data-id="${manifest.id}"]`).first().click();
    await expect(page.locator('#scan-input')).toBeVisible();
    await page.locator('#scan-input').fill('TRK-E2E-CSV-001');
    await page.locator('#scan-form button[type="submit"]').click();
    await expect(page.locator('#scan-feedback')).toContainText('Cocok');

    await page.locator('#scan-input').fill('TRK-E2E-CSV-001');
    await page.locator('#scan-form button[type="submit"]').click();
    await expect(page.locator('#scan-feedback')).toContainText('Pindai duplikat');
    const afterDuplicate = await stateFromApi(page);
    const parcel = afterDuplicate.manifests.find((item) => item.id === manifest.id).packages.find((item) => item.tracking === 'TRK-E2E-CSV-001');
    expect(parcel.status).toBe('SCANNED');

    await page.locator('#receiver-name').fill('Kurir E2E');
    await page.locator('#handover-photo').setInputFiles(writePhoto());
    page.once('dialog', (dialog) => dialog.accept());
    await page.locator('#handover-form button[type="submit"]').click();
    await expect(page.locator('.toast')).toContainText(/Serah terima tersimpan/i);

    await page.locator('[data-action="view-evidence"]').first().click();
    await expect(page.locator('#evidence-modal-content img')).toBeVisible();
    await page.locator('[data-action="close-modal"]').last().click();

    page.once('dialog', (dialog) => dialog.accept());
    await page.locator('[data-action="close-manifest"]').click();
    await expect(page.locator('.toast')).toContainText(/Manifest ditutup/i);
  });

  test('reports are available after operational activity', async ({ page }) => {
    await login(page, 'admin', 'admin123');
    await goView(page, 'reports');
    await expect(page.locator('#page-content')).toContainText('Laporan rekonsiliasi');
    await expect(page.locator('#page-content')).toContainText('Rekonsiliasi per manifest');
  });

  test('connection failure during session bootstrap renders login safely', async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.route('**/api/session', (route) => route.abort());
    await page.goto('/');
    await expect(page.locator('#login-form')).toBeVisible();
    await context.close();
  });

  test('PWA service worker registers and uses the current shell cache', async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto('/');
    const result = await page.evaluate(async () => {
      const registration = await navigator.serviceWorker.ready;
      return { scriptURL: registration.active?.scriptURL || '', caches: await caches.keys() };
    });
    expect(result.scriptURL).toContain('/service-worker.js');
    expect(result.caches).toContain('dfixer-orderguard-shell-v9');
    await context.close();
  });
});
