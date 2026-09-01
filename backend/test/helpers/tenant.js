'use strict';
// Builds an isolated agency through the real HTTP flows: a platform admin
// onboards it, its admin accepts the invite, and agents/accounts are created
// the way the console does it. Every test gets its own island of data.

const request = require('supertest');
const { pool } = require('../../src/db');
const { hashPassword } = require('../../src/auth/passwords');
const { lastEmailTo } = require('../../src/util/email');

let counter = 0;
function tag() {
  counter += 1;
  return `${Date.now().toString(36)}${counter}${Math.random().toString(36).slice(2, 5)}`;
}

const PASSWORD = 'passwordtest';
const MERCHANT_ID = '7374656';

async function login(app, email, password = PASSWORD) {
  const res = await request(app).post('/auth/login').send({ email, password }).expect(200);
  return { userId: res.body.user.id, accessToken: res.body.accessToken, refreshToken: res.body.refreshToken, workspaces: res.body.workspaces };
}

/** One platform admin per process, created straight in the database. */
let platformAdmin = null;
async function getPlatformAdmin(app) {
  if (platformAdmin) return platformAdmin;
  const email = `platform+${tag()}@test.local`;
  await pool.query(
    'INSERT INTO users (email, full_name, password_hash, is_platform_admin) VALUES ($1,$2,$3,true)',
    [email, 'Platform Admin', await hashPassword(PASSWORD)]);
  const session = await login(app, email);
  platformAdmin = { email, ...session, headers: { Authorization: `Bearer ${session.accessToken}` } };
  return platformAdmin;
}

/** Pull the invite token out of the stubbed email for an address. */
function inviteTokenFor(email) {
  const mail = lastEmailTo(email);
  if (!mail) throw new Error(`no invite email was sent to ${email}`);
  const match = /token=([A-Za-z0-9_-]+)/.exec(mail.body);
  if (!match) throw new Error(`no invite token in the email to ${email}`);
  return match[1];
}

/**
 * @returns {Promise<{ email, password, userId, workspaceId, accessToken, refreshToken, authHeaders }>}
 *   the agency's first workspace_admin.
 */
async function createTenant(app, opts = {}) {
  const t = tag();
  const admin = await getPlatformAdmin(app);
  const email = opts.email || `admin+${t}@test.local`;
  const onboarded = await request(app).post('/platform/agencies').set(admin.headers).send({
    name: opts.name || `Agency ${t}`,
    adminEmail: email,
    currency: 'EUR',
    merchantId: MERCHANT_ID,
    feeModel: opts.feeModel || 'flat',
    pspRatePct: opts.pspRatePct ?? 8,
    mdrPct: opts.mdrPct ?? null,
    settlementPct: opts.settlementPct ?? null,
    pspFixedFee: opts.pspFixedFee ?? 0.5,
    checkoutFee: opts.checkoutFee ?? 0,
    marginRatePct: opts.marginRatePct ?? 5,
    accountSplitPct: opts.accountSplitPct ?? 70,
    agentPct: opts.agentPct ?? 10,
    chargebackFee: opts.chargebackFee ?? 60,
    refundFee: opts.refundFee ?? 15,
  }).expect(201);
  const workspaceId = onboarded.body.workspaceId;

  await request(app).post(`/invites/${inviteTokenFor(email)}/accept`)
    .send({ password: PASSWORD, fullName: 'Agency Admin' }).expect(201);
  const session = await login(app, email);
  return {
    email, password: PASSWORD, userId: session.userId, workspaceId,
    accessToken: session.accessToken, refreshToken: session.refreshToken,
    authHeaders: { Authorization: `Bearer ${session.accessToken}`, 'X-Workspace-Id': workspaceId },
  };
}

const headersFor = (session, workspaceId) => ({ Authorization: `Bearer ${session.accessToken}`, 'X-Workspace-Id': workspaceId });

/** Create an account (and its owner's login); returns the account plus the owner's session. */
// The owner's login is created without a password and invited, so the test
// accepts the invite the way the person would before signing in.
async function createAccount(app, tenant, overrides = {}) {
  const t = tag();
  const email = overrides.email || `owner+${t}@test.local`;
  const res = await request(app)
    .post(`/workspaces/${tenant.workspaceId}/accounts`).set(tenant.authHeaders)
    .send({
      email, fullName: overrides.fullName || `Owner ${t}`,
      name: overrides.name || `Ava ${t}`,
      revenueSplitPct: overrides.revenueSplitPct ?? 70,
    })
    .expect(201);
  if (res.body.invited) {
    await request(app).post(`/invites/${inviteTokenFor(email)}/accept`)
      .send({ password: PASSWORD }).expect(201);
  }
  const session = await login(app, email);
  return { ...res.body, ownerEmail: email, ownerUserId: session.userId, ownerHeaders: headersFor(session, tenant.workspaceId) };
}

/** Create an agent (and their login); returns the agent plus their session. */
async function createAgent(app, tenant, overrides = {}) {
  const t = tag();
  const email = overrides.email || `agent+${t}@test.local`;
  const res = await request(app)
    .post(`/workspaces/${tenant.workspaceId}/agents`).set(tenant.authHeaders)
    .send({ email, fullName: overrides.fullName || `Agent ${t}`, password: PASSWORD, commissionPct: overrides.commissionPct ?? 10 })
    .expect(201);
  const session = await login(app, email);
  return { ...res.body, email, headers: headersFor(session, tenant.workspaceId), accessToken: session.accessToken, refreshToken: session.refreshToken };
}

/** Invite + accept + login for an admin or analyst. */
async function addMember(app, owner, role, opts = {}) {
  const email = opts.email || `member+${tag()}@test.local`;
  await request(app).post(`/workspaces/${owner.workspaceId}/invites`).set(owner.authHeaders).send({ email, role }).expect(201);
  await request(app).post(`/invites/${inviteTokenFor(email)}/accept`).send({ password: PASSWORD, fullName: opts.fullName || 'Member' }).expect(201);
  const session = await login(app, email);
  return { email, password: PASSWORD, userId: session.userId, accessToken: session.accessToken, refreshToken: session.refreshToken, headers: headersFor(session, owner.workspaceId) };
}

async function assignAgent(app, owner, accountId, agentId) {
  await request(app).post(`/workspaces/${owner.workspaceId}/accounts/${accountId}/agents`).set(owner.authHeaders).send({ agentId }).expect(201);
}

async function createCategory(app, tenant, name = `Cat ${tag()}`) {
  return (await request(app).post(`/workspaces/${tenant.workspaceId}/categories`).set(tenant.authHeaders).send({ name }).expect(201)).body;
}

module.exports = {
  PASSWORD, MERCHANT_ID, tag, login, getPlatformAdmin, inviteTokenFor,
  createTenant, createAccount, createAgent, addMember, assignAgent, createCategory,
};
