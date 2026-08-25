import { useEffect } from 'react';
import { markDirty } from '../lib/unsavedChanges';

/**
 * Declares that this form is holding unsaved edits.
 *
 * Covers both ways out: `beforeunload` for a reload or tab close, and the
 * shared registry that the app shell checks before following a nav link.
 *
 * @param key unique per form, e.g. 'account-splits'
 */
export function useUnsavedChanges(key: string, isDirty: boolean): void {
  useEffect(() => {
    markDirty(key, isDirty);
    return () => markDirty(key, false);
  }, [key, isDirty]);

  useEffect(() => {
    if (!isDirty) return;
    // Browsers show their own wording here; preventDefault is all we control.
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [isDirty]);
}
