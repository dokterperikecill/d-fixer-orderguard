const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const { createPool } = require('../database');
const { runValidation } = require('./validate-constraints');

const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString) throw new Error('TEST_DATABASE_URL wajib untuk constraint validation test.');
const pool = new Pool({ connectionString });
const schemaPrefix = `constraints_test_${process.pid}`;

async function createTestDatabase(schema) {
  await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  await pool.query(`CREATE SCHEMA "${schema}"`);
  const db = createPool({ connectionString, schema });
  await db.exec(db.schema);
  for (const migration of db.migrations) await db.exec(migration);
  return db;
}

test('constraint validation dry-run lists pending foreign keys and applies them in a transaction', async () => {
  const schema = `${schemaPrefix}_apply`;
  const db = await createTestDatabase(schema);
  try {
    const now = new Date().toISOString();
    await db.prepare('INSERT INTO tenants (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)').run('tenant-a', 'Tenant A', now, now);
    await db.prepare('INSERT INTO users (id, username, name, password_salt, password_hash, role, tenant_id, active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, TRUE, ?, ?)')
      .run('user-a', 'user-a', 'User A', 'salt', 'hash', 'store-admin', 'tenant-a', now, now);
    await db.prepare('INSERT INTO sessions (token_hash, user_id, csrf_token, expires_at, created_at) VALUES (?, ?, ?, ?, ?)')
      .run('token-a', 'user-a', 'csrf', new Date(Date.now() + 60000).toISOString(), now);
    await db.exec('ALTER TABLE sessions ADD CONSTRAINT sessions_validation_test_fk FOREIGN KEY (user_id) REFERENCES users(id) NOT VALID');

    const dryRun = await runValidation(db, { apply: false });
    assert.equal(dryRun.applied, false);
    assert.equal(dryRun.pending.some((constraint) => constraint.conname === 'sessions_validation_test_fk'), true);
    const before = await db.prepare("SELECT convalidated FROM pg_constraint WHERE connamespace = current_schema()::regnamespace AND conname = 'sessions_validation_test_fk'").get();
    assert.equal(before.convalidated, false);

    const applied = await runValidation(db, { apply: true });
    assert.equal(applied.applied, true);
    assert.equal(applied.validation.some((item) => item.name === 'sessions_validation_test_fk' && item.status === 'validated'), true);
    const after = await db.prepare("SELECT convalidated FROM pg_constraint WHERE connamespace = current_schema()::regnamespace AND conname = 'sessions_validation_test_fk'").get();
    assert.equal(after.convalidated, true);
  } finally {
    await db.pool.end();
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  }
});

test('constraint validation blocks when orphan data would fail the foreign key', async () => {
  const schema = `${schemaPrefix}_blocked`;
  const db = await createTestDatabase(schema);
  try {
    const now = new Date().toISOString();
    await db.exec('ALTER TABLE sessions DROP CONSTRAINT IF EXISTS sessions_user_fk');
    await db.prepare('INSERT INTO sessions (token_hash, user_id, csrf_token, expires_at, created_at) VALUES (?, ?, ?, ?, ?)')
      .run('orphan-token', 'missing-user', 'csrf', new Date(Date.now() + 60000).toISOString(), now);
    await db.exec('ALTER TABLE sessions ADD CONSTRAINT sessions_user_fk FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE NOT VALID');
    const dryRun = await runValidation(db, { apply: false });
    assert.equal(dryRun.blockers.orphans.some((item) => item.table === 'sessions'), true);

    const blocked = await runValidation(db, { apply: true });
    assert.equal(blocked.applied, false);
    assert.match(blocked.blocked, /diblokir/);
    const constraint = await db.prepare("SELECT convalidated FROM pg_constraint WHERE connamespace = current_schema()::regnamespace AND conname = 'sessions_user_fk'").get();
    assert.equal(constraint.convalidated, false);
  } finally {
    await db.pool.end();
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  }
});
