import type { Member } from '../../api/endpoints';
import type { Permission } from '../../rbac/permissions';

/** What a seat holds: either a custom role, or a permission list of its own. */
export interface PermissionState {
  roleKey: string | null;
  permissions: Permission[];
}

export function stateFromMember(member?: { customRoleKey: string | null; permissions: Permission[] }): PermissionState | null {
  return member ? { roleKey: member.customRoleKey, permissions: member.permissions } : null;
}

const sameSet = (a: Permission[], b: Permission[]) => a.length === b.length && a.every((permission) => b.includes(permission));

/**
 * The fields of a member update that carry a permission change, or none when
 * nothing changed. A role is sent by name so the seat keeps following it;
 * anything else is sent as the list.
 */
export function permissionChange(before: PermissionState, after: PermissionState):
{ customRoleKey?: string | null; permissions?: Permission[] } {
  if (before.roleKey === after.roleKey && sameSet(before.permissions, after.permissions)) return {};
  if (after.roleKey) return { customRoleKey: after.roleKey };
  if (before.roleKey && sameSet(before.permissions, after.permissions)) return { customRoleKey: null };
  return { permissions: after.permissions };
}

/**
 * The member update that carries a role and permission change, or `{}` when
 * nothing changed. A new sign-in role resets permissions on the server, so
 * when the role moves the chosen permissions are always sent along.
 */
export function accessUpdate(member: Member, nextRole: Member['role'], after: PermissionState) {
  if (nextRole === member.role) {
    return permissionChange({ roleKey: member.customRoleKey, permissions: member.permissions }, after);
  }
  const permissions = after.roleKey ? { customRoleKey: after.roleKey } : { permissions: after.permissions };
  return { role: nextRole as 'agent' | 'workspace_admin' | 'member', ...permissions };
}

/** Mirrors the server's rule, so a weak password is caught before the request, with the rule spelled out. */
export function passwordProblem(password: string): string | null {
  if (password.length >= 12 && /[a-z]/.test(password) && /[A-Z]/.test(password) && /\d/.test(password)) return null;
  return 'The password needs at least 12 characters, with upper case, lower case and a number.';
}
