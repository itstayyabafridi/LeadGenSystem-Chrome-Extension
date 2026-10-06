import { describe, expect, it } from 'vitest';
import { csvCell, hasAccess, identityKey, isMapsUrl, jobInputSchema, leadsToCsv, searchUrl, type LeadInput } from '@leadgen/shared';

export const sampleLead: LeadInput = {
  name: 'Riverside Dental', category: 'Dental clinic', address: '12 Canal Road, Lahore', phone: '+92421112233',
  website: 'https://riverside.example', rating: 4.7, review_count: 1234, hours: null,
  maps_url: 'https://www.google.com/maps/place/Riverside/data=!1sChIJriverside', place_id: 'ChIJriverside', collected_at: '2026-10-05T10:00:00.000Z',
};
describe('collection boundaries', () => {
  it('encodes area and business as one search', () => { expect(searchUrl('Dentists & clinics', 'Lahore / Pakistan')).toContain('Dentists%20%26%20clinics%20in%20Lahore%20%2F%20Pakistan'); });
  it('rejects out-of-range limits and empty searches', () => {
    expect(jobInputSchema.safeParse({ business: '  ', area: 'Lahore', limit: 100 }).success).toBe(false);
    expect(jobInputSchema.safeParse({ business: 'Dentists', area: 'Lahore', limit: 201 }).success).toBe(false);
  });
  it('rejects deceptive Maps origins and HTTP', () => {
    expect(isMapsUrl('https://www.google.com.evil.example/maps')).toBe(false);
    expect(isMapsUrl('https://evil.example/?url=https://www.google.com/maps')).toBe(false);
    expect(isMapsUrl('http://www.google.com/maps')).toBe(false);
    expect(isMapsUrl(sampleLead.maps_url)).toBe(true);
  });
  it('uses place identity across viewport and tracking changes', () => {
    expect(identityKey(sampleLead)).toBe(identityKey({ ...sampleLead, maps_url: sampleLead.maps_url + '?hl=en' }));
    const noId = { ...sampleLead, place_id: null, maps_url: 'https://www.google.com/maps/place/A/@31,74,15z/data=!3m1' };
    expect(identityKey(noId)).toBe(identityKey({ ...noId, maps_url: 'https://www.google.com/maps/place/A/@30,73,12z/data=!3m1?hl=en' }));
  });
  it('requires active access and a future expiry', () => {
    const e = { user_id: 'id', credits: 0, active: true, expires_at: '2026-10-06T00:00:00Z' };
    expect(hasAccess(e, Date.parse('2026-10-05T00:00:00Z'))).toBe(true);
    expect(hasAccess({ ...e, active: false })).toBe(false);
    expect(hasAccess({ ...e, expires_at: null })).toBe(false);
    expect(hasAccess(e, Date.parse('2026-10-07T00:00:00Z'))).toBe(false);
  });
});
describe('CSV export', () => {
  it('quotes delimiters, newlines, and quotes', () => { expect(csvCell('Acme, "North"\nBranch')).toBe('"Acme, ""North""\nBranch"'); });
  it.each(['=HYPERLINK("bad")', '+123', '-1+2', '@SUM(A1)', '  =SUM(A1)', '\tphone', '\nformula'])('neutralizes spreadsheet execution: %s', value => { expect(csvCell(value)).toMatch(/^"'/); });
  it('includes a UTF-8 BOM and headers even when empty', () => { expect(leadsToCsv([])).toMatch(/^\uFEFF"Name"/); });
  it('exports partial records without inventing contacts', () => {
    const csv = leadsToCsv([{ ...sampleLead, phone: null, website: null }]);
    expect(csv).toContain('Riverside Dental'); expect(csv.split('\r\n')).toHaveLength(2);
  });
});
