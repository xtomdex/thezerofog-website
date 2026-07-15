// Geo lookup for the cookie-consent regime split (EU opt-in vs elsewhere opt-out).
// Returns the visitor's ISO country code from Netlify's edge geo data. The client
// (cookie-consent-5.js) maps it to a consent regime; an empty/unknown country is
// treated as EU there (safe default: opt-in). Response is never cached - the CDN
// would otherwise serve one visitor's country to another.
// CORS: the Systeme course portal (course.thezerofog.com) runs the same regime
// split for its consent-gated PostHog snippet and has no /geo of its own.
export default (request, context) => {
  const country = context.geo?.country?.code || "";
  return new Response(JSON.stringify({ country }), {
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      "access-control-allow-origin": "https://course.thezerofog.com",
    },
  });
};

export const config = { path: "/geo" };
