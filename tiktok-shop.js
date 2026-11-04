const crypto = require('node:crypto');

const API_BASE_URL = 'https://open-api.tiktokglobalshop.com';
const AUTHORIZATION_URL = 'https://services.tiktokshop.com/open/authorize';
const MAX_ORDER_PAGES = 20;

function getConfig(env = process.env) {
  const key = env.TIKTOK_APP_KEY?.trim();
  const secret = env.TIKTOK_APP_SECRET;
  const redirectUri = env.TIKTOK_REDIRECT_URI?.trim();
  const encryptionKey = env.ORDERGUARD_TOKEN_ENCRYPTION_KEY?.trim();
  const missing = [];

  if (!key) missing.push('TIKTOK_APP_KEY');
  if (!secret) missing.push('TIKTOK_APP_SECRET');
  if (!redirectUri) missing.push('TIKTOK_REDIRECT_URI');
  if (redirectUri) {
    try {
      const callback = new URL(redirectUri);
      if (callback.protocol !== 'https:' || callback.pathname !== '/api/tiktok/callback') {
        missing.push('TIKTOK_REDIRECT_URI (must be the HTTPS callback URL)');
      }
    } catch {
      missing.push('TIKTOK_REDIRECT_URI (invalid URL)');
    }
  }
  if (!encryptionKey) missing.push('ORDERGUARD_TOKEN_ENCRYPTION_KEY');
  if (encryptionKey) {
    try {
      decodeEncryptionKey(encryptionKey);
    } catch {
      missing.push('ORDERGUARD_TOKEN_ENCRYPTION_KEY (invalid format)');
    }
  }

  return { key, secret, redirectUri, encryptionKey, missing };
}

function decodeEncryptionKey(value) {
  if (/^[a-f0-9]{64}$/i.test(value)) return Buffer.from(value, 'hex');
  const key = Buffer.from(value, 'base64');
  if (key.length !== 32) throw new Error('ORDERGUARD_TOKEN_ENCRYPTION_KEY harus berupa 32 byte dalam format hex atau base64.');
  return key;
}

function encryptSecret(value, encryptionKey) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', decodeEncryptionKey(encryptionKey), iv);
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), ciphertext].map((part) => part.toString('base64url')).join('.');
}

function decryptSecret(value, encryptionKey) {
  const [encodedIv, encodedTag, encodedCiphertext] = String(value).split('.');
  if (!encodedIv || !encodedTag || !encodedCiphertext) throw new Error('Token TikTok Shop tersimpan dalam format yang tidak valid.');
  const decipher = crypto.createDecipheriv('aes-256-gcm', decodeEncryptionKey(encryptionKey), Buffer.from(encodedIv, 'base64url'));
  decipher.setAuthTag(Buffer.from(encodedTag, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(encodedCiphertext, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}

function canonicalQuery(params) {
  return Object.entries(params)
    .filter(([key, value]) => key !== 'sign' && key !== 'access_token' && value !== undefined && value !== null)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}${Array.isArray(value) ? value.join(',') : value}`)
    .join('');
}

function signRequest(path, params, body, appSecret) {
  const payload = `${appSecret}${path}${canonicalQuery(params)}${body ? JSON.stringify(body) : ''}${appSecret}`;
  return crypto.createHmac('sha256', appSecret).update(payload).digest('hex');
}

async function requestApi({ path, method = 'GET', params = {}, body, appKey, appSecret, accessToken, shopCipher, fetchImpl = fetch }) {
  const query = {
    app_key: appKey,
    timestamp: Math.floor(Date.now() / 1000),
    ...params,
  };
  if (shopCipher) query.shop_cipher = shopCipher;
  query.sign = signRequest(path, query, body, appSecret);

  const url = new URL(path, API_BASE_URL);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  }
  const response = await fetchImpl(url, {
    method,
    signal: AbortSignal.timeout(15000),
    headers: {
      'content-type': 'application/json',
      ...(accessToken ? { 'x-tts-access-token': accessToken } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const result = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`TikTok Shop API mengembalikan HTTP ${response.status}.`);
  if (!result || result.code !== 0) {
    const message = typeof result?.message === 'string' ? result.message : 'Respons TikTok Shop API tidak valid.';
    throw new Error(`TikTok Shop API gagal: ${message}`);
  }
  return result.data || {};
}

async function exchangeAuthorizationCode({ authCode, config, fetchImpl = fetch }) {
  const path = '/api/v2/token/get';
  return requestApi({
    path,
    method: 'POST',
    body: { auth_code: authCode, grant_type: 'authorized_code' },
    appKey: config.key,
    appSecret: config.secret,
    fetchImpl,
  });
}

async function refreshAccessToken({ refreshToken, config, fetchImpl = fetch }) {
  const path = '/api/v2/token/refresh';
  return requestApi({
    path,
    method: 'POST',
    body: { refresh_token: refreshToken, grant_type: 'refresh_token' },
    appKey: config.key,
    appSecret: config.secret,
    fetchImpl,
  });
}

async function getAuthorizedShops({ accessToken, config, fetchImpl = fetch }) {
  return requestApi({
    path: '/authorization/202309/shops',
    appKey: config.key,
    appSecret: config.secret,
    accessToken,
    fetchImpl,
  });
}

async function searchOrders({ accessToken, shopCipher, config, now = Date.now(), fetchImpl = fetch }) {
  const path = '/order/202309/orders/search';
  const orders = [];
  let pageToken;
  const body = {
    update_time_ge: Math.floor((now - 30 * 24 * 60 * 60 * 1000) / 1000),
    update_time_lt: Math.floor(now / 1000),
  };

  for (let page = 0; page < MAX_ORDER_PAGES; page += 1) {
    const data = await requestApi({
      path,
      method: 'POST',
      params: { page_size: 100, ...(pageToken ? { page_token: pageToken } : {}) },
      body,
      appKey: config.key,
      appSecret: config.secret,
      accessToken,
      shopCipher,
      fetchImpl,
    });
    if (!Array.isArray(data.orders)) throw new Error('Respons daftar pesanan TikTok Shop tidak memuat daftar pesanan yang valid.');
    orders.push(...data.orders);
    if (!data.next_page_token) return orders;
    pageToken = data.next_page_token;
  }

  throw new Error(`Sinkronisasi dibatasi hingga ${MAX_ORDER_PAGES * 100} pesanan. Persempit rentang waktu lalu coba lagi.`);
}

function prepareImportOrders(orders, shopName, date, { existingOrders = [], existingTrackings = [] } = {}) {
  const eligible = [];
  const knownOrders = new Set(existingOrders.map((value) => String(value).trim().toLocaleLowerCase('id-ID')));
  const knownTrackings = new Set(existingTrackings.map((value) => String(value).trim().toLocaleLowerCase('id-ID')));
  const seenOrders = new Set();
  const seenTrackings = new Set();
  let withoutTracking = 0;
  let alreadyImported = 0;
  let duplicateOrders = 0;
  for (const order of orders) {
    const tracking = typeof order.tracking_number === 'string' ? order.tracking_number.trim() : '';
    if (!tracking) {
      withoutTracking += 1;
      continue;
    }
    if (!order.order_id) continue;
    const orderId = String(order.order_id);
    const normalizedOrder = orderId.trim().toLocaleLowerCase('id-ID');
    const normalizedTracking = tracking.toLocaleLowerCase('id-ID');
    if (knownOrders.has(normalizedOrder) || knownTrackings.has(normalizedTracking)) {
      alreadyImported += 1;
      continue;
    }
    if (seenOrders.has(normalizedOrder) || seenTrackings.has(normalizedTracking)) {
      duplicateOrders += 1;
      continue;
    }
    seenOrders.add(normalizedOrder);
    seenTrackings.add(normalizedTracking);
    eligible.push({
      order: orderId,
      tracking,
      courier: String(order.shipping_provider || 'TikTok Shop'),
      shop: shopName,
      date,
    });
  }
  return { orders: eligible, withoutTracking, alreadyImported, duplicateOrders };
}

module.exports = {
  AUTHORIZATION_URL,
  decryptSecret,
  encryptSecret,
  exchangeAuthorizationCode,
  getAuthorizedShops,
  getConfig,
  prepareImportOrders,
  refreshAccessToken,
  searchOrders,
  signRequest,
};
