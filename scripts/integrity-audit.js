const { createPool } = require('../database');
const { auditIntegrity } = require('./integrity-lib');

const db = createPool();

(async () => {
  try {
    const report = await auditIntegrity(db);
    console.log(JSON.stringify({ generatedAt: new Date().toISOString(), ...report }, null, 2));
    if (report.orphans.length || report.duplicateManifests.length) process.exitCode = 2;
  } finally {
    await db.pool.end();
  }
})().catch(async (error) => {
  console.error(`Audit integritas gagal: ${error.message}`);
  process.exitCode = 1;
  await db.pool.end();
});
