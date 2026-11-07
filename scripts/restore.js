const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { decryptFile, encryptFile, sha256File } = require('./backup-crypto');

const databaseUrl = process.env.DATABASE_URL;
const backupDirectory = path.resolve(process.env.ORDERGUARD_BACKUP_DIR || path.join(__dirname, '..', 'data', 'backups'));
const backupPath = process.argv[2] ? path.resolve(process.argv[2]) : '';
const timestamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
const currentKey = process.env.ORDERGUARD_BACKUP_ENCRYPTION_KEY || '';
const previousKeys = String(process.env.ORDERGUARD_BACKUP_PREVIOUS_ENCRYPTION_KEYS || '').split(',').map((value) => value.trim()).filter(Boolean);

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

function databaseName() {
  if (!databaseUrl) throw new Error('DATABASE_URL wajib diatur untuk restore PostgreSQL.');
  return decodeURIComponent(new URL(databaseUrl).pathname.slice(1));
}

function run(command, args) {
  const result = spawnSync(command, args, { env: { ...process.env, ...postgresEnvironment() }, encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr.trim() || `${command} exited with status ${result.status}.`);
  return result.stdout;
}

function expectedChecksum(filePath) {
  const checksumPath = `${filePath}.sha256`;
  if (!fs.existsSync(checksumPath)) {
    console.warn('Peringatan: file checksum .sha256 tidak ditemukan; validasi integritas hanya memakai pg_restore --list.');
    return null;
  }
  return fs.readFileSync(checksumPath, 'utf8').trim().split(/\s+/)[0];
}

async function preparePlainbackup(tempDirectory) {
  if (!fs.existsSync(backupPath) || !['.dump', '.enc'].includes(path.extname(backupPath))) {
    throw new Error('Berikan path file backup PostgreSQL .dump atau .dump.enc yang tersedia.');
  }
  if (path.extname(backupPath) === '.enc') {
    const metadataPath = `${backupPath}.meta.json`;
    if (!fs.existsSync(metadataPath)) throw new Error('Metadata enkripsi backup tidak ditemukan.');
    if (!currentKey && !previousKeys.length) throw new Error('ORDERGUARD_BACKUP_ENCRYPTION_KEY wajib diatur untuk restore backup terenkripsi.');
    const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
    const checksum = expectedChecksum(backupPath);
    if (checksum && checksum !== sha256File(backupPath)) throw new Error('Checksum ciphertext backup tidak cocok.');
    const plainPath = path.join(tempDirectory, 'restore.dump');
    const keys = [currentKey, ...previousKeys].filter(Boolean);
    let lastError = null;
    for (const key of keys) {
      try {
        await decryptFile(backupPath, plainPath, key, metadata);
        return plainPath;
      } catch (error) {
        lastError = error;
        if (fs.existsSync(plainPath)) fs.unlinkSync(plainPath);
      }
    }
    throw new Error(`Dekripsi backup gagal dengan seluruh encryption key yang tersedia: ${lastError?.message || 'unknown error'}`);
  }

  const checksum = expectedChecksum(backupPath);
  if (checksum && checksum !== sha256File(backupPath)) throw new Error('Checksum backup tidak cocok. File backup mungkin rusak atau berubah.');
  return backupPath;
}

async function main() {
  if (!backupPath) throw new Error('Berikan path file backup PostgreSQL.');
  const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'orderguard-restore-'));
  try {
    const restoreSource = await preparePlainbackup(tempDirectory);
    run('pg_restore', ['--list', restoreSource]);

    const target = databaseName();
    const confirmation = process.env.ORDERGUARD_CONFIRM_RESTORE || '';
    if (confirmation !== target) {
      throw new Error(`Konfirmasi restore diperlukan. Set ORDERGUARD_CONFIRM_RESTORE=${target} untuk database target.`);
    }

    fs.mkdirSync(backupDirectory, { recursive: true, mode: 0o700 });
    fs.chmodSync(backupDirectory, 0o700);
    const safetyBackupPath = path.join(backupDirectory, `orderguard-pre-restore-${timestamp}.dump`);
    run('pg_dump', ['--format=custom', '--no-owner', '--no-acl', '--file', safetyBackupPath]);
    fs.chmodSync(safetyBackupPath, 0o600);
    let safetyFinalPath = safetyBackupPath;
    if (currentKey) {
      const encryptedSafetyPath = `${safetyBackupPath}.enc`;
      const metadata = await encryptFile(safetyBackupPath, encryptedSafetyPath, currentKey);
      fs.writeFileSync(`${encryptedSafetyPath}.meta.json`, JSON.stringify(metadata, null, 2), { mode: 0o600 });
      fs.chmodSync(`${encryptedSafetyPath}.meta.json`, 0o600);
      fs.writeFileSync(`${encryptedSafetyPath}.sha256`, `${sha256File(encryptedSafetyPath)}  ${path.basename(encryptedSafetyPath)}\n`, { mode: 0o600 });
      fs.chmodSync(`${encryptedSafetyPath}.sha256`, 0o600);
      fs.unlinkSync(safetyBackupPath);
      safetyFinalPath = encryptedSafetyPath;
    }
    run('pg_restore', ['--clean', '--if-exists', '--single-transaction', '--no-owner', '--no-acl', '--exit-on-error', '--dbname', target, restoreSource]);

    const tableCount = Number(run('psql', ['--dbname', target, '--tuples-only', '--no-align', '--command', "SELECT COUNT(*) FROM information_schema.tables WHERE table_name = 'tenants'"]).trim());
    if (!Number.isInteger(tableCount) || tableCount < 1) {
      throw new Error('Verifikasi pasca-restore gagal: tabel tenants tidak ditemukan.');
    }
    console.log(`Database PostgreSQL dipulihkan dari ${backupPath}. Backup sebelum restore: ${safetyFinalPath}`);
  } finally {
    fs.rmSync(tempDirectory, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(`Restore gagal: ${error.message}`);
  process.exitCode = 1;
});
