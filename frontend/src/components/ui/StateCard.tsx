/**
 * Full-width placeholders for a page section that is still loading or failed
 * to load. Tables get the same treatment from `DataTable`; use these for
 * card-based layouts so every page reads the same way.
 */

export function LoadingCard({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="card state-card" role="status">
      {label}
    </div>
  );
}

export function ErrorCard({ message = 'Could not load this section.' }: { message?: string }) {
  return (
    <div className="card state-card state-card-error" role="alert">
      {message}
    </div>
  );
}
