const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

const appDir = path.resolve(__dirname, '..');
const databasePath = path.resolve(process.env.ORDERGUARD_DB_PATH || path.join(appDir, 'data', 'orderguard.db'));
const backupDirectory = path.resolve(process.env.ORDERGUARD_BACKUP_DIR || path.join(appDir, 'data', 'backups'));
const backupPath = process.argv[2] ? path.resolve(process.argv[2]) : '';
const timestamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');

function verifyDatabase(filePath) {
  const database = new Database(filePath, { readonly: true, fileMustExist: true });
  try {
    const integrity = database.pragma('integrity_check', { simple: true });
    if (integrity !== 'ok') throw new Error(`integrity_check gagal: ${integrity}`);
    const tables = new Set(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name));
    for (const required of ['users', 'tenants', 'tenant_state']) {
      if (!tables.has(required)) throw new Error(`Backup tidak memiliki tabel ${required}.`);
    }
  } finally {
    database.close();
  }
}

async function main() {
  if (!backupPath || !fs.existsSync(backupPath)) throw new Error('Berikan path file backup SQLite yang tersedia.');
  if (backupPath === databasePath) throw new Error('File backup dan database aktif tidak boleh sama.');
  verifyDatabase(backupPath);
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  fs.mkdirSync(backupDirectory, { recursive: true, mode: 0o700 });
  fs.chmodSync(backupDirectory, 0o700);

  const stagedPath = `${databasePath}.restore-${process.pid}.tmp`;
  const safetyBackupPath = path.join(backupDirectory, `orderguard-pre-restore-${timestamp}.sqlite`);
  let liveDatabase;
  try {
    if (fs.existsSync(databasePath)) {
      liveDatabase = new Database(databasePath, { fileMustExist: true });
      await liveDatabase.backup(safetyBackupPath);
      liveDatabase.close();
      liveDatabase = null;
      fs.chmodSync(safetyBackupPath, 0o600);
    }

    const backup = new Database(backupPath, { readonly: true, fileMustExist: true });
    try {
      await backup.backup(stagedPath);
    } finally {
      backup.close();
    }
    fs.chmodSync(stagedPath, 0o600);
    verifyDatabase(stagedPath);

    for (const suffix of ['-wal', '-shm']) {
      const sidecar = `${databasePath}${suffix}`;
      if (fs.existsSync(sidecar)) fs.unlinkSync(sidecar);
    }
    fs.renameSync(stagedPath, databasePath);
    verifyDatabase(databasePath);
    console.log(`Database dipulihkan dari ${backupPath}${fs.existsSync(safetyBackupPath) ? `. Backup sebelum restore: ${safetyBackupPath}` : ''}`);
  } catch (error) {
    liveDatabase?.close();
    if (fs.existsSync(stagedPath)) fs.unlinkSync(stagedPath);
    throw error;
  }
}

main().catch((error) => {
  console.error(`Restore gagal: ${error.message}`);
  process.exitCode = 1;
});