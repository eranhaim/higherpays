import { describe, expect, it } from 'vitest';
import {
  PAYMENT_STATUSES, PAYMENT_STATUS_LABELS, paymentStatusLabel, getPaymentExportColumns, PROVIDER_FEE_SOURCE_LABELS,
} from './payments';

describe('payment outcome labels', () => {
  it('uses the customer-facing payment lifecycle labels', () => {
    expect(PAYMENT_STATUSES).toContain('pending');
    expect(PAYMENT_STATUS_LABELS.pending).toBe('Waiting for payment');
    expect(PAYMENT_STATUS_LABELS.paid).toBe('Completed');
    expect(paymentStatusLabel({ status: 'paid', needsDetails: true })).toBe('Waiting to fill details');
    expect(PROVIDER_FEE_SOURCE_LABELS.estimated).toBe('Estimated');
    expect(PROVIDER_FEE_SOURCE_LABELS.actual).toBe('Actual');
    const columns = getPaymentExportColumns({
      account: 'Model', accounts: 'Models', agent: 'Closer', agents: 'Closers',
    });
    expect(columns.find((column) => column.key === 'reference')?.label).toBe('HigherPays Order');
    expect(columns.find((column) => column.key === 'providerTransaction')?.label).toBe('MantaPay Transaction ID');
    expect(columns.find((column) => column.key === 'creator')?.label).toBe('Model');
    expect(columns.find((column) => column.key === 'agent')?.label).toBe('Closer');
  });
});
