const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { decodeKey, encryptFile, decryptFile, keyId } = require('./backup-crypto');

const KEY = 'a'.repeat(64);

test('backup encryption round-trips and verifies AES-256-GCM authentication', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orderguard-crypto-'));
  const plain = path.join(directory, 'source.dump');
  const encrypted = path.join(directory, 'source.dump.enc');
  const restored = path.join(directory, 'restored.dump');
  fs.writeFileSync(plain, Buffer.from('backup payload with unicode ✓'));
  try {
    const metadata = await encryptFile(plain, encrypted, KEY);
    assert.equal(metadata.algorithm, 'aes-256-gcm');
    assert.equal(metadata.keyId, keyId(decodeKey(KEY)));
    assert.notEqual(fs.readFileSync(encrypted).toString('utf8'), fs.readFileSync(plain).toString('utf8'));
    await decryptFile(encrypted, restored, KEY, metadata);
    assert.deepEqual(fs.readFileSync(restored), fs.readFileSync(plain));
    fs.appendFileSync(encrypted, 'x');
    await assert.rejects(() => decryptFile(encrypted, restored, KEY, metadata), /ciphertext|dekripsi|authentication/i);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('backup encryption rejects a wrong key and invalid key format', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orderguard-crypto-'));
  const plain = path.join(directory, 'source.dump');
  const encrypted = path.join(directory, 'source.dump.enc');
  const restored = path.join(directory, 'restored.dump');
  fs.writeFileSync(plain, 'secret backup');
  try {
    const metadata = await encryptFile(plain, encrypted, KEY);
    await assert.rejects(() => decryptFile(encrypted, restored, 'b'.repeat(64), metadata), /authentication|unable|bad decrypt|tag/i);
    assert.throws(() => decodeKey('not-a-valid-key'), /32 byte/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('key rotation restores an old backup with the previous key and rejects the new key', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orderguard-rotation-'));
  const plain = path.join(directory, 'source.dump');
  const encrypted = path.join(directory, 'source.dump.enc');
  const restored = path.join(directory, 'restored.dump');
  const rejected = path.join(directory, 'rejected.dump');
  const previousKey = 'c'.repeat(64);
  const currentKey = 'd'.repeat(64);
  fs.writeFileSync(plain, 'backup before key rotation');
  try {
    const metadata = await encryptFile(plain, encrypted, previousKey);
    assert.equal(metadata.keyId, keyId(decodeKey(previousKey)));
    assert.notEqual(metadata.keyId, keyId(decodeKey(currentKey)));
    await decryptFile(encrypted, restored, previousKey, metadata);
    assert.deepEqual(fs.readFileSync(restored), fs.readFileSync(plain));
    await assert.rejects(() => decryptFile(encrypted, rejected, currentKey, metadata), /authentication|unable|bad decrypt|tag|ciphertext/i);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
