'use strict';
// Mantapay webservices authentication.
//
// The Search API (and payouts) sit behind a login that returns a short-lived
// credentials token. Two headers are involved and it is easy to get wrong:
//
//   applicationToken  — issued by support, sent on every call including login
//   <CredentialsHeaderName>: <CredentialsToken>
//
// CredentialsHeaderName is the NAME OF THE HEADER, not a literal header name.
// The login response tells you what to call the header; the token is the value.
//
// Use the API User role (50). Their own note: it "was designed to allow merchant
// continuous access to the service without affecting backoffice access" —
// otherwise a human changing their portal password silently breaks the
// integration. Credentials expire every 3 months either way.
const config = require('../config');

const LOGIN_PATH = '/v2/account.svc/login';

const USER_ROLE = { customer: '15', merchant: '20', merchantSub: '21', affiliate: '25', apiUser: '50' };

// Cached session, keyed by credential, so we do not log in on every request.
const sessions = new Map();
// Re-login a little before the token could plausibly expire.
const SESSION_TTL_MS = 20 * 60 * 1000;

/**
 * Log in and return the credentials needed for subsequent webservice calls.
 * @returns {{ headerName:string, token:string, accountStatus:string, signature:string|null }}
 */
async function login(o = {}) {
  const appToken = o.applicationToken || config.mantapayAppToken;
  const email = o.email || config.mantapayApiEmail;
  const userName = o.userName || config.mantapayApiUsername;
  const password = o.password || config.mantapayApiPassword;
  const userRole = o.userRole || USER_ROLE.apiUser;

  if (!appToken) throw Object.assign(new Error('mantapay_app_token_missing'), { status: 500, detail: 'Set MANTAPAY_APP_TOKEN (issued by support).' });
  if (!email || !userName || !password) {
    throw Object.assign(new Error('mantapay_api_credentials_missing'), {
      status: 500,
      detail: 'Set MANTAPAY_API_EMAIL, MANTAPAY_API_USERNAME and MANTAPAY_API_PASSWORD (API user role 50).',
    });
  }

  const body = JSON.stringify({
    email,
    // For the API-user role these carry the PublicKey / SecretKey instead.
    userName,
    password,
    options: {
      appName: o.appName || 'HigherPays',
      applicationToken: appToken,
      setCookie: false,
      userRole,
    },
  });

  const r = await fetch(`${config.mantapaySearchBase}${LOGIN_PATH}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', applicationToken: appToken },
    body,
  });
  const text = await r.text();
  let data = null; try { data = JSON.parse(text); } catch { /* non-JSON */ }
  const d = data && (data.d || data);
  if (!r.ok || !d || d.IsSuccess === false) {
    throw Object.assign(new Error('mantapay_login_failed'), {
      status: r.status === 200 ? 401 : r.status,
      detail: (d && (d.Message || d.Key)) || String(text).slice(0, 200),
    });
  }
  if (!d.CredentialsToken) {
    throw Object.assign(new Error('mantapay_login_no_token'), { status: 502, detail: String(text).slice(0, 200) });
  }
  return {
    headerName: d.CredentialsHeaderName || 'CredentialsToken',
    token: d.CredentialsToken,
    accountStatus: d.AccountStatus || null,
    customerNumber: d.CustomerNumber || null,
    // Their login response also carries a "Signature" field. It may be the salt
    // the Search API signs request bodies with — UNCONFIRMED, see open questions.
    signature: d.Signature || null,
  };
}

/** Login with caching, so a burst of searches does not re-authenticate each time. */
async function getSession(o = {}) {
  const key = (o.email || config.mantapayApiEmail || '') + '|'
    + (o.userName || config.mantapayApiUsername || '') + '|'
    + (o.userRole || USER_ROLE.apiUser);
  const hit = sessions.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.session;
  const session = await login(o);
  sessions.set(key, { session, expiresAt: Date.now() + SESSION_TTL_MS });
  return session;
}

/** Drop a cached session — call this after a 401 so the next attempt re-logs in. */
function invalidateSession(o = {}) {
  sessions.delete((o.email || config.mantapayApiEmail || '') + '|'
    + (o.userName || config.mantapayApiUsername || '') + '|'
    + (o.userRole || USER_ROLE.apiUser));
}

module.exports = { LOGIN_PATH, USER_ROLE, login, getSession, invalidateSession };
