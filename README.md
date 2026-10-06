# LeadGenSystem

A Chrome extension and customer dashboard for collecting Google Maps business details, discovering public website contacts, and exporting lead lists. The implementation follows [plan.md](plan.md).

## What is implemented

- A Manifest V3 Chrome side panel with business/area search, a 1–200 lead limit, progress, pause/resume/stop, and CSV export.
- Checkpoints and pending uploads persisted before network requests. Retried uploads use the same request ID to prevent double charging.
- A responsive dashboard with email/password registration, email verification, password reset, lead search and filters, contact source links, collection history, subscription status, and customer administration.
- Account-isolated PostgreSQL tables and guarded server RPCs for one active collection, deduplication, credit charging, and manual subscription activation.
- A separate contact discovery worker with leased tasks, three total attempts, bounded HTML fetches, public-address validation, DNS pinning, and source attribution.
- Unpacked extension and ZIP packaging, Docker deployment files, and automated tests.

Email outreach, WhatsApp, automated checkout, CRM integrations, shared team accounts, and Chrome Web Store publication are deferred. There are no fabricated leads or demo accounts in the application.

## Local setup

Use Node.js 24 LTS, npm, Chrome 116 or newer, and a Supabase project. Install dependencies from the repository root:

```powershell
npm ci
Copy-Item apps/web/.env.example apps/web/.env.local
Copy-Item apps/worker/.env.example apps/worker/.env
Copy-Item apps/extension/.env.example apps/extension/.env
```

Fill in the environment files:

| File | Required values |
| --- | --- |
| `apps/web/.env.local` | Supabase project URL, public anon key, server-only service-role key, and allowed origins |
| `apps/worker/.env` | Supabase project URL and server-only service-role key |
| `apps/extension/.env` | `WXT_API_URL`, initially `http://localhost:3000` |

Never put the service-role key in the extension or a `NEXT_PUBLIC_*` variable. The extension communicates with the authenticated application API, not privileged Supabase endpoints.

In the Supabase SQL Editor, run [the initial migration](supabase/migrations/202610050001_initial.sql) once. Alternatively, link the project with the Supabase CLI and run `supabase db push`. The migration also provisions profiles and inactive entitlements for pre-existing auth users.

In Supabase Authentication settings:

1. Enable email/password sign-in and email confirmations.
2. Set the Site URL to `http://localhost:3000`.
3. Allow `http://localhost:3000` as an email verification/password reset redirect URL.
4. Configure an email provider for delivery when moving beyond local testing.

Run the dashboard and worker in separate terminals:

```powershell
npm run dev
```

```powershell
npm run dev:worker
```

Visit `http://localhost:3000`, create your account, and confirm the verification email. Before configuring Supabase, the application shows a setup-required sign-in screen; it cannot save leads without a database.

### Create the first administrator

After creating and verifying your owner account, run this in the Supabase SQL Editor with your actual email:

```sql
insert into public.admins(user_id)
select id from auth.users where email = 'owner@yourcompany.com'
on conflict do nothing;
```

Refresh the dashboard. Open **Customers**, choose **Manage access**, set a future expiry date, and grant credits to the customer account that will use the extension. Each new account starts inactive with zero credits. Expiry dates entered in the admin form are interpreted as the end of that day in UTC.

### Install the extension

```powershell
npm run zip:extension
```

1. Open `chrome://extensions`, enable **Developer mode**, and click **Load unpacked**.
2. Select `apps/extension/.output/chrome-mv3`.
3. Copy the installed extension ID. Add its exact origin to `ALLOWED_ORIGINS` in `apps/web/.env.local`, for example:

   ```dotenv
   ALLOWED_ORIGINS=http://localhost:3000,chrome-extension://your-actual-extension-id
   ```

4. Restart the dashboard after changing the environment file.
5. Open `https://www.google.com/maps?hl=en`, click the extension icon, and sign in.
6. Enter a business type and area, set a lead limit, and start collection.

`npm run dev:extension` is also available for development with WXT. Reload pre-existing Maps tabs if Chrome has not injected the newly installed content script.

The ZIP is generated at `apps/extension/.output/leadgenextension-0.1.0-chrome.zip` and copied to `apps/web/public/downloads/leadgen-extension.zip`. The dashboard then exposes a download link. A private-pilot ZIP must be extracted and loaded as an unpacked extension; it is not a one-click Web Store installation.

### Collection and recovery behavior

- A collection searches in its assigned Google Maps tab. Leave the tab available while collection runs. Details come from the currently rendered English Maps layout.
- Limits apply to unique businesses associated with that search, including businesses already in the account. Only first-time saves deduct credits.
- Paused collections still occupy the account's active collection slot. Resume or stop them before starting another.
- Closing the tab, restarting Chrome, changing the search, exhausting credits, or encountering a Maps challenge pauses collection. Challenges must be handled manually.
- Pending uploads retain their request IDs. Resume retries them before proceeding. A lost response after a successful database commit will not incur another charge.
- Stopping with an unknown network outcome requires reconnecting first. If the server rejects an upload because access expired, credits ran out, or the job was already stopped, its record is retained locally and can be downloaded using **Download recovery CSV**. It is not silently treated as a saved cloud lead.
- Local recovery records are scoped to their account and preserved when a new collection starts. Removing the extension or clearing its local storage removes local-only recovery data.
- Website enrichment continues on the server after Maps collection finishes. It reads the homepage and up to four same-domain contact/about pages; it does not execute website JavaScript or log into websites. Contacts may therefore be absent even when a business has a website.
- CSV export uses currently selected dashboard filters. Exports include email/social sources and escape spreadsheet formula prefixes.

## Verification

```powershell
npm test
npm run typecheck
npm run test:browser
npm run build
```

The default suite executes the actual SQL migration and transactions in an embedded PostgreSQL instance (PGlite), exercises extraction fixtures and recovery, checks public website fetch boundaries, and tests API authorization/validation and multi-page CSV exports. The embedded database substitutes only the surrounding Supabase auth schema and does not require cloud credentials.

Browser checks run an isolated Next.js dev server on port 3100 using test-only authentication and API fixtures. They test dashboard interactions and mobile layout, not a live Supabase deployment. On Windows they use installed Chrome; elsewhere install Chromium with `npx playwright install chromium`, or set `PLAYWRIGHT_CHROMIUM_EXECUTABLE` to your browser executable. Screenshots are written to `artifacts/`.

For concurrency across real database connections and actual Supabase RLS, use a disposable Supabase project with the migration applied:

```powershell
$env:TEST_SUPABASE_URL = 'https://your-test-project.supabase.co'
$env:TEST_SUPABASE_ANON_KEY = 'your-test-public-key'
$env:TEST_SUPABASE_SERVICE_ROLE_KEY = 'your-test-service-role-key'
npm run test:db
```

That script creates uniquely named test accounts, checks concurrent duplicate ingestion and unauthorized reads/RPCs, and deletes its test accounts afterward. It never falls back to application credentials.

Before a live pilot, run a small English Maps search with a configured account, verify the saved fields against the listings, retry a paused job, and confirm website enrichment and CSV output. Live Maps/Supabase verification requires real project configuration and is separate from the automated fixture tests.

## Deployment

Copy the root `.env.example` to `.env` and supply the production Supabase values, public HTTPS application URL, and exact allowed dashboard/extension origins. Update Supabase Site URL and allowed redirect URLs for the production domain. Then:

```powershell
docker compose up --build -d
```

The dashboard is bound to `127.0.0.1:3000`; place it behind your HTTPS reverse proxy. The worker runs separately and can restart without losing tasks. Public Supabase values and the extension API URL are build-time inputs; rebuild after changing them. The service-role key is supplied only at runtime to the server and worker.

Monitor worker logs, failed enrichment tasks, subscription changes in `credit_ledger`, and collections stuck in a paused state. Review representative Maps fixtures whenever Google changes its interface. Add your normal database backup policy before taking customer payments.

## API reference

All endpoints except login/refresh require `Authorization: Bearer <Supabase access token>`. Customer ownership is derived from the verified token. Admin endpoints additionally require an entry in `public.admins`.

| Method | Endpoint | Purpose |
| --- | --- | --- |
| POST | `/api/v1/auth/login` | Sign in with email and password |
| POST | `/api/v1/auth/refresh` | Refresh the extension session |
| GET | `/api/v1/account` | Account, entitlement, admin status, and lead counts |
| GET / POST | `/api/v1/jobs` | Recent jobs / create a search with `business`, `area`, and `limit` |
| GET / PATCH | `/api/v1/jobs/:id` | Read or control a customer-owned collection |
| POST | `/api/v1/jobs/:id/leads` | Ingest `{ request_id, lead }` idempotently |
| GET | `/api/v1/leads` | Paginated leads; `q`, `email`, `rating`, `job`, `page` filters |
| GET | `/api/v1/leads/:id` | Lead details and contact source URLs |
| GET | `/api/v1/leads/export` | Stream filtered CSV without database page truncation |
| GET | `/api/v1/admin/customers` | Latest 100 customers and their entitlements |
| PATCH | `/api/v1/admin/customers/:id` | Set `{ active, expires_at, grant }` and audit the change |

## Current limits

Maps may expose fewer businesses than requested, and DOM selectors need ongoing maintenance. Only English Maps layouts on `www.google.com/maps` and `maps.google.com` are supported initially. Contact discovery collects public information and does not verify deliverability.

Google's [Maps terms](https://maps.google.com/help/terms_maps/?hl=en) restrict mass downloading and redistribution. The implementation does not imply Google authorization or guarantee Chrome Web Store acceptance.
