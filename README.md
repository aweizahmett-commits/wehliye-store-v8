# WEHLIYE STORE V8

React/Vite storefront and a Node HTTP server backed by PostgreSQL.
The existing website design and 73-product files are preserved.

## Local setup
Use Node 24.x. Run npm ci --include=dev and npm run build.
Copy .env.example to a private .env and supply valid local PostgreSQL credentials,
ADMIN_USER, ADMIN_PASSWORD (12+ characters), PUBLIC_URL and your Google Web OAuth credentials.
Never commit secrets or put them in VITE_* variables.

Existing store data must be initialized separately. The server never seeds or overwrites products.
Review RENDER-MIGRATION-PLAN.md and render-product-migration.mjs before product migration.
Authentication tables are separate and additive:
npm run db:auth:check
npm run db:auth:apply
Only apply after confirming the target and approving that database change.
Then run npm start; storefront /, owner dashboard /admin, readiness /health/ready.

## Production behavior
Customer/admin sessions are stored as hashed tokens in PostgreSQL; old development JSON sessions are not imported.
Customers sign in with Google's authorization-code flow, browser-bound one-use state and PKCE.
Customer cookies last seven days; owner cookies last eight hours, HttpOnly/SameSite=Lax and Secure on HTTPS.
All state mutations use one PostgreSQL transaction and SELECT FOR UPDATE on store_state row 1.
Products remain in the existing JSONB format; no product conversion is performed.
Checkout uses server prices, integer cents, combined quantities per product, and persisted idempotency keys.
Unpaid orders reserve stock for 30 minutes. Confirmation keeps stock allocated.
Cancellation or expiry releases it once; cancelled orders cannot be reopened.
Legacy orders without reservationExpiresAt require manual review/cancellation.
State transitions: Awaiting payment -> Confirmed -> Processing -> Shipped -> Delivered.
Cancellation is allowed before shipment. Confirmation does not itself verify payment.
An expiry worker runs once per minute while the process is active; checkout/status updates also check expiry.
When free hosting is asleep, background expiry pauses until the server starts and the worker or checkout runs.

## Security
JSON write requests require an exact same-origin Origin header.
Rate limits persist across restarts in PostgreSQL. Owner login: 10 attempts per source per 15 minutes,
plus 100 total per 15 minutes. OAuth starts: 20 per source per 10 minutes.
Checkout: 30 attempts per customer per minute and at most three awaiting-payment orders.
TRUST_PROXY_HOPS defaults to 0, so forwarded client addresses are ignored.
Only set a proxy count after verifying the hosting proxy chain, including a forged-header check.
Until then proxy users may share an IP rate limit; do not blindly trust incoming forwarded headers.
Errors are redacted; security headers and a CSP protect the unchanged UI.
Do not log cookie/Authorization headers, OAuth callback query strings, secrets or customer addresses.
Rotate secrets through private hosting settings. Password rotation does not automatically revoke existing
owner sessions; explicitly revoke owner sessions during incident response after approved database access.
Sessions, OAuth states and rate-limit records are pruned by the maintenance job.

## Payments and shipping
Payments are not integrated. All orders are UNPAID and require independent payment confirmation.
The selectable payment method is recorded but no card/mobile money is charged.
Shipping remains the existing $5/free-over-$150 estimate; taxes and real carrier rates are not implemented.
Treat this as a manually confirmed order workflow until approved provider APIs and webhook verification exist.

## Tests and deployment
npm test
npm run test:integration
npm run build
npm audit --ignore-scripts
The integration runner creates its own isolated local PostgreSQL cluster with synthetic data.
It never reads DATABASE_URL/DB_* or connects to existing databases; the cluster is stopped afterward.
Windows defaults to PostgreSQL 18 binaries. Override PG_TEST_BIN for another installation/platform.
Test files are retained in ignored .test-postgres/ without deleting any database.
See RENDER-DEPLOYMENT.md and SECURITY-VALIDATION.md for review results and remaining live checks.
No Git push, Render deployment, cloud configuration change or production migration is authorized automatically.
