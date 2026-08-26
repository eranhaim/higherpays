'use strict';
// Field and entity builders for the schema model in entities.js.
//
// A builder returns a plain descriptor. The SQL generator reads those
// descriptors and emits the DDL — nothing here talks to the database.

class Field {
  constructor(sqlType) {
    this.sqlType = sqlType;
    this.isPrimaryKey = false;
    this.isNotNull = false;
    this.isUnique = false;
    this.defaultSql = null;
    this.referencesTable = null;
    this.onDelete = null;
    this.allowedValues = null;   // enumOf
    this.allowedRange = null;    // percent
  }

  primaryKey() {
    this.isPrimaryKey = true;
    this.isNotNull = true;
    // Every primary key here is a server-generated uuid, so the default
    // belongs in one place rather than on each entity.
    if (this.sqlType === 'uuid') this.defaultSql = 'gen_random_uuid()';
    return this;
  }

  notNull() {
    this.isNotNull = true;
    return this;
  }

  unique() {
    this.isUnique = true;
    return this;
  }

  default(sql) {
    this.defaultSql = sql;
    return this;
  }

  references(table, onDelete = 'CASCADE') {
    this.referencesTable = table;
    this.onDelete = onDelete;
    return this;
  }

  generatedAs(sql) {
    this.generatedSql = sql;
    return this;
  }
}

const uuid = () => new Field('uuid');
const text = () => new Field('text');
const citext = () => new Field('citext');
const char = (length) => new Field(`char(${length})`);
const bool = () => new Field('boolean');
const int = () => new Field('integer');
const date = () => new Field('date');
const timestamp = () => new Field('timestamptz');
const jsonb = () => new Field('jsonb');
const textArray = () => new Field('text[]');
const inet = () => new Field('inet');

// Money is always exact NUMERIC, never float.
const money = () => new Field('numeric(14,2)');
const numeric = (precision, scale) => new Field(`numeric(${precision},${scale})`);

// A rate or split, constrained to 0-100 by the generated CHECK.
const percent = () => {
  const field = numeric(5, 2);
  field.allowedRange = [0, 100];
  return field;
};

// Append-only tables use a monotonic bigint instead of a uuid.
const bigIdentity = () => {
  const field = new Field('bigint');
  field.isPrimaryKey = true;
  field.isNotNull = true;
  field.defaultSql = null;
  field.isIdentity = true;
  return field;
};

// Stored as text with a CHECK constraint rather than a Postgres ENUM type:
// adding a value later is an ordinary migration instead of an ALTER TYPE.
const enumOf = (values) => {
  const field = new Field('text');
  field.allowedValues = values;
  return field;
};

const entity = (table, spec) => {
  if (!spec.fields || Object.keys(spec.fields).length === 0) {
    throw new Error(`${table}: no fields`);
  }
  return {
    table,
    fields: spec.fields,
    primaryKey: spec.primaryKey ?? null,  // composite key; single keys use .primaryKey()
    unique: spec.unique ?? [],            // arrays of field names
    // Multi-column foreign keys, for rules a single-column key cannot express:
    //   { columns: ['workspaceId','accountId'], table: 'accounts',
    //     references: ['workspaceId','id'], onDelete: 'CASCADE' }
    foreignKeys: spec.foreignKeys ?? [],
    indexes: spec.indexes ?? [],          // field name, or { columns, where, unique }
    checks: spec.checks ?? [],            // raw SQL, so written in snake_case
    timestamps: spec.timestamps ?? false, // 'created' | 'both'
  };
};

module.exports = {
  entity,
  uuid, text, citext, char, bool, int, date, timestamp, jsonb, textArray, inet,
  money, numeric, percent, bigIdentity, enumOf,
};
