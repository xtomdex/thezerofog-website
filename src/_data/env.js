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
  posthog_host: process.env.PUBLIC_POSTHOG_HOST || 'https://us.i.posthog.com',

  // Purchase value for the Meta Pixel, read from the same pair stripe-webhook.js validates the
  // order against - so the number the pixel reports and the number we refuse to accept can never
  // drift apart. Cents there, major units here, because that is what Meta expects.
  //
  // Not a secret: it is the public price. Empty when unset, and the pixel then reports the sale
  // without a value rather than inventing one - the founding price is a ladder ($67 -> $167 ->
  // $250-290) and a hard-coded number would quietly misreport revenue from the day it moves.
  purchase_value: process.env.EXPECTED_AMOUNT_TOTAL
    ? String(Number(process.env.EXPECTED_AMOUNT_TOTAL) / 100)
    : '',
  purchase_currency: (process.env.EXPECTED_CURRENCY || 'usd').toUpperCase()
};
