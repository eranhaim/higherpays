import { describe, expect, it } from 'vitest';
import { customersFromResponse, type Customer } from './customers';

const completedCustomer: Customer = {
  id: 'customer-1',
  name: 'Existing Customer',
  telegramName: '@existing',
  email: null,
  phone: null,
  country: null,
  segment: 'regular',
  totalSpend: 75,
  lastPurchaseAt: '2026-09-09T10:00:00.000Z',
  createdAt: '2026-09-01T10:00:00.000Z',
};

describe('customer list response', () => {
  it('keeps existing customers with completed payments', () => {
    expect(customersFromResponse({ customers: [completedCustomer] })).toEqual([completedCustomer]);
  });

  it('rejects a malformed response instead of showing an empty list', () => {
    expect(() => customersFromResponse({})).toThrow('Invalid customers response.');
  });
});
