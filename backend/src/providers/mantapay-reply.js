'use strict';

// MantaPay uses different casing on its webhook, status, and Search responses.
// These are the documented names observed in those three response shapes.
const DECLINE_SOURCE = {
  webhookSigned: 'mantapay_webhook_signed',
  webhook: 'mantapay_webhook',
  status: 'mantapay_status',
  rawPayload: 'stored_raw_payload',
};

function providerText(value) {
  if (value == null) return null;
  const text = String(value).trim();
  return text || null;
}

function readReplyCode(payload) {
  return providerText(
    payload?.reply_code
    ?? payload?.replyCode
    ?? payload?.Reply
    ?? payload?.ReplyCode,
  );
}

function readReplyDescription(payload) {
  return providerText(
    payload?.reply_desc
    ?? payload?.replyDesc
    ?? payload?.ReplyDesc
    ?? payload?.ReplyDescription,
  );
}

function declineFields(status, {
  code = null,
  reason = null,
  codeSource = null,
  reasonSource = null,
} = {}) {
  if (status !== 'declined') {
    return {
      code: null,
      reason: null,
      codeSource: null,
      reasonSource: null,
    };
  }

  const normalizedCode = providerText(code);
  const normalizedReason = providerText(reason);
  return {
    code: normalizedCode,
    reason: normalizedReason,
    codeSource: normalizedCode ? codeSource : null,
    reasonSource: normalizedReason ? reasonSource : null,
  };
}

module.exports = {
  DECLINE_SOURCE,
  providerText,
  readReplyCode,
  readReplyDescription,
  declineFields,
};
