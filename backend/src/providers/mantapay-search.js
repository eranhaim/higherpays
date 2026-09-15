'use strict';
// MantaPay Transaction Search — reconciliation with PER-TRANSACTION FEES.
//
// MantaPay returns a TransactionFees object on every transaction, so we can
// price the real cost of each sale, compute true margin, and reconcile without
// importing a settlement spreadsheet.
//
// THIRD host again:
//   hosted page  https://uiservices.mantapay.biz
//   status check https://process.mantapay.biz
//   search API   https://webservices.mantapay.biz
//
// Auth is NOT the hosted-page hash key. It needs:
//   applicationToken        (issued by support)
//   CredentialsToken        (from the Authentication call — see AUTH, unread)
//   Signature: "bytes-SHA256, " + base64(SHA256(rawRequestBody + salt))
// Note the signature covers the RAW BODY, uses a "salt" (relationship to the
// hash key is unconfirmed), and carries a literal prefix.
const config = require('../config');
const crypto = require('crypto');
const auth = require('./mantapay-auth');

const SEARCH_PATH = '/v2/transactions.svc/Search';

// Captured=1, Declined=2, Approval=3, Pending=4, IsRefund=5
const TRANS_TYPE = { captured: 1, declined: 2, approval: 3, pending: 4, refund: 5 };

/**
 * Microsoft/WCF date format: /Date(1702554387000+0000)/
 * Their own examples mix SECONDS and MILLISECONDS, so length decides.
 */
function parseDotNetDate(v) {
  if (v == null) return null;
  const m = /\/Date\((-?\d+)([+-]\d{4})?\)\//.exec(String(v));
  if (!m) { const d = new Date(v); return isNaN(d) ? null : d.toISOString(); }
  let n = Number(m[1]);
  if (String(m[1]).replace('-', '').length <= 10) n *= 1000;   // seconds -> ms
  return new Date(n).toISOString();
}

function toDotNetDate(d) {
  const ms = d instanceof Date ? d.getTime() : Number(d);
  return `/Date(${ms}+0000)/`;
}

/** "bytes-SHA256, " + base64(SHA256(rawBody + salt)) */
function bodySignature(rawBody, salt) {
  if (!salt) throw Object.assign(new Error('mantapay_search_salt_missing'), { status: 500 });
  const h = crypto.createHash('sha256').update(String(rawBody) + String(salt), 'utf8').digest('base64');
  return `bytes-SHA256, ${h}`;
}

const num = (v) => (v == null ? 0 : Number(v));

/** Flatten one search result into the shape our ledger reconciles against. */
function normaliseTransaction(t) {
  const f = t.TransactionFees || {};
  const fees = {
    debit: num(f.DebitFee),                 // the processing fee for this transaction
    transaction: num(f.TransactionFee),     // per-transaction fixed
    handling: num(f.HandlingFee),
    ratio: num(f.RatioFee),
    chargeback: num(f.ChargebackFee),
    chargebackDebit: num(f.DebitFeeChb),
    clarification: num(f.ClarificationFee),
  };
  fees.total = fees.debit + fees.transaction + fees.handling + fees.ratio
             + fees.chargeback + fees.chargebackDebit + fees.clarification;

  return {
    transId: t.ID != null ? String(t.ID) : null,
    orderId: t.OrderId != null ? String(t.OrderId) : null,   // OUR reference
    date: parseDotNetDate(t.InsertDate),
    amount: num(t.Amount),
    currency: t.CurrencyIso || null,
    sourceAmount: num(t.SourceAmount),
    sourceCurrency: t.SourceCurrency || null,
    replyCode: t.ReplyCode != null && t.ReplyCode !== '' ? String(t.ReplyCode) : null,
    replyDescription: t.ReplyDescription || null,
    is3D: !!t.Is3D,
    isRefund: !!t.IsRefund,
    isRefunded: !!t.IsRefunded,
    isChargeback: !!t.IsChargeback,
    originalTransId: t.OriginalTransId ? String(t.OriginalTransId) : null,
    paymentDisplay: t.PaymentDisplay || null,
    binCountry: t.PaymentData ? t.PaymentData.BinCountry : null,
    fees,
  };
}

/**
 * Search transactions for a period.
 * @param {object} o { from, to, transType, pageNumber, pageSize,
 *                     applicationToken, credentialsToken, salt }
 */
async function searchTransactions(o = {}) {
  const body = {
    filters: {
      DateFrom: toDotNetDate(o.from || new Date(Date.now() - 86400000)),
      ...(o.to ? { DateTo: toDotNetDate(o.to) } : {}),
      ...(o.customerId ? { CustomerId: o.customerId } : {}),
    },
    loadOptions: {
      TransType: o.transType != null ? o.transType : TRANS_TYPE.captured,
      LoadMerchant: false,
      LoadPayment: true,
      LoadPayer: true,
      LoadFees: true,            // without this there are no per-transaction fees
    },
    sortAndPage: {
      PageNumber: o.pageNumber || 1,
      PageSize: Math.min(1000, o.pageSize || 1000),
    },
  };
  const raw = JSON.stringify(body);

  // The login response tells us what to CALL the credentials header; it is not
  // literally "CredentialsHeaderName". Getting this wrong yields a 401 that
  // looks like bad credentials.
  const session = o.session || await auth.getSession(o);
  const headers = {
    'Content-Type': 'application/json',
    applicationToken: o.applicationToken || config.mantapayAppToken || '',
    Signature: bodySignature(raw, o.salt || config.mantapaySearchSalt || session.signature),
  };
  headers[session.headerName] = session.token;

  let r = await fetch(`${config.mantapaySearchBase}${SEARCH_PATH}`, { method: 'POST', headers, body: raw });
  // A stale cached token looks like an auth failure — retry once with a fresh login.
  if (r.status === 401 && !o.session) {
    auth.invalidateSession(o);
    const fresh = await auth.getSession(o);
    headers[fresh.headerName] = fresh.token;
    headers.Signature = bodySignature(raw, o.salt || config.mantapaySearchSalt || fresh.signature);
    r = await fetch(`${config.mantapaySearchBase}${SEARCH_PATH}`, { method: 'POST', headers, body: raw });
  }
  const text = await r.text();
  let data = null; try { data = JSON.parse(text); } catch { /* non-JSON */ }
  if (!r.ok || !data) {
    throw Object.assign(new Error('mantapay_search_failed'), {
      status: r.status, detail: String(text).slice(0, 300),
    });
  }
  // WCF wraps the payload in "d"
  const rows = Array.isArray(data.d) ? data.d : (Array.isArray(data) ? data : []);
  return {
    pageNumber: body.sortAndPage.PageNumber,
    pageSize: body.sortAndPage.PageSize,
    count: rows.length,
    transactions: rows.map(normaliseTransaction),
  };
}

module.exports = {
  SEARCH_PATH, TRANS_TYPE, searchTransactions, normaliseTransaction,
  parseDotNetDate, toDotNetDate, bodySignature,
};
