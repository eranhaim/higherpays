import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { platformApi, type PlatformWorkspace, type PlatformOverview, type OnboardAgencyInput, type PlatformFeeRate } from '../../api/endpoints';
import { useAuthStore } from '../../store/auth';

export interface UsePlatformDataResult {
  isPlatformAdmin: boolean;
  requiresTwoFactor: boolean;
  overview: PlatformOverview | null;
  workspaces: PlatformWorkspace[];
  isLoading: boolean;
  isError: boolean;
  onboardAgency: (input: OnboardAgencyInput) => Promise<{ workspaceId: string; webhookEndpointId: string }>;
  setStatus: (id: string, status: 'active' | 'suspended') => Promise<unknown>;
  setCurrency: (id: string, currency: string) => Promise<unknown>;
  setPlatformFee: (id: string, input: PlatformFeeRate) => Promise<unknown>;
}

export function usePlatformData(): UsePlatformDataResult {
  const queryClient = useQueryClient();
  const user = useAuthStore((state) => state.user);
  const isPlatformAdmin = Boolean(user?.isPlatformAdmin);
  const requiresTwoFactor = isPlatformAdmin && !user?.twoFactorEnabled;
  const canLoadPlatform = isPlatformAdmin && !requiresTwoFactor;

  const overview = useQuery({ queryKey: ['platform-overview'], queryFn: () => platformApi.overview(), enabled: canLoadPlatform });
  const workspaces = useQuery({ queryKey: ['platform-workspaces'], queryFn: () => platformApi.listWorkspaces(), enabled: canLoadPlatform });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['platform-workspaces'] });
    queryClient.invalidateQueries({ queryKey: ['platform-workspace'] });
    queryClient.invalidateQueries({ queryKey: ['platform-overview'] });
    queryClient.invalidateQueries({ queryKey: ['auth-me'] });
  };
  const onboard = useMutation({ mutationFn: (input: OnboardAgencyInput) => platformApi.onboardAgency(input), onSuccess: invalidate });
  const status = useMutation({
    mutationFn: ({ id, status }: { id: string; status: 'active' | 'suspended' }) => platformApi.setStatus(id, status),
    onSuccess: () => {
      invalidate();
    },
  });
  const fee = useMutation({
    mutationFn: ({ id, input }: { id: string; input: PlatformFeeRate }) => platformApi.setPlatformFee(id, input),
    onSuccess: invalidate,
  });
  const currency = useMutation({
    mutationFn: ({ id, currency }: { id: string; currency: string }) => platformApi.setCurrency(id, currency),
    onSuccess: invalidate,
  });

  return {
    isPlatformAdmin,
    requiresTwoFactor,
    overview: overview.data ?? null,
    workspaces: workspaces.data ?? [],
    isLoading: workspaces.isLoading,
    isError: workspaces.isError,
    onboardAgency: (input) => onboard.mutateAsync(input),
    setStatus: (id, s) => status.mutateAsync({ id, status: s }),
    setCurrency: (id, nextCurrency) => currency.mutateAsync({ id, currency: nextCurrency }),
    setPlatformFee: (id, input) => fee.mutateAsync({ id, input }),
  };
}
