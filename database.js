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
  CREATE TABLE IF NOT EXISTS tenant_manifest_ids (
    tenant_id TEXT NOT NULL,
    manifest_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (tenant_id, manifest_id)
  );
  CREATE TABLE IF NOT EXISTS state_quarantine (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    payload TEXT NOT NULL,
    payload_hash TEXT NOT NULL,
    reason TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (tenant_id, payload_hash),
    UNIQUE (id, tenant_id)
  );
  CREATE INDEX IF NOT EXISTS state_quarantine_tenant_created_idx ON state_quarantine (tenant_id, created_at DESC);
  CREATE TABLE IF NOT EXISTS quarantine_recovery_audit (
    id TEXT PRIMARY KEY,
    quarantine_id TEXT NOT NULL,
    tenant_id TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    actor_name TEXT NOT NULL,
    action TEXT NOT NULL,
    before_hash TEXT,
    after_hash TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS quarantine_recovery_audit_tenant_idx ON quarantine_recovery_audit (tenant_id, created_at DESC);
  CREATE TABLE IF NOT EXISTS integrity_orphans (
    id TEXT PRIMARY KEY,
    source_table TEXT NOT NULL,
    source_key TEXT NOT NULL,
    tenant_id TEXT,
    payload TEXT NOT NULL,
    payload_hash TEXT NOT NULL,
    reason TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (source_table, source_key, payload_hash)
  );
  CREATE INDEX IF NOT EXISTS integrity_orphans_created_idx ON integrity_orphans (created_at DESC);
  CREATE INDEX IF NOT EXISTS tenant_manifest_ids_tenant_idx ON tenant_manifest_ids (tenant_id);
  CREATE TABLE IF NOT EXISTS tenant_audit (
    id TEXT PRIMARY KEY,
    actor_id TEXT NOT NULL,
    actor_name TEXT NOT NULL,
    tenant_id TEXT NOT NULL,
    action TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS tenant_audit_tenant_created_idx ON tenant_audit (tenant_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS tenant_audit_created_idx ON tenant_audit (created_at DESC);
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
  CREATE UNIQUE INDEX IF NOT EXISTS users_id_tenant_uq ON users (id, tenant_id);
  CREATE INDEX IF NOT EXISTS users_tenant_id_idx ON users (tenant_id);
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    csrf_token TEXT,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON sessions (user_id);
  CREATE INDEX IF NOT EXISTS sessions_expires_at_idx ON sessions (expires_at);
  CREATE TABLE IF NOT EXISTS auth_audit (
    id TEXT PRIMARY KEY,
    user_id TEXT,
    username TEXT,
    tenant_id TEXT,
    action TEXT NOT NULL,
    ip_hash TEXT NOT NULL DEFAULT '',
    metadata TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS auth_audit_created_at_idx ON auth_audit (created_at DESC);
  CREATE INDEX IF NOT EXISTS auth_audit_action_idx ON auth_audit (action, created_at DESC);
  CREATE INDEX IF NOT EXISTS auth_audit_user_idx ON auth_audit (user_id, created_at DESC);
  CREATE TABLE IF NOT EXISTS login_attempts (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL,
    ip_hash TEXT NOT NULL,
    attempted_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS login_attempts_pair_idx ON login_attempts (username, ip_hash, attempted_at);
  CREATE INDEX IF NOT EXISTS login_attempts_ip_idx ON login_attempts (ip_hash, attempted_at);
  CREATE INDEX IF NOT EXISTS login_attempts_attempted_at_idx ON login_attempts (attempted_at);
  CREATE TABLE IF NOT EXISTS tiktok_oauth_states (
    state_hash TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS tiktok_oauth_states_expires_idx ON tiktok_oauth_states (expires_at);
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
  CREATE UNIQUE INDEX IF NOT EXISTS tiktok_connections_id_tenant_uq ON tiktok_connections (id, tenant_id);
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
  CREATE INDEX IF NOT EXISTS employee_audit_target_created_idx ON employee_audit (target_user_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS employee_audit_created_idx ON employee_audit (created_at DESC);
`;

const MIGRATIONS = [
  'ALTER TABLE tenant_state ADD COLUMN IF NOT EXISTS version BIGINT NOT NULL DEFAULT 0',
  'ALTER TABLE sessions ADD COLUMN IF NOT EXISTS csrf_token TEXT',
  `DO $$ BEGIN
    ALTER TABLE tenant_state ADD CONSTRAINT tenant_state_tenant_fk
      FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT NOT VALID;
  EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
  `DO $$ BEGIN
    ALTER TABLE users ADD CONSTRAINT users_tenant_fk
      FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT NOT VALID;
  EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
  `DO $$ BEGIN
    ALTER TABLE sessions ADD CONSTRAINT sessions_user_fk
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE NOT VALID;
  EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
  `DO $$ BEGIN
    ALTER TABLE tenant_audit ADD CONSTRAINT tenant_audit_tenant_fk
      FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT NOT VALID;
  EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
  `DO $$ BEGIN
    ALTER TABLE employee_audit ADD CONSTRAINT employee_audit_target_fk
      FOREIGN KEY (target_user_id) REFERENCES users(id) ON DELETE RESTRICT NOT VALID;
  EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
  `DO $$ BEGIN
    ALTER TABLE tiktok_oauth_states ADD CONSTRAINT tiktok_oauth_states_tenant_fk
      FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE NOT VALID;
  EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
  `DO $$ BEGIN
    ALTER TABLE tiktok_oauth_states ADD CONSTRAINT tiktok_oauth_states_user_fk
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE NOT VALID;
  EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
  `DO $$ BEGIN
    ALTER TABLE tiktok_connections ADD CONSTRAINT tiktok_connections_tenant_fk
      FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE NOT VALID;
  EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
  `DO $$ BEGIN
    ALTER TABLE tiktok_shops ADD CONSTRAINT tiktok_shops_tenant_fk
      FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE NOT VALID;
  EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
  `DO $$ BEGIN
    ALTER TABLE tiktok_shops ADD CONSTRAINT tiktok_shops_connection_fk
      FOREIGN KEY (connection_id) REFERENCES tiktok_connections(id) ON DELETE CASCADE NOT VALID;
  EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
  `DO $$ BEGIN
    ALTER TABLE tenant_manifest_ids ADD CONSTRAINT tenant_manifest_ids_tenant_fk
      FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE NOT VALID;
  EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
  `DO $$ BEGIN
    ALTER TABLE state_quarantine ADD CONSTRAINT state_quarantine_tenant_fk
      FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE NOT VALID;
  EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
  `DO $$ BEGIN
    ALTER TABLE auth_audit ADD CONSTRAINT auth_audit_user_fk
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL NOT VALID;
  EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
  `DO $$ BEGIN
    ALTER TABLE quarantine_recovery_audit ADD CONSTRAINT quarantine_recovery_audit_tenant_fk
      FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT NOT VALID;
  EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
  `DO $$ BEGIN
    ALTER TABLE quarantine_recovery_audit ADD CONSTRAINT quarantine_recovery_audit_quarantine_fk
      FOREIGN KEY (quarantine_id) REFERENCES state_quarantine(id) ON DELETE RESTRICT NOT VALID;
  EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
  `DO $$ BEGIN
    ALTER TABLE integrity_orphans ADD CONSTRAINT integrity_orphans_tenant_fk
      FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE SET NULL NOT VALID;
  EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
  `CREATE OR REPLACE FUNCTION prevent_quarantine_audit_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'quarantine_recovery_audit is append-only'; END; $$`,
  `DO $$ BEGIN
    ALTER TABLE tiktok_oauth_states ADD CONSTRAINT tiktok_oauth_states_user_tenant_fk
      FOREIGN KEY (user_id, tenant_id) REFERENCES users(id, tenant_id) ON DELETE CASCADE NOT VALID;
  EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
  `DO $$ BEGIN
    ALTER TABLE tiktok_shops ADD CONSTRAINT tiktok_shops_connection_tenant_fk
      FOREIGN KEY (connection_id, tenant_id) REFERENCES tiktok_connections(id, tenant_id) ON DELETE CASCADE NOT VALID;
  EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
  `ALTER TABLE auth_audit DROP CONSTRAINT IF EXISTS auth_audit_user_tenant_fk`,
  `DO $$ BEGIN
    ALTER TABLE quarantine_recovery_audit ADD CONSTRAINT quarantine_recovery_audit_quarantine_tenant_fk
      FOREIGN KEY (quarantine_id, tenant_id) REFERENCES state_quarantine(id, tenant_id) ON DELETE RESTRICT NOT VALID;
  EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
  `CREATE OR REPLACE FUNCTION revoke_sessions_on_user_tenant_change() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id THEN EXECUTE format('DELETE FROM %I.sessions WHERE user_id = $1', TG_TABLE_SCHEMA) USING NEW.id; EXECUTE format('DELETE FROM %I.tiktok_oauth_states WHERE user_id = $1', TG_TABLE_SCHEMA) USING NEW.id; END IF; RETURN NEW; END; $$`,
  `DO $$ BEGIN
    CREATE TRIGGER users_tenant_change_revokes_sessions
      BEFORE UPDATE OF tenant_id ON users
      FOR EACH ROW EXECUTE FUNCTION revoke_sessions_on_user_tenant_change();
  EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
  `DO $$ BEGIN
    CREATE TRIGGER quarantine_recovery_audit_immutable
      BEFORE UPDATE OR DELETE ON quarantine_recovery_audit
      FOR EACH ROW EXECUTE FUNCTION prevent_quarantine_audit_mutation();
  EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
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
