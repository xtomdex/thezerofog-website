// Public runtime env for client-side integrations. Templates: {{ env.paddle_client_token }}.
// All keys MUST come from PUBLIC_*-prefixed env vars. For site identity (brand, domain,
// emails, legal entity), see _data/site.js — those expose semantic names instead.

module.exports = {
  paddle_client_token: process.env.PUBLIC_PADDLE_CLIENT_TOKEN || "",
  paddle_environment: process.env.PUBLIC_PADDLE_ENVIRONMENT || "sandbox",
};
