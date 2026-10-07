/**
 * Full-width placeholders for a page section that is still loading or failed
 * to load. Tables get the same treatment from `DataTable`; use these for
 * card-based layouts so every page reads the same way.
 */

export function LoadingCard({ label = 'Loading…', lines = 4 }: { label?: string; lines?: number }) {
  return (
    // aria-busy rather than the label as text: a screen reader announces the
    // region as busy and re-reads it when the real content replaces it.
    <div className="card skeleton-lines" role="status" aria-busy="true" aria-label={label}>
      {Array.from({ length: lines }, (_, i) => <span className="skeleton" key={i} />)}
    </div>
  );
}

/**
 * A read that failed. One shape for all of them: what could not be loaded,
 * then what to do about it — callers supply only the first half, so the
 * instruction cannot drift from page to page. A write that failed is a toast;
 * a partial failure that leaves the page usable is a `.warnbar`.
 */
export function ErrorCard({ message = "Couldn't load this section." }: { message?: string }) {
  return (
    <div className="card state-card state-card-error" role="alert">
      <div>{message}</div>
      <p className="empty-hint">Reload the page to try again.</p>
    </div>
  );
}
