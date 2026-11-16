'use strict';
const { BadRequestError } = require('./errors');

const DAY_MS = 86_400_000;

function toDate(value, field) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new BadRequestError(`${field} must be a date`, { fields: [field] });
  return date;
}

// The period a report covers, as ISO instants. Without bounds it is the last
// 30 days up to now.
function reportRange({ from, to } = {}) {
  const end = to ? toDate(to, 'to') : new Date();
  const start = from ? toDate(from, 'from') : new Date(Date.now() - 30 * DAY_MS);
  return { from: start.toISOString(), to: end.toISOString() };
}

module.exports = { DAY_MS, reportRange };
