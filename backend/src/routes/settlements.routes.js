'use strict';
// Settlement reports: import the provider's daily XLSX, reconcile it against our
// ledger, and track the rolling reserve.
//
// Why this exists: the provider computes fees on a daily BATCH, not per
// transaction, and only the settlement report shows decline fees at all. So our
// per-sale fees are estimates; these imported rows are the truth.
const express = require('express');
const { withWorkspace } = require('../db');
const { requirePermission } = require('../middleware');
const { asyncHandler } = require('../lib/http');
const { audit } = require('../util/audit');
const { parseInWorker } = require('../settlement/parse');
const { parseLimit, decodeCursor, page } = require('../lib/cursor');
const config = require('../config');

const router = express.Router({ mergeParams: true });
const { wid, uid } = require('../lib/scope');
const n = (v) => Number(v || 0);
const round2 = (v) => Math.round(v * 100) / 100;

// A daily export is a few hundred KB; anything near the JSON body limit is
// not a settlement report.
const MAX_WORKBOOK_BYTES = 4 * 1024 * 1024;
const XLSX_MAGIC = Buffer.from('PK');

// POST /import  { filename, contentBase64 }
router.post('/import', requirePermission('commissions.manage'), asyncHandler(async (req, res) => {
  const { filename, contentBase64 } = req.body || {};
  if (!contentBase64) return res.status(400).json({ error: 'file_required' });
  let buf;
  try { buf = Buffer.from(contentBase64, 'base64'); }
  catch { return res.status(400).json({ error: 'bad_base64' }); }
  if (!buf.length || buf.length > MAX_WORKBOOK_BYTES) return res.status(400).json({ error: 'bad_file_size' });
  if (!buf.subarray(0, 2).equals(XLSX_MAGIC)) return res.status(400).json({ error: 'not_a_workbook' });

  let parsed;
  try { parsed = await parseInWorker(buf); }
  catch (e) { return res.status(e.status || 400).json({ error: e.message, detail: e.detail }); }

  // EUR-only for now: the report carries one sheet per currency, so skip any we
  // don't track rather than importing money the rest of the system can't reason about.
  const skipped = parsed.sheets
    .filter((sh) => !config.supportedCurrencies.includes(sh.currency))
    .map((sh) => ({ currency: sh.currency, rows: sh.rows.length }));
  const usable = parsed.sheets.filter((sh) => config.supportedCurrencies.includes(sh.currency));

  const result = await withWorkspace(wid(req), uid(req), async (c) => {
    const imported = [];
    for (const sheet of usable) {
      for (const r of sheet.rows) {
        const row = (await c.query(
          `INSERT INTO settlements (workspace_id, currency, period_start, period_end, settlement_date, paid,
             first_transaction, last_transaction, total_transactions, refunds, chargebacks, declined, volume,
             approved_cost, decline_cost, refund_cost, chargeback_cost, mdr, volume_fee, reserve, total_fees,
             net, debit, credit, report_settings, source_file, imported_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27)
           ON CONFLICT (workspace_id, currency, period_start, period_end) DO UPDATE SET
             settlement_date=EXCLUDED.settlement_date, paid=EXCLUDED.paid,
             total_transactions=EXCLUDED.total_transactions, refunds=EXCLUDED.refunds,
             chargebacks=EXCLUDED.chargebacks, declined=EXCLUDED.declined, volume=EXCLUDED.volume,
             approved_cost=EXCLUDED.approved_cost, decline_cost=EXCLUDED.decline_cost,
             refund_cost=EXCLUDED.refund_cost, chargeback_cost=EXCLUDED.chargeback_cost,
             mdr=EXCLUDED.mdr, volume_fee=EXCLUDED.volume_fee, reserve=EXCLUDED.reserve,
             total_fees=EXCLUDED.total_fees, net=EXCLUDED.net, debit=EXCLUDED.debit, credit=EXCLUDED.credit,
             report_settings=EXCLUDED.report_settings, source_file=EXCLUDED.source_file,
             imported_by=EXCLUDED.imported_by, imported_at=now()
           RETURNING id, currency, period_start, period_end`,
          [wid(req), r.currency, r.periodStart, r.periodEnd, r.settlementDate, r.paid,
            r.firstTransaction, r.lastTransaction, r.totalTransactions, r.refunds, r.chargebacks, r.declined, r.volume,
            r.approvedCost, r.declineCost, r.refundCost, r.chargebackCost, r.mdr, r.volumeFee, r.reserve, r.totalFees,
            r.net, r.debit, r.credit, JSON.stringify(sheet.settings), filename || null, uid(req)])).rows[0];
        imported.push(row);
      }
    }
    return imported;
  });

  // Integrity check the provider's own arithmetic: volume - totalFees should equal net.
  const anomalies = [];
  for (const sheet of usable) {
    for (const r of sheet.rows) {
      const expected = round2(r.volume - r.totalFees);
      if (Math.abs(expected - round2(r.net)) > 0.01) {
        anomalies.push({
          currency: r.currency, periodStart: r.periodStart, periodEnd: r.periodEnd,
          volume: r.volume, totalFees: r.totalFees, netReported: r.net, netExpected: expected,
          difference: round2(r.net - expected),
        });
      }
    }
  }

  await audit({ workspaceId: wid(req), actorUserId: uid(req), action: 'settlement.import', metadata: { filename, rows: result.length } });
  res.status(201).json({
    ok: true,
    merchant: parsed.info.merchant || null,
    baseCurrency: parsed.info.baseCurrency || null,
    periodDays: parsed.info.periodDays || null,
    imported: result.length,
    currencies: usable.map((s) => ({ currency: s.currency, rows: s.rows.length, reportSettings: s.settings })),
    skipped,
    supportedCurrencies: config.supportedCurrencies,
    anomalies,
  });
}));

// GET /?limit&cursor — imported settlements, each reconciled against our own ledger
router.get('/', requirePermission('commissions.view'), asyncHandler(async (req, res) => {
  const limit = parseLimit(req.query.limit);
  const cursor = decodeCursor(req.query.cursor);
  const result = await withWorkspace(wid(req), uid(req), async (c) => {
    const fetched = (await c.query(
      `SELECT * FROM settlements
        WHERE workspace_id = $1
          AND ($2::timestamptz IS NULL OR (period_end::timestamptz, id) < ($2::timestamptz, $3::uuid))
        ORDER BY period_end DESC, id DESC LIMIT $4`,
      [wid(req), cursor ? cursor.ts : null, cursor ? cursor.id : null, limit + 1])).rows;
    const { items: settlements, nextCursor } = page(fetched, limit, (r) => r.period_end, (r) => r.id);
    if (!settlements.length) return { items: [], nextCursor };

    // Our own numbers for every window in one round-trip, keyed by settlement id.
    const ours = new Map((await c.query(
      `SELECT s.id,
              COALESCE(SUM(t.gross) FILTER (WHERE t.status='approved'), 0)          AS gross,
              COUNT(t.id) FILTER (WHERE t.status='approved')                       AS sales,
              COUNT(t.id) FILTER (WHERE t.status='declined')                       AS declined,
              COALESCE(SUM(ce.psp_fee) FILTER (WHERE ce.entry_type='sale'), 0)     AS est_psp_fee,
              COUNT(ce.id) FILTER (WHERE ce.entry_type='refund')                   AS refunds,
              COUNT(ce.id) FILTER (WHERE ce.entry_type='chargeback')               AS chargebacks
         FROM settlements s
         LEFT JOIN transactions t
           ON t.currency = s.currency AND t.occurred_at >= s.period_start::date AND t.occurred_at < (s.period_end::date + 1)
         LEFT JOIN commission_entries ce ON ce.transaction_id = t.id
        WHERE s.id = ANY($1::uuid[])
        GROUP BY s.id`, [settlements.map((s) => s.id)])).rows.map((r) => [r.id, r]));

    const out = [];
    for (const s of settlements) {
      const o = ours.get(s.id) || {};
      const reported = { volume: n(s.volume), sales: n(s.total_transactions), declined: n(s.declined), refunds: n(s.refunds), chargebacks: n(s.chargebacks), fees: n(s.total_fees) };
      const mine = { volume: n(o.gross), sales: n(o.sales), declined: n(o.declined), refunds: n(o.refunds), chargebacks: n(o.chargebacks), fees: n(o.est_psp_fee) };

      out.push({
        id: s.id, currency: s.currency, periodStart: s.period_start, periodEnd: s.period_end,
        settlementDate: s.settlement_date, paid: s.paid,
        volume: n(s.volume), totalFees: n(s.total_fees), net: n(s.net),
        reserve: n(s.reserve), debit: n(s.debit), credit: n(s.credit),
        breakdown: {
          mdr: n(s.mdr), volumeFee: n(s.volume_fee), approvedCost: n(s.approved_cost),
          declineCost: n(s.decline_cost), refundCost: n(s.refund_cost), chargebackCost: n(s.chargeback_cost),
        },
        reportSettings: s.report_settings,
        reconciliation: {
          reported, ours: mine,
          variance: {
            volume: round2(reported.volume - mine.volume),
            sales: reported.sales - mine.sales,
            declined: reported.declined - mine.declined,
            fees: round2(reported.fees - mine.fees),
          },
          matched: Math.abs(reported.volume - mine.volume) < 0.01 && reported.sales === mine.sales,
        },
      });
    }
    return { items: out, nextCursor };
  });
  res.json(result);
}));

// GET /reserve — held vs released, per currency, using the negotiated release schedule
router.get('/reserve', requirePermission('commissions.view'), asyncHandler(async (req, res) => {
  const data = await withWorkspace(wid(req), uid(req), async (c) => {
    const cfg = (await c.query(
      `SELECT r.reserve_pct, r.reserve_release_days
         FROM workspaces w
         LEFT JOIN LATERAL effective_reserve(w.organization_id, now()) r ON true
        WHERE w.id = $1`, [wid(req)])).rows[0] || {};
    const releaseDays = n(cfg.reserve_release_days);

    const rows = (await c.query(
      `SELECT currency, settlement_date, reserve,
              (settlement_date + ($1 || ' days')::interval)::date AS release_on
         FROM settlements WHERE reserve > 0 ORDER BY settlement_date`, [String(releaseDays)])).rows;

    const byCurrency = {};
    for (const r of rows) {
      const cur = r.currency;
      byCurrency[cur] = byCurrency[cur] || { currency: cur, held: 0, released: 0, upcoming: [] };
      const releaseOn = r.release_on;
      const isReleased = releaseDays > 0 && releaseOn && new Date(releaseOn) <= new Date();
      if (isReleased) byCurrency[cur].released += n(r.reserve);
      else {
        byCurrency[cur].held += n(r.reserve);
        byCurrency[cur].upcoming.push({ releaseOn, amount: n(r.reserve) });
      }
    }
    Object.values(byCurrency).forEach((v) => {
      v.held = round2(v.held); v.released = round2(v.released);
      v.upcoming = v.upcoming.sort((a, b) => String(a.releaseOn).localeCompare(String(b.releaseOn))).slice(0, 6);
    });
    return { reservePct: n(cfg.reserve_pct), releaseDays, byCurrency: Object.values(byCurrency) };
  });
  res.json(data);
}));

module.exports = router;
