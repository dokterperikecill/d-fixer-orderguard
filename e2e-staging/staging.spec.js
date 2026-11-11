const { test, expect } = require('@playwright/test');

const username = process.env.STAGING_USERNAME;
const password = process.env.STAGING_PASSWORD;
const expectedTenant = process.env.STAGING_TENANT_NAME || '';
if (!username || !password) throw new Error('STAGING_USERNAME dan STAGING_PASSWORD wajib diatur untuk E2E staging.');

test.describe.serial('OrderGuard staging browser smoke', () => {
  test('login, session persistence, security cookie, and logout', async ({ page, context }) => {
    await page.goto('/');
    await expect(page.locator('#login-form')).toBeVisible();

    await page.locator('#login-username').fill(username);
    await page.locator('#login-password').fill('definitely-wrong-password');
    await page.locator('#login-form button[type="submit"]').click();
    await expect(page.locator('.toast.error')).toBeVisible();

    await page.locator('#login-username').fill(username);
    await page.locator('#login-password').fill(password);
    await page.locator('#login-form button[type="submit"]').click();
    await expect(page.locator('#logout-button')).toBeVisible();
    if (expectedTenant) await expect(page.locator('#workspace-tenant-name')).toHaveText(expectedTenant);

    const sessionCookie = (await context.cookies()).find((cookie) => cookie.name === 'orderguard_session');
    expect(sessionCookie, 'cookie sesi harus ada').toBeTruthy();
    expect(sessionCookie.httpOnly).toBeTruthy();
    expect(sessionCookie.sameSite).toBe('Lax');
    expect(sessionCookie.path).toBe('/');
    if (new URL(process.env.STAGING_BASE_URL).protocol === 'https:') expect(sessionCookie.secure).toBeTruthy();

    await page.reload();
    await expect(page.locator('#logout-button')).toBeVisible();

    await page.locator('#logout-button').click();
    await expect(page.locator('#login-form')).toBeVisible();
  });

  test('PWA manifest and security headers are served', async ({ page }) => {
    const response = await page.goto('/');
    expect(response.ok()).toBeTruthy();
    const headers = response.headers();
    expect(headers['x-frame-options']).toBe('DENY');
    expect(headers['x-content-type-options']).toBe('nosniff');
    expect(headers['content-security-policy']).toContain("default-src 'self'");
    if (new URL(process.env.STAGING_BASE_URL).protocol === 'https:') {
      expect(headers['strict-transport-security']).toBeTruthy();
    }

    const manifestLink = await page.locator('link[rel="manifest"]').getAttribute('href');
    expect(manifestLink).toBe('/manifest.webmanifest');
    const manifest = await page.request.get('/manifest.webmanifest');
    expect(manifest.ok()).toBeTruthy();
    const manifestBody = await manifest.json();
    expect(manifestBody.display).toBe('standalone');
  });

  test('service worker is available over HTTPS', async ({ page }) => {
    test.skip(new URL(process.env.STAGING_BASE_URL).protocol !== 'https:', 'Service worker hanya diuji pada HTTPS.');
    await page.goto('/');
    const scope = await page.evaluate(async () => {
      if (!('serviceWorker' in navigator)) return null;
      const registration = await navigator.serviceWorker.getRegistration();
      return registration ? registration.scope : null;
    });
    expect(scope).toBeTruthy();
  });
});
