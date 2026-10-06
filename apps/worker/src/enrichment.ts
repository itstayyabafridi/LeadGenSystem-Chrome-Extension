import { lookup } from 'node:dns/promises';
import type { LookupAddress } from 'node:dns';
import ipaddr from 'ipaddr.js';
import { Agent, request } from 'undici';
import * as cheerio from 'cheerio';
import type { Contact } from '@leadgen/shared';

export function isPublicAddress(address: string): boolean {
  try { return ipaddr.process(address).range() === 'unicast'; } catch { return false; }
}
export function parseWebsite(value: string): URL {
  const url = new URL(value);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('Unsupported website URL');
  if (url.port && !['80', '443'].includes(url.port)) throw new Error('Unsupported website port');
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || !host.includes('.') && !ipaddr.isValid(host)) throw new Error('Private website destination');
  if (ipaddr.isValid(host) && !isPublicAddress(host)) throw new Error('Private website destination');
  return url;
}
export function sameWebsite(a: URL, b: URL): boolean {
  return a.hostname.toLowerCase().replace(/^www\./, '') === b.hostname.toLowerCase().replace(/^www\./, '');
}

/** DNS is validated AND pinned to the connection, including every redirect. */
export async function fetchHtml(value: string, root?: URL): Promise<{ html: string; url: string }> {
  let url = parseWebsite(value);
  const boundary = root || url;
  const signal = AbortSignal.timeout(10000);
  for (let redirects = 0; redirects <= 3; redirects++) {
    if (!sameWebsite(boundary, url)) throw new Error('Website redirected outside its domain');
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    const records = await new Promise<LookupAddress[]>((resolve, reject) => {
      const abort = () => reject(new Error('Website DNS lookup timed out'));
      if (signal.aborted) { abort(); return; }
      signal.addEventListener('abort', abort, { once: true });
      void lookup(hostname, { all: true }).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    });
    if (!records.length || records.some(r => !isPublicAddress(r.address))) throw new Error('Private website destination');
    const selected = records[0];
    const dispatcher = new Agent({ connect: {
      autoSelectFamily: false,
      timeout: 10000,
      lookup: (_hostname, _options, callback) => callback(null, selected.address, selected.family),
    } });
    try {
      const response = await request(url, {
        dispatcher,
        signal,
        headersTimeout: 10000,
        bodyTimeout: 10000,
        headers: { 'user-agent': 'LeadGenContactDiscovery/0.1', accept: 'text/html,application/xhtml+xml' },
      });
      if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
        const location = response.headers.location;
        response.body.destroy();
        if (!location || Array.isArray(location) || redirects === 3) throw new Error('Too many or invalid website redirects');
        url = parseWebsite(new URL(location, url).href);
        continue;
      }
      if (response.statusCode < 200 || response.statusCode >= 300) { response.body.destroy(); throw new Error(`Website returned HTTP ${response.statusCode}`); }
      const type = String(response.headers['content-type'] || '').toLowerCase();
      if (!type.includes('text/html') && !type.includes('application/xhtml+xml')) { response.body.destroy(); throw new Error('Website did not return HTML'); }
      let size = 0;
      const chunks: Buffer[] = [];
      for await (const chunk of response.body) {
        const data = Buffer.from(chunk);
        size += data.length;
        if (size > 2 * 1024 * 1024) { response.body.destroy(); throw new Error('Website page exceeds 2 MB'); }
        chunks.push(data);
      }
      return { html: Buffer.concat(chunks).toString('utf8'), url: url.href };
    } finally { await dispatcher.close(); }
  }
  throw new Error('Too many website redirects');
}

const socialHosts = ['facebook.com', 'instagram.com', 'linkedin.com', 'twitter.com', 'x.com', 'youtube.com', 'tiktok.com'];
export function extractContacts(html: string, source: string): { emails: Contact[]; socials: Contact[]; pages: string[] } {
  const $ = cheerio.load(html);
  $('script,style,noscript').remove();
  const emails = new Set<string>();
  const socials = new Set<string>();
  const pages = new Set<string>();
  const root = new URL(source);
  const addEmail = (value: string) => {
    const email = value.trim().toLowerCase();
    if (/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i.test(email) && !/\.(png|jpe?g|webp|gif|svg|avif)$/i.test(email) && email.length <= 254) emails.add(email);
  };
  const textNodes: string[] = [];
  $('*').contents().each((_, node) => { if (node.type === 'text') textNodes.push(node.data); });
  const visible = textNodes.join(' ');
  for (const email of visible.match(/[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+/gi) || []) addEmail(email);
  $('a[href]').each((_, element) => {
    const href = $(element).attr('href') || '';
    if (/^mailto:/i.test(href)) {
      try { decodeURIComponent(href.slice(7).split('?')[0]).split(/[;,]/).forEach(addEmail); } catch { /* Ignore malformed links. */ }
      return;
    }
    try {
      const url = new URL(href, source);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return;
      url.hash = '';
      if (socialHosts.some(host => url.hostname === host || url.hostname.endsWith(`.${host}`))) socials.add(url.href);
      if (sameWebsite(root, url) && /contact|about|reach|get.in.touch/i.test(`${url.pathname} ${$(element).text()}`)) pages.add(url.href);
    } catch { /* Ignore malformed links. */ }
  });
  return {
    emails: [...emails].slice(0, 50).map(value => ({ value, source_url: source })),
    socials: [...socials].slice(0, 30).map(value => ({ value, source_url: source })),
    pages: [...pages].filter(p => p !== source).slice(0, 4),
  };
}

export async function enrichWebsite(website: string, fetcher = fetchHtml): Promise<{ emails: Contact[]; socials: Contact[] }> {
  const root = parseWebsite(website);
  const home = await fetcher(root.href, root);
  const found = extractContacts(home.html, home.url);
  const results = [found];
  for (const page of found.pages) {
    try {
      const result = await fetcher(page, root);
      results.push(extractContacts(result.html, result.url));
    } catch { /* A broken contact page does not discard contacts already found. */ }
  }
  const unique = (contacts: Contact[]) => [...new Map(contacts.map(c => [c.value, c])).values()];
  return { emails: unique(results.flatMap(r => r.emails)), socials: unique(results.flatMap(r => r.socials)) };
}
