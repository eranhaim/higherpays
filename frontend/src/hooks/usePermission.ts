import { useQuery } from '@tanstack/react-query';
import { workspacesApi } from '../api/endpoints';
import { ROLE_PERMISSIONS, type Permission } from '../rbac/permissions';
import { useCurrentSession } from './useCurrentSession';

/**
 * Returns `can(permission)` for the current workspace access.
 *
 * Permissions come from `/permissions`, which is what the backend enforces.
 * While that request is in flight the built-in matrix stands in so the
 * sidebar does not flash empty; if it FAILS we grant nothing.
 */
export function useCan(): (perm: Permission | Permission[]) => boolean {
  const { role, activeWorkspaceId } = useCurrentSession();

  const query = useQuery({
    queryKey: ['permissions', activeWorkspaceId],
    queryFn: () => workspacesApi.getPermissions(),
    enabled: Boolean(activeWorkspaceId),
    staleTime: 5 * 60_000,
  });

  let perms: readonly string[] = [];
  if (query.isSuccess) perms = query.data.permissions;
  else if (query.isPending && role && role in ROLE_PERMISSIONS) {
    perms = ROLE_PERMISSIONS[role as keyof typeof ROLE_PERMISSIONS];
  }

  // An array means "any of these" — a page can be worth opening for more than
  // one reason. See the `/links` entry in rbac/nav.ts.
  return (perm) => Array.isArray(perm)
    ? perm.some((p) => perms.includes(p))
    : perms.includes(perm);
}

/** True while the real permission set is still unknown. */
export function usePermissionsPending(): boolean {
  const { activeWorkspaceId } = useCurrentSession();
  const query = useQuery({
    queryKey: ['permissions', activeWorkspaceId],
    queryFn: () => workspacesApi.getPermissions(),
    enabled: Boolean(activeWorkspaceId),
    staleTime: 5 * 60_000,
  });
  return query.isPending;
}
