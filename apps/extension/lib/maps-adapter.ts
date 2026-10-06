import { canonicalMapsUrl, identityKey, type LeadInput } from '@leadgen/shared';

export interface Candidate { url: string; name: string; key: string; element: HTMLAnchorElement }
export function placeId(url: string): string | null {
  try {
    const u = new URL(url);
    const direct = u.searchParams.get('query_place_id');
    if (direct) return direct;
    const feature = u.pathname.match(/!1s([^!/?]+)/)?.[1];
    return feature ? decodeURIComponent(feature) : null;
  } catch { return null; }
}
export function candidateKey(url: string): string {
  const id = placeId(url);
  return id ? `place:${id}` : `maps:${canonicalMapsUrl(url)}`;
}
export function resultCandidates(doc: Document): Candidate[] {
  const seen = new Set<string>();
  return [...doc.querySelectorAll<HTMLAnchorElement>('[role="feed"] a[href*="/maps/place/"]')].flatMap(element => {
    const url = element.href;
    const key = candidateKey(url);
    if (seen.has(key)) return [];
    seen.add(key);
    return [{ url, key, name: element.getAttribute('aria-label') || element.textContent?.trim() || '', element }];
  });
}
const clean = (value: string | null | undefined): string | null => value?.replace(/^[\s\uE000-\uF8FF]+/, '').trim() || null;
const labelValue = (element: Element | null, prefix: RegExp): string | null => clean(element?.getAttribute('aria-label')?.replace(prefix, '') || element?.textContent);
export function extractListing(doc: Document, mapsUrl: string): LeadInput | null {
  const name = clean(doc.querySelector('h1.DUwDvf, [role="main"] h1, h1')?.textContent);
  if (!name) return null;
  const websiteElement = doc.querySelector<HTMLAnchorElement>('a[data-item-id="authority"]');
  let website = websiteElement?.href || null;
  if (website) {
    try {
      const url = new URL(website);
      if (url.hostname === 'www.google.com' && url.pathname === '/url') website = url.searchParams.get('q') || url.searchParams.get('url');
      if (website && !['https:', 'http:'].includes(new URL(website).protocol)) website = null;
    } catch { website = null; }
  }
  const ratingElement = doc.querySelector('[role="img"][aria-label*="stars"], [aria-label*=" stars"]');
  const ratingText = ratingElement?.getAttribute('aria-label')?.match(/([0-5](?:\.\d+)?)\s+stars/i)?.[1]
    || doc.querySelector('.F7nice span[aria-hidden="true"]')?.textContent?.match(/^[0-5](?:\.\d+)?$/)?.[0];
  const reviewElement = doc.querySelector('[aria-label*="reviews"], [aria-label*="Reviews"]');
  const reviewsText = reviewElement?.getAttribute('aria-label')?.match(/([\d,]+)\s+reviews/i)?.[1];
  const hoursElement = doc.querySelector('[data-item-id="oh"], [aria-label^="Hours"], [aria-label^="Open hours"]');
  return {
    name,
    category: clean(doc.querySelector('button[jsaction*="category"], button.DkEaL')?.textContent),
    address: labelValue(doc.querySelector('[data-item-id="address"]'), /^Address:\s*/i),
    phone: labelValue(doc.querySelector('[data-item-id^="phone:tel:"]'), /^Phone:\s*/i),
    website,
    rating: ratingText ? Number(ratingText) : null,
    review_count: reviewsText ? Number(reviewsText.replace(/,/g, '')) : null,
    hours: labelValue(hoursElement, /^(?:Open )?Hours:\s*/i),
    maps_url: mapsUrl,
    place_id: placeId(mapsUrl),
    collected_at: new Date().toISOString(),
  };
}
export function listingKey(lead: LeadInput): string { return identityKey(lead); }
export function challengeDetected(doc: Document): boolean {
  return !!doc.querySelector('form[action*="/sorry/"], iframe[src*="recaptcha"], #captcha-form') || /unusual traffic|verify you are human/i.test(doc.body?.innerText || '');
}
export function resultsExhausted(doc: Document): boolean {
  const text = doc.querySelector('[role="feed"]')?.textContent || doc.body?.textContent || '';
  return /you(?:'|’)?ve reached the end of the list|no results found|couldn(?:'|’)?t find/i.test(text);
}
