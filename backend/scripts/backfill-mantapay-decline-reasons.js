'use strict';

// Reads provider state only. It changes HigherPays rows only with --apply.
const { query, withTransaction, pool } = require('../src/db');
const provider = require('../src/providers/mantapay');
const signature = require('../src/providers/mantapay-signature');
const reply = require('../src/providers/mantapay-reply');

function readRawDecline(payload) {
  const code = reply.readReplyCode(payload);
  if (signature.mapReplyCode(code) !== 'declined') {
    return { code: null, reason: null, codeSource: null, reasonSource: null };
  }
  const reason = reply.readReplyDescription(payload);
  return {
    code,
    reason,
    codeSource: code ? reply.DECLINE_SOURCE.rawPayload : null,
    reasonSource: reason ? reply.DECLINE_SOURCE.rawPayload : null,
  };
}

async function readStatusDecline(row) {
  const result = await provider.status.getStatusById(
    row.merchant_id || provider.resolveMerchantId(row),
    row.provider_transaction_id,
  );
  if (result.status !== 'declined') {
    return { code: null, reason: null, codeSource: null, reasonSource: null };
  }
  return {
    code: result.replyCode,
    reason: result.replyDesc,
    codeSource: result.replyCode ? reply.DECLINE_SOURCE.status : null,
    reasonSource: result.replyDesc ? reply.DECLINE_SOURCE.status : null,
  };
}

function mergeDecline(current, candidate) {
  return {
    code: current.provider_decline_code || candidate.code,
    reason: current.provider_decline_reason || candidate.reason,
    codeSource: current.provider_decline_code_source || candidate.codeSource,
    reasonSource: current.provider_decline_reason_source || candidate.reasonSource,
  };
}

async function loadDeclinedTransactions() {
  return (await query(
    `SELECT t.id, t.workspace_id, t.provider_transaction_id, t.raw_payload,
            t.provider_decline_code, t.provider_decline_reason,
            t.provider_decline_code_source, t.provider_decline_reason_source,
            w.merchant_id, w.provider_config_ref
       FROM transactions t
       JOIN payments p ON p.id = t.payment_id
       JOIN workspaces w ON w.id = t.workspace_id
      WHERE t.type = 'payment'
        AND t.status = 'declined'
        AND p.status = 'failed'
        AND t.provider_transaction_id IS NOT NULL
      ORDER BY t.occurred_at ASC`,
  )).rows;
}

async function applyUpdates(updates) {
  if (!updates.length) return;
  await withTransaction(async (client) => {
    for (const update of updates) {
      await client.query(
        `UPDATE transactions
            SET provider_decline_code = COALESCE(provider_decline_code, $2),
                provider_decline_reason = COALESCE(provider_decline_reason, $3),
                provider_decline_code_source = COALESCE(provider_decline_code_source, $4),
                provider_decline_reason_source = COALESCE(provider_decline_reason_source, $5)
          WHERE id = $1`,
        [update.id, update.details.code, update.details.reason,
          update.details.codeSource, update.details.reasonSource],
      );
      await client.query(
        `INSERT INTO audit_log (workspace_id, action, entity_type, entity_id, metadata)
         VALUES ($1, 'mantapay.decline_reason_backfill', 'transaction', $2,
                 jsonb_build_object(
                   'codeSource', $3::text,
                   'reasonSource', $4::text,
                   'hasCode', $5::boolean,
                   'hasReason', $6::boolean
                 ))`,
        [update.workspace_id, update.id, update.details.codeSource, update.details.reasonSource,
          Boolean(update.details.code), Boolean(update.details.reason)],
      );
    }
  });
}

async function backfill({ apply = false } = {}) {
  const rows = await loadDeclinedTransactions();
  const report = {
    scanned: rows.length,
    rawPayloadMatched: 0,
    statusLookups: 0,
    statusMatched: 0,
    codeOnly: 0,
    noProviderDetails: 0,
    lookupErrors: 0,
    updated: 0,
    dryRun: !apply,
  };
  const updates = [];

  for (const row of rows) {
    let candidate = readRawDecline(row.raw_payload);
    if (candidate.code || candidate.reason) report.rawPayloadMatched++;

    if (!candidate.code || !candidate.reason) {
      report.statusLookups++;
      try {
        const status = await readStatusDecline(row);
        if (status.code || status.reason) {
          report.statusMatched++;
          candidate = {
            code: candidate.code || status.code,
            reason: candidate.reason || status.reason,
            codeSource: candidate.codeSource || status.codeSource,
            reasonSource: candidate.reasonSource || status.reasonSource,
          };
        }
      } catch {
        report.lookupErrors++;
      }
    }

    const details = mergeDecline(row, candidate);
    const changed = details.code !== row.provider_decline_code
      || details.reason !== row.provider_decline_reason
      || details.codeSource !== row.provider_decline_code_source
      || details.reasonSource !== row.provider_decline_reason_source;
    if (!changed) continue;
    if (!details.code && !details.reason) {
      report.noProviderDetails++;
      continue;
    }
    if (!details.reason) report.codeOnly++;
    updates.push({ id: row.id, workspace_id: row.workspace_id, details });
  }

  if (apply) await applyUpdates(updates);
  report.updated = updates.length;
  return report;
}

if (require.main === module) {
  backfill({ apply: process.argv.includes('--apply') })
    .then((report) => console.log(JSON.stringify(report)))
    .catch((error) => {
      console.error(JSON.stringify({ error: error.code || error.message }));
      process.exitCode = 1;
    })
    .finally(() => pool.end());
}

module.exports = { backfill, mergeDecline, readRawDecline, readStatusDecline };
