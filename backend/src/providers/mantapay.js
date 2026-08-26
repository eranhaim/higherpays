'use strict';
// MantaPay provider adapter.
//
// Presents the same surface the routes already use, so switching provider is an
// import change rather than a rewrite:
//   resolveApiKey, createCheckout, parseWebhook, verifyWebhookSignature,
//   SIGNATURE_HEADER, getPaymentStatus, mapPaymentStatus, isAmbiguousStatus,
//   refundPayment
//
// The heavy lifting lives in focused modules, each verified independently:
//   mantapay-signature.js  request + notification signatures, reply codes
//   mantapay-checkout.js   hosted-page URL / form construction
//   mantapay-status.js     status check (by order, by transaction id)
//   mantapay-search.js     transaction search with PER-TRANSACTION FEES
//   mantapay-auth.js       webservices login + session caching
const config = require('../config');
const sig = require('./mantapay-signature');
const checkout = require('./mantapay-checkout');
const status = require('./mantapay-status');
const search = require('./mantapay-search');
const auth = require('./mantapay-auth');

// MantaPay signs notifications in the body, not a header — but the routes read a
// header name, so expose the field name they use. verifyWebhookSignature below
// works off the parsed body regardless.
const SIGNATURE_HEADER = 'signature';

/**
 * Per-workspace hash key. Never stored in the database: the workspace holds a
 * REFERENCE to an env var, so a database leak does not leak signing keys.
 */
function resolveApiKey(ws) {
  const ref = ws && ws.provider_config_ref;
  if (ref && process.env[ref]) return process.env[ref];
  return config.mantapayHashKey;
}

/** Merchant number for a workspace (their `merchantID`). */
function resolveMerchantId(ws) {
  return (ws && ws.merchant_id) || config.mantapayMerchantId || null;
}

/**
 * Build a hosted-page checkout.
 * Returns the same shape the links route expects, plus MantaPay extras.
 */
async function createCheckout(ws, o = {}) {
  const built = checkout.buildCheckout({
    merchantId: resolveMerchantId(ws),
    hashKey: resolveApiKey(ws),
    amount: o.amount,
    currency: o.currency || 'EUR',
    reference: o.reference,
    description: o.description,
    notificationUrl: o.notificationUrl,
    redirectUrl: o.redirectUrl,
    expiresAt: o.expiresAt,
    language: o.language,
    brand: o.brand,
    customer: o.customer,
    extraCosts: o.extraCosts,
    extraCostAmount: o.extraCostAmount,
    extraCostName: o.extraCostName,
    extraCostDescription: o.extraCostDescription,
  });
  return {
    // The hosted page is reached by sending the payer here. No server call is
    // made to create it, so there is no provider-side id until they pay.
    checkoutUrl: built.url,
    postUrl: built.postUrl,
    formFields: built.formFields,
    providerLinkId: null,
    signature: built.signature,
  };
}

/**
 * Parse an inbound notification (payment or chargeback) into our vocabulary.
 * Body is form-encoded; they explicitly require POST support.
 */
function parseWebhook(raw) {
  const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw || '');
  const p = status.parseFormReply(text);

  if (sig.isChargebackNotification(p)) {
    return {
      kind: 'chargeback',
      providerEventId: p.trans_id || null,
      transactionId: p.trans_id || null,
      originalTransactionId: p.originalID || null,
      referenceId: p.OrderId || null,
      action: p.action || null,
      reason: p.reason || null,
      reasonCode: p.reasonCode || null,
      comment: p.comment || null,
      status: 'chargeback',
      fields: p,   // stored verbatim in webhook_events.payload
      raw: p,
    };
  }

  const code = p.reply_code != null ? p.reply_code : p.replyCode;
  const mapped = sig.mapReplyCode(code);
  return {
    kind: 'payment',
    providerEventId: p.trans_id || null,
    transactionId: p.trans_id || null,
    // `trans_order` is our own reference echoed back. WHICH request field
    // populates it is unconfirmed — see OPEN-QUESTIONS-MANTAPAY.md #1.
    referenceId: p.trans_order || null,
    merchantId: p.merchant_id || null,
    replyCode: code != null ? String(code) : null,
    replyDesc: p.reply_desc || null,
    // approved | declined | pending | abandoned | unknown
    status: mapped === 'approved' ? 'approved'
          : (mapped === 'declined' || mapped === 'abandoned') ? 'declined'
          : mapped,
    // `gross` is the name the routes read; `grossAmount` kept as an alias.
    // NOTE: whether trans_amount includes the EC surcharge is unconfirmed —
    // see OPEN-QUESTIONS-MANTAPAY.md #2.
    gross: p.trans_amount != null ? Number(p.trans_amount) : null,
    grossAmount: p.trans_amount != null ? Number(p.trans_amount) : null,
    // MantaPay does NOT report the fee or the net in the notification — unlike
    // the previous provider. Per-transaction fees come from the Search API
    // afterwards. So we record fee as unknown (null) here and let the payout
    // engine price the sale from the rate card; reconciliation later replaces
    // the estimate with the provider's actual figure.
    fee: null,
    net: null,
    currency: p.trans_currency || null,
    paymentDetails: p.payment_details || null,
    clientEmail: p.client_email || null,
    clientName: p.client_fullname || null,
    occurredAt: p.trans_date || null,
    fields: p,   // stored verbatim in webhook_events.payload
    raw: p,
  };
}

/**
 * Verify an inbound notification. MantaPay signs a SUBSET of fields inside the
 * body, so the raw body is what we check — the `provided` argument (a header) is
 * ignored and accepted only for signature-compatibility with the route.
 */
function verifyWebhookSignature(raw, apiKey /* , providedHeader */) {
  const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw || '');
  const p = status.parseFormReply(text);
  return sig.verifyNotification(p, apiKey);
}

/** Poll a payment by OUR order reference. Returns the resolved outcome. */
async function getPaymentStatus(ws, reference) {
  const res = await status.getStatusByOrder(resolveMerchantId(ws), reference, resolveApiKey(ws));
  if (!res.ok) {
    throw Object.assign(new Error('mantapay_status_failed'), { status: 502, detail: res.message || res.error });
  }
  const outcome = status.resolveOrderOutcome(res.transactions);
  return {
    payment_request_status_id: outcome.transaction ? outcome.transaction.replyCode : null,
    status: outcome.status,
    attempts: outcome.attempts,
    transaction_id: outcome.transaction ? outcome.transaction.transId : null,
    gross_amount: outcome.transaction ? outcome.transaction.amount : null,
    unit: outcome.transaction ? outcome.transaction.currency : null,
    transactions: res.transactions,
  };
}

/** Reply code -> our vocabulary. Codes are strings; never parse as integers. */
function mapPaymentStatus(code) { return sig.mapReplyCode(code); }

/**
 * MantaPay documents its status codes unambiguously (000 approved; 553/663/001
 * pending; everything else declined), so unlike the previous provider there is
 * no ambiguous-code window to defend against.
 */
function isAmbiguousStatus() { return false; }

/**
 * Refund. Their flow is a two-step request that an admin approves, and the docs
 * for it have not been read yet — so this fails loudly rather than pretending.
 * Until then the console records refunds issued in their dashboard.
 */
async function refundPayment() {
  throw Object.assign(new Error('refund_endpoint_not_configured'), {
    status: 501,
    detail: 'MantaPay refund API not yet implemented (PP-Refund-Request/Process/Status pages unread). Record the refund as external.',
  });
}

module.exports = {
  SIGNATURE_HEADER,
  resolveApiKey, resolveMerchantId,
  createCheckout, parseWebhook, verifyWebhookSignature,
  getPaymentStatus, mapPaymentStatus, isAmbiguousStatus, refundPayment,
  // richer surfaces, used directly by reconciliation
  status, search, auth, signature: sig, checkout,
};
