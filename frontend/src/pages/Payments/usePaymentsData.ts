/**
 * Data hook for the Payments page.
 *
 * Emits a single `Transaction[]`-shaped list regardless of whether we're in
 * offline demo mode (reading from `appStore`) or live (React Query against
 * `payoutsApi.listTransactions`). The page component doesn't care which.
 */

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAppStore } from '../../store/appStore';
import { useCurrentSession } from '../../hooks/useCurrentSession';
import { scopeTx } from '../../rbac/permissions';
import { payoutsApi, type Transaction as ApiTransaction } from '../../api/endpoints';
import type { Transaction } from '../../types';

function apiToLegacyTx(t: ApiTransaction): Transaction {
  return {
    id: t.id,
    referenceId: t.providerTransactionId ?? t.id,
    providerTxId: t.providerTransactionId ?? undefined,
    clientName: t.customer ?? '',
    username: '',
    creator: t.creator ?? '',
    chatter: t.chatter ?? '',
    amount: t.gross,
    currency: 'EUR',
    status: t.status,
    notes: '',
    ts: Date.parse(t.occurredAt),
  };
}

export interface UsePaymentsDataResult {
  transactions: Transaction[];
  isLoading: boolean;
  isError: boolean;
}

export function usePaymentsData(): UsePaymentsDataResult {
  const { isDemo, activeWorkspaceId } = useCurrentSession();
  const demoTx = useAppStore((s) => s.transactions);
  const role = useAppStore((s) => s.role);
  const identity = useAppStore((s) => s.identity);

  const query = useQuery({
    queryKey: ['transactions', activeWorkspaceId],
    queryFn: () => payoutsApi.listTransactions(),
    enabled: !isDemo && Boolean(activeWorkspaceId),
  });

  const scopedDemo = useMemo(
    () => scopeTx(demoTx, role, identity),
    [demoTx, role, identity],
  );

  if (isDemo) {
    return { transactions: scopedDemo, isLoading: false, isError: false };
  }
  return {
    transactions: (query.data ?? []).map(apiToLegacyTx),
    isLoading: query.isLoading,
    isError: query.isError,
  };
}
