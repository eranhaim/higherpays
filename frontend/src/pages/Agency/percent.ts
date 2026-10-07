/**
 * NaN for anything that isn't a usable percentage, so callers can flag the
 * field instead of sending a nonsense share or commission to the server.
 */
export function parsePct(text: string): number {
  const value = parseFloat(text);
  return Number.isFinite(value) && value >= 0 && value <= 100 ? value : Number.NaN;
}
