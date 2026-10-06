import { beforeEach, describe, expect, it, vi } from 'vitest';
const fixture = vi.hoisted(() => ({
  authorized: true, admin: false, calls: [] as { table: string; method: string; args: unknown[] }[],
  rows: [] as Record<string, unknown>[], rpc: vi.fn(),
}));
const userId = '11111111-1111-4111-8111-111111111111';
const jobId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
vi.mock('../apps/web/lib/server', async importOriginal => {
  const actual = await importOriginal<typeof import('../apps/web/lib/server')>();
  return {
    ...actual,
    authenticate: async (request: Request) => {
      if (!fixture.authorized) throw new actual.ApiError(401, 'unauthorized', 'Sign in to continue.');
      return { user: { id: userId, email: 'me@example.com' }, db: {
        rpc: fixture.rpc,
        from: (table: string) => {
          const filters: [string, unknown][] = [];
          let cursor = ''; let limit = Infinity;
          const chain: Record<string, unknown> = {};
          const resolve = () => {
            let data = fixture.rows.filter(r => filters.every(([key,value]) => r[key] === value));
            if (cursor) data = data.filter(r => String(r.id) > cursor);
            return { data: data.slice(0,limit), count: data.length, error: null };
          };
          for (const method of ['select','eq','neq','or','gte','order','range','limit','gt','in']) chain[method] = (...args: unknown[]) => {
            fixture.calls.push({ table,method,args });
            if (method === 'eq') filters.push([String(args[0]),args[1]]);
            if (method === 'gt') cursor = String(args[1]);
            if (method === 'limit') limit = Number(args[0]);
            return chain;
          };
          chain.maybeSingle = async () => table === 'admins' ? { data: fixture.admin ? { user_id: userId } : null, error: null } : { ...resolve(), data: resolve().data[0] || null };
          chain.single = chain.maybeSingle;
          chain.then = (yes: (v: unknown) => unknown, no: (e: unknown) => unknown) => Promise.resolve(resolve()).then(yes,no);
          return chain;
        },
      } };
    },
  };
});
import { GET, POST, PATCH, OPTIONS } from '../apps/web/app/api/v1/[...path]/route';
import { jsonBody } from '../apps/web/lib/server';
const request = (path: string, method = 'GET', body?: unknown) => new Request(`http://localhost:3000/api/v1/${path}`, { method, ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
const context = (path: string) => ({ params: Promise.resolve({ path: path.split('?')[0].split('/') }) });
beforeEach(() => {
  fixture.authorized = true; fixture.admin = false; fixture.calls = []; fixture.rows = [];
  fixture.rpc.mockReset().mockImplementation(() => {
    const result = { data: { id: jobId, status: 'running' }, error: null };
    return { single: async () => result, then: (yes: (v: unknown) => unknown, no: (e: unknown) => unknown) => Promise.resolve(result).then(yes,no) };
  });
});
describe('API validation and ownership', () => {
  it('protects customer endpoints without a session', async () => {
    fixture.authorized = false;
    expect((await GET(request('leads'),context('leads'))).status).toBe(401);
  });
  it('takes job ownership from the authenticated user rather than the payload', async () => {
    const response = await POST(request('jobs','POST',{ business: 'Dentists', area: 'Lahore', limit: 10, user_id: 'attacker' }),context('jobs'));
    expect(response.status).toBe(201);
    expect(fixture.rpc).toHaveBeenCalledWith('create_collection',{ p_user: userId, p_business: 'Dentists', p_area: 'Lahore', p_limit: 10 });
    expect(await response.json()).toEqual({ id: jobId, status: 'running' });
  });
  it('rejects invalid job limits and identifiers before writes', async () => {
    expect((await POST(request('jobs','POST',{ business: 'Dentists', area: 'Lahore', limit: 201 }),context('jobs'))).status).toBe(400);
    expect((await PATCH(request('jobs/not-a-uuid','PATCH',{ status: 'paused' }),context('jobs/not-a-uuid'))).status).toBe(400);
    expect(fixture.rpc).not.toHaveBeenCalled();
  });
  it('computes lead identity on the server', async () => {
    const path = `jobs/${jobId}/leads`;
    await POST(request(path,'POST',{ request_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', identity_key: 'attacker', user_id: 'attacker', lead: { name: 'River Dental', maps_url: 'https://www.google.com/maps/place/River', place_id: 'ChIJriver', collected_at: '2026-10-05T00:00:00Z' } }),context(path));
    expect(fixture.rpc.mock.calls[0][1]).toMatchObject({ p_user: userId, p_identity: 'place:ChIJriver' });
  });
  it('always filters lead reads to the authenticated owner', async () => {
    await GET(request('leads?user_id=attacker'),context('leads'));
    expect(fixture.calls).toContainEqual({ table: 'leads', method: 'eq', args: ['user_id', userId] });
  });
  it('denies customer administration to non-admins', async () => {
    expect((await GET(request('admin/customers'),context('admin/customers'))).status).toBe(403);
  });
  it('rejects unauthorized origins and handles allowed preflights', async () => {
    const denied = new Request('http://localhost:3000/api/v1/leads',{ headers: { Origin: 'https://evil.example' } });
    expect((await GET(denied,context('leads'))).status).toBe(403);
    const accepted = new Request('http://localhost:3000/api/v1/leads',{ method: 'OPTIONS', headers: { Origin: 'http://localhost:3000' } });
    const response = await OPTIONS(accepted,context('leads'));
    expect(response.status).toBe(204); expect(response.headers.get('access-control-allow-origin')).toBe('http://localhost:3000');
  });
  it('validates export filters before sending streaming headers', async () => {
    expect((await GET(request('leads/export?rating=99'),context('leads/export'))).status).toBe(400);
  });
  it('streams exports beyond a database response page with one header', async () => {
    fixture.rows = Array.from({ length: 501 }, (_, i) => ({ id: String(i).padStart(8,'0'), user_id: userId, name: `Business ${i}`, maps_url: 'https://www.google.com/maps/place/A', collected_at: '2026-10-05T00:00:00Z' }));
    const response = await GET(request('leads/export'),context('leads/export'));
    const csv = await response.text();
    expect(csv.split('\r\n')).toHaveLength(502);
    expect(csv.match(/"Name"/g)).toHaveLength(1);
    expect(csv).toContain('Business 500');
  });
  it('limits chunked JSON request bodies', async () => {
    const body = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('x'.repeat(65537))); controller.close(); } });
    const r = new Request('http://localhost:3000', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, duplex: 'half' } as RequestInit);
    await expect(jsonBody(r)).rejects.toThrow('Request is too large');
  });
});
