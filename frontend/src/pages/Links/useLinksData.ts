import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useCurrentSession } from '../../hooks/useCurrentSession';
import {
  linksApi, creatorsApi, customersApi, workspacesApi,
  type PaymentLink, type Creator, type Customer, type LinkLimits, type CreatedLink,
} from '../../api/endpoints';

export interface CreateLinkFormInput {
  creatorId: string;
  customerId?: string;
  amount: number;
}

export interface ReconcileSummary {
  checked: number;
  updated: number;
}

export interface UseLinksDataResult {
  links: PaymentLink[];
  creators: Creator[];
  customers: Customer[];
  linkLimits: LinkLimits | null;
  isLoading: boolean;
  isError: boolean;
  createLink: (input: CreateLinkFormInput) => Promise<CreatedLink>;
  reconcile: () => Promise<ReconcileSummary>;
}

export function useLinksData(): UseLinksDataResult {
  const { activeWorkspaceId, currency } = useCurrentSession();
  const queryClient = useQueryClient();
  const enabled = Boolean(activeWorkspaceId);

  const links = useQuery({
    queryKey: ['links', activeWorkspaceId],
    queryFn: () => linksApi.list(),
    enabled,
  });
  const creators = useQuery({
    queryKey: ['creators', activeWorkspaceId],
    queryFn: () => creatorsApi.list(),
    enabled,
  });
  const customers = useQuery({
    queryKey: ['customers', activeWorkspaceId],
    queryFn: () => customersApi.list({ limit: 200 }),
    enabled,
  });
  const linkLimits = useQuery({
    queryKey: ['link-limits', activeWorkspaceId],
    queryFn: () => workspacesApi.getLinkLimits(),
    enabled,
    staleTime: 5 * 60_000,
  });

  const create = useMutation({
    mutationFn: (input: CreateLinkFormInput) =>
      linksApi.create({
        creatorId: input.creatorId,
        customerId: input.customerId,
        pricingMode: 'fixed',
        amount: input.amount,
        currency,
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['links', activeWorkspaceId] }),
  });

  const reconcile = useMutation({
    mutationFn: () => linksApi.reconcile(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['links', activeWorkspaceId] });
      queryClient.invalidateQueries({ queryKey: ['transactions', activeWorkspaceId] });
    },
  });

  return {
    links: links.data ?? [],
    creators: creators.data ?? [],
    customers: customers.data ?? [],
    linkLimits: linkLimits.data ?? null,
    isLoading: links.isLoading,
    isError: links.isError,
    createLink: (input) => create.mutateAsync(input),
    reconcile: async () => {
      const result = await reconcile.mutateAsync();
      return { checked: result.checked, updated: result.updated.length };
    },
  };
}
