import type { ReactNode } from 'react';

interface PageHeaderProps {
  title: string;
  subtitle?: string;
  /**
   * Uppercase micro-label above the display title. Use it to encode where
   * the reader is in the app ("MONEY IN", "PEOPLE") — a structural device,
   * not decoration.
   */
  eyebrow?: string;
  actions?: ReactNode;
}

export function PageHeader({ title, subtitle, eyebrow, actions }: PageHeaderProps) {
  return (
    <div className="pagehead">
      <div>
        {eyebrow ? <div className="eyebrow">{eyebrow}</div> : null}
        <h2>{title}</h2>
        {subtitle ? <p>{subtitle}</p> : null}
      </div>
      {actions ? <div className="pagehead-actions">{actions}</div> : null}
    </div>
  );
}
