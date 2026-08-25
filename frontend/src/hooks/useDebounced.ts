import { useEffect, useState } from 'react';

/**
 * Trails `value` by `delay` ms. Use it for text that drives a request — a
 * search box filtering server-side should not fire a query per keystroke.
 */
export function useDebounced<T>(value: T, delay = 300): T {
  const [settled, setSettled] = useState(value);

  useEffect(() => {
    const id = setTimeout(() => setSettled(value), delay);
    return () => clearTimeout(id);
  }, [value, delay]);

  return settled;
}
