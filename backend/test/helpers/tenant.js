'use strict';
// Creates an isolated tenant + owner user via the real HTTP register flow.
// Every test that needs a workspace calls this to get its own island of data.

const request = require('supertest');
const { lastEmailTo } = require('../../src/util/email');

let counter = 0;
function tag() {
  counter += 1;
  return `${Date.now().toString(36)}${counter}${Math.random().toString(36).slice(2, 5)}`;
}

/**
 * @returns {Promise<{
 *   email: string,
 *   password: string,
 *   userId: string,
 *   workspaceId: string,
 *   accessToken: string,
 *   refreshToken: string,
 *   authHeaders: Record<string,string>,
 * }>}
 */
async function createTenant(app, opts = {}) {
  const t = tag();
  const email = opts.email || `owner+${t}@test.local`;
  const password = opts.password || 'passwordtest';
  const organizationName = opts.organizationName || `Agency ${t}`;

  const res = await request(app)
    .post('/auth/register')
    .send({ email, password, fullName: opts.fullName || 'Test Owner', organizationName })
    .expect(201);

  const workspaceId = res.body.workspaces[0].id;
  return {
    email,
    password,
    userId: res.body.user.id,
    workspaceId,
    accessToken: res.body.accessToken,
    refreshToken: res.body.refreshToken,
    authHeaders: {
      Authorization: `Bearer ${res.body.accessToken}`,
      'X-Workspace-Id': workspaceId,
    },
  };
}

/** Convenience: create an account inside a tenant's workspace. */
async function createAccount(app, tenant, overrides = {}) {
  const res = await request(app)
    .post(`/workspaces/${tenant.workspaceId}/accounts`)
    .set(tenant.authHeaders)
    .send({
      stageName: overrides.stageName || `Ava ${tag()}`,
      revenueModel: overrides.revenueModel || 'revshare',
      revenueSplitPct: overrides.revenueSplitPct ?? 70,
      status: overrides.status || 'active',
    })
    .expect(201);
  return res.body;
}

/**
 * Invite + accept + login, returning the new member's ids and auth headers.
 * The invite token is read out of the email stub, the same way the recipient
 * would get it — the API deliberately never returns it.
 */
async function addMember(app, owner, role, opts = {}) {
  const email = opts.email || `member+${tag()}@test.local`;
  const password = opts.password || 'passwordtest';

  await request(app)
    .post(`/workspaces/${owner.workspaceId}/invites`).set(owner.authHeaders)
    .send({ email, role }).expect(201);

  const token = inviteTokenFor(email);
  await request(app)
    .post(`/invites/${token}/accept`)
    .send({ password, fullName: opts.fullName || 'Member' }).expect(201);

  const login = await request(app).post('/auth/login').send({ email, password }).expect(200);
  const members = (await request(app)
    .get(`/workspaces/${owner.workspaceId}/memberships/members`).set(owner.authHeaders).expect(200)).body.members;

  return {
    email,
    password,
    userId: login.body.user.id,
    membershipId: members.find((m) => m.email === email).membershipId,
    accessToken: login.body.accessToken,
    refreshToken: login.body.refreshToken,
    headers: { Authorization: `Bearer ${login.body.accessToken}`, 'X-Workspace-Id': owner.workspaceId },
  };
}

/** Pull the invite token out of the stubbed email for an address. */
function inviteTokenFor(email) {
  const mail = lastEmailTo(email);
  if (!mail) throw new Error(`no invite email was sent to ${email}`);
  const match = /token=([A-Za-z0-9_-]+)/.exec(mail.body);
  if (!match) throw new Error(`no invite token in the email to ${email}`);
  return match[1];
}

/** Assign an agent membership to an account. */
async function assignAgent(app, owner, accountId, membershipId) {
  await request(app)
    .post(`/workspaces/${owner.workspaceId}/accounts/${accountId}/assignments`)
    .set(owner.authHeaders).send({ membershipId }).expect(201);
}

/** Link an account record to a login, which is what puts a user in account scope. */
async function linkAccountUser(app, owner, accountId, userId) {
  await request(app)
    .patch(`/workspaces/${owner.workspaceId}/accounts/${accountId}`)
    .set(owner.authHeaders).send({ userId }).expect(200);
}

module.exports = {
  createTenant, createAccount, addMember, inviteTokenFor, assignAgent, linkAccountUser,
};
