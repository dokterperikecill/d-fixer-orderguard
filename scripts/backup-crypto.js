const fs = require('node:fs');
const crypto = require('node:crypto');
const { pipeline } = require('node:stream/promises');

function decodeKey(value) {
  const text = String(value || '').trim();
  if (/^[a-f0-9]{64}$/i.test(text)) return Buffer.from(text, 'hex');
  try {
    const key = Buffer.from(text, 'base64');
    if (key.length === 32) return key;
  } catch {
    // Fall through to the uniform error below.
  }
  throw new Error('Kunci backup harus berupa 32 byte dalam format hex 64 karakter atau base64.');
}

function keyId(key) {
  return crypto.createHash('sha256').update(key).digest('hex').slice(0, 32);
}

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

async function encryptFile(inputPath, outputPath, keyValue) {
  const key = decodeKey(keyValue);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const plaintextSha256 = sha256File(inputPath);
  await pipeline(fs.createReadStream(inputPath), cipher, fs.createWriteStream(outputPath, { mode: 0o600 }));
  const tag = cipher.getAuthTag();
  const ciphertextSha256 = sha256File(outputPath);
  return {
    version: 1,
    algorithm: 'aes-256-gcm',
    keyId: keyId(key),
    iv: iv.toString('base64url'),
    tag: tag.toString('base64url'),
    plaintextSha256,
    ciphertextSha256,
    createdAt: new Date().toISOString(),
  };
}

async function decryptFile(inputPath, outputPath, keyValue, metadata) {
  const key = decodeKey(keyValue);
  if (!metadata || metadata.algorithm !== 'aes-256-gcm' || !metadata.iv || !metadata.tag) {
    throw new Error('Metadata enkripsi backup tidak valid.');
  }
  if (metadata.ciphertextSha256 && metadata.ciphertextSha256 !== sha256File(inputPath)) {
    throw new Error('Checksum ciphertext backup tidak cocok.');
  }
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(metadata.iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(metadata.tag, 'base64url'));
  await pipeline(fs.createReadStream(inputPath), decipher, fs.createWriteStream(outputPath, { mode: 0o600 }));
  if (metadata.plaintextSha256 && metadata.plaintextSha256 !== sha256File(outputPath)) {
    throw new Error('Checksum plaintext backup tidak cocok setelah dekripsi.');
  }
  return { plaintextSha256: metadata.plaintextSha256 || sha256File(outputPath) };
}

module.exports = { decodeKey, keyId, sha256File, encryptFile, decryptFile };
