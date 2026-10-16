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

const db = new Database(path.join(dataDir, 'orderguard.db'));
db.exec(`
  CREATE TABLE IF NOT EXISTS app_state (
    id TEXT PRIMARY KEY,
    payload TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`);

const USERS = {
  admin: { id: 'admin', username: 'admin', password: 'admin123', name: 'Platform Admin', role: 'super-admin' },
  rani: { id: 'rani', username: 'rani', password: 'rani123', name: 'Rani Admin', role: 'store-admin' },
  handover: { id: 'handover', username: 'handover', password: 'handover123', name: 'Budi Handover', role: 'handover-staff' },
};
const ROLE_PERMISSIONS = {
  'super-admin': ['dashboard', 'manifests', 'imports', 'incidents', 'reports', 'audit'],
  'store-admin': ['dashboard', 'manifests', 'imports', 'incidents', 'reports', 'audit'],
  'handover-staff': ['dashboard', 'manifests'],
};
const SESSIONS = new Map();

function signSessionToken(userId) {
  return crypto.createHash('sha256').update(`${userId}:${Date.now()}:${Math.random()}`).digest('hex');
}

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
  return userId ? USERS[userId] || null : null;
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

function baseState() {
  const today = new Date().toISOString().slice(0, 10);
  const previous = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  return {
    manifests: [
      { id: `OG-${today.replaceAll('-', '').slice(2)}-042`, shop: "D'Fixer Store", courier: 'J&T Express', location: 'Gudang Jakarta Selatan', date: today, status: 'HANDOVER_IN_PROGRESS', createdAt: new Date().toISOString(), createdBy: 'Rani Admin', packages: [
          { order: 'ORD-5821', tracking: 'SPXID028451101', status: 'SCANNED', scannedAt: new Date().toISOString() },
          { order: 'ORD-5822', tracking: 'SPXID028451102', status: 'SCANNED', scannedAt: new Date().toISOString() },
          { order: 'ORD-5823', tracking: 'SPXID028451103', status: 'EXPECTED', scannedAt: null },
          { order: 'ORD-5824', tracking: 'SPXID028451104', status: 'EXPECTED', scannedAt: null },
          { order: 'ORD-5825', tracking: 'SPXID028451105', status: 'EXPECTED', scannedAt: null },
          { order: 'ORD-5826', tracking: 'SPXID028451106', status: 'EXPECTED', scannedAt: null },
        ], scans: [], sessions: [] },
      { id: `OG-${previous.replaceAll('-', '').slice(2)}-039`, shop: "D'Fixer Store", courier: 'JNE', location: 'Gudang Jakarta Selatan', date: previous, status: 'PARTIALLY_HANDED_OVER', createdAt: new Date(Date.now() - 86400000).toISOString(), createdBy: 'Rani Admin', packages: [
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

function readState() {
  const row = db.prepare("SELECT payload FROM app_state WHERE id = 'state'").get();
  if (!row) {
    writeState(baseState());
    return baseState();
  }

  try {
    return JSON.parse(row.payload);
  } catch (error) {
    writeState(baseState());
    return baseState();
  }
}

function writeState(payload) {
  const state = payload && typeof payload === 'object' ? payload : baseState();
  const issuedAt = new Date().toISOString();
  db.prepare(
    `INSERT INTO app_state (id, payload, updated_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at`
  ).run('state', JSON.stringify(state), issuedAt);
}

app.use(express.json({ limit: '10mb' }));

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

app.get('/api/session', (req, res) => {
  const user = getUserFromRequest(req);
  res.json({ user: user ? { id: user.id, username: user.username, name: user.name, role: user.role } : null });
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  const user = Object.values(USERS).find((candidate) => candidate.username === String(username || '').trim() && candidate.password === String(password || ''));
  if (!user) {
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
  res.json({ ok: true, user: { id: user.id, username: user.username, name: user.name, role: user.role } });
});

app.post('/api/logout', (req, res) => {
  const cookies = parseCookies(req.headers.cookie || '');
  const token = cookies.orderguard_session;
  if (token) SESSIONS.delete(token);
  res.clearCookie('orderguard_session');
  res.json({ ok: true });
});

app.get('/api/state', requireAuth, requireRole(['super-admin', 'store-admin', 'handover-staff']), (req, res) => {
  res.json(readState());
});

app.post('/api/state', requireAuth, requireRole(['super-admin', 'store-admin', 'handover-staff']), (req, res) => {
  const payload = req.body && typeof req.body === 'object' ? req.body : baseState();
  writeState(payload);
  res.json({ ok: true, updatedAt: new Date().toISOString() });
});

app.use(express.static(appDir));

app.get(/^\/(?!api).*/, (req, res) => {
  res.sendFile(path.join(appDir, 'index.html'));
});

app.listen(port, () => {
  console.log(`OrderGuard backend running on http://localhost:${port}`);
});
