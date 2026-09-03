// Netlify build plugin: after a PRODUCTION deploy has gone live, ping IndexNow with every sitemap
// URL whose <lastmod> is within the last 3 days. Deploy previews and branch deploys stay silent -
// their URLs are not thezerofog.com and a ping from them would just fail the key check.
//
// onSuccess (not onPostBuild) on purpose: the key file and the changed pages must already be live
// when Bing comes to look. A failed ping is reported as a warning, never as a failed build - the
// site going live matters more than Bing hearing about it a day earlier.
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

module.exports = {
  onSuccess: async ({ utils, constants }) => {
    if (process.env.CONTEXT !== 'production') {
      console.log(`indexnow: CONTEXT=${process.env.CONTEXT}, not production - skipped`);
      return;
    }
    try {
      const { submit, urlsFromSitemap } = await import('../../scripts/indexnow.mjs');
      const xml = readFileSync(join(constants.PUBLISH_DIR, 'sitemap.xml'), 'utf8');
      const urls = urlsFromSitemap(xml, 3);
      const r = await submit(urls);
      if (r.status && r.status !== 200 && r.status !== 202) {
        utils.status.show({ title: 'IndexNow ping failed', summary: `HTTP ${r.status}` });
      } else if (r.sent.length) {
        utils.status.show({ title: 'IndexNow', summary: `${r.sent.length} url(s) submitted, HTTP ${r.status}` });
      }
    } catch (err) {
      console.warn('indexnow: ' + (err && err.message));
      utils.status.show({ title: 'IndexNow skipped', summary: String(err && err.message) });
    }
  },
};
