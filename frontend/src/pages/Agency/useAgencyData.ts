import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCurrentSession } from '../../hooks/useCurrentSession';
import {
  accountsApi, agentsApi, invitesApi, platformApi, teamApi,
  type Account, type Agent, type CreateAccountInput, type CreateAgentInput,
  type Invite, type Member, type MemberStatus, type UpdateAccountInput, type UpdateAgentInput,
} from '../../api/endpoints';
import type { Permission } from '../../rbac/permissions';

export interface MemberInput {
  fullName?: string;
  email?: string;
  role?: 'workspace_admin' | 'member';
  permissions?: Permission[];
  password?: string;
  passwordConfirm?: string;
}

export interface UseAgencyDataResult {
  members: Member[];
  pendingInvites: Invite[];
  /** The pickers inside the editors; empty until the caller may manage them. */
  accounts: Account[];
  agents: Agent[];
  isLoading: boolean;
  isError: boolean;

  createMember: (input: { email: string; password: string; fullName?: string; role: 'workspace_admin' | 'member'; permissions: Permission[] }) => Promise<void>;
  updateMember: (userId: string, input: MemberInput) => Promise<void>;
  setMemberStatus: (userId: string, status: Exclude<MemberStatus, 'removed'>) => Promise<void>;
  removeMember: (userId: string) => Promise<void>;
  transferOwner: (userId: string) => Promise<void>;
  setPlatformAdmin: (userId: string, enabled: boolean) => Promise<void>;
  cancelInvite: (id: string) => Promise<void>;

  createAccount: (input: CreateAccountInput, agentIds: string[]) => Promise<{ invited: boolean }>;
  updateAccount: (id: string, input: UpdateAccountInput) => Promise<void>;
  setAssignedAgents: (accountId: string, agentIds: string[]) => Promise<void>;

  createAgent: (input: CreateAgentInput, accountIds: string[]) => Promise<void>;
  updateAgent: (id: string, input: UpdateAgentInput) => Promise<void>;
  setAssignedAccounts: (agentId: string, currentIds: string[], nextIds: string[]) => Promise<void>;
}

/**
 * Everything the one members list and its three editors need. The rows come
 * from `/team` alone — it already carries the profile behind each seat — so
 * the accounts and agents lists are only fetched for the assignment pickers,
 * and only once the caller may actually open an editor.
 */
export function useAgencyData(
  salesRange: { from?: string; to?: string },
  canManageRoster: boolean,
): UseAgencyDataResult {
  const { activeWorkspaceId } = useCurrentSession();
  const queryClient = useQueryClient();
  const enabled = Boolean(activeWorkspaceId);

  const members = useQuery({
    queryKey: ['team', activeWorkspaceId, salesRange],
    queryFn: () => teamApi.list(salesRange),
    enabled,
  });
  const invites = useQuery({ queryKey: ['invites', activeWorkspaceId], queryFn: () => invitesApi.list(), enabled });
  // Archived profiles belong in the pickers too: an assignment survives a
  // suspension, and hiding them would silently drop one on the next save.
  const agents = useQuery({
    queryKey: ['agents', activeWorkspaceId, 'include-archived'],
    queryFn: () => agentsApi.list({ showArchived: true }),
    enabled: enabled && canManageRoster,
  });
  const accounts = useQuery({
    queryKey: ['accounts', activeWorkspaceId],
    queryFn: () => accountsApi.list(),
    enabled: enabled && canManageRoster,
  });

  // A seat, a profile and an assignment all change what the list renders, so
  // every mutation here refreshes the same four keys.
  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['team', activeWorkspaceId] });
    queryClient.invalidateQueries({ queryKey: ['accounts', activeWorkspaceId] });
    queryClient.invalidateQueries({ queryKey: ['agents', activeWorkspaceId] });
    queryClient.invalidateQueries({ queryKey: ['permissions', activeWorkspaceId] });
    queryClient.invalidateQueries({ queryKey: ['auth-me'] });
  };
  const invalidateInvites = () => queryClient.invalidateQueries({ queryKey: ['invites', activeWorkspaceId] });

  const createMember = useMutation({ mutationFn: teamApi.create, onSuccess: invalidate });
  const updateMember = useMutation({
    mutationFn: ({ userId, input }: { userId: string; input: MemberInput }) => teamApi.update(userId, input),
    onSuccess: invalidate,
  });
  const memberStatus = useMutation({
    mutationFn: ({ userId, status }: { userId: string; status: Exclude<MemberStatus, 'removed'> }) => teamApi.setStatus(userId, status),
    onSuccess: invalidate,
  });
  const removeMember = useMutation({ mutationFn: (userId: string) => teamApi.remove(userId), onSuccess: invalidate });
  const transferOwner = useMutation({ mutationFn: (userId: string) => teamApi.transferOwner(userId), onSuccess: invalidate });
  // The operator route, above any workspace. requirePlatformAdmin is the gate;
  // hiding the control is only so the rest of an agency never sees it.
  const platformAdmin = useMutation({
    mutationFn: ({ userId, enabled: on }: { userId: string; enabled: boolean }) => platformApi.setPlatformAdmin(userId, on),
    onSuccess: invalidate,
  });
  const cancelInvite = useMutation({ mutationFn: (id: string) => invitesApi.remove(id), onSuccess: invalidateInvites });

  const createAccount = useMutation({
    mutationFn: async ({ input, agentIds }: { input: CreateAccountInput; agentIds: string[] }) => {
      const created = await accountsApi.create(input);
      for (const agentId of agentIds) await accountsApi.assignAgent(created.id, agentId);
      return { invited: created.invited };
    },
    onSuccess: invalidate,
  });
  const updateAccount = useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdateAccountInput }) => accountsApi.update(id, input),
    onSuccess: invalidate,
  });
  const assignAgents = useMutation({
    mutationFn: async ({ accountId, agentIds }: { accountId: string; agentIds: string[] }) => {
      const current = new Set((await accountsApi.get(accountId)).agents?.map((a) => a.agentId) ?? []);
      const wanted = new Set(agentIds);
      for (const id of wanted) if (!current.has(id)) await accountsApi.assignAgent(accountId, id);
      for (const id of current) if (!wanted.has(id)) await accountsApi.unassignAgent(accountId, id);
    },
    onSuccess: invalidate,
  });

  const createAgent = useMutation({
    mutationFn: async ({ input, accountIds }: { input: CreateAgentInput; accountIds: string[] }) => {
      const created = await agentsApi.create(input);
      for (const accountId of accountIds) await accountsApi.assignAgent(accountId, created.id);
    },
    onSuccess: invalidate,
  });
  const updateAgent = useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdateAgentInput }) => agentsApi.update(id, input),
    onSuccess: invalidate,
  });
  const assignAccounts = useMutation({
    mutationFn: async ({ agentId, currentIds, nextIds }: { agentId: string; currentIds: string[]; nextIds: string[] }) => {
      const current = new Set(currentIds);
      const next = new Set(nextIds);
      for (const accountId of nextIds) if (!current.has(accountId)) await accountsApi.assignAgent(accountId, agentId);
      for (const accountId of currentIds) if (!next.has(accountId)) await accountsApi.unassignAgent(accountId, agentId);
    },
    onSuccess: invalidate,
  });

  return {
    members: members.data ?? [],
    // An expired invite is no longer pending, but stays withdrawable until cleared.
    pendingInvites: (invites.data ?? []).filter((invite) => !invite.acceptedAt),
    accounts: accounts.data ?? [],
    agents: agents.data ?? [],
    isLoading: members.isLoading,
    isError: members.isError,

    createMember: async (input) => { await createMember.mutateAsync(input); },
    updateMember: async (userId, input) => { await updateMember.mutateAsync({ userId, input }); },
    setMemberStatus: async (userId, status) => { await memberStatus.mutateAsync({ userId, status }); },
    removeMember: async (userId) => { await removeMember.mutateAsync(userId); },
    transferOwner: async (userId) => { await transferOwner.mutateAsync(userId); },
    setPlatformAdmin: async (userId, on) => { await platformAdmin.mutateAsync({ userId, enabled: on }); },
    cancelInvite: async (id) => { await cancelInvite.mutateAsync(id); },

    createAccount: (input, agentIds) => createAccount.mutateAsync({ input, agentIds }),
    updateAccount: async (id, input) => { await updateAccount.mutateAsync({ id, input }); },
    setAssignedAgents: async (accountId, agentIds) => { await assignAgents.mutateAsync({ accountId, agentIds }); },

    createAgent: async (input, accountIds) => { await createAgent.mutateAsync({ input, accountIds }); },
    updateAgent: async (id, input) => { await updateAgent.mutateAsync({ id, input }); },
    setAssignedAccounts: async (agentId, currentIds, nextIds) => {
      await assignAccounts.mutateAsync({ agentId, currentIds, nextIds });
    },
  };
}

/** One creator with its agent roster, for the assignment editor. */
export function useAccountDetail(id: string | null) {
  const { activeWorkspaceId } = useCurrentSession();
  return useQuery({
    queryKey: ['account', activeWorkspaceId, id],
    queryFn: () => accountsApi.get(id as string),
    enabled: Boolean(activeWorkspaceId && id),
  });
}
