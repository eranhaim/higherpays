'use strict';

// Minimal validation helpers — enough to keep handlers clean without a library.
const isStr = (v, max = 10000) => typeof v === 'string' && v.length > 0 && v.length <= max;
const isOptStr = (v, max = 10000) => v == null || (typeof v === 'string' && v.length <= max);

function badRequest(res, detail, fields) {
  return res.status(400).json({ error: 'validation_failed', detail, fields });
}

/**
 * The name of the `from`/`to` filter that is not a date, or null when the
 * range is usable. Either bound may be absent: a half-open range is a filter,
 * not an error.
 *
 * A list endpoint casts these to timestamptz, and Postgres raises on a value
 * it cannot read rather than returning NULL — so an unreadable bound has to be
 * caught here or it becomes a 500.
 */
function invalidDateFilter(query) {
  const isDate = (v) => v == null || v === '' || (typeof v === 'string' && !Number.isNaN(Date.parse(v)));
  if (!isDate(query.from)) return 'from';
  if (!isDate(query.to)) return 'to';
  return null;
}

// CSV builder (RFC-4180-ish; quotes fields containing comma/quote/newline).
function toCSV(headers, rows) {
  const esc = (v) => {
    v = v == null ? '' : String(v);
    return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
  };
  return [headers.map(esc).join(','), ...rows.map((r) => r.map(esc).join(','))].join('\r\n');
}

module.exports = { isStr, isOptStr, badRequest, invalidDateFilter, toCSV };
