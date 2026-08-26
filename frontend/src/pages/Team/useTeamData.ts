import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useCurrentSession } from '../../hooks/useCurrentSession';
import { teamApi, invitesApi, type Member, type MemberStatus, type Invite, type InvitableRole } from '../../api/endpoints';

export interface UseTeamDataResult {
  members: Member[];
  pendingInvites: Invite[];
  isLoading: boolean;
  isError: boolean;
  setStatus: (userId: string, status: MemberStatus) => Promise<void>;
  removeMember: (userId: string) => Promise<void>;
  invite: (input: { email: string; role: InvitableRole }) => Promise<void>;
  cancelInvite: (id: string) => Promise<void>;
}

export function useTeamData(): UseTeamDataResult {
  const { activeWorkspaceId } = useCurrentSession();
  const queryClient = useQueryClient();
  const enabled = Boolean(activeWorkspaceId);

  const members = useQuery({ queryKey: ['team', activeWorkspaceId], queryFn: () => teamApi.list(), enabled });
  const invites = useQuery({ queryKey: ['invites', activeWorkspaceId], queryFn: () => invitesApi.list(), enabled });

  const invalidateTeam = () => {
    queryClient.invalidateQueries({ queryKey: ['team', activeWorkspaceId] });
    queryClient.invalidateQueries({ queryKey: ['agents', activeWorkspaceId] });
    queryClient.invalidateQueries({ queryKey: ['accounts', activeWorkspaceId] });
  };
  const invalidateInvites = () => queryClient.invalidateQueries({ queryKey: ['invites', activeWorkspaceId] });

  const status = useMutation({
    mutationFn: ({ userId, status }: { userId: string; status: MemberStatus }) => teamApi.setStatus(userId, status),
    onSuccess: invalidateTeam,
  });
  const remove = useMutation({ mutationFn: (userId: string) => teamApi.remove(userId), onSuccess: invalidateTeam });
  const invite = useMutation({ mutationFn: (input: { email: string; role: InvitableRole }) => invitesApi.create(input), onSuccess: invalidateInvites });
  const cancelInvite = useMutation({ mutationFn: (id: string) => invitesApi.remove(id), onSuccess: invalidateInvites });

  return {
    members: members.data ?? [],
    // An expired invite is no longer pending, but stays withdrawable until cleared.
    pendingInvites: (invites.data ?? []).filter((i) => !i.acceptedAt),
    isLoading: members.isLoading,
    isError: members.isError,
    setStatus: async (userId, next) => { await status.mutateAsync({ userId, status: next }); },
    removeMember: async (userId) => { await remove.mutateAsync(userId); },
    invite: async (input) => { await invite.mutateAsync(input); },
    cancelInvite: async (id) => { await cancelInvite.mutateAsync(id); },
  };
}
