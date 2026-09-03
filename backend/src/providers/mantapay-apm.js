'use strict';

// MantaPay's S2S APM request starts the payment page and returns a
// D3Redirect. The browser is then sent to the provider's CentroBill page.
const config = require('../config');
const sig = require('./mantapay-signature');

const APM_PATH = '/member/remote_charge.asp';
const CURRENCY_IDS = { USD: '1', EUR: '2', GBP: '3' };

function currencyId(currency) {
  const id = CURRENCY_IDS[String(currency || '').toUpperCase()];
  if (!id) throw Object.assign(new Error('mantapay_currency_not_supported'), { status: 400 });
  return id;
}

function clientIp(ip) {
  const value = String(ip || '').replace(/^::ffff:/, '');
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(value) ? value : '127.0.0.1';
}

function buildApmUrl({ merchantId, hashKey, amount, currency, order, notificationUrl, returnUrl, clientIp: ip, cpm }) {
  if (!merchantId) throw Object.assign(new Error('mantapay_merchant_id_missing'), { status: 500 });
  if (!hashKey) throw Object.assign(new Error('mantapay_hash_key_missing'), { status: 500 });
  if (!(Number(amount) > 0)) throw Object.assign(new Error('invalid_amount'), { status: 400 });

  const companyNum = String(merchantId);
  const transType = '0';
  const typeCredit = '1';
  const value = Number(amount).toFixed(2);
  const currencyValue = currencyId(currency);
  const signature = sig.digest(companyNum + transType + typeCredit + value + currencyValue + hashKey);
  const fields = [
    ['CompanyNum', companyNum],
    ['TransType', transType],
    ['Member', 'Customer'],
    ['TypeCredit', typeCredit],
    ['Payments', '1'],
    ['Amount', value],
    ['Currency', currencyValue],
    ['Email', 'customer@higherpays.com'],
    ['ClientIP', clientIp(ip)],
    ['Order', String(order)],
    ['CPM', String(cpm || config.mantapayCpm)],
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

module.exports = { APM_PATH, CURRENCY_IDS, currencyId, buildApmUrl, parseResponse, startApm };
