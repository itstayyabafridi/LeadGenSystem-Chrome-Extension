import { describe, expect, it, vi } from 'vitest';
import { enrichWebsite, extractContacts, isPublicAddress, parseWebsite } from '../apps/worker/src/enrichment';

describe('public website destinations', () => {
  it.each(['127.0.0.1', '10.0.0.1', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '::1', 'fc00::1', 'fe80::1', '::ffff:127.0.0.1', '0.0.0.0', '224.0.0.1'])('rejects non-public address %s', address => { expect(isPublicAddress(address)).toBe(false); });
  it.each(['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111'])('accepts public address %s', address => { expect(isPublicAddress(address)).toBe(true); });
  it.each(['file:///etc/passwd', 'http://localhost', 'http://127.0.0.1', 'http://[::1]', 'http://0x7f000001', 'http://2130706433', 'http://10.0.0.1', 'https://user:pass@example.com', 'https://example.com:8080'])('rejects unsafe URL %s', url => { expect(() => parseWebsite(url)).toThrow(); });
});
describe('public contact discovery', () => {
  it('finds mailto and visible emails with source attribution, ignoring scripts and image names', () => {
    const result = extractContacts('<p>hello@acme.example</p><a href="mailto:Sales%40acme.example?subject=hi">Email</a><script>secret@acme.example</script><p>logo@2x.png</p><a href="https://instagram.com/acme">Social</a>', 'https://acme.example');
    expect(result.emails.map(e => e.value)).toEqual(['hello@acme.example', 'sales@acme.example']);
    expect(result.emails.every(e => e.source_url === 'https://acme.example')).toBe(true);
    expect(result.socials[0].value).toBe('https://instagram.com/acme');
  });
  it('limits discovery to four same-domain contact/about pages', () => {
    const html = '<a href="https://other.example/contact">Other</a>' + Array.from({ length: 9 }, (_, i) => `<a href="/contact-${i}">Contact ${i}</a>`).join('');
    const pages = extractContacts(html, 'https://acme.example').pages;
    expect(pages).toHaveLength(4); expect(pages.every(p => p.startsWith('https://acme.example/'))).toBe(true);
  });
  it('preserves homepage contacts when a contact page fails', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce({ html: '<p>hello@acme.example</p><a href="/contact">Contact</a>', url: 'https://acme.example/' }).mockRejectedValueOnce(new Error('timeout'));
    const result = await enrichWebsite('https://acme.example', fetcher);
    expect(result.emails).toEqual([{ value: 'hello@acme.example', source_url: 'https://acme.example/' }]); expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('returns empty contacts for a readable site without public emails', async () => {
    expect(await enrichWebsite('https://acme.example', async () => ({ html: '<h1>Acme</h1>', url: 'https://acme.example' }))).toEqual({ emails: [], socials: [] });
  });
});
