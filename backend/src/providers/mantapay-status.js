'use strict';
// Mantapay status check — the safety net when a notification never arrives.
//
// NOTE: this lives on a DIFFERENT host to the hosted page.
//   hosted page : https://uiservices.mantapay.biz
//   status check: https://process.mantapay.biz
//
// Two modes:
//   by TransID — form-encoded reply, NO signature required. Returns the PENDING
//                transaction by default; RequestType=1 for anything else.
//   by Order   — JSON, signed. Returns EVERY transaction sharing that order id,
//                because the same order can be attempted several times (some
//                declined, one approved). This is the mode we want: it maps our
//                reference back to the real outcome.
const config = require('../config');
const sig = require('./mantapay-signature');
const { fetchWithTimeout } = require('./http');

const STATUS_PATH = '/member/getStatus.asp';

/** Signature for the by-order lookup: base64(SHA256(CompanyNum + Order + key)). */
function orderSignature(companyNum, order, hashKey) {
  if (!hashKey) throw Object.assign(new Error('mantapay_hash_key_missing'), { status: 500 });
  return sig.digest(String(companyNum) + String(order) + hashKey);
}

async function httpGet(url) {
  const r = await fetchWithTimeout(url, { method: 'GET' });
  const text = await r.text();
  return { ok: r.ok, status: r.status, text };
}

/** Parse the form-encoded reply used by the by-TransID mode. */
function parseFormReply(text) {
  const out = {};
  for (const part of String(text || '').split('&')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).replace(/\+/g, ' '));
  }
  return out;
}

/**
 * Look up every transaction recorded against one of our order references.
 * @returns {{ ok:boolean, error?:string, transactions:Array }}
 */
async function getStatusByOrder(companyNum, order, hashKey) {
  const qs = new URLSearchParams({
    Order: String(order),
    CompanyNum: String(companyNum),
    signature: orderSignature(companyNum, order, hashKey),
  }).toString();
  const res = await httpGet(`${config.mantapayProcessBase}${STATUS_PATH}?${qs}`);

  let body = null;
  try { body = JSON.parse(res.text); } catch { /* not JSON */ }
  if (!body) {
    throw Object.assign(new Error('mantapay_status_unparseable'), {
      status: 502, detail: String(res.text).slice(0, 300),
    });
  }
  // Their failure shape: { error:"103", message:"Failed On Authentication", data:[] }
  if (body.error && String(body.error) !== '0') {
    return { ok: false, error: String(body.error), message: body.message || null, transactions: [] };
  }

  const transactions = (body.data || []).map((d) => ({
    // camelCase here, snake_case in notifications — accept whatever arrives
    replyCode: d.replyCode != null ? String(d.replyCode) : (d.Reply != null ? String(d.Reply) : null),
    replyDesc: d.replyDesc || d.ReplyDesc || null,
    transId: d.trans_id != null ? String(d.trans_id) : (d.TransID != null ? String(d.TransID) : null),
    date: parseTransDate(d.trans_date),
    amount: d.trans_amount != null ? Number(d.trans_amount) : null,
    currency: d.trans_currency || null,
    order: d.trans_order != null ? String(d.trans_order) : String(order),
    status: sig.mapReplyCode(d.replyCode != null ? d.replyCode : d.Reply),
  }));
  return { ok: true, transactions };
}

/** Look up one transaction by the provider's own id. No signature required. */
async function getStatusById(companyNum, transId, { includeNonPending = true } = {}) {
  const qs = new URLSearchParams({ CompanyNum: String(companyNum), TransID: String(transId) });
  if (includeNonPending) qs.set('RequestType', '1');
  const res = await httpGet(`${config.mantapayProcessBase}${STATUS_PATH}?${qs.toString()}`);
  const p = parseFormReply(res.text);
  const code = p.Reply != null ? String(p.Reply) : null;
  return { replyCode: code, replyDesc: p.ReplyDesc || null, transId: p.TransID || String(transId), status: sig.mapReplyCode(code) };
}

// Their dates are DD/MM/YYYY HH:mm:ss (note: the settlement report used dd.mm.yyyy).
function parseTransDate(v) {
  if (!v) return null;
  const m = /^(\d{2})\/(\d{2})\/(\d{4})[ T](\d{2}):(\d{2}):(\d{2})$/.exec(String(v).trim());
  if (!m) { const d = new Date(v); return isNaN(d) ? null : d.toISOString(); }
  return new Date(Date.UTC(+m[3], +m[2] - 1, +m[1], +m[4], +m[5], +m[6])).toISOString();
}

/**
 * Decide the real outcome of an order from its (possibly many) attempts.
 * An order can be retried: several declines and one approval. An approval wins;
 * otherwise a pending attempt keeps the link open; otherwise it is declined.
 */
function resolveOrderOutcome(transactions) {
  const list = transactions || [];
  if (!list.length) return { status: 'unknown', transaction: null, attempts: 0 };
  const approved = list.find((t) => t.status === 'approved');
  if (approved) return { status: 'approved', transaction: approved, attempts: list.length };
  const pending = list.find((t) => t.status === 'pending');
  if (pending) return { status: 'pending', transaction: pending, attempts: list.length };
  const latest = list.slice().sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')))[0];
  return { status: latest.status, transaction: latest, attempts: list.length };
}

module.exports = {
  STATUS_PATH, orderSignature, getStatusByOrder, getStatusById,
  parseFormReply, parseTransDate, resolveOrderOutcome,
};
