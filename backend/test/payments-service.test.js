'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateProviderMoney } = require('../src/services/payments.service');

const expected = {
  contentAmount: '25.00',
  checkoutFee: '2.00',
  expectedCurrency: 'EUR',
};

test('provider money accepts the signed content amount or customer total', () => {
  assert.doesNotThrow(() => validateProviderMoney({
    ...expected, providerAmount: '25.00', providerCurrency: 'EUR',
  }));
  assert.doesNotThrow(() => validateProviderMoney({
    ...expected, providerAmount: '27.00', providerCurrency: 'eur',
  }));
});

test('provider money rejects amount and currency mismatches', () => {
  assert.throws(
    () => validateProviderMoney({ ...expected, providerAmount: '26.00', providerCurrency: 'EUR' }),
    (error) => error.code === 'provider_amount_mismatch' && error.status === 422,
  );
  assert.throws(
    () => validateProviderMoney({ ...expected, providerAmount: '25.00', providerCurrency: 'USD' }),
    (error) => error.code === 'provider_currency_mismatch' && error.status === 422,
  );
});
