const crypto = require('node:crypto');

const ORPHAN_RULES = [
  { table: 'tenant_state', key: 'tenant_id', ref: 'tenants', refKey: 'id', tenantColumn: 'tenant_id' },
  { table: 'tenant_manifest_ids', key: 'tenant_id', ref: 'tenants', refKey: 'id', tenantColumn: 'tenant_id' },
  { table: 'state_quarantine', key: 'tenant_id', ref: 'tenants', refKey: 'id', tenantColumn: 'tenant_id' },
  { table: 'quarantine_recovery_audit', key: 'tenant_id', ref: 'tenants', refKey: 'id', tenantColumn: 'tenant_id' },
  { table: 'quarantine_recovery_audit', key: 'quarantine_id', ref: 'state_quarantine', refKey: 'id', tenantColumn: 'tenant_id' },
  { table: 'tenant_audit', key: 'tenant_id', ref: 'tenants', refKey: 'id', tenantColumn: 'tenant_id' },
  { table: 'sessions', key: 'user_id', ref: 'users', refKey: 'id', tenantColumn: null },
  { table: 'employee_audit', key: 'target_user_id', ref: 'users', refKey: 'id', tenantColumn: null },
  { table: 'auth_audit', key: 'user_id', ref: 'users', refKey: 'id', tenantColumn: null },
  { table: 'tiktok_oauth_states', key: 'tenant_id', ref: 'tenants', refKey: 'id', tenantColumn: 'tenant_id' },
  { table: 'tiktok_oauth_states', key: 'user_id', ref: 'users', refKey: 'id', tenantColumn: 'tenant_id' },
  { table: 'users', key: 'tenant_id', ref: 'tenants', refKey: 'id', tenantColumn: 'tenant_id' },
  { table: 'tiktok_shops', key: 'tenant_id', ref: 'tenants', refKey: 'id', tenantColumn: 'tenant_id' },
  { table: 'tiktok_shops', key: 'connection_id', ref: 'tiktok_connections', refKey: 'id', tenantColumn: 'tenant_id' },
  { table: 'tiktok_connections', key: 'tenant_id', ref: 'tenants', refKey: 'id', tenantColumn: 'tenant_id' },
  { table: 'integrity_orphans', key: 'tenant_id', ref: 'tenants', refKey: 'id', tenantColumn: 'tenant_id' },
];

function quote(table) {
  if (!/^[a-z_][a-z0-9_]*$/.test(table)) throw new Error(`Unsafe table name: ${table}`);
  return `"${table}"`;
}

function hash(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

async function auditIntegrity(db) {
  const constraints = await db.prepare(`
    SELECT conname, conrelid::regclass AS table_name, confrelid::regclass AS ref_table, convalidated
    FROM pg_constraint
    WHERE contype = 'f' AND connamespace = current_schema()::regnamespace
    ORDER BY conname
  `).all();

  const orphans = [];
  for (const rule of ORPHAN_RULES) {
    const rows = await db.prepare(`
      SELECT child.*
      FROM ${quote(rule.table)} child
      LEFT JOIN ${quote(rule.ref)} parent ON parent.${quote(rule.refKey)} = child.${quote(rule.key)}
      WHERE child.${quote(rule.key)} IS NOT NULL AND parent.${quote(rule.refKey)} IS NULL
      ORDER BY child.${quote(rule.key)}
    `).all();
    if (rows.length) {
      orphans.push({
        table: rule.table,
        key: rule.key,
        reference: `${rule.ref}.${rule.refKey}`,
        count: rows.length,
        sampleKeys: rows.slice(0, 20).map((row) => String(row[rule.key])),
      });
    }
  }

  const duplicateManifests = [];
  const states = await db.prepare('SELECT tenant_id AS tenantId, payload FROM tenant_state ORDER BY tenant_id').all();
  for (const stateRow of states) {
    try {
      const state = JSON.parse(stateRow.payload);
      if (!Array.isArray(state.manifests)) continue;
      const ids = new Map();
      for (const manifest of state.manifests) {
        if (!manifest || typeof manifest.id !== 'string') continue;
        ids.set(manifest.id, (ids.get(manifest.id) || 0) + 1);
      }
      for (const [manifestId, count] of ids) {
        if (count > 1) duplicateManifests.push({ tenantId: stateRow.tenantId, manifestId, count });
      }
    } catch {
      // Invalid JSON is reported separately by the application quarantine flow.
    }
  }

  return { constraints, orphans, duplicateManifests };
}

async function validateConstraints(db) {
  const constraints = await db.prepare(`
    SELECT conname, conrelid::regclass AS table_name, convalidated
    FROM pg_constraint
    WHERE contype = 'f' AND connamespace = current_schema()::regnamespace
  `).all();
  const results = [];
  for (const constraint of constraints) {
    if (constraint.convalidated) {
      results.push({ name: constraint.conname, table: constraint.table_name, status: 'already-valid' });
      continue;
    }
    await db.exec(`ALTER TABLE ${constraint.table_name} VALIDATE CONSTRAINT "${constraint.conname}"`);
    results.push({ name: constraint.conname, table: constraint.table_name, status: 'validated' });
  }
  return results;
}

async function reconcileIntegrity(db, { apply = false } = {}) {
  const before = await auditIntegrity(db);
  if (!apply) return { applied: false, before, after: before, quarantined: [], deleted: [], validation: [], duplicateManifests: before.duplicateManifests };

  if (before.duplicateManifests.length) {
    return {
      applied: false,
      blocked: 'Manifest ID duplikat harus ditinjau manual; rekonsiliasi tidak menghapus data manifest otomatis.',
      before,
      after: before,
      quarantined: [],
      deleted: [],
      validation: [],
      duplicateManifests: before.duplicateManifests,
    };
  }

  return db.transaction(async (tx) => {
    const quarantined = [];
    const deleted = [];
    for (const rule of ORPHAN_RULES) {
      const rows = await tx.prepare(`
        SELECT child.*
        FROM ${quote(rule.table)} child
        LEFT JOIN ${quote(rule.ref)} parent ON parent.${quote(rule.refKey)} = child.${quote(rule.key)}
        WHERE child.${quote(rule.key)} IS NOT NULL AND parent.${quote(rule.refKey)} IS NULL
      `).all();
      for (const row of rows) {
        const sourceKey = String(row[rule.key]);
        const payload = JSON.stringify(row);
        const payloadHash = hash(payload);
        const sourceTenant = rule.tenantColumn ? row[rule.tenantColumn] : null;
        const tenantExists = sourceTenant
          ? await tx.prepare('SELECT 1 AS found FROM tenants WHERE id = ?').get(sourceTenant)
          : null;
        await tx.prepare(`
          INSERT INTO integrity_orphans (id, source_table, source_key, tenant_id, payload, payload_hash, reason, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (source_table, source_key, payload_hash) DO NOTHING
        `).run(crypto.randomUUID(), rule.table, sourceKey, tenantExists ? sourceTenant : null, payload, payloadHash, `${rule.table}.${rule.key} orphan; reference ${rule.reference}`, new Date().toISOString());
        await tx.prepare(`DELETE FROM ${quote(rule.table)} WHERE ${quote(rule.key)} = ?`).run(row[rule.key]);
        quarantined.push({ table: rule.table, key: rule.key, sourceKey });
        deleted.push({ table: rule.table, key: rule.key, sourceKey });
      }
    }
    const validation = await validateConstraints(tx);
    const after = await auditIntegrity(tx);
    return { applied: true, before, after, quarantined, deleted, validation, duplicateManifests: after.duplicateManifests };
  });
}

module.exports = { ORPHAN_RULES, auditIntegrity, reconcileIntegrity, validateConstraints };
