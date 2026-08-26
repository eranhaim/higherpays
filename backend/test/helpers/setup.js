'use strict';
// Test bootstrap. Pins env vars BEFORE anything requires the app or config.js.
// The tests run against the local docker Postgres exposed on host:5432 (via
// docker-compose.override.yml). They create their own agencies under unique
// tags, so multiple runs coexist without a wipe.

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-only-secret-fixed-value-for-deterministic-tokens';
process.env.PORT = process.env.PORT || '0'; // never actually listened on
process.env.DATABASE_URL =
  process.env.DATABASE_URL ||
  `postgres://${process.env.HP_APP_USER || 'hp_app'}:${process.env.HP_APP_PASSWORD || 'hp_app_dev'}@${process.env.PGHOST || 'localhost'}:${process.env.PGPORT || '5432'}/${process.env.PGDATABASE || 'higherpays'}`;

// A stable seed for the MantaPay checkout signature test — the tests never call
// the real provider, only the local signing code path.
process.env.MANTAPAY_MERCHANT_ID = process.env.MANTAPAY_MERCHANT_ID || '7374656';
process.env.MANTAPAY_HASH_KEY = process.env.MANTAPAY_HASH_KEY || 'AJG3CI3EX8';

const app = require('../../src/server');
const { pool } = require('../../src/db');

// Close the pool at the very end so `node --test` exits cleanly.
process.on('beforeExit', () => { try { pool.end(); } catch { /* noop */ } });

module.exports = { app, pool };
