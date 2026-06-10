// Public client-side env (PUBLIC_* / build-time vars exposed to templates).
// Values here are intentionally non-secret and may reach the browser.
// Any future `{{ env.* }}` reference resolves cleanly from this contract.

module.exports = {
  // Meta (Facebook) Pixel ID — public, not a secret. Exposed to client JS only
  // when set; the pixel itself is consent-gated (loads only on consent === 'all').
  meta_pixel_id: process.env.META_PIXEL_ID || ''
};
