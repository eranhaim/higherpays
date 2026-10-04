import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useCurrentSession } from '../../hooks/useCurrentSession';
import {
  teamApi, invitesApi,
  type Member, type MemberStatus, type Invite, type InvitableRole,
} from '../../api/endpoints';
import type { Permission } from '../../rbac/permissions';

export interface UseTeamDataResult {
  members: Member[];
  pendingInvites: Invite[];
  isLoading: boolean;
  isError: boolean;
  setStatus: (userId: string, status: Exclude<MemberStatus, 'removed'>) => Promise<void>;
  updateMember: (userId: string, input: {
    fullName?: string; email?: string; role?: 'workspace_admin' | 'member';
    permissions?: Permission[]; password?: string; passwordConfirm?: string;
  }) => Promise<void>;
  transferOwner: (userId: string) => Promise<void>;
  removeMember: (userId: string) => Promise<void>;
  createMember: (input: { email: string; password: string; fullName?: string; role: 'workspace_admin' | 'member'; permissions: Permission[] }) => Promise<void>;
  invite: (input: { email: string; role: InvitableRole }) => Promise<void>;
  cancelInvite: (id: string) => Promise<void>;
}

export function useTeamData(salesRange?: { from?: string; to?: string }): UseTeamDataResult {
  const { activeWorkspaceId } = useCurrentSession();
  const queryClient = useQueryClient();
  const enabled = Boolean(activeWorkspaceId);

  const members = useQuery({ queryKey: ['team', activeWorkspaceId, salesRange], queryFn: () => teamApi.list(salesRange), enabled });
  const invites = useQuery({ queryKey: ['invites', activeWorkspaceId], queryFn: () => invitesApi.list(), enabled });

  const invalidateTeam = () => {
    queryClient.invalidateQueries({ queryKey: ['team', activeWorkspaceId] });
    queryClient.invalidateQueries({ queryKey: ['agents', activeWorkspaceId] });
    queryClient.invalidateQueries({ queryKey: ['accounts', activeWorkspaceId] });
    queryClient.invalidateQueries({ queryKey: ['permissions', activeWorkspaceId] });
    queryClient.invalidateQueries({ queryKey: ['auth-me'] });
  };
  const invalidateInvites = () => queryClient.invalidateQueries({ queryKey: ['invites', activeWorkspaceId] });

  const status = useMutation({
    mutationFn: ({ userId, status }: { userId: string; status: Exclude<MemberStatus, 'removed'> }) => teamApi.setStatus(userId, status),
    onSuccess: invalidateTeam,
  });
  const remove = useMutation({ mutationFn: (userId: string) => teamApi.remove(userId), onSuccess: invalidateTeam });
  const createMember = useMutation({ mutationFn: teamApi.create, onSuccess: invalidateTeam });
  const update = useMutation({
    mutationFn: ({ userId, input }: { userId: string; input: {
      fullName?: string; email?: string; role?: 'workspace_admin' | 'member';
      permissions?: Permission[]; password?: string; passwordConfirm?: string;
    } }) => teamApi.update(userId, input),
    onSuccess: invalidateTeam,
  });
  const owner = useMutation({ mutationFn: (userId: string) => teamApi.transferOwner(userId), onSuccess: invalidateTeam });
  const invite = useMutation({ mutationFn: (input: { email: string; role: InvitableRole }) => invitesApi.create(input), onSuccess: invalidateInvites });
  const cancelInvite = useMutation({ mutationFn: (id: string) => invitesApi.remove(id), onSuccess: invalidateInvites });

  return {
    members: members.data ?? [],
    // An expired invite is no longer pending, but stays withdrawable until cleared.
    pendingInvites: (invites.data ?? []).filter((i) => !i.acceptedAt),
    isLoading: members.isLoading,
    isError: members.isError,
    setStatus: async (userId, next) => { await status.mutateAsync({ userId, status: next }); },
    updateMember: async (userId, input) => { await update.mutateAsync({ userId, input }); },
    transferOwner: async (userId) => { await owner.mutateAsync(userId); },
    removeMember: async (userId) => { await remove.mutateAsync(userId); },
    createMember: async (input) => { await createMember.mutateAsync(input); },
    invite: async (input) => { await invite.mutateAsync(input); },
    cancelInvite: async (id) => { await cancelInvite.mutateAsync(id); },
  };
}
