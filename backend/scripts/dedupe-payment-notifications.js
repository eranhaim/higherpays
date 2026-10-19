'use strict';

// Usage:
//   node scripts/dedupe-payment-notifications.js
//   NOTIFICATION_DEDUPE_CONFIRM=payment-notification-dedupe-2026-10-04 \
//     node scripts/dedupe-payment-notifications.js --apply
//
// The default is a dry run. Redirect stdout to a protected host file before
// applying: it contains the scoped backup required to restore this cleanup.

const { Pool } = require('pg');
const config = require('../src/config');

const CONFIRMATION = 'payment-notification-dedupe-2026-10-04';
const OUTCOME_EVENTS = new Set(['payment.paid', 'payment.failed']);

function eventKey(row) {
  return `${row.event}:${row.entity_id}`;
}

function groupRows(rows) {
  const grouped = new Map();
  for (const row of rows) {
    const key = `${row.workspace_id}:${row.event}:${row.entity_id}`;
    const group = grouped.get(key) || [];
    group.push(row);
    grouped.set(key, group);
  }

  const repairGroups = [];
  const skippedGroups = [];
  for (const rowsForEvent of grouped.values()) {
    rowsForEvent.sort((a, b) =>
      new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
      || a.id.localeCompare(b.id));
    const expectedEventKey = eventKey(rowsForEvent[0]);
    if (rowsForEvent.some((row) => row.event_key && row.event_key !== expectedEventKey)) {
      skippedGroups.push({
        workspaceId: rowsForEvent[0].workspace_id,
        event: rowsForEvent[0].event,
        paymentId: rowsForEvent[0].entity_id,
        notificationIds: rowsForEvent.map((row) => row.id),
        reason: 'unexpected_event_key',
      });
      continue;
    }
    if (rowsForEvent.some((row) => row.read_workspace_mismatch)) {
      skippedGroups.push({
        workspaceId: rowsForEvent[0].workspace_id,
        event: rowsForEvent[0].event,
        paymentId: rowsForEvent[0].entity_id,
        notificationIds: rowsForEvent.map((row) => row.id),
        reason: 'notification_read_workspace_mismatch',
      });
      continue;
    }

    const canonical = rowsForEvent[0];
    const duplicates = rowsForEvent.slice(1);
    if (duplicates.length || canonical.event_key !== expectedEventKey) {
      repairGroups.push({
        workspaceId: canonical.workspace_id,
        event: canonical.event,
        paymentId: canonical.entity_id,
        canonicalId: canonical.id,
        canonicalCreatedAt: canonical.created_at,
        eventKey: expectedEventKey,
        notificationIds: rowsForEvent.map((row) => row.id),
        duplicateIds: duplicates.map((row) => row.id),
      });
    }
  }
  return { repairGroups, skippedGroups };
}

async function loadRows(client, lock = false) {
  const lockClause = lock ? ' FOR UPDATE OF n' : '';
  return (await client.query(
    `SELECT n.id, n.workspace_id, n.event, n.entity_id, n.event_key, n.created_at,
            EXISTS (
              SELECT 1 FROM notification_reads r
               WHERE r.notification_id=n.id AND r.workspace_id <> n.workspace_id
            ) AS read_workspace_mismatch
       FROM notifications n
       JOIN payments p ON p.id=n.entity_id AND p.workspace_id=n.workspace_id
      WHERE n.event = ANY($1::text[])
        AND n.entity_type='payment'
        AND n.entity_id IS NOT NULL
      ORDER BY n.workspace_id, n.event, n.entity_id, n.created_at, n.id${lockClause}`,
    [[...OUTCOME_EVENTS]],
  )).rows;
}

async function loadInvalidRows(client) {
  return (await client.query(
    `SELECT reason, count(*)::int AS rows
       FROM (
         SELECT CASE
           WHEN n.entity_type IS DISTINCT FROM 'payment' THEN 'entity_type_not_payment'
           WHEN n.entity_id IS NULL THEN 'missing_payment_id'
           WHEN p.id IS NULL THEN 'payment_not_found_in_workspace'
         END AS reason
           FROM notifications n
           LEFT JOIN payments p ON p.id=n.entity_id AND p.workspace_id=n.workspace_id
          WHERE n.event = ANY($1::text[])
            AND (
              n.entity_type IS DISTINCT FROM 'payment'
              OR n.entity_id IS NULL
              OR p.id IS NULL
            )
       ) invalid
      GROUP BY reason
      ORDER BY reason`,
    [[...OUTCOME_EVENTS]],
  )).rows;
}

async function loadReadStates(client, groups) {
  const ids = groups.flatMap((group) => group.notificationIds);
  if (!ids.length) return [];
  return (await client.query(
    `SELECT r.workspace_id, r.notification_id, r.user_id, r.read_at
       FROM notification_reads r
      WHERE r.notification_id = ANY($1::uuid[])
      ORDER BY r.workspace_id, r.notification_id, r.user_id`,
    [ids],
  )).rows;
}

function groupSummary(groups) {
  const summary = {};
  for (const group of groups) {
    const key = `${group.workspaceId}:${group.event}`;
    const current = summary[key] || {
      workspaceId: group.workspaceId,
      event: group.event,
      canonical: 0,
      duplicateRows: 0,
      eventKeysBackfilled: 0,
    };
    current.canonical++;
    current.duplicateRows += group.duplicateIds.length;
    if (group.eventKey) current.eventKeysBackfilled++;
    summary[key] = current;
  }
  return Object.values(summary);
}

async function loadBackup(client, groups) {
  const ids = groups.flatMap((group) => group.notificationIds);
  if (!ids.length) return { notifications: [], reads: [] };
  const [notifications, reads] = await Promise.all([
    client.query('SELECT * FROM notifications WHERE id = ANY($1::uuid[]) ORDER BY workspace_id, created_at, id', [ids]),
    client.query('SELECT * FROM notification_reads WHERE notification_id = ANY($1::uuid[]) ORDER BY workspace_id, notification_id, user_id', [ids]),
  ]);
  return { notifications: notifications.rows, reads: reads.rows };
}

async function applyGroup(client, group) {
  const reads = (await client.query(
    `INSERT INTO notification_reads (workspace_id, notification_id, user_id, read_at)
     SELECT $1, $2, user_id, min(read_at)
       FROM notification_reads
      WHERE workspace_id=$1 AND notification_id = ANY($3::uuid[])
      GROUP BY user_id
     ON CONFLICT (notification_id, user_id) DO UPDATE
       SET read_at=LEAST(notification_reads.read_at, EXCLUDED.read_at)`,
    [group.workspaceId, group.canonicalId, group.notificationIds],
  )).rowCount;
  const deletedReads = group.duplicateIds.length
    ? (await client.query(
      'DELETE FROM notification_reads WHERE workspace_id=$1 AND notification_id = ANY($2::uuid[])',
      [group.workspaceId, group.duplicateIds],
    )).rowCount
    : 0;
  const deletedNotifications = group.duplicateIds.length
    ? (await client.query(
      'DELETE FROM notifications WHERE workspace_id=$1 AND id = ANY($2::uuid[])',
      [group.workspaceId, group.duplicateIds],
    )).rowCount
    : 0;
  const keyed = (await client.query(
    'UPDATE notifications SET event_key=$2 WHERE id=$1 AND event_key IS NULL',
    [group.canonicalId, group.eventKey],
  )).rowCount;
  return { reads, deletedReads, deletedNotifications, keyed };
}

async function applyCleanup(client, groups) {
  const totals = { readStatesMerged: 0, duplicateReadsDeleted: 0, notificationsDeleted: 0, eventKeysBackfilled: 0 };
  const byWorkspace = new Map();
  for (const group of groups) {
    const result = await applyGroup(client, group);
    for (const [key, value] of Object.entries(result)) totals[
      key === 'reads' ? 'readStatesMerged'
        : key === 'deletedReads' ? 'duplicateReadsDeleted'
          : key === 'deletedNotifications' ? 'notificationsDeleted'
            : 'eventKeysBackfilled'
    ] += value;
    const workspace = byWorkspace.get(group.workspaceId) || { deleted: 0, backfilled: 0, events: {} };
    workspace.deleted += result.deletedNotifications;
    workspace.backfilled += result.keyed;
    workspace.events[group.event] = (workspace.events[group.event] || 0) + result.deletedNotifications;
    byWorkspace.set(group.workspaceId, workspace);
  }
  for (const [workspaceId, summary] of byWorkspace) {
    await client.query(
      `INSERT INTO audit_log (workspace_id, action, entity_type, metadata)
       VALUES ($1,'notification.payment_outcomes.deduplicated','notification',$2)`,
      [workspaceId, { script: 'dedupe-payment-notifications', ...summary }],
    );
  }
  return totals;
}

async function buildReport(client, mode, lock = false) {
  const rows = await loadRows(client, lock);
  const { repairGroups, skippedGroups } = groupRows(rows);
  const invalidRows = await loadInvalidRows(client);
  const readStates = await loadReadStates(client, repairGroups);
  const backup = await loadBackup(client, repairGroups);
  return {
    generatedAt: new Date().toISOString(),
    mode,
    summary: groupSummary(repairGroups),
    retained: repairGroups.length,
    duplicateRows: repairGroups.reduce((count, group) => count + group.duplicateIds.length, 0),
    skipped: {
      invalidRows,
      groups: skippedGroups,
    },
    groups: repairGroups,
    readStates,
    backup,
  };
}

async function main() {
  const applyRequested = process.argv.includes('--apply');
  if (applyRequested && process.env.NOTIFICATION_DEDUPE_CONFIRM !== CONFIRMATION) {
    throw new Error(`Set NOTIFICATION_DEDUPE_CONFIRM=${CONFIRMATION} before using --apply`);
  }

  const pool = new Pool({ connectionString: config.databaseUrl });
  try {
    if (!applyRequested) {
      process.stdout.write(JSON.stringify(await buildReport(pool, 'dry-run'), null, 2) + '\n');
      return;
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const report = await buildReport(client, 'apply', true);
      report.applied = await applyCleanup(client, report.groups);
      report.remainingDuplicateGroups = (await buildReport(client, 'post-apply')).duplicateRows;
      await client.query('COMMIT');
      process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`notification cleanup failed: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { groupRows };
