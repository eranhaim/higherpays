import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useCurrentSession } from '../../hooks/useCurrentSession';
import {
  agentsApi, accountsApi, teamApi,
  type Account, type Agent, type CreateAgentInput, type UpdateAgentInput, type MemberStatus,
} from '../../api/endpoints';

export interface UseAgentsDataResult {
  agents: Agent[];
  accounts: Account[];
  isLoading: boolean;
  isError: boolean;
  createAgent: (input: CreateAgentInput) => Promise<Agent>;
  updateAgent: (id: string, input: UpdateAgentInput) => Promise<void>;
  setStatus: (agent: Agent, status: MemberStatus) => Promise<void>;
  setAssignedAccounts: (agentId: string, currentIds: string[], nextIds: string[]) => Promise<void>;
}

export function useAgentsData(): UseAgentsDataResult {
  const { activeWorkspaceId } = useCurrentSession();
  const queryClient = useQueryClient();
  const enabled = Boolean(activeWorkspaceId);

  const agents = useQuery({ queryKey: ['agents', activeWorkspaceId], queryFn: () => agentsApi.list(), enabled });
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
  // Suspending is an access change, so it goes through the team endpoint.
  const status = useMutation({
    mutationFn: ({ agent, status }: { agent: Agent; status: MemberStatus }) => teamApi.setStatus(agent.userId, status),
    onSuccess: invalidate,
  });

  return {
    agents: agents.data ?? [],
    accounts: accounts.data ?? [],
    isLoading: agents.isLoading,
    isError: agents.isError,
    createAgent: async (input) => create.mutateAsync(input),
    updateAgent: async (id, input) => { await update.mutateAsync({ id, input }); },
    setStatus: async (agent, next) => { await status.mutateAsync({ agent, status: next }); },
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
