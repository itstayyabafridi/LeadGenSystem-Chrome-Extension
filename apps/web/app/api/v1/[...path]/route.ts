import { z } from 'zod';
import { identityKey, JOB_STATUSES, jobInputSchema, leadInputSchema, leadsToCsv, type Lead } from '@leadgen/shared';
import { ApiError, authenticate, checkDb, errorResponse, jsonBody, publicClient, requireAdmin, uuid } from '../../../../lib/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
type Context = { params: Promise<{ path: string[] }> };

async function route(request: Request, context: Context): Promise<Response> {
  const { path } = await context.params;
  const url = new URL(request.url);
  const resource = path.join('/');
  if (request.method === 'POST' && resource === 'auth/login') {
    const input = z.object({ email: z.string().email().max(320), password: z.string().min(1).max(128) }).parse(await jsonBody(request));
    const { data, error } = await publicClient().auth.signInWithPassword(input);
    if (error || !data.session) throw new ApiError(401, 'login_failed', error?.message || 'Sign-in failed.');
    const s = data.session;
    return Response.json({ access_token: s.access_token, refresh_token: s.refresh_token, expires_at: s.expires_at, user: { id: s.user.id, email: s.user.email } });
  }
  if (request.method === 'POST' && resource === 'auth/refresh') {
    const input = z.object({ refresh_token: z.string().min(1).max(4096) }).parse(await jsonBody(request));
    const { data, error } = await publicClient().auth.refreshSession(input);
    if (error || !data.session) throw new ApiError(401, 'session_expired', 'Your session expired. Sign in again.');
    const s = data.session;
    return Response.json({ access_token: s.access_token, refresh_token: s.refresh_token, expires_at: s.expires_at, user: { id: s.user.id, email: s.user.email } });
  }
  const { user, db } = await authenticate(request);
  if (request.method === 'GET' && resource === 'account') {
    const results = await Promise.all([
      db.from('entitlements').select('*').eq('user_id', user.id).single(),
      db.from('admins').select('user_id').eq('user_id', user.id).maybeSingle(),
      db.from('leads').select('id', { head: true, count: 'exact' }).eq('user_id', user.id),
      db.from('leads').select('id', { head: true, count: 'exact' }).eq('user_id', user.id).neq('emails', '[]'),
    ]);
    results.forEach(r => checkDb(r.error));
    return Response.json({ email: user.email, user_id: user.id, entitlement: results[0].data, admin: !!results[1].data, total_leads: results[2].count, with_email: results[3].count });
  }
  if (request.method === 'POST' && resource === 'jobs') {
    const input = jobInputSchema.parse(await jsonBody(request));
    const { data, error } = await db.rpc('create_collection', { p_user: user.id, p_business: input.business, p_area: input.area, p_limit: input.limit }).single();
    checkDb(error);
    return Response.json(data, { status: 201 });
  }
  if (request.method === 'GET' && resource === 'jobs') {
    const { data, error } = await db.from('jobs').select('*').eq('user_id', user.id).order('created_at', { ascending: false }).limit(100);
    checkDb(error);
    return Response.json({ jobs: data });
  }
  if (path[0] === 'jobs' && path.length >= 2) {
    const id = uuid.parse(path[1]);
    if (request.method === 'POST' && path[2] === 'leads' && path.length === 3) {
      const input = z.object({ request_id: uuid, lead: leadInputSchema }).parse(await jsonBody(request));
      const { data, error } = await db.rpc('ingest_lead', { p_user: user.id, p_job: id, p_request: input.request_id, p_identity: identityKey(input.lead), p_lead: input.lead });
      checkDb(error);
      return Response.json(data);
    }
    if (request.method === 'PATCH' && path.length === 2) {
      const input = z.object({ status: z.enum(JOB_STATUSES), reason: z.string().max(500).nullable().default(null), skipped_count: z.number().int().min(0).max(10000).default(0) }).parse(await jsonBody(request));
      const { data, error } = await db.rpc('control_collection', { p_user: user.id, p_job: id, p_status: input.status, p_reason: input.reason, p_skipped: input.skipped_count }).single();
      checkDb(error);
      return Response.json(data);
    }
    if (request.method === 'GET' && path.length === 2) {
      const { data, error } = await db.from('jobs').select('*').eq('user_id', user.id).eq('id', id).maybeSingle();
      checkDb(error);
      if (!data) throw new ApiError(404, 'not_found', 'Collection not found.');
      return Response.json(data);
    }
  }
  if (request.method === 'GET' && (resource === 'leads' || resource === 'leads/export')) {
    const q = (url.searchParams.get('q') || '').slice(0, 120).replace(/[^\p{L}\p{N}\s@.+-]/gu, '').trim();
    const job = url.searchParams.get('job');
    if (job) uuid.parse(job);
    const buildQuery = () => {
      let query = db.from('leads').select(job ? '*,job_leads!inner(job_id)' : '*', { count: 'exact' }).eq('user_id', user.id);
      if (job) query = query.eq('job_leads.job_id', job);
      if (q) query = query.or(`name.ilike.%${q}%,address.ilike.%${q}%,category.ilike.%${q}%`);
      if (url.searchParams.get('email') === 'true') query = query.neq('emails', '[]');
      const rating = url.searchParams.get('rating');
      if (rating) query = query.gte('rating', z.coerce.number().min(0).max(5).parse(rating));
      return query;
    };
    if (resource === 'leads/export') {
      // Keyset pagination avoids Supabase's response limit and offset drift.
      const encoder = new TextEncoder();
      let lastId: string | null = null;
      let header = true;
      const stream = new ReadableStream({
        async pull(controller) {
          try {
            let query = buildQuery().order('id', { ascending: true }).limit(500);
            if (lastId) query = query.gt('id', lastId);
            const { data, error } = await query;
            checkDb(error);
            const rows = (data || []) as unknown as Lead[];
            if (!rows.length) { if (header) controller.enqueue(encoder.encode(leadsToCsv([]))); controller.close(); return; }
            const csv = leadsToCsv(rows);
            controller.enqueue(encoder.encode(header ? csv : '\r\n' + csv.slice(csv.indexOf('\r\n') + 2)));
            header = false;
            lastId = rows[rows.length - 1].id;
            if (rows.length < 500) controller.close();
          } catch (error) { controller.error(error); }
        },
      });
      return new Response(stream, { headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="leadgen-leads.csv"' } });
    }
    const page = z.coerce.number().int().min(1).max(100000).parse(url.searchParams.get('page') || 1);
    const { data, count, error } = await buildQuery().order('created_at', { ascending: false }).order('id').range((page - 1) * 25, page * 25 - 1);
    checkDb(error);
    return Response.json({ leads: data, total: count, page, page_size: 25 });
  }
  if (request.method === 'GET' && path[0] === 'leads' && path.length === 2) {
    const { data, error } = await db.from('leads').select('*').eq('user_id', user.id).eq('id', uuid.parse(path[1])).maybeSingle();
    checkDb(error);
    if (!data) throw new ApiError(404, 'not_found', 'Lead not found.');
    return Response.json(data);
  }
  if (resource.startsWith('admin/')) {
    await requireAdmin(db, user);
    if (request.method === 'GET' && resource === 'admin/customers') {
      const { data: profiles, error } = await db.from('profiles').select('*').order('created_at', { ascending: false }).limit(100);
      checkDb(error);
      const ids = (profiles || []).map(p => p.user_id);
      if (!ids.length) return Response.json({ customers: [] });
      const { data: entitlements, error: entitlementError } = await db.from('entitlements').select('*').in('user_id', ids);
      checkDb(entitlementError);
      return Response.json({ customers: profiles!.map(p => ({ ...p, entitlement: entitlements?.find(e => e.user_id === p.user_id) })) });
    }
    if (request.method === 'PATCH' && path[1] === 'customers' && path.length === 3) {
      const input = z.object({ active: z.boolean(), expires_at: z.string().datetime().nullable(), grant: z.number().int().min(0).max(1000000) }).parse(await jsonBody(request));
      const { data, error } = await db.rpc('set_entitlement', { p_actor: user.id, p_user: uuid.parse(path[2]), p_active: input.active, p_expiry: input.expires_at, p_grant: input.grant }).single();
      checkDb(error);
      return Response.json(data);
    }
  }
  throw new ApiError(404, 'not_found', 'Endpoint not found.');
}

async function handler(request: Request, context: Context) {
  const origin = request.headers.get('origin');
  const allowed = new Set((process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean));
  allowed.add(new URL(request.url).origin);
  if (origin && !allowed.has(origin)) return errorResponse(new ApiError(403, 'origin_denied', 'This application origin is not allowed.'));
  let response: Response;
  try { response = request.method === 'OPTIONS' ? new Response(null, { status: 204 }) : await route(request, context); }
  catch (error) { response = errorResponse(error); }
  response.headers.set('Cache-Control', 'no-store');
  response.headers.set('Vary', 'Origin');
  if (origin) response.headers.set('Access-Control-Allow-Origin', origin);
  response.headers.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  response.headers.set('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
  return response;
}
export { handler as GET, handler as POST, handler as PATCH, handler as OPTIONS };
