import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PAYMENT_STATUSES, PAYMENT_STATUS_LABELS, paymentStatusLabel, getPaymentExportColumns, PROVIDER_FEE_SOURCE_LABELS, declineReasonLabel,
  paymentsApi,
} from './payments';
import { useSessionStore } from '../../store/session';

describe('payment outcome labels', () => {
  it('uses the customer-facing payment lifecycle labels', () => {
    expect(PAYMENT_STATUSES).toContain('pending');
    expect(PAYMENT_STATUS_LABELS.pending).toBe('Waiting for payment');
    expect(PAYMENT_STATUS_LABELS.paid).toBe('Completed');
    expect(paymentStatusLabel({ status: 'paid', needsDetails: true })).toBe('Waiting to fill details');
    expect(declineReasonLabel('Insufficient funds')).toBe('Insufficient funds');
    expect(declineReasonLabel(null)).toBe('Unknown');
    expect(declineReasonLabel(undefined)).toBe('Unknown');
    expect(PROVIDER_FEE_SOURCE_LABELS.estimated).toBe('Estimated');
    expect(PROVIDER_FEE_SOURCE_LABELS.actual).toBe('Actual');
    const columns = getPaymentExportColumns({
      account: 'Model', accounts: 'Models', agent: 'Closer', agents: 'Closers',
    });
    expect(columns.find((column) => column.key === 'reference')?.label).toBe('HigherPays Order');
    expect(columns.find((column) => column.key === 'providerTransaction')?.label).toBe('Provider Transaction ID');
    expect(columns.find((column) => column.key === 'creator')?.label).toBe('Model');
    expect(columns.find((column) => column.key === 'agent')?.label).toBe('Closer');
  });
});

describe('payment list query', () => {
  const originalFetch = globalThis.fetch;
  let requested: string;

  beforeEach(() => {
    useSessionStore.setState({ activeWorkspaceId: 'ws-1' });
    globalThis.fetch = vi.fn(async (url: string) => {
      requested = url;
      return new Response('{"items":[],"nextCursor":null}', { status: 200 });
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    useSessionStore.setState({ activeWorkspaceId: null });
  });

  // The page has already turned the picker's day into an instant. Widening it
  // a second time here produced `...ZT23:59:59.999`, which Postgres reads as a
  // timezone name — the whole Payments page answered 500 on a picked range.
  it('sends the range it was given, instant for instant', async () => {
    await paymentsApi.list(null, { from: '2026-09-30T21:00:00.000Z', to: '2026-10-13T20:59:59.999Z' });
    const params = new URL(requested, 'https://higherpays.test').searchParams;
    expect(params.get('from')).toBe('2026-09-30T21:00:00.000Z');
    expect(params.get('to')).toBe('2026-10-13T20:59:59.999Z');
  });

  it('leaves an open bound out of the query', async () => {
    await paymentsApi.list(null, { from: '2026-09-30T21:00:00.000Z', to: '' });
    const params = new URL(requested, 'https://higherpays.test').searchParams;
    expect(params.get('to')).toBe(null);
  });
});
