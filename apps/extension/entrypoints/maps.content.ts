import { browser } from 'wxt/browser';
import { defineContentScript } from 'wxt/utils/define-content-script';
import type { Checkpoint } from '@leadgen/shared';
import { send } from '../lib/protocol';
import { challengeDetected, extractListing, listingKey, resultCandidates, resultsExhausted } from '../lib/maps-adapter';

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
export default defineContentScript({
  matches: ['https://www.google.com/maps/*', 'https://maps.google.com/*'],
  runAt: 'document_idle',
  main(ctx) {
    let halted = false;
    let running = false;
    browser.runtime.onMessage.addListener(message => { if (message.type === 'HALT') halted = true; });
    ctx.onInvalidated(() => { halted = true; });
    async function waitFor(test: () => boolean, timeout = 15000): Promise<boolean> {
      const end = Date.now() + timeout;
      while (!halted && Date.now() < end) { if (test()) return true; await delay(250); }
      return false;
    }
    async function collect(cp: Checkpoint) {
      if (running) return;
      running = true;
      halted = false;
      const visited = new Set(cp.visited);
      let collected = cp.job.saved_count + cp.job.duplicate_count;
      let stalls = 0;
      let skippedStreak = 0;
      try {
        if (!await waitFor(() => !!document.querySelector('[role="feed"]') || resultsExhausted(document) || challengeDetected(document))) {
          await send({ type: 'INTERRUPT', reason: 'Maps results did not load. Check the page and resume.' }); return;
        }
        while (!halted && collected < cp.job.lead_limit) {
          if (challengeDetected(document)) { await send({ type: 'INTERRUPT', reason: 'Maps needs your attention. Complete the prompt manually, then resume.' }); return; }
          const candidate = resultCandidates(document).find(c => !visited.has(c.key));
          if (!candidate) {
            if (resultsExhausted(document)) { await send({ type: 'FINISH', reason: 'All available search results collected.' }); return; }
            const feed = document.querySelector<HTMLElement>('[role="feed"]');
            if (!feed) { await send({ type: 'INTERRUPT', reason: 'The Maps results list is no longer visible. Reopen your search and resume.' }); return; }
            feed.scrollBy({ top: Math.max(feed.clientHeight, 600), behavior: 'instant' });
            await delay(1800);
            if (++stalls >= 8) { await send({ type: 'INTERRUPT', reason: 'Maps stopped loading additional results. Check the page, then resume or stop.' }); return; }
            continue;
          }
          stalls = 0;
          candidate.element.click();
          const loaded = await waitFor(() => {
            const heading = document.querySelector('h1.DUwDvf, [role="main"] h1, h1')?.textContent?.trim();
            return !!heading && (!candidate.name || heading === candidate.name);
          });
          if (halted) break;
          await delay(650);
          const lead = loaded ? extractListing(document, candidate.url) : null;
          if (!lead) {
            visited.add(candidate.key);
            await send({ type: 'SKIP', key: candidate.key });
            if (++skippedStreak >= 3) { await send({ type: 'INTERRUPT', reason: 'Several business details could not be read. Check Maps before resuming.' }); return; }
            continue;
          }
          skippedStreak = 0;
          const result = await send<{ saved_count: number; duplicate_count: number } | null>({ type: 'RECORD', lead });
          visited.add(candidate.key);
          visited.add(listingKey(lead));
          if (result && 'saved_count' in result) collected = result.saved_count + result.duplicate_count;
          if (!result) break;
          await delay(1100);
        }
      } catch (error) {
        if (!halted) await send({ type: 'INTERRUPT', reason: error instanceof Error ? error.message.slice(0, 500) : 'Collection interrupted.' }).catch(() => {});
      } finally { running = false; }
    }
    void send<Checkpoint | null>({ type: 'READY' }).then(cp => { if (cp) void collect(cp); }).catch(() => {});
    // Maps uses client-side navigation. Detect leaving Maps without relying on worker lifetime.
    let previous = location.href;
    const navigationCheck = setInterval(() => {
      if (!running || location.href === previous) return;
      previous = location.href;
      if (!location.pathname.startsWith('/maps')) {
        halted = true;
        void send({ type: 'INTERRUPT', reason: 'You navigated away from Maps. Reopen Maps and resume.' }).catch(() => {});
      }
    }, 1000);
    ctx.onInvalidated(() => clearInterval(navigationCheck));
  },
});
