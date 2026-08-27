import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { platformApi, type PlatformWorkspace, type PlatformOverview, type OnboardAgencyInput, type PlatformFeeRate } from '../../api/endpoints';

export interface UsePlatformDataResult {
  /** True while we still don't know whether the caller is a platform admin. */
  isCheckingAccess: boolean;
  isPlatformAdmin: boolean;
  overview: PlatformOverview | null;
  workspaces: PlatformWorkspace[];
  isLoading: boolean;
  isError: boolean;
  onboardAgency: (input: OnboardAgencyInput) => Promise<{ workspaceId: string; webhookEndpointId: string }>;
  setStatus: (id: string, status: 'active' | 'suspended') => Promise<unknown>;
  setPlatformFee: (id: string, input: PlatformFeeRate) => Promise<unknown>;
}

export function usePlatformData(): UsePlatformDataResult {
  const queryClient = useQueryClient();
  // A 403 here is the answer "you are not a platform admin", not a failure,
  // so it gates the rest rather than surfacing as an error card.
  const me = useQuery({ queryKey: ['platform-me'], queryFn: () => platformApi.me(), retry: false });
  const isPlatformAdmin = me.isSuccess;

  const overview = useQuery({ queryKey: ['platform-overview'], queryFn: () => platformApi.overview(), enabled: isPlatformAdmin });
  const workspaces = useQuery({ queryKey: ['platform-workspaces'], queryFn: () => platformApi.listWorkspaces(), enabled: isPlatformAdmin });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['platform-workspaces'] });
    queryClient.invalidateQueries({ queryKey: ['platform-overview'] });
  };
  const onboard = useMutation({ mutationFn: (input: OnboardAgencyInput) => platformApi.onboardAgency(input), onSuccess: invalidate });
  const status = useMutation({
    mutationFn: ({ id, status }: { id: string; status: 'active' | 'suspended' }) => platformApi.setStatus(id, status),
    onSuccess: invalidate,
  });
  const fee = useMutation({
    mutationFn: ({ id, input }: { id: string; input: PlatformFeeRate }) => platformApi.setPlatformFee(id, input),
    onSuccess: invalidate,
  });

  return {
    isCheckingAccess: me.isPending,
    isPlatformAdmin,
    overview: overview.data ?? null,
    workspaces: workspaces.data ?? [],
    isLoading: workspaces.isLoading,
    isError: workspaces.isError,
    onboardAgency: (input) => onboard.mutateAsync(input),
    setStatus: (id, s) => status.mutateAsync({ id, status: s }),
    setPlatformFee: (id, input) => fee.mutateAsync({ id, input }),
  };
}
