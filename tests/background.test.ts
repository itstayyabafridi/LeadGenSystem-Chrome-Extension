import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Checkpoint, ExtensionState, Job, Session } from '@leadgen/shared';

const fake = vi.hoisted(() => ({
  store: {} as Record<string, unknown>,
  listener: null as ((message: unknown, sender: unknown, respond: (r: unknown) => void) => void) | null,
  removed: null as ((id: number) => void) | null,
  startup: null as (() => void) | null,
  updated: null as ((id: number, change: { url: string }) => void) | null,
  update: vi.fn(async () => ({})),
  halt: vi.fn(async () => ({})),
}));
vi.mock('wxt/utils/define-background', () => ({ defineBackground: (fn: () => void) => fn }));
vi.mock('wxt/browser', () => ({ browser: {
  storage: { local: {
    setAccessLevel: vi.fn(async () => {}),
    get: async () => structuredClone(fake.store),
    set: async (values: Record<string, unknown>) => { Object.assign(fake.store, structuredClone(values)); },
    remove: async (key: string) => { delete fake.store[key]; },
  } },
  sidePanel: { setPanelBehavior: vi.fn(async () => {}) },
  runtime: {
    getURL: (path: string) => `chrome-extension://test${path}`,
    onMessage: { addListener: (fn: typeof fake.listener) => { fake.listener = fn; } },
    onStartup: { addListener: (fn: typeof fake.startup) => { fake.startup = fn; } },
  },
  tabs: {
    get: async () => ({ id: 5, url: 'https://www.google.com/maps/search/dentists' }),
    update: fake.update,
    sendMessage: fake.halt,
    onRemoved: { addListener: (fn: typeof fake.removed) => { fake.removed = fn; } },
    onUpdated: { addListener: (fn: typeof fake.updated) => { fake.updated = fn; } },
  },
} }));
import background from '../apps/extension/entrypoints/background';
const user = '11111111-1111-4111-8111-111111111111';
const session: Session = { access_token: 'test-token', refresh_token: 'test-refresh', expires_at: 4070908800, user: { id: user, email: 'me@example.com' } };
let job: Job;
let serverSaved = 0;
let commitThenFail = false;
let offline = false;
let requests: Map<string, unknown>;
const panel = { url: 'chrome-extension://test/sidepanel.html' };
const maps = { url: 'https://www.google.com/maps/search/dentists', tab: { id: 5 } };
async function command<T = unknown>(input: unknown, sender: unknown = panel): Promise<T> {
  return await new Promise((resolve, reject) => fake.listener!(input, sender, (r: unknown) => {
    const result = r as { ok: boolean; data: T; message: string };
    if (result.ok) resolve(result.data); else reject(new Error(result.message));
  }));
}
const lead = { name: 'River Dental', category: null, address: null, phone: null, website: null, rating: null, review_count: null, hours: null, maps_url: 'https://www.google.com/maps/place/River/data=!1sChIJriver', place_id: 'ChIJriver', collected_at: '2026-10-05T10:00:00.000Z' };
beforeEach(() => {
  serverSaved = 0; commitThenFail = false; offline = false; requests = new Map();
  fake.store = { session }; fake.update.mockClear(); fake.halt.mockClear();
  job = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', user_id: user, business: 'Dentists', area: 'Lahore', lead_limit: 200, status: 'running', saved_count: 0, duplicate_count: 0, skipped_count: 0, reason: null, created_at: '2026-10-05T10:00:00Z', updated_at: '2026-10-05T10:00:00Z' };
  vi.stubGlobal('fetch', vi.fn(async (input: string, options: RequestInit) => {
    if (offline) throw new TypeError('network down');
    const path = new URL(input).pathname;
    const body = options?.body ? JSON.parse(String(options.body)) : {};
    if (path.endsWith('/jobs') && options.method === 'POST') return Response.json(job);
    if (path.endsWith('/leads')) {
      if (!requests.has(body.request_id)) { serverSaved++; job.saved_count++; requests.set(body.request_id, { lead_id: 'lead-id', credits: 10 - serverSaved, duplicate: false, saved_count: job.saved_count, duplicate_count: 0 }); }
      if (commitThenFail) { commitThenFail = false; throw new TypeError('response lost after commit'); }
      return Response.json(requests.get(body.request_id));
    }
    if (options.method === 'PATCH') { Object.assign(job, { status: body.status, reason: body.reason }); return Response.json(job); }
    return Response.json(job);
  }));
  (background as unknown as () => void)();
});
async function start(limit = 200) { job.lead_limit = limit; await command({ type: 'START', business: 'Dentists', area: 'Lahore', limit, tabId: 5 }); }

describe('durable extension collection', () => {
  it('creates a search and navigates only after checkpoint persistence', async () => {
    await start(); expect((fake.store.checkpoint as Checkpoint).job.id).toBe(job.id);
    expect(fake.update).toHaveBeenCalledWith(5, { url: 'https://www.google.com/maps/search/Dentists%20in%20Lahore?hl=en' });
  });
  it('recovers a committed upload with a lost response without charging again', async () => {
    await start(); commitThenFail = true;
    await expect(command({ type: 'RECORD', lead }, maps)).rejects.toThrow('Could not reach');
    const pending = (fake.store.checkpoint as Checkpoint).pending!;
    expect(pending.requestId).toBeTruthy(); expect((fake.store.checkpoint as Checkpoint).job.status).toBe('paused');
    // Simulate the service worker being terminated and restarted.
    (background as unknown as () => void)();
    await command({ type: 'RESUME', tabId: 5 });
    expect(serverSaved).toBe(1); expect(requests.size).toBe(1);
    expect((fake.store.checkpoint as Checkpoint).pending).toBeNull();
    expect((fake.store.checkpoint as Checkpoint).visited).toContain('place:ChIJriver');
  });
  it('completes a recovered job that already reached its requested limit', async () => {
    await start(1); commitThenFail = true;
    await expect(command({ type: 'RECORD', lead }, maps)).rejects.toThrow();
    await command({ type: 'RESUME', tabId: 5 });
    expect((fake.store.checkpoint as Checkpoint).job.status).toBe('completed');
  });
  it('allows stopping after subscription expiry while preserving a local recovery CSV', async () => {
    await start();
    const fetcher = globalThis.fetch;
    vi.stubGlobal('fetch',vi.fn(async (url: string, options: RequestInit) => {
      if (url.endsWith('/leads')) return Response.json({ error:'subscription_inactive',message:'Subscription expired' },{ status:403 });
      return fetcher(url,options);
    }));
    await expect(command({ type:'RECORD',lead },maps)).rejects.toThrow('Subscription expired');
    await command({ type:'STOP' });
    const state = await command<ExtensionState>({ type:'GET_STATE' });
    expect(state.checkpoint?.job.status).toBe('stopped'); expect(state.unsynced_count).toBe(1);
    expect(await command<string>({ type:'EXPORT_UNSYNCED' })).toContain('River Dental');
    expect(serverSaved).toBe(0);
  });
  it('preserves unuploaded records when a new collection replaces a finished checkpoint', async () => {
    await start(); const cp = fake.store.checkpoint as Checkpoint;
    cp.job.status = 'stopped'; cp.pending = { requestId:'pending-request',lead };
    await command({ type:'START',business:'Dentists',area:'Lahore',limit:200,tabId:5 });
    expect((fake.store.checkpoint as Checkpoint).pending).toBeNull();
    expect(await command<string>({ type:'EXPORT_UNSYNCED' })).toContain('River Dental');
  });
  it('pauses on tab closure and preserves partial results', async () => {
    await start(); await command({ type: 'RECORD', lead }, maps);
    fake.removed!(5); const state = await command<ExtensionState>({ type: 'GET_STATE' });
    expect(state.checkpoint?.job.status).toBe('paused'); expect(state.checkpoint?.job.saved_count).toBe(1);
  });
  it('pauses on browser restart', async () => {
    await start(); fake.startup!(); const state = await command<ExtensionState>({ type: 'GET_STATE' });
    expect(state.checkpoint?.reason).toContain('Browser restarted');
  });
  it('persists an offline pause for later server synchronization', async () => {
    await start(); offline = true; await command({ type: 'PAUSE' });
    expect((fake.store.checkpoint as Checkpoint).controlPending).toBe(true);
    expect((fake.store.checkpoint as Checkpoint).job.status).toBe('paused');
  });
  it('accepts Maps viewport and plus-encoded changes within the same search', async () => {
    await start(); fake.updated!(5, { url: 'https://www.google.com/maps/search/Dentists+in+Lahore/@31,74,14z' });
    const state = await command<ExtensionState>({ type: 'GET_STATE' });
    expect(state.checkpoint?.job.status).toBe('running');
  });
  it('pauses when a user switches to a different search', async () => {
    await start(); fake.updated!(5, { url: 'https://www.google.com/maps/search/Restaurants+in+Karachi' });
    const state = await command<ExtensionState>({ type: 'GET_STATE' });
    expect(state.checkpoint?.job.status).toBe('paused');
  });
  it('does not expose tokens in panel state', async () => {
    await start(); const state = await command({ type: 'GET_STATE' });
    expect(JSON.stringify(state)).not.toContain('test-token'); expect(JSON.stringify(state)).not.toContain('test-refresh');
  });
  it('rejects messages from other websites and unrelated Maps tabs', async () => {
    await start();
    await expect(command({ type: 'RECORD', lead }, { url: 'https://evil.example', tab: { id: 5 } })).rejects.toThrow('not allowed');
    await expect(command({ type: 'RECORD', lead }, { ...maps, tab: { id: 6 } })).rejects.toThrow('not allowed');
  });
  it('does not allow Maps content scripts to execute privileged panel commands', async () => {
    await start(); await command({ type: 'LOGOUT' }, maps);
    expect(fake.store.session).toEqual(session);
  });
});
