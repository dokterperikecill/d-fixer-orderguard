const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { copyOffsite } = require('./backup-offsite');

test('off-site S3 transport issues one aws copy per file', () => {
  const calls = [];
  const warnings = [];
  const result = copyOffsite(['/backups/a.dump.enc', '/backups/a.dump.enc.meta.json'], {
    env: { ORDERGUARD_BACKUP_OFFSITE_S3_URI: 's3://bucket/prefix/' },
    run: (command, args) => calls.push([command, ...args]),
    warn: (message) => warnings.push(message),
  });
  assert.deepEqual(result, { mode: 's3', destination: 's3://bucket/prefix' });
  assert.deepEqual(calls, [
    ['aws', 's3', 'cp', '/backups/a.dump.enc', 's3://bucket/prefix/a.dump.enc'],
    ['aws', 's3', 'cp', '/backups/a.dump.enc.meta.json', 's3://bucket/prefix/a.dump.enc.meta.json'],
  ]);
  assert.deepEqual(warnings, []);
});

test('off-site rclone transport issues copyto per file and prefers S3 when both are set', () => {
  const calls = [];
  const warnings = [];
  const rcloneResult = copyOffsite(['/backups/b.dump.enc'], {
    env: { ORDERGUARD_BACKUP_OFFSITE_RCLONE_REMOTE: 'remote:orderguard/' },
    run: (command, args) => calls.push([command, ...args]),
    warn: (message) => warnings.push(message),
  });
  assert.deepEqual(rcloneResult, { mode: 'rclone', destination: 'remote:orderguard' });
  assert.deepEqual(calls, [['rclone', 'copyto', '/backups/b.dump.enc', 'remote:orderguard/b.dump.enc']]);

  const priorityCalls = [];
  const priorityWarnings = [];
  copyOffsite(['/backups/c.dump.enc'], {
    env: {
      ORDERGUARD_BACKUP_OFFSITE_S3_URI: 's3://bucket/prefix',
      ORDERGUARD_BACKUP_OFFSITE_RCLONE_REMOTE: 'remote:path',
    },
    run: (command, args) => priorityCalls.push([command, ...args]),
    warn: (message) => priorityWarnings.push(message),
  });
  assert.equal(priorityCalls[0][0], 'aws');
  assert.match(priorityWarnings[0], /S3 diprioritaskan/);
});

test('local mirror copies files and warns that it is not a separate off-site location', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orderguard-offsite-'));
  const source = path.join(directory, 'source.dump.enc');
  fs.writeFileSync(source, 'backup');
  const warnings = [];
  try {
    const result = copyOffsite([source], {
      env: { ORDERGUARD_BACKUP_OFFSITE_DIR: path.join(directory, 'mirror') },
      warn: (message) => warnings.push(message),
    });
    assert.equal(result.mode, 'local-mirror');
    assert.equal(fs.readFileSync(path.join(directory, 'mirror', 'source.dump.enc'), 'utf8'), 'backup');
    assert.match(warnings[0], /mirror filesystem lokal/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('off-site transport is a no-op when no destination is configured and propagates transport failures', () => {
  assert.deepEqual(copyOffsite(['/backups/a.dump.enc'], { env: {}, run: () => { throw new Error('must not run'); } }), { mode: 'none', destination: '' });
  assert.throws(() => copyOffsite(['/backups/a.dump.enc'], {
    env: { ORDERGUARD_BACKUP_OFFSITE_S3_URI: 's3://bucket/prefix' },
    run: () => { throw new Error('aws failed'); },
  }), /aws failed/);
});
