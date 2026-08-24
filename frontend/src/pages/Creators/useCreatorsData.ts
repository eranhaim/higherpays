import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useCurrentSession } from '../../hooks/useCurrentSession';
import {
  creatorsApi, membershipsApi,
  type Creator, type Chatter, type CreateCreatorInput, type UpdateCreatorInput,
} from '../../api/endpoints';

export interface UseCreatorsDataResult {
  creators: Creator[];
  chatters: Chatter[];
  isLoading: boolean;
  isError: boolean;
  createCreator: (input: CreateCreatorInput, chatterMembershipIds: string[]) => Promise<void>;
  updateCreator: (id: string, input: UpdateCreatorInput) => Promise<void>;
}

export function useCreatorsData(): UseCreatorsDataResult {
  const { activeWorkspaceId } = useCurrentSession();
  const queryClient = useQueryClient();
  const enabled = Boolean(activeWorkspaceId);

  const creators = useQuery({
    queryKey: ['creators', activeWorkspaceId],
    queryFn: () => creatorsApi.list(),
    enabled,
  });
  const chatters = useQuery({
    queryKey: ['team-chatters', activeWorkspaceId],
    queryFn: () => membershipsApi.listChatters(),
    enabled,
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['creators', activeWorkspaceId] });

  const create = useMutation({
    mutationFn: async ({ input, chatterMembershipIds }: { input: CreateCreatorInput; chatterMembershipIds: string[] }) => {
      const created = await creatorsApi.create(input);
      for (const membershipId of chatterMembershipIds) {
        await creatorsApi.assignChatter(created.id, membershipId);
      }
    },
    onSuccess: invalidate,
  });

  const update = useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdateCreatorInput }) => creatorsApi.update(id, input),
    onSuccess: invalidate,
  });

  return {
    creators: creators.data ?? [],
    chatters: chatters.data ?? [],
    isLoading: creators.isLoading,
    isError: creators.isError,
    createCreator: async (input, chatterMembershipIds) => {
      await create.mutateAsync({ input, chatterMembershipIds });
    },
    updateCreator: async (id, input) => {
      await update.mutateAsync({ id, input });
    },
  };
}
