# Project: The Zero Fog — marketing site

## Architecture
Static HTML/CSS/JS site deployed via Netlify (auto-deploy from GitHub main branch).
No build step, no framework, no dependencies.

## File structure
- `index.html` — main opt-in page (webinar registration)
- `thank-you.html` and `thank-you/index.html` — post-registration page
- `sales/index.html` — sales page (post-webinar CTA → Paddle checkout)
- `confirmation/index.html` — email confirmation page
- `replay/index.html` — webinar replay page
- `terms.html`, `privacy.html` — legal pages
- `social.html` — social proof page
- `bonuses/` — bonus content pages
- `shared.css` — global styles (CSS variables, dark/light theme)
- `shared.js` — global scripts
- `_redirects` — Netlify redirects config
- `_archive-2026-03-29/` — old versions, do not modify
- `netlify/functions/optin.js` — serverless proxy for form submissions (validates input, forwards to Make.com)

## Conventions
- Dark theme is default, light toggle via CSS class `.dark` on `<html>`
- CSS variables defined in shared.css, page-specific styles inline in each HTML
- All code comments in English
- Do not modify files in `_archive-*` directories

## Integrations (in progress)
- Make.com webhook for form submissions — proxied via `netlify/functions/optin.js` (not called directly from the browser). Requires `MAKE_WEBHOOK_URL` env variable set in Netlify dashboard (Site settings → Environment variables).
- EverWebinar for webinar room
- Paddle.js for checkout on sales page
- MailerLite for email sequences via Make.com
- Systeme.io for LMS (course delivery)