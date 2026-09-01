import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useCurrentSession } from '../../hooks/useCurrentSession';
import {
  accountsApi, agentsApi,
  type Account, type Agent, type CreateAccountInput, type UpdateAccountInput,
} from '../../api/endpoints';

export interface UseAccountsDataResult {
  accounts: Account[];
  agents: Agent[];
  isLoading: boolean;
  isError: boolean;
  createAccount: (input: CreateAccountInput, agentIds: string[]) => Promise<{ invited: boolean }>;
  updateAccount: (id: string, input: UpdateAccountInput) => Promise<void>;
  setAssignedAgents: (account: Account, agentIds: string[]) => Promise<void>;
}

export function useAccountsData(canManage: boolean): UseAccountsDataResult {
  const { activeWorkspaceId } = useCurrentSession();
  const queryClient = useQueryClient();
  const enabled = Boolean(activeWorkspaceId);

  const accounts = useQuery({ queryKey: ['accounts', activeWorkspaceId], queryFn: () => accountsApi.list(), enabled });
  const agents = useQuery({ queryKey: ['agents', activeWorkspaceId], queryFn: () => agentsApi.list(), enabled: enabled && canManage });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['accounts', activeWorkspaceId] });
    queryClient.invalidateQueries({ queryKey: ['agents', activeWorkspaceId] });
    queryClient.invalidateQueries({ queryKey: ['team', activeWorkspaceId] });
  };

  const create = useMutation({
    mutationFn: async ({ input, agentIds }: { input: CreateAccountInput; agentIds: string[] }) => {
      const created = await accountsApi.create(input);
      for (const agentId of agentIds) await accountsApi.assignAgent(created.id, agentId);
      return { invited: created.invited };
    },
    onSuccess: invalidate,
  });
  const update = useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdateAccountInput }) => accountsApi.update(id, input),
    onSuccess: invalidate,
  });
  const assign = useMutation({
    mutationFn: async ({ account, agentIds }: { account: Account; agentIds: string[] }) => {
      const current = new Set((await accountsApi.get(account.id)).agents?.map((a) => a.agentId) ?? []);
      const wanted = new Set(agentIds);
      for (const id of wanted) if (!current.has(id)) await accountsApi.assignAgent(account.id, id);
      for (const id of current) if (!wanted.has(id)) await accountsApi.unassignAgent(account.id, id);
    },
    onSuccess: invalidate,
  });

  return {
    accounts: accounts.data ?? [],
    agents: agents.data ?? [],
    isLoading: accounts.isLoading,
    isError: accounts.isError,
    createAccount: (input, agentIds) => create.mutateAsync({ input, agentIds }),
    updateAccount: async (id, input) => { await update.mutateAsync({ id, input }); },
    setAssignedAgents: async (account, agentIds) => { await assign.mutateAsync({ account, agentIds }); },
  };
}

/** One account with its agent roster, for the assignment editor. */
export function useAccountDetail(id: string | null) {
  const { activeWorkspaceId } = useCurrentSession();
  return useQuery({
    queryKey: ['account', activeWorkspaceId, id],
    queryFn: () => accountsApi.get(id as string),
    enabled: Boolean(activeWorkspaceId && id),
  });
}
