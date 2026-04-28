// Site identity. Templates: {{ site.brand }}, {{ site.domain }}, {{ site.legal.entity }},
// {{ site.email.support }}, etc. Most fields read from PUBLIC_* env vars (Netlify in prod,
// .env locally — loaded by netlify dev). Defaults are safe production values where possible.

const domain = process.env.PUBLIC_SITE_DOMAIN || "thezerofog.com";

module.exports = {
  brand: "The Zero Fog",
  domain,
  url: process.env.PUBLIC_SITE_URL || `https://${domain}`,
  legal: {
    entity: process.env.PUBLIC_LEGAL_ENTITY || "TBD",
  },
  email: {
    support: process.env.PUBLIC_EMAIL_SUPPORT || `support@${domain}`,
    privacy: process.env.PUBLIC_EMAIL_PRIVACY || `privacy@${domain}`,
    refunds: process.env.PUBLIC_EMAIL_REFUNDS || `refunds@${domain}`,
    copyright: process.env.PUBLIC_EMAIL_COPYRIGHT || `copyright@${domain}`,
  },
};
