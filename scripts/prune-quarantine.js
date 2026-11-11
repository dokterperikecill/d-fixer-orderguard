const { createPool } = require('../database');

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const confirmIndex = args.indexOf('--confirm');
const confirmation = confirmIndex >= 0 ? args[confirmIndex + 1] : process.env.ORDERGUARD_CONFIRM_QUARANTINE_PRUNE;
const databaseName = decodeURIComponent(new URL(process.env.DATABASE_URL || '').pathname.slice(1));
const retentionDays = Number.parseInt(process.env.ORDERGUARD_QUARANTINE_RETENTION_DAYS || '90', 10);
if (!Number.isInteger(retentionDays) || retentionDays < 1) throw new Error('ORDERGUARD_QUARANTINE_RETENTION_DAYS harus bilangan positif.');
const db = createPool();

(async () => {
  try {
    if (apply && confirmation !== databaseName) {
      throw new Error(`Prune quarantine membutuhkan --confirm ${databaseName}.`);
    }
    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
    const rows = await db.prepare(
      `SELECT q.id, q.tenant_id AS tenantId, q.created_at AS createdAt
       FROM state_quarantine q
       WHERE q.created_at < ?
         AND NOT EXISTS (SELECT 1 FROM quarantine_recovery_audit a WHERE a.quarantine_id = q.id)
       ORDER BY q.created_at`
    ).all(cutoff);
    if (apply) {
      await db.transaction(async (tx) => {
        for (const row of rows) await tx.prepare('DELETE FROM state_quarantine WHERE id = ?').run(row.id);
      });
    }
    console.log(JSON.stringify({ applied: apply, retentionDays, cutoff, candidates: rows, count: rows.length }, null, 2));
  } finally {
    await db.pool.end();
  }
})().catch(async (error) => {
  console.error(`Prune quarantine gagal: ${error.message}`);
  process.exitCode = 1;
  await db.pool.end();
});
