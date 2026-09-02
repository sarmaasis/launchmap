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
