import { useQuery } from '@tanstack/react-query';
import { platformApi, type PlatformWorkspace } from '../../api/endpoints';

export interface UsePlatformDataResult {
  /** True while we still don't know whether the caller is a platform admin. */
  isCheckingAccess: boolean;
  isPlatformAdmin: boolean;
  workspaces: PlatformWorkspace[];
  isLoading: boolean;
  isError: boolean;
}

export function usePlatformData(): UsePlatformDataResult {
  // A 403 here is the answer "you are not a platform admin", not a failure,
  // so it gates the rest rather than surfacing as an error card.
  const me = useQuery({ queryKey: ['platform-me'], queryFn: () => platformApi.me(), retry: false });
  const isPlatformAdmin = me.isSuccess;

  const workspaces = useQuery({
    queryKey: ['platform-workspaces'],
    queryFn: () => platformApi.listWorkspaces(),
    enabled: isPlatformAdmin,
  });

  return {
    isCheckingAccess: me.isPending,
    isPlatformAdmin,
    workspaces: workspaces.data ?? [],
    isLoading: workspaces.isLoading,
    isError: workspaces.isError,
  };
}
