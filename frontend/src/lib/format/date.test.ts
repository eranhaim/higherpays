import { describe, it, expect } from 'vitest';
import { startOfLocalDay, endOfLocalDay, toInstantRange } from './date';

describe('toInstantRange', () => {
  it('covers the whole of the last day', () => {
    // Sending the bare `to` date instead made the API compare against midnight,
    // so everything taken during the final day went missing from the totals.
    const { to } = toInstantRange({ from: '2026-10-01', to: '2026-10-06' });
    expect(to).toBe(new Date(2026, 9, 6, 23, 59, 59, 999).toISOString());
  });

  it('starts at the first instant of the first day', () => {
    const { from } = toInstantRange({ from: '2026-10-01', to: '2026-10-06' });
    expect(from).toBe(new Date(2026, 9, 1).toISOString());
  });

  it('leaves an open bound open', () => {
    expect(toInstantRange({ from: '', to: '' })).toEqual({ from: undefined, to: undefined });
    expect(toInstantRange({ from: '2026-10-01' }).to).toBe(undefined);
  });

  it('spans a full day', () => {
    const start = startOfLocalDay('2026-10-06');
    const end = endOfLocalDay('2026-10-06');
    expect(end! - start!).toBe(86_399_999);
  });

  it('rejects anything that is not a date', () => {
    expect(startOfLocalDay('not-a-date')).toBe(null);
    expect(endOfLocalDay('')).toBe(null);
  });
});
