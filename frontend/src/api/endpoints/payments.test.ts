import { describe, expect, it } from 'vitest';
import {
  PAYMENT_STATUSES, PAYMENT_STATUS_LABELS, PROVIDER_FEE_SOURCE_LABELS,
} from './payments';

describe('payment outcome labels', () => {
  it('shows pending attempts and distinguishes estimated provider fees', () => {
    expect(PAYMENT_STATUSES).toContain('pending');
    expect(PAYMENT_STATUS_LABELS.pending).toBe('Pending');
    expect(PROVIDER_FEE_SOURCE_LABELS.estimated).toBe('Estimated');
    expect(PROVIDER_FEE_SOURCE_LABELS.actual).toBe('Actual');
  });
});
