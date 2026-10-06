// Uses ONLY explicitly named TEST_* credentials, never application credentials.
// Run against a disposable Supabase project after applying the migration.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
const url = process.env.TEST_SUPABASE_URL;
const key = process.env.TEST_SUPABASE_SERVICE_ROLE_KEY;
const anonKey = process.env.TEST_SUPABASE_ANON_KEY;
if (!url || !key || !anonKey) throw new Error('Set TEST_SUPABASE_URL, TEST_SUPABASE_SERVICE_ROLE_KEY, and TEST_SUPABASE_ANON_KEY for a disposable test project.');
const db = createClient(url,key,{ auth: { persistSession: false, autoRefreshToken: false } });
const users: string[] = [];
const prefix = `leadgen-test-${randomUUID()}`;
const password = `${randomUUID()}Aa1!`;
async function createUser(suffix: string) {
  const email = `${prefix}-${suffix}@example.com`;
  const { data, error } = await db.auth.admin.createUser({ email,password,email_confirm:true });
  if (error || !data.user) throw new Error(error?.message || 'Test user creation failed');
  users.push(data.user.id);
  const { error: activationError } = await db.from('entitlements').update({ active:true,expires_at:'2099-01-01T00:00:00Z',credits:10 }).eq('user_id',data.user.id);
  if (activationError) throw activationError;
  return { id:data.user.id,email };
}
try {
  const owner = await createUser('owner'); const other = await createUser('other');
  const { data: job,error } = await db.rpc('create_collection',{ p_user:owner.id,p_business:'Test dentists',p_area:'Test area',p_limit:10 }).single();
  if (error) throw error;
  const lead = { name:'Test business',website:null,category:null,address:null,phone:null,rating:null,review_count:null,hours:null,maps_url:'https://www.google.com/maps/place/Test',place_id:'integration-test',collected_at:new Date().toISOString() };
  const results = await Promise.all(Array.from({ length:8 }, () => db.rpc('ingest_lead',{ p_user:owner.id,p_job:job.id,p_request:randomUUID(),p_identity:'place:integration-test',p_lead:lead })));
  results.forEach(r => { if (r.error) throw r.error; });
  assert.equal(results.filter(r => !r.data.duplicate).length,1);
  const { data: entitlement,error: entitlementError } = await db.from('entitlements').select('credits').eq('user_id',owner.id).single();
  if (entitlementError) throw entitlementError;
  assert.equal(entitlement.credits,9);
  const client = createClient(url,anonKey,{ auth: { persistSession:false,autoRefreshToken:false } });
  const signedIn = await client.auth.signInWithPassword({ email:other.email,password });
  if (signedIn.error) throw signedIn.error;
  const visible = await client.from('leads').select('id').eq('user_id',owner.id);
  if (visible.error) throw visible.error;
  assert.equal(visible.data.length,0);
  const forbidden = await client.rpc('create_collection',{ p_user:owner.id,p_business:'Unauthorized',p_area:'Test',p_limit:1 });
  assert.ok(forbidden.error,'Authenticated clients must not execute privileged RPCs');
  console.log('Live PostgreSQL concurrency and RLS checks passed.');
} finally {
  const errors = await Promise.all(users.map(async id => (await db.auth.admin.deleteUser(id)).error));
  if (errors.some(Boolean)) console.error('Some disposable test users could not be removed. Check the test project.');
}
