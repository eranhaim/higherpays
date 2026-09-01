import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  authApi, notificationsApi, workspacesApi, categoriesApi, revenueApi, platformApi,
  type NotificationEvent, type UpdateWorkspaceInput,
} from '../../api/endpoints';
import { useAuthStore } from '../../store/auth';
import { useCurrentSession } from '../../hooks/useCurrentSession';

export function useGeneralSettings() {
  const { activeWorkspaceId } = useCurrentSession();
  const qc = useQueryClient();

  const workspace = useQuery({
    queryKey: ['workspace', activeWorkspaceId],
    queryFn: () => workspacesApi.get(),
    enabled: Boolean(activeWorkspaceId),
  });
  const linkLimits = useQuery({
    queryKey: ['link-limits', activeWorkspaceId],
    queryFn: () => workspacesApi.getLinkLimits(),
    enabled: Boolean(activeWorkspaceId),
  });
  const revenue = useQuery({
    queryKey: ['revenue-rule', activeWorkspaceId],
    queryFn: () => revenueApi.get(),
    enabled: Boolean(activeWorkspaceId),
  });

  const update = useMutation({
    mutationFn: (input: UpdateWorkspaceInput) => workspacesApi.update(input),
    onSuccess: (updated) => {
      // The sidebar and every page title read the name and labels from the
      // session, so it has to learn the change too.
      const auth = useAuthStore.getState();
      auth.setWorkspaces(auth.workspaces.map((w) => w.id === updated.id ? { ...w, name: updated.name, labels: updated.labels } : w));
      qc.invalidateQueries({ queryKey: ['workspace', activeWorkspaceId] });
    },
  });

  const saveLinkLimits = useMutation({
    mutationFn: (input: { minLinkAmount: number | null; maxLinkAmount: number | null }) => workspacesApi.setLinkLimits(input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['link-limits', activeWorkspaceId] }),
  });

  const saveRevenue = useMutation({
    mutationFn: (input: { accountSplitPct: number; agentPct: number }) => revenueApi.set(input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['revenue-rule', activeWorkspaceId] }),
  });

  return { workspace, linkLimits, revenue, update, saveLinkLimits, saveRevenue };
}

export interface FeeAmounts {
  fixedFee: number;
  refundFee: number;
  chargebackFee: number;
  declineFee: number;
}

/**
 * The fees HigherPays charges this agency. Only a platform admin may change
 * them, and both writes are versioned rows, so each one carries the values it
 * does not touch — sending zeros would silently drop the margin or the reserve.
 */
export function usePlatformFees() {
  const { user, activeWorkspaceId } = useCurrentSession();
  const qc = useQueryClient();
  const canEdit = Boolean(user?.isPlatformAdmin && activeWorkspaceId);

  const detail = useQuery({
    queryKey: ['platform-workspace', activeWorkspaceId],
    queryFn: () => platformApi.getWorkspace(activeWorkspaceId as string),
    enabled: canEdit,
  });

  const save = useMutation({
    mutationFn: async (input: FeeAmounts) => {
      const id = activeWorkspaceId as string;
      const rate = detail.data?.feeHistory[0];
      if (!rate) throw new Error('This agency has no rate card yet.');
      const settlement = detail.data?.settlementFee;

      if (input.fixedFee !== rate.pspFixedFee) {
        await platformApi.setPlatformFee(id, {
          pspRatePct: rate.pspRatePct, marginRatePct: rate.marginRatePct, pspFixedFee: input.fixedFee,
          checkoutFee: rate.checkoutFee,
        });
      }
      const reversalsChanged = !settlement
        || input.refundFee !== settlement.refundFee
        || input.chargebackFee !== settlement.chargebackFee
        || input.declineFee !== settlement.declineFee;
      if (reversalsChanged) {
        await platformApi.setSettlementFee(id, {
          settlementFeePct: settlement?.settlementFeePct ?? 0,
          settlementFeeFlat: settlement?.settlementFeeFlat ?? 0,
          reservePct: settlement?.reservePct ?? 0,
          reserveReleaseDays: settlement?.reserveReleaseDays ?? 0,
          refundFee: input.refundFee, chargebackFee: input.chargebackFee, declineFee: input.declineFee,
        });
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['platform-workspace', activeWorkspaceId] });
      qc.invalidateQueries({ queryKey: ['platform-fee', activeWorkspaceId] });
    },
  });

  return { canEdit, detail, save };
}

export function useTwoFactor() {
  const setTwoFactorEnabled = (enabled: boolean) => {
    const auth = useAuthStore.getState();
    if (auth.user) auth.setUser({ ...auth.user, twoFactorEnabled: enabled });
  };

  const enable = useMutation({ mutationFn: (code: string) => authApi.enableTwoFactor(code), onSuccess: () => setTwoFactorEnabled(true) });
  const disable = useMutation({ mutationFn: (code: string) => authApi.disableTwoFactor(code), onSuccess: () => setTwoFactorEnabled(false) });

  return { enable, disable };
}

export function useCategories() {
  const { activeWorkspaceId } = useCurrentSession();
  const qc = useQueryClient();

  const categories = useQuery({
    queryKey: ['categories', activeWorkspaceId, 'all'],
    queryFn: () => categoriesApi.list(true),
    enabled: Boolean(activeWorkspaceId),
  });
  const invalidate = () => qc.invalidateQueries({ queryKey: ['categories', activeWorkspaceId] });

  const create = useMutation({ mutationFn: (name: string) => categoriesApi.create(name), onSuccess: invalidate });
  const update = useMutation({
    mutationFn: ({ id, input }: { id: string; input: { name?: string; active?: boolean } }) => categoriesApi.update(id, input),
    onSuccess: invalidate,
  });

  return { categories, create, update };
}

export function useNotificationSettings() {
  const { activeWorkspaceId } = useCurrentSession();
  const qc = useQueryClient();

  const preferences = useQuery({
    queryKey: ['notification-preferences', activeWorkspaceId],
    queryFn: () => notificationsApi.getPreferences(),
    enabled: Boolean(activeWorkspaceId),
  });
  const channels = useQuery({
    queryKey: ['notification-channels', activeWorkspaceId],
    queryFn: () => notificationsApi.listChannels(),
    enabled: Boolean(activeWorkspaceId),
  });

  const invalidateChannels = () => qc.invalidateQueries({ queryKey: ['notification-channels', activeWorkspaceId] });

  const savePreferences = useMutation({
    mutationFn: (events: NotificationEvent[]) => notificationsApi.setPreferences(events),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['notification-preferences', activeWorkspaceId] }),
  });
  const createChannel = useMutation({
    mutationFn: (input: { target: string; label?: string; events: NotificationEvent[] }) => notificationsApi.createChannel(input),
    onSuccess: invalidateChannels,
  });
  const setChannelEvents = useMutation({
    mutationFn: (input: { id: string; events: NotificationEvent[] }) => notificationsApi.updateChannel(input.id, { events: input.events }),
    onSuccess: invalidateChannels,
  });
  const setChannelActive = useMutation({
    mutationFn: (input: { id: string; active: boolean }) => notificationsApi.updateChannel(input.id, { active: input.active }),
    onSuccess: invalidateChannels,
  });
  const deleteChannel = useMutation({ mutationFn: (id: string) => notificationsApi.deleteChannel(id), onSuccess: invalidateChannels });
  const testChannel = useMutation({
    mutationFn: (id: string) => notificationsApi.testChannel(id),
    // A failed test writes lastError on the channel, so the table must refresh either way.
    onSettled: invalidateChannels,
  });

  return { preferences, channels, savePreferences, createChannel, setChannelActive, setChannelEvents, deleteChannel, testChannel };
}

export function useAudit() {
  const { activeWorkspaceId } = useCurrentSession();
  const entries = useInfiniteQuery({
    queryKey: ['audit', activeWorkspaceId],
    queryFn: ({ pageParam }) => workspacesApi.listAudit(pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    enabled: Boolean(activeWorkspaceId),
  });
  return {
    entries: entries.data?.pages.flatMap((p) => p.items) ?? [],
    isLoading: entries.isLoading,
    isError: entries.isError,
    hasMore: entries.hasNextPage,
    isLoadingMore: entries.isFetchingNextPage,
    loadMore: () => { void entries.fetchNextPage(); },
  };
}
