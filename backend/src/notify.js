'use strict';
// Notifications: record an in-app feed entry, then fan out to external channels
// (currently Telegram). Delivery is best-effort and never blocks the caller —
// a failed Telegram send must not fail a payment webhook.
const config = require('./config');
const { log } = require('./lib/log');

const EVENTS = ['payment.paid', 'payment.failed', 'payment.refunded', 'payment.chargeback', 'payout.paid'];

// An event is only offered to (and delivered to) users whose role grants this permission.
const EVENT_PERMISSION = {
  'payment.paid': 'payments.view',
  'payment.failed': 'payments.view',
  'payment.refunded': 'payments.view',
  'payment.chargeback': 'revenue.view',
  'payout.paid': 'revenue.view',
};
function eventsAllowedFor(permissions) {
  return EVENTS.filter((e) => permissions.has(EVENT_PERMISSION[e]));
}

function money(amount, currency) {
  if (amount == null) return '';
  const n = Number(amount).toFixed(2);
  return `${n} ${(currency || '').toUpperCase()}`.trim();
}

// Telegram treats these as markup in MarkdownV2; escape or messages fail to send.
function esc(s) {
  return String(s == null ? '' : s).replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, (m) => '\\' + m);
}

function renderTelegram(n) {
  const icon = { 'payment.paid': '✅', 'payment.failed': '⚠️', 'payment.refunded': '↩️', 'payment.chargeback': '❌', 'payout.paid': '💸' }[n.event] || '🔔';
  const lines = [`${icon} *${esc(n.title)}*`];
  if (n.amount != null) lines.push(`Amount: *${esc(money(n.amount, n.currency))}*`);
  if (n.body) lines.push(esc(n.body));
  return lines.join('\n');
}

async function sendTelegram(chatId, text) {
  if (!config.telegramBotToken) {
    throw Object.assign(new Error('telegram_not_configured'), {
      status: 501,
      detail: 'Set TELEGRAM_BOT_TOKEN on the server to enable Telegram delivery.',
    });
  }
  const url = `${config.telegramApiBase}/bot${config.telegramBotToken}/sendMessage`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'MarkdownV2', disable_web_page_preview: true }),
  });
  const data = await r.json().catch(() => null);
  if (!r.ok || (data && data.ok === false)) {
    const detail = (data && (data.description || data.error_code)) || `HTTP ${r.status}`;
    throw Object.assign(new Error('telegram_send_failed'), { status: r.status, detail });
  }
  return data;
}

/**
 * Record a notification and deliver it to every active channel subscribed to
 * the event. accountId / agentId say who it concerns; both null means the
 * agency as a whole, which only workspace-wide roles see.
 */
async function notify(c, workspaceId, n) {
  if (!EVENTS.includes(n.event)) throw new Error('unknown_event: ' + n.event);

  const row = (await c.query(
    `INSERT INTO notifications (workspace_id, event, title, body, amount, currency, entity_type, entity_id, account_id, agent_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [workspaceId, n.event, n.title, n.body || null, n.amount ?? null, n.currency || null,
      n.entityType || null, n.entityId || null, n.accountId || null, n.agentId || null],
  )).rows[0];

  const channels = (await c.query(
    'SELECT id, type, target FROM notification_channels WHERE workspace_id=$1 AND active AND $2 = ANY(events)',
    [workspaceId, n.event],
  )).rows;

  const text = renderTelegram(row);
  for (const ch of channels) {
    if (ch.type !== 'telegram') continue;
    try {
      await sendTelegram(ch.target, text);
      await c.query('UPDATE notification_channels SET last_sent_at=now(), last_error=NULL WHERE id=$1', [ch.id]);
    } catch (e) {
      const msg = (e.detail || e.message || 'send failed').toString().slice(0, 300);
      log.error({ channelId: ch.id, err: msg }, 'telegram delivery failed');
      await c.query('UPDATE notification_channels SET last_error=$2 WHERE id=$1', [ch.id, msg]).catch(() => {});
    }
  }
  return row;
}

module.exports = { notify, sendTelegram, renderTelegram, EVENTS, EVENT_PERMISSION, eventsAllowedFor, money };
