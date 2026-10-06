import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import { challengeDetected, extractListing, placeId, resultCandidates, resultsExhausted } from '../apps/extension/lib/maps-adapter';

const documentFrom = (html: string) => new JSDOM(html, { url: 'https://www.google.com/maps/search/dentists' }).window.document;
describe('English Maps adapter', () => {
  const fixture = readFileSync(new URL('./fixtures/maps-detail.html', import.meta.url), 'utf8');
  it('extracts detail fields and normalizes review counts', () => {
    const lead = extractListing(documentFrom(fixture), 'https://www.google.com/maps/place/Riverside/data=!1sChIJriverside');
    expect(lead).toMatchObject({ name: 'Riverside Dental', category: 'Dental clinic', address: '12 Canal Road, Lahore', phone: '+92 42 1112233', website: 'https://riverside.example/', rating: 4.7, review_count: 1234, hours: 'Monday–Friday 9am–5pm', place_id: 'ChIJriverside' });
  });
  it('deduplicates repeated links in the feed', () => { expect(resultCandidates(documentFrom(fixture))).toHaveLength(2); });
  it('detects exhausted searches', () => { expect(resultsExhausted(documentFrom(fixture))).toBe(true); expect(resultsExhausted(documentFrom('<div role="feed">No results found</div>'))).toBe(true); });
  it('keeps absent optional fields null', () => {
    expect(extractListing(documentFrom('<h1 class="DUwDvf">Small Shop</h1>'), 'https://www.google.com/maps/place/Small')).toMatchObject({ phone: null, website: null, rating: null, review_count: null, hours: null });
  });
  it('fails safely when the listing heading is absent', () => { expect(extractListing(documentFrom('<main>Changed layout</main>'), 'https://www.google.com/maps/place/A')).toBeNull(); });
  it('detects a captcha without attempting to solve it', () => { expect(challengeDetected(documentFrom('<form id="captcha-form"></form>'))).toBe(true); });
  it('extracts query and encoded feature identifiers', () => { expect(placeId('https://www.google.com/maps/place/A?query_place_id=ChIJabc')).toBe('ChIJabc'); expect(placeId('https://www.google.com/maps/place/A/data=!1s0x123%3A0x456!2m')).toBe('0x123:0x456'); });
  it('does not accept javascript websites', () => { expect(extractListing(documentFrom('<h1>A</h1><a data-item-id="authority" href="javascript:alert(1)">Website</a>'), 'https://www.google.com/maps/place/A')?.website).toBeNull(); });
});
