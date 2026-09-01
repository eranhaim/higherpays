import { usePreferencesStore, type ViewLayout } from '../store/preferences';

export interface ViewItem {
  key: string;
  label: string;
}

export interface ViewLayoutState {
  /** Every key, in the order the user put them. */
  order: string[];
  hidden: string[];
  /** The shown keys, in order. What a page renders. */
  visibleKeys: string[];
  items: ViewItem[];
  setLayout: (layout: ViewLayout) => void;
  reset: () => void;
}

/**
 * Remembers which of a page's columns or stat cards the user shows, and in
 * what order. The choice lives in the browser (persisted preferences), so it
 * is per browser rather than per login.
 */
export function useViewLayout(viewKey: string, items: ViewItem[], hiddenByDefault: string[] = []): ViewLayoutState {
  const stored = usePreferencesStore((s) => s.views[viewKey]);
  const setView = usePreferencesStore((s) => s.setView);
  const resetView = usePreferencesStore((s) => s.resetView);

  const keys = items.map((i) => i.key);
  const order = stored
    ? [...stored.order.filter((k) => keys.includes(k)), ...keys.filter((k) => !stored.order.includes(k))]
    : keys;
  const hidden = (stored ? stored.hidden : hiddenByDefault).filter((k) => keys.includes(k));

  return {
    order,
    hidden,
    visibleKeys: order.filter((k) => !hidden.includes(k)),
    items,
    setLayout: (layout) => setView(viewKey, layout),
    reset: () => resetView(viewKey),
  };
}

/** Picks the entries a view layout shows, in the layout's order. */
export function orderBy<T extends { key: string }>(entries: T[], keys: string[]): T[] {
  return keys.map((k) => entries.find((e) => e.key === k)).filter((e): e is T => e !== undefined);
}
