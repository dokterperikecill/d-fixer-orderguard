const { createPool } = require('../database');
const { auditIntegrity, validateConstraints } = require('./integrity-lib');

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const confirmIndex = args.indexOf('--confirm');
const confirmation = confirmIndex >= 0 ? args[confirmIndex + 1] : process.env.ORDERGUARD_CONFIRM_VALIDATE_CONSTRAINTS;

function databaseName(databaseUrl) {
  if (!databaseUrl) throw new Error('DATABASE_URL wajib diatur.');
  return decodeURIComponent(new URL(databaseUrl).pathname.slice(1));
}

async function runValidation(db, { apply = false, lockTimeout = '5s', statementTimeout = '60s' } = {}) {
  const before = await auditIntegrity(db);
  const pending = before.constraints.filter((constraint) => !constraint.convalidated);
  const blockers = {
    orphans: before.orphans,
    crossTenantReferences: before.crossTenantReferences,
    duplicateManifests: before.duplicateManifests,
  };
  if (!apply) {
    return { applied: false, pending, blockers, validation: [] };
  }
  if (before.orphans.length || before.crossTenantReferences.length) {
    return {
      applied: false,
      blocked: 'Validasi constraint diblokir: masih ada orphan atau referensi lintas tenant. Jalankan audit dan rekonsiliasi terlebih dahulu.',
      pending,
      blockers,
      validation: [],
    };
  }
  const validation = await db.transaction(async (tx) => {
    await tx.exec(`SET LOCAL lock_timeout = '${lockTimeout}'`);
    await tx.exec(`SET LOCAL statement_timeout = '${statementTimeout}'`);
    return validateConstraints(tx);
  });
  return { applied: true, pending, blockers, validation };
}

async function main() {
  const target = databaseName(process.env.DATABASE_URL);
  if (apply && confirmation !== target) {
    throw new Error(`Validasi constraint membutuhkan --confirm ${target}.`);
  }
  const db = createPool();
  try {
    const report = await runValidation(db, { apply });
    console.log(JSON.stringify({ generatedAt: new Date().toISOString(), database: target, confirmationRequired: target, ...report }, null, 2));
    if (!apply || (!report.applied && report.blocked)) process.exitCode = 2;
  } finally {
    await db.pool.end();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`Validasi constraint gagal: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { runValidation };
