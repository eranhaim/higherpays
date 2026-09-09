'use strict';

// Public payment links do not require a HigherPays login. The endpoint starts
// MantaPay's APM page only when the payer opens the link.
const express = require('express');
const { query, withTransaction } = require('../db');
const config = require('../config');
const provider = require('../providers/mantapay');
const { asyncHandler } = require('../lib/http');
const { recordLinkEvent } = require('../services/linkEvents');

const router = express.Router();

router.get('/:reference', asyncHandler(async (req, res) => {
  const link = await withTransaction(async (c) => {
    const found = (await c.query(
    `SELECT pl.id, pl.workspace_id, pl.amount, pl.checkout_fee, pl.currency, pl.status, pl.expires_at,
            w.merchant_id, w.provider_config_ref, w.webhook_endpoint_id
       FROM payment_links pl
       JOIN workspaces w ON w.id = pl.workspace_id
      WHERE pl.reference_id = $1 AND w.status = 'active'`,
    [req.params.reference])).rows[0];
    if (!found) return null;
    await recordLinkEvent(c, {
      workspaceId: found.workspace_id, linkId: found.id, eventType: 'opened',
      source: 'public_checkout',
    });
    if (found.status === 'active' && found.expires_at && new Date(found.expires_at) < new Date()) {
      await c.query("UPDATE payment_links SET status = 'expired' WHERE id = $1 AND status = 'active'", [found.id]);
      found.status = 'expired';
      await recordLinkEvent(c, {
        workspaceId: found.workspace_id, linkId: found.id, eventType: 'expired',
        source: 'public_checkout', idempotencyKey: 'expired',
      });
    }
    if (found.status === 'active') {
      await recordLinkEvent(c, {
        workspaceId: found.workspace_id, linkId: found.id, eventType: 'checkout_initiated',
        source: 'public_checkout',
      });
    }
    return found;
  });

  if (!link) return res.status(404).json({ error: 'payment_link_not_found' });
  if (link.status !== 'active') {
    return res.status(410).json({ error: 'payment_link_expired' });
  }

  const notificationUrl = config.webhookPublicBase
    ? `${config.webhookPublicBase.replace(/\/$/, '')}/webhooks/payment/${link.webhook_endpoint_id}`
    : undefined;
  const result = await provider.apm.startApm({
    merchantId: provider.resolveMerchantId(link),
    hashKey: provider.resolveApiKey(link),
    contentAmount: link.amount,
    checkoutFee: link.checkout_fee,
    currency: link.currency,
    order: req.params.reference,
    notificationUrl,
    returnUrl: `${config.appPublicBase}/payment-complete`,
    clientIp: req.ip,
  });
  await recordLinkEvent({ query }, {
    workspaceId: link.workspace_id, linkId: link.id, eventType: 'checkout_redirected',
    source: 'public_checkout',
  });
  res.redirect(302, result.redirect);
}));

module.exports = router;
