import { useQuery } from '@tanstack/react-query';
import { platformApi, type PlatformRole, type PlatformWorkspace } from '../../api/endpoints';

export interface UsePlatformDataResult {
  role: PlatformRole | null;
  /** True while we still don't know whether the caller is an operator. */
  isCheckingAccess: boolean;
  isOperator: boolean;
  workspaces: PlatformWorkspace[];
  isLoading: boolean;
  isError: boolean;
}

export function usePlatformData(): UsePlatformDataResult {
  // A 403 here is the answer "you are not an operator", not a failure, so it
  // gates the rest rather than surfacing as an error card.
  const me = useQuery({
    queryKey: ['platform-me'],
    queryFn: () => platformApi.me(),
    retry: false,
  });
  const isOperator = me.isSuccess;

  const workspaces = useQuery({
    queryKey: ['platform-workspaces'],
    queryFn: () => platformApi.listWorkspaces(),
    enabled: isOperator,
  });

  return {
    role: me.data?.role ?? null,
    isCheckingAccess: me.isPending,
    isOperator,
    workspaces: workspaces.data ?? [],
    isLoading: workspaces.isLoading,
    isError: workspaces.isError,
  };
}
