const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const databaseUrl = process.env.DATABASE_URL;
const backupDirectory = path.resolve(process.env.ORDERGUARD_BACKUP_DIR || path.join(__dirname, '..', 'data', 'backups'));
const backupPath = process.argv[2] ? path.resolve(process.argv[2]) : '';
const timestamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');

function postgresEnvironment() {
  if (!databaseUrl) throw new Error('DATABASE_URL wajib diatur untuk restore PostgreSQL.');
  const url = new URL(databaseUrl);
  return {
    PGHOST: url.hostname,
    PGPORT: url.port || '5432',
    PGDATABASE: decodeURIComponent(url.pathname.slice(1)),
    PGUSER: decodeURIComponent(url.username),
    ...(url.password ? { PGPASSWORD: decodeURIComponent(url.password) } : {}),
    ...(url.searchParams.get('sslmode') ? { PGSSLMODE: url.searchParams.get('sslmode') } : {}),
  };
}

function run(command, args) {
  const result = spawnSync(command, args, { env: { ...process.env, ...postgresEnvironment() }, encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr.trim() || `${command} exited with status ${result.status}.`);
}

try {
  if (!backupPath || !fs.existsSync(backupPath) || path.extname(backupPath) !== '.dump') {
    throw new Error('Berikan path file backup PostgreSQL .dump yang tersedia.');
  }
  run('pg_restore', ['--list', backupPath]);

  fs.mkdirSync(backupDirectory, { recursive: true, mode: 0o700 });
  fs.chmodSync(backupDirectory, 0o700);
  const safetyBackupPath = path.join(backupDirectory, `orderguard-pre-restore-${timestamp}.dump`);
  run('pg_dump', ['--format=custom', '--no-owner', '--no-acl', '--file', safetyBackupPath]);
  fs.chmodSync(safetyBackupPath, 0o600);
  run('pg_restore', ['--clean', '--if-exists', '--no-owner', '--no-acl', '--exit-on-error', backupPath]);
  console.log(`Database PostgreSQL dipulihkan dari ${backupPath}. Backup sebelum restore: ${safetyBackupPath}`);
} catch (error) {
  console.error(`Restore gagal: ${error.message}`);
  process.exitCode = 1;
}
