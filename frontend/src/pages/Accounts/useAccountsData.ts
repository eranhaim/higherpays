import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useCurrentSession } from '../../hooks/useCurrentSession';
import {
  accountsApi, membershipsApi,
  type Account, type Agent, type CreateAccountInput, type UpdateAccountInput,
} from '../../api/endpoints';

export interface UseAccountsDataResult {
  accounts: Account[];
  agents: Agent[];
  isLoading: boolean;
  isError: boolean;
  createAccount: (input: CreateAccountInput, agentMembershipIds: string[]) => Promise<void>;
  updateAccount: (id: string, input: UpdateAccountInput) => Promise<void>;
}

export function useAccountsData(): UseAccountsDataResult {
  const { activeWorkspaceId } = useCurrentSession();
  const queryClient = useQueryClient();
  const enabled = Boolean(activeWorkspaceId);

  const accounts = useQuery({
    queryKey: ['accounts', activeWorkspaceId],
    queryFn: () => accountsApi.list(),
    enabled,
  });
  const agents = useQuery({
    queryKey: ['team-agents', activeWorkspaceId],
    queryFn: () => membershipsApi.listAgents(),
    enabled,
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['accounts', activeWorkspaceId] });

  const create = useMutation({
    mutationFn: async ({ input, agentMembershipIds }: { input: CreateAccountInput; agentMembershipIds: string[] }) => {
      const created = await accountsApi.create(input);
      for (const membershipId of agentMembershipIds) {
        await accountsApi.assignAgent(created.id, membershipId);
      }
    },
    onSuccess: invalidate,
  });

  const update = useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdateAccountInput }) => accountsApi.update(id, input),
    onSuccess: invalidate,
  });

  return {
    accounts: accounts.data ?? [],
    agents: agents.data ?? [],
    isLoading: accounts.isLoading,
    isError: accounts.isError,
    createAccount: async (input, agentMembershipIds) => {
      await create.mutateAsync({ input, agentMembershipIds });
    },
    updateAccount: async (id, input) => {
      await update.mutateAsync({ id, input });
    },
  };
}
