'use strict';
// Drives a sale through the real webhook path so tests that need ledger
// entries (payouts, cash position, refunds) get them the same way production does.
const request = require('supertest');
const { withSystem } = require('../../src/db');
const sig = require('../../src/providers/mantapay-signature');
const { createCreator } = require('./tenant');

const MERCHANT_ID = '7374656';

// `workspaces` is FORCE-RLS, so a bare pool query returns zero rows. Use the
// same trusted system context the webhook itself uses.
async function endpointFor(workspaceId) {
  return withSystem(async (c) => {
    const { rows } = await c.query(
      'SELECT webhook_endpoint_id FROM workspaces WHERE id = $1', [workspaceId]);
    return rows[0].webhook_endpoint_id;
  });
}

async function setMerchantId(workspaceId, mid = MERCHANT_ID) {
  await withSystem((c) => c.query('UPDATE workspaces SET mid = $2 WHERE id = $1', [workspaceId, mid]));
}

function encodeForm(params) {
  return Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
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
  const hashKey = process.env.MANTAPAY_HASH_KEY;
  const base = fields.trans_id + fields.trans_order + fields.reply_code +
               fields.trans_amount + fields.trans_currency;
  fields.signature = sig.digest(base + hashKey);
  return fields;
}

function postWebhook(app, endpointId, payload) {
  return request(app)
    .post(`/webhooks/payment/${endpointId}`)
    .set('Content-Type', 'application/x-www-form-urlencoded')
    .send(encodeForm(payload));
}

/** Creates a link for `creator` and pays it. Returns the link and the provider transaction id. */
async function paySale(app, tenant, creator, amount) {
  await setMerchantId(tenant.workspaceId);
  const link = (await request(app)
    .post(`/workspaces/${tenant.workspaceId}/links`)
    .set(tenant.authHeaders)
    .send({ creatorId: creator.id, pricingMode: 'fixed', amount, currency: 'EUR' })
    .expect(201)).body;
  const transId = `mp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
  await postWebhook(app, await endpointFor(tenant.workspaceId),
    buildPaidPayload({ reference: link.reference_id, transId, amount })).expect(200);
  return { link, transId };
}

module.exports = {
  MERCHANT_ID, endpointFor, setMerchantId, encodeForm, buildPaidPayload, postWebhook, paySale, createCreator,
};
