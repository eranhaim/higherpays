import { useCan } from '../../hooks/usePermission';
import { useCurrentSession } from '../../hooks/useCurrentSession';
import type { Permission } from '../../rbac/permissions';

/**
 * What the signed-in person may give to someone else: everything for an owner
 * or admin, otherwise only what they hold themselves. The server enforces the
 * same rule; this keeps the form from offering what it would refuse.
 */
export function useGrantable() {
  const can = useCan();
  const { role } = useCurrentSession();
  const grantsAnything = role === 'workspace_owner' || role === 'workspace_admin';
  const isGrantable = (permission: Permission) => grantsAnything || can(permission);
  return { grantsAnything, isGrantable, onlyGrantable: (list: readonly Permission[]) => list.filter(isGrantable) };
}
