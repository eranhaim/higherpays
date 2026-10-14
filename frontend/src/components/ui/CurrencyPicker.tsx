import { Select } from './Select';
import { useReportingCurrency } from '../../hooks/useReportingCurrency';

/**
 * Picks the currency a money page reports in.
 *
 * Renders nothing for a single-currency agency: there is no choice to make,
 * and an operator should not have to confirm the only answer. There is no
 * "all currencies" option — a figure covering several currencies would be
 * true in none of them.
 */
export function CurrencyPicker() {
  const { currency, setCurrency, currencies, hasChoice } = useReportingCurrency();
  if (!hasChoice) return null;
  return (
    <Select label="Currency" hideLabel value={currency} onChange={setCurrency}>
      {currencies.map((c) => (
        <option key={c.currency} value={c.currency}>
          {c.currency}{c.isBase ? ' (base)' : ''}
        </option>
      ))}
    </Select>
  );
}
