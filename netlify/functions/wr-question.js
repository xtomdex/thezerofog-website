// POST /.netlify/functions/wr-question
//
// A real question typed by someone in the room. Stored, and forwarded to Make so it reaches an
// inbox rather than a table nobody opens.
//
// This is the honest half of what EverWebinar calls a chat. There is no moderator sitting in the
// room, and a message box that answers nobody would be worse than one that plainly forwards - so
// the page says who reads them and this function makes that true.

import { insert, json, preflight, selectOne } from './lib/wr-db.js';
import { loadConfig } from './lib/wr-config.js';

const MAX_LENGTH = 2000;

export default async function handler(req) {
  if (req.method === 'OPTIONS') return preflight();
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  let body;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Invalid JSON' }, 400);
  }

  const { t: token, text, positionSec } = body;
  if (!token || typeof token !== 'string') return json({ error: 'Invalid link.' }, 400);
  if (typeof text !== 'string' || !text.trim()) return json({ error: 'Empty question.' }, 400);

  let registration;
  try {
    registration = await selectOne('wr_registrations', {
      select: 'id,email,name',
      token: `eq.${token}`,
    });
  } catch (err) {
    console.error('wr-question: lookup failed:', err.message);
    return json({ error: 'Server error' }, 500);
  }
  if (!registration) return json({ error: 'This link is not valid.' }, 404);

  const clean = text.trim().slice(0, MAX_LENGTH);
  const position = Number.isFinite(positionSec) ? Math.max(0, Math.floor(positionSec)) : null;

  try {
    await insert(
      'wr_events',
      {
        registration_id: registration.id,
        type: 'question',
        position_sec: position,
        payload: { text: clean },
      },
      { returning: false }
    );
  } catch (err) {
    console.error('wr-question: store failed:', err.message);
    return json({ error: 'Server error' }, 500);
  }

  // Best effort. The question is already saved; failing to forward it costs a notification, not
  // the question itself.
  const config = await loadConfig().catch(() => null);
  const target = config?.webhooks?.routes?.question || process.env.MAKE_WEBHOOK_URL;
  if (target) {
    try {
      await fetch(target, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'workshop_question',
          email: registration.email,
          name: registration.name,
          position_sec: position,
          text: clean,
        }),
      });
    } catch (err) {
      console.error('wr-question: forward failed:', err.message);
    }
  }

  return json({ ok: true });
}
