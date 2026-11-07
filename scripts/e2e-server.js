const { Client } = require('pg');
const { spawn } = require('node:child_process');
const path = require('node:path');

const databaseUrl = process.env.DATABASE_URL;
const schema = process.env.DATABASE_SCHEMA || 'orderguard_e2e';
if (!databaseUrl) throw new Error('DATABASE_URL wajib diatur untuk E2E.');

(async () => {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await client.query(`CREATE SCHEMA "${schema}"`);
  } finally {
    await client.end();
  }

  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      DATABASE_SCHEMA: schema,
      NODE_ENV: 'test',
      ORDERGUARD_TEST_SEED_DEMO: '1',
    },
    stdio: 'inherit',
  });
  const shutdown = (signal) => {
    if (child.exitCode === null) child.kill(signal);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  child.on('exit', (code) => process.exit(code ?? 1));
})().catch((error) => {
  console.error(`E2E server gagal: ${error.message}`);
  process.exit(1);
});
