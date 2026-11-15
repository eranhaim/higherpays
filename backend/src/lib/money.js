'use strict';
// pg returns NUMERIC columns as strings, and a SUM over no rows as null.

const toNumber = (value) => Number(value || 0);

const round2 = (value) => Math.round(value * 100) / 100;

module.exports = { toNumber, round2 };
