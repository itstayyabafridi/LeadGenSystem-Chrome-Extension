import { mkdir } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
const userId = '11111111-1111-4111-8111-111111111111';
const jobId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const lead = {
  id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', user_id: userId, identity_key: 'place:ChIJriverside',
  name: 'Riverside Dental', category: 'Dental clinic', address: '12 Canal Road, Lahore, Pakistan', phone: '+92 42 1112233',
  website: 'https://riverside.example', rating: 4.7, review_count: 1234, hours: 'Mon–Fri 9am–5pm',
  maps_url: 'https://www.google.com/maps/place/Riverside/data=!1sChIJriverside', place_id: 'ChIJriverside', collected_at: '2026-10-05T10:00:00Z',
  emails: [{ value: 'hello@riverside.example', source_url: 'https://riverside.example/contact' }], socials: [],
  enrichment_status: 'completed', enrichment_error: null, created_at: '2026-10-05T10:00:00Z', updated_at: '2026-10-05T10:00:00Z',
};
const entitlement = { user_id: userId, active: true, expires_at: '2099-01-01T00:00:00Z', credits: 99 };
async function setup(page: Page, admin = false, empty = false) {
  // Test-only browser fixtures; the application never includes seeded demo leads.
  await page.addInitScript(({ userId }) => {
    localStorage.setItem('sb-test-auth-token', JSON.stringify({
      access_token: 'test-access-token', refresh_token: 'test-refresh-token', token_type: 'bearer', expires_at: 4070908800,
      user: { id: userId, email: 'customer@example.com', aud: 'authenticated', role: 'authenticated', app_metadata: {}, user_metadata: {}, created_at: '2026-10-05T00:00:00Z' },
    }));
  }, { userId });
  await page.route('https://test.supabase.co/**', async route => {
    await route.fulfill({ json: { id: userId, email: 'customer@example.com', aud: 'authenticated', role: 'authenticated' } });
  });
  await page.route('**/api/v1/**', async route => {
    const url = new URL(route.request().url()); const path = url.pathname;
    if (path.endsWith('/account')) return route.fulfill({ json: { user_id: userId, email: 'customer@example.com', admin, entitlement, total_leads: empty ? 0 : 1, with_email: empty ? 0 : 1 } });
    if (path.endsWith('/jobs')) return route.fulfill({ json: { jobs: empty ? [] : [{ id: jobId, user_id: userId, business: 'Dental clinics', area: 'Lahore', lead_limit: 100, saved_count: 1, duplicate_count: 0, skipped_count: 0, status: 'completed', reason: 'All available results collected.', created_at: '2026-10-05T10:00:00Z' }] } });
    if (path.endsWith('/leads/export')) return route.fulfill({ contentType: 'text/csv', body: '\uFEFF"Name"\r\n"Riverside Dental"' });
    if (path.endsWith('/leads')) return route.fulfill({ json: { leads: empty ? [] : [lead], total: empty ? 0 : 1, page: 1, page_size: 25 } });
    if (path.endsWith(`/leads/${lead.id}`)) return route.fulfill({ json: lead });
    if (path.endsWith('/admin/customers')) return route.fulfill({ json: { customers: [{ user_id: userId, email: 'customer@example.com', entitlement, created_at: '2026-10-05T00:00:00Z' }] } });
    if (path.endsWith(`/admin/customers/${userId}`)) return route.fulfill({ json: entitlement });
    return route.fulfill({ status: 404, json: { message: 'Test endpoint not found' } });
  });
}

test('authentication views work and fit a mobile viewport', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible();
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Create your workspace' })).toBeVisible();
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByRole('button', { name: 'Forgot your password?' }).click();
  await expect(page.getByRole('button', { name: 'Send reset link' })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await mkdir('artifacts', { recursive: true });
  await page.screenshot({ path: 'artifacts/auth-mobile.png', fullPage: true });
});
test('lead details, email source, and CSV download work', async ({ page }) => {
  await setup(page); await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Your lead library' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Riverside Dental Dental clinic' })).toBeVisible();
  await mkdir('artifacts', { recursive: true });
  await page.screenshot({ path: 'artifacts/workspace-desktop.png', fullPage: true });
  await page.getByRole('button', { name: 'Riverside Dental Dental clinic' }).click();
  await expect(page.getByRole('dialog', { name: 'Riverside Dental' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'View source' })).toHaveAttribute('href', 'https://riverside.example/contact');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const downloaded = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export CSV' }).click();
  expect((await downloaded).suggestedFilename()).toBe('leadgen-leads.csv');
});
test('search and filters are sent to the API', async ({ page }) => {
  await setup(page); await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Your lead library' })).toBeVisible();
  const request = page.waitForRequest(r => r.url().includes('/api/v1/leads?') && new URL(r.url()).searchParams.get('q') === 'dental');
  await page.getByRole('textbox', { name: 'Search leads' }).fill('dental'); await request;
  const filtered = page.waitForRequest(r => new URL(r.url()).searchParams.get('email') === 'true');
  await page.getByRole('checkbox', { name: 'Has email' }).check(); await filtered;
});
test('collections link to saved leads and empty accounts give a useful next step', async ({ page }) => {
  await setup(page); await page.goto('/');
  await page.getByRole('button', { name: 'Collections', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Dental clinics', exact: true })).toBeVisible();
  const request = page.waitForRequest(r => new URL(r.url()).searchParams.get('job') === jobId);
  await page.getByRole('button', { name: 'View leads' }).click(); await request;
  await expect(page.getByText('Showing one collection')).toBeVisible();
});
test('admin can edit subscription access and credit grants', async ({ page }) => {
  await setup(page, true); await page.goto('/');
  await page.getByRole('button', { name: 'Customers', exact: true }).click();
  await page.getByRole('button', { name: 'Manage access' }).click();
  await page.getByRole('spinbutton', { name: 'Credits to add' }).fill('50');
  const request = page.waitForRequest(r => r.method() === 'PATCH' && r.url().includes('/admin/customers/'));
  await page.getByRole('button', { name: 'Save access' }).click();
  expect((await request).postDataJSON()).toMatchObject({ active: true, grant: 50 });
  await expect(page.getByText('Customer access updated.')).toBeVisible();
});
test('empty library and subscription fit mobile without horizontal page overflow', async ({ page }) => {
  await setup(page, false, true); await page.setViewportSize({ width: 390, height: 844 }); await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Your first lead starts with a search' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole('button', { name: 'Subscription', exact: true }).click();
  await expect(page.getByText('Ready for your next search')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: 'artifacts/subscription-mobile.png', fullPage: true });
});
