const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');

const app = express();
const port = Number(process.env.PORT || 4173);
const appDir = __dirname;
const dataDir = path.join(appDir, 'data');
fs.mkdirSync(dataDir, { recursive: true });

const dbPath = process.env.ORDERGUARD_DB_PATH || path.join(dataDir, 'orderguard.db');
fs.mkdirSync(path.dirname(dbPath), { recursive: true });
const db = new Database(dbPath);
db.exec(`
  CREATE TABLE IF NOT EXISTS app_state (
    id TEXT PRIMARY KEY,
    payload TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS tenant_state (
    tenant_id TEXT PRIMARY KEY,
    payload TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS tenants (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS tenant_audit (
    id TEXT PRIMARY KEY,
    actor_id TEXT NOT NULL,
    actor_name TEXT NOT NULL,
    tenant_id TEXT NOT NULL,
    action TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name TEXT NOT NULL,
    password_salt TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL,
    tenant_id TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS employee_audit (
    id TEXT PRIMARY KEY,
    actor_id TEXT NOT NULL,
    actor_name TEXT NOT NULL,
    target_user_id TEXT NOT NULL,
    action TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
`);

const INITIAL_TENANTS = [
  { id: 'dfixer-store', name: "D'Fixer Store" },
  { id: 'maya-commerce', name: 'Maya Commerce' },
];
const DEMO_USERS = [
  { id: 'admin', username: 'admin', password: 'admin123', name: 'Platform Admin', role: 'super-admin', tenantId: 'dfixer-store' },
  { id: 'rani', username: 'rani', password: 'rani123', name: 'Rani Admin', role: 'store-admin', tenantId: 'dfixer-store' },
  { id: 'handover', username: 'handover', password: 'handover123', name: 'Budi Handover', role: 'handover-staff', tenantId: 'dfixer-store' },
  { id: 'maya', username: 'maya', password: 'maya123', name: 'Maya Admin', role: 'store-admin', tenantId: 'maya-commerce' },
];
const EMPLOYEE_ROLES = ['super-admin', 'store-admin', 'handover-staff'];
const ROLE_PERMISSIONS = {
  'super-admin': ['dashboard', 'manifests', 'imports', 'incidents', 'reports', 'audit'],
  'store-admin': ['dashboard', 'manifests', 'imports', 'incidents', 'reports', 'audit'],
  'handover-staff': ['dashboard', 'manifests'],
};
const SESSIONS = new Map();

function seedTenants() {
  const insert = db.prepare('INSERT OR IGNORE INTO tenants (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)');
  const now = new Date().toISOString();
  for (const tenant of INITIAL_TENANTS) insert.run(tenant.id, tenant.name, now, now);
}

function getTenant(tenantId) {
  return db.prepare('SELECT id, name, created_at AS createdAt, updated_at AS updatedAt FROM tenants WHERE id = ?').get(tenantId) || null;
}

function listTenants() {
  return db.prepare(`SELECT tenants.id, tenants.name, tenants.created_at AS createdAt, tenants.updated_at AS updatedAt,
    COUNT(users.id) AS employeeCount FROM tenants LEFT JOIN users ON users.tenant_id = tenants.id
    GROUP BY tenants.id ORDER BY tenants.name COLLATE NOCASE`).all();
}

function recordTenantAudit(actor, tenantId, action) {
  db.prepare('INSERT INTO tenant_audit (id, actor_id, actor_name, tenant_id, action, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(crypto.randomUUID(), actor.id, actor.name, tenantId, action, new Date().toISOString());
}

function signSessionToken(userId) {
  return crypto.createHash('sha256').update(`${userId}:${Date.now()}:${Math.random()}`).digest('hex');
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

function seedDemoUsers() {
  const count = db.prepare('SELECT COUNT(*) AS count FROM users').get().count;
  if (count) return;
  const insert = db.prepare('INSERT INTO users (id, username, name, password_salt, password_hash, role, tenant_id, active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)');
  const now = new Date().toISOString();
  const seed = db.transaction(() => {
    for (const user of DEMO_USERS) {
      const credentials = hashPassword(user.password);
      insert.run(user.id, user.username, user.name, credentials.salt, credentials.hash, user.role, user.tenantId, now, now);
    }
  });
  seed();
}

seedTenants();
seedDemoUsers();

function parseCookies(header = '') {
  return header.split(';').map((segment) => segment.trim()).filter(Boolean).reduce((accumulator, segment) => {
    const [name, ...rest] = segment.split('=');
    accumulator[name] = decodeURIComponent(rest.join('='));
    return accumulator;
  }, {});
}

function getUserFromRequest(req) {
  const cookies = parseCookies(req.headers.cookie || '');
  const token = cookies.orderguard_session;
  const userId = token ? SESSIONS.get(token) : null;
  if (!userId) return null;
  return db.prepare('SELECT id, username, name, role, tenant_id AS tenantId FROM users WHERE id = ? AND active = 1').get(userId) || null;
}

function requireAuth(req, res, next) {
  const user = getUserFromRequest(req);
  if (!user) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  req.user = user;
  next();
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
          { order: 'ORD-5790', tracking: 'JNE0008114201', status: 'HANDED_OVER', scannedAt: new Date(Date.now() - 86400000).toISOString() },
          { order: 'ORD-5791', tracking: 'JNE0008114202', status: 'HANDED_OVER', scannedAt: new Date(Date.now() - 86400000).toISOString() },
          { order: 'ORD-5792', tracking: 'JNE0008114203', status: 'EXPECTED', scannedAt: null },
        ], scans: [], sessions: [{ id: `TR-${previous.replaceAll('-', '')}-01`, receiver: 'Budi Santoso', actor: 'Rani Admin', createdAt: new Date(Date.now() - 86400000 + 3600000).toISOString(), note: 'Pengambilan tahap pertama', items: ['JNE0008114201', 'JNE0008114202'], evidence: null }] },
    ],
    incidents: [{ id: 'INC-2601', category: 'Paket di luar manifest', manifestId: `OG-${today.replaceAll('-', '').slice(2)}-042`, tracking: 'SPXID028451199', description: 'Resi terbaca saat proses sortir, belum ditambahkan ke manifest.', reportedBy: 'Rani Admin', createdAt: new Date().toISOString(), status: 'OPEN', resolution: '' }],
    audit: [
      { id: 'AU-1', actor: 'Rani Admin', action: 'Manifest dibuka untuk pemindaian', object: `OG-${today.replaceAll('-', '').slice(2)}-042`, createdAt: new Date().toISOString() },
      { id: 'AU-2', actor: 'Rani Admin', action: 'Serah terima tahap pertama dikonfirmasi', object: `OG-${previous.replaceAll('-', '').slice(2)}-039`, createdAt: new Date(Date.now() - 86400000 + 3600000).toISOString() },
    ],
    importJobs: [],
  };
}

function readState(tenantId) {
  const row = db.prepare('SELECT payload FROM tenant_state WHERE tenant_id = ?').get(tenantId);
  if (!row) {
    if (tenantId === 'dfixer-store') {
      const legacyRow = db.prepare("SELECT payload FROM app_state WHERE id = 'state'").get();
      if (legacyRow) {
        try {
          const legacyState = JSON.parse(legacyRow.payload);
          writeState(tenantId, legacyState);
          return legacyState;
        } catch (error) {
          console.warn('State lama tidak dapat dibaca; membuat state tenant baru.', error);
        }
      }
    }
    const initialState = baseState(getTenant(tenantId)?.name);
    writeState(tenantId, initialState);
    return initialState;
  }

  try {
    return JSON.parse(row.payload);
  } catch (error) {
    const initialState = baseState(getTenant(tenantId)?.name);
    writeState(tenantId, initialState);
    return initialState;
  }
}

function writeState(tenantId, payload) {
  const state = payload && typeof payload === 'object' ? payload : baseState(getTenant(tenantId)?.name);
  const issuedAt = new Date().toISOString();
  db.prepare(
    `INSERT INTO tenant_state (tenant_id, payload, updated_at) VALUES (?, ?, ?) ON CONFLICT(tenant_id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at`
  ).run(tenantId, JSON.stringify(state), issuedAt);
}

function publicUser(user) {
  return {
    id: user.id,
    username: user.username,
    name: user.name,
    role: user.role,
    tenantId: user.tenantId || user.tenant_id,
    tenantName: getTenant(user.tenantId || user.tenant_id)?.name,
    active: user.active === undefined ? true : Boolean(user.active),
    createdAt: user.createdAt || user.created_at,
    updatedAt: user.updatedAt || user.updated_at,
  };
}

app.use(express.json({ limit: '10mb' }));

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

app.get('/api/session', (req, res) => {
  const user = getUserFromRequest(req);
  res.json({ user: user ? publicUser(user) : null });
});

app.post('/api/tenants', requireAuth, requireRole(['super-admin']), (req, res) => {
  const id = String(req.body?.id || '').trim();
  const name = String(req.body?.name || '').trim();
  if (!/^[a-z0-9](?:[a-z0-9-]{0,48}[a-z0-9])$/.test(id)) {
    return res.status(400).json({ error: 'ID tenant harus 2-50 karakter, huruf kecil, angka, dan tanda hubung; tidak boleh diawali atau diakhiri tanda hubung.' });
  }
  if (name.length < 2 || name.length > 100) return res.status(400).json({ error: 'Nama tenant harus 2-100 karakter.' });

  const now = new Date().toISOString();
  try {
    db.prepare('INSERT INTO tenants (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)').run(id, name, now, now);
  } catch (error) {
    if (error.code === 'SQLITE_CONSTRAINT_PRIMARYKEY') return res.status(409).json({ error: 'ID tenant sudah digunakan.' });
    if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') return res.status(409).json({ error: 'Nama tenant sudah digunakan.' });
    throw error;
  }
  recordTenantAudit(req.user, id, 'Tenant dibuat');
  res.status(201).json({ tenant: getTenant(id) });
});

app.patch('/api/tenants/:id', requireAuth, requireRole(['super-admin']), (req, res) => {
  const tenant = getTenant(req.params.id);
  if (!tenant) return res.status(404).json({ error: 'Tenant tidak ditemukan.' });
  const name = String(req.body?.name || '').trim();
  if (name.length < 2 || name.length > 100) return res.status(400).json({ error: 'Nama tenant harus 2-100 karakter.' });

  const now = new Date().toISOString();
  try {
    db.prepare('UPDATE tenants SET name = ?, updated_at = ? WHERE id = ?').run(name, now, tenant.id);
  } catch (error) {
    if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') return res.status(409).json({ error: 'Nama tenant sudah digunakan.' });
    throw error;
  }
  recordTenantAudit(req.user, tenant.id, 'Nama tenant diperbarui');
  res.json({ tenant: getTenant(tenant.id) });
});

app.get('/api/users', requireAuth, requireRole(['super-admin']), (req, res) => {
  const users = db.prepare('SELECT id, username, name, role, tenant_id AS tenantId, active, created_at AS createdAt, updated_at AS updatedAt FROM users ORDER BY tenant_id, name COLLATE NOCASE').all().map(publicUser);
  const activity = db.prepare('SELECT actor_name AS actorName, target_user_id AS targetUserId, action, created_at AS createdAt FROM employee_audit ORDER BY created_at DESC LIMIT 100').all();
  const tenantActivity = db.prepare('SELECT actor_name AS actorName, tenant_id AS tenantId, action, created_at AS createdAt FROM tenant_audit ORDER BY created_at DESC LIMIT 100').all();
  res.json({ users, tenants: listTenants(), activity, tenantActivity });
});

app.post('/api/users', requireAuth, requireRole(['super-admin']), (req, res) => {
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
  if (!getTenant(tenantId)) return res.status(400).json({ error: 'Tenant tidak valid.' });

  const now = new Date().toISOString();
  const credentials = hashPassword(password);
  const id = crypto.randomUUID();
  try {
    db.prepare('INSERT INTO users (id, username, name, password_salt, password_hash, role, tenant_id, active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)')
      .run(id, username, name, credentials.salt, credentials.hash, role, tenantId, now, now);
  } catch (error) {
    if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') return res.status(409).json({ error: 'Username sudah digunakan.' });
    throw error;
  }
  db.prepare('INSERT INTO employee_audit (id, actor_id, actor_name, target_user_id, action, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(crypto.randomUUID(), req.user.id, req.user.name, id, 'Karyawan ditambahkan', now);
  const created = db.prepare('SELECT id, username, name, role, tenant_id AS tenantId, active, created_at AS createdAt, updated_at AS updatedAt FROM users WHERE id = ?').get(id);
  res.status(201).json({ user: publicUser(created) });
});

app.patch('/api/users/:id', requireAuth, requireRole(['super-admin']), (req, res) => {
  const existing = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
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
  if (!getTenant(tenantId)) return res.status(400).json({ error: 'Tenant tidak valid.' });
  if (password && password.length < 8) return res.status(400).json({ error: 'Kata sandi baru minimal 8 karakter.' });
  if (isSelf && (role !== existing.role || tenantId !== existing.tenant_id || !active)) {
    return res.status(400).json({ error: 'Akun sendiri tidak dapat dipindahkan, dinonaktifkan, atau diubah perannya.' });
  }
  if (existing.role === 'super-admin' && (role !== 'super-admin' || !active)) {
    const activeAdmins = db.prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'super-admin' AND active = 1").get().count;
    if (activeAdmins <= 1) return res.status(409).json({ error: 'Minimal satu Platform Admin aktif harus dipertahankan.' });
  }

  const now = new Date().toISOString();
  const credentials = password ? hashPassword(password) : null;
  try {
    if (credentials) {
      db.prepare('UPDATE users SET username = ?, name = ?, role = ?, tenant_id = ?, active = ?, password_salt = ?, password_hash = ?, updated_at = ? WHERE id = ?')
        .run(username, name, role, tenantId, Number(active), credentials.salt, credentials.hash, now, existing.id);
    } else {
      db.prepare('UPDATE users SET username = ?, name = ?, role = ?, tenant_id = ?, active = ?, updated_at = ? WHERE id = ?')
        .run(username, name, role, tenantId, Number(active), now, existing.id);
    }
  } catch (error) {
    if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') return res.status(409).json({ error: 'Username sudah digunakan.' });
    throw error;
  }
  if (password && existing.id !== req.user.id) {
    for (const [token, userId] of SESSIONS) {
      if (userId === existing.id) SESSIONS.delete(token);
    }
  }
  const action = password ? 'Data karyawan dan kata sandi diperbarui' : 'Data karyawan diperbarui';
  db.prepare('INSERT INTO employee_audit (id, actor_id, actor_name, target_user_id, action, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(crypto.randomUUID(), req.user.id, req.user.name, existing.id, action, now);
  const updated = db.prepare('SELECT id, username, name, role, tenant_id AS tenantId, active, created_at AS createdAt, updated_at AS updatedAt FROM users WHERE id = ?').get(existing.id);
  res.json({ user: publicUser(updated) });
});

app.delete('/api/users/:id', requireAuth, requireRole(['super-admin']), (req, res) => {
  const existing = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Karyawan tidak ditemukan.' });
  if (existing.id === req.user.id) return res.status(400).json({ error: 'Akun yang sedang digunakan tidak dapat dinonaktifkan.' });
  if (existing.role === 'super-admin') {
    const activeAdmins = db.prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'super-admin' AND active = 1").get().count;
    if (activeAdmins <= 1) return res.status(409).json({ error: 'Minimal satu Platform Admin aktif harus dipertahankan.' });
  }

  const now = new Date().toISOString();
  db.prepare('UPDATE users SET active = 0, updated_at = ? WHERE id = ?').run(now, existing.id);
  for (const [token, userId] of SESSIONS) {
    if (userId === existing.id) SESSIONS.delete(token);
  }
  db.prepare('INSERT INTO employee_audit (id, actor_id, actor_name, target_user_id, action, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(crypto.randomUUID(), req.user.id, req.user.name, existing.id, 'Akun karyawan dinonaktifkan', now);
  res.json({ ok: true });
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  const user = db.prepare('SELECT id, username, name, password_salt, password_hash, role, tenant_id AS tenantId FROM users WHERE username = ? COLLATE NOCASE AND active = 1').get(String(username || '').trim());
  if (!user || !verifyPassword(String(password || ''), user.password_salt, user.password_hash)) {
    return res.status(401).json({ error: 'Kredensial tidak valid.' });
  }

  const token = signSessionToken(user.id);
  SESSIONS.set(token, user.id);
  res.cookie('orderguard_session', token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: false,
    maxAge: 1000 * 60 * 60 * 8,
  });
  res.json({ ok: true, user: publicUser(user) });
});

app.post('/api/logout', (req, res) => {
  const cookies = parseCookies(req.headers.cookie || '');
  const token = cookies.orderguard_session;
  if (token) SESSIONS.delete(token);
  res.clearCookie('orderguard_session');
  res.json({ ok: true });
});

app.get('/api/state', requireAuth, requireRole(['super-admin', 'store-admin', 'handover-staff']), (req, res) => {
  res.json(readState(req.user.tenantId));
});

app.post('/api/state', requireAuth, requireRole(['super-admin', 'store-admin', 'handover-staff']), (req, res) => {
  const payload = req.body && typeof req.body === 'object' ? req.body : baseState(getTenant(req.user.tenantId)?.name);
  writeState(req.user.tenantId, payload);
  res.json({ ok: true, updatedAt: new Date().toISOString() });
});

app.use(express.static(appDir));

app.get(/^\/(?!api).*/, (req, res) => {
  res.sendFile(path.join(appDir, 'index.html'));
});

app.listen(port, () => {
  console.log(`OrderGuard backend running on http://localhost:${port}`);
});
