const express = require('express');
const path = require('node:path');
const crypto = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const { createPool } = require('./database');
const TikTokShop = require('./tiktok-shop');

const app = express();
const port = Number(process.env.PORT || 4173);
const appDir = __dirname;
const db = createPool();
const tiktokTokenRefreshes = new Map();

const INITIAL_TENANTS = [
  { id: 'dfixer-store', name: "D'Fixer Store" },
  { id: 'maya-commerce', name: 'Maya Commerce' },
];
const EMPLOYEE_ROLES = ['super-admin', 'store-admin', 'handover-staff'];
const ROLE_PERMISSIONS = {
  'super-admin': ['dashboard', 'manifests', 'imports', 'incidents', 'reports', 'audit'],
  'store-admin': ['dashboard', 'manifests', 'imports', 'incidents', 'reports', 'audit'],
  'handover-staff': ['dashboard', 'manifests'],
};
async function seedTenants() {
  const insert = db.prepare('INSERT INTO tenants (id, name, created_at, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING');
  const now = new Date().toISOString();
  for (const tenant of INITIAL_TENANTS) await insert.run(tenant.id, tenant.name, now, now);
}

async function getTenant(tenantId) {
  return db.prepare('SELECT id, name, created_at AS createdAt, updated_at AS updatedAt FROM tenants WHERE id = ?').get(tenantId);
}

async function listTenants() {
  return db.prepare(`SELECT tenants.id, tenants.name, tenants.created_at AS createdAt, tenants.updated_at AS updatedAt,
    COUNT(users.id)::INTEGER AS employeeCount FROM tenants LEFT JOIN users ON users.tenant_id = tenants.id
    GROUP BY tenants.id ORDER BY LOWER(tenants.name)`).all();
}

async function recordTenantAudit(actor, tenantId, action) {
  await db.prepare('INSERT INTO tenant_audit (id, actor_id, actor_name, tenant_id, action, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(crypto.randomUUID(), actor.id, actor.name, tenantId, action, new Date().toISOString());
}

function signSessionToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function hashSessionToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function hashOpaqueValue(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { salt, hash };
}

function verifyPassword(password, salt, hash) {
  const candidate = Buffer.from(hashPassword(password, salt).hash, 'hex');
  const expected = Buffer.from(hash, 'hex');
  return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
}

async function seedInitialUsers() {
  const count = (await db.prepare('SELECT COUNT(*)::INTEGER AS count FROM users').get()).count;
  if (count) {
    if (process.env.NODE_ENV === 'production') {
      const legacyDemoAccounts = await db.prepare("SELECT username FROM users WHERE id IN ('admin', 'rani', 'handover', 'maya') AND active = TRUE").all();
      if (legacyDemoAccounts.length) {
        const names = legacyDemoAccounts.map((user) => user.username).join(', ');
        throw new Error(`Database masih memiliki akun demo aktif (${names}). Nonaktifkan atau migrasikan akun tersebut sebelum menjalankan production.`);
      }
    }
    return;
  }
  let initialUsers;
  if (process.env.NODE_ENV === 'test') {
    try {
      initialUsers = JSON.parse(process.env.ORDERGUARD_TEST_USERS || '[]');
    } catch (error) {
      throw new Error('ORDERGUARD_TEST_USERS harus berupa JSON valid.');
    }
  } else {
    const username = String(process.env.ORDERGUARD_BOOTSTRAP_USERNAME || '').trim();
    const password = String(process.env.ORDERGUARD_BOOTSTRAP_PASSWORD || '');
    const name = String(process.env.ORDERGUARD_BOOTSTRAP_NAME || '').trim();
    if (!username || password.length < 12 || !name) {
      throw new Error('Database pengguna kosong. Set ORDERGUARD_BOOTSTRAP_USERNAME, ORDERGUARD_BOOTSTRAP_PASSWORD (minimal 12 karakter), dan ORDERGUARD_BOOTSTRAP_NAME untuk membuat Platform Admin pertama.');
    }
    initialUsers = [{ id: crypto.randomUUID(), username, password, name, role: 'super-admin', tenantId: 'dfixer-store' }];
  }
  if (!Array.isArray(initialUsers) || !initialUsers.length) throw new Error('Tidak ada akun awal untuk database kosong.');

  const now = new Date().toISOString();
  await db.transaction(async (tx) => {
    const insert = tx.prepare('INSERT INTO users (id, username, name, password_salt, password_hash, role, tenant_id, active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, TRUE, ?, ?)');
    for (const user of initialUsers) {
      const credentials = hashPassword(user.password);
      await insert.run(user.id, user.username, user.name, credentials.salt, credentials.hash, user.role, user.tenantId, now, now);
    }
  });
}

async function initializeDatabase() {
  await db.exec(db.schema);
  await seedTenants();
  await seedInitialUsers();
}

function parseCookies(header = '') {
  return header.split(';').map((segment) => segment.trim()).filter(Boolean).reduce((accumulator, segment) => {
    const [name, ...rest] = segment.split('=');
    accumulator[name] = decodeURIComponent(rest.join('='));
    return accumulator;
  }, {});
}

async function getUserFromRequest(req) {
  const cookies = parseCookies(req.headers.cookie || '');
  const token = cookies.orderguard_session;
  if (!token) return null;
  const hashedToken = hashSessionToken(token);
  const session = await db.prepare('SELECT user_id AS userId FROM sessions WHERE token_hash = ? AND expires_at > ?').get(hashedToken, new Date().toISOString());
  if (!session) {
    await db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashedToken);
    return null;
  }
  const user = await db.prepare('SELECT id, username, name, role, tenant_id AS tenantId FROM users WHERE id = ? AND active = TRUE').get(session.userId);
  if (!user) await db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashedToken);
  return user || null;
}

async function revokeUserSessions(userId, exceptToken = '') {
  if (exceptToken) {
    await db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?').run(userId, hashSessionToken(exceptToken));
    return;
  }
  await db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
}

function requireAuth(req, res, next) {
  getUserFromRequest(req).then((user) => {
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    req.user = user;
    next();
  }).catch(next);
}

function requireRole(requiredRoles) {
  return (req, res, next) => {
    const user = req.user;
    if (!user || !requiredRoles.includes(user.role)) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    next();
  };
}

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function tiktokTokenExpiry(value, now = Date.now()) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) throw new Error('Respons otorisasi TikTok Shop tidak memuat waktu kedaluwarsa token yang valid.');
  return numeric > 1000000000 ? numeric * 1000 : now + numeric * 1000;
}

function tiktokConfigStatus() {
  const config = TikTokShop.getConfig();
  return { config, configured: config.missing.length === 0 };
}

async function tiktokConnectionForShop(tenantId, shopId) {
  return db.prepare(`
    SELECT tiktok_shops.shop_id AS shopId, tiktok_shops.shop_cipher AS shopCipher,
      tiktok_shops.name AS shopName, tiktok_shops.region,
      tiktok_connections.id AS connectionId, tiktok_connections.open_id AS openId,
      tiktok_connections.access_token AS accessToken,
      tiktok_connections.refresh_token AS refreshToken,
      tiktok_connections.access_token_expires_at AS accessTokenExpiresAt,
      tiktok_connections.refresh_token_expires_at AS refreshTokenExpiresAt
    FROM tiktok_shops
    JOIN tiktok_connections ON tiktok_connections.id = tiktok_shops.connection_id
    WHERE tiktok_shops.tenant_id = ? AND tiktok_shops.shop_id = ?
  `).get(tenantId, shopId);
}

async function ensureTikTokAccessToken(connection, config) {
  const now = Date.now();
  const accessToken = TikTokShop.decryptSecret(connection.accessToken, config.encryptionKey);
  if (connection.accessTokenExpiresAt > now + 5 * 60 * 1000) return accessToken;
  if (connection.refreshTokenExpiresAt <= now) throw new Error('Otorisasi TikTok Shop kedaluwarsa. Hubungkan ulang toko tersebut.');

  const pendingRefresh = tiktokTokenRefreshes.get(connection.connectionId);
  if (pendingRefresh) return pendingRefresh;

  const refreshPromise = (async () => {
    const refreshToken = TikTokShop.decryptSecret(connection.refreshToken, config.encryptionKey);
    const refreshed = await TikTokShop.refreshAccessToken({ refreshToken, config });
    if (!refreshed.access_token || !refreshed.refresh_token) throw new Error('TikTok Shop tidak mengembalikan token baru yang valid.');
    const updatedAt = new Date().toISOString();
    await db.prepare(`
      UPDATE tiktok_connections SET access_token = ?, refresh_token = ?,
        access_token_expires_at = ?, refresh_token_expires_at = ?, updated_at = ?
      WHERE id = ?
    `).run(
      TikTokShop.encryptSecret(refreshed.access_token, config.encryptionKey),
      TikTokShop.encryptSecret(refreshed.refresh_token, config.encryptionKey),
      tiktokTokenExpiry(refreshed.access_token_expire_in, now),
      tiktokTokenExpiry(refreshed.refresh_token_expire_in, now),
      updatedAt,
      connection.connectionId,
    );
    return refreshed.access_token;
  })();
  tiktokTokenRefreshes.set(connection.connectionId, refreshPromise);
  try {
    return await refreshPromise;
  } finally {
    tiktokTokenRefreshes.delete(connection.connectionId);
  }
}

function baseState(tenantName = "D'Fixer Store") {
  const today = new Date().toISOString().slice(0, 10);
  const previous = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  return {
    manifests: [
      { id: `OG-${today.replaceAll('-', '').slice(2)}-042`, shop: tenantName, courier: 'J&T Express', location: 'Gudang Jakarta Selatan', date: today, status: 'HANDOVER_IN_PROGRESS', createdAt: new Date().toISOString(), createdBy: 'Rani Admin', packages: [
          { order: 'ORD-5821', tracking: 'SPXID028451101', status: 'SCANNED', scannedAt: new Date().toISOString() },
          { order: 'ORD-5822', tracking: 'SPXID028451102', status: 'SCANNED', scannedAt: new Date().toISOString() },
          { order: 'ORD-5823', tracking: 'SPXID028451103', status: 'EXPECTED', scannedAt: null },
          { order: 'ORD-5824', tracking: 'SPXID028451104', status: 'EXPECTED', scannedAt: null },
          { order: 'ORD-5825', tracking: 'SPXID028451105', status: 'EXPECTED', scannedAt: null },
          { order: 'ORD-5826', tracking: 'SPXID028451106', status: 'EXPECTED', scannedAt: null },
        ], scans: [], sessions: [] },
      { id: `OG-${previous.replaceAll('-', '').slice(2)}-039`, shop: tenantName, courier: 'JNE', location: 'Gudang Jakarta Selatan', date: previous, status: 'PARTIALLY_HANDED_OVER', createdAt: new Date(Date.now() - 86400000).toISOString(), createdBy: 'Rani Admin', packages: [
          { order: 'ORD-5790', tracking: 'JNE0008114201', status: 'HANDED_OVER', scannedAt: new Date(Date.now() - 86400000).toISOString(), handedOverAt: new Date(Date.now() - 86400000 + 3600000).toISOString(), handedOverSessionId: `TR-${previous.replaceAll('-', '')}-01` },
          { order: 'ORD-5791', tracking: 'JNE0008114202', status: 'HANDED_OVER', scannedAt: new Date(Date.now() - 86400000).toISOString(), handedOverAt: new Date(Date.now() - 86400000 + 3600000).toISOString(), handedOverSessionId: `TR-${previous.replaceAll('-', '')}-01` },
          { order: 'ORD-5792', tracking: 'JNE0008114203', status: 'EXPECTED', scannedAt: null },
        ], scans: [], sessions: [{ id: `TR-${previous.replaceAll('-', '')}-01`, receiver: 'Budi Santoso', actor: 'Rani Admin', createdAt: new Date(Date.now() - 86400000 + 3600000).toISOString(), note: 'Pengambilan tahap pertama', items: ['JNE0008114201', 'JNE0008114202'], evidence: null }] },
    ],
    incidents: [{ id: 'INC-2601', category: 'Paket di luar manifest', manifestId: `OG-${today.replaceAll('-', '').slice(2)}-042`, tracking: 'SPXID028451199', description: 'Resi terbaca saat proses sortir, belum ditambahkan ke manifest.', reportedBy: 'Rani Admin', createdAt: new Date().toISOString(), status: 'OPEN', resolution: '' }],
    audit: [
      { id: 'AU-1', actor: 'Rani Admin', action: 'Manifest dibuka untuk pemindaian', object: `OG-${today.replaceAll('-', '').slice(2)}-042`, createdAt: new Date().toISOString() },
      { id: 'AU-2', actor: 'Rani Admin', action: 'Serah terima tahap pertama dikonfirmasi', object: `OG-${previous.replaceAll('-', '').slice(2)}-039`, createdAt: new Date(Date.now() - 86400000 + 3600000).toISOString() },
    ],
    importJobs: [],
    orderEvents: [],
  };
}

function normalizeState(payload, tenantName = "D'Fixer Store") {
  const state = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : baseState(tenantName);
  for (const field of ['manifests', 'incidents', 'audit', 'importJobs', 'orderEvents']) {
    if (!Array.isArray(state[field])) state[field] = [];
  }
  return state;
}

async function readState(tenantId) {
  const tenantName = (await getTenant(tenantId))?.name;
  const row = await db.prepare('SELECT payload FROM tenant_state WHERE tenant_id = ?').get(tenantId);
  if (!row) {
    if (tenantId === 'dfixer-store') {
      const legacyRow = await db.prepare("SELECT payload FROM app_state WHERE id = 'state'").get();
      if (legacyRow) {
        try {
          const legacyState = normalizeState(JSON.parse(legacyRow.payload), tenantName);
          await writeState(tenantId, legacyState);
          return legacyState;
        } catch (error) {
          console.warn('State lama tidak dapat dibaca; membuat state tenant baru.', error);
        }
      }
    }
    const initialState = baseState(tenantName);
    await writeState(tenantId, initialState);
    return initialState;
  }

  try {
    return normalizeState(JSON.parse(row.payload), tenantName);
  } catch (error) {
    const initialState = baseState(tenantName);
    await writeState(tenantId, initialState);
    return initialState;
  }
}

async function writeState(tenantId, payload) {
  const state = normalizeState(payload, (await getTenant(tenantId))?.name);
  const issuedAt = new Date().toISOString();
  await db.prepare(
    `INSERT INTO tenant_state (tenant_id, payload, updated_at) VALUES (?, ?, ?) ON CONFLICT(tenant_id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at`
  ).run(tenantId, JSON.stringify(state), issuedAt);
}

async function updateTenantState(tenantId, updater) {
  const tenantName = (await getTenant(tenantId))?.name;
  return db.transaction(async (tx) => {
    const row = await tx.prepare('SELECT payload FROM tenant_state WHERE tenant_id = ? FOR UPDATE').get(tenantId);
    let current;
    if (row) {
      try {
        current = normalizeState(JSON.parse(row.payload), tenantName);
      } catch {
        current = baseState(tenantName);
      }
    } else if (tenantId === 'dfixer-store') {
      const legacyRow = await tx.prepare("SELECT payload FROM app_state WHERE id = 'state'").get();
      try {
        current = legacyRow ? normalizeState(JSON.parse(legacyRow.payload), tenantName) : baseState(tenantName);
      } catch {
        current = baseState(tenantName);
      }
    } else {
      current = baseState(tenantName);
    }
    const result = await updater(current);
    const issuedAt = new Date().toISOString();
    await tx.prepare(
      `INSERT INTO tenant_state (tenant_id, payload, updated_at) VALUES (?, ?, ?) ON CONFLICT(tenant_id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at`
    ).run(tenantId, JSON.stringify(current), issuedAt);
    return result;
  });
}

class OrderEventError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const ORDER_EVENT_TYPES = new Set([
  'CANCELLED_BEFORE_HANDOVER',
  'CANCELLATION_AFTER_HANDOVER',
  'RETURN_IN_TRANSIT',
  'RETURN_RECEIVED',
  'CANCELLATION_REJECTED',
]);

function findPackageByTracking(state, tracking) {
  const wanted = normalizedTracking(tracking);
  for (const manifest of state.manifests) {
    for (const parcel of Array.isArray(manifest.packages) ? manifest.packages : []) {
      if (normalizedTracking(parcel.tracking) === wanted) return { manifest, parcel };
    }
  }
  return null;
}

function hasHandoverHistory(manifest, parcel) {
  return Boolean(parcel.handedOverAt) || parcel.status === 'HANDED_OVER' || (Array.isArray(manifest.sessions) && manifest.sessions.some((session) => Array.isArray(session.items) && session.items.includes(parcel.tracking)));
}

function applyOrderEvent(user, state, input) {
  const { manifest, parcel } = findPackageByTracking(state, input.tracking) || {};
  if (!manifest || !parcel) throw new OrderEventError(404, `Resi ${input.tracking} tidak ditemukan pada manifest tenant ini.`);
  if (user.role === 'handover-staff' && input.type !== 'RETURN_RECEIVED') throw new OrderEventError(403, 'Handover Staff hanya dapat mencatat retur diterima.');

  const recordedAt = new Date().toISOString();
  const occurredAt = validTimestamp(input.occurredAt) ? new Date(input.occurredAt).toISOString() : recordedAt;
  const previousStatus = parcel.status;
  let newStatus;

  switch (input.type) {
    case 'CANCELLED_BEFORE_HANDOVER':
      if (!['EXPECTED', 'SCANNED'].includes(parcel.status)) throw new OrderEventError(409, 'Paket sudah diserahkan; gunakan pembatalan setelah pickup.');
      if (!input.reason) throw new OrderEventError(400, 'Alasan pembatalan wajib diisi.');
      newStatus = 'CANCELLED_BEFORE_HANDOVER';
      break;
    case 'CANCELLATION_AFTER_HANDOVER':
      if (!hasHandoverHistory(manifest, parcel) || ['CANCELLATION_AFTER_HANDOVER', 'RETURN_IN_TRANSIT', 'RETURN_RECEIVED'].includes(parcel.status)) throw new OrderEventError(409, 'Paket tidak berada pada status yang dapat dibatalkan setelah pickup.');
      if (!input.reason) throw new OrderEventError(400, 'Alasan pembatalan wajib diisi.');
      newStatus = 'CANCELLATION_AFTER_HANDOVER';
      break;
    case 'RETURN_IN_TRANSIT':
      if (parcel.status !== 'CANCELLATION_AFTER_HANDOVER') throw new OrderEventError(409, 'Retur hanya dapat diajukan untuk paket yang dibatalkan setelah pickup.');
      newStatus = 'RETURN_IN_TRANSIT';
      break;
    case 'RETURN_RECEIVED':
      if (parcel.status !== 'RETURN_IN_TRANSIT') throw new OrderEventError(409, 'Retur hanya dapat diterima untuk paket yang sedang dalam perjalanan retur.');
      if (!input.evidence || !/^data:image\/(jpeg|png|webp);base64,/.test(input.evidence) || input.evidence.length > 2500000) throw new OrderEventError(400, 'Foto bukti retur diterima wajib diunggah.');
      newStatus = 'RETURN_RECEIVED';
      break;
    case 'CANCELLATION_REJECTED': {
      if (parcel.status !== 'CANCELLATION_AFTER_HANDOVER') throw new OrderEventError(409, 'Pembatalan hanya dapat ditolak saat paket berstatus dibatalkan setelah pickup.');
      const cancellation = state.orderEvents.find((event) => event.type === 'CANCELLATION_AFTER_HANDOVER' && normalizedTracking(event.tracking) === normalizedTracking(parcel.tracking));
      if (!cancellation) throw new OrderEventError(409, 'Riwayat pembatalan paket tidak ditemukan.');
      newStatus = ['HANDED_OVER', 'SCANNED', 'EXPECTED'].includes(cancellation.previousStatus) ? cancellation.previousStatus : 'HANDED_OVER';
      break;
    }
    default:
      throw new OrderEventError(400, 'Jenis kejadian tidak valid.');
  }

  const event = {
    id: `EVT-${crypto.randomUUID()}`,
    manifestId: manifest.id,
    order: parcel.order,
    tracking: parcel.tracking,
    type: input.type,
    reason: input.reason || '',
    note: input.note || '',
    source: 'manual',
    previousStatus,
    newStatus,
    occurredAt,
    recordedAt,
    recordedBy: user.name,
    recordedById: user.id,
    evidence: input.type === 'RETURN_RECEIVED' ? input.evidence : null,
  };
  state.orderEvents.unshift(event);
  state.orderEvents = state.orderEvents.slice(0, 5000);
  parcel.status = newStatus;
  if (input.type === 'RETURN_RECEIVED') {
    parcel.returnReceivedAt = recordedAt;
    parcel.returnReceivedBy = user.name;
  }
  const auditActions = {
    CANCELLED_BEFORE_HANDOVER: `Pembatalan pembeli dicatat: ${parcel.tracking}`,
    CANCELLATION_AFTER_HANDOVER: `Pembatalan pembeli setelah pickup: ${parcel.tracking}`,
    RETURN_IN_TRANSIT: `Retur dalam perjalanan: ${parcel.tracking}`,
    RETURN_RECEIVED: `Retur diterima: ${parcel.tracking}`,
    CANCELLATION_REJECTED: `Pembatalan ditolak marketplace: ${parcel.tracking}`,
  };
  state.audit.unshift({ id: `AU-${crypto.randomUUID()}`, actor: user.name, action: auditActions[input.type], object: manifest.id, createdAt: recordedAt });
  state.audit = state.audit.slice(0, 5000);
  return { ok: true, event, manifestId: manifest.id, order: parcel.order, tracking: parcel.tracking, status: parcel.status };
}

async function publicUser(user) {
  return {
    id: user.id,
    username: user.username,
    name: user.name,
    role: user.role,
    tenantId: user.tenantId || user.tenant_id,
    tenantName: (await getTenant(user.tenantId || user.tenant_id))?.name,
    active: user.active === undefined ? true : Boolean(user.active),
    createdAt: user.createdAt || user.created_at,
    updatedAt: user.updatedAt || user.updated_at,
  };
}

function prefixedEntries(previous, next) {
  if (!Array.isArray(previous) || !Array.isArray(next) || next.length < previous.length) return null;
  const addedCount = next.length - previous.length;
  return isDeepStrictEqual(next.slice(addedCount), previous) ? next.slice(0, addedCount) : null;
}

function appendedEntries(previous, next) {
  if (!Array.isArray(previous) || !Array.isArray(next) || next.length < previous.length) return null;
  return isDeepStrictEqual(next.slice(0, previous.length), previous) ? next.slice(previous.length) : null;
}

function auditEntries(previous, next) {
  const added = prefixedEntries(previous, next);
  if (added) return added;
  if (previous.length === 5000 && next.length === 5000 && isDeepStrictEqual(next.slice(1), previous.slice(0, -1))) return [next[0]];
  return null;
}

function validTimestamp(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function normalizedTracking(value) {
  return String(value || '').trim().toLocaleLowerCase('id-ID');
}

function validateNewManifestTracking(previousManifests, addedManifests) {
  const known = new Map();
  for (const manifest of previousManifests) {
    for (const parcel of Array.isArray(manifest.packages) ? manifest.packages : []) {
      const tracking = normalizedTracking(parcel.tracking);
      if (tracking) known.set(tracking, manifest.id);
    }
  }
  for (const manifest of addedManifests) {
    for (const parcel of Array.isArray(manifest.packages) ? manifest.packages : []) {
      const tracking = normalizedTracking(parcel.tracking);
      if (!tracking) continue;
      if (known.has(tracking)) return `Resi ${parcel.tracking} sudah tercatat pada manifest ${known.get(tracking)}.`;
      known.set(tracking, manifest.id);
    }
  }
  return null;
}

function validateAuditAppend(user, previous, next) {
  const added = auditEntries(previous, next);
  if (!added) return 'Riwayat audit lama tidak boleh diubah atau dihapus.';
  for (const entry of added) {
    if (entry.actor !== user.name || typeof entry.action !== 'string' || typeof entry.object !== 'string' || !validTimestamp(entry.createdAt)) {
      return 'Audit hanya boleh ditambahkan oleh pengguna yang sedang login.';
    }
  }
  return null;
}

function validateStoreAdminWorkflowUpdate(user, previous, next, addedAudit) {
  const workflowError = validateHandoverUpdate(user, previous, next);
  if (!workflowError) return null;

  if (next.manifests.length !== previous.manifests.length) return workflowError;
  const changed = previous.manifests.map((manifest, index) => ({ previous: manifest, next: next.manifests[index] })).filter(({ previous: oldManifest, next: newManifest }) => !isDeepStrictEqual(oldManifest, newManifest));
  if (changed.length !== 1 || !isDeepStrictEqual(previous.incidents, next.incidents) || addedAudit.length !== 1) return workflowError;
  const { previous: oldManifest, next: newManifest } = changed[0];
  if (oldManifest.id !== newManifest.id) return workflowError;
  if (newManifest.status === 'CLOSED' && oldManifest.status !== 'CLOSED') {
    const counts = oldManifest.packages.filter((parcel) => ['EXPECTED', 'SCANNED', 'REJECTED', 'EXCEPTION', 'CANCELLATION_AFTER_HANDOVER', 'RETURN_IN_TRANSIT'].includes(parcel.status)).length;
    if (counts || previous.incidents.some((incident) => incident.manifestId === oldManifest.id && incident.status === 'OPEN') || !isDeepStrictEqual(oldManifest.packages, newManifest.packages) || addedAudit[0].object !== oldManifest.id || addedAudit[0].action !== 'Manifest ditutup') return 'Penutupan manifest tidak memenuhi syarat rekonsiliasi.';
    const oldFields = Object.fromEntries(Object.entries(oldManifest).filter(([key]) => key !== 'status'));
    const newFields = Object.fromEntries(Object.entries(newManifest).filter(([key]) => key !== 'status'));
    return isDeepStrictEqual(oldFields, newFields) ? null : workflowError;
  }
  if (newManifest.status === 'CANCELLED' && oldManifest.status !== 'CANCELLED') {
    if (oldManifest.packages.some((parcel) => parcel.status === 'HANDED_OVER' || parcel.handedOverAt || ['CANCELLATION_AFTER_HANDOVER', 'RETURN_IN_TRANSIT', 'RETURN_RECEIVED'].includes(parcel.status)) || addedAudit[0].object !== oldManifest.id || addedAudit[0].action !== 'Manifest dibatalkan') return 'Manifest yang memiliki penerimaan tidak dapat dibatalkan.';
    const oldFields = Object.fromEntries(Object.entries(oldManifest).filter(([key]) => !['status', 'packages'].includes(key)));
    const newFields = Object.fromEntries(Object.entries(newManifest).filter(([key]) => !['status', 'packages'].includes(key)));
    const packagesValid = oldManifest.packages.length === newManifest.packages.length && oldManifest.packages.every((parcel, index) => {
      const updated = newManifest.packages[index];
      if (parcel.status === 'HANDED_OVER') return isDeepStrictEqual(parcel, updated);
      return updated.status === 'CANCELLED' && isDeepStrictEqual(Object.fromEntries(Object.entries(parcel).filter(([key]) => key !== 'status')), Object.fromEntries(Object.entries(updated).filter(([key]) => key !== 'status')));
    });
    return packagesValid && isDeepStrictEqual(oldFields, newFields) ? null : workflowError;
  }
  return workflowError;
}

function validateStoreAdminUpdate(user, previous, next) {
  if (!next || typeof next !== 'object' || Array.isArray(next)) return 'Payload state tidak valid.';
  const allowedFields = ['manifests', 'incidents', 'audit', 'importJobs', 'orderEvents'];
  for (const field of new Set([...Object.keys(previous), ...Object.keys(next)])) {
    if (!allowedFields.includes(field) && !isDeepStrictEqual(previous[field], next[field])) return 'Field state tidak dikenal atau tidak dapat diubah.';
  }
  for (const field of allowedFields) {
    if (!Array.isArray(previous[field]) || !Array.isArray(next[field])) return `Data ${field} tidak valid.`;
  }
  if (!isDeepStrictEqual(previous.orderEvents, next.orderEvents)) return 'Pembatalan dan retur harus dicatat melalui endpoint order event.';
  const auditError = validateAuditAppend(user, previous.audit, next.audit);
  if (auditError) return auditError;
  const addedAudit = auditEntries(previous.audit, next.audit);
  const addedManifests = prefixedEntries(previous.manifests, next.manifests);
  const addedJobs = prefixedEntries(previous.importJobs, next.importJobs);
  if (!addedJobs) return 'Manifest, riwayat impor, dan audit lama tidak boleh dihapus atau disusun ulang.';
  const addedIncidents = prefixedEntries(previous.incidents, next.incidents);

  if (addedManifests === null) {
    if (!isDeepStrictEqual(previous.importJobs, next.importJobs)) return 'Riwayat impor lama tidak boleh diubah atau dihapus.';
    return validateStoreAdminWorkflowUpdate(user, previous, next, addedAudit);
  }

  if (addedManifests.length) {
    if (!addedIncidents || addedIncidents.length) return 'Pembuatan manifest tidak boleh mengubah insiden lama.';
    if (next.manifests.length - addedManifests.length !== previous.manifests.length || !isDeepStrictEqual(next.manifests.slice(addedManifests.length), previous.manifests)) return 'Manifest lama tidak boleh diubah saat membuat manifest baru.';
    const trackingError = validateNewManifestTracking(previous.manifests, addedManifests);
    if (trackingError) return trackingError;
    const packageCount = addedManifests.reduce((total, manifest) => total + (Array.isArray(manifest.packages) ? manifest.packages.length : 0), 0);
    if (!addedManifests.every((manifest) => manifest.createdBy === user.name && manifest.status === 'OPEN' && manifest.shop && manifest.courier && validTimestamp(manifest.createdAt) && Array.isArray(manifest.packages) && manifest.packages.length > 0 && Array.isArray(manifest.scans) && manifest.scans.length === 0 && Array.isArray(manifest.sessions) && manifest.sessions.length === 0 && manifest.packages.every((parcel) => parcel.order && parcel.tracking && parcel.status === 'EXPECTED' && parcel.scannedAt === null))) {
      return 'Manifest baru tidak memenuhi aturan pembuatan.';
    }
    if (addedJobs.length === 0) {
      if (addedManifests.length !== 1 || addedManifests[0].source !== 'manual' || addedAudit.length !== 1 || addedAudit[0].object !== addedManifests[0].id || addedAudit[0].action !== `Manifest dibuat manual dengan ${packageCount} paket`) return 'Pembuatan manifest manual tidak cocok dengan catatan audit.';
    } else {
      const job = addedJobs[0];
      if (addedJobs.length !== 1 || addedManifests.some((manifest) => manifest.source !== job.fileName) || job.valid !== packageCount || job.manifestCount !== addedManifests.length || job.valid + job.failed !== job.total || !validTimestamp(job.createdAt) || addedAudit.length !== 1 || addedAudit[0].object !== job.id || addedAudit[0].action !== `Impor ${job.fileName}: ${job.valid} valid, ${job.failed} ditolak`) return 'Manifest impor tidak cocok dengan riwayat impor dan audit.';
    }
    return null;
  }

  if (addedJobs.length) return 'Riwayat impor hanya dapat ditambahkan bersama manifest baru.';

  if (!addedIncidents) {
    if (next.incidents.length !== previous.incidents.length) return 'Insiden lama tidak boleh dihapus atau disusun ulang.';
    const changedIncidents = previous.incidents.map((incident, index) => ({ previous: incident, next: next.incidents[index] })).filter(({ previous: oldIncident, next: newIncident }) => !isDeepStrictEqual(oldIncident, newIncident));
    if (changedIncidents.length !== 1) return 'Hanya satu insiden terbuka yang dapat diselesaikan per perubahan.';
    const { previous: oldIncident, next: newIncident } = changedIncidents[0];
    const oldFields = Object.fromEntries(Object.entries(oldIncident).filter(([key]) => !['status', 'resolution', 'resolvedAt', 'resolvedBy'].includes(key)));
    const newFields = Object.fromEntries(Object.entries(newIncident).filter(([key]) => !['status', 'resolution', 'resolvedAt', 'resolvedBy'].includes(key)));
    if (oldIncident.status !== 'OPEN' || newIncident.status !== 'RESOLVED' || !newIncident.resolution || newIncident.resolvedBy !== user.name || !validTimestamp(newIncident.resolvedAt) || !isDeepStrictEqual(oldFields, newFields) || addedAudit.length !== 1 || addedAudit[0].object !== oldIncident.id || addedAudit[0].action !== `Insiden diselesaikan: ${oldIncident.category} — ${newIncident.resolution}`) return 'Penyelesaian insiden tidak valid atau tidak cocok dengan audit.';
    return null;
  }

  if (addedIncidents.length) {
    if (addedIncidents.length !== 1 || !isDeepStrictEqual(previous.manifests, next.manifests)) return 'Pencatatan insiden tidak boleh mengubah manifest.';
    const incident = addedIncidents[0];
    if (!incident.id || !incident.category || !incident.description || incident.reportedBy !== user.name || incident.status !== 'OPEN' || !validTimestamp(incident.createdAt) || (incident.manifestId && !previous.manifests.some((manifest) => manifest.id === incident.manifestId)) || addedAudit.length !== 1 || addedAudit[0].object !== incident.id || addedAudit[0].action !== `Insiden dicatat: ${incident.category}`) return 'Insiden baru tidak valid atau tidak cocok dengan audit.';
    return null;
  }

  if (!isDeepStrictEqual(previous.manifests, next.manifests)) {
    return validateStoreAdminWorkflowUpdate(user, previous, next, addedAudit);
  }

  if (addedAudit.length === 1 && addedAudit[0].action === 'Laporan rekonsiliasi diekspor' && addedAudit[0].object === 'CSV') return null;
  if (addedAudit.length === 0 || addedAudit.every((entry) => entry.action === 'Laporan rekonsiliasi diekspor' && entry.object === 'CSV')) return null;
  return 'Perubahan state tidak cocok dengan tindakan Store Admin yang diizinkan.';
}

function validateHandoverUpdate(user, previous, next) {
  if (!next || typeof next !== 'object' || Array.isArray(next)) return 'Payload state tidak valid.';
  for (const field of new Set([...Object.keys(previous), ...Object.keys(next)])) {
    if (['manifests', 'incidents', 'audit', 'importJobs', 'orderEvents'].includes(field)) continue;
    if (!isDeepStrictEqual(previous[field], next[field])) return 'Handover Staff tidak diizinkan mengubah data administratif.';
  }
  if (!Array.isArray(previous.manifests) || !Array.isArray(next.manifests) || previous.manifests.length !== next.manifests.length) {
    return 'Handover Staff tidak dapat menambah atau menghapus manifest.';
  }
  if (!isDeepStrictEqual(previous.importJobs, next.importJobs)) return 'Handover Staff tidak dapat mengubah data impor.';
  if (!isDeepStrictEqual(previous.orderEvents, next.orderEvents)) return 'Pembatalan dan retur harus dicatat melalui endpoint order event.';
  if (!Array.isArray(previous.incidents) || !Array.isArray(next.incidents)) return 'Data insiden tidak valid.';
  if (!Array.isArray(previous.audit) || !Array.isArray(next.audit)) return 'Data audit tidak valid.';

  const auditError = validateAuditAppend(user, previous.audit, next.audit);
  if (auditError) return auditError;
  const addedAudit = auditEntries(previous.audit, next.audit);
  const addedIncidents = prefixedEntries(previous.incidents, next.incidents);
  if (!addedIncidents) return 'Insiden lama tidak boleh diubah atau dihapus.';
  const knownAuditActions = [
    /^Paket dipindai: .+$/,
    /^Pemindaian di luar manifest: .+$/,
    /^Serah terima TR-[A-Z0-9-]+ dikonfirmasi: .+$/,
  ];
  for (const entry of addedAudit) {
    if (entry.actor !== user.name || !validTimestamp(entry.createdAt) || !knownAuditActions.some((pattern) => pattern.test(entry.action)) || !previous.manifests.some((manifest) => manifest.id === entry.object)) {
      return 'Catatan audit baru tidak valid untuk peran Handover Staff.';
    }
  }

  const expectedIncidents = [];
  for (let index = 0; index < previous.manifests.length; index += 1) {
    const oldManifest = previous.manifests[index];
    const newManifest = next.manifests[index];
    if (!newManifest || oldManifest.id !== newManifest.id) return 'Handover Staff tidak dapat mengganti manifest.';
    const protectedManifest = (manifest) => Object.fromEntries(Object.entries(manifest).filter(([key]) => !['status', 'packages', 'scans', 'sessions'].includes(key)));
    if (!isDeepStrictEqual(protectedManifest(oldManifest), protectedManifest(newManifest))) return 'Informasi administratif manifest tidak boleh diubah.';
    if (!Array.isArray(oldManifest.packages) || !Array.isArray(newManifest.packages) || oldManifest.packages.length !== newManifest.packages.length) return 'Daftar paket manifest tidak boleh diubah.';
    if (!Array.isArray(oldManifest.scans) || !Array.isArray(newManifest.scans) || !Array.isArray(oldManifest.sessions) || !Array.isArray(newManifest.sessions)) return 'Riwayat pemindaian atau serah terima tidak valid.';

    const newScans = appendedEntries(oldManifest.scans, newManifest.scans);
    const newSessions = appendedEntries(oldManifest.sessions, newManifest.sessions);
    if (!newScans || !newSessions) return 'Riwayat pemindaian dan serah terima hanya boleh ditambahkan.';
    const newlyHandedOver = new Set();
    const newlyRejected = new Set();
    const newlyScanned = new Set();

    for (let packageIndex = 0; packageIndex < oldManifest.packages.length; packageIndex += 1) {
      const oldPackage = oldManifest.packages[packageIndex];
      const newPackage = newManifest.packages[packageIndex];
      if (!newPackage || oldPackage.order !== newPackage.order || oldPackage.tracking !== newPackage.tracking) return 'Identitas paket manifest tidak boleh diubah.';
      const protectedPackage = (parcel) => Object.fromEntries(Object.entries(parcel).filter(([key]) => !['status', 'scannedAt', 'handedOverAt', 'handedOverSessionId'].includes(key)));
      if (!isDeepStrictEqual(protectedPackage(oldPackage), protectedPackage(newPackage))) return 'Data paket administratif tidak boleh diubah.';

      if (oldPackage.status === newPackage.status) {
        if (oldPackage.scannedAt !== newPackage.scannedAt) return 'Waktu pemindaian tidak boleh diubah.';
        if (oldPackage.handedOverAt !== newPackage.handedOverAt || oldPackage.handedOverSessionId !== newPackage.handedOverSessionId) return 'Riwayat serah terima tidak boleh diubah.';
      } else if (oldPackage.status === 'EXPECTED' && newPackage.status === 'SCANNED') {
        if (!validTimestamp(newPackage.scannedAt)) return 'Waktu pemindaian tidak valid.';
        newlyScanned.add(newPackage.tracking);
      } else if (oldPackage.status === 'SCANNED' && ['HANDED_OVER', 'REJECTED'].includes(newPackage.status)) {
        if (oldPackage.scannedAt !== newPackage.scannedAt) return 'Waktu pemindaian tidak boleh diubah.';
        if (newPackage.status === 'HANDED_OVER' && (newPackage.handedOverAt !== undefined && !validTimestamp(newPackage.handedOverAt))) return 'Waktu serah terima tidak valid.';
        if (newPackage.status === 'HANDED_OVER' && newPackage.handedOverSessionId !== undefined && typeof newPackage.handedOverSessionId !== 'string') return 'Sesi serah terima tidak valid.';
        (newPackage.status === 'HANDED_OVER' ? newlyHandedOver : newlyRejected).add(newPackage.tracking);
      } else {
        return 'Transisi status paket tidak diizinkan untuk Handover Staff.';
      }
    }

    if (oldManifest.status !== newManifest.status) {
      const permittedStatuses = ['OPEN', 'HANDOVER_IN_PROGRESS', 'RECONCILIATION_REQUIRED', 'PARTIALLY_HANDED_OVER', 'READY_FOR_CONFIRMATION', 'CONFIRMED'];
      if (!permittedStatuses.includes(oldManifest.status) || !permittedStatuses.includes(newManifest.status) || ['CLOSED', 'CANCELLED', 'CONFIRMED'].includes(oldManifest.status)) return 'Handover Staff tidak dapat menutup, membatalkan, atau mengubah manifest final.';
      if (!newSessions.length) return 'Perubahan status manifest harus berasal dari sesi serah terima.';
      const hasOutstanding = newManifest.packages.some((parcel) => ['EXPECTED', 'SCANNED', 'REJECTED', 'EXCEPTION', 'CANCELLATION_AFTER_HANDOVER', 'RETURN_IN_TRANSIT'].includes(parcel.status));
      if (newManifest.status !== (hasOutstanding ? 'PARTIALLY_HANDED_OVER' : 'CONFIRMED')) return 'Status manifest tidak sesuai dengan hasil serah terima.';
    }

    const handedOverInSessions = new Set();
    for (const session of newSessions) {
      if (session.actor !== user.name || !session.receiver || !validTimestamp(session.createdAt) || !Array.isArray(session.items) || !session.items.length) return 'Sesi serah terima tidak valid.';
      const sessionItems = new Set();
      for (const tracking of session.items) {
        if (!newlyHandedOver.has(tracking) || handedOverInSessions.has(tracking) || sessionItems.has(tracking)) return 'Sesi hanya boleh berisi paket yang baru dikonfirmasi.';
        sessionItems.add(tracking);
        handedOverInSessions.add(tracking);
      }
    }
    if (handedOverInSessions.size !== newlyHandedOver.size) return 'Setiap paket yang diterima harus tercatat dalam sesi serah terima.';

    for (const scan of newScans) {
      if (scan.actor !== user.name || !validTimestamp(scan.createdAt) || !['MATCH', 'DUPLICATE_SCAN', 'NOT_IN_MANIFEST', 'ALREADY_HANDED_OVER', 'INVALID_PACKAGE', 'CANCELLED', 'CANCELLED_BY_BUYER', 'RETURN_IN_TRANSIT', 'RETURN_RECEIVED'].includes(scan.result)) {
        return 'Catatan pemindaian baru tidak valid.';
      }
      const packageBefore = oldManifest.packages.find((parcel) => parcel.tracking === scan.tracking);
      const packageAfter = newManifest.packages.find((parcel) => parcel.tracking === scan.tracking);
      const handedOverElsewhere = previous.manifests.some((manifest) => manifest.packages.some((parcel) => parcel.tracking === scan.tracking && parcel.status === 'HANDED_OVER'));
      if (scan.result === 'MATCH' && !newlyScanned.has(scan.tracking)) return 'Hasil scan cocok harus memperbarui paket yang direncanakan.';
      if (scan.result === 'DUPLICATE_SCAN' && !['SCANNED', 'HANDED_OVER'].includes(packageAfter?.status)) return 'Hasil scan duplikat tidak cocok dengan status paket.';
      if (scan.result === 'NOT_IN_MANIFEST' && (packageBefore || handedOverElsewhere)) return 'Hasil scan di luar manifest tidak sesuai dengan data paket.';
      if (scan.result === 'ALREADY_HANDED_OVER' && !handedOverElsewhere && packageBefore?.status !== 'HANDED_OVER') return 'Hasil scan sudah diserahkan tidak sesuai dengan data paket.';
      if (scan.result === 'INVALID_PACKAGE' && packageBefore?.status !== 'REJECTED') return 'Hasil scan tidak valid tidak sesuai dengan data paket.';
      if (scan.result === 'CANCELLED' && !['CANCELLED', 'CANCELLED_BEFORE_HANDOVER'].includes(packageBefore?.status)) return 'Hasil scan dibatalkan tidak sesuai dengan data paket.';
      if (scan.result === 'CANCELLED_BY_BUYER' && !['CANCELLED_BEFORE_HANDOVER', 'CANCELLATION_AFTER_HANDOVER'].includes(packageBefore?.status)) return 'Hasil scan dibatalkan pembeli tidak sesuai dengan data paket.';
      if (scan.result === 'RETURN_IN_TRANSIT' && packageBefore?.status !== 'RETURN_IN_TRANSIT') return 'Hasil scan retur tidak sesuai dengan data paket.';
      if (scan.result === 'RETURN_RECEIVED' && packageBefore?.status !== 'RETURN_RECEIVED') return 'Hasil scan retur diterima tidak sesuai dengan data paket.';
    }
    for (const incident of addedIncidents) {
      if (incident.manifestId !== oldManifest.id) continue;
      if (incident.category !== 'Paket ditolak kurir' || incident.reportedBy !== user.name || incident.status !== 'OPEN' || !newlyRejected.has(incident.tracking) || !validTimestamp(incident.createdAt) || typeof incident.description !== 'string') {
        return 'Handover Staff hanya dapat mencatat insiden penolakan paket dari sesi serah terima.';
      }
      expectedIncidents.push(incident);
    }

    for (const audit of addedAudit) {
      if (audit.object !== oldManifest.id) continue;
      if (audit.action.startsWith('Paket dipindai: ') && !newScans.some((scan) => scan.result === 'MATCH' && audit.action === `Paket dipindai: ${scan.tracking}`)) return 'Audit pemindaian tidak sesuai dengan catatan scan.';
      if (audit.action.startsWith('Pemindaian di luar manifest: ') && !newScans.some((scan) => scan.result === 'NOT_IN_MANIFEST' && audit.action === `Pemindaian di luar manifest: ${scan.tracking}`)) return 'Audit pemindaian tidak sesuai dengan catatan scan.';
      if (audit.action.startsWith('Serah terima ') && !newSessions.some((session) => audit.action.startsWith(`Serah terima ${session.id} dikonfirmasi:`))) return 'Audit serah terima tidak sesuai dengan sesi baru.';
    }

    for (const tracking of newlyRejected) {
      const incident = expectedIncidents.find((entry) => entry.manifestId === oldManifest.id && entry.tracking === tracking);
      if (!incident || !newSessions.some((session) => incident.description.includes(session.id))) return 'Paket yang ditolak harus memiliki insiden dan sesi serah terima.';
    }
  }

  if (addedIncidents.length !== expectedIncidents.length) return 'Insiden baru tidak cocok dengan paket yang ditolak.';
  return null;
}

app.use(express.json({ limit: '10mb' }));

app.get('/api/health', asyncRoute(async (req, res) => {
  await db.prepare('SELECT 1').get();
  res.json({ status: 'ok', database: 'ok', time: new Date().toISOString() });
}));

app.get('/api/config', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ environment: process.env.NODE_ENV === 'production' ? 'production' : 'sandbox' });
});

app.get('/api/session', (req, res) => {
  getUserFromRequest(req)
    .then((user) => user ? publicUser(user) : null)
    .then((user) => res.json({ user }))
    .catch((error) => res.status(500).json({ error: error.message }));
});

app.post('/api/tenants', requireAuth, requireRole(['super-admin']), asyncRoute(async (req, res) => {
  const id = String(req.body?.id || '').trim();
  const name = String(req.body?.name || '').trim();
  if (!/^[a-z0-9](?:[a-z0-9-]{0,48}[a-z0-9])$/.test(id)) {
    return res.status(400).json({ error: 'ID tenant harus 2-50 karakter, huruf kecil, angka, dan tanda hubung; tidak boleh diawali atau diakhiri tanda hubung.' });
  }
  if (name.length < 2 || name.length > 100) return res.status(400).json({ error: 'Nama tenant harus 2-100 karakter.' });

  const now = new Date().toISOString();
  try {
    await db.prepare('INSERT INTO tenants (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)').run(id, name, now, now);
  } catch (error) {
    if (error.code === '23505') {
      if (error.constraint?.includes('pkey')) return res.status(409).json({ error: 'ID tenant sudah digunakan.' });
      return res.status(409).json({ error: 'Nama tenant sudah digunakan.' });
    }
    throw error;
  }
  await recordTenantAudit(req.user, id, 'Tenant dibuat');
  res.status(201).json({ tenant: await getTenant(id) });
}));

app.patch('/api/tenants/:id', requireAuth, requireRole(['super-admin']), asyncRoute(async (req, res) => {
  const tenant = await getTenant(req.params.id);
  if (!tenant) return res.status(404).json({ error: 'Tenant tidak ditemukan.' });
  const name = String(req.body?.name || '').trim();
  if (name.length < 2 || name.length > 100) return res.status(400).json({ error: 'Nama tenant harus 2-100 karakter.' });

  const now = new Date().toISOString();
  try {
    await db.prepare('UPDATE tenants SET name = ?, updated_at = ? WHERE id = ?').run(name, now, tenant.id);
  } catch (error) {
    if (error.code === '23505') return res.status(409).json({ error: 'Nama tenant sudah digunakan.' });
    throw error;
  }
  await recordTenantAudit(req.user, tenant.id, 'Nama tenant diperbarui');
  res.json({ tenant: await getTenant(tenant.id) });
}));

app.get('/api/users', requireAuth, requireRole(['super-admin']), asyncRoute(async (req, res) => {
  const users = await Promise.all((await db.prepare('SELECT id, username, name, role, tenant_id AS tenantId, active, created_at AS createdAt, updated_at AS updatedAt FROM users ORDER BY tenant_id, LOWER(name)').all()).map(publicUser));
  const [activity, tenantActivity, tenants] = await Promise.all([
    db.prepare('SELECT actor_name AS actorName, target_user_id AS targetUserId, action, created_at AS createdAt FROM employee_audit ORDER BY created_at DESC LIMIT 100').all(),
    db.prepare('SELECT actor_name AS actorName, tenant_id AS tenantId, action, created_at AS createdAt FROM tenant_audit ORDER BY created_at DESC LIMIT 100').all(),
    listTenants(),
  ]);
  res.json({ users, tenants, activity, tenantActivity });
}));

app.post('/api/users', requireAuth, requireRole(['super-admin']), asyncRoute(async (req, res) => {
  const body = req.body || {};
  const username = String(body.username || '').trim();
  const name = String(body.name || '').trim();
  const password = String(body.password || '');
  const role = String(body.role || '');
  const tenantId = String(body.tenantId || '');

  if (!/^[a-zA-Z0-9._-]{3,32}$/.test(username)) return res.status(400).json({ error: 'Username harus 3-32 karakter dan hanya berisi huruf, angka, titik, garis bawah, atau tanda hubung.' });
  if (!name || name.length > 100) return res.status(400).json({ error: 'Nama wajib diisi dan maksimal 100 karakter.' });
  if (password.length < 8) return res.status(400).json({ error: 'Kata sandi minimal 8 karakter.' });
  if (!EMPLOYEE_ROLES.includes(role)) return res.status(400).json({ error: 'Peran tidak valid.' });
  if (!(await getTenant(tenantId))) return res.status(400).json({ error: 'Tenant tidak valid.' });

  const now = new Date().toISOString();
  const credentials = hashPassword(password);
  const id = crypto.randomUUID();
  try {
    await db.prepare('INSERT INTO users (id, username, name, password_salt, password_hash, role, tenant_id, active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, TRUE, ?, ?)')
      .run(id, username, name, credentials.salt, credentials.hash, role, tenantId, now, now);
  } catch (error) {
    if (error.code === '23505') return res.status(409).json({ error: 'Username sudah digunakan.' });
    throw error;
  }
  await db.prepare('INSERT INTO employee_audit (id, actor_id, actor_name, target_user_id, action, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(crypto.randomUUID(), req.user.id, req.user.name, id, 'Karyawan ditambahkan', now);
  const created = await db.prepare('SELECT id, username, name, role, tenant_id AS tenantId, active, created_at AS createdAt, updated_at AS updatedAt FROM users WHERE id = ?').get(id);
  res.status(201).json({ user: await publicUser(created) });
}));

app.patch('/api/users/:id', requireAuth, requireRole(['super-admin']), asyncRoute(async (req, res) => {
  const existing = await db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Karyawan tidak ditemukan.' });

  const body = req.body || {};
  const username = body.username === undefined ? existing.username : String(body.username).trim();
  const name = body.name === undefined ? existing.name : String(body.name).trim();
  const role = body.role === undefined ? existing.role : String(body.role);
  const tenantId = body.tenantId === undefined ? existing.tenant_id : String(body.tenantId);
  const active = body.active === undefined ? Boolean(existing.active) : body.active === true;
  const password = String(body.password || '');
  const isSelf = existing.id === req.user.id;

  if (!/^[a-zA-Z0-9._-]{3,32}$/.test(username)) return res.status(400).json({ error: 'Username harus 3-32 karakter dan hanya berisi huruf, angka, titik, garis bawah, atau tanda hubung.' });
  if (!name || name.length > 100) return res.status(400).json({ error: 'Nama wajib diisi dan maksimal 100 karakter.' });
  if (!EMPLOYEE_ROLES.includes(role)) return res.status(400).json({ error: 'Peran tidak valid.' });
  if (!(await getTenant(tenantId))) return res.status(400).json({ error: 'Tenant tidak valid.' });
  if (password && password.length < 8) return res.status(400).json({ error: 'Kata sandi baru minimal 8 karakter.' });
  if (isSelf && (role !== existing.role || tenantId !== existing.tenant_id || !active)) {
    return res.status(400).json({ error: 'Akun sendiri tidak dapat dipindahkan, dinonaktifkan, atau diubah perannya.' });
  }
  if (existing.role === 'super-admin' && (role !== 'super-admin' || !active)) {
    const activeAdmins = (await db.prepare("SELECT COUNT(*)::INTEGER AS count FROM users WHERE role = 'super-admin' AND active = TRUE").get()).count;
    if (activeAdmins <= 1) return res.status(409).json({ error: 'Minimal satu Platform Admin aktif harus dipertahankan.' });
  }

  const now = new Date().toISOString();
  const credentials = password ? hashPassword(password) : null;
  try {
    if (credentials) {
      await db.prepare('UPDATE users SET username = ?, name = ?, role = ?, tenant_id = ?, active = ?, password_salt = ?, password_hash = ?, updated_at = ? WHERE id = ?')
        .run(username, name, role, tenantId, active, credentials.salt, credentials.hash, now, existing.id);
    } else {
      await db.prepare('UPDATE users SET username = ?, name = ?, role = ?, tenant_id = ?, active = ?, updated_at = ? WHERE id = ?')
        .run(username, name, role, tenantId, active, now, existing.id);
    }
  } catch (error) {
    if (error.code === '23505') return res.status(409).json({ error: 'Username sudah digunakan.' });
    throw error;
  }
  if (password || role !== existing.role || tenantId !== existing.tenant_id || !active) {
    await revokeUserSessions(existing.id, existing.id === req.user.id ? parseCookies(req.headers.cookie || '').orderguard_session : '');
  }
  const action = password ? 'Data karyawan dan kata sandi diperbarui' : 'Data karyawan diperbarui';
  await db.prepare('INSERT INTO employee_audit (id, actor_id, actor_name, target_user_id, action, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(crypto.randomUUID(), req.user.id, req.user.name, existing.id, action, now);
  const updated = await db.prepare('SELECT id, username, name, role, tenant_id AS tenantId, active, created_at AS createdAt, updated_at AS updatedAt FROM users WHERE id = ?').get(existing.id);
  res.json({ user: await publicUser(updated) });
}));

app.delete('/api/users/:id', requireAuth, requireRole(['super-admin']), asyncRoute(async (req, res) => {
  const existing = await db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Karyawan tidak ditemukan.' });
  if (existing.id === req.user.id) return res.status(400).json({ error: 'Akun yang sedang digunakan tidak dapat dinonaktifkan.' });
  if (existing.role === 'super-admin') {
    const activeAdmins = (await db.prepare("SELECT COUNT(*)::INTEGER AS count FROM users WHERE role = 'super-admin' AND active = TRUE").get()).count;
    if (activeAdmins <= 1) return res.status(409).json({ error: 'Minimal satu Platform Admin aktif harus dipertahankan.' });
  }

  const now = new Date().toISOString();
  await db.prepare('UPDATE users SET active = FALSE, updated_at = ? WHERE id = ?').run(now, existing.id);
  await revokeUserSessions(existing.id);
  await db.prepare('INSERT INTO employee_audit (id, actor_id, actor_name, target_user_id, action, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(crypto.randomUUID(), req.user.id, req.user.name, existing.id, 'Akun karyawan dinonaktifkan', now);
  res.json({ ok: true });
}));

app.post('/api/login', asyncRoute(async (req, res) => {
  const { username, password } = req.body || {};
  const user = await db.prepare('SELECT id, username, name, password_salt, password_hash, role, tenant_id AS tenantId FROM users WHERE LOWER(username) = LOWER(?) AND active = TRUE').get(String(username || '').trim());
  if (!user || !verifyPassword(String(password || ''), user.password_salt, user.password_hash)) {
    return res.status(401).json({ error: 'Kredensial tidak valid.' });
  }

  const token = signSessionToken();
  const createdAt = new Date();
  const expiresAt = new Date(createdAt.getTime() + 1000 * 60 * 60 * 8).toISOString();
  await db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)')
    .run(hashSessionToken(token), user.id, expiresAt, createdAt.toISOString());
  await db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(createdAt.toISOString());
  const secureCookie = process.env.NODE_ENV === 'production';
  res.cookie('orderguard_session', token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: secureCookie,
    maxAge: 1000 * 60 * 60 * 8,
  });
  res.json({ ok: true, user: await publicUser(user) });
}));

app.post('/api/logout', asyncRoute(async (req, res) => {
  const cookies = parseCookies(req.headers.cookie || '');
  const token = cookies.orderguard_session;
  if (token) await db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashSessionToken(token));
  res.clearCookie('orderguard_session', { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production' });
  res.json({ ok: true });
}));

app.get('/api/tiktok/status', requireAuth, requireRole(['super-admin', 'store-admin']), asyncRoute(async (req, res) => {
  const { configured, config } = tiktokConfigStatus();
  const shops = (await db.prepare('SELECT COUNT(*)::INTEGER AS count FROM tiktok_shops WHERE tenant_id = ?').get(req.user.tenantId)).count;
  res.json({ configured, missing: configured ? [] : config.missing, connectedShops: shops });
}));

app.get('/api/tiktok/connect', requireAuth, requireRole(['super-admin', 'store-admin']), asyncRoute(async (req, res) => {
  const { configured, config } = tiktokConfigStatus();
  if (!configured) {
    return res.status(503).json({ error: `Integrasi TikTok Shop belum dikonfigurasi: ${config.missing.join(', ')}.` });
  }
  const state = crypto.randomBytes(32).toString('base64url');
  const now = new Date();
  await db.prepare('DELETE FROM tiktok_oauth_states WHERE expires_at <= ?').run(now.toISOString());
  await db.prepare('INSERT INTO tiktok_oauth_states (state_hash, tenant_id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(hashOpaqueValue(state), req.user.tenantId, req.user.id, new Date(now.getTime() + 10 * 60 * 1000).toISOString(), now.toISOString());

  const authorizationUrl = new URL(TikTokShop.AUTHORIZATION_URL);
  authorizationUrl.searchParams.set('service_id', config.key);
  authorizationUrl.searchParams.set('state', state);
  res.set('Cache-Control', 'no-store');
  res.redirect(302, authorizationUrl.toString());
}));

app.get('/api/tiktok/callback', asyncRoute(async (req, res) => {
  const state = String(req.query.state || '');
  const authCode = String(req.query.auth_code || req.query.code || '');
  if (!state || !authCode) return res.status(400).send('Callback TikTok Shop tidak lengkap. Silakan mulai ulang proses koneksi.');

  const stateHash = hashOpaqueValue(state);
  const pending = await db.prepare('SELECT tenant_id AS tenantId FROM tiktok_oauth_states WHERE state_hash = ? AND expires_at > ?')
    .get(stateHash, new Date().toISOString());
  await db.prepare('DELETE FROM tiktok_oauth_states WHERE state_hash = ?').run(stateHash);
  if (!pending) return res.status(400).send('Sesi koneksi TikTok Shop kedaluwarsa atau tidak valid. Silakan mulai ulang proses koneksi.');

  const { configured, config } = tiktokConfigStatus();
  if (!configured) return res.status(503).send('Integrasi TikTok Shop belum dikonfigurasi oleh administrator.');

  try {
    const tokenData = await TikTokShop.exchangeAuthorizationCode({ authCode, config });
    if (!tokenData.access_token || !tokenData.refresh_token || !tokenData.open_id) {
      throw new Error('Respons otorisasi TikTok Shop tidak memuat kredensial yang diwajibkan.');
    }
    const shopData = await TikTokShop.getAuthorizedShops({ accessToken: tokenData.access_token, config });
    const shops = Array.isArray(shopData.shops) ? shopData.shops : [];
    const validShops = shops.filter((shop) => shop.shop_id && shop.shop_cipher);
    if (!validShops.length) throw new Error('Tidak ada toko berotorisasi dengan informasi toko yang lengkap.');

    const now = Date.now();
    const createdAt = new Date(now).toISOString();
    await db.transaction(async (tx) => {
      await tx.prepare(`
        INSERT INTO tiktok_connections (
          id, tenant_id, open_id, access_token, refresh_token,
          access_token_expires_at, refresh_token_expires_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(tenant_id, open_id) DO UPDATE SET
          access_token = excluded.access_token,
          refresh_token = excluded.refresh_token,
          access_token_expires_at = excluded.access_token_expires_at,
          refresh_token_expires_at = excluded.refresh_token_expires_at,
          updated_at = excluded.updated_at
      `).run(
        crypto.randomUUID(),
        pending.tenantId,
        String(tokenData.open_id),
        TikTokShop.encryptSecret(tokenData.access_token, config.encryptionKey),
        TikTokShop.encryptSecret(tokenData.refresh_token, config.encryptionKey),
        tiktokTokenExpiry(tokenData.access_token_expire_in, now),
        tiktokTokenExpiry(tokenData.refresh_token_expire_in, now),
        createdAt,
        createdAt,
      );
      const connection = await tx.prepare('SELECT id FROM tiktok_connections WHERE tenant_id = ? AND open_id = ?')
        .get(pending.tenantId, String(tokenData.open_id));
      await tx.prepare('DELETE FROM tiktok_shops WHERE connection_id = ?').run(connection.id);
      const insertShop = tx.prepare(`
        INSERT INTO tiktok_shops (id, tenant_id, connection_id, shop_id, shop_cipher, name, region, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(tenant_id, shop_id) DO UPDATE SET
          connection_id = excluded.connection_id,
          shop_cipher = excluded.shop_cipher,
          name = excluded.name,
          region = excluded.region
      `);
      for (const shop of validShops) {
        await insertShop.run(
          crypto.randomUUID(),
          pending.tenantId,
          connection.id,
          String(shop.shop_id),
          String(shop.shop_cipher),
          String(shop.shop_name || shop.name || shop.shop_id),
          String(shop.region || shop.region_code || ''),
          createdAt,
        );
      }
    });
    return res.redirect('/?view=imports&tiktok=connected');
  } catch (error) {
    console.error('Koneksi TikTok Shop gagal:', error.message);
    return res.redirect('/?view=imports&tiktok=error');
  }
}));

app.get('/api/tiktok/shops', requireAuth, requireRole(['super-admin', 'store-admin']), asyncRoute(async (req, res) => {
  const shops = await db.prepare(`
    SELECT shop_id AS shopId, name, region FROM tiktok_shops
    WHERE tenant_id = ? ORDER BY LOWER(name)
  `).all(req.user.tenantId);
  res.json({ shops });
}));

app.post('/api/tiktok/sync', requireAuth, requireRole(['super-admin', 'store-admin']), asyncRoute(async (req, res) => {
  const shopId = String(req.body?.shopId || '').trim();
  if (!shopId) return res.status(400).json({ error: 'Pilih toko TikTok Shop terlebih dahulu.' });
  const { configured, config } = tiktokConfigStatus();
  if (!configured) return res.status(503).json({ error: `Integrasi TikTok Shop belum dikonfigurasi: ${config.missing.join(', ')}.` });
  const connection = await tiktokConnectionForShop(req.user.tenantId, shopId);
  if (!connection) return res.status(404).json({ error: 'Toko TikTok Shop tidak ditemukan pada tenant ini.' });

  try {
    const accessToken = await ensureTikTokAccessToken(connection, config);
    const orders = await TikTokShop.searchOrders({
      accessToken,
      shopCipher: connection.shopCipher,
      config,
    });
    const date = new Date().toISOString().slice(0, 10);
    const shopName = connection.shopName.trim().toLocaleLowerCase('id-ID');
    const knownPackages = (await readState(req.user.tenantId)).manifests
      .filter((manifest) => String(manifest.shop || '').trim().toLocaleLowerCase('id-ID') === shopName)
      .flatMap((manifest) => Array.isArray(manifest.packages) ? manifest.packages : []);
    const { orders: eligibleOrders, withoutTracking, alreadyImported, duplicateOrders } = TikTokShop.prepareImportOrders(orders, connection.shopName, date, {
      existingOrders: knownPackages.map((parcel) => parcel.order).filter(Boolean),
      existingTrackings: knownPackages.map((parcel) => parcel.tracking).filter(Boolean),
    });
    res.json({
      shop: { shopId: connection.shopId, name: connection.shopName },
      fetched: orders.length,
      withoutTracking,
      alreadyImported,
      duplicateOrders,
      orders: eligibleOrders,
    });
  } catch (error) {
    console.error('Sinkronisasi TikTok Shop gagal:', error.message);
    res.status(502).json({ error: error.message || 'Sinkronisasi TikTok Shop gagal.' });
  }
}));

app.post('/api/order-events', requireAuth, requireRole(['super-admin', 'store-admin', 'handover-staff']), asyncRoute(async (req, res) => {
  const type = String(req.body?.type || '');
  const tracking = String(req.body?.tracking || '').trim();
  const reason = String(req.body?.reason || '').trim();
  const note = String(req.body?.note || '').trim();
  if (!tracking) return res.status(400).json({ error: 'Nomor resi wajib diisi.' });
  if (!ORDER_EVENT_TYPES.has(type)) return res.status(400).json({ error: 'Jenis kejadian tidak valid.' });
  if (reason.length > 500) return res.status(400).json({ error: 'Alasan maksimal 500 karakter.' });
  if (note.length > 1000) return res.status(400).json({ error: 'Catatan maksimal 1.000 karakter.' });
  const occurredAt = String(req.body?.occurredAt || '').trim();
  if (occurredAt && !validTimestamp(occurredAt)) return res.status(400).json({ error: 'Waktu kejadian tidak valid.' });
  try {
    const result = await updateTenantState(req.user.tenantId, (state) => applyOrderEvent(req.user, state, {
      type,
      tracking,
      reason,
      note,
      occurredAt,
      evidence: req.body?.evidence,
    }));
    res.status(201).json(result);
  } catch (error) {
    if (error instanceof OrderEventError) return res.status(error.status).json({ error: error.message });
    throw error;
  }
}));

app.get('/api/state', requireAuth, requireRole(['super-admin', 'store-admin', 'handover-staff']), asyncRoute(async (req, res) => {
  res.json(await readState(req.user.tenantId));
}));

app.post('/api/state', requireAuth, requireRole(['super-admin', 'store-admin', 'handover-staff']), asyncRoute(async (req, res) => {
  const payload = req.body && typeof req.body === 'object' ? req.body : null;
  if (!payload) return res.status(400).json({ error: 'Payload state tidak valid.' });
  const previous = await readState(req.user.tenantId);
  if (!Array.isArray(payload.audit)) return res.status(400).json({ error: 'Data audit tidak valid.' });
  const auditError = validateAuditAppend(req.user, previous.audit, payload.audit);
  if (auditError) return res.status(403).json({ error: auditError });
  if (req.user.role === 'handover-staff') {
    const validationError = validateHandoverUpdate(req.user, previous, payload);
    if (validationError) return res.status(403).json({ error: validationError });
  } else {
    const validationError = validateStoreAdminUpdate(req.user, previous, payload);
    if (validationError) return res.status(403).json({ error: validationError });
  }
  await writeState(req.user.tenantId, payload);
  res.json({ ok: true, updatedAt: new Date().toISOString() });
}));

app.get('/', (req, res) => {
  res.sendFile(path.join(appDir, 'index.html'));
});

app.get('/app.js', (req, res) => res.sendFile(path.join(appDir, 'app.js')));
app.get('/styles.css', (req, res) => res.sendFile(path.join(appDir, 'styles.css')));
app.get('/manifest.webmanifest', (req, res) => {
  res.set('Cache-Control', 'no-cache');
  res.sendFile(path.join(appDir, 'manifest.webmanifest'));
});
app.get('/service-worker.js', (req, res) => {
  res.set('Cache-Control', 'no-cache');
  res.set('Service-Worker-Allowed', '/');
  res.sendFile(path.join(appDir, 'service-worker.js'));
});
app.get('/icons/:icon', (req, res) => {
  if (!['orderguard.svg', 'icon-192.png', 'icon-512.png'].includes(req.params.icon)) return res.sendStatus(404);
  res.sendFile(path.join(appDir, 'icons', req.params.icon));
});

initializeDatabase().then(() => {
  app.listen(port, () => {
    console.log(`OrderGuard backend connected to PostgreSQL and running on http://localhost:${port}`);
  });
}).catch(async (error) => {
  console.error(`Gagal menginisialisasi PostgreSQL: ${error.message}`);
  await db.pool.end();
  process.exitCode = 1;
});
