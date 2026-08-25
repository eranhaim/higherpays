'use strict';
// Mantapay request signing.
//
// Verified against the provider's own Signature Generator (Aug 2026):
//   input : 377109718015EURProduct-name0en-gbjohn+smithtest%40test.com
//           %2b972547880123067823012barkat+13HOLON5447778DIL999999
//   sha256: b9a3f24e99bade1cafd1b7587e47cbb293d7c6bda55ba28e95fcb8084c6e4674
//   base64: uaPyTpm63hyv0bdYfkfLspPXxr2lW6KOlfy4CExuRnQ=
//   urlenc: uaPyTpm63hyv0bdYfkfLspPXxr2lW6KOlfy4CExuRnQ%3D
// That vector is asserted in test() below — if their scheme ever changes, this
// fails loudly instead of silently producing links the provider rejects.
//
// Scheme: urlencode( base64( SHA256_raw( concat(values) + hashKey ) ) )
//  * base64 is of the RAW 32 digest bytes, NOT of the hex string.
//  * Values are concatenated with NO delimiter; empty values contribute nothing.
//  * Each value is URL-encoded BEFORE hashing (their step 2), so the string that
//    is hashed matches the string that is transmitted.
//  * POST: send Base64Signature (skip the urlencode) — their note under step 1.
const crypto = require('crypto');
const config = require('../config');

// FIELD ORDER — request order, corroborated twice.
// The Signature page says "keep the order identical to your request string", and
// the Hosted Overview repeats it: "pay attention to the ORDER of the parameters
// in the request and in the signature". Their JS snippet shows a different fixed
// order, but that is one illustrative arrangement, not a required one: the rule
// is that request order and signature order must MATCH each other.
// We follow request order, which reproduces their documented hash string exactly.
// If links are rejected with a signature error, try HOSTED_FIELD_ORDER_JS.
const HOSTED_FIELD_ORDER_REQUEST = [
  'merchantID', 'url_redirect', 'notification_url', 'trans_comment', 'trans_refNum',
  'Brand', 'trans_installments', 'amount_options', 'ui_version', 'trans_type',
  'trans_amount', 'trans_currency', 'disp_paymentType', 'disp_payFor', 'disp_recurring',
  'disp_lng', 'client_fullName', 'client_email', 'client_phoneNum', 'client_idNum',
  'client_billaddress1', 'client_billcity', 'client_billzipcode', 'client_billstate',
  'client_billcountry',
];

// The alternative ordering implied by their JS snippet, kept so a cutover is a
// config flip rather than a code change.
const HOSTED_FIELD_ORDER_JS = [
  'merchantID', 'trans_type', 'trans_comment', 'trans_refNum', 'trans_installments',
  'trans_amount', 'trans_currency', 'disp_payFor', 'client_email', 'client_fullName',
  'client_phoneNum', 'client_billaddress1', 'client_billaddress2', 'client_billcity',
  'client_billzipcode', 'client_billstate', 'client_billcountry', 'PLID',
  'trans_storePm', 'disp_lng', 'ui_version', 'Brand', 'url_redirect', 'notification_url',
];

// Server-to-server uses a fixed, much shorter field set.
const S2S_FIELD_ORDER = ['CompanyNum', 'TransType', 'TypeCredit', 'Amount', 'Currency', 'CardNum', 'RefTransID'];

// Their encoding is .NET's HttpUtility.UrlEncode, NOT JS encodeURIComponent.
// Two differences, both provable from their own example, and both fatal because
// the hash is byte-exact:
//   space -> "+"        (encodeURIComponent gives "%20")   e.g. "barkat+13"
//   hex escapes lower   (encodeURIComponent gives "%2B")   e.g. "%2b9725..."
// Getting either wrong yields a valid-looking signature the provider rejects.
function urlEncodeDotNet(value) {
  return encodeURIComponent(String(value))
    .replace(/%20/g, '+')
    .replace(/[!'()*]/g, (ch) => '%' + ch.charCodeAt(0).toString(16))  // encodeURIComponent leaves these
    .replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase());
}

/** SHA256 -> base64(raw). The core primitive. */
function digest(payload) {
  return crypto.createHash('sha256').update(payload, 'utf8').digest('base64');
}

/**
 * Build the signature for a hosted-page request.
 * @param {object} params  field name -> raw (un-encoded) value
 * @param {string} hashKey merchant hash key
 * @param {object} opts    { order, urlEncodeResult }
 * @returns {{ base64: string, encoded: string, signedString: string }}
 */
// HASH INPUT ENCODING — settled against their live Signature Validator.
//
// Neither doc page states the real rule plainly:
//   Signature page : hashes fully URL-ENCODED values (test%40test.com, %2b972...)
//   Validator page : says "raw (un-encoded) values"
// Both are wrong as written. The validator's own field-by-field output shows the
// truth: "%XX -> char, + kept as +". That is a HYBRID.
//
//   hash input = the raw value, with SPACES replaced by "+". Nothing else escaped.
//
// Equivalently: encode for the wire, then decode the %XX escapes back, keeping +.
// Verified: this reproduces their expected concat (168 chars) and their expected
// signature /o+QnAtvuyRHFRntTEtq879sWXq1oXl2P3I59ksTUkQ= byte-for-byte.
//
// Empty parameters contribute nothing but still occupy their position in the order.
function hashValue(v) {
  return String(v).replace(/ /g, '+');
}

function signHosted(params, hashKey, opts = {}) {
  if (!hashKey) throw new Error('mantapay_hash_key_missing');
  const order = opts.order || HOSTED_FIELD_ORDER_REQUEST;
  const signedString = order
    .map((k) => {
      const v = params[k];
      return v == null || v === '' ? '' : hashValue(v);
    })
    .join('') + hashKey;
  const base64 = digest(signedString);
  return { base64, encoded: encodeURIComponent(base64), signedString };
}

function signServerToServer(params, hashKey) {
  if (!hashKey) throw new Error('mantapay_hash_key_missing');
  const signedString = S2S_FIELD_ORDER
    .map((k) => (params[k] == null ? '' : String(params[k])))
    .join('') + hashKey;
  const base64 = digest(signedString);
  return { base64, encoded: encodeURIComponent(base64), signedString };
}

/**
 * Constant-time comparison, for verifying any signature the provider sends us.
 * (Inbound webhook verification is still unspecified — see notes in the adapter.)
 */
function safeEqual(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  if (x.length !== y.length) return false;
  try { return crypto.timingSafeEqual(x, y); } catch { return false; }
}

// The provider's own generator and validator vectors are asserted in
// test/mantapay.test.js — if their scheme ever changes, that suite fails.

module.exports = {
  digest, urlEncodeDotNet, hashValue, signHosted, signServerToServer, safeEqual,
  HOSTED_FIELD_ORDER_REQUEST, HOSTED_FIELD_ORDER_JS, S2S_FIELD_ORDER,
};

// ---------------------------------------------------------------------------
// INBOUND notification verification.
//
// Unlike the outbound request signature (which covers every field), the inbound
// notification signs only a SUBSET:
//   payment   : trans_id + trans_order + reply_code + trans_amount + trans_currency + hashKey
//   chargeback: trans_id + action + reason + reasonCode + comment + originalID + OrderId + hashKey
// The money-critical fields (amount, currency, order, status) ARE covered, which
// is what matters. Client details, trans_date and reply_desc are NOT signed and
// must never be trusted for anything that affects the ledger.
//
// Values are hashed EXACTLY as received, after URL-decoding of the form body.
// Never normalise, re-case or "correct" a value first (their own example
// contains the typo "Chargback" — hashing "Chargeback" would fail).
const PAYMENT_SIGNED_FIELDS    = ['trans_id', 'trans_order', 'reply_code', 'trans_amount', 'trans_currency'];
const CHARGEBACK_SIGNED_FIELDS = ['trans_id', 'action', 'reason', 'reasonCode', 'comment', 'originalID', 'OrderId'];

// Their examples use a lowercase `signature` for payments and a capital
// `Signature` for chargebacks, and urlencode it in one example but not the other.
// Accept either name; the transport layer has already URL-decoded the value.
function readSignature(p) {
  return p.signature != null ? p.signature : (p.Signature != null ? p.Signature : null);
}

function isChargebackNotification(p) {
  return p && p.action != null && p.originalID != null;
}

/** Recompute the expected signature for a notification payload. */
function expectedNotificationSignature(params, hashKey, kind) {
  const fields = (kind === 'chargeback' || (!kind && isChargebackNotification(params)))
    ? CHARGEBACK_SIGNED_FIELDS
    : PAYMENT_SIGNED_FIELDS;
  const base = fields.map((f) => (params[f] == null ? '' : String(params[f]))).join('');
  return digest(base + hashKey);
}

/** Constant-time verification of an inbound notification. */
function verifyNotification(params, hashKey) {
  const provided = readSignature(params);
  if (!provided || !hashKey) return false;
  return safeEqual(provided, expectedNotificationSignature(params, hashKey));
}

// reply_code semantics, from their Reply Codes page.
//
// Codes are STRINGS, not numbers: the list contains dotted codes (100.011),
// alphanumerics (N7, 5C, 9G, 6P) and leading zeros (000, 001). Never parse as int.
//
// There are THREE pending codes, not one. Treating 001 or 663 as a decline would
// mark a link failed while the customer is still completing a wire/PIX transfer.
const REPLY_APPROVED = new Set(['000']);
const REPLY_PENDING = new Set([
  '553', // 3D/APM redirect needed (the hosted page handles this itself)
  '663', // still awaiting final response
  '001', // passed initial step, awaiting customer to complete (PIX / wire transfer)
]);
// Customer closed the payment window. Not a bank decline — an abandonment.
// Kept separate so we don't report "payment declined" for someone who just left.
const REPLY_ABANDONED = new Set(['600']);
// Test-environment-only codes; must never appear in production.
const REPLY_TEST_ONLY = new Set(['1001', '1002']);
// Signature/merchant configuration failures. Surfaced distinctly because these
// mean OUR request was malformed, not that the customer's card failed.
const REPLY_CONFIG_ERROR = new Set(['500', '501', '502', '503', '526', '528', '534']);

function mapReplyCode(code) {
  const c = String(code == null ? '' : code).trim();
  if (c === '') return 'unknown';
  if (REPLY_APPROVED.has(c)) return 'approved';
  if (REPLY_PENDING.has(c)) return 'pending';
  if (REPLY_ABANDONED.has(c)) return 'abandoned';
  return 'declined';
}

/** True when a decline indicates a problem with OUR integration, not the card. */
function isConfigurationError(code) {
  return REPLY_CONFIG_ERROR.has(String(code == null ? '' : code).trim());
}
function isTestOnlyCode(code) {
  return REPLY_TEST_ONLY.has(String(code == null ? '' : code).trim());
}

module.exports.PAYMENT_SIGNED_FIELDS = PAYMENT_SIGNED_FIELDS;
module.exports.CHARGEBACK_SIGNED_FIELDS = CHARGEBACK_SIGNED_FIELDS;
module.exports.readSignature = readSignature;
module.exports.isChargebackNotification = isChargebackNotification;
module.exports.expectedNotificationSignature = expectedNotificationSignature;
module.exports.verifyNotification = verifyNotification;
module.exports.mapReplyCode = mapReplyCode;
module.exports.isConfigurationError = isConfigurationError;
module.exports.isTestOnlyCode = isTestOnlyCode;
module.exports.REPLY_APPROVED = REPLY_APPROVED;
module.exports.REPLY_PENDING = REPLY_PENDING;

// ---------------------------------------------------------------------------
// Integration-mode test amounts (their "Controlling Replies" page).
// In integration mode the AMOUNT drives the outcome — useful for exercising the
// declined and delayed paths without needing real failures.
//
// NOTE: any amount NOT in this table and below 1.00 returns 596
// ("Integration mode - incorrect charge amount"), so tests must use these exact
// values or >= 1.00.
const TEST_AMOUNTS = {
  '0.04': { code: '1001', expect: 'declined', note: 'soft decline (call)' },
  '0.05': { code: '1002', expect: 'declined', note: 'insufficient funds' },
  '0.90': { code: '000', expect: 'approved', note: 'approved after 5s' },
  '0.95': { code: '000', expect: 'approved', note: 'approved after 50s' },
  '0.99': { code: '000', expect: 'approved', note: 'approved after 90s' },
  // Their Controlling Replies page says this returns 533; their Reply Codes page
  // documents 553 as the 3D/APM redirect status (533 is "cannot refund more than
  // the original amount", which makes no sense here). Treated as a typo for 553,
  // but CONFIRM before relying on it — if it really is 533 we would classify a
  // 3DS redirect as a decline.
  '55.3': { code: '553', expect: 'pending', note: '3DS/APM redirect simulator (see caveat)' },
  '1.00': { code: '000', expect: 'approved', note: 'any amount >= 1.00 is approved' },
};

module.exports.TEST_AMOUNTS = TEST_AMOUNTS;
