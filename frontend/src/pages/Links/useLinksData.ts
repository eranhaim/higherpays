import { useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAppStore } from '../../store/appStore';
import { useCurrentSession } from '../../hooks/useCurrentSession';
import { linksApi, type PaymentLink as ApiLink, type LinkStatus as ApiStatus } from '../../api/endpoints';
import type { PaymentLink, LinkStatus } from '../../types';

const API_TO_UI_STATUS: Record<ApiStatus, LinkStatus> = {
  created: 'Created',
  opened: 'Created',
  paid: 'Paid',
  failed: 'Failed',
  expired: 'Expired',
  refunded: 'Failed',
};

function apiToLegacyLink(l: ApiLink): PaymentLink {
  return {
    id: l.id,
    creator: l.creator ?? '',
    chatter: l.chatter ?? '',
    customerName: l.customer ?? '',
    customerUsername: '',
    amount: l.amount ?? 0,
    unit: l.currency ?? 'EUR',
    status: API_TO_UI_STATUS[l.status] ?? 'Created',
    ts: Date.parse(l.createdAt),
    checkoutUrl: l.checkoutUrl,
  };
}

export interface CreateLinkFormInput {
  creator: string;
  chatter: string;
  customerName: string;
  customerUsername: string;
  amount: number;
  creatorId?: string;
  customerId?: string;
}

export interface UseLinksDataResult {
  links: PaymentLink[];
  isLoading: boolean;
  isError: boolean;
  create: (input: CreateLinkFormInput) => Promise<{ url?: string }>;
  reconcile: () => Promise<void>;
}

export function useLinksData(): UseLinksDataResult {
  const { isDemo, activeWorkspaceId, currency } = useCurrentSession();
  const demoLinks = useAppStore((s) => s.links);
  const updateDemo = useAppStore((s) => s.updateState);
  const qc = useQueryClient();

  const query = useQuery({
    queryKey: ['links', activeWorkspaceId],
    queryFn: () => linksApi.list(),
    enabled: !isDemo && Boolean(activeWorkspaceId),
  });

  const createMutation = useMutation({
    mutationFn: async (input: CreateLinkFormInput) => {
      if (!input.creatorId) {
        throw new Error('creatorId is required in live mode');
      }
      return linksApi.create({
        creatorId: input.creatorId,
        customerId: input.customerId,
        pricingMode: 'fixed',
        amount: input.amount,
        currency,
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['links', activeWorkspaceId] });
    },
  });

  const reconcileMutation = useMutation({
    mutationFn: () => linksApi.reconcile(),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['links', activeWorkspaceId] });
    },
  });

  const liveLinks = useMemo(
    () => (query.data ?? []).map(apiToLegacyLink),
    [query.data],
  );

  return {
    links: isDemo ? demoLinks : liveLinks,
    isLoading: !isDemo && query.isLoading,
    isError: !isDemo && query.isError,
    reconcile: async () => {
      if (isDemo) return;
      await reconcileMutation.mutateAsync();
    },
    create: async (input) => {
      if (isDemo) {
        let user = input.customerUsername.trim();
        if (user && !user.startsWith('@')) user = `@${user}`;
        const newLink: PaymentLink = {
          id: `pl${demoLinks.length + 1}`,
          creator: input.creator,
          chatter: input.chatter,
          customerName: input.customerName.trim(),
          customerUsername: user,
          amount: input.amount,
          unit: 'EUR',
          status: 'Created',
          ts: Date.now(),
        };
        updateDemo({ links: [newLink, ...demoLinks] });
        return {};
      }
      const created = await createMutation.mutateAsync(input);
      return { url: created.url };
    },
  };
}
