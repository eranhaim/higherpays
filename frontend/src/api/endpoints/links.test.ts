import { describe, expect, it } from 'vitest';
import {
  LINK_STATUS_LABELS, PROVIDER_ATTEMPT_STATUSES, PROVIDER_ATTEMPT_STATUS_LABELS,
} from './links';

describe('payment-link status labels', () => {
  it('keeps lifecycle and provider-attempt statuses separate', () => {
    expect(LINK_STATUS_LABELS.pending).toBe('Paid — details needed');
    expect(PROVIDER_ATTEMPT_STATUSES).toEqual(['pending', 'approved', 'declined']);
    expect(PROVIDER_ATTEMPT_STATUS_LABELS.pending).toBe('Pending');
  });
});
