import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { workspacesApi, type MyWorkspace } from '../../api/endpoints';
import { useCurrentSession } from '../../hooks/useCurrentSession';

export interface UseWorkspacesDataResult {
  workspaces: MyWorkspace[];
  isLoading: boolean;
  isError: boolean;
  createWorkspace: (name: string, currency: string) => Promise<void>;
}

export function useWorkspacesData(): UseWorkspacesDataResult {
  const { activeWorkspaceId } = useCurrentSession();
  const queryClient = useQueryClient();

  // Not keyed on the active workspace: this list is about the user, not the
  // workspace they happen to be looking at.
  const workspaces = useQuery({
    queryKey: ['my-workspaces'],
    queryFn: () => workspacesApi.listMine(),
  });

  const create = useMutation({
    mutationFn: ({ name, currency }: { name: string; currency: string }) =>
      workspacesApi.create({ name, currency }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['my-workspaces'] }),
  });

  return {
    workspaces: workspaces.data ?? [],
    isLoading: workspaces.isLoading,
    isError: workspaces.isError,
    createWorkspace: async (name, currency) => {
      // The new workspace belongs to the active one's organization, so a
      // workspace must be active before this can be called.
      if (!activeWorkspaceId) throw new Error('No active workspace.');
      await create.mutateAsync({ name, currency });
    },
  };
}
