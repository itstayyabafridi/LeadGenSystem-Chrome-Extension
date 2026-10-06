import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

let db: PGlite;
const customer = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';
const admin = '33333333-3333-4333-8333-333333333333';
const lead = {
  name: 'Riverside Dental', category: 'Dental clinic', address: 'Lahore', phone: '+92421112233', website: 'https://riverside.example',
  rating: 4.7, review_count: 10, hours: null, maps_url: 'https://www.google.com/maps/place/Riverside/data=!1sChIJriver', place_id: 'ChIJriver', collected_at: '2026-10-05T10:00:00Z',
};
async function job(user = customer, limit = 200) {
  const result = await db.query<{ id: string }>('select * from public.create_collection($1,$2,$3,$4)', [user, 'Dentists', 'Lahore', limit]);
  return result.rows[0].id;
}
async function ingest(jobId: string, requestId = randomUUID(), user = customer, identity = 'place:ChIJriver', input = lead) {
  const result = await db.query<{ result: { lead_id: string; credits: number; duplicate: boolean; saved_count: number; duplicate_count: number } }>('select public.ingest_lead($1,$2,$3,$4,$5::jsonb) as result', [user, jobId, requestId, identity, JSON.stringify(input)]);
  return result.rows[0].result;
}
beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create schema auth;
    create table auth.users(id uuid primary key, email text);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true),'')::uuid $$;
    grant usage on schema public, auth to authenticated;
  `);
  // gen_random_uuid is built into PostgreSQL. PGlite needs no pgcrypto extension.
  const migration = readFileSync(new URL('../supabase/migrations/202610050001_initial.sql', import.meta.url), 'utf8').replace('create extension if not exists pgcrypto;', '');
  await db.exec(migration);
  await db.exec('grant select on all tables in schema public to authenticated');
}, 30000);
beforeEach(async () => {
  await db.exec('truncate auth.users cascade');
  await db.query('insert into auth.users values ($1,$2),($3,$4),($5,$6)', [customer, 'customer@example.com', other, 'other@example.com', admin, 'admin@example.com']);
  await db.query("update public.entitlements set active = true, expires_at = '2099-01-01', credits = 10");
  await db.query('insert into public.admins values($1)', [admin]);
});
afterAll(async () => { await db?.close(); });

describe('actual PostgreSQL migration and transactions', () => {
  it('provisions inactive new customer accounts', async () => {
    const id = randomUUID(); await db.query('insert into auth.users values($1,$2)', [id, 'new@example.com']);
    const result = await db.query('select active, credits from public.entitlements where user_id=$1', [id]);
    expect(result.rows[0]).toEqual({ active: false, credits: 0 });
  });
  it('charges a new lead atomically and queues enrichment', async () => {
    const result = await ingest(await job());
    expect(result).toMatchObject({ credits: 9, duplicate: false, saved_count: 1 });
    expect((await db.query('select * from public.credit_ledger')).rows).toHaveLength(1);
    expect((await db.query('select * from public.enrichment_tasks')).rows).toHaveLength(1);
  });
  it('does not charge or recount retried requests', async () => {
    const id = await job(); const request = randomUUID();
    const first = await ingest(id, request); const retry = await ingest(id, request);
    expect(retry).toEqual(first);
    expect((await db.query('select * from public.leads')).rows).toHaveLength(1);
  });
  it('serializes concurrent duplicate submissions without double charging', async () => {
    const id = await job();
    const results = await Promise.all(Array.from({ length: 5 }, () => ingest(id)));
    expect(results.filter(r => !r.duplicate)).toHaveLength(1);
    expect((await db.query<{ credits: number }>('select credits from entitlements where user_id=$1', [customer])).rows[0].credits).toBe(9);
    expect((await db.query<{ saved_count: number; duplicate_count: number }>('select saved_count,duplicate_count from jobs where id=$1', [id])).rows[0]).toEqual({ saved_count: 1, duplicate_count: 0 });
  });
  it('updates existing businesses in a subsequent search without charging', async () => {
    const first = await job(); await ingest(first);
    await db.query("select public.control_collection($1,$2,'completed',null,0)", [customer,first]);
    const next = await job(); const result = await ingest(next, randomUUID(), customer, 'place:ChIJriver', { ...lead, phone: '+92420000000' });
    expect(result).toMatchObject({ credits: 9, duplicate: true, saved_count: 0, duplicate_count: 1 });
    expect((await db.query<{ phone: string }>('select phone from leads')).rows[0].phone).toBe('+92420000000');
  });
  it('rejects zero-credit new leads without partial writes', async () => {
    const id = await job(); await db.query('update entitlements set credits=0 where user_id=$1', [customer]);
    await expect(ingest(id)).rejects.toThrow('credits_exhausted');
    expect((await db.query('select * from leads')).rows).toHaveLength(0);
    expect((await db.query('select * from credit_ledger')).rows).toHaveLength(0);
  });
  it('rejects inactive and expired subscriptions', async () => {
    await db.query("update entitlements set expires_at='2000-01-01' where user_id=$1", [customer]);
    await expect(job()).rejects.toThrow('subscription_inactive');
    await db.query("update entitlements set expires_at='2099-01-01', active=false where user_id=$1", [customer]);
    await expect(job()).rejects.toThrow('subscription_inactive');
  });
  it('enforces one active job including paused jobs', async () => {
    const id = await job(); await db.query("select public.control_collection($1,$2,'paused',null,0)", [customer,id]);
    await expect(job()).rejects.toThrow('active_job_exists');
  });
  it('enforces job lead limits server-side', async () => {
    const id = await job(customer, 1); await ingest(id);
    await expect(ingest(id, randomUUID(), customer, 'place:another', { ...lead, place_id: 'another' })).rejects.toThrow('job_limit_reached');
  });
  it('rejects cross-account job ingestion and control', async () => {
    const id = await job();
    await expect(ingest(id, randomUUID(), other)).rejects.toThrow('job_not_found');
    await expect(db.query("select public.control_collection($1,$2,'stopped',null,0)", [other,id])).rejects.toThrow('job_not_found');
  });
  it('isolates leads through row-level security', async () => {
    await ingest(await job());
    await db.transaction(async tx => {
      await tx.exec('set local role authenticated');
      await tx.query("select set_config('request.jwt.claim.sub',$1,true)", [other]);
      expect((await tx.query('select * from public.leads')).rows).toHaveLength(0);
      await tx.query("select set_config('request.jwt.claim.sub',$1,true)", [customer]);
      expect((await tx.query('select * from public.leads')).rows).toHaveLength(1);
    });
  });
  it('blocks authenticated clients from privileged RPCs and balance changes', async () => {
    await expect(db.transaction(async tx => {
      await tx.exec('set local role authenticated');
      await tx.query('select public.create_collection($1,$2,$3,$4)', [customer,'Dentists','Lahore',10]);
    })).rejects.toThrow('permission denied');
    await expect(db.transaction(async tx => {
      await tx.exec('set local role authenticated'); await tx.exec('update entitlements set credits=9999');
    })).rejects.toThrow('permission denied');
  });
  it('guards admin credit grants and records the actor', async () => {
    await expect(db.query("select public.set_entitlement($1,$2,true,'2099-01-01',50)", [other,customer])).rejects.toThrow('admin_required');
    await db.query("select public.set_entitlement($1,$2,true,'2099-01-01',50)", [admin,customer]);
    expect((await db.query<{ credits: number }>('select credits from entitlements where user_id=$1', [customer])).rows[0].credits).toBe(60);
    expect((await db.query<{ actor_id: string }>('select actor_id from credit_ledger')).rows[0].actor_id).toBe(admin);
  });
  it('prevents resuming a finished collection', async () => {
    const id = await job(); await db.query("select public.control_collection($1,$2,'stopped',null,0)", [customer,id]);
    await expect(db.query("select public.control_collection($1,$2,'running',null,0)", [customer,id])).rejects.toThrow('job_is_terminal');
  });
  it('leases enrichment exclusively and rejects stale completions', async () => {
    await ingest(await job());
    const first = (await db.query<{ task: { id: string; lease_token: string } }>('select public.claim_enrichment() as task')).rows[0].task;
    expect((await db.query<{ task: unknown }>('select public.claim_enrichment() as task')).rows[0].task).toBeNull();
    expect((await db.query<{ result: boolean }>("select public.finish_enrichment($1,$2,'[]','[]',null) as result", [first.id,randomUUID()])).rows[0].result).toBe(false);
    await db.query("select public.finish_enrichment($1,$2,'[]','[]',null)", [first.id,first.lease_token]);
    expect((await db.query<{ enrichment_status: string }>('select enrichment_status from leads')).rows[0].enrichment_status).toBe('completed');
  });
  it('records at most three enrichment attempts and preserves the lead on failure', async () => {
    await ingest(await job());
    for (let i = 0; i < 3; i++) {
      const task = (await db.query<{ task: { id: string; lease_token: string } }>('select public.claim_enrichment() as task')).rows[0].task;
      await db.query("select public.finish_enrichment($1,$2,'[]','[]','timeout')", [task.id,task.lease_token]);
      await db.exec('update enrichment_tasks set next_attempt_at=now()');
    }
    expect((await db.query<{ state: string; attempts: number }>('select state,attempts from enrichment_tasks')).rows[0]).toEqual({ state: 'failed', attempts: 3 });
    expect((await db.query('select * from leads')).rows).toHaveLength(1);
  });
});
