// POST /.netlify/functions/wr-preferences
//
// The one-click opt-out from the SALES cadence that E13's P.P.S. promises: "one click here and
// I stop. You'll still get the useful stuff, just nothing about the price."
//
// This is NOT an unsubscribe. The person stays on the list and keeps every non-sales email;
// only the templates flagged `sales: true` in the schedule stop. The flag is honoured by
// wr-notify at send time, which is the only place a sending decision is made - so the promise
// is kept by the same code that would otherwise break it. Setting is one-way by design: a
// fresh registration (duplicatePolicy 'replace') starts clean.
//
// Body: { t } - the join token. That token arrives only by email, so a valid one IS the proof
// that the request comes from the addressee.

import { json, preflight, selectOne, update } from './lib/wr-db.js';

export default async function handler(req) {
  if (req.method === 'OPTIONS') return preflight();
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  let body;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Invalid JSON' }, 400);
  }

  const { t: token } = body;
  if (!token || typeof token !== 'string') return json({ error: 'Invalid link.' }, 400);

  let registration;
  try {
    registration = await selectOne('wr_registrations', {
      select: 'id',
      token: `eq.${token}`,
    });
  } catch (err) {
    console.error('wr-preferences: lookup failed:', err.message);
    return json({ error: 'Server error' }, 500);
  }
  if (!registration) return json({ error: 'This link is not valid.' }, 404);

  try {
    await update('wr_registrations', { id: `eq.${registration.id}` }, { no_sales: true });
  } catch (err) {
    console.error('wr-preferences: update failed:', err.message);
    return json({ error: 'Server error' }, 500);
  }

  return json({ ok: true });
}
