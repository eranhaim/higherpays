import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useCurrentSession } from '../../hooks/useCurrentSession';
import {
  membershipsApi, invitesApi, rolesApi,
  type Chatter, type Invite, type WorkspaceRole,
} from '../../api/endpoints';

export interface UseTeamDataResult {
  chatters: Chatter[];
  pendingInvites: Invite[];
  roles: WorkspaceRole[];
  isLoading: boolean;
  isError: boolean;
  setCommission: (membershipId: string, commissionPct: number) => Promise<void>;
  invite: (input: { email: string; role: string }) => Promise<void>;
}

export function useTeamData(): UseTeamDataResult {
  const { activeWorkspaceId } = useCurrentSession();
  const queryClient = useQueryClient();
  const enabled = Boolean(activeWorkspaceId);

  const chatters = useQuery({
    queryKey: ['team-chatters', activeWorkspaceId],
    queryFn: () => membershipsApi.listChatters(),
    enabled,
  });
  const invites = useQuery({
    queryKey: ['invites', activeWorkspaceId],
    queryFn: () => invitesApi.list(),
    enabled,
  });
  const roles = useQuery({
    queryKey: ['roles', activeWorkspaceId],
    queryFn: () => rolesApi.list(),
    enabled,
    staleTime: 5 * 60_000,
  });

  const commission = useMutation({
    mutationFn: ({ membershipId, commissionPct }: { membershipId: string; commissionPct: number }) =>
      membershipsApi.setCommissionPct(membershipId, commissionPct),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['team-chatters', activeWorkspaceId] }),
  });

  const invite = useMutation({
    mutationFn: (input: { email: string; role: string }) => invitesApi.create(input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['invites', activeWorkspaceId] }),
  });

  return {
    chatters: chatters.data ?? [],
    pendingInvites: (invites.data ?? []).filter((i) => !i.acceptedAt),
    roles: roles.data ?? [],
    isLoading: chatters.isLoading,
    isError: chatters.isError,
    setCommission: async (membershipId, commissionPct) => {
      await commission.mutateAsync({ membershipId, commissionPct });
    },
    invite: async (input) => {
      await invite.mutateAsync(input);
    },
  };
}
