import { browser } from 'wxt/browser';
import { defineBackground } from 'wxt/utils/define-background';
import { identityKey, isMapsUrl, jobInputSchema, leadInputSchema, searchUrl, type Checkpoint, type ExtensionState, type IngestResult, type Job, type JobStatus, type Session } from '@leadgen/shared';
import type { ContentCommand, PanelCommand } from '../lib/protocol';

const API = (import.meta.env.WXT_API_URL || 'http://localhost:3000').replace(/\/$/, '');
class BackendError extends Error { constructor(public code: string, message: string) { super(message); } }

export default defineBackground(() => {
  // Content scripts must never be able to read access or refresh tokens.
  void browser.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  void browser.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  let queue: Promise<unknown> = Promise.resolve();
  const serialize = <T>(fn: () => Promise<T>): Promise<T> => {
    const result = queue.then(fn, fn);
    queue = result.catch(() => {});
    return result;
  };
  const read = async () => await browser.storage.local.get(['session', 'checkpoint']) as { session?: Session; checkpoint?: Checkpoint };
  const save = async (checkpoint: Checkpoint) => { await browser.storage.local.set({ checkpoint }); };
  async function raw(path: string, method = 'GET', body?: unknown, token?: string): Promise<Response> {
    let response: Response;
    try {
      response = await fetch(`${API}/api/v1/${path}`, {
        method, headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20000),
      });
    } catch { throw new BackendError('offline', 'Could not reach the server. Check your connection and resume to retry.'); }
    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: 'server_error', message: 'The server could not complete this action.' }));
      throw new BackendError(error.error, error.message);
    }
    return response;
  }
  async function session(): Promise<Session> {
    let { session: current } = await read();
    if (!current) throw new BackendError('unauthorized', 'Sign in to collect leads.');
    if (current.expires_at * 1000 < Date.now() + 60000) {
      current = await (await raw('auth/refresh', 'POST', { refresh_token: current.refresh_token })).json() as Session;
      await browser.storage.local.set({ session: current });
    }
    return current;
  }
  async function api<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
    const current = await session();
    return await (await raw(path, method, body, current.access_token)).json() as T;
  }
  async function syncControl(cp: Checkpoint) {
    try {
      cp.job = await api<Job>(`jobs/${cp.job.id}`, 'PATCH', { status: cp.job.status, reason: cp.reason, skipped_count: cp.job.skipped_count });
      cp.controlPending = false;
    } catch (error) {
      cp.controlPending = true;
      if (error instanceof BackendError && ['job_is_terminal', 'job_not_active'].includes(error.code)) {
        try { cp.job = await api<Job>(`jobs/${cp.job.id}`); cp.controlPending = false; } catch { /* Preserve for manual recovery. */ }
      }
    }
    await save(cp);
  }
  async function halt(cp: Checkpoint, status: JobStatus, reason: string) {
    cp.job.status = status;
    cp.reason = reason;
    cp.controlPending = true;
    await save(cp);
    await browser.tabs.sendMessage(cp.tabId, { type: 'HALT' }).catch(() => {});
    await syncControl(cp);
  }
  async function flush(cp: Checkpoint): Promise<IngestResult | null> {
    if (!cp.pending) return null;
    const pending = cp.pending;
    const result = await api<IngestResult>(`jobs/${cp.job.id}/leads`, 'POST', { request_id: pending.requestId, lead: pending.lead });
    cp.visited = [...new Set([...cp.visited, identityKey(pending.lead)])];
    cp.pending = null;
    cp.job.saved_count = result.saved_count;
    cp.job.duplicate_count = result.duplicate_count;
    await save(cp);
    return result;
  }
  async function handle(message: PanelCommand | ContentCommand, sender: { url?: string; tab?: { id?: number } }) {
    const { checkpoint: cp, session: stored } = await read();
    const fromPanel = sender.url === browser.runtime.getURL('/sidepanel.html');
    const fromMaps = !!sender.url && isMapsUrl(sender.url) && sender.tab?.id === cp?.tabId;
    if (!fromPanel && !fromMaps) throw new Error('This message source is not allowed.');
    if (fromPanel) {
      const command = message as PanelCommand;
      if (command.type === 'GET_STATE') return { checkpoint: cp || null, email: stored?.user.email || null, accountId: stored?.user.id || null } satisfies ExtensionState;
      if (command.type === 'LOGIN') {
        const authenticated = await (await raw('auth/login', 'POST', { email: command.email, password: command.password })).json() as Session;
        if (cp && authenticated.user.id !== cp.job.user_id && (cp.pending || ['running', 'paused'].includes(cp.job.status))) {
          throw new Error('Finish or stop the current account’s collection before switching accounts.');
        }
        await browser.storage.local.set({ session: authenticated });
        if (cp && authenticated.user.id !== cp.job.user_id) await browser.storage.local.remove('checkpoint');
        return { email: authenticated.user.email };
      }
      if (command.type === 'LOGOUT') {
        if (cp?.job.status === 'running') await halt(cp, 'paused', 'Signed out. Sign back in to resume.');
        await browser.storage.local.remove('session');
        return null;
      }
      if (command.type === 'ACCOUNT') return await api('account');
      if (command.type === 'START') {
        if (cp?.pending) throw new Error('Resume the previous collection to sync its pending lead before starting another.');
        if (cp?.controlPending) { await syncControl(cp); if (cp.controlPending) throw new Error('Reconnect to sync the previous collection first.'); }
        const input = jobInputSchema.parse(command);
        const tab = await browser.tabs.get(command.tabId);
        if (!tab.url || !isMapsUrl(tab.url)) throw new Error('Open Google Maps in this tab first.');
        const job = await api<Job>('jobs', 'POST', input);
        const next: Checkpoint = { job, tabId: command.tabId, visited: [], pending: null, reason: null, startedAt: Date.now(), controlPending: false };
        await save(next);
        try { await browser.tabs.update(command.tabId, { url: searchUrl(input.business, input.area) }); }
        catch { await halt(next, 'paused', 'The Maps tab could not be opened. Reopen Maps and resume.'); }
        return job;
      }
      if (command.type === 'EXPORT') {
        const current = await session();
        return await (await raw(`leads/export?job=${encodeURIComponent(command.jobId)}`, 'GET', undefined, current.access_token)).text();
      }
      if (!cp) throw new Error('Start a collection first.');
      if (command.type === 'RESUME') {
        if (['completed', 'stopped', 'failed'].includes(cp.job.status)) throw new Error('This collection has finished. Start a new search.');
        const tab = await browser.tabs.get(command.tabId);
        if (!tab.url || !isMapsUrl(tab.url)) throw new Error('Open Google Maps before resuming.');
        const remote = await api<Job>(`jobs/${cp.job.id}`);
        if (['completed','stopped','failed'].includes(remote.status)) { cp.job = remote; await save(cp); throw new Error('This collection was finished from the dashboard.'); }
        await flush(cp);
        if (cp.job.saved_count + cp.job.duplicate_count >= cp.job.lead_limit) {
          await halt(cp, 'completed', 'Requested lead limit reached.');
          return cp.job;
        }
        cp.job = await api<Job>(`jobs/${cp.job.id}`, 'PATCH', { status: 'running', reason: null, skipped_count: cp.job.skipped_count });
        cp.reason = null;
        cp.controlPending = false;
        cp.tabId = command.tabId;
        await save(cp);
        await browser.tabs.update(command.tabId, { url: searchUrl(cp.job.business, cp.job.area) });
        return cp.job;
      }
      if (command.type === 'PAUSE') { await halt(cp, 'paused', 'Paused by you.'); return cp.job; }
      if (command.type === 'STOP') {
        // Keep an unacknowledged record until it has been committed before finishing.
        await flush(cp);
        await halt(cp, 'stopped', 'Stopped by you.');
        return cp.job;
      }
      throw new Error('Unknown command.');
    }
    if (!cp || !stored || cp.job.user_id !== stored.user.id) return null;
    const command = message as ContentCommand;
    if (command.type === 'READY') {
      if (cp.job.status !== 'running') return null;
      try {
        const remote = await api<Job>(`jobs/${cp.job.id}`);
        if (remote.status !== 'running') { cp.job = remote; await save(cp); return null; }
        await flush(cp);
        if (cp.job.saved_count + cp.job.duplicate_count >= cp.job.lead_limit) { await halt(cp, 'completed', 'Requested lead limit reached.'); return null; }
        return cp;
      } catch (error) { await halt(cp, 'paused', error instanceof Error ? error.message : 'Connection interrupted.'); return null; }
    }
    if (cp.job.status !== 'running') return null;
    if (command.type === 'RECORD') {
      try {
        const lead = leadInputSchema.parse(command.lead);
        if (cp.visited.includes(identityKey(lead))) return { skip: true };
        if (cp.pending) await flush(cp);
        cp.pending = { requestId: crypto.randomUUID(), lead };
        await save(cp); // Persist before network I/O so worker suspension is recoverable.
        const result = await flush(cp);
        if (cp.job.saved_count + cp.job.duplicate_count >= cp.job.lead_limit) await halt(cp, 'completed', 'Requested lead limit reached.');
        else if (result?.credits === 0) await halt(cp, 'paused', 'Your lead credits are exhausted.');
        return result;
      } catch (error) {
        await halt(cp, 'paused', error instanceof Error ? error.message : 'The lead could not be saved.');
        throw error;
      }
    }
    if (command.type === 'SKIP') {
      if (!cp.visited.includes(command.key)) { cp.visited.push(command.key); cp.job.skipped_count++; await save(cp); }
      return null;
    }
    if (command.type === 'FINISH') { await halt(cp, 'completed', command.reason); return null; }
    if (command.type === 'INTERRUPT') { await halt(cp, 'paused', command.reason); return null; }
    return null;
  }
  browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    void serialize(() => handle(message, sender)).then(data => sendResponse({ ok: true, data }), error => sendResponse({ ok: false, message: error instanceof Error ? error.message : 'Action failed.', code: error instanceof BackendError ? error.code : 'extension_error' }));
    return true;
  });
  browser.tabs.onRemoved.addListener(tabId => {
    void serialize(async () => {
      const { checkpoint } = await read();
      if (checkpoint?.tabId === tabId && checkpoint.job.status === 'running') await halt(checkpoint, 'paused', 'Maps tab closed. Reopen Maps and resume.');
    });
  });
  browser.tabs.onUpdated.addListener((tabId, change) => {
    if (!change.url) return;
    void serialize(async () => {
      const { checkpoint } = await read();
      if (!checkpoint || checkpoint.tabId !== tabId || checkpoint.job.status !== 'running') return;
      if (!isMapsUrl(change.url!)) await halt(checkpoint, 'paused', 'You navigated away from Maps. Reopen Maps and resume.');
      else if (new URL(change.url!).pathname.startsWith('/maps/search/')) {
        const term = (url: string) => decodeURIComponent(new URL(url).pathname.split('/maps/search/')[1]?.split('/')[0]?.replace(/\+/g, ' ') || '').trim().toLowerCase().replace(/\s+/g, ' ');
        if (term(change.url!) !== term(searchUrl(checkpoint.job.business, checkpoint.job.area))) await halt(checkpoint, 'paused', 'The Maps search changed. Resume to reopen this collection’s search.');
      }
    });
  });
  browser.runtime.onStartup.addListener(() => {
    void serialize(async () => {
      const { checkpoint } = await read();
      if (checkpoint?.job.status === 'running') await halt(checkpoint, 'paused', 'Browser restarted. Resume when ready.');
    });
  });
});
