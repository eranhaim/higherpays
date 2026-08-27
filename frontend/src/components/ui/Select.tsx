import { useId, type ReactNode, type SelectHTMLAttributes } from 'react';

interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'onChange'> {
  /** Names the control. Visible in a form; screen-reader only in a filter bar. */
  label: string;
  hideLabel?: boolean;
  onChange: (value: string) => void;
  /** Hint under the control, forms only. */
  hint?: ReactNode;
  children: ReactNode;
}

/**
 * The one dropdown. A filter bar hides the label (the first option names the
 * filter: "All statuses"); a form shows it above the control like every other
 * field. Either way the control is named for assistive technology.
 */
export function Select({ label, hideLabel, onChange, hint, children, id, ...rest }: SelectProps) {
  const generated = useId();
  const selectId = id ?? generated;
  const control = (
    <select id={selectId} aria-label={hideLabel ? label : undefined} onChange={(e) => onChange(e.target.value)} {...rest}>
      {children}
    </select>
  );
  if (hideLabel) return control;
  return (
    <div className="field">
      <label htmlFor={selectId}>{label}</label>
      {control}
      {hint ? <p className="sub">{hint}</p> : null}
    </div>
  );
}
