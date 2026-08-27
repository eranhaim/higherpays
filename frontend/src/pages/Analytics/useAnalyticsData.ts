/**
 * Data hook for the Analytics page.
 *
 * Loads the report for the selected range plus the report for the period of
 * equal length just before it, so the page can show "vs previous" deltas.
 * Account and agent lists feed the scope filters and are only fetched for
 * roles that may scope the report.
 */

import { useQuery } from '@tanstack/react-query';
import { useCurrentSession } from '../../hooks/useCurrentSession';
import { analyticsApi, accountsApi, agentsApi } from '../../api/endpoints';
import { DAY_MS } from '../../lib/format';

export interface AnalyticsFilters {
  /** Date-input values, `YYYY-MM-DD` in local time. */
  from: string;
  to: string;
  accountId: string;
  agentId: string;
}

export interface DateWindow {
  fromMs: number;
  toMs: number;
  days: number;
}

/** `YYYY-MM-DD` for a timestamp in local time, matching what `<input type="date">` holds. */
export function toLocalDateInput(ts: number): string {
  const d = new Date(ts);
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${mo}-${day}`;
}

export function defaultFilters(): AnalyticsFilters {
  const now = Date.now();
  return { from: toLocalDateInput(now - 30 * DAY_MS), to: toLocalDateInput(now), accountId: '', agentId: '' };
}

function parseLocalDate(input: string, endOfDay: boolean): number | null {
  const [y, m, d] = input.split('-').map(Number);
  if (!y || !m || !d) return null;
  const date = endOfDay ? new Date(y, m - 1, d, 23, 59, 59, 999) : new Date(y, m - 1, d);
  return date.getTime();
}

/**
 * Start of the `from` day to end of the `to` day, local time.
 *
 * The shared picker can be cleared to "all time", but this page always compares
 * a bounded window against the one before it — so an open bound falls back to
 * the last 30 days rather than leaving the page with nothing to draw.
 * Null only when the two bounds are the wrong way round.
 */
export function toDateWindow(filters: AnalyticsFilters): DateWindow | null {
  const to = filters.to || toLocalDateInput(Date.now());
  const from = filters.from || toLocalDateInput((parseLocalDate(to, false) ?? Date.now()) - 29 * DAY_MS);
  const fromMs = parseLocalDate(from, false);
  const toMs = parseLocalDate(to, true);
  if (fromMs === null || toMs === null || toMs < fromMs) return null;
  return { fromMs, toMs, days: Math.round((toMs - fromMs) / DAY_MS) };
}

export function useAnalyticsData(filters: AnalyticsFilters, canScope: boolean) {
  const { activeWorkspaceId } = useCurrentSession();
  const dateWindow = toDateWindow(filters);
  const enabled = Boolean(activeWorkspaceId) && dateWindow !== null;

  const scope = { accountId: filters.accountId || undefined, agentId: filters.agentId || undefined };

  const currentRange = dateWindow
    ? { from: new Date(dateWindow.fromMs).toISOString(), to: new Date(dateWindow.toMs).toISOString() }
    : null;

  // Same length as the selected range, ending the moment the selected range starts.
  const previousRange = dateWindow
    ? { from: new Date(dateWindow.fromMs - (dateWindow.toMs - dateWindow.fromMs)).toISOString(), to: new Date(dateWindow.fromMs).toISOString() }
    : null;

  const report = useQuery({
    queryKey: ['analytics', activeWorkspaceId, currentRange, scope],
    queryFn: () => analyticsApi.report({ ...currentRange!, ...scope }),
    enabled,
  });
  const previous = useQuery({
    queryKey: ['analytics', activeWorkspaceId, previousRange, scope],
    queryFn: () => analyticsApi.report({ ...previousRange!, ...scope }),
    enabled,
  });
  const accounts = useQuery({
    queryKey: ['accounts', activeWorkspaceId],
    queryFn: () => accountsApi.list(),
    enabled: canScope && Boolean(activeWorkspaceId),
  });
  const agents = useQuery({
    queryKey: ['agents', activeWorkspaceId],
    queryFn: () => agentsApi.list(),
    enabled: canScope && Boolean(activeWorkspaceId),
  });

  return {
    dateWindow,
    report: report.data,
    previous: previous.data,
    isLoading: report.isLoading,
    isError: report.isError,
    accounts: accounts.data ?? [],
    agents: agents.data ?? [],
  };
}
