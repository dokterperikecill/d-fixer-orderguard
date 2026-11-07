const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const databaseUrl = process.env.DATABASE_URL;
const backupDirectory = path.resolve(process.env.ORDERGUARD_BACKUP_DIR || path.join(__dirname, '..', 'data', 'backups'));
const configuredKeepCount = Number.parseInt(process.env.ORDERGUARD_BACKUP_KEEP || '30', 10);
const keepCount = Number.isInteger(configuredKeepCount) && configuredKeepCount > 0 ? configuredKeepCount : 30;
const timestamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
const backupPath = path.join(backupDirectory, `orderguard-${timestamp}.dump`);
const checksumPath = `${backupPath}.sha256`;

function postgresEnvironment() {
  if (!databaseUrl) throw new Error('DATABASE_URL wajib diatur untuk backup PostgreSQL.');
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
  return result.stdout;
}

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

try {
  fs.mkdirSync(backupDirectory, { recursive: true, mode: 0o700 });
  fs.chmodSync(backupDirectory, 0o700);
  run('pg_dump', ['--format=custom', '--no-owner', '--no-acl', '--file', backupPath]);
  fs.chmodSync(backupPath, 0o600);
  run('pg_restore', ['--list', backupPath]);
  fs.writeFileSync(checksumPath, `${sha256File(backupPath)}  ${path.basename(backupPath)}\n`, { mode: 0o600 });
  fs.chmodSync(checksumPath, 0o600);

  const backups = fs.readdirSync(backupDirectory)
    .filter((name) => /^orderguard-\d{8}T\d{6}Z\.dump$/.test(name))
    .sort()
    .reverse();
  for (const oldBackup of backups.slice(keepCount)) {
    fs.unlinkSync(path.join(backupDirectory, oldBackup));
    const oldChecksum = path.join(backupDirectory, `${oldBackup}.sha256`);
    if (fs.existsSync(oldChecksum)) fs.unlinkSync(oldChecksum);
  }
  console.log(`Backup PostgreSQL valid: ${backupPath} (sha256 ${sha256File(backupPath)})`);
} catch (error) {
  if (fs.existsSync(backupPath)) fs.unlinkSync(backupPath);
  if (fs.existsSync(checksumPath)) fs.unlinkSync(checksumPath);
  console.error(`Backup gagal: ${error.message}`);
  process.exitCode = 1;
}
