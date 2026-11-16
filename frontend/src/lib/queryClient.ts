import { QueryClient } from '@tanstack/react-query';
import { HttpError } from '../api/http';

/**
 * Single shared React Query client.
 *
 * - Never retry 4xx: user error, no point pounding the server.
 * - 30 s default stale time — most CRUD lists don't need to refetch on every
 *   mount, and we invalidate explicitly on mutation.
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: false,
      retry: (failureCount, error) => {
        if (error instanceof HttpError && error.status >= 400 && error.status < 500) {
          return false;
        }
        return failureCount < 2;
      },
    },
    mutations: {
      retry: false,
    },
  },
});

/**
 * Every query whose figures come from payments and the ledger. A mutation
 * that records, completes, reverses, archives or restores money refreshes all
 * of them, so no card on another page keeps a stale total.
 */
const LEDGER_QUERY_KEYS = [
  'payments', 'payments-summary', 'payment-filter-options',
  'links', 'links-summary', 'link',
  'customers', 'payouts-breakdown', 'provider-reserve', 'agency-rolling-reserve', 'analytics',
];

export function invalidateLedgerQueries(client: QueryClient, workspaceId: string | null) {
  for (const key of LEDGER_QUERY_KEYS) {
    client.invalidateQueries({ queryKey: [key, workspaceId] });
  }
}
