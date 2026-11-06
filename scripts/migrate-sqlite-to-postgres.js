const fs = require('node:fs');
const Database = require('better-sqlite3');
const { createPool } = require('../database');

const sourcePath = process.argv[2];
const TABLES = [
  'app_state',
  'tenants',
  'tenant_state',
  'tenant_audit',
  'users',
  'sessions',
  'tiktok_oauth_states',
  'tiktok_connections',
  'tiktok_shops',
  'employee_audit',
];

async function main() {
  if (!sourcePath || !fs.existsSync(sourcePath)) throw new Error('Gunakan: npm run db:migrate -- /path/ke/orderguard.db');
  const source = new Database(sourcePath, { readonly: true, fileMustExist: true });
  const target = createPool();
  const counts = {};

  try {
    await target.exec(target.schema);
    for (const table of TABLES) {
      const { count } = await target.prepare(`SELECT COUNT(*)::INTEGER AS count FROM "${table}"`).get();
      if (count > 0) throw new Error(`Tabel PostgreSQL "${table}" sudah berisi data. Migrasi dibatalkan agar tidak menimpa data.`);
    }

    await target.transaction(async (tx) => {
      const sourceTables = new Set(source.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(({ name }) => name));
      for (const table of TABLES) {
        if (!sourceTables.has(table)) continue;
        const columns = source.prepare(`PRAGMA table_info("${table}")`).all().map(({ name }) => name);
        const rows = source.prepare(`SELECT * FROM "${table}"`).all();
        if (!columns.length || !rows.length) {
          counts[table] = 0;
          continue;
        }
        const columnList = columns.map((column) => `"${column}"`).join(', ');
        const valueList = columns.map(() => '?').join(', ');
        const insert = tx.prepare(`INSERT INTO "${table}" (${columnList}) VALUES (${valueList})`);
        for (const row of rows) {
          const values = columns.map((column) => table === 'users' && column === 'active' ? Boolean(row[column]) : row[column]);
          await insert.run(...values);
        }
        counts[table] = rows.length;
      }
    });

    console.log(JSON.stringify({ migrated: counts, source: sourcePath, target: 'PostgreSQL' }, null, 2));
  } finally {
    source.close();
    await target.pool.end();
  }
}

main().catch((error) => {
  console.error(`Migrasi SQLite ke PostgreSQL gagal: ${error.message}`);
  process.exitCode = 1;
});
