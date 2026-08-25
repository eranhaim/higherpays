'use strict';
// PII retention. Provider payloads are stored verbatim so a payment can be
// reconciled; once they are old enough that reconciliation is over, only the
// fields that identify the payment are kept and the rest (name, email, phone)
// is dropped. Run from cron on the box:
//
//   30 4 * * * cd /home/ubuntu/higherpays && docker compose exec -T backend node src/util/redact.js >> /var/log/higherpays-retention.log 2>&1
//
// RETENTION_DAYS (default 90) sets the age. Runs as the app role: the tables
// are tenant-scoped, so it uses the trusted system context.
const { withSystem, pool } = require('../db');

const KEEP = ['trans_id', 'trans_order', 'reply_code', 'reply_desc', 'trans_amount', 'trans_currency', 'merchant_id', 'trans_date'];

async function redactOlderThan(days) {
  return withSystem(async (c) => {
    const keep = KEEP.map((k) => `'${k}'`).join(', ');
    const tx = await c.query(
      `UPDATE transactions
          SET raw_payload = (SELECT jsonb_object_agg(key, value) FROM jsonb_each(raw_payload) WHERE key IN (${keep}))
                            || jsonb_build_object('redacted_at', now())
        WHERE occurred_at < now() - ($1 || ' days')::interval
          AND raw_payload IS NOT NULL AND NOT (raw_payload ? 'redacted_at')`, [String(days)]);
    const ev = await c.query(
      `UPDATE webhook_events
          SET payload = (SELECT jsonb_object_agg(key, value) FROM jsonb_each(payload) WHERE key IN (${keep}))
                        || jsonb_build_object('redacted_at', now())
        WHERE created_at < now() - ($1 || ' days')::interval
          AND payload IS NOT NULL AND NOT (payload ? 'redacted_at')`, [String(days)]);
    return { transactions: tx.rowCount, webhookEvents: ev.rowCount };
  });
}

if (require.main === module) {
  const days = parseInt(process.env.RETENTION_DAYS || '90', 10);
  redactOlderThan(days)
    .then((r) => { console.log(`[retention] redacted ${r.transactions} transactions and ${r.webhookEvents} webhook events older than ${days} days`); return pool.end(); })
    .catch((e) => { console.error('[retention] failed:', e.message); process.exitCode = 1; return pool.end(); });
}

module.exports = { redactOlderThan, KEEP };
