interface RowViewButtonProps {
  onClick: () => void;
  /** Announced to screen readers; the icon carries no text. */
  label?: string;
}

/**
 * Explicit per-row control that opens a row's detail modal. It is a real
 * <button>, so the DataTable row/card click guards (which ignore clicks on
 * button/a/input/select/label) skip it and it never double-opens the modal.
 */
export function RowViewButton({ onClick, label = 'View details' }: RowViewButtonProps) {
  return (
    <button type="button" className="row-view" aria-label={label} onClick={onClick}>
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path
          d="M1.5 12S5 5 12 5s10.5 7 10.5 7-3.5 7-10.5 7S1.5 12 1.5 12Z"
          fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
        />
        <circle cx="12" cy="12" r="3.2" fill="none" stroke="currentColor" strokeWidth="2" />
      </svg>
    </button>
  );
}
