const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { Client } = require('pg');
const { encryptFile, sha256File } = require('./backup-crypto');
const { copyOffsite } = require('./backup-offsite');

const databaseUrl = process.env.DATABASE_URL;
const backupDirectory = path.resolve(process.env.ORDERGUARD_BACKUP_DIR || path.join(__dirname, '..', 'data', 'backups'));
const configuredKeepCount = Number.parseInt(process.env.ORDERGUARD_BACKUP_KEEP || '30', 10);
const keepCount = Number.isInteger(configuredKeepCount) && configuredKeepCount > 0 ? configuredKeepCount : 30;
const timestamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
const encryptionKey = process.env.ORDERGUARD_BACKUP_ENCRYPTION_KEY || '';
const allowPlaintext = process.env.ORDERGUARD_BACKUP_ALLOW_PLAINTEXT === '1';
let offsiteDestination = '';

const plainPath = path.join(backupDirectory, `orderguard-${timestamp}.dump`);
const encryptedPath = `${plainPath}.enc`;
const tempPath = `${plainPath}.tmp`;
const encryptedMetadataPath = `${encryptedPath}.meta.json`;
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

async function collectCounts() {
  const schema = process.env.DATABASE_SCHEMA;
  const client = new Client({ connectionString: databaseUrl, ...(schema ? { options: `-c search_path=${schema}` } : {}) });
  await client.connect();
  try {
    const tables = ['tenants', 'users', 'tenant_state', 'tenant_manifest_ids', 'state_quarantine', 'quarantine_recovery_audit', 'integrity_orphans', 'sessions', 'auth_audit'];
    const existing = await client.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = ANY($1::text[])`, [tables]);
    const counts = {};
    for (const row of existing.rows) {
      const table = row.table_name;
      if (!/^[a-z_][a-z0-9_]*$/.test(table)) continue;
      const result = await client.query(`SELECT COUNT(*)::BIGINT AS count FROM "${table}"`);
      counts[table] = Number(result.rows[0].count);
    }
    return counts;
  } finally {
    await client.end();
  }
}

function writeChecksum(filePath) {
  const checksumPathForFile = `${filePath}.sha256`;
  fs.writeFileSync(checksumPathForFile, `${sha256File(filePath)}  ${path.basename(filePath)}\n`, { mode: 0o600 });
  fs.chmodSync(checksumPathForFile, 0o600);
  return checksumPathForFile;
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

    const counts = await collectCounts();
    if (encryptionKey) {
      const metadata = { ...(await encryptFile(tempPath, encryptedPath, encryptionKey)), encrypted: true, counts };
      fs.writeFileSync(encryptedMetadataPath, JSON.stringify(metadata, null, 2), { mode: 0o600 });
      fs.chmodSync(encryptedMetadataPath, 0o600);
      const encryptedChecksum = writeChecksum(encryptedPath);
      createdFiles = [encryptedPath, encryptedMetadataPath, encryptedChecksum];
      finalPath = encryptedPath;
      fs.unlinkSync(tempPath);
    } else {
      fs.renameSync(tempPath, plainPath);
      const metadataPathForPlain = `${plainPath}.meta.json`;
      fs.writeFileSync(metadataPathForPlain, JSON.stringify({ version: 1, encrypted: false, counts, createdAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
      fs.chmodSync(metadataPathForPlain, 0o600);
      const plainChecksum = writeChecksum(plainPath);
      createdFiles = [plainPath, metadataPathForPlain, plainChecksum];
      finalPath = plainPath;
      console.warn('Peringatan: backup disimpan tanpa enkripsi karena ORDERGUARD_BACKUP_ALLOW_PLAINTEXT=1.');
    }

    try {
      const offsite = copyOffsite(createdFiles);
      offsiteDestination = offsite.destination;
      if (offsite.mode === 'none') console.warn('Peringatan: backup tidak disalin off-site; konfigurasi S3/rclone diperlukan untuk disaster recovery.');
    } catch (offsiteError) {
      console.error(`Backup lokal valid, tetapi salinan off-site gagal: ${offsiteError.message}`);
      process.exitCode = 1;
    }
  } catch (error) {
    for (const file of [tempPath, encryptedPath, encryptedMetadataPath, checksumPath, plainPath, `${plainPath}.meta.json`, `${plainPath}.sha256`]) {
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

  console.log(`Backup PostgreSQL valid: ${finalPath} (sha256 ${sha256File(finalPath)})${offsiteDestination ? `; off-site: ${offsiteDestination}` : ''}`);
}

main().catch((error) => {
  console.error(`Backup gagal: ${error.message}`);
  process.exitCode = 1;
});
