'use strict';
// Keyset pagination helpers. A cursor is the (sort value, id) pair of the last
// row returned, opaque to the client. Keyset rather than offset because a live
// payments feed gains rows between requests and offsets would drift.
//
// The sort value is whatever column the list is ordered by — a timestamp for
// the default feeds, an amount or a status when the caller sorts by one — so
// it travels as text and the query casts it back.

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

function parseLimit(raw) {
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_LIMIT;
  return Math.min(n, MAX_LIMIT);
}

function encodeCursor(value, id) {
  const text = value instanceof Date ? value.toISOString() : String(value);
  return Buffer.from(`${text}|${id}`).toString('base64url');
}

/** Returns { value, id } or null when the cursor is missing or malformed. */
function decodeCursor(raw) {
  if (!raw) return null;
  const text = Buffer.from(String(raw), 'base64url').toString();
  // The id is the last field: a sort value may itself contain the separator.
  const at = text.lastIndexOf('|');
  if (at <= 0) return null;
  const value = text.slice(0, at);
  const id = text.slice(at + 1);
  return id ? { value, id } : null;
}

/**
 * Trims a page fetched with limit+1 rows and computes the next cursor.
 * `keyOf`/`idOf` read the ordering columns from a row.
 */
function page(rows, limit, keyOf, idOf) {
  const items = rows.slice(0, limit);
  const last = items[items.length - 1];
  const nextCursor = rows.length > limit && last ? encodeCursor(keyOf(last), idOf(last)) : null;
  return { items, nextCursor };
}

module.exports = { parseLimit, encodeCursor, decodeCursor, page };
