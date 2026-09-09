'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { validatePermissions, ROLE_PERMISSIONS } = require('../src/auth/permissions');
const { signImpersonationToken, verifyAccessToken } = require('../src/auth/tokens');

test('custom permissions enforce known values, editor limits, and dependencies', () => {
  assert.equal(validatePermissions(['payments.view'], ['payments.view']), null);
  assert.equal(validatePermissions(['payments.export'], ['payments.view', 'payments.export']), 'permission_dependency_missing');
  assert.equal(validatePermissions(['payments.view', 'payments.export'], ['payments.view']), 'permission_not_grantable');
  assert.equal(validatePermissions(['unknown.permission'], ['unknown.permission']), 'permission_unknown');
  assert.equal(validatePermissions(['payments.view', 'payments.view'], ['payments.view']), 'permissions_invalid');
});

test('owner permissions are complete and impersonation tokens are scoped and short-lived', () => {
  assert.ok(ROLE_PERMISSIONS.workspace_owner.has('roles.manage'));
  const token = signImpersonationToken({
    actor: { id: '00000000-0000-4000-8000-000000000001' },
    subject: {
      id: '00000000-0000-4000-8000-000000000002',
      email: 'target@test.local',
      full_name: 'Target',
    },
    workspaceId: '00000000-0000-4000-8000-000000000003',
    role: 'analyst',
  });
  const payload = verifyAccessToken(token);
  assert.equal(payload.actor, '00000000-0000-4000-8000-000000000001');
  assert.equal(payload.sub, '00000000-0000-4000-8000-000000000002');
  assert.equal(payload.workspace, '00000000-0000-4000-8000-000000000003');
  assert.equal(payload.role, 'analyst');
  assert.equal(payload.impersonation, true);
  assert.ok(payload.exp - payload.iat <= 15 * 60);
});
