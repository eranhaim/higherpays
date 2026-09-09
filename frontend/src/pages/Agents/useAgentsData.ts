import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useCurrentSession } from '../../hooks/useCurrentSession';
import {
  agentsApi, accountsApi,
  type Account, type Agent, type CreateAgentInput, type UpdateAgentInput,
} from '../../api/endpoints';

export interface UseAgentsDataResult {
  agents: Agent[];
  accounts: Account[];
  isLoading: boolean;
  isError: boolean;
  createAgent: (input: CreateAgentInput) => Promise<Agent>;
  updateAgent: (id: string, input: UpdateAgentInput) => Promise<void>;
  setArchived: (agent: Agent, archived: boolean) => Promise<void>;
  setAssignedAccounts: (agentId: string, currentIds: string[], nextIds: string[]) => Promise<void>;
}

export function useAgentsData(): UseAgentsDataResult {
  const { activeWorkspaceId } = useCurrentSession();
  const queryClient = useQueryClient();
  const enabled = Boolean(activeWorkspaceId);

  const agents = useQuery({
    queryKey: ['agents', activeWorkspaceId, 'include-archived'],
    queryFn: () => agentsApi.list({ showArchived: true }),
    enabled,
  });
  const accounts = useQuery({ queryKey: ['accounts', activeWorkspaceId], queryFn: () => accountsApi.list(), enabled });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['agents', activeWorkspaceId] });
    queryClient.invalidateQueries({ queryKey: ['team', activeWorkspaceId] });
    queryClient.invalidateQueries({ queryKey: ['accounts', activeWorkspaceId] });
  };

  const create = useMutation({ mutationFn: (input: CreateAgentInput) => agentsApi.create(input), onSuccess: invalidate });
  const update = useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdateAgentInput }) => agentsApi.update(id, input),
    onSuccess: invalidate,
  });
  const archived = useMutation({
    mutationFn: async ({ agent, archived }: { agent: Agent; archived: boolean }) => {
      if (archived) await agentsApi.archive(agent.id);
      else await agentsApi.reactivate(agent.id);
    },
    onSuccess: invalidate,
  });

  return {
    agents: agents.data ?? [],
    accounts: accounts.data ?? [],
    isLoading: agents.isLoading,
    isError: agents.isError,
    createAgent: async (input) => create.mutateAsync(input),
    updateAgent: async (id, input) => { await update.mutateAsync({ id, input }); },
    setArchived: async (agent, next) => { await archived.mutateAsync({ agent, archived: next }); },
    setAssignedAccounts: async (agentId, currentIds, nextIds) => {
      const current = new Set(currentIds);
      const next = new Set(nextIds);
      await Promise.all([
        ...nextIds.filter((id) => !current.has(id)).map((accountId) => accountsApi.assignAgent(accountId, agentId)),
        ...currentIds.filter((id) => !next.has(id)).map((accountId) => accountsApi.unassignAgent(accountId, agentId)),
      ]);
      invalidate();
    },
  };
}
