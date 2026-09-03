# Launchmap

Hosted launch boards. Customers pay, paste a 1KB script, tweet a public URL. Hosted product.

See .dev.vars.example for local config.

Hono plus React and Vite on Workers.

Use the Vite dev script, then open localhost on port 5173.

## Local
Run the Vite dev script after installing packages and applying local D1 migrations.

## Pages
/ landing
/login
/auth/verify
/app dashboard
/l/:slug public board
/t/:slug/collect embed ingest
/checkout/success

## Billing
Dodo checkout: 9 USD monthly and 19 USD one launch. Webhook path /webhooks/dodo. Events payment.succeeded and subscription.active. Env names are in .dev.vars.example.

## Blockers
Blockers: EMAIL binding, EMAIL_FROM, APP_URL, SESSION_SECRET, DODO_PAYMENTS_API_KEY, DODO_PAYMENTS_WEBHOOK_KEY, DODO_PAYMENTS_ENVIRONMENT, DODO_PRODUCT_ID, DODO_MONTHLY_PRODUCT_ID or DODO_PRICE, and D1 database_id in wrangler.jsonc (still REPLACE_WITH_D1_DATABASE_ID).

## License
MIT

## Search Console
Login Google OAuth stays at `$APP_URL/api/auth/google/callback`. Search Console is a separate flow: add `$APP_URL/api/connect/gsc/callback` as a redirect URI on the same Google client. From Plan, Connect Search Console with `launch_id` set. Scope is `https://www.googleapis.com/auth/webmasters.readonly` plus openid email, `access_type=offline` and `prompt=consent`. After consent, Cairn stores the refresh token, lists GSC properties, and binds the one whose hostname matches the site URL (including `sc-domain:`). Daily cron at 03:00 UTC syncs GSC and Bing after event purge. Manual sync: `POST /api/launches/:id/search/sync`.

## Bing
`POST /api/launches/:id/connect/bing` with `{ "api_key", "site_url?" }`. Sync uses `GET https://ssl.bing.com/webmaster/api.svc/json/GetQueryStats`.

## Webhooks
Customer checkout webhooks (pass `cairn_vid` plus `launch_id` or `slug` in metadata; `window.cairnCheckoutUrl` already appends `cairn_vid`):

- `/webhooks/dodo`
- `/webhooks/stripe`
- `/webhooks/polar` (`POLAR_WEBHOOK_SECRET`; Standard Webhooks or Polar-Signature)
- `/webhooks/paddle` (`PADDLE_WEBHOOK_SECRET`; Paddle-Signature `ts`/`h1`)
- `/webhooks/lemon` (`LEMON_SQUEEZY_WEBHOOK_SECRET`; X-Signature HMAC-SHA256)

If a secret is unset, that path returns 500.

## API keys, CLI, MCP
Create a key in Plan (`POST /api/keys`). The `lm_live_...` secret is shown once. Send `Authorization: Bearer` to `/api/v1/me`, `/api/v1/sites`, `/api/v1/sites/:id/overview|sources|search|funnel|feed`.

CLI:

```
export CAIRN_API_KEY=lm_live_...
export CAIRN_API_URL=https://cairn.app   # or http://localhost:5173
node cli/cairn.mjs whoami
node cli/cairn.mjs sites
node cli/cairn.mjs overview <id>
```

Or `npx tsx cli/cairn.mjs` / `npx cairn` if the bin is linked.

Cursor `mcp.json`:

```
{
  "mcpServers": {
    "cairn": {
      "command": "node",
      "args": ["mcp/server.mjs"],
      "env": {
        "CAIRN_API_KEY": "lm_live_...",
        "CAIRN_API_URL": "https://cairn.app"
      }
    }
  }
}
```

Tools: cairn_overview, cairn_sources, cairn_search, cairn_funnel, cairn_feed.
