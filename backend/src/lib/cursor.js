'use strict';
// Keyset pagination helpers. A cursor is the (timestamp, id) pair of the last
// row returned, opaque to the client. Keyset rather than offset because a
// live payments feed gains rows between requests and offsets would drift.

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

function parseLimit(raw) {
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_LIMIT;
  return Math.min(n, MAX_LIMIT);
}

function encodeCursor(ts, id) {
  return Buffer.from(`${new Date(ts).toISOString()}|${id}`).toString('base64url');
}

/** Returns { ts, id } or null when the cursor is missing or malformed. */
function decodeCursor(raw) {
  if (!raw) return null;
  const [ts, id] = Buffer.from(String(raw), 'base64url').toString().split('|');
  if (!ts || !id || Number.isNaN(Date.parse(ts))) return null;
  return { ts, id };
}

/**
 * Trims a page fetched with limit+1 rows and computes the next cursor.
 * `tsOf`/`idOf` read the ordering columns from a row.
 */
function page(rows, limit, tsOf, idOf) {
  const items = rows.slice(0, limit);
  const last = items[items.length - 1];
  const nextCursor = rows.length > limit && last ? encodeCursor(tsOf(last), idOf(last)) : null;
  return { items, nextCursor };
}

module.exports = { parseLimit, encodeCursor, decodeCursor, page };
