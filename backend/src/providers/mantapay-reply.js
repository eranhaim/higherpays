'use strict';

// MantaPay uses different casing on its webhook, status, and Search responses.
// These are the documented names observed in those three response shapes —
// except the last, which marks wording of our own and must stay
// distinguishable from anything the provider actually said.
const DECLINE_SOURCE = {
  webhookSigned: 'mantapay_webhook_signed',
  webhook: 'mantapay_webhook',
  status: 'mantapay_status',
  rawPayload: 'stored_raw_payload',
  derivedNoProviderText: 'derived_no_provider_text',
};

// MantaPay describes most declines in `reply_desc`, but on some reply codes it
// sends that field EMPTY — every production `017` arrives as `reply_desc: ""`,
// and its status lookup answers blank too. The provider documents no meaning
// for those codes, so we cannot name a cause without inventing one. State the
// truth instead: a code with no explanation behind it.
const UNSPECIFIED_DECLINE_REASON = 'MantaPay declined the payment without giving a reason';

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
  // A declined attempt always carries a readable reason: staff asked why a
  // payment failed, and a bare reply code does not answer that.
  return {
    code: normalizedCode,
    reason: normalizedReason || UNSPECIFIED_DECLINE_REASON,
    codeSource: normalizedCode ? codeSource : null,
    reasonSource: normalizedReason ? reasonSource : DECLINE_SOURCE.derivedNoProviderText,
  };
}

module.exports = {
  DECLINE_SOURCE,
  UNSPECIFIED_DECLINE_REASON,
  providerText,
  readReplyCode,
  readReplyDescription,
  declineFields,
};
