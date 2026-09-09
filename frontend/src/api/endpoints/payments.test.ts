import { describe, expect, it } from 'vitest';
import {
  PAYMENT_STATUSES, PAYMENT_STATUS_LABELS, getPaymentExportColumns, PROVIDER_FEE_SOURCE_LABELS,
} from './payments';

describe('payment outcome labels', () => {
  it('shows pending attempts and distinguishes estimated provider fees', () => {
    expect(PAYMENT_STATUSES).toContain('pending');
    expect(PAYMENT_STATUS_LABELS.pending).toBe('Pending');
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
