'use strict';

// Public payment links do not require a HigherPays login. The endpoint starts
// MantaPay's APM page only when the payer opens the link.
const express = require('express');
const { query } = require('../db');
const config = require('../config');
const provider = require('../providers/mantapay');
const { asyncHandler } = require('../lib/http');

const router = express.Router();

router.get('/:reference', asyncHandler(async (req, res) => {
  const link = (await query(
    `SELECT pl.amount, pl.checkout_fee, pl.currency, pl.status, pl.expires_at,
            w.merchant_id, w.provider_config_ref, w.webhook_endpoint_id
       FROM payment_links pl
       JOIN workspaces w ON w.id = pl.workspace_id
      WHERE pl.reference_id = $1 AND w.status = 'active'`,
    [req.params.reference])).rows[0];

  if (!link) return res.status(404).json({ error: 'payment_link_not_found' });
  if (link.status !== 'active' || (link.expires_at && new Date(link.expires_at) < new Date())) {
    return res.status(410).json({ error: 'payment_link_expired' });
  }

  const notificationUrl = config.webhookPublicBase
    ? `${config.webhookPublicBase.replace(/\/$/, '')}/webhooks/payment/${link.webhook_endpoint_id}`
    : undefined;
  const result = await provider.apm.startApm({
    merchantId: provider.resolveMerchantId(link),
    hashKey: provider.resolveApiKey(link),
    amount: Number(link.amount) + Number(link.checkout_fee || 0),
    currency: link.currency,
    order: req.params.reference,
    notificationUrl,
    clientIp: req.ip,
  });
  res.redirect(302, result.redirect);
}));

module.exports = router;
