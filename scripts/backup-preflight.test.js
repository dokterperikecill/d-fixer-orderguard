const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { Pool } = require('pg');
const { createPool } = require('../database');

const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString) throw new Error('TEST_DATABASE_URL wajib untuk backup preflight test.');
const pool = new Pool({ connectionString });
const schema = `backup_preflight_test_${process.pid}`;

function runBackup(extraEnv = {}, backupDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'orderguard-preflight-'))) {
  return spawnSync(process.execPath, [path.join(__dirname, 'backup.js'), '--dry-run'], {
    cwd: path.join(__dirname, '..'),
    encoding: 'utf8',
    env: {
      ...process.env,
      DATABASE_URL: connectionString,
      DATABASE_SCHEMA: schema,
      ORDERGUARD_BACKUP_DIR: backupDirectory,
      ...extraEnv,
    },
  });
}

test('backup dry-run validates database, encryption key, tools, and destination without writing a backup', async () => {
  await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  await pool.query(`CREATE SCHEMA "${schema}"`);
  const db = createPool({ connectionString, schema });
  const backupDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'orderguard-preflight-'));
  try {
    await db.exec(db.schema);
    for (const migration of db.migrations) await db.exec(migration);
    const now = new Date().toISOString();
    await db.prepare('INSERT INTO tenants (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)').run('tenant-a', 'Tenant A', now, now);

    const result = spawnSync(process.execPath, [path.join(__dirname, 'backup.js'), '--dry-run'], {
      cwd: path.join(__dirname, '..'),
      encoding: 'utf8',
      env: {
        ...process.env,
        DATABASE_URL: connectionString,
        DATABASE_SCHEMA: schema,
        ORDERGUARD_BACKUP_DIR: backupDirectory,
        ORDERGUARD_BACKUP_ENCRYPTION_KEY: 'a'.repeat(64),
      },
    });
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.preflight, 'ok');
    assert.equal(report.encryption, true);
    assert.equal(report.counts.tenants, 1);
    assert.deepEqual(fs.readdirSync(backupDirectory), []);
  } finally {
    await db.pool.end();
    fs.rmSync(backupDirectory, { recursive: true, force: true });
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  }
});

test('backup dry-run rejects a missing or invalid encryption key', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orderguard-preflight-'));
  try {
    const missingKey = runBackup({ ORDERGUARD_BACKUP_ENCRYPTION_KEY: '' }, directory);
    assert.equal(missingKey.status, 1);
    assert.match(missingKey.stderr, /ENCRYPTION_KEY wajib diatur/);

    const invalidKey = runBackup({ ORDERGUARD_BACKUP_ENCRYPTION_KEY: 'not-a-key' }, directory);
    assert.equal(invalidKey.status, 1);
    assert.match(invalidKey.stderr, /Kunci backup/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
