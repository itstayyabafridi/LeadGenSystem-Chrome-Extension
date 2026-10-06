import { defineConfig } from 'wxt';
import { loadEnv } from 'vite';

const api = process.env.WXT_API_URL || loadEnv('production', process.cwd(), 'WXT_').WXT_API_URL || 'http://localhost:3000';
const origin = new URL(api).origin;
if (new URL(api).protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(new URL(api).hostname)) {
  throw new Error('WXT_API_URL must use HTTPS outside local development');
}
export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: 'LeadGen — Maps to leads',
    description: 'Collect business details from your Google Maps searches and save them to your lead workspace.',
    permissions: ['storage', 'sidePanel', 'activeTab'],
    host_permissions: ['https://www.google.com/maps/*', 'https://maps.google.com/*', `${origin}/*`],
    minimum_chrome_version: '116',
    action: { default_title: 'Open LeadGen' },
  },
});
