const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function defaultRun(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr.trim() || `${command} exited with status ${result.status}.`);
}

function copyOffsite(files, { run = defaultRun, env = process.env, warn = console.warn } = {}) {
  const s3Uri = env.ORDERGUARD_BACKUP_OFFSITE_S3_URI;
  const rcloneRemote = env.ORDERGUARD_BACKUP_OFFSITE_RCLONE_REMOTE;
  const localDirectory = env.ORDERGUARD_BACKUP_OFFSITE_DIR;

  if (s3Uri && rcloneRemote) {
    warn('Peringatan: ORDERGUARD_BACKUP_OFFSITE_S3_URI dan ORDERGUARD_BACKUP_OFFSITE_RCLONE_REMOTE sama-sama diatur; S3 diprioritaskan.');
  }
  if (s3Uri) {
    const base = s3Uri.replace(/\/+$/, '');
    for (const file of files) run('aws', ['s3', 'cp', file, `${base}/${path.basename(file)}`]);
    return { mode: 's3', destination: base };
  }
  if (rcloneRemote) {
    const base = rcloneRemote.replace(/\/+$/, '');
    for (const file of files) run('rclone', ['copyto', file, `${base}/${path.basename(file)}`]);
    return { mode: 'rclone', destination: base };
  }
  if (localDirectory) {
    const directory = path.resolve(localDirectory);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.chmodSync(directory, 0o700);
    for (const file of files) fs.copyFileSync(file, path.join(directory, path.basename(file)));
    warn('Peringatan: ORDERGUARD_BACKUP_OFFSITE_DIR adalah mirror filesystem lokal, bukan off-site terpisah. Gunakan S3/rclone untuk off-site sebenarnya.');
    return { mode: 'local-mirror', destination: directory };
  }
  return { mode: 'none', destination: '' };
}

module.exports = { copyOffsite };
