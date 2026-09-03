'use strict';
// Mantapay hosted-page checkout.
//
// THE ONE RULE THAT MATTERS: the signature covers "all parameters in the order
// they appear in the request". Their own examples use two different orders and
// both are valid, because each signs in its own request order. So the only way
// to get this wrong is to let the query string and the signature diverge.
//
// This module therefore builds BOTH from a single ordered array. There is no
// second list to keep in sync, so they cannot drift.
const config = require('../config');
const sig = require('./mantapay-signature');

const HOSTED_PATH = '/hosted/default.aspx';

// Max lengths from their field table. Exceeding them risks a silent reject, so
// we truncate deliberately rather than let the provider decide.
const MAX_LEN = {
  disp_payFor: 40, trans_comment: 255, trans_refNum: 100, PLID: 100,
  client_fullName: 50, client_email: 50, client_phoneNum: 15, client_idNum: 9,
  client_billAddress1: 50, client_billAddress2: 50, client_billCity: 20,
  client_billZipcode: 20, client_billState: 2, client_billCountry: 2,
  notification_url: 255, url_redirect: 255, terms_url: 100,
};

const clip = (v, n) => (v == null ? '' : (n ? String(v).slice(0, n) : String(v)));


const EC_MAX_LEN = 50;

/**
 * Build the `EC` value: "price|Name|Description,price|Name|Description".
 * Capped at 50 chars, so entries are trimmed (description first, then name)
 * rather than silently truncated mid-field by the provider.
 */
function buildExtraCost(entries) {
  const list = (entries || []).filter((e) => e && Number(e.amount) > 0);
  if (!list.length) return '';
  const render = (e, descLen, nameLen) => [
    Number(e.amount).toFixed(2).replace(/\.00$/, ''),
    String(e.name || 'Fee').slice(0, nameLen),
    String(e.description || '').slice(0, descLen),
  ].join('|');

  // try full, then progressively shorter descriptions, then shorter names
  for (const [d, n] of [[40, 30], [20, 30], [0, 30], [0, 20], [0, 12]]) {
    const v = list.map((e) => render(e, d, n)).join(',');
    if (v.length <= EC_MAX_LEN) return v;
  }
  const v = list.map((e) => render(e, 0, 12)).join(',');
  if (v.length > EC_MAX_LEN) {
    throw Object.assign(new Error('extra_cost_too_long'), {
      status: 400,
      detail: `EC value exceeds ${EC_MAX_LEN} characters even after trimming: "${v}"`,
    });
  }
  return v;
}

/**
 * Build the hosted-page checkout request.
 *
 * @param {object} o
 *   merchantId, amount, currency, reference (our order id), description,
 *   notificationUrl, redirectUrl, expiresAt (Date|ms), extraCostAmount,
 *   customer {fullName,email,phone}, brand, hashKey
 * @returns {{ url:string, formFields:object[], signature:string, signedString:string }}
 */
function buildCheckout(o) {
  if (!o.hashKey) throw Object.assign(new Error('mantapay_hash_key_missing'), { status: 500 });
  if (!o.merchantId) throw Object.assign(new Error('mantapay_merchant_id_missing'), { status: 500 });
  const amount = Number(o.amount);
  if (!(amount > 0)) throw Object.assign(new Error('invalid_amount'), { status: 400 });

  // ExpiredOn is EPOCH SECONDS in GMT (their note). This replaces the manual
  // 10-minute expiry we had to run ourselves with the previous provider.
  //
  // Reusable links never expire, and the hosted page rejects an EMPTY ExpiredOn
  // with "Input string was not in a correct format." — it parses the field
  // whenever it is present. So the field is omitted entirely when there is no
  // deadline, rather than sent blank.
  let expiredOn = '';
  if (o.expiresAt) {
    const ms = o.expiresAt instanceof Date ? o.expiresAt.getTime() : Number(o.expiresAt);
    if (Number.isFinite(ms)) expiredOn = String(Math.floor(ms / 1000));
  }

  const c = o.customer || {};

  // ONE ordered list -> query string AND signature.
  const fields = [
    ['merchantID', clip(o.merchantId)],
    ['trans_type', '0'],                              // 0 = debit (SALE = auth+capture)
    ['trans_installments', '1'],                      // 1 = regular, non-instalment
    ['trans_amount', amount.toFixed(2)],
    ['trans_currency', clip(o.currency || 'EUR')],    // hosted page takes the ISO code
    ['trans_refNum', clip(o.reference, MAX_LEN.trans_refNum)],
    ['disp_payFor', clip(o.description, MAX_LEN.disp_payFor)],
    ['disp_lng', clip(o.language || 'en-US')],
    ['client_fullName', clip(c.fullName, MAX_LEN.client_fullName)],
    ['client_email', clip(c.email, MAX_LEN.client_email)],
    ['client_phoneNum', clip(c.phone, MAX_LEN.client_phoneNum)],
    ['notification_url', clip(o.notificationUrl, MAX_LEN.notification_url)],
    ['url_redirect', clip(o.redirectUrl, MAX_LEN.url_redirect)],
    ['Brand', clip(o.brand)],                         // source/attribution tag
  ];
  if (expiredOn) fields.push(['ExpiredOn', expiredOn]);

  // Surcharge shown to the payer as a separate line, when configured.
  //
  // NOTE: the parameter is `EC`, not `ExtraCostAmount` as the supplier stated.
  // Format is a comma-separated list of `price|Name|Description` entries, and
  // the whole value is capped at 50 characters — so names/descriptions must be
  // short. Their own worked example (100 amount + 100 voucher + 10 processing =
  // 210 total) confirms extras are ADDED ON TOP of trans_amount.
  const ec = buildExtraCost(o.extraCosts || (o.extraCostAmount
    ? [{ amount: o.extraCostAmount, name: o.extraCostName || 'Platform Fee', description: o.extraCostDescription || '' }]
    : []));
  if (ec) fields.push(['EC', ec]);

  const order = fields.map(([k]) => k);
  const params = Object.fromEntries(fields);
  const signed = sig.signHosted(params, o.hashKey, { order });

  // Same encoder as the signature, so the transmitted bytes match the hashed bytes.
  const query = fields
    .map(([k, v]) => `${k}=${v === '' ? '' : sig.urlEncodeDotNet(v)}`)
    .join('&') + `&signature=${signed.encoded}`;

  return {
    url: `${config.mantapayHostedBase}${HOSTED_PATH}?${query}`,
    // For POST: send these as a form and use the un-encoded base64 (their note
    // under Signature step 1). Keeps customer PII out of URLs and server logs.
    formFields: fields.map(([k, v]) => ({ name: k, value: v }))
      .concat([{ name: 'signature', value: signed.base64 }]),
    postUrl: `${config.mantapayHostedBase}${HOSTED_PATH}`,
    signature: signed.base64,
    signedString: signed.signedString,
  };
}

module.exports = { buildCheckout, buildExtraCost, HOSTED_PATH, MAX_LEN, EC_MAX_LEN };
