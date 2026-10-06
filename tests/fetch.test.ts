import { beforeEach, describe, expect, it, vi } from 'vitest';
const network = vi.hoisted(() => ({ lookup: vi.fn(), request: vi.fn(), dispatchers: [] as { connect: { lookup: (...args: unknown[]) => void } }[] }));
vi.mock('node:dns/promises', () => ({ lookup: network.lookup }));
vi.mock('undici', () => ({
  request: network.request,
  Agent: class {
    constructor(options: typeof network.dispatchers[number]) { network.dispatchers.push(options); }
    async close() {}
  },
}));
import { fetchHtml } from '../apps/worker/src/enrichment';
const response = (statusCode = 200, location?: string, contentType = 'text/html') => ({
  statusCode, headers: { 'content-type': contentType, ...(location ? { location } : {}) },
  body: { destroy: vi.fn(), async *[Symbol.asyncIterator]() { yield Buffer.from('<h1>Acme</h1>'); } },
});
beforeEach(() => {
  network.dispatchers.length = 0;
  network.lookup.mockReset().mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
  network.request.mockReset().mockResolvedValue(response());
});
describe('bounded public website fetches', () => {
  it('pins the validated address instead of resolving DNS again for the socket', async () => {
    expect(await fetchHtml('https://acme.example')).toMatchObject({ html: '<h1>Acme</h1>' });
    const callback = vi.fn(); network.dispatchers[0].connect.lookup('acme.example',{},callback);
    expect(callback).toHaveBeenCalledWith(null,'93.184.216.34',4);
    expect(network.lookup).toHaveBeenCalledTimes(1);
  });
  it('rejects mixed public/private DNS answers before requesting the page', async () => {
    network.lookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 },{ address: '127.0.0.1', family: 4 }]);
    await expect(fetchHtml('https://acme.example')).rejects.toThrow('Private'); expect(network.request).not.toHaveBeenCalled();
  });
  it('validates DNS again after an allowed redirect', async () => {
    network.request.mockResolvedValueOnce(response(302,'/contact'));
    network.lookup.mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }]).mockResolvedValueOnce([{ address: '10.0.0.1', family: 4 }]);
    await expect(fetchHtml('https://acme.example')).rejects.toThrow('Private'); expect(network.request).toHaveBeenCalledTimes(1);
  });
  it('rejects external and private redirects', async () => {
    network.request.mockResolvedValueOnce(response(302,'http://169.254.169.254/latest/meta-data'));
    await expect(fetchHtml('https://acme.example')).rejects.toThrow('Private');
    network.request.mockResolvedValueOnce(response(302,'https://other.example'));
    await expect(fetchHtml('https://acme.example')).rejects.toThrow('outside its domain');
  });
  it('bounds redirect loops and uses one timeout budget across redirects', async () => {
    network.request.mockResolvedValue(response(302,'/next'));
    await expect(fetchHtml('https://acme.example')).rejects.toThrow('Too many');
    expect(network.request).toHaveBeenCalledTimes(4);
    expect(new Set(network.request.mock.calls.map(c => c[1].signal)).size).toBe(1);
  });
  it('rejects non-HTML and oversized bodies', async () => {
    network.request.mockResolvedValueOnce(response(200,undefined,'application/pdf'));
    await expect(fetchHtml('https://acme.example')).rejects.toThrow('HTML');
    network.request.mockResolvedValueOnce({ ...response(), body: { destroy: vi.fn(), async *[Symbol.asyncIterator]() { yield Buffer.alloc(2*1024*1024+1); } } });
    await expect(fetchHtml('https://acme.example')).rejects.toThrow('exceeds 2 MB');
  });
});
