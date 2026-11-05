-- One-time correction for the two orders in workspace 5f099129. Run as the
-- database owner after migration 046. It refuses changed or paid-out records.
\set ON_ERROR_STOP on
BEGIN;

DO $$
DECLARE
  old_p payments%ROWTYPE;
  old_t transactions%ROWTYPE;
  old_sale revenue_entries%ROWTYPE;
  target payment_links%ROWTYPE;
  decline webhook_events%ROWTYPE;
  approval webhook_events%ROWTYPE;
  new_payment uuid;
  new_transaction uuid;
BEGIN
  SELECT * INTO STRICT old_p FROM payments WHERE id='4a431cf0-5b31-4ec9-8f33-6ac452f80e73' FOR UPDATE;
  SELECT * INTO STRICT old_t FROM transactions WHERE id='23786df5-006b-4e02-b08a-c6f19daf3868' FOR UPDATE;
  SELECT * INTO STRICT old_sale FROM revenue_entries WHERE transaction_id=old_t.id FOR UPDATE;
  SELECT * INTO STRICT target FROM payment_links WHERE id='feb294cb-d00e-480c-9adf-6976fd5fdee2' FOR UPDATE;
  SELECT * INTO STRICT decline FROM webhook_events WHERE id='c7809598-2c09-43fd-a2e1-2b29577fb07b';
  SELECT * INTO STRICT approval FROM webhook_events WHERE id='e11c1e43-c55d-40f1-9e86-7668577e02aa';

  IF old_p.workspace_id <> target.workspace_id OR old_p.status <> 'paid'
     OR old_p.payment_link_id <> '307da5e8-6cfd-4316-a889-456f69bc6e9f'
     OR old_p.provider_payment_id <> '166848' OR old_p.amount <> 199
     OR old_t.payment_id <> old_p.id OR old_t.status <> 'approved' OR old_t.gross <> 199
     OR old_sale.entry_type <> 'sale' OR old_sale.status <> 'locked'
     OR old_sale.account_payout_id IS NOT NULL OR old_sale.agent_payout_id IS NOT NULL
     OR old_sale.account_paid_at IS NOT NULL OR old_sale.agent_paid_at IS NOT NULL
     OR target.reference_id <> 'HP-HPMK-BBBX-RF4W' OR target.status <> 'pending'
     OR target.amount <> 222 OR target.checkout_fee <> 2 OR target.currency <> 'EUR'
     OR target.paid_at IS NULL
     OR NOT decline.signature_valid OR decline.event_type <> 'declined'
     OR decline.payload->>'trans_order' <> 'HP-KAH7-NSBD-ZNEV'
     OR decline.payload->>'trans_id' <> '166848'
     OR NOT approval.signature_valid OR approval.event_type <> 'approved'
     OR approval.payload->>'trans_order' <> target.reference_id
     OR approval.payload->>'trans_id' <> '166848'
     OR approval.payload->>'reply_code' <> '000'
     OR approval.payload->>'trans_amount' <> '222'
     OR EXISTS (SELECT 1 FROM payments WHERE payment_link_id=target.id)
     OR EXISTS (SELECT 1 FROM rolling_reserve_entries WHERE transaction_id=old_t.id)
     OR EXISTS (SELECT 1 FROM workspaces WHERE id=target.workspace_id AND rolling_reserve_enabled)
     OR EXISTS (SELECT 1 FROM transactions WHERE payment_id=old_p.id AND id<>old_t.id)
     OR (SELECT count(*) FROM payment_link_events WHERE payment_link_id=target.id AND event_type='provider_approved' AND payment_id=old_p.id AND idempotency_key='166848') <> 1
  THEN RAISE EXCEPTION 'repair preconditions changed; review manually'; END IF;

  -- Keep the complete old accounting snapshot in the audit trail before it is
  -- removed, including all calculated fee and recipient amounts.
  INSERT INTO audit_log(workspace_id, action, entity_type, entity_id, metadata)
  VALUES (target.workspace_id, 'payment.provider_id_collision_repair', 'payment', old_p.id,
    jsonb_build_object('oldPayment', to_jsonb(old_p), 'oldTransaction', to_jsonb(old_t) - 'raw_payload',
      'oldSale', to_jsonb(old_sale), 'declineWebhookId', decline.id,
      'approvalWebhookId', approval.id, 'correctOrder', target.reference_id));

  DELETE FROM revenue_entries WHERE id=old_sale.id;
  UPDATE payments SET status='failed' WHERE id=old_p.id;
  UPDATE transactions SET status='declined', raw_payload=decline.payload WHERE id=old_t.id;

  INSERT INTO payments (workspace_id, account_id, payment_link_id, agent_id, amount, currency,
                        status, payment_method, provider_payment_id, occurred_at, created_at)
  VALUES (target.workspace_id, target.account_id, target.id, target.created_by_agent_id,
          target.amount, target.currency, 'paid', approval.payload->>'payment_details',
          '166848', approval.received_at, approval.received_at)
  RETURNING id INTO new_payment;

  INSERT INTO transactions (workspace_id, payment_id, type, status, gross, fee, fee_is_estimate,
                            surcharge, net, currency, provider_transaction_id, occurred_at, raw_payload, created_at)
  VALUES (target.workspace_id, new_payment, 'payment', 'approved', target.amount, 0, true,
          target.checkout_fee, target.amount, target.currency, '166848', approval.received_at,
          approval.payload, approval.received_at)
  RETURNING id INTO new_transaction;

  PERFORM fn_post_sale(new_transaction);
  PERFORM fn_hold_rolling_reserve(new_transaction);
  UPDATE revenue_entries SET created_at=approval.received_at WHERE transaction_id=new_transaction;
  UPDATE payment_link_events SET payment_id=new_payment
    WHERE payment_link_id=target.id AND event_type='provider_approved'
      AND payment_id=old_p.id AND idempotency_key='166848';
  INSERT INTO audit_log(workspace_id, action, entity_type, entity_id, metadata)
  VALUES (target.workspace_id, 'payment.provider_id_collision_recovered', 'payment', new_payment,
    jsonb_build_object('transactionId', new_transaction, 'providerTransactionId', '166848',
      'orderReference', target.reference_id, 'approvalWebhookId', approval.id));
END $$;

COMMIT;
