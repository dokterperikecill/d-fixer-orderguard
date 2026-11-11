const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { decodeKey, decryptFile, encryptFile, sha256File, keyId } = require('./backup-crypto');

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const confirmIndex = args.indexOf('--confirm');
const directoryIndex = args.indexOf('--dir');
const confirmation = confirmIndex >= 0 ? args[confirmIndex + 1] : process.env.ORDERGUARD_CONFIRM_ROTATE_KEYS;
const backupDirectory = path.resolve(directoryIndex >= 0 ? args[directoryIndex + 1] : (process.env.ORDERGUARD_BACKUP_DIR || path.join(__dirname, '..', 'data', 'backups')));
const newKey = process.env.ORDERGUARD_BACKUP_NEW_ENCRYPTION_KEY || '';
const decryptionKeys = [process.env.ORDERGUARD_BACKUP_ENCRYPTION_KEY || '', ...String(process.env.ORDERGUARD_BACKUP_PREVIOUS_ENCRYPTION_KEYS || '').split(',')]
  .map((value) => value.trim())
  .filter(Boolean);

function timestamp() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function readMetadata(filePath) {
  const metadataPath = `${filePath}.meta.json`;
  if (!fs.existsSync(filePath)) throw new Error(`Backup tidak ditemukan: ${filePath}`);
  if (!fs.existsSync(metadataPath)) throw new Error(`Metadata backup tidak ditemukan: ${metadataPath}`);
  const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
  if (!metadata || metadata.algorithm !== 'aes-256-gcm' || !metadata.iv || !metadata.tag) {
    throw new Error(`Metadata backup tidak valid: ${metadataPath}`);
  }
  return { metadata, metadataPath };
}

function keyMatchesMetadata(key, metadata) {
  try {
    return keyId(decodeKey(key)) === metadata.keyId;
  } catch {
    return false;
  }
}

function inspectBackupFile(filePath, keys = decryptionKeys) {
  const { metadata } = readMetadata(filePath);
  const matchingKey = keys.find((key) => keyMatchesMetadata(key, metadata)) || null;
  return {
    file: path.basename(filePath),
    keyId: metadata.keyId,
    encrypted: true,
    canDecrypt: Boolean(matchingKey),
    counts: metadata.counts || null,
  };
}

async function rotateBackupFile(filePath, { keys = decryptionKeys, newEncryptionKey = newKey, tempRoot = os.tmpdir() } = {}) {
  if (!newEncryptionKey) throw new Error('ORDERGUARD_BACKUP_NEW_ENCRYPTION_KEY wajib diatur untuk rotasi kunci.');
  decodeKey(newEncryptionKey);
  const { metadata, metadataPath } = readMetadata(filePath);
  const tempDirectory = fs.mkdtempSync(path.join(tempRoot, 'orderguard-rotate-'));
  const plainPath = path.join(tempDirectory, 'plain.dump');
  const verifyPath = path.join(tempDirectory, 'verify.dump');
  const rotatingPath = `${filePath}.rotating.enc`;
  const rotatingMetadataPath = `${rotatingPath}.meta.json`;
  const rotatingChecksumPath = `${rotatingPath}.sha256`;
  let archivedPath = null;
  let completed = false;
  const cleanup = () => {
    for (const file of [plainPath, verifyPath, rotatingPath, rotatingMetadataPath, rotatingChecksumPath]) {
      if (fs.existsSync(file)) fs.unlinkSync(file);
    }
  };

  try {
    let lastError = null;
    let decrypted = false;
    for (const key of keys) {
      try {
        await decryptFile(filePath, plainPath, key, metadata);
        decrypted = true;
        break;
      } catch (error) {
        lastError = error;
        if (fs.existsSync(plainPath)) fs.unlinkSync(plainPath);
      }
    }
    if (!decrypted) throw new Error(`Dekripsi backup ${path.basename(filePath)} gagal: ${lastError?.message || 'tidak ada key yang cocok'}`);
    if (metadata.plaintextSha256 && sha256File(plainPath) !== metadata.plaintextSha256) {
      throw new Error(`Checksum plaintext ${path.basename(filePath)} tidak cocok setelah dekripsi.`);
    }

    const newMetadata = {
      ...(await encryptFile(plainPath, rotatingPath, newEncryptionKey)),
      encrypted: true,
      counts: metadata.counts || {},
      rotatedAt: new Date().toISOString(),
      previousKeyId: metadata.keyId,
    };
    fs.writeFileSync(rotatingMetadataPath, JSON.stringify(newMetadata, null, 2), { mode: 0o600 });
    fs.chmodSync(rotatingMetadataPath, 0o600);
    fs.writeFileSync(rotatingChecksumPath, `${sha256File(rotatingPath)}  ${path.basename(rotatingPath)}\n`, { mode: 0o600 });
    fs.chmodSync(rotatingChecksumPath, 0o600);

    await decryptFile(rotatingPath, verifyPath, newEncryptionKey, newMetadata);
    if (sha256File(verifyPath) !== sha256File(plainPath)) {
      throw new Error(`Verifikasi re-enkripsi ${path.basename(filePath)} gagal: plaintext berubah.`);
    }

    const preRotationPath = `${filePath}.pre-rotation.enc`;
    archivedPath = fs.existsSync(preRotationPath) ? `${filePath}.pre-rotation-${timestamp()}.enc` : preRotationPath;
    fs.chmodSync(filePath, 0o600);
    fs.renameSync(filePath, archivedPath);
    if (fs.existsSync(metadataPath)) fs.renameSync(metadataPath, `${archivedPath}.meta.json`);
    if (fs.existsSync(`${filePath}.sha256`)) fs.renameSync(`${filePath}.sha256`, `${archivedPath}.sha256`);
    fs.renameSync(rotatingPath, filePath);
    fs.renameSync(rotatingMetadataPath, metadataPath);
    fs.renameSync(rotatingChecksumPath, `${filePath}.sha256`);
    completed = true;

    return {
      file: path.basename(filePath),
      previousKeyId: metadata.keyId,
      keyId: newMetadata.keyId,
      archived: path.basename(archivedPath),
      counts: newMetadata.counts,
    };
  } catch (error) {
    cleanup();
    if (!completed && archivedPath && fs.existsSync(archivedPath)) {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      fs.renameSync(archivedPath, filePath);
      if (fs.existsSync(`${archivedPath}.meta.json`)) fs.renameSync(`${archivedPath}.meta.json`, metadataPath);
      if (fs.existsSync(`${archivedPath}.sha256`)) fs.renameSync(`${archivedPath}.sha256`, `${filePath}.sha256`);
    }
    throw error;
  } finally {
    fs.rmSync(tempDirectory, { recursive: true, force: true });
  }
}

async function main() {
  if (!fs.existsSync(backupDirectory)) throw new Error(`Direktori backup tidak ditemukan: ${backupDirectory}`);
  if (apply) {
    if (!newKey) throw new Error('ORDERGUARD_BACKUP_NEW_ENCRYPTION_KEY wajib diatur untuk --apply.');
    decodeKey(newKey);
    if (confirmation !== backupDirectory) {
      throw new Error(`Rotasi membutuhkan --confirm ${backupDirectory}.`);
    }
    if (!decryptionKeys.length) throw new Error('ORDERGUARD_BACKUP_ENCRYPTION_KEY atau ORDERGUARD_BACKUP_PREVIOUS_ENCRYPTION_KEYS wajib diatur.');
  }

  const files = fs.readdirSync(backupDirectory)
    .filter((name) => /^orderguard-.*\.dump\.enc$/.test(name))
    .sort()
    .map((name) => path.join(backupDirectory, name));
  if (!files.length) {
    console.log(JSON.stringify({ directory: backupDirectory, applied: false, files: [], message: 'Tidak ada backup .dump.enc.' }, null, 2));
    return;
  }

  if (!apply) {
    const inspected = files.map((file) => {
      try {
        return inspectBackupFile(file);
      } catch (error) {
        return { file: path.basename(file), error: error.message, canDecrypt: false };
      }
    });
    console.log(JSON.stringify({ directory: backupDirectory, applied: false, newKeyConfigured: Boolean(newKey), files: inspected }, null, 2));
    if (inspected.some((item) => item.error || !item.canDecrypt)) process.exitCode = 2;
    return;
  }

  const rotated = [];
  for (const file of files) rotated.push(await rotateBackupFile(file));
  console.log(JSON.stringify({ directory: backupDirectory, applied: true, rotated }, null, 2));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`Rotasi key backup gagal: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { rotateBackupFile, inspectBackupFile };
