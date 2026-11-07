const crypto = require('node:crypto');

const CROSS_TENANT_RULES = [
  { table: 'tiktok_shops', key: 'connection_id', parent: 'tiktok_connections', parentKey: 'id', label: 'tiktok_shops.connection_id / tenant_id' },
  { table: 'tiktok_oauth_states', key: 'user_id', parent: 'users', parentKey: 'id', label: 'tiktok_oauth_states.user_id / tenant_id' },
  { table: 'quarantine_recovery_audit', key: 'quarantine_id', parent: 'state_quarantine', parentKey: 'id', label: 'quarantine_recovery_audit.quarantine_id / tenant_id' },
];

const DEPENDENCIES = {
  users: [
    { table: 'sessions', column: 'user_id' },
    { table: 'employee_audit', column: 'target_user_id' },
    { table: 'auth_audit', column: 'user_id' },
    { table: 'tiktok_oauth_states', column: 'user_id' },
  ],
  tiktok_connections: [{ table: 'tiktok_shops', column: 'connection_id' }],
  state_quarantine: [{ table: 'quarantine_recovery_audit', column: 'quarantine_id' }],
};

const ORPHAN_RULES = [
  { table: 'tenant_state', key: 'tenant_id', deleteKey: 'tenant_id', ref: 'tenants', refKey: 'id', tenantColumn: 'tenant_id' },
  { table: 'tenant_manifest_ids', key: 'tenant_id', deleteKey: 'tenant_id', ref: 'tenants', refKey: 'id', tenantColumn: 'tenant_id' },
  { table: 'state_quarantine', key: 'tenant_id', deleteKey: 'id', ref: 'tenants', refKey: 'id', tenantColumn: 'tenant_id' },
  { table: 'quarantine_recovery_audit', key: 'tenant_id', deleteKey: 'id', ref: 'tenants', refKey: 'id', tenantColumn: 'tenant_id', protected: true },
  { table: 'quarantine_recovery_audit', key: 'quarantine_id', deleteKey: 'id', ref: 'state_quarantine', refKey: 'id', tenantColumn: 'tenant_id', protected: true },
  { table: 'tenant_audit', key: 'tenant_id', deleteKey: 'id', ref: 'tenants', refKey: 'id', tenantColumn: 'tenant_id' },
  { table: 'sessions', key: 'user_id', deleteKey: 'token_hash', ref: 'users', refKey: 'id', tenantColumn: null },
  { table: 'employee_audit', key: 'target_user_id', deleteKey: 'id', ref: 'users', refKey: 'id', tenantColumn: null },
  { table: 'auth_audit', key: 'user_id', deleteKey: 'id', ref: 'users', refKey: 'id', tenantColumn: null },
  { table: 'tiktok_oauth_states', key: 'tenant_id', deleteKey: 'state_hash', ref: 'tenants', refKey: 'id', tenantColumn: 'tenant_id' },
  { table: 'tiktok_oauth_states', key: 'user_id', deleteKey: 'state_hash', ref: 'users', refKey: 'id', tenantColumn: 'tenant_id' },
  { table: 'users', key: 'tenant_id', deleteKey: 'id', ref: 'tenants', refKey: 'id', tenantColumn: 'tenant_id' },
  { table: 'tiktok_shops', key: 'tenant_id', deleteKey: 'id', ref: 'tenants', refKey: 'id', tenantColumn: 'tenant_id' },
  { table: 'tiktok_shops', key: 'connection_id', deleteKey: 'id', ref: 'tiktok_connections', refKey: 'id', tenantColumn: 'tenant_id' },
  { table: 'tiktok_connections', key: 'tenant_id', deleteKey: 'id', ref: 'tenants', refKey: 'id', tenantColumn: 'tenant_id' },
  { table: 'integrity_orphans', key: 'tenant_id', deleteKey: 'id', ref: 'tenants', refKey: 'id', tenantColumn: 'tenant_id' },
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

  const crossTenantReferences = [];
  for (const rule of CROSS_TENANT_RULES) {
    const rows = await db.prepare(`
      SELECT child.tenant_id AS child_tenant, parent.tenant_id AS parent_tenant, COUNT(*)::INTEGER AS count
      FROM ${quote(rule.table)} child
      JOIN ${quote(rule.parent)} parent ON parent.${quote(rule.parentKey)} = child.${quote(rule.key)}
      WHERE child.tenant_id IS DISTINCT FROM parent.tenant_id
      GROUP BY child.tenant_id, parent.tenant_id
      ORDER BY child.tenant_id, parent.tenant_id
    `).all();
    if (rows.length) crossTenantReferences.push({ reference: rule.label, rows });
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

  return { constraints, orphans, crossTenantReferences, duplicateManifests };
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

  if (before.crossTenantReferences.length) {
    return {
      applied: false,
      blocked: 'Referensi lintas tenant harus ditinjau manual; rekonsiliasi tidak menghapus data otomatis.',
      before,
      after: before,
      quarantined: [],
      deleted: [],
      validation: [],
      duplicateManifests: before.duplicateManifests,
    };
  }

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
        const sourceKey = String(row[rule.deleteKey || rule.key]);
        if (rule.protected) {
          throw new Error(`Rekonsiliasi diblokir: ${rule.table}.${rule.key}=${sourceKey} adalah audit append-only; data tidak dihapus.`);
        }
        for (const dependency of DEPENDENCIES[rule.table] || []) {
          if (!/^[a-z_][a-z0-9_]*$/.test(dependency.table) || !/^[a-z_][a-z0-9_]*$/.test(dependency.column)) {
            throw new Error('Dependency rule tidak valid.');
          }
          const dependent = await tx.prepare(`SELECT COUNT(*)::INTEGER AS count FROM ${quote(dependency.table)} WHERE ${quote(dependency.column)} = ?`).get(row[rule.deleteKey || rule.key]);
          if (dependent.count > 0) {
            throw new Error(`Rekonsiliasi diblokir: ${rule.table}.${rule.key}=${sourceKey} masih memiliki ${dependent.count} baris di ${dependency.table}; data tidak dihapus.`);
          }
        }
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
        await tx.prepare(`DELETE FROM ${quote(rule.table)} WHERE ${quote(rule.deleteKey || rule.key)} = ?`).run(row[rule.deleteKey || rule.key]);
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
