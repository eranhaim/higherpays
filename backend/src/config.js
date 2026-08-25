'use strict';
require('dotenv').config();

// Central config. Real secrets come from the environment (.env locally,
// the host's secret manager in production) — never hard-coded here.
function required(name, fallback) {
  const v = process.env[name] ?? fallback;
  if (v === undefined) {
    // In production we refuse to boot without critical secrets.
    if (process.env.NODE_ENV === 'production') {
      throw new Error(`Missing required env var: ${name}`);
    }
    return undefined;
  }
  return v;
}

const config = {
  env: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.PORT || '3000', 10),

  databaseUrl: required('DATABASE_URL', 'postgres://postgres@localhost:5432/higherpays'),

  // JWT signing. MUST be set to a long random value in production.
  jwtSecret: required('JWT_SECRET', 'dev-only-insecure-secret-change-me'),
  accessTokenTtl: process.env.ACCESS_TOKEN_TTL || '15m',
  refreshTokenDays: parseInt(process.env.REFRESH_TOKEN_DAYS || '30', 10),

  // Turn on to have the app set app.workspace_id / app.user_id per request
  // (required if you enabled Row-Level Security in migration 002/003).
  useRls: process.env.USE_RLS === 'true',

  // Currencies. EUR-only for now. FX (closing-date cross-rates, per-currency
  // reserves, EUR-denominated fixed fees converted into the transaction
  // currency) is deliberately out of scope. Add a currency here to re-enable.
  supportedCurrencies: (process.env.SUPPORTED_CURRENCIES || 'EUR').split(',').map((c) => c.trim().toUpperCase()),

  // ── MantaPay (payment provider) ─────────────────────────────────────────
  // Hosted-page base URL. The per-merchant hash key is resolved per workspace
  // via workspaces.provider_config_ref (which names an env var), never stored
  // in the database.
  mantapayHostedBase: process.env.MANTAPAY_HOSTED_BASE || 'https://uiservices.mantapay.biz',
  // Status check / server-to-server; different host from the hosted page.
  mantapaySearchBase: process.env.MANTAPAY_SEARCH_BASE || 'https://webservices.mantapay.biz',
  mantapayProcessBase: process.env.MANTAPAY_PROCESS_BASE || 'https://process.mantapay.biz',
  // Webservices login credentials (Search API + payouts). Use their API-user
  // role so a human rotating their portal password doesn't break the link.
  mantapayApiEmail: process.env.MANTAPAY_API_EMAIL || null,
  mantapayApiPassword: process.env.MANTAPAY_API_PASSWORD || null,
  mantapayAppToken: process.env.MANTAPAY_APP_TOKEN || null,
  mantapaySearchSalt: process.env.MANTAPAY_SEARCH_SALT || null,
  // Refund flow is a two-step request approved by their admins and isn't
  // implemented yet; until then the console records refunds issued in their
  // dashboard. Flip on once the refund API is built.
  mantapayRefundEnabled: String(process.env.MANTAPAY_REFUND_ENABLED || '') === 'true',
  // Fallback merchant id / hash key when a workspace hasn't been configured
  // individually. Production workspaces should override via provider_config_ref.
  mantapayMerchantId: process.env.MANTAPAY_MERCHANT_ID || null,
  mantapayHashKey: process.env.MANTAPAY_HASH_KEY || null,

  // Telegram fan-out. One HigherPays-owned bot delivers to every workspace's
  // chat; workspaces store only a chat id, never a secret.
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || null,
  telegramApiBase: process.env.TELEGRAM_API_BASE || 'https://api.telegram.org',

  // Public base URL of THIS backend, used to build each workspace's notifyUrl
  // (e.g. https://api.higherpays.com). If unset, MantaPay falls back to the
  // URL configured on the merchant profile.
  webhookPublicBase: process.env.WEBHOOK_PUBLIC_BASE || null,
  // Payment-link expiry (minutes). MantaPay honours ExpiredOn on the hosted
  // page and we mirror the same TTL locally for the reconciler.
  linkTtlMinutes: parseInt(process.env.LINK_TTL_MINUTES || '10', 10),
};

// Check the property, not a specific string: a guard that matches one exact
// dev value is routed around by any other weak default.
const MIN_JWT_SECRET_LENGTH = 32;
if (config.env === 'production' && String(config.jwtSecret || '').length < MIN_JWT_SECRET_LENGTH) {
  throw new Error(`JWT_SECRET must be at least ${MIN_JWT_SECRET_LENGTH} characters in production`);
}

// Row-Level Security IS the tenant boundary. Booting production without it would
// silently expose every agency's data to every other agency.
if (config.env === 'production' && !config.useRls) {
  throw new Error('USE_RLS must be true in production (tenant isolation depends on it)');
}

// Optional integrations, with the env var that turns each one on. Logged at
// boot so a missing value is a visible line in the logs, not a silent gap.
config.integrations = [
  { name: 'MantaPay checkout', enabled: Boolean(config.mantapayMerchantId && config.mantapayHashKey), needs: 'MANTAPAY_MERCHANT_ID, MANTAPAY_HASH_KEY' },
  { name: 'MantaPay webhook URL', enabled: Boolean(config.webhookPublicBase), needs: 'WEBHOOK_PUBLIC_BASE' },
  { name: 'MantaPay fee reconciliation', enabled: Boolean(config.mantapayApiEmail && config.mantapayApiPassword && config.mantapayAppToken), needs: 'MANTAPAY_API_EMAIL, MANTAPAY_API_PASSWORD, MANTAPAY_APP_TOKEN' },
  { name: 'MantaPay refunds', enabled: config.mantapayRefundEnabled, needs: 'MANTAPAY_REFUND_ENABLED=true' },
  { name: 'Telegram notifications', enabled: Boolean(config.telegramBotToken), needs: 'TELEGRAM_BOT_TOKEN' },
];

module.exports = config;
