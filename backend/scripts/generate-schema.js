'use strict';
// Emits backend/migrations/001_init.sql from src/schema/entities.js.
//
//   node scripts/generate-schema.js
//
// The output is committed. Regenerate after editing entities.js; the migration
// runner refuses to apply a changed file, so on a live database a schema
// change is a new migration written by hand, not a regeneration.
const fs = require('fs');
const path = require('path');
const schema = require('../src/schema/entities');

const snake = (s) => s.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase());
const quoteList = (values) => values.map((v) => `'${v}'`).join(', ');

const entities = Object.keys(schema).filter((k) => k !== 'status').map((k) => schema[k]);
const byTable = Object.fromEntries(entities.map((e) => [e.table, e]));

// A table must exist before anything references it. Export order is the
// tiebreak, so the file reads in the same order as entities.js.
function dependencyOrder() {
  const done = new Set();
  const out = [];
  const visit = (e, trail) => {
    if (done.has(e.table)) return;
    if (trail.has(e.table)) throw new Error(`circular reference through ${e.table}`);
    trail.add(e.table);
    const deps = new Set();
    for (const f of Object.values(e.fields)) if (f.referencesTable && f.referencesTable !== e.table) deps.add(f.referencesTable);
    for (const fk of e.foreignKeys) if (fk.table !== e.table) deps.add(fk.table);
    for (const t of deps) visit(byTable[t], trail);
    trail.delete(e.table);
    done.add(e.table);
    out.push(e);
  };
  for (const e of entities) visit(e, new Set());
  return out;
}

function columnSql(name, f) {
  const col = snake(name);
  const parts = [col.padEnd(24), f.sqlType];
  if (f.isIdentity) parts.push('GENERATED ALWAYS AS IDENTITY');
  if (f.generatedSql) parts.push(`GENERATED ALWAYS AS (${f.generatedSql}) STORED`);
  if (f.isPrimaryKey) parts.push('PRIMARY KEY');
  else if (f.isNotNull) parts.push('NOT NULL');
  if (f.isUnique) parts.push('UNIQUE');
  if (f.defaultSql != null) parts.push(`DEFAULT ${f.defaultSql}`);
  if (f.referencesTable) parts.push(`REFERENCES ${f.referencesTable}(id) ON DELETE ${f.onDelete}`);
  if (f.allowedValues) parts.push(`CHECK (${col} IN (${quoteList(f.allowedValues)}))`);
  if (f.allowedRange) parts.push(`CHECK (${col} >= ${f.allowedRange[0]} AND ${col} <= ${f.allowedRange[1]})`);
  return '  ' + parts.join(' ');
}

function tableSql(e) {
  const lines = Object.entries(e.fields).map(([name, f]) => columnSql(name, f));
  if (e.timestamps === 'created' || e.timestamps === 'both') {
    lines.push('  ' + 'created_at'.padEnd(24) + ' timestamptz NOT NULL DEFAULT now()');
  }
  if (e.timestamps === 'both') {
    lines.push('  ' + 'updated_at'.padEnd(24) + ' timestamptz NOT NULL DEFAULT now()');
  }
  if (e.primaryKey) lines.push(`  PRIMARY KEY (${e.primaryKey.map(snake).join(', ')})`);
  for (const cols of e.unique) lines.push(`  UNIQUE (${cols.map(snake).join(', ')})`);
  for (const fk of e.foreignKeys) {
    lines.push(`  FOREIGN KEY (${fk.columns.map(snake).join(', ')}) REFERENCES ${fk.table}(${fk.references.map(snake).join(', ')}) ON DELETE ${fk.onDelete || 'CASCADE'}`);
  }
  for (const check of e.checks) lines.push(`  CHECK (${check})`);

  const out = [`CREATE TABLE ${e.table} (`, lines.join(',\n'), ');'];

  for (const idx of e.indexes) {
    const spec = typeof idx === 'string' ? { columns: [idx] } : idx;
    const cols = spec.columns.map(snake);
    const name = `idx_${e.table}_${cols.join('_')}`;
    const where = spec.where ? ` WHERE ${spec.where}` : '';
    out.push(`CREATE ${spec.unique ? 'UNIQUE ' : ''}INDEX ${name} ON ${e.table}(${cols.join(', ')})${where};`);
  }
  if (e.timestamps === 'both') {
    out.push(`CREATE TRIGGER trg_${e.table}_updated BEFORE UPDATE ON ${e.table}\n  FOR EACH ROW EXECUTE FUNCTION set_updated_at();`);
  }
  return out.join('\n');
}

const header = `-- Generated from src/schema/entities.js by scripts/generate-schema.js.
-- Do not edit by hand: change the entities file and regenerate.
--
-- Money is NUMERIC, never float. Status columns are text with a CHECK so a new
-- value is an ordinary migration rather than an ALTER TYPE.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS citext;     -- case-insensitive email

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
`;

const body = dependencyOrder().map((e) => `\n-- ${e.table}\n${tableSql(e)}`).join('\n');
const sql = `${header}${body}\n\nCOMMIT;\n`;

const target = path.join(__dirname, '..', 'migrations', '001_init.sql');
fs.writeFileSync(target, sql);
console.log(`wrote ${path.relative(process.cwd(), target)} (${entities.length} tables)`);
