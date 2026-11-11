const { createPool } = require('../database');
const { reconcileIntegrity } = require('./integrity-lib');

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const confirmIndex = args.indexOf('--confirm');
const confirmation = confirmIndex >= 0 ? args[confirmIndex + 1] : process.env.ORDERGUARD_CONFIRM_INTEGRITY;
const databaseName = decodeURIComponent(new URL(process.env.DATABASE_URL || '').pathname.slice(1));
const db = createPool();

(async () => {
  try {
    if (apply && confirmation !== databaseName) {
      throw new Error(`Rekonsiliasi membutuhkan --confirm ${databaseName}. Audit/rekonsiliasi tidak menghapus data tanpa konfirmasi.`);
    }
    const report = await reconcileIntegrity(db, { apply });
    console.log(JSON.stringify({ generatedAt: new Date().toISOString(), confirmationRequired: databaseName, ...report }, null, 2));
    if (!report.applied) {
      process.exitCode = 2;
    }
  } finally {
    await db.pool.end();
  }
})().catch(async (error) => {
  console.error(`Rekonsiliasi integritas gagal: ${error.message}`);
  process.exitCode = 1;
  await db.pool.end();
});
