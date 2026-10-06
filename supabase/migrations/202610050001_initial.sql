-- Run once in Supabase SQL Editor or with `supabase db push`.
create extension if not exists pgcrypto;

create table public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  created_at timestamptz not null default now()
);
create table public.admins (
  user_id uuid primary key references auth.users(id) on delete cascade
);
create table public.entitlements (
  user_id uuid primary key references auth.users(id) on delete cascade,
  active boolean not null default false,
  expires_at timestamptz,
  credits integer not null default 0 check (credits >= 0),
  updated_at timestamptz not null default now()
);
create table public.jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  business text not null,
  area text not null,
  lead_limit integer not null check (lead_limit between 1 and 200),
  status text not null default 'running' check (status in ('running','paused','completed','stopped','failed')),
  saved_count integer not null default 0,
  duplicate_count integer not null default 0,
  skipped_count integer not null default 0,
  reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, user_id)
);
create unique index one_active_job_per_account on public.jobs(user_id) where status in ('running','paused');
create index jobs_customer_history on public.jobs(user_id, created_at desc);
create table public.leads (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  identity_key text not null,
  name text not null,
  category text,
  address text,
  phone text,
  website text,
  rating numeric check (rating between 0 and 5),
  review_count integer check (review_count >= 0),
  hours text,
  maps_url text not null,
  place_id text,
  collected_at timestamptz not null,
  emails jsonb not null default '[]',
  socials jsonb not null default '[]',
  enrichment_status text not null default 'pending' check (enrichment_status in ('pending','running','completed','failed','not_available')),
  enrichment_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, identity_key),
  unique (id, user_id)
);
create index leads_customer_recent on public.leads(user_id, created_at desc);
create table public.job_leads (
  job_id uuid not null,
  lead_id uuid not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  duplicate boolean not null,
  primary key (job_id, lead_id),
  foreign key (job_id, user_id) references public.jobs(id, user_id) on delete cascade,
  foreign key (lead_id, user_id) references public.leads(id, user_id) on delete cascade
);
create table public.ingestion_requests (
  job_id uuid not null references public.jobs(id) on delete cascade,
  request_id uuid not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  result jsonb not null,
  primary key (job_id, request_id)
);
create table public.credit_ledger (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  delta integer not null,
  reason text not null,
  lead_id uuid references public.leads(id) on delete set null,
  actor_id uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);
create table public.enrichment_tasks (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null unique references public.leads(id) on delete cascade,
  state text not null default 'pending' check (state in ('pending','running','completed','failed')),
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  lease_until timestamptz,
  lease_token uuid,
  last_error text
);
create index enrichment_due on public.enrichment_tasks(state, next_attempt_at);

create function public.on_customer_created() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles(user_id, email) values (new.id, coalesce(new.email, ''));
  insert into public.entitlements(user_id) values (new.id);
  return new;
end;
$$;
create trigger customer_created after insert on auth.users for each row execute function public.on_customer_created();
-- Also support projects that already contain users.
insert into public.profiles(user_id, email) select id, coalesce(email, '') from auth.users on conflict do nothing;
insert into public.entitlements(user_id) select id from auth.users on conflict do nothing;

alter table public.profiles enable row level security;
alter table public.admins enable row level security;
alter table public.entitlements enable row level security;
alter table public.jobs enable row level security;
alter table public.leads enable row level security;
alter table public.job_leads enable row level security;
alter table public.ingestion_requests enable row level security;
alter table public.credit_ledger enable row level security;
alter table public.enrichment_tasks enable row level security;
create policy own_profile on public.profiles for select to authenticated using (user_id = (select auth.uid()));
create policy own_admin_status on public.admins for select to authenticated using (user_id = (select auth.uid()));
create policy own_entitlement on public.entitlements for select to authenticated using (user_id = (select auth.uid()));
create policy own_jobs on public.jobs for select to authenticated using (user_id = (select auth.uid()));
create policy own_leads on public.leads for select to authenticated using (user_id = (select auth.uid()));
create policy own_job_leads on public.job_leads for select to authenticated using (user_id = (select auth.uid()));
create policy own_ledger on public.credit_ledger for select to authenticated using (user_id = (select auth.uid()));
-- No browser write policies: credit-affecting writes only use guarded server RPCs.
revoke all on public.enrichment_tasks, public.ingestion_requests from anon, authenticated;
revoke insert, update, delete on public.profiles, public.admins, public.entitlements, public.jobs, public.leads, public.job_leads, public.credit_ledger from anon, authenticated;

create function public.create_collection(p_user uuid, p_business text, p_area text, p_limit integer)
returns public.jobs language plpgsql security definer set search_path = public as $$
declare e public.entitlements; j public.jobs;
begin
  select * into e from public.entitlements where user_id = p_user for update;
  if not found or not e.active or e.expires_at is null or e.expires_at <= now() then raise exception 'subscription_inactive'; end if;
  if e.credits < 1 then raise exception 'credits_exhausted'; end if;
  if exists (select 1 from public.jobs where user_id = p_user and status in ('running','paused')) then raise exception 'active_job_exists'; end if;
  insert into public.jobs(user_id,business,area,lead_limit) values(p_user,p_business,p_area,p_limit) returning * into j;
  return j;
end;
$$;

create function public.ingest_lead(p_user uuid, p_job uuid, p_request uuid, p_identity text, p_lead jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare e public.entitlements; j public.jobs; l public.leads; result jsonb; is_duplicate boolean; linked integer;
begin
  -- The account lock serializes charging and duplicate detection across all requests.
  select * into e from public.entitlements where user_id = p_user for update;
  select r.result into result from public.ingestion_requests r where r.job_id = p_job and r.request_id = p_request and r.user_id = p_user;
  if found then return result; end if;
  if not e.active or e.expires_at is null or e.expires_at <= now() then raise exception 'subscription_inactive'; end if;
  select * into j from public.jobs where id = p_job and user_id = p_user for update;
  if not found then raise exception 'job_not_found'; end if;
  if j.status not in ('running','paused') then raise exception 'job_not_active'; end if;
  select * into l from public.leads where user_id = p_user and identity_key = p_identity;
  is_duplicate := found;
  -- An already-associated lead is a no-op even with a new request id.
  if is_duplicate and exists (select 1 from public.job_leads where job_id = p_job and lead_id = l.id) then
    result := jsonb_build_object('lead_id',l.id,'duplicate',true,'credits',e.credits,'saved_count',j.saved_count,'duplicate_count',j.duplicate_count);
    insert into public.ingestion_requests values(p_job,p_request,p_user,result);
    return result;
  end if;
  if j.saved_count + j.duplicate_count >= j.lead_limit then raise exception 'job_limit_reached'; end if;
  if not is_duplicate then
    if e.credits < 1 then raise exception 'credits_exhausted'; end if;
    insert into public.leads(user_id,identity_key,name,category,address,phone,website,rating,review_count,hours,maps_url,place_id,collected_at,enrichment_status)
    values(p_user,p_identity,p_lead->>'name',p_lead->>'category',p_lead->>'address',p_lead->>'phone',p_lead->>'website',
      (p_lead->>'rating')::numeric,(p_lead->>'review_count')::integer,p_lead->>'hours',p_lead->>'maps_url',p_lead->>'place_id',
      (p_lead->>'collected_at')::timestamptz,case when p_lead->>'website' is null then 'not_available' else 'pending' end) returning * into l;
    update public.entitlements set credits = credits - 1, updated_at = now() where user_id = p_user returning * into e;
    insert into public.credit_ledger(user_id,delta,reason,lead_id) values(p_user,-1,'New business saved',l.id);
    if l.website is not null then insert into public.enrichment_tasks(lead_id) values(l.id); end if;
  else
    update public.leads set name = p_lead->>'name', category = coalesce(p_lead->>'category',category), address = coalesce(p_lead->>'address',address),
      phone = coalesce(p_lead->>'phone',phone), website = coalesce(p_lead->>'website',website), rating = coalesce((p_lead->>'rating')::numeric,rating),
      review_count = coalesce((p_lead->>'review_count')::integer,review_count), hours = coalesce(p_lead->>'hours',hours),
      collected_at = (p_lead->>'collected_at')::timestamptz, updated_at = now() where id = l.id returning * into l;
    if l.website is not null and l.enrichment_status = 'not_available' then
      update public.leads set enrichment_status = 'pending' where id = l.id;
      insert into public.enrichment_tasks(lead_id) values(l.id) on conflict do nothing;
    end if;
  end if;
  insert into public.job_leads(job_id,lead_id,user_id,duplicate) values(p_job,l.id,p_user,is_duplicate);
  update public.jobs set saved_count = saved_count + case when is_duplicate then 0 else 1 end,
    duplicate_count = duplicate_count + case when is_duplicate then 1 else 0 end, updated_at = now() where id = p_job returning * into j;
  result := jsonb_build_object('lead_id',l.id,'duplicate',is_duplicate,'credits',e.credits,'saved_count',j.saved_count,'duplicate_count',j.duplicate_count);
  insert into public.ingestion_requests values(p_job,p_request,p_user,result);
  return result;
end;
$$;

create function public.control_collection(p_user uuid, p_job uuid, p_status text, p_reason text, p_skipped integer)
returns public.jobs language plpgsql security definer set search_path = public as $$
declare j public.jobs; e public.entitlements;
begin
  select * into e from public.entitlements where user_id = p_user for update;
  select * into j from public.jobs where id = p_job and user_id = p_user for update;
  if not found then raise exception 'job_not_found'; end if;
  if p_status not in ('running','paused','completed','stopped','failed') then raise exception 'invalid_status'; end if;
  if j.status in ('completed','stopped','failed') and p_status <> j.status then raise exception 'job_is_terminal'; end if;
  if p_status = 'running' and (not e.active or e.expires_at is null or e.expires_at <= now()) then raise exception 'subscription_inactive'; end if;
  update public.jobs set status = p_status, reason = p_reason,
    skipped_count = greatest(skipped_count, least(coalesce(p_skipped,0), 10000)), updated_at = now() where id = p_job returning * into j;
  return j;
end;
$$;

create function public.set_entitlement(p_actor uuid, p_user uuid, p_active boolean, p_expiry timestamptz, p_grant integer)
returns public.entitlements language plpgsql security definer set search_path = public as $$
declare e public.entitlements;
begin
  if not exists (select 1 from public.admins where user_id = p_actor) then raise exception 'admin_required'; end if;
  if p_grant < 0 or p_grant > 1000000 then raise exception 'invalid_credit_grant'; end if;
  if p_active and (p_expiry is null or p_expiry <= now()) then raise exception 'future_expiry_required'; end if;
  update public.entitlements set active = p_active, expires_at = p_expiry, credits = credits + p_grant, updated_at = now() where user_id = p_user returning * into e;
  if not found then raise exception 'customer_not_found'; end if;
  insert into public.credit_ledger(user_id,delta,reason,actor_id) values(p_user,p_grant,
    case when p_active then 'Subscription activated or updated' else 'Subscription deactivated' end,p_actor);
  return e;
end;
$$;

create function public.claim_enrichment() returns jsonb
language plpgsql security definer set search_path = public as $$
declare t public.enrichment_tasks; l public.leads;
begin
  with exhausted as (
    update public.enrichment_tasks set state = 'failed', last_error = 'Worker lease expired after final attempt'
    where state = 'running' and lease_until < now() and attempts >= 3 returning lead_id
  ) update public.leads set enrichment_status = 'failed', enrichment_error = 'Worker lease expired after final attempt'
    where id in (select lead_id from exhausted);
  select * into t from public.enrichment_tasks
    where (state = 'pending' and next_attempt_at <= now()) or (state = 'running' and lease_until < now() and attempts < 3)
    order by next_attempt_at for update skip locked limit 1;
  if not found then return null; end if;
  update public.enrichment_tasks set state = 'running', attempts = attempts + 1,
    lease_until = now() + interval '3 minutes', lease_token = gen_random_uuid() where id = t.id returning * into t;
  update public.leads set enrichment_status = 'running', updated_at = now() where id = t.lead_id returning * into l;
  return jsonb_build_object('id',t.id,'lead_id',t.lead_id,'website',l.website,'lease_token',t.lease_token,'attempts',t.attempts);
end;
$$;
create function public.finish_enrichment(p_task uuid, p_token uuid, p_emails jsonb, p_socials jsonb, p_error text)
returns boolean language plpgsql security definer set search_path = public as $$
declare t public.enrichment_tasks;
begin
  select * into t from public.enrichment_tasks where id = p_task and state = 'running' and lease_token = p_token for update;
  if not found then return false; end if;
  if p_error is null then
    update public.enrichment_tasks set state = 'completed', lease_until = null, last_error = null where id = p_task;
    update public.leads set emails = p_emails, socials = p_socials, enrichment_status = 'completed', enrichment_error = null, updated_at = now() where id = t.lead_id;
  else
    update public.enrichment_tasks set state = case when attempts >= 3 then 'failed' else 'pending' end,
      next_attempt_at = now() + interval '30 seconds' * attempts, lease_until = null, last_error = left(p_error,500) where id = p_task;
    update public.leads set enrichment_status = case when t.attempts >= 3 then 'failed' else 'pending' end,
      enrichment_error = left(p_error,500), updated_at = now() where id = t.lead_id;
  end if;
  return true;
end;
$$;

-- Functions accept explicit customer ids and therefore must never be public RPCs.
revoke all on function public.on_customer_created() from public, anon, authenticated;
revoke all on function public.create_collection(uuid,text,text,integer) from public, anon, authenticated;
revoke all on function public.ingest_lead(uuid,uuid,uuid,text,jsonb) from public, anon, authenticated;
revoke all on function public.control_collection(uuid,uuid,text,text,integer) from public, anon, authenticated;
revoke all on function public.set_entitlement(uuid,uuid,boolean,timestamptz,integer) from public, anon, authenticated;
revoke all on function public.claim_enrichment() from public, anon, authenticated;
revoke all on function public.finish_enrichment(uuid,uuid,jsonb,jsonb,text) from public, anon, authenticated;
grant execute on function public.create_collection(uuid,text,text,integer), public.ingest_lead(uuid,uuid,uuid,text,jsonb),
  public.control_collection(uuid,uuid,text,text,integer), public.set_entitlement(uuid,uuid,boolean,timestamptz,integer),
  public.claim_enrichment(), public.finish_enrichment(uuid,uuid,jsonb,jsonb,text) to service_role;
