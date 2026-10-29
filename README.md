# WEHLIYE STORE V8 — integrated development build

This package is a **working development baseline**, NOT a finished, payment-ready global commerce deployment.

## Windows PowerShell quick start

Open the folder containing `package.json` (this folder), then:

```powershell
npm install
npm run build
$env:ADMIN_USER="owner"
$env:ADMIN_PASSWORD="replace-with-a-long-unique-password"
npm start
```

Customer storefront: http://localhost:3001  
Owner admin: http://localhost:3001/admin

Admin product edits, content, customer orders, customer profiles, and stock changes persist in `store-data.json` on the server. Orders use **server-side price calculation** and stock checks. Owner can update order status in the admin Orders section.

## Google login (customers ONLY)

Set up Google OAuth **Web application** in Google Cloud Console. Add authorized redirect URI `http://localhost:3001/api/auth/google/callback` for local development. Then run the server with:

```powershell
$env:GOOGLE_CLIENT_ID="your-client-id.apps.googleusercontent.com"
$env:GOOGLE_CLIENT_SECRET="your-client-secret"
$env:PUBLIC_URL="http://localhost:3001"
$env:ADMIN_USER="owner"
$env:ADMIN_PASSWORD="replace-with-a-long-unique-password"
npm start
```

Never put OAuth secrets in frontend code or GitHub. Google OAuth requires Internet and real credentials; it is **not configured or verified** in the delivered zip. Google customer accounts cannot access owner admin. Login sessions persist in `customer-sessions.json` (development only).

## Payment and shipping — NOT LIVE

Orders are **UNPAID** and must be manually confirmed by the owner. No card/mobile money is charged. Do not fulfill orders without independently verifying payment. Real Visa/Mastercard and EVC/ZAAD/eDahab require merchant onboarding, approved provider APIs, secure webhooks, and integration testing. Worldwide shipping fees, duties, availability and tracking require shipping partners. The current $5/free shipping rule is a demo estimate, **not a real worldwide rate**.

## Before public launch

Move the JSON datastore and in-memory admin sessions to managed database and session storage (e.g., PostgreSQL), add transactional stock updates, rate limiting, CSRF defenses, logging, backups, HTTPS, real payment processing, tax/shipping calculations, privacy/returns policies, and end-to-end tests. Admin password must be unique and strong. Product images are stored as data URLs in JSON for demo only; use cloud object storage for production. Do not deploy this server to the public Internet as-is.
