const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pruneOldBackups } = require('./backup');

test('backup retention keeps the newest N backups and removes old sidecars without touching rotation archives', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orderguard-retention-'));
  const names = [
    'orderguard-20261101T000000Z.dump.enc',
    'orderguard-20261102T000000Z.dump.enc',
    'orderguard-20261103T000000Z.dump.enc',
  ];
  try {
    for (const name of names) {
      const file = path.join(directory, name);
      fs.writeFileSync(file, 'backup');
      fs.writeFileSync(`${file}.meta.json`, '{}');
      fs.writeFileSync(`${file}.sha256`, 'checksum');
    }
    const archive = path.join(directory, `${names[0]}.pre-rotation.enc`);
    fs.writeFileSync(archive, 'old encrypted backup');
    fs.writeFileSync(`${archive}.meta.json`, '{}');
    fs.writeFileSync(`${archive}.sha256`, 'checksum');

    const removed = pruneOldBackups(directory, 2);
    assert.deepEqual(removed, [names[0]]);
    assert.equal(fs.existsSync(path.join(directory, names[0])), false);
    assert.equal(fs.existsSync(path.join(directory, `${names[0]}.meta.json`)), false);
    assert.equal(fs.existsSync(path.join(directory, `${names[0]}.sha256`)), false);
    assert.equal(fs.existsSync(path.join(directory, names[1])), true);
    assert.equal(fs.existsSync(path.join(directory, names[2])), true);
    assert.equal(fs.existsSync(archive), true);
    assert.equal(fs.existsSync(`${archive}.meta.json`), true);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
