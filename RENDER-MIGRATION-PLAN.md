# Render deployment audit and migration preparation

Inspected 2026-10-29. No production data or service settings changed.

## Verified resources
Workspace: My Workspace (tea-dbhlb88u01pc73bkgcig).
Web service: wehliye-store-v8 (srv-dbhljqafngtc73c000d0), Frankfurt, free.
Repo: https://github.com/aweizahmett-commits/wehliye-store-v8, main, auto deploy on commit.
Build: npm install; npm run build. Start: npm run start.
Latest deployment update_failed. Build passed, startup exits with:
Set ADMIN_PASSWORD (12+ characters) before starting server.
PostgreSQL: wehliye-store-db (dpg-dbhlhpg8v5cc738qc3rg-a), Frankfurt, available.
Database wehliye_store, role wehliye_user, PostgreSQL 18.6.
Read-only SQL confirmed no application tables.
Free database expires 2026-11-28 14:32 UTC; arrange a durable plan before launch.
Database external access currently allows 0.0.0.0/0; restrict after migration.

## Readiness findings
server.mjs reads DB_HOST/DB_PORT/DB_NAME/DB_USER/DB_PASSWORD, ignores DATABASE_URL, and has no explicit TLS configuration.
Use an explicit shared connection configuration supporting DATABASE_URL, connection timeouts, pool error handling, and appropriate TLS.
Render service and database share region/workspace: use the actual internal connection URL from Dashboard for the service.
For local migration use the actual external URL, never the internal hostname.
Render MCP here can inspect/query but cannot read existing service environment variables or return database credentials, so deployed DB settings have not been verified.
Set ADMIN_USER, a unique ADMIN_PASSWORD (12+ characters), PUBLIC_URL=https://wehliye-store-v8.onrender.com and NODE_ENV=production.
Configure GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET and the exact production callback; checkout requires Google login.
PORT is already honored. There is no database readiness endpoint, health check path, graceful shutdown, or explicit Node engine.
Admin sessions and OAuth states are in memory; customer sessions are local files and disappear on redeploy.
Whole JSON state updates have only a process-local lock, allowing lost updates across processes/deploys.
Use database transactions and SELECT FOR UPDATE for all state mutations.
Order validation checks each line independently: repeated product IDs can oversell stock within one order. Aggregate quantity by product before stock checks.
No login rate limit; OAuth state is not tied to a browser session. Harden both before public launch.
API errors expose internal error messages. Add safe error responses and structured server logs.
Payment providers are not integrated; orders are unpaid and shipping is an estimate.
Frontend starts with bundled sample products and suppresses store API failures; do not use visible product count as proof of migration.
README describes old JSON persistence and needs updating.
Syntax checks and TypeScript no-emit validation passed. Render's existing build succeeded; runtime deployment failed.

## Source uncertainty
.env points to 127.0.0.1:5434, which refused a read-only connection both inside and outside the sandbox.
PostgreSQL 17 and 18 Windows services are running, but the correct source instance/port remains unverified.
store-data.json and store-data.backup.json each contain 73 products with 73 unique IDs, zero orders/customers, one embedded image, and zero localhost/file image references.
These files are evidence only; do not silently substitute them for the requested PostgreSQL source.

## Safe migration procedure
1. Identify the correct local PostgreSQL endpoint and verify row 1 of public.store_state is the authoritative source.
2. Pause local product edits while taking the final snapshot. Keep the Render web service from accepting writes during migration.
3. Run: node render-product-migration.mjs export local-store.backup.json
   This uses SOURCE_DATABASE_URL if set, otherwise existing DB_* variables; it only reads PostgreSQL.
   It validates exactly 73 products, IDs, stock, prices, arrays and image references.
   It writes a new private full-state backup without overwriting files and prints SHA-256.
   Keep the backup outside source control; *.backup.json is already ignored. It can contain customer data.
4. Set MIGRATION_TARGET_URL in the current private shell to the database's actual External Database URL from Render Dashboard. Do not paste secrets into chat.
5. Run: node render-product-migration.mjs check local-store.backup.json SHA256_FROM_EXPORT
   This verifies destination hostname/database, requires verified external TLS, checks backup integrity and destination emptiness, and writes nothing to the database.
6. Review the successful check and source snapshot before executing:
   node render-product-migration.mjs apply local-store.backup.json SHA256_FROM_EXPORT
   Do not execute apply as part of preparation alone.
   Apply creates the schema and inserts the 73 products plus storefront content, with empty orders/customers, in one transaction.
   It refuses nonempty destination state, preserves IDs/images/stock, takes a table lock and compares the complete JSONB payload before commit.
   Any failure before commit rolls back schema/data changes. A connection loss around COMMIT has an uncertain outcome: inspect the database before retrying.
7. Independently verify product IDs, prices, stock and images against the snapshot; load /api/store and confirm 73 products after correcting service configuration.
8. Take a destination backup before opening traffic. Retain the source snapshot and local database.
   Before commit, rollback is automatic. After commit, keep traffic closed and review a deliberate restore/removal plan; never delete a state row after customer writes begin.

The tool intentionally refuses existing destination data rather than attempting an unsafe merge.
A new source export is required if products change; any count other than 73 requires review.
It has not been run against the source or destination because source connectivity is unresolved and external credentials are unavailable.

References:
https://render.com/docs/postgresql-creating-connecting
https://render.com/docs/postgresql-backups
