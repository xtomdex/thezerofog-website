// POST /.netlify/functions/wr-question
//
// A real question typed by someone in the room. Stored, and pushed to the operator so it reaches
// a person rather than a table nobody opens.
//
// This is the honest half of what EverWebinar calls a chat. There is no moderator sitting in the
// room, and a message box that answers nobody would be worse than one that plainly forwards - so
// the page says who reads them and this function makes that true.
//
// It did not, between 2026-08-13 and 2026-08-16: the forward went to MAKE_QUESTION_WEBHOOK_URL,
// which was never set in production, and no admin surface listed the rows either. Three
// questions sat unread. Make is now out of the funnel entirely, so the route is a Telegram
// message to the operator, and wr-stats returns the questions as the durable second copy.

import { insert, json, preflight, selectOne } from './lib/wr-db.js';
import { formatPosition, notifyOperator } from './lib/wr-telegram.js';

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

  // Best effort, and awaited rather than fired and forgotten - a serverless function that
  // returns is free to be frozen mid-request, which would drop the alert silently. The question
  // is already saved either way, and wr-stats lists it, so a failed push costs a notification
  // and never the question.
  const who = registration.name ? `${registration.name} <${registration.email}>` : registration.email;
  await notifyOperator(
    'Question from the workshop room\n\n' +
      `From: ${who}\n` +
      `At: ${formatPosition(position)} into the session\n\n` +
      clean
  );

  return json({ ok: true });
}
