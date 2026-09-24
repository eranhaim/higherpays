import type { ReactNode } from 'react';

type Tone = 'ok' | 'no' | 'warn' | 'info' | 'muted';

interface PillProps {
  tone?: Tone;
  children: ReactNode;
}

/** Small status chip. Reuses the existing `.pill` styles from `global.css`. */
export function Pill({ tone = 'muted', children }: PillProps) {
  const className = tone === 'muted' ? 'pill' : `pill ${tone}`;
  return <span className={className}>{children}</span>;
}
