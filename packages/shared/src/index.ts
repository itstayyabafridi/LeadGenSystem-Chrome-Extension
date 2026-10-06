import { z } from 'zod';

export const JOB_STATUSES = ['running', 'paused', 'completed', 'stopped', 'failed'] as const;
export type JobStatus = typeof JOB_STATUSES[number];
export const jobInputSchema = z.object({
  business: z.string().trim().min(2).max(120),
  area: z.string().trim().min(2).max(180),
  limit: z.number().int().min(1).max(200),
});
const webUrl = z.string().url().max(4096).refine(v => ['http:', 'https:'].includes(new URL(v).protocol), 'HTTP(S) URL required');
export const leadInputSchema = z.object({
  name: z.string().trim().min(1).max(500),
  category: z.string().max(500).nullable().default(null),
  address: z.string().max(2000).nullable().default(null),
  phone: z.string().max(100).nullable().default(null),
  website: webUrl.nullable().default(null),
  rating: z.number().min(0).max(5).nullable().default(null),
  review_count: z.number().int().nonnegative().nullable().default(null),
  hours: z.string().max(4000).nullable().default(null),
  maps_url: webUrl.refine(isMapsUrl, 'A Google Maps listing URL is required'),
  place_id: z.string().max(300).nullable().default(null),
  collected_at: z.string().datetime(),
});
export type LeadInput = z.infer<typeof leadInputSchema>;
export interface Contact { value: string; source_url: string }
export interface Lead extends LeadInput {
  id: string;
  user_id: string;
  identity_key: string;
  emails: Contact[];
  socials: Contact[];
  enrichment_status: 'pending' | 'running' | 'completed' | 'failed' | 'not_available';
  enrichment_error: string | null;
  created_at: string;
  updated_at: string;
}
export interface Job {
  id: string;
  user_id: string;
  business: string;
  area: string;
  lead_limit: number;
  status: JobStatus;
  saved_count: number;
  duplicate_count: number;
  skipped_count: number;
  reason: string | null;
  created_at: string;
  updated_at: string;
}
export interface Entitlement { user_id: string; credits: number; expires_at: string | null; active: boolean }
export interface IngestResult { lead_id: string; duplicate: boolean; credits: number; saved_count: number; duplicate_count: number }
export interface Session { access_token: string; refresh_token: string; expires_at: number; user: { id: string; email?: string } }
export interface Checkpoint {
  job: Job;
  tabId: number;
  visited: string[];
  pending: { requestId: string; lead: LeadInput } | null;
  reason: string | null;
  startedAt: number;
  controlPending: boolean;
}
export interface ExtensionState { checkpoint: Checkpoint | null; accountId: string | null; email: string | null; unsynced_count?: number }

export function isMapsUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === 'https:' && ((u.hostname === 'www.google.com' && (u.pathname === '/maps' || u.pathname.startsWith('/maps/'))) || u.hostname === 'maps.google.com');
  } catch { return false; }
}
export function searchUrl(business: string, area: string): string {
  return `https://www.google.com/maps/search/${encodeURIComponent(`${business} in ${area}`)}?hl=en`;
}
export function canonicalMapsUrl(value: string): string {
  const u = new URL(value);
  u.search = '';
  u.hash = '';
  // Viewport movement must not create another business identity.
  u.pathname = u.pathname.replace(/\/@[^/]+/, '').replace(/\/$/, '');
  return u.toString();
}
export function identityKey(lead: Pick<LeadInput, 'place_id' | 'maps_url' | 'name' | 'address'>): string {
  if (lead.place_id) return `place:${lead.place_id}`;
  if (lead.maps_url) return `maps:${canonicalMapsUrl(lead.maps_url)}`;
  return `address:${[lead.name, lead.address ?? ''].map(s => s.trim().toLowerCase().replace(/\s+/g, ' ')).join('|')}`;
}
export function hasAccess(entitlement: Entitlement | null, now = Date.now()): boolean {
  return !!entitlement?.active && !!entitlement.expires_at && Date.parse(entitlement.expires_at) > now;
}
export function csvCell(value: unknown): string {
  let s = value == null ? '' : String(value);
  if (/^[\s\u0000-\u001f]*[=+@-]/.test(s) || /^[\t\r\n]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}
export function leadsToCsv(leads: LeadInput[] | Lead[]): string {
  const headers = ['Name', 'Category', 'Address', 'Phone', 'Website', 'Rating', 'Review count', 'Hours', 'Maps URL', 'Emails', 'Email sources', 'Social links', 'Social sources', 'Collected at'];
  const rows = leads.map(l => {
    const full = l as Partial<Lead>;
    return [l.name, l.category, l.address, l.phone, l.website, l.rating, l.review_count, l.hours, l.maps_url,
      full.emails?.map(c => c.value).join('; '), full.emails?.map(c => c.source_url).join('; '),
      full.socials?.map(c => c.value).join('; '), full.socials?.map(c => c.source_url).join('; '), l.collected_at].map(csvCell).join(',');
  });
  return '\uFEFF' + [headers.map(csvCell).join(','), ...rows].join('\r\n');
}
