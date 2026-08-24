import { useQuery } from '@tanstack/react-query';
import { workspacesApi } from '../api/endpoints';
import { SYSTEM_ROLE_PERMISSIONS, type Permission } from '../rbac/permissions';
import { useCurrentSession } from './useCurrentSession';

/**
 * Returns `can(permission)` for the current membership.
 *
 * Permissions come from the workspace's role definitions (`/permissions`),
 * which is what the backend enforces. Until that request resolves, the
 * built-in matrix stands in so the sidebar does not flash empty.
 */
export function useCan(): (perm: Permission) => boolean {
  const { role, activeWorkspaceId } = useCurrentSession();

  const query = useQuery({
    queryKey: ['permissions', activeWorkspaceId],
    queryFn: () => workspacesApi.getPermissions(),
    enabled: Boolean(activeWorkspaceId),
    staleTime: 5 * 60_000,
  });

  const perms: readonly string[] = query.data?.permissions ?? SYSTEM_ROLE_PERMISSIONS[role] ?? [];
  return (perm) => perms.includes(perm);
}
