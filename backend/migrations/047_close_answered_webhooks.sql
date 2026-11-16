BEGIN;

-- Webhooks whose processing failed (a statement timeout on 10 OnlyElite
-- approvals) but whose outcome the reconciler recorded later. The reconciler
-- did not close the inbox row, so /health stayed red with no money missing.
-- recordPaymentOutcome closes such rows from now on; this closes the old ones.
-- processing_error is kept as the record of the failed delivery.
UPDATE webhook_events e
   SET processed = true, processed_at = now()
  FROM transactions t
  JOIN payments p ON p.id = t.payment_id
  JOIN payment_links pl ON pl.id = p.payment_link_id
 WHERE e.processed = false
   AND e.signature_valid = true
   AND e.provider = 'mantapay'
   AND t.type = 'payment'
   AND t.workspace_id = e.workspace_id
   AND t.provider_transaction_id = e.provider_event_id
   AND t.status = e.event_type
   AND pl.reference_id = e.order_reference;

COMMIT;
