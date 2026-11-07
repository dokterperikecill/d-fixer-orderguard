const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { encryptFile, sha256File } = require('./backup-crypto');

const databaseUrl = process.env.DATABASE_URL;
const backupDirectory = path.resolve(process.env.ORDERGUARD_BACKUP_DIR || path.join(__dirname, '..', 'data', 'backups'));
const configuredKeepCount = Number.parseInt(process.env.ORDERGUARD_BACKUP_KEEP || '30', 10);
const keepCount = Number.isInteger(configuredKeepCount) && configuredKeepCount > 0 ? configuredKeepCount : 30;
const timestamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
const encryptionKey = process.env.ORDERGUARD_BACKUP_ENCRYPTION_KEY || '';
const allowPlaintext = process.env.ORDERGUARD_BACKUP_ALLOW_PLAINTEXT === '1';
const offsiteDirectory = process.env.ORDERGUARD_BACKUP_OFFSITE_DIR ? path.resolve(process.env.ORDERGUARD_BACKUP_OFFSITE_DIR) : '';

const plainPath = path.join(backupDirectory, `orderguard-${timestamp}.dump`);
const encryptedPath = `${plainPath}.enc`;
const tempPath = `${plainPath}.tmp`;
const metadataPath = `${encryptedPath}.meta.json`;
const checksumPath = `${encryptedPath}.sha256`;

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

function writeChecksum(filePath) {
  const checksumPathForFile = `${filePath}.sha256`;
  fs.writeFileSync(checksumPathForFile, `${sha256File(filePath)}  ${path.basename(filePath)}\n`, { mode: 0o600 });
  fs.chmodSync(checksumPathForFile, 0o600);
  return checksumPathForFile;
}

function copyOffsite(files) {
  if (!offsiteDirectory) return;
  fs.mkdirSync(offsiteDirectory, { recursive: true, mode: 0o700 });
  fs.chmodSync(offsiteDirectory, 0o700);
  for (const file of files) {
    if (fs.existsSync(file)) fs.copyFileSync(file, path.join(offsiteDirectory, path.basename(file)));
  }
}

async function main() {
  if (!encryptionKey && !allowPlaintext) {
    throw new Error('ORDERGUARD_BACKUP_ENCRYPTION_KEY wajib diatur untuk backup terenkripsi.');
  }
  fs.mkdirSync(backupDirectory, { recursive: true, mode: 0o700 });
  fs.chmodSync(backupDirectory, 0o700);

  let finalPath;
  let createdFiles = [];
  try {
    run('pg_dump', ['--format=custom', '--no-owner', '--no-acl', '--file', tempPath]);
    fs.chmodSync(tempPath, 0o600);
    run('pg_restore', ['--list', tempPath]);

    if (encryptionKey) {
      const metadata = await encryptFile(tempPath, encryptedPath, encryptionKey);
      fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2), { mode: 0o600 });
      fs.chmodSync(metadataPath, 0o600);
      const encryptedChecksum = writeChecksum(encryptedPath);
      createdFiles = [encryptedPath, metadataPath, encryptedChecksum];
      finalPath = encryptedPath;
      fs.unlinkSync(tempPath);
    } else {
      fs.renameSync(tempPath, plainPath);
      const plainChecksum = writeChecksum(plainPath);
      createdFiles = [plainPath, plainChecksum];
      finalPath = plainPath;
      console.warn('Peringatan: backup disimpan tanpa enkripsi karena ORDERGUARD_BACKUP_ALLOW_PLAINTEXT=1.');
    }

    try {
      copyOffsite(createdFiles);
    } catch (offsiteError) {
      console.error(`Backup lokal valid, tetapi salinan off-site gagal: ${offsiteError.message}`);
      process.exitCode = 1;
    }
  } catch (error) {
    for (const file of [tempPath, encryptedPath, metadataPath, checksumPath, plainPath, `${plainPath}.sha256`]) {
      if (fs.existsSync(file)) fs.unlinkSync(file);
    }
    throw error;
  }

  const backups = fs.readdirSync(backupDirectory)
    .filter((name) => /^orderguard-\d{8}T\d{6}Z\.dump(\.enc)?$/.test(name))
    .sort()
    .reverse();
  for (const oldBackup of backups.slice(keepCount)) {
    const oldPath = path.join(backupDirectory, oldBackup);
    const sidecars = [`${oldPath}.sha256`, `${oldPath}.meta.json`];
    fs.unlinkSync(oldPath);
    for (const sidecar of sidecars) if (fs.existsSync(sidecar)) fs.unlinkSync(sidecar);
  }

  console.log(`Backup PostgreSQL valid: ${finalPath} (sha256 ${sha256File(finalPath)})${offsiteDirectory ? `; off-site: ${offsiteDirectory}` : ''}`);
}

main().catch((error) => {
  console.error(`Backup gagal: ${error.message}`);
  process.exitCode = 1;
});
