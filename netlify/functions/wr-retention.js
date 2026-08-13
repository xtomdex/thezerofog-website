// Scheduled daily. Deletes workshop registrations older than the retention window.
//
// EverWebinar exposes this as a GDPR setting - "delete leads N months after subscription". Ours
// is the same promise except that it runs against data we actually hold, and it is the half of a
// privacy policy that usually never gets built: saying you delete old data is easy, deleting it
// is a cron job somebody has to write.
//
// Deleting the registration cascades to attendance, events and the notification queue, because
// every one of those tables references it with `on delete cascade`. One delete, nothing orphaned.

import { json, remove, select } from './lib/wr-db.js';
import { loadConfig } from './lib/wr-config.js';

export default async function handler() {
  let config;
  try {
    config = await loadConfig({ fresh: true });
  } catch (err) {
    console.error('wr-retention: config load failed:', err.message);
    return json({ error: 'config' }, 500);
  }

  const months = config.privacy?.retainMonths;
  if (!months || months <= 0) {
    return json({ ok: true, skipped: 'retention disabled' });
  }

  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - months);

  try {
    // Counted before deleting, purely so the log says what happened. A silent retention sweep is
    // indistinguishable from one that never ran.
    const doomed = await select('wr_registrations', {
      select: 'id',
      created_at: `lt.${cutoff.toISOString()}`,
      limit: 5000,
    });

    if (!doomed || !doomed.length) {
      console.log(`wr-retention: nothing older than ${cutoff.toISOString()}`);
      return json({ ok: true, deleted: 0 });
    }

    await remove('wr_registrations', { created_at: `lt.${cutoff.toISOString()}` });

    console.log(`wr-retention: deleted ${doomed.length} registrations older than ${months} months`);
    return json({ ok: true, deleted: doomed.length, cutoff: cutoff.toISOString() });
  } catch (err) {
    console.error('wr-retention failed:', err.message);
    return json({ error: 'retention' }, 500);
  }
}

// Once a day, at a quiet hour. There is nothing time-sensitive about it.
export const config = { schedule: '17 4 * * *' };
