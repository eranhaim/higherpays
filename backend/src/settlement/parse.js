'use strict';
// Parses the provider's daily settlement export (XLSX).
//
// Layout notes learned from a real export:
//  * One "Info" sheet, then one "Settlement <CCY>" sheet per currency.
//  * Header row is row 3. Header cells carry the configured rate on a second
//    line, e.g. "Chargeback cost\n130.00 EUR" or "RR\n5.00%".
//  * Column ORDER IS NOT STABLE: non-base-currency sheets insert an extra
//    "FX rate" column, and "NET USD" can appear twice. So never index by
//    position — always resolve columns by their header name.
//
// Parsing a workbook is CPU-bound (zip + XML), so the route runs it in a
// worker thread (`parseInWorker`) rather than on the request path.
const path = require('path');
const { Worker } = require('worker_threads');
const ExcelJS = require('exceljs');

const HEADER_ROW = 3;
const FIRST_DATA_ROW = 4;
const WORKER_TIMEOUT_MS = 30_000;

/** Flattens exceljs cell values (rich text, formulas, hyperlinks) to a plain value. */
function cellValue(v) {
  if (v == null) return null;
  if (v instanceof Date || typeof v !== 'object') return v;
  if (Array.isArray(v.richText)) return v.richText.map((p) => p.text).join('');
  if ('result' in v) return cellValue(v.result);
  if ('text' in v) return cellValue(v.text);
  if ('error' in v) return null;
  return v;
}

/** Row values as a 0-based array, blanks as null. */
function rowValues(ws, rowNumber) {
  const raw = ws.getRow(rowNumber).values;
  const out = [];
  for (let i = 1; i < raw.length; i++) out.push(cellValue(raw[i]));
  return out;
}

const norm = (v) => String(v == null ? '' : v).split('\n')[0].trim().toLowerCase();
const secondLine = (v) => {
  const parts = String(v == null ? '' : v).split('\n');
  return parts.length > 1 ? parts[1].trim() : null;
};
const num = (v) => {
  if (v == null || v === '') return 0;
  if (typeof v === 'number') return v;
  const n = Number(String(v).replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? n : 0;
};
// provider writes dd.mm.yyyy
function parseDate(v) {
  if (v == null || v === '') return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(String(v).trim());
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  const d = new Date(v);
  return isNaN(d) ? null : d.toISOString().slice(0, 10);
}
function pct(s) { const m = s && /([\d.]+)\s*%/.exec(s); return m ? Number(m[1]) : null; }
function money(s) { const m = s && /([\d.]+)\s*([A-Z]{3})/.exec(s); return m ? { amount: Number(m[1]), currency: m[2] } : null; }

function parseInfo(wb) {
  const ws = wb.getWorksheet('Info');
  if (!ws) return {};
  const out = {};
  for (let i = 1; i <= ws.rowCount; i++) {
    const r = rowValues(ws, i);
    const k = norm(r[0]);
    if (k === 'merchant') out.merchant = String(r[1] || '').trim();
    if (k === 'base settlement currency') out.baseCurrency = String(r[1] || '').trim().toUpperCase();
    if (k === 'period days') out.periodDays = num(r[1]);
  }
  return out;
}

function parseSheet(ws) {
  const currency = ws.name.replace(/^settlement\s*/i, '').trim().toUpperCase();
  const header = rowValues(ws, HEADER_ROW);

  // name -> first index (duplicates like "NET USD" keep the first)
  const col = {};
  header.forEach((h, i) => { const k = norm(h); if (k && !(k in col)) col[k] = i; });

  // the fee settings the provider had configured when the report was generated
  const settings = {
    approvedTrxCost: money(secondLine(header[col['approved trx cost']])),
    declineCost: money(secondLine(header[col['decline cost']])),
    refundCost: money(secondLine(header[col['refund cost']])),
    chargebackCost: money(secondLine(header[col['chargeback cost']])),
    mdrPct: pct(secondLine(header[col['mdr']])),
    volumeFeePct: pct(secondLine(header[col['volume fee']])),
    reservePct: pct(secondLine(header[col['rr']])),
  };

  // NET column for this sheet's own currency ("NET EUR" on the EUR sheet)
  const netKey = `net ${currency.toLowerCase()}`;
  const g = (r, key) => (col[key] == null ? null : r[col[key]]);

  const out = [];
  for (let i = FIRST_DATA_ROW; i <= ws.rowCount; i++) {
    const r = rowValues(ws, i);
    if (r.every((c) => c == null || c === '')) continue;
    const periodStart = parseDate(g(r, 'start date'));
    const periodEnd = parseDate(g(r, 'end date'));
    if (!periodStart || !periodEnd) continue;

    out.push({
      currency,
      paid: /^(x|✓|☑|yes|true)$/i.test(String(g(r, 'paid') || '').trim()),
      settlementDate: parseDate(g(r, 'settlement date')),
      periodStart,
      periodEnd,
      firstTransaction: g(r, 'first transaction') == null ? null : String(g(r, 'first transaction')),
      lastTransaction: g(r, 'last transaction') == null ? null : String(g(r, 'last transaction')),
      totalTransactions: num(g(r, 'total transactions')),
      refunds: num(g(r, 'refunds')),
      chargebacks: num(g(r, 'chargebacks')),
      declined: num(g(r, 'declined')),
      volume: num(g(r, 'total capture/volume')),
      approvedCost: num(g(r, 'approved trx cost')),
      declineCost: num(g(r, 'decline cost')),
      refundCost: num(g(r, 'refund cost')),
      chargebackCost: num(g(r, 'chargeback cost')),
      mdr: num(g(r, 'mdr')),
      volumeFee: num(g(r, 'volume fee')),
      reserve: num(g(r, 'rr')),
      totalFees: num(g(r, 'total')),
      net: num(col[netKey] != null ? r[col[netKey]] : null),
      debit: num(g(r, 'debit usdt')),
      credit: num(g(r, 'credit usdt')),
    });
  }
  return { currency, settings, rows: out };
}

async function parseSettlementWorkbook(buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const info = parseInfo(wb);
  const sheets = wb.worksheets
    .filter((ws) => /^settlement\s+/i.test(ws.name))
    .map(parseSheet)
    .filter((s) => s.rows.length || s.currency);
  if (!sheets.length) {
    throw Object.assign(new Error('no_settlement_sheets'), {
      status: 400,
      detail: 'No "Settlement <CURRENCY>" sheets found. Is this the provider\'s settlement export?',
    });
  }
  return { info, sheets };
}

/** Same result as parseSettlementWorkbook, computed off the request thread. */
function parseInWorker(buffer) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, 'parse.worker.js'), { workerData: buffer });
    const timer = setTimeout(() => {
      worker.terminate();
      reject(Object.assign(new Error('parse_timeout'), { status: 400, detail: 'The workbook took too long to parse.' }));
    }, WORKER_TIMEOUT_MS);
    worker.once('message', (msg) => {
      clearTimeout(timer);
      if (msg.ok) resolve(msg.result);
      else reject(Object.assign(new Error(msg.error), { status: msg.status || 400, detail: msg.detail }));
    });
    worker.once('error', (err) => { clearTimeout(timer); reject(err); });
  });
}

module.exports = { parseSettlementWorkbook, parseInWorker, parseDate, num };
