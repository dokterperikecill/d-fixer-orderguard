const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const { createPool } = require('../database');
const { auditIntegrity, reconcileIntegrity } = require('./integrity-lib');

const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString) throw new Error('TEST_DATABASE_URL wajib untuk integrity test.');
const schema = `integrity_test_${process.pid}`;
const pool = new Pool({ connectionString });

test('integrity audit/reconcile quarantines orphans and validates foreign keys', async () => {
  await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  await pool.query(`CREATE SCHEMA "${schema}"`);
  const db = createPool({ connectionString, schema });
  try {
    await db.exec(db.schema);
    for (const migration of db.migrations) await db.exec(migration);
    const now = new Date().toISOString();
    await db.prepare('INSERT INTO tenants (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)').run('tenant-a', 'Tenant A', now, now);
    await db.exec('ALTER TABLE users DROP CONSTRAINT IF EXISTS users_tenant_fk');
    await db.prepare(
      'INSERT INTO users (id, username, name, password_salt, password_hash, role, tenant_id, active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, TRUE, ?, ?)'
    ).run('orphan-user', 'orphan-user', 'Orphan', 'salt', 'hash', 'handover-staff', 'missing-tenant', now, now);
    await db.exec('ALTER TABLE users ADD CONSTRAINT users_tenant_fk FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT NOT VALID');

    const before = await auditIntegrity(db);
    assert.equal(before.orphans.some((item) => item.table === 'users'), true);

    const dryRun = await reconcileIntegrity(db, { apply: false });
    assert.equal(dryRun.applied, false);
    const stillThere = await db.prepare('SELECT COUNT(*)::INTEGER AS count FROM users WHERE id = ?').get('orphan-user');
    assert.equal(stillThere.count, 1);

    const applied = await reconcileIntegrity(db, { apply: true });
    assert.equal(applied.applied, true);
    const after = await db.prepare('SELECT COUNT(*)::INTEGER AS count FROM users WHERE id = ?').get('orphan-user');
    assert.equal(after.count, 0);
    const quarantine = await db.prepare('SELECT COUNT(*)::INTEGER AS count FROM integrity_orphans WHERE source_table = ?').get('users');
    assert.equal(quarantine.count, 1);
    const validated = await db.prepare("SELECT convalidated FROM pg_constraint WHERE connamespace = current_schema()::regnamespace AND conname = 'users_tenant_fk'").get();
    assert.equal(validated.convalidated, true);

    const duplicatePayload = JSON.stringify({ manifests: [{ id: 'dup', packages: [], scans: [], sessions: [] }, { id: 'dup', packages: [], scans: [], sessions: [] }], incidents: [], audit: [], importJobs: [], orderEvents: [] });
    await db.prepare('INSERT INTO tenant_state (tenant_id, payload, version, updated_at) VALUES (?, ?, 0, ?)').run('tenant-a', duplicatePayload, now);
    const duplicateAudit = await auditIntegrity(db);
    assert.equal(duplicateAudit.duplicateManifests.length, 1);
    const duplicateReconcile = await reconcileIntegrity(db, { apply: true });
    assert.equal(duplicateReconcile.applied, false);
    const duplicateStillThere = await db.prepare('SELECT payload FROM tenant_state WHERE tenant_id = ?').get('tenant-a');
    assert.equal(duplicateStillThere.payload, duplicatePayload);
  } finally {
    await db.pool.end();
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  }
});
