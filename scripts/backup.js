const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

const appDir = path.resolve(__dirname, '..');
const databasePath = path.resolve(process.env.ORDERGUARD_DB_PATH || path.join(appDir, 'data', 'orderguard.db'));
const backupDirectory = path.resolve(process.env.ORDERGUARD_BACKUP_DIR || path.join(appDir, 'data', 'backups'));
const configuredKeepCount = Number.parseInt(process.env.ORDERGUARD_BACKUP_KEEP || '30', 10);
const keepCount = Number.isInteger(configuredKeepCount) && configuredKeepCount > 0 ? configuredKeepCount : 30;
const timestamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
const backupPath = path.join(backupDirectory, `orderguard-${timestamp}.sqlite`);

async function main() {
  if (!fs.existsSync(databasePath)) throw new Error(`Database tidak ditemukan: ${databasePath}`);
  if (path.dirname(backupPath) === path.dirname(databasePath) && backupPath === databasePath) throw new Error('Lokasi backup tidak boleh sama dengan database aktif.');
  fs.mkdirSync(backupDirectory, { recursive: true, mode: 0o700 });
  fs.chmodSync(backupDirectory, 0o700);

  const database = new Database(databasePath, { fileMustExist: true });
  try {
    await database.backup(backupPath);
  } finally {
    database.close();
  }

  fs.chmodSync(backupPath, 0o600);
  const verification = new Database(backupPath, { readonly: true, fileMustExist: true });
  try {
    const result = verification.pragma('integrity_check', { simple: true });
    if (result !== 'ok') throw new Error(`Backup tidak lolos integrity_check: ${result}`);
  } finally {
    verification.close();
  }

  const backups = fs.readdirSync(backupDirectory)
    .filter((name) => /^orderguard-\d{8}T\d{6}Z\.sqlite$/.test(name))
    .sort()
    .reverse();
  for (const oldBackup of backups.slice(keepCount)) fs.unlinkSync(path.join(backupDirectory, oldBackup));
  console.log(`Backup valid: ${backupPath}`);
}

main().catch((error) => {
  console.error(`Backup gagal: ${error.message}`);
  process.exitCode = 1;
});