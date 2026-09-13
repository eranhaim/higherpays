import { describe, expect, it } from 'vitest';
import {
  LINK_STATUS_LABELS, PROVIDER_ATTEMPT_STATUSES, PROVIDER_ATTEMPT_STATUS_LABELS,
} from './links';

describe('payment-link status labels', () => {
  it('uses the customer-facing payment lifecycle labels', () => {
    expect(LINK_STATUS_LABELS.active).toBe('Waiting for payment');
    expect(LINK_STATUS_LABELS.pending).toBe('Waiting to fill details');
    expect(LINK_STATUS_LABELS.done).toBe('Completed');
  });

  it('keeps provider-attempt statuses available only for internal detail', () => {
    expect(PROVIDER_ATTEMPT_STATUSES).toEqual(['pending', 'approved', 'declined']);
    expect(PROVIDER_ATTEMPT_STATUS_LABELS.pending).toBe('Pending');
  });
});
