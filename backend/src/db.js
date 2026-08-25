'use strict';
const { Pool } = require('pg');
const config = require('./config');

// Sized for one API container against the default Postgres max_connections
// (100), leaving room for migrations, backups and psql. A statement that runs
// longer than the timeout is a bug or an attack, not a query to wait for.
const pool = new Pool({
  connectionString: config.databaseUrl,
  max: parseInt(process.env.PG_POOL_MAX || '20', 10),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
  statement_timeout: parseInt(process.env.PG_STATEMENT_TIMEOUT_MS || '30000', 10),
});

// Plain query — use for auth/global tables (users, refresh_tokens) and for
// cross-workspace lookups like "which workspaces does this user belong to".
async function query(text, params) {
  return pool.query(text, params);
}

// Run `fn(client)` inside a transaction scoped to a workspace (and user).
// When USE_RLS is on, this sets the GUCs that the Row-Level Security policies
// read, so the database itself blocks any cross-tenant access.
async function withWorkspace(workspaceId, userId, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (config.useRls) {
      // set_config(name, value, is_local=true) — scoped to this transaction
      await client.query("SELECT set_config('app.workspace_id', $1, true)", [workspaceId || '']);
      await client.query("SELECT set_config('app.user_id', $1, true)", [userId || '']);
    }
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// Run `fn(client)` in a transaction marked as a PLATFORM-ADMIN context.
// When USE_RLS is on, this sets app.platform_admin='on', which the tenant
// policies honour to allow controlled cross-tenant access. Only call this after
// requirePlatformAdmin has verified the user.
async function withPlatformAdmin(userId, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (config.useRls) {
      await client.query("SELECT set_config('app.platform_admin', 'on', true)");
      await client.query("SELECT set_config('app.user_id', $1, true)", [userId || '']);
    }
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// Run `fn(client)` with only the user context set (no workspace). Used by login
// and /me to list the user's own memberships under the memberships self-policy.
async function withUser(userId, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (config.useRls) {
      await client.query("SELECT set_config('app.user_id', $1, true)", [userId || '']);
    }
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// Run `fn(client)` as a TRUSTED SERVER context (no authenticated user).
// Needed for operations that must resolve a tenant *before* a workspace is
// known — e.g. a provider webhook arriving on an opaque endpoint id. Under RLS
// this uses the same controlled bypass as withPlatformAdmin. Never expose this
// to user-supplied routing: the only key is the unguessable endpoint id, and
// the payload signature is still verified afterwards.
async function withSystem(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (config.useRls) {
      await client.query("SELECT set_config('app.platform_admin', 'on', true)");
    }
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

module.exports = { pool, query, withWorkspace, withPlatformAdmin, withUser, withSystem };

