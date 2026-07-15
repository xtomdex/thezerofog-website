// Public client-side env (PUBLIC_* / build-time vars exposed to templates).
// Values here are intentionally non-secret and may reach the browser.
// Any future `{{ env.* }}` reference resolves cleanly from this contract.

module.exports = {
  // Meta (Facebook) Pixel ID — public, not a secret. Exposed to client JS only
  // when set; the pixel itself is consent-gated (loads only on consent === 'all').
  meta_pixel_id: process.env.META_PIXEL_ID || '',

  // PostHog project API key + ingestion host — public, not secrets. Exposed to
  // client JS only when set; PostHog itself is consent-gated exactly like the
  // pixel (loads only on consent === 'all'). Empty key = site stays analytics-free.
  posthog_key: process.env.PUBLIC_POSTHOG_KEY || '',
  posthog_host: process.env.PUBLIC_POSTHOG_HOST || 'https://us.i.posthog.com'
};
