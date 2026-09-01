/**
 * User preferences — things that survive login/logout and travel with the browser.
 *
 * Kept separate from `authStore` so signing out doesn't reset the user's
 * timezone or density choices.
 */

import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

export type TzMode = 'auto' | 'manual';

/**
 * Which columns or stat cards a page shows, and in what order. Keyed by a view
 * name such as `payments.columns`. Keys the page no longer offers are ignored
 * on read, and keys added later show up at the end.
 */
export interface ViewLayout {
  order: string[];
  hidden: string[];
}

interface PreferencesState {
  tzMode: TzMode;
  tzManual: string | null;
  views: Record<string, ViewLayout>;

  setTz: (mode: TzMode, manual?: string | null) => void;
  setView: (viewKey: string, layout: ViewLayout) => void;
  resetView: (viewKey: string) => void;
}

export const usePreferencesStore = create<PreferencesState>()(
  persist(
    (set) => ({
      tzMode: 'auto',
      tzManual: null,
      views: {},

      setTz: (mode, manual) => set({ tzMode: mode, tzManual: manual ?? null }),
      setView: (viewKey, layout) => set((s) => ({ views: { ...s.views, [viewKey]: layout } })),
      resetView: (viewKey) => set((s) => {
        const views = { ...s.views };
        delete views[viewKey];
        return { views };
      }),
    }),
    {
      name: 'higherpays.preferences',
      storage: createJSONStorage(() => localStorage),
    },
  ),
);
