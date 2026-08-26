import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useCurrentSession } from '../../hooks/useCurrentSession';
import { agentsApi, teamApi, type Agent, type CreateAgentInput, type UpdateAgentInput, type MemberStatus } from '../../api/endpoints';

export interface UseAgentsDataResult {
  agents: Agent[];
  isLoading: boolean;
  isError: boolean;
  createAgent: (input: CreateAgentInput) => Promise<void>;
  updateAgent: (id: string, input: UpdateAgentInput) => Promise<void>;
  setStatus: (agent: Agent, status: MemberStatus) => Promise<void>;
}

export function useAgentsData(): UseAgentsDataResult {
  const { activeWorkspaceId } = useCurrentSession();
  const queryClient = useQueryClient();
  const enabled = Boolean(activeWorkspaceId);

  const agents = useQuery({ queryKey: ['agents', activeWorkspaceId], queryFn: () => agentsApi.list(), enabled });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['agents', activeWorkspaceId] });
    queryClient.invalidateQueries({ queryKey: ['team', activeWorkspaceId] });
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
    isLoading: agents.isLoading,
    isError: agents.isError,
    createAgent: async (input) => { await create.mutateAsync(input); },
    updateAgent: async (id, input) => { await update.mutateAsync({ id, input }); },
    setStatus: async (agent, next) => { await status.mutateAsync({ agent, status: next }); },
  };
}
