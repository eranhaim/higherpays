import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useCurrentSession } from '../../hooks/useCurrentSession';
import {
  teamApi, rolesApi, invitesApi,
  type Member, type MemberStatus, type Invite, type InvitableRole, type RoleDefinition,
} from '../../api/endpoints';
import type { Permission } from '../../rbac/permissions';

export interface UseTeamDataResult {
  members: Member[];
  roles: RoleDefinition[];
  pendingInvites: Invite[];
  isLoading: boolean;
  isError: boolean;
  setStatus: (userId: string, status: MemberStatus) => Promise<void>;
  setRole: (userId: string, role: string) => Promise<void>;
  removeMember: (userId: string) => Promise<void>;
  createRole: (name: string, permissions: Permission[]) => Promise<void>;
  updateRole: (key: string, input: { name?: string; permissions?: Permission[] }) => Promise<void>;
  removeRole: (key: string) => Promise<void>;
  invite: (input: { email: string; role: InvitableRole }) => Promise<void>;
  cancelInvite: (id: string) => Promise<void>;
}

export function useTeamData(): UseTeamDataResult {
  const { activeWorkspaceId } = useCurrentSession();
  const queryClient = useQueryClient();
  const enabled = Boolean(activeWorkspaceId);

  const members = useQuery({ queryKey: ['team', activeWorkspaceId], queryFn: () => teamApi.list(), enabled });
  const roles = useQuery({ queryKey: ['roles', activeWorkspaceId], queryFn: () => rolesApi.list(), enabled });
  const invites = useQuery({ queryKey: ['invites', activeWorkspaceId], queryFn: () => invitesApi.list(), enabled });

  const invalidateTeam = () => {
    queryClient.invalidateQueries({ queryKey: ['team', activeWorkspaceId] });
    queryClient.invalidateQueries({ queryKey: ['agents', activeWorkspaceId] });
    queryClient.invalidateQueries({ queryKey: ['accounts', activeWorkspaceId] });
    queryClient.invalidateQueries({ queryKey: ['roles', activeWorkspaceId] });
    queryClient.invalidateQueries({ queryKey: ['permissions', activeWorkspaceId] });
    queryClient.invalidateQueries({ queryKey: ['auth-me'] });
  };
  const invalidateInvites = () => queryClient.invalidateQueries({ queryKey: ['invites', activeWorkspaceId] });

  const status = useMutation({
    mutationFn: ({ userId, status }: { userId: string; status: MemberStatus }) => teamApi.setStatus(userId, status),
    onSuccess: invalidateTeam,
  });
  const role = useMutation({
    mutationFn: ({ userId, nextRole }: { userId: string; nextRole: string }) => teamApi.setRole(userId, nextRole),
    onSuccess: invalidateTeam,
  });
  const remove = useMutation({ mutationFn: (userId: string) => teamApi.remove(userId), onSuccess: invalidateTeam });
  const createRole = useMutation({
    mutationFn: ({ name, permissions }: { name: string; permissions: Permission[] }) => rolesApi.create({ name, permissions }),
    onSuccess: invalidateTeam,
  });
  const updateRole = useMutation({
    mutationFn: ({ key, input }: { key: string; input: { name?: string; permissions?: Permission[] } }) => rolesApi.update(key, input),
    onSuccess: invalidateTeam,
  });
  const removeRole = useMutation({ mutationFn: (key: string) => rolesApi.remove(key), onSuccess: invalidateTeam });
  const invite = useMutation({ mutationFn: (input: { email: string; role: InvitableRole }) => invitesApi.create(input), onSuccess: invalidateInvites });
  const cancelInvite = useMutation({ mutationFn: (id: string) => invitesApi.remove(id), onSuccess: invalidateInvites });

  return {
    members: members.data ?? [],
    roles: roles.data?.roles ?? [],
    // An expired invite is no longer pending, but stays withdrawable until cleared.
    pendingInvites: (invites.data ?? []).filter((i) => !i.acceptedAt),
    isLoading: members.isLoading,
    isError: members.isError,
    setStatus: async (userId, next) => { await status.mutateAsync({ userId, status: next }); },
    setRole: async (userId, nextRole) => { await role.mutateAsync({ userId, nextRole }); },
    removeMember: async (userId) => { await remove.mutateAsync(userId); },
    createRole: async (name, permissions) => { await createRole.mutateAsync({ name, permissions }); },
    updateRole: async (key, input) => { await updateRole.mutateAsync({ key, input }); },
    removeRole: async (key) => { await removeRole.mutateAsync(key); },
    invite: async (input) => { await invite.mutateAsync(input); },
    cancelInvite: async (id) => { await cancelInvite.mutateAsync(id); },
  };
}
