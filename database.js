const { Pool } = require('pg');

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS app_state (
    id TEXT PRIMARY KEY,
    payload TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS tenant_state (
    tenant_id TEXT PRIMARY KEY,
    payload TEXT NOT NULL,
    version BIGINT NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS tenants (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS tenants_name_lower_uq ON tenants (LOWER(name));
  CREATE TABLE IF NOT EXISTS tenant_audit (
    id TEXT PRIMARY KEY,
    actor_id TEXT NOT NULL,
    actor_name TEXT NOT NULL,
    tenant_id TEXT NOT NULL,
    action TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    password_salt TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL,
    tenant_id TEXT NOT NULL,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS users_username_lower_uq ON users (LOWER(username));
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS tiktok_oauth_states (
    state_hash TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS tiktok_connections (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    open_id TEXT NOT NULL,
    access_token TEXT NOT NULL,
    refresh_token TEXT NOT NULL,
    access_token_expires_at BIGINT NOT NULL,
    refresh_token_expires_at BIGINT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (tenant_id, open_id)
  );
  CREATE TABLE IF NOT EXISTS tiktok_shops (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    connection_id TEXT NOT NULL,
    shop_id TEXT NOT NULL,
    shop_cipher TEXT NOT NULL,
    name TEXT NOT NULL,
    region TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    UNIQUE (tenant_id, shop_id)
  );
  CREATE TABLE IF NOT EXISTS employee_audit (
    id TEXT PRIMARY KEY,
    actor_id TEXT NOT NULL,
    actor_name TEXT NOT NULL,
    target_user_id TEXT NOT NULL,
    action TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
`;

const MIGRATIONS = [
  'ALTER TABLE tenant_state ADD COLUMN IF NOT EXISTS version BIGINT NOT NULL DEFAULT 0',
];

function placeholders(sql) {
  let index = 0;
  return sql
    .replace(/\bAS\s+([a-z_]*[A-Z][a-zA-Z0-9_]*)\b/g, 'AS "$1"')
    .replace(/\?/g, () => `$${++index}`);
}

function createDatabase(client) {
  return {
    prepare(sql) {
      const statement = placeholders(sql);
      return {
        async get(...values) {
          const result = await client.query(statement, values);
          return result.rows[0] || null;
        },
        async all(...values) {
          const result = await client.query(statement, values);
          return result.rows;
        },
        async run(...values) {
          const result = await client.query(statement, values);
          return { changes: result.rowCount };
        },
      };
    },
    async exec(sql) {
      return client.query(sql);
    },
    async transaction(callback) {
      const connection = await client.connect();
      try {
        await connection.query('BEGIN');
        const result = await callback(createDatabase(connection));
        await connection.query('COMMIT');
        return result;
      } catch (error) {
        await connection.query('ROLLBACK');
        throw error;
      } finally {
        connection.release();
      }
    },
  };
}

function createPool({ connectionString = process.env.DATABASE_URL, max = 10, schema = process.env.DATABASE_SCHEMA } = {}) {
  if (!connectionString) throw new Error('DATABASE_URL wajib diatur untuk koneksi PostgreSQL.');
  if (schema && !/^[a-z_][a-z0-9_]{0,62}$/.test(schema)) throw new Error('DATABASE_SCHEMA hanya boleh berisi huruf kecil, angka, dan garis bawah.');
  const pool = new Pool({ connectionString, max, ...(schema ? { options: `-c search_path=${schema}` } : {}) });
  const database = createDatabase(pool);
  return { ...database, pool, schema: SCHEMA, migrations: MIGRATIONS };
}

module.exports = { createPool, placeholders, SCHEMA, MIGRATIONS };
