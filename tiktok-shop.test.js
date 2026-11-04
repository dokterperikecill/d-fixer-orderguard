const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const TikTokShop = require('./tiktok-shop');

test('TikTok request signature sorts parameters and excludes sign and access token', () => {
  const actual = TikTokShop.signRequest('/order/search', {
    z: 'last',
    access_token: 'not-signed',
    a: 'first',
    sign: 'ignored',
  }, { limit: 10 }, 'app-secret');
  const expected = crypto.createHmac('sha256', 'app-secret')
    .update('app-secret/order/searchafirstzlast{"limit":10}app-secret')
    .digest('hex');
  assert.equal(actual, expected);
});

test('TikTok access tokens are encrypted and authenticated at rest', () => {
  const key = crypto.randomBytes(32).toString('hex');
  const encrypted = TikTokShop.encryptSecret('private-access-token', key);
  assert.notEqual(encrypted, 'private-access-token');
  assert.equal(TikTokShop.decryptSecret(encrypted, key), 'private-access-token');
  assert.throws(() => TikTokShop.decryptSecret(`${encrypted.slice(0, -2)}aa`, key));
});

test('TikTok order search follows pagination and returns all pages', async () => {
  const calls = [];
  const orders = await TikTokShop.searchOrders({
    accessToken: 'access-token',
    shopCipher: 'shop-cipher',
    config: { key: 'app-key', secret: 'app-secret' },
    now: 1800000000000,
    fetchImpl: async (url, options) => {
      const requestUrl = new URL(url);
      calls.push({ requestUrl, options, body: JSON.parse(options.body) });
      const firstPage = !requestUrl.searchParams.has('page_token');
      return Response.json({
        code: 0,
        data: {
          orders: firstPage ? [{ order_id: 'order-1' }] : [{ order_id: 'order-2' }],
          ...(firstPage ? { next_page_token: 'next-page' } : {}),
        },
      });
    },
  });

  assert.deepEqual(orders.map((order) => order.order_id), ['order-1', 'order-2']);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].requestUrl.pathname, '/order/202309/orders/search');
  assert.equal(calls[0].requestUrl.searchParams.get('page_size'), '100');
  assert.equal(calls[1].requestUrl.searchParams.get('page_token'), 'next-page');
  assert.equal(calls[0].requestUrl.searchParams.get('shop_cipher'), 'shop-cipher');
  assert.equal(calls[0].requestUrl.searchParams.has('access_token'), false);
  assert.equal(calls[0].options.headers['x-tts-access-token'], 'access-token');
  assert.equal(calls[0].body.update_time_ge, Math.floor((1800000000000 - 30 * 24 * 60 * 60 * 1000) / 1000));
});

test('only orders with a tracking number are mapped for manifest import', () => {
  const result = TikTokShop.prepareImportOrders([
    { order_id: 'ready-order', tracking_number: '  TRK-1 ', shipping_provider: 'JNE', buyer_email: 'private@example.test' },
    { order_id: 'no-tracking' },
    { order_id: 'existing-order', tracking_number: 'TRK-OLD' },
    { order_id: 'ready-order', tracking_number: 'TRK-DUPLICATE' },
    { tracking_number: 'TRK-NO-ID' },
  ], 'TikTok Shop Jakarta', '2026-11-04', {
    existingOrders: ['existing-order'],
  });
  assert.deepEqual(result, {
    orders: [{
      order: 'ready-order',
      tracking: 'TRK-1',
      courier: 'JNE',
      shop: 'TikTok Shop Jakarta',
      date: '2026-11-04',
    }],
    withoutTracking: 1,
    alreadyImported: 1,
    duplicateOrders: 1,
  });
  assert.equal(JSON.stringify(result).includes('private@example.test'), false);
});

test('TikTok API errors are surfaced instead of returning empty order data', async () => {
  await assert.rejects(() => TikTokShop.searchOrders({
    accessToken: 'access-token',
    shopCipher: 'shop-cipher',
    config: { key: 'app-key', secret: 'app-secret' },
    fetchImpl: async () => Response.json({ code: 123, message: 'permission denied' }),
  }), /permission denied/);
});

test('TikTok integration reports missing server configuration', () => {
  assert.deepEqual(TikTokShop.getConfig({}), {
    key: undefined,
    secret: undefined,
    redirectUri: undefined,
    encryptionKey: undefined,
    missing: ['TIKTOK_APP_KEY', 'TIKTOK_APP_SECRET', 'TIKTOK_REDIRECT_URI', 'ORDERGUARD_TOKEN_ENCRYPTION_KEY'],
  });
});
