import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useCurrentSession } from '../../hooks/useCurrentSession';
import {
  membershipsApi, invitesApi, rolesApi,
  type Agent, type Member, type Invite, type WorkspaceRole,
} from '../../api/endpoints';

export interface UseTeamDataResult {
  agents: Agent[];
  members: Member[];
  pendingInvites: Invite[];
  roles: WorkspaceRole[];
  isLoading: boolean;
  isError: boolean;
  setCommission: (membershipId: string, commissionPct: number) => Promise<void>;
  setRole: (membershipId: string, role: string) => Promise<void>;
  removeMember: (membershipId: string) => Promise<void>;
  invite: (input: { email: string; role: string }) => Promise<void>;
}

export function useTeamData(): UseTeamDataResult {
  const { activeWorkspaceId } = useCurrentSession();
  const queryClient = useQueryClient();
  const enabled = Boolean(activeWorkspaceId);

  const agents = useQuery({
    queryKey: ['team-agents', activeWorkspaceId],
    queryFn: () => membershipsApi.listAgents(),
    enabled,
  });
  const members = useQuery({
    queryKey: ['team-members', activeWorkspaceId],
    queryFn: () => membershipsApi.listMembers(),
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

  const invalidateTeam = () => {
    queryClient.invalidateQueries({ queryKey: ['team-agents', activeWorkspaceId] });
    queryClient.invalidateQueries({ queryKey: ['team-members', activeWorkspaceId] });
  };

  const commission = useMutation({
    mutationFn: ({ membershipId, commissionPct }: { membershipId: string; commissionPct: number }) =>
      membershipsApi.setCommissionPct(membershipId, commissionPct),
    onSuccess: invalidateTeam,
  });
  const role = useMutation({
    mutationFn: ({ membershipId, role }: { membershipId: string; role: string }) =>
      membershipsApi.setRole(membershipId, role),
    onSuccess: invalidateTeam,
  });
  const remove = useMutation({
    mutationFn: (membershipId: string) => membershipsApi.remove(membershipId),
    onSuccess: invalidateTeam,
  });
  const invite = useMutation({
    mutationFn: (input: { email: string; role: string }) => invitesApi.create(input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['invites', activeWorkspaceId] }),
  });

  return {
    agents: agents.data ?? [],
    members: members.data ?? [],
    pendingInvites: (invites.data ?? []).filter((i) => !i.acceptedAt),
    roles: roles.data ?? [],
    isLoading: agents.isLoading || members.isLoading,
    isError: agents.isError || members.isError,
    setCommission: async (membershipId, commissionPct) => {
      await commission.mutateAsync({ membershipId, commissionPct });
    },
    setRole: async (membershipId, next) => {
      await role.mutateAsync({ membershipId, role: next });
    },
    removeMember: async (membershipId) => {
      await remove.mutateAsync(membershipId);
    },
    invite: async (input) => {
      await invite.mutateAsync(input);
    },
  };
}
