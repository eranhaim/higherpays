/**
 * Which currency the money on screen is in.
 *
 * HigherPays never converts and never sums across currencies, so every totals
 * page is about exactly one currency. This hook is the one place that decides
 * which: the user's choice for this workspace, or its base currency.
 *
 * Pass `currency` into the query key and the request so switching currency
 * refetches from the server instead of re-filtering rows already loaded.
 */

import { useQuery } from '@tanstack/react-query';
import { workspacesApi, type WorkspaceCurrency } from '../api/endpoints';
import { useCurrentSession } from './useCurrentSession';
import { useSessionStore } from '../store/session';

export interface ReportingCurrency {
  /** The resolved currency. Always a code, even while the list is loading. */
  currency: string;
  setCurrency: (currency: string) => void;
  /** Every currency this agency may use, base first. */
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
    queryFn: () => workspacesApi.getCurrencies(),
    enabled: Boolean(activeWorkspaceId),
    staleTime: 60_000,
  });
  const currencies = list.data?.currencies ?? [];

  // A stale choice (a currency since removed) falls back to the base one.
  const isAllowed = currencies.length === 0 || currencies.some((c) => c.currency === chosen);
  const currency = chosen && isAllowed ? chosen : baseCurrency;

  return {
    currency,
    setCurrency: (next) => { if (activeWorkspaceId) setReportingCurrency(activeWorkspaceId, next); },
    currencies,
    hasChoice: currencies.length > 1,
  };
}
