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

// One statement, no transaction. Every query filters by workspace_id itself;
// there is no row-level security behind it.
async function query(text, params) {
  return pool.query(text, params);
}

// Run `fn(client)` inside one transaction. Anything that writes more than one
// row, or reads then writes, goes through here.
async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { pool, query, withTransaction };
