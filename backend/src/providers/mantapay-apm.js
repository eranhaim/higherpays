'use strict';

// MantaPay's S2S APM request starts the payment page and returns a
// D3Redirect. The browser is then sent to the provider's CentroBill page.
const config = require('../config');
const sig = require('./mantapay-signature');

const APM_PATH = '/member/remote_charge.asp';
const CURRENCY_IDS = { USD: '1', EUR: '2', GBP: '3' };
const FEE_MODES = {
  ADDITIVE: 'additive',
  INCLUDED: 'included',
};

function currencyId(currency) {
  const id = CURRENCY_IDS[String(currency || '').toUpperCase()];
  if (!id) throw Object.assign(new Error('mantapay_currency_not_supported'), { status: 400 });
  return id;
}

function clientIp(ip) {
  const value = String(ip || '').replace(/^::ffff:/, '');
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(value) ? value : '127.0.0.1';
}

function toMinorUnits(value, errorCode) {
  const number = Number(value);
  const minor = Math.round(number * 100);
  if (!Number.isFinite(number) || Math.abs(number * 100 - minor) >= 0.000001) {
    throw Object.assign(new Error(errorCode), { status: 400 });
  }
  return minor;
}

function calculateApmMoney(contentAmount, checkoutFee, feeMode) {
  const contentMinor = toMinorUnits(contentAmount, 'invalid_amount');
  const feeMinor = toMinorUnits(checkoutFee || 0, 'invalid_checkout_fee');
  if (contentMinor <= 0) throw Object.assign(new Error('invalid_amount'), { status: 400 });
  if (feeMinor < 0) throw Object.assign(new Error('invalid_checkout_fee'), { status: 400 });
  if (!Object.values(FEE_MODES).includes(feeMode)) {
    throw Object.assign(new Error('invalid_mantapay_fee_mode'), { status: 500 });
  }

  // MantaPay has only proven ExtraCostAmount as a ratio. Included mode changes
  // its denominator with Amount so the fee is represented inside the total.
  const amountMinor = feeMode === FEE_MODES.INCLUDED
    ? contentMinor + feeMinor
    : contentMinor;
  const extraCostRate = feeMinor / amountMinor;
  if (extraCostRate >= 1) {
    throw Object.assign(new Error('mantapay_extra_cost_must_be_less_than_amount'), { status: 400 });
  }

  return {
    amount: (amountMinor / 100).toFixed(2),
    extraCostRate: feeMinor > 0 ? String(Number(extraCostRate.toFixed(8))) : null,
  };
}

function buildApmUrl({
  merchantId, hashKey, contentAmount, checkoutFee, currency, order, notificationUrl, returnUrl,
  clientIp: ip, cpm, feeMode = config.mantapayFeeMode,
}) {
  if (!merchantId) throw Object.assign(new Error('mantapay_merchant_id_missing'), { status: 500 });
  if (!hashKey) throw Object.assign(new Error('mantapay_hash_key_missing'), { status: 500 });

  const companyNum = String(merchantId);
  const transType = '0';
  const typeCredit = '1';
  const money = calculateApmMoney(contentAmount, checkoutFee, feeMode);
  const currencyValue = currencyId(currency);
  const signature = sig.digest(
    companyNum + transType + typeCredit + money.amount + currencyValue + hashKey,
  );
  const fields = [
    ['CompanyNum', companyNum],
    ['TransType', transType],
    ['Member', 'Customer'],
    ['TypeCredit', typeCredit],
    ['Payments', '1'],
    ['Amount', money.amount],
    ['Currency', currencyValue],
    // MantaPay requires an email to start APM. It is never used to create a
    // HigherPays customer; the payer can replace it on the hosted page.
    ['Email', 'customer@higherpays.com'],
    ['ClientIP', clientIp(ip)],
    ['Order', String(order)],
    ['CPM', String(cpm || config.mantapayCpm)],
    ...(money.extraCostRate
      ? [['ExtraCostAmount', money.extraCostRate]]
      : []),
    ...(returnUrl ? [['RetURL', returnUrl]] : []),
    ...(notificationUrl ? [['notification_url', notificationUrl]] : []),
    ['signature', signature],
  ];
  const query = fields.map(([key, fieldValue]) => `${key}=${encodeURIComponent(fieldValue)}`).join('&');
  return `${config.mantapayProcessBase}${APM_PATH}?${query}`;
}

function parseResponse(text) {
  const params = new URLSearchParams(String(text || '').replace(/\+/g, '%20'));
  return Object.fromEntries(params.entries());
}

async function startApm(o = {}) {
  const url = buildApmUrl(o);
  const response = await fetch(url, { redirect: 'manual' });
  const location = response.headers.get('location');
  if (location && response.status >= 300 && response.status < 400) {
    return { reply: '553', redirect: location, fields: {} };
  }
  const text = await response.text();
  const fields = parseResponse(text);
  const reply = String(fields.Reply || fields.replyCode || '');
  const redirect = fields.D3Redirect || null;
  if (!response.ok) {
    throw Object.assign(new Error('mantapay_apm_failed'), { status: 502, detail: text.slice(0, 300) });
  }
  if (!redirect) {
    throw Object.assign(new Error('mantapay_apm_no_redirect'), {
      status: 502,
      detail: `MantaPay returned reply ${reply || 'unknown'} without D3Redirect`,
    });
  }
  return { reply, redirect, fields };
}

module.exports = {
  APM_PATH, CURRENCY_IDS, FEE_MODES, currencyId, calculateApmMoney, buildApmUrl, parseResponse, startApm,
};
