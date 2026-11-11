const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { Client } = require('pg');
const { sendAlert } = require('./alert');

const APP_DIR = path.join(__dirname, '..');
const sourceUrl = process.env.DRILL_SOURCE_DATABASE_URL || process.env.DATABASE_URL || '';
const targetUrl = process.env.DRILL_TARGET_DATABASE_URL || '';
const encryptionKey = process.env.ORDERGUARD_BACKUP_ENCRYPTION_KEY || '';
const backupDir = path.resolve(process.env.DRILL_BACKUP_DIR || path.join(os.tmpdir(), `orderguard-drill-${Date.now()}`));
const reportPath = process.env.DRILL_REPORT_PATH || '';
const runTamperCheck = process.env.DRILL_TAMPER_CHECK !== '0';
const keepBackups = process.env.DRILL_KEEP_BACKUPS !== '0';
const startedAt = Date.now();
const steps = [];

function databaseName(value) {
  return decodeURIComponent(new URL(value).pathname.slice(1));
}

function assertConfiguration() {
  if (!sourceUrl) throw new Error('DRILL_SOURCE_DATABASE_URL (atau DATABASE_URL) wajib diatur.');
  if (!targetUrl) throw new Error('DRILL_TARGET_DATABASE_URL wajib diatur ke database drill terpisah.');
  if (!encryptionKey) throw new Error('ORDERGUARD_BACKUP_ENCRYPTION_KEY wajib diatur.');
  const source = new URL(sourceUrl);
  const target = new URL(targetUrl);
  if (source.hostname === target.hostname && source.port === target.port && databaseName(sourceUrl) === databaseName(targetUrl)) {
    throw new Error('Database target drill harus berbeda dari database sumber.');
  }
}

function record(name, fn) {
  const begin = performance.now();
  try {
    const detail = fn();
    steps.push({ step: name, status: 'pass', durationMs: Number((performance.now() - begin).toFixed(1)), detail: detail || null });
    return detail;
  } catch (error) {
    steps.push({ step: name, status: 'fail', durationMs: Number((performance.now() - begin).toFixed(1)), error: error.message });
    throw error;
  }
}

function runNode(script, args, env, { expectFailure = false } = {}) {
  const result = spawnSync(process.execPath, [path.join(APP_DIR, script), ...args], {
    cwd: APP_DIR,
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
  if (expectFailure) {
    if (result.status === 0) throw new Error(`${script} seharusnya gagal tetapi berhasil.`);
    return { status: result.status, stderr: (result.stderr || '').trim(), stdout: (result.stdout || '').trim() };
  }
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${script} gagal (exit ${result.status}): ${(result.stderr || '').trim() || 'tanpa stderr'}`);
  return { status: result.status, stdout: (result.stdout || '').trim(), stderr: (result.stderr || '').trim() };
}

function newestBackupSince(directory, since) {
  const candidates = fs.readdirSync(directory)
    .filter((name) => /^orderguard-\d{8}T\d{6}Z\.dump(\.enc)?$/.test(name))
    .map((name) => path.join(directory, name))
    .filter((file) => fs.statSync(file).mtimeMs >= since - 1000)
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  if (!candidates.length) throw new Error('Backup baru tidak ditemukan setelah proses backup.');
  return candidates[0];
}

const TABLES = ['tenants', 'users', 'tenant_state', 'tenant_manifest_ids', 'state_quarantine', 'quarantine_recovery_audit', 'integrity_orphans', 'sessions', 'auth_audit'];

async function collectCounts(connectionString) {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    const existing = await client.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = ANY($1::text[])`,
      [TABLES],
    );
    const counts = {};
    for (const row of existing.rows) {
      if (!/^[a-z_][a-z0-9_]*$/.test(row.table_name)) continue;
      const result = await client.query(`SELECT COUNT(*)::BIGINT AS count FROM "${row.table_name}"`);
      counts[row.table_name] = Number(result.rows[0].count);
    }
    return counts;
  } finally {
    await client.end();
  }
}

async function main() {
  assertConfiguration();
  fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  const targetName = databaseName(targetUrl);

  const backupStart = Date.now();
  record('encrypted_backup', () => {
    const result = runNode('scripts/backup.js', [], {
      DATABASE_URL: sourceUrl,
      ORDERGUARD_BACKUP_DIR: backupDir,
      ORDERGUARD_BACKUP_ENCRYPTION_KEY: encryptionKey,
      ORDERGUARD_BACKUP_KEEP: process.env.ORDERGUARD_BACKUP_KEEP || '7',
    });
    return { output: result.stdout.split('\n').slice(-1)[0] };
  });
  const backupFile = record('locate_backup', () => newestBackupSince(backupDir, backupStart));
  steps[steps.length - 1].detail = { file: path.basename(backupFile) };

  record('restore_to_separate_database', () => {
    const result = runNode('scripts/restore.js', [backupFile], {
      DATABASE_URL: targetUrl,
      ORDERGUARD_CONFIRM_RESTORE: targetName,
      ORDERGUARD_BACKUP_ENCRYPTION_KEY: encryptionKey,
      ORDERGUARD_BACKUP_DIR: backupDir,
    });
    return { output: result.stdout.split('\n').slice(-1)[0] };
  });

  const sourceCounts = await collectCounts(sourceUrl);
  const targetCounts = await collectCounts(targetUrl);
  record('row_count_match', () => {
    const mismatches = Object.keys(sourceCounts).filter((table) => sourceCounts[table] !== targetCounts[table]);
    if (mismatches.length) {
      throw new Error(`Jumlah baris tidak cocok pada: ${mismatches.map((table) => `${table} (${sourceCounts[table]} != ${targetCounts[table]})`).join(', ')}`);
    }
    return { tables: Object.keys(sourceCounts).length, rows: Object.values(sourceCounts).reduce((sum, count) => sum + count, 0) };
  });

  record('wrong_key_rejected', () => {
    const wrongKey = crypto.randomBytes(32).toString('hex');
    const result = runNode('scripts/restore.js', [backupFile], {
      DATABASE_URL: targetUrl,
      ORDERGUARD_CONFIRM_RESTORE: targetName,
      ORDERGUARD_BACKUP_ENCRYPTION_KEY: wrongKey,
      ORDERGUARD_BACKUP_DIR: backupDir,
    }, { expectFailure: true });
    return { exitStatus: result.status };
  });

  if (runTamperCheck) {
    record('tampered_ciphertext_rejected', () => {
      const tamperedPath = path.join(backupDir, `tampered-${path.basename(backupFile)}`);
      const bytes = fs.readFileSync(backupFile);
      const offset = Math.floor(bytes.length / 2);
      bytes[offset] ^= 0xff;
      fs.writeFileSync(tamperedPath, bytes, { mode: 0o600 });
      fs.copyFileSync(`${backupFile}.meta.json`, `${tamperedPath}.meta.json`);
      try {
        const result = runNode('scripts/restore.js', [tamperedPath], {
          DATABASE_URL: targetUrl,
          ORDERGUARD_CONFIRM_RESTORE: targetName,
          ORDERGUARD_BACKUP_ENCRYPTION_KEY: encryptionKey,
          ORDERGUARD_BACKUP_DIR: backupDir,
        }, { expectFailure: true });
        return { exitStatus: result.status };
      } finally {
        fs.rmSync(tamperedPath, { force: true });
        fs.rmSync(`${tamperedPath}.meta.json`, { force: true });
      }
    });
  }

  const report = {
    generatedAt: new Date().toISOString(),
    status: 'pass',
    sourceDatabase: databaseName(sourceUrl),
    targetDatabase: targetName,
    backupFile: path.basename(backupFile),
    encryption: 'aes-256-gcm',
    steps,
    counts: sourceCounts,
    durationMs: Date.now() - startedAt,
  };
  if (reportPath) {
    fs.mkdirSync(path.dirname(path.resolve(reportPath)), { recursive: true });
    fs.writeFileSync(path.resolve(reportPath), JSON.stringify(report, null, 2), { mode: 0o600 });
  }
  console.log(JSON.stringify(report, null, 2));
  if (!keepBackups) fs.rmSync(backupDir, { recursive: true, force: true });
}

main().catch(async (error) => {
  const report = {
    generatedAt: new Date().toISOString(),
    status: 'fail',
    sourceDatabase: sourceUrl ? databaseName(sourceUrl) : null,
    targetDatabase: targetUrl ? databaseName(targetUrl) : null,
    error: error.message,
    steps,
    durationMs: Date.now() - startedAt,
  };
  if (reportPath) {
    fs.mkdirSync(path.dirname(path.resolve(reportPath)), { recursive: true });
    fs.writeFileSync(path.resolve(reportPath), JSON.stringify(report, null, 2), { mode: 0o600 });
  }
  console.error(JSON.stringify(report, null, 2));
  await sendAlert({ title: 'OrderGuard restore drill gagal', message: error.message, severity: 'critical' });
  process.exitCode = 1;
});
