'use strict';
// Applies every migration in /migrations in order, exactly once. Tracks applied
// files and their checksums in schema_migrations. Safe to run repeatedly.
// Fails loudly if an already-applied file has changed: "never edit an applied
// migration" is enforced here, not by convention.
//   node src/util/migrate.js
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');
const config = require('../config');

const checksumOf = (sql) => crypto.createHash('sha256').update(sql).digest('hex');

async function run() {
  // Migrations need DDL and must not be subject to RLS, so we prefer a
  // dedicated MIGRATIONS_DATABASE_URL (owner/superuser). Falls back to the
  // main DATABASE_URL for local dev where the app connects as owner anyway.
  const migrationsUrl = process.env.MIGRATIONS_DATABASE_URL || config.databaseUrl;
  const pool = new Pool({ connectionString: migrationsUrl });
  const dir = path.join(__dirname, '..', '..', 'migrations');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  const client = await pool.connect();
  let ran = 0;
  try {
    await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (filename text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    // The checksum column arrives with migration 030; before that it does not exist yet.
    const hasChecksum = (await client.query(
      "SELECT 1 FROM information_schema.columns WHERE table_name='schema_migrations' AND column_name='checksum'")).rowCount > 0;
    const applied = new Map((await client.query(
      hasChecksum ? 'SELECT filename, checksum FROM schema_migrations' : 'SELECT filename, NULL AS checksum FROM schema_migrations'))
      .rows.map((r) => [r.filename, r.checksum]));

    for (const f of files) {
      const source = fs.readFileSync(path.join(dir, f), 'utf8');
      const checksum = checksumOf(source);
      if (applied.has(f)) {
        const recorded = applied.get(f);
        if (recorded && recorded !== checksum) {
          console.error(`FAILED: ${f} was edited after it was applied (checksum ${recorded.slice(0, 12)} → ${checksum.slice(0, 12)}). Write a new migration instead.`);
          process.exitCode = 1;
          return;
        }
        if (!recorded && hasChecksum) {
          await client.query('UPDATE schema_migrations SET checksum = $2 WHERE filename = $1', [f, checksum]);
        }
        continue;
      }
      // The runner wraps each migration + its bookkeeping in ONE transaction, so
      // strip the file's own top-level BEGIN;/COMMIT; markers (PL/pgSQL BEGIN/END
      // inside function bodies has no semicolon and is left untouched).
      const sql = source
        .replace(/^\s*BEGIN;\s*$/gim, '')
        .replace(/^\s*COMMIT;\s*$/gim, '');
      process.stdout.write(`  → ${f} ... `);
      try {
        await client.query('BEGIN');
        await client.query(sql);
        const withChecksum = hasChecksum || (await client.query(
          "SELECT 1 FROM information_schema.columns WHERE table_name='schema_migrations' AND column_name='checksum'")).rowCount > 0;
        if (withChecksum) {
          await client.query('INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)', [f, checksum]);
        } else {
          await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [f]);
        }
        await client.query('COMMIT');
        console.log('done');
        ran++;
      } catch (e) {
        await client.query('ROLLBACK');
        console.error(`FAILED\n${e.message}`);
        process.exitCode = 1;
        return;
      }
    }
    console.log(ran ? `Applied ${ran} migration(s).` : 'Database already up to date.');
  } finally {
    client.release();
    await pool.end();
  }
}

if (require.main === module) run();
module.exports = { run };
