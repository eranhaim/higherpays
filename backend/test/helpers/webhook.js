'use strict';
// Drives a sale through the real webhook path so tests that need ledger
// entries get them the same way production does.
const request = require('supertest');
const { pool } = require('../../src/db');
const sig = require('../../src/providers/mantapay-signature');
const { MERCHANT_ID } = require('./tenant');

async function endpointFor(workspaceId) {
  const { rows } = await pool.query('SELECT webhook_endpoint_id FROM workspaces WHERE id = $1', [workspaceId]);
  return rows[0].webhook_endpoint_id;
}

function encodeForm(params) {
  return Object.entries(params).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
}

function buildPaidPayload({ reference, transId, amount, currency = 'EUR', merchantId = MERCHANT_ID, replyCode = '000' }) {
  const fields = {
    trans_id: transId,
    trans_order: reference,
    reply_code: replyCode,
    reply_desc: replyCode === '000' ? 'Approved' : 'Declined',
    trans_amount: String(amount),
    trans_currency: currency,
    merchant_id: merchantId,
    trans_date: '01/01/2026 12:00:00',
    client_email: 'buyer@test.local',
  };
  // Notifications sign a subset:
  //   trans_id + trans_order + reply_code + trans_amount + trans_currency + hashKey
  const base = fields.trans_id + fields.trans_order + fields.reply_code + fields.trans_amount + fields.trans_currency;
  fields.signature = sig.digest(base + process.env.MANTAPAY_HASH_KEY);
  return fields;
}

function postWebhook(app, endpointId, payload) {
  return request(app)
    .post(`/webhooks/payment/${endpointId}`)
    .set('Content-Type', 'application/x-www-form-urlencoded')
    .send(encodeForm(payload));
}

const newTransId = () => `mp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;

/** Creates a link for `account` as `headers` (default: the admin) and pays it. */
async function paySale(app, tenant, account, amount, opts = {}) {
  const link = (await request(app)
    .post(`/workspaces/${tenant.workspaceId}/links`)
    .set(opts.headers || tenant.authHeaders)
    .send({ accountId: account.id, type: opts.type || 'single_use', amount, currency: 'EUR' })
    .expect(201)).body;
  const transId = newTransId();
  const res = await postWebhook(app, await endpointFor(tenant.workspaceId),
    buildPaidPayload({ reference: link.referenceId, transId, amount })).expect(200);
  return { link, transId, paymentId: res.body.paymentId };
}

module.exports = { MERCHANT_ID, endpointFor, encodeForm, buildPaidPayload, postWebhook, paySale, newTransId };
