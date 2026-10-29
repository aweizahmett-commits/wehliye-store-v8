# Existing Render service: deployment review

Prepared locally only. No Git push, Render setting change, deployment or cloud database write has occurred.

## Existing resources
Service: wehliye-store-v8, srv-dbhljqafngtc73c000d0, Frankfurt.
https://dashboard.render.com/web/srv-dbhljqafngtc73c000d0
Repository: aweizahmett-commits/wehliye-store-v8; branch main, commit auto-deploy enabled.
Database: wehliye-store-db, dpg-dbhlhpg8v5cc738qc3rg-a, database wehliye_store, Frankfurt.
Existing resources must be reused. Do not create/delete/replace a database or overwrite product data.
The latest inspected deployment failed startup because ADMIN_PASSWORD was invalid or absent.
The database was empty on the earlier read-only schema inspection.
Free database expiry: 2026-11-28 14:32 UTC. A durable plan needs separate approval.

## Settings to apply only after explicit approval
Root directory: repository root
Build command: npm ci --include=dev && npm run build
Start command: npm start
Health check: /health/ready
Node engines: >=24 <25
One Node service serves both the built frontend and API.

Private runtime variables:
NODE_ENV=production
DATABASE_URL=<existing Render database Internal Database URL>
ADMIN_USER=<unique owner username>
ADMIN_PASSWORD=<strong unique password, at least 12 characters>
PUBLIC_URL=https://wehliye-store-v8.onrender.com
GOOGLE_CLIENT_ID=<Google Web application client ID>
GOOGLE_CLIENT_SECRET=<matching private client secret>
TRUST_PROXY_HOPS=0 initially; verify the real proxy chain before selecting another value.
Render supplies PORT. NODE_VERSION in the Dashboard overrides package.json engines.
Never place credentials in VITE_* values, source control or chat.
The backend accepts DATABASE_URL and enforces verified TLS for Render external endpoints.
Internal URL TLS settings follow the chosen URL and Render connection guidance.

## Approval and rollout sequence
1. Review the local diff, test results and the 30-minute unpaid stock reservation policy.
2. Resolve correct local PostgreSQL source credentials. Existing .env port 5434 refuses connections;
   configured credentials were rejected by local instances on 5432/5433. No credential file was changed.
3. Export and verify the authoritative 73-product PostgreSQL snapshot using render-product-migration.mjs.
   Follow RENDER-MIGRATION-PLAN.md. JSON files contain 73 products but are not silently used as the source.
4. Privately configure the Google Web OAuth client. Register this exact callback:
   https://wehliye-store-v8.onrender.com/api/auth/google/callback
   Review audience/publishing status and permitted test users.
5. Obtain explicit approval for specific cloud environment changes, the additive auth schema migration,
   the reviewed product import, GitHub push and the deployment.
   A push to main itself triggers deployment. It must not happen before approval.
6. Keep customer traffic closed until initialization and verification are complete.
   Before applying migrations, take/review destination backup and recheck that product data is absent.
7. With the approved destination configured privately, run node migrate-auth.mjs --check,
   then node migrate-auth.mjs --apply. The latter creates only three new auth/rate tables and indexes
   inside a transaction. It does not modify store_state or products and is safe to rerun.
8. Apply the separately reviewed product migration only to an empty destination. Do not merge/overwrite existing data.
   If any destination data already exists, stop and review rather than changing it.
9. Apply service settings, then push/deploy the reviewed source with approval. Do not issue a second manual
   deploy if the push already triggered it.
10. Check logs without printing secrets, /health/ready, /api/store (all 73 IDs/prices/images/stock),
    Google sign-in, admin login/logout, and session persistence after an approved restart.
    Verify forwarded-header behavior before trusting proxy addresses for source rate limits.
    Test commerce scenarios using a separate staging database with synthetic products, not real customer orders.

## Readiness and rollback
Startup validates required production variables but never applies schema or seeds products.
Readiness requires initialized store data, auth tables, and built frontend assets.
A 200 health response does not certify live OAuth credentials or payment processing.
Sessions are persisted as token hashes. Old browser-stored admin tokens and development file sessions are invalidated.
Stock/order changes are transactional; cancellation/expiry release stock once.
Keep a database backup before accepting traffic. A code rollback does not undo orders or stock changes.
Keep the additive tables if rolling application code back; do not drop/delete databases or overwrite products.
Avoid reverting to the old backend, which lacks transaction and session protections.
Real payments, carrier rates and tax calculations remain unimplemented; orders require manual confirmation.

References:
https://render.com/docs/node-version
https://render.com/docs/health-checks
https://render.com/docs/postgresql-creating-connecting
https://node-postgres.com/features/transactions
https://developers.google.com/identity/protocols/oauth2/web-server
