import { formatMoney } from '../../lib/format';
import { useCurrentSession } from '../../hooks/useCurrentSession';

interface MoneyProps {
  amount: number;
  currency?: string;
  /**
   * Signals direction so the number picks up its colour cue without the
   * page having to hand-wire a class. 'in' is mint (revenue, approved),
   * 'out' is red (refund, declined, cost). Left unset, the number stays
   * plain text.
   */
  direction?: 'in' | 'out';
  /** Bold the number, e.g. on totals rows. */
  emphasis?: boolean;
}

/**
 * Renders a money value with tabular numerals and its direction colour.
 * Every money number in the UI should come through here so figures line up
 * in a column and money in never looks like money out.
 */
export function Money({ amount, currency, direction, emphasis }: MoneyProps) {
  const session = useCurrentSession();
  const c = currency ?? session.currency;
  const text = formatMoney(amount, c);
  const cls = [
    'amt',
    direction === 'in' ? 'up' : direction === 'out' ? 'down' : '',
    emphasis ? 'strong' : '',
  ].filter(Boolean).join(' ');
  return <span className={cls}>{text}</span>;
}
