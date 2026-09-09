import { describe, expect, it } from 'vitest';
import { toggleRolePermission } from './roles';

describe('role permission dependencies', () => {
  it('adds required view permissions and removes dependent permissions', () => {
    const enabled = toggleRolePermission(['data.view_all'], 'roles.manage');
    expect(enabled).toEqual(expect.arrayContaining([
      'data.view_all', 'roles.manage', 'team.manage', 'team.view',
    ]));
    expect(toggleRolePermission(enabled, 'team.view')).toEqual(['data.view_all']);
  });
});
