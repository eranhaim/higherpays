'use strict';
// The settlement parser resolves columns by header name, reads the configured
// rates from the header's second line, and survives the provider's unstable
// column order. The workbook is built here so the test carries its own fixture.
const test = require('node:test');
const assert = require('node:assert/strict');
const ExcelJS = require('exceljs');
const { parseSettlementWorkbook, parseInWorker } = require('../src/settlement/parse');

async function buildWorkbook({ extraColumn = false } = {}) {
  const wb = new ExcelJS.Workbook();
  const info = wb.addWorksheet('Info');
  info.addRow(['Merchant', 'Test Agency']);
  info.addRow(['Base settlement currency', 'eur']);
  info.addRow(['Period days', 7]);

  const eur = wb.addWorksheet('Settlement EUR');
  eur.addRow(['Settlement report']);
  eur.addRow([]);
  const header = [
    'Paid', 'Settlement date', 'Start date', 'End date', 'First transaction', 'Last transaction',
    'Total transactions', 'Refunds', 'Chargebacks', 'Declined',
    ...(extraColumn ? ['FX rate'] : []),
    'Total capture/volume', 'Approved trx cost\n0.50 EUR', 'Decline cost\n0.30 EUR', 'Refund cost\n15.00 EUR',
    'Chargeback cost\n130.00 EUR', 'MDR\n7.00%', 'Volume fee\n1.00%', 'RR\n5.00%', 'Total', 'NET EUR', 'NET USD', 'NET USD',
  ];
  eur.addRow(header);
  eur.addRow([
    'x', '08.08.2026', '01.08.2026', '07.08.2026', 'T-1', 'T-99',
    12, 1, 0, 3,
    ...(extraColumn ? [1.0] : []),
    1000, 6, 0.9, 15, 0, 70, 10, 50, 151.9, 848.1, 900, 901,
  ]);
  eur.addRow([]);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

test('reads the info sheet, the header rates, and one settlement row', async () => {
  const parsed = await parseSettlementWorkbook(await buildWorkbook());
  assert.equal(parsed.info.merchant, 'Test Agency');
  assert.equal(parsed.info.baseCurrency, 'EUR');
  assert.equal(parsed.info.periodDays, 7);

  const sheet = parsed.sheets[0];
  assert.equal(sheet.currency, 'EUR');
  assert.deepEqual(sheet.settings.chargebackCost, { amount: 130, currency: 'EUR' });
  assert.equal(sheet.settings.mdrPct, 7);
  assert.equal(sheet.settings.reservePct, 5);

  const row = sheet.rows[0];
  assert.equal(row.paid, true);
  assert.equal(row.settlementDate, '2026-08-08');
  assert.equal(row.periodStart, '2026-08-01');
  assert.equal(row.periodEnd, '2026-08-07');
  assert.equal(row.totalTransactions, 12);
  assert.equal(row.volume, 1000);
  assert.equal(row.totalFees, 151.9);
  assert.equal(row.net, 848.1, 'the NET column for the sheet currency, not the USD one');
  assert.equal(sheet.rows.length, 1, 'blank rows are skipped');
});

test('an inserted column does not shift the values', async () => {
  const parsed = await parseSettlementWorkbook(await buildWorkbook({ extraColumn: true }));
  const row = parsed.sheets[0].rows[0];
  assert.equal(row.volume, 1000);
  assert.equal(row.net, 848.1);
});

test('rejects a workbook with no settlement sheets', async () => {
  const wb = new ExcelJS.Workbook();
  wb.addWorksheet('Info').addRow(['Merchant', 'x']);
  await assert.rejects(parseSettlementWorkbook(Buffer.from(await wb.xlsx.writeBuffer())), /no_settlement_sheets/);
});

test('the worker thread returns the same result as the direct parse', async () => {
  const buf = await buildWorkbook();
  const direct = await parseSettlementWorkbook(buf);
  const viaWorker = await parseInWorker(buf);
  assert.deepEqual(viaWorker, direct);
});
