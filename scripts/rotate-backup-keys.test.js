const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { decryptFile, encryptFile, sha256File, keyId, decodeKey } = require('./backup-crypto');
const { rotateBackupFile, inspectBackupFile } = require('./rotate-backup-keys');

const OLD_KEY = 'e'.repeat(64);
const NEW_KEY = 'f'.repeat(64);

async function createEncryptedBackup(directory) {
  const plainPath = path.join(directory, 'source.dump');
  const encryptedPath = path.join(directory, 'orderguard-20261108T000000Z.dump.enc');
  fs.writeFileSync(plainPath, Buffer.from('database backup payload ✓'));
  const metadata = { ...(await encryptFile(plainPath, encryptedPath, OLD_KEY)), encrypted: true, counts: { tenants: 2, users: 1 } };
  fs.writeFileSync(`${encryptedPath}.meta.json`, JSON.stringify(metadata, null, 2));
  fs.writeFileSync(`${encryptedPath}.sha256`, `${sha256File(encryptedPath)}  ${path.basename(encryptedPath)}\n`);
  return { plainPath, encryptedPath, metadata };
}

test('key rotation re-encrypts, verifies, archives the original, and preserves metadata counts', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orderguard-rotate-test-'));
  try {
    const { plainPath, encryptedPath, metadata } = await createEncryptedBackup(directory);
    const before = inspectBackupFile(encryptedPath, [OLD_KEY]);
    assert.equal(before.canDecrypt, true);
    assert.equal(before.keyId, metadata.keyId);

    const result = await rotateBackupFile(encryptedPath, { keys: [OLD_KEY], newEncryptionKey: NEW_KEY });
    assert.equal(result.previousKeyId, metadata.keyId);
    assert.equal(result.keyId, keyId(decodeKey(NEW_KEY)));
    assert.deepEqual(result.counts, { tenants: 2, users: 1 });

    const newMetadata = JSON.parse(fs.readFileSync(`${encryptedPath}.meta.json`, 'utf8'));
    assert.equal(newMetadata.keyId, keyId(decodeKey(NEW_KEY)));
    assert.equal(newMetadata.previousKeyId, metadata.keyId);
    assert.deepEqual(newMetadata.counts, { tenants: 2, users: 1 });

    const restoredPath = path.join(directory, 'restored.dump');
    await decryptFile(encryptedPath, restoredPath, NEW_KEY, newMetadata);
    assert.deepEqual(fs.readFileSync(restoredPath), fs.readFileSync(plainPath));
    await assert.rejects(() => decryptFile(encryptedPath, path.join(directory, 'old.dump'), OLD_KEY, newMetadata), /authentication|unable|bad decrypt|tag|ciphertext/i);

    const archivedPath = path.join(directory, result.archived);
    assert.equal(fs.existsSync(archivedPath), true);
    assert.equal(fs.existsSync(`${archivedPath}.meta.json`), true);
    assert.equal(fs.existsSync(`${archivedPath}.sha256`), true);
    await decryptFile(archivedPath, path.join(directory, 'archived.dump'), OLD_KEY, JSON.parse(fs.readFileSync(`${archivedPath}.meta.json`, 'utf8')));
    assert.deepEqual(fs.readFileSync(path.join(directory, 'archived.dump')), fs.readFileSync(plainPath));
    assert.equal(fs.existsSync(`${encryptedPath}.rotating.enc`), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('key rotation fails safely without a matching key and leaves the original intact', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orderguard-rotate-fail-'));
  try {
    const { encryptedPath } = await createEncryptedBackup(directory);
    const originalBytes = fs.readFileSync(encryptedPath);
    await assert.rejects(
      () => rotateBackupFile(encryptedPath, { keys: ['9'.repeat(64)], newEncryptionKey: NEW_KEY }),
      /Dekripsi backup|authentication|tag/i,
    );
    assert.deepEqual(fs.readFileSync(encryptedPath), originalBytes);
    assert.equal(fs.existsSync(`${encryptedPath}.pre-rotation.enc`), false);
    assert.equal(fs.existsSync(`${encryptedPath}.rotating.enc`), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
