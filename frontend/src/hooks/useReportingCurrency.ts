/**
 * Which currency the money on screen is in.
 *
 * HigherPays never converts and never sums across currencies, so every money
 * page is about exactly one currency. This hook is the one place that decides
 * which: the operator's choice for this workspace, or its base currency.
 *
 * Pass `currency` into the query filters so it is part of the React Query key
 * — switching currency must refetch from the server, not re-filter rows that
 * are already loaded.
 */

import { useQuery } from '@tanstack/react-query';
import { workspacesApi, type WorkspaceCurrency } from '../api/endpoints';
import { useCurrentSession } from './useCurrentSession';
import { useSessionStore } from '../store/session';

export interface ReportingCurrency {
  /** The resolved currency. Always a code, even while the list is loading. */
  currency: string;
  setCurrency: (currency: string) => void;
  /** Every currency this agency may transact in, base first. */
  currencies: WorkspaceCurrency[];
  /** True once the agency has more than one, i.e. there is a choice to offer. */
  hasChoice: boolean;
}

export function useReportingCurrency(): ReportingCurrency {
  const { activeWorkspaceId, currency: baseCurrency } = useCurrentSession();
  const chosen = useSessionStore((s) => (activeWorkspaceId ? s.reportingCurrency[activeWorkspaceId] : undefined));
  const setReportingCurrency = useSessionStore((s) => s.setReportingCurrency);

  const list = useQuery({
    queryKey: ['workspace-currencies', activeWorkspaceId],
    queryFn: () => workspacesApi.listCurrencies(),
    enabled: Boolean(activeWorkspaceId),
    staleTime: 5 * 60_000,
  });
  const currencies = list.data ?? [];

  // A stale choice (a currency the agency was withdrawn from) falls back to
  // the base one rather than asking the server for an empty report.
  const enabled = currencies.length === 0 || currencies.some((c) => c.currency === chosen);
  const currency = chosen && enabled ? chosen : baseCurrency;

  return {
    currency,
    setCurrency: (next) => { if (activeWorkspaceId) setReportingCurrency(activeWorkspaceId, next); },
    currencies,
    hasChoice: currencies.length > 1,
  };
}
