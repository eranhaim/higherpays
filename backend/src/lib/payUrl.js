'use strict';
const config = require('../config');

// The public link a payer opens. It is a top-level /pay path, not /api/pay:
// some content filters (NetSpark-style "Your device is protected" pages) block
// /api/ URLs as tracking or advertising. /api/pay/<ref> still resolves to the
// same handler, so links already sent keep working.
function payUrl(referenceId) {
  return `${config.appPublicBase}/pay/${encodeURIComponent(referenceId)}`;
}

module.exports = { payUrl };
