'use strict';

// Read-only by default. A production import requires:
//   MONGODB_MIGRATION_CONFIRM=YES node scripts/migrate-postgres-to-mongodb.js
//
// The source remains Postgres until the application repositories have been
// migrated and parity has been verified.

const { Pool } = require('pg');
const { MongoClient, Decimal128 } = require('mongodb');
const config = require('../src/config');

const confirm = process.env.MONGODB_MIGRATION_CONFIRM === 'YES';
const databaseName = process.env.MONGODB_DATABASE || 'higherpays';
const mongoUri = process.env.MONGODB_URI;

if (!mongoUri) throw new Error('MONGODB_URI is required');

function camelCase(name) {
  return name.replace(/_([a-z])/g, (_match, letter) => letter.toUpperCase());
}

function convertValue(value, dataType) {
  if (value == null) return value;
  if (dataType === 'numeric' || dataType === 'decimal') return Decimal128.fromString(String(value));
  return value;
}

async function readTable(client, table) {
  const columns = (await client.query(
    `SELECT column_name, data_type
       FROM information_schema.columns
      WHERE table_schema='public' AND table_name=$1
      ORDER BY ordinal_position`,
    [table],
  )).rows;
  const rows = (await client.query(`SELECT * FROM "${table}"`)).rows;
  return {
    rows: rows.map((row) => Object.fromEntries(columns.map((column) => [
      camelCase(column.column_name),
      convertValue(row[column.column_name], column.data_type),
    ]))),
    columns,
  };
}

async function run() {
  const pg = new Pool({ connectionString: config.databaseUrl });
  const mongo = new MongoClient(mongoUri);
  const pgClient = await pg.connect();
  try {
    await pgClient.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const tables = (await pgClient.query(
      `SELECT tablename FROM pg_tables
        WHERE schemaname='public' AND tablename <> 'schema_migrations'
        ORDER BY tablename`,
    )).rows.map((row) => row.tablename);

    await mongo.connect();
    const db = mongo.db(databaseName);
    const summary = [];

    for (const table of tables) {
      const data = await readTable(pgClient, table);
      const collection = db.collection(table);
      if (confirm && data.rows.length) {
        const operations = data.rows
          .filter((row) => row.id != null)
          .map((row) => ({
            replaceOne: {
              filter: { _id: String(row.id) },
              replacement: { _id: String(row.id), ...row },
              upsert: true,
            },
          }));
        for (let i = 0; i < operations.length; i += 500) {
          await collection.bulkWrite(operations.slice(i, i + 500), { ordered: false });
        }
      }
      if (data.columns.some((column) => column.column_name === 'workspace_id')) {
        await collection.createIndex({ workspaceId: 1 });
      }
      summary.push({ table, documents: data.rows.length, imported: confirm });
    }

    await pgClient.query('ROLLBACK');
    console.log(JSON.stringify({
      mode: confirm ? 'import' : 'dry-run',
      database: databaseName,
      tables: summary,
    }, null, 2));
  } finally {
    await pgClient.release();
    await pg.end();
    await mongo.close();
  }
}

run().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
