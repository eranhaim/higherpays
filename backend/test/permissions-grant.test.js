'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateGrantablePermissions, seatOutranksCaller } = require('../src/auth/permissions');

const caller = (role, permissions) => ({ role, permissions: new Set(permissions) });

test('an admin may grant any permission, a member only what they hold', () => {
  assert.equal(validateGrantablePermissions(caller('workspace_admin', []), ['settings.edit', 'settings.view']), null);
  const manager = caller('member', ['team.view', 'team.manage']);
  assert.equal(validateGrantablePermissions(manager, ['team.view']), null);
  assert.equal(validateGrantablePermissions(manager, ['settings.view']), 'permission_not_grantable');
});

test('a seat outranks a non-admin caller when it is an admin or holds more', () => {
  const manager = caller('member', ['team.view', 'team.manage', 'payments.view']);
  assert.equal(seatOutranksCaller(manager, { role: 'workspace_admin', permissions: [] }), true);
  assert.equal(seatOutranksCaller(manager, { role: 'member', permissions: ['payments.view', 'links.view'] }), true);
  assert.equal(seatOutranksCaller(manager, { role: 'agent', permissions: ['payments.view'] }), false);
  assert.equal(seatOutranksCaller(caller('workspace_admin', []), { role: 'workspace_admin', permissions: ['settings.edit'] }), false);
});
