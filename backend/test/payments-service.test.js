'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateProviderMoney } = require('../src/services/payments.service');

test('provider money accepts signed content or customer total during the fee-mode transition', () => {
  for (const { contentAmount, checkoutFee, customerTotal } of [
    { contentAmount: '100.00', checkoutFee: '2.00', customerTotal: '102.00' },
    { contentAmount: '3.00', checkoutFee: '2.00', customerTotal: '5.00' },
  ]) {
    const expected = { contentAmount, checkoutFee, expectedCurrency: 'EUR' };
    assert.doesNotThrow(() => validateProviderMoney({
      ...expected, providerAmount: contentAmount, providerCurrency: 'EUR',
    }));
    assert.doesNotThrow(() => validateProviderMoney({
      ...expected, providerAmount: customerTotal, providerCurrency: 'eur',
    }));
  }
});

test('provider money rejects amount and currency mismatches', () => {
  const expected = {
    contentAmount: '25.00',
    checkoutFee: '2.00',
    expectedCurrency: 'EUR',
  };
  assert.throws(
    () => validateProviderMoney({ ...expected, providerAmount: '26.00', providerCurrency: 'EUR' }),
    (error) => error.code === 'provider_amount_mismatch' && error.status === 422,
  );
  assert.throws(
    () => validateProviderMoney({ ...expected, providerAmount: '25.00', providerCurrency: 'USD' }),
    (error) => error.code === 'provider_currency_mismatch' && error.status === 422,
  );
});
