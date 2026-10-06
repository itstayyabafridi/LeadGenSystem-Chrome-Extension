# Paid lead-generation extension: first release

## Summary

Build a Chrome extension and customer dashboard. Users open Google Maps, launch the extension, enter a business type and target area, and collect up to 200 businesses per search.

The first release includes Maps details, website contact discovery, saved leads, CSV export, accounts, credits, and manually activated subscriptions. Email outreach comes in a later phase.

## Customer experience

- Use a Chrome side panel with business type, target area, lead limit, and Start/Pause/Resume/Stop controls. This uses Chrome's [Side Panel API](https://developer.chrome.com/docs/extensions/reference/api/sidePanel).
- Start a search in the current Maps tab, collect available results sequentially, and display saved, duplicate, skipped, and enriched counts.
- Collect name, category, address, phone, website, rating, review count, opening hours, Maps URL, and collection timestamp. Missing values remain empty.
- Discover public email addresses and social links from each business website. Store their source URLs; describe emails as "found," without claiming deliverability verification.
- Provide a dashboard for lead search, filters, lead details, collection history, CSV export, and subscription/credit status.
- Provide an admin dashboard for activating customers, setting subscription expiry, granting credits, and reviewing usage.

## Implementation

- Create a TypeScript monorepo using WXT and React for the Manifest V3 extension, Next.js for the dashboard/API, Supabase for authentication and PostgreSQL, and a separate Node.js enrichment worker.
- Use email/password authentication with verification and password reset. Each customer has one account. Apply account isolation through server authorization and [Supabase row-level security](https://supabase.com/docs/guides/database/postgres/row-level-security).
- Keep Maps extraction in the tab's content script. Isolate DOM selectors in a replaceable adapter; persist job checkpoints and unsynced records locally.
- Allow one active collection per account. Pause when the tab closes, navigation interrupts collection, connectivity fails, or Maps presents a challenge. Resume requires the user to reopen the job; previously collected businesses are skipped.
- Stop at the requested limit, exhausted results, exhausted credits, or user cancellation. Preserve and export partial results. A requested limit does not guarantee that many results.
- Run website enrichment asynchronously: homepage plus up to four same-domain contact/about pages, bounded timeouts, and at most two retries. Block private-network destinations and unsafe redirects. Enrichment failure preserves the Maps lead.
- Deduplicate within each customer account using a stable Maps identifier where available, otherwise a normalized Maps URL, with name/address fallback.
- Charge one credit only when a new business is successfully saved. Include enrichment and duplicate updates. Make lead insertion and credit deduction atomic and ingestion retries idempotent.
- Add records for customer profiles, entitlements, credit ledger, collection jobs, leads, job-to-lead associations, and enrichment tasks.
- Define shared job, lead, progress, and entitlement types. Expose authenticated APIs for job creation/status, lead ingestion/list/detail/export, and admin entitlement changes. Derive account ownership from authentication.
- Keep privileged credentials server-side. Restrict extension permissions to Maps, local persistence, and the application backend; fetch business websites through the worker.

## Validation and delivery

- Test extraction against Maps DOM fixtures covering missing fields, duplicate results, changed layouts, and exhausted searches.
- Test pause/resume, tab closure, interrupted uploads, retries, and partial exports.
- Test concurrent ingestion, duplicate charging, zero credits, expired subscriptions, and cross-account access denial.
- Test enrichment failures, unsafe destinations, source attribution, and CSV escaping, including spreadsheet formula injection.
- Verify the unpacked extension end to end with test customers and manual activation.
- Deliver database migrations, local setup instructions, an installable extension ZIP, and Docker deployment configuration for the dashboard/API and worker. Start with a private pilot.

## Assumptions and later phases

- Initial interface and supported Maps layout are English; searches may target any location.
- Admins configure customer credit allowances and expiry dates. Automated checkout, public Store publication, and team accounts are deferred.
- Later phases add connected email campaigns, campaign analytics, lead scoring, CRM integrations, and official WhatsApp Business integration.
- Maps DOM extraction requires ongoing maintenance. Google's [Maps terms](https://maps.google.com/help/terms_maps/?hl=en) restrict mass downloading and redistribution; this is a material constraint on the proposed commercial product, and the plan does not imply Google authorization.
