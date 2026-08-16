// Operator alerts over Telegram.
//
// This exists because the workshop room invites a real question - "Have a question? Send it to
// Kirill", and on success the page says "Kirill reads these himself" - and until 2026-08-16 the
// question reached a Make webhook that was never configured in production. It landed in
// wr_events and stopped there.
//
// Why Telegram and not email: every email path we own is a marketing path. MailerLite sends only
// by group-join firing an automation, the Free plan allows three active automations at a time,
// and the operator would arrive in his own subscriber list with an unsubscribe footer under a
// customer's question. A bot message is free, instant, uncapped, and belongs to nobody's list.
//
// Delivery is best effort by contract. Every caller has already stored the thing it is telling
// us about, so a failed alert costs a notification and never the record - which is why nothing
// here throws and every failure is a console line.

const API = () => process.env.TELEGRAM_API_BASE || 'https://api.telegram.org';

// Telegram rejects anything longer; the room already caps a question at 2000 characters, so this
// only ever bites if a caller composes something unusually long.
const MAX_MESSAGE = 4096;

/**
 * Send one operator alert. Returns true if Telegram accepted it, false in every other case -
 * including "not configured", which is a normal state in a preview deploy.
 *
 * Sent without parse_mode on purpose: the body carries text a stranger typed, and an unbalanced
 * `_` or `*` in Markdown mode makes Telegram reject the whole message. Plain text cannot be
 * broken by its own content.
 */
export async function notifyOperator(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) {
    console.warn('wr-telegram: TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID unset - alert not sent');
    return false;
  }

  try {
    const res = await fetch(`${API()}/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: String(text).slice(0, MAX_MESSAGE),
        disable_web_page_preview: true,
      }),
    });
    if (!res.ok) {
      // The body carries Telegram's own reason (wrong chat id, bot blocked, bad token) and is
      // the only way to tell those apart, so it is worth the log line.
      const detail = await res.text().catch(() => '');
      console.error(`wr-telegram: sendMessage -> ${res.status}: ${detail.slice(0, 200)}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error('wr-telegram: send failed:', err.message);
    return false;
  }
}

/** `129` -> `2:09`. Null position renders as a dash - a question can arrive before playback. */
export function formatPosition(sec) {
  if (!Number.isFinite(sec)) return '-';
  const total = Math.max(0, Math.floor(sec));
  const minutes = Math.floor(total / 60);
  const seconds = String(total % 60).padStart(2, '0');
  return `${minutes}:${seconds}`;
}
