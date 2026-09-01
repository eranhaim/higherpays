'use strict';
// Creating an agent or an account always creates its login. The three rows
// (user, workspace access, profile) land in one transaction, in the order the
// foreign keys demand: the profile's composite key proves the user holds the
// matching role in this workspace.
const { hashPassword } = require('../auth/passwords');

const MIN_PASSWORD_LENGTH = 8;

/**
 * Find or create the user for an email, then give them `role` in the workspace.
 * An existing user must not already hold a different role here: one person is
 * one thing per workspace.
 *
 * Without a password the login is created with none, which cannot sign in
 * until an invite is accepted — `isNewLogin` tells the caller to send one.
 *
 * @returns {{ userId: string, isNewLogin: boolean } | { err: string }}
 */
async function grantWorkspaceRole(client, workspaceId, { email, fullName, password }, role) {
  let user = (await client.query('SELECT id FROM users WHERE email = $1', [email])).rows[0];
  const isNewLogin = !user;
  if (!user) {
    if (password !== undefined && String(password).length < MIN_PASSWORD_LENGTH) return { err: 'weak_password' };
    user = (await client.query(
      'INSERT INTO users (email, full_name, password_hash) VALUES ($1,$2,$3) RETURNING id',
      [email, fullName, password === undefined ? null : await hashPassword(password)])).rows[0];
  }

  const existing = (await client.query(
    'SELECT role FROM workspace_users WHERE workspace_id = $1 AND user_id = $2', [workspaceId, user.id])).rows[0];
  if (existing && existing.role !== role) return { err: 'already_a_member', role: existing.role };
  if (!existing) {
    await client.query(
      'INSERT INTO workspace_users (workspace_id, user_id, role) VALUES ($1,$2,$3)', [workspaceId, user.id, role]);
  }
  return { userId: user.id, isNewLogin };
}

module.exports = { grantWorkspaceRole, MIN_PASSWORD_LENGTH };
