import { describe, expect, it } from 'vitest';
import type { Member } from '../../api/endpoints';
import { accessUpdate, passwordProblem, permissionChange } from './permissionState';

const seat = (overrides: Partial<Member>) => ({
  role: 'member', customRoleKey: null, permissions: ['payments.view'], ...overrides,
}) as Member;

describe('permissionChange', () => {
  it('sends nothing when nothing changed', () => {
    expect(permissionChange({ roleKey: null, permissions: ['payments.view'] }, { roleKey: null, permissions: ['payments.view'] })).toEqual({});
  });

  it('sends the role by name so the seat keeps following it', () => {
    expect(permissionChange({ roleKey: null, permissions: ['payments.view'] }, { roleKey: 'custom_a', permissions: ['links.view'] }))
      .toEqual({ customRoleKey: 'custom_a' });
  });

  it('sends the list when permissions are edited by hand', () => {
    expect(permissionChange({ roleKey: 'custom_a', permissions: ['payments.view'] }, { roleKey: null, permissions: ['payments.view', 'links.view'] }))
      .toEqual({ permissions: ['payments.view', 'links.view'] });
  });

  it('detaches from a role without changing the list', () => {
    expect(permissionChange({ roleKey: 'custom_a', permissions: ['payments.view'] }, { roleKey: null, permissions: ['payments.view'] }))
      .toEqual({ customRoleKey: null });
  });
});

describe('accessUpdate', () => {
  it('always sends the permissions along with a new sign-in role', () => {
    expect(accessUpdate(seat({ role: 'agent' }), 'workspace_admin', { roleKey: null, permissions: ['payments.view'] }))
      .toEqual({ role: 'workspace_admin', permissions: ['payments.view'] });
  });

  it('sends only the permission change when the role stays', () => {
    expect(accessUpdate(seat({}), 'member', { roleKey: null, permissions: ['payments.view'] })).toEqual({});
  });
});

describe('passwordProblem', () => {
  it('names the rule for a weak password', () => {
    expect(passwordProblem('marco1234')).toMatch(/12 characters/);
  });

  it('accepts a strong password', () => {
    expect(passwordProblem('Marco-Strong-Pass1')).toBeNull();
  });
});
