// Site identity. Templates: {{ site.brand }}, {{ site.domain }}, {{ site.legal.entity }},
// {{ site.email.support }}, etc. Most fields read from PUBLIC_* env vars (Netlify in prod,
// .env locally — loaded by netlify dev). Defaults are safe production values where possible.

const domain = process.env.PUBLIC_SITE_DOMAIN || "thezerofog.com";

// Legal identity address parts (LSSI-CE Art. 10). Empty string when unset — never faked.
const addressLine1 = process.env.PUBLIC_LEGAL_ADDRESS_LINE1 || "";
const addressLine2 = process.env.PUBLIC_LEGAL_ADDRESS_LINE2 || "";
const postalCode = process.env.PUBLIC_LEGAL_POSTAL_CODE || "";
const city = process.env.PUBLIC_LEGAL_CITY || "";
const country = process.env.PUBLIC_LEGAL_COUNTRY || "";

// postalCode + city join with a space ("08015 Barcelona"), not a comma.
const postalCity = [postalCode, city].filter(Boolean).join(" ");
// Compose the one-line form from non-empty parts only — line2 skipped cleanly when empty.
const addressOneLine = [addressLine1, addressLine2, postalCity, country]
  .filter(Boolean)
  .join(", ");

module.exports = {
  brand: "The Zero Fog",
  domain,
  url: process.env.PUBLIC_SITE_URL || `https://${domain}`,
  legal: {
    entity: process.env.PUBLIC_LEGAL_ENTITY || "TBD",
    taxId: process.env.PUBLIC_LEGAL_TAX_ID || "",
    address: {
      line1: addressLine1,
      line2: addressLine2,
      postalCode,
      city,
      country,
      oneLine: addressOneLine,
      // A published address is only meaningful when the core parts are all present.
      isSet: Boolean(addressLine1 && postalCode && city && country),
    },
  },
  email: {
    support: process.env.PUBLIC_EMAIL_SUPPORT || `support@${domain}`,
    privacy: process.env.PUBLIC_EMAIL_PRIVACY || `privacy@${domain}`,
    refunds: process.env.PUBLIC_EMAIL_REFUNDS || `refunds@${domain}`,
    copyright: process.env.PUBLIC_EMAIL_COPYRIGHT || `copyright@${domain}`,
  },
};
