# Local production-hardening validation

Date: 2026-10-29. Scope: local implementation and isolated synthetic-data tests only.

## Implemented
- PostgreSQL customer/admin sessions with hashed bearer tokens, expiry and logout revocation.
- Browser-bound one-use Google OAuth state, PKCE, callback denial handling and provider timeouts.
- Same-origin mutation protection, JSON/body limits, safe API errors and security headers/CSP.
- Persistent login/OAuth/checkout rate limits; conservative explicit proxy trust.
- SELECT FOR UPDATE and a single checked-out client per store mutation transaction.
- Combined product quantity validation across sizes, integer-cent money and idempotent order creation.
- Enforced order transitions and exactly-once stock release on cancellation/30-minute unpaid expiry.
- Transactional Google profile/session creation and all admin store updates.
- Cookie-based admin frontend auth, safe checkout retries, no persisted order/address history in localStorage.
- Logout does not appear successful when server revocation fails.
- Separate additive authentication schema migration; server startup never migrates/seeds.
- DATABASE_URL configuration, production validation, readiness and graceful shutdown.

## Verification
npm test: domain/configuration/security and redacted HTTP errors; isolated database suite skips unless launched by runner.
npm run test:integration: new isolated PostgreSQL 18 cluster, synthetic data, two independent pools/server instances.
Scenarios include concurrent last-item checkout, idempotency, duplicate size lines, concurrent admin/profile-style
updates, atomic rollback including auth writes, cancellation races, expiry maintenance, sessions across server
restart, revoked/expired sessions, OAuth browser mismatch/replay/expiry/PKCE/provider errors, login rate limiting,
malformed/oversized/cross-origin requests and slow request bodies.
npm run build: TypeScript and Vite production build.
npm audit --ignore-scripts: zero known dependency vulnerabilities at inspection.

Product preservation: store-data.json and store-data.backup.json retain their original SHA-256:
2045885d5d90738193d5f1d5309e21789be5b29fdf7b55319bab7e63e1469e61
Both contain 73 unique product IDs. No writes were made to existing local or Render databases.
Design preservation: src/style.css, src/data.ts and index.html are byte-identical.
Admin HTML/CSS before the script tag and storefront JSX tags/attributes/text match the original layout.
Frontend edits affect request/state behavior, not styling or layout. No interactive browser visual test was available.

## Remaining live checks / limitations
- Correct local PostgreSQL source credentials are still required; the requested database source has not been exported.
- Render's existing runtime secrets cannot be read through available MCP capabilities.
- Google Cloud client credentials, exact registered callback, consent audience and real login remain unverified.
  OAuth protocol tests use a mocked Google provider against the real local application and PostgreSQL.
- Render deployment, schema migration, product import, proxy configuration and restart verification await explicit approval.
- Expiry jobs pause while free hosting is asleep; cleanup resumes after wake-up or during checkout/status changes.
- Legacy orders without an expiry stay reserved until manual review/cancellation.
- Existing file sessions are not migrated. Users sign in again after moving to the fixed backend.
- Owner password rotation requires explicit session revocation if immediate logout of existing sessions is required.
- Order/payment selection does not charge money. Tax and shipping-provider integrations remain out of scope.
- Database free-plan expiry and broad external access remain unchanged pending approval.
- Earlier RENDER-MIGRATION-PLAN.md records historical findings; this document describes the current local fixes.

No code was pushed and no cloud resource was modified.
