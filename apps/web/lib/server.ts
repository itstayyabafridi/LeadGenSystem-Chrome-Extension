import { createClient, type SupabaseClient, type User } from '@supabase/supabase-js';
import { ZodError, z } from 'zod';

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}
export function publicClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) throw new ApiError(503, 'not_configured', 'Configure Supabase before using the application.');
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}
export function serviceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new ApiError(503, 'not_configured', 'The application backend is not configured.');
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}
export async function authenticate(request: Request): Promise<{ user: User; db: SupabaseClient }> {
  const header = request.headers.get('authorization');
  if (!header?.startsWith('Bearer ')) throw new ApiError(401, 'unauthorized', 'Sign in to continue.');
  const { data, error } = await publicClient().auth.getUser(header.slice(7));
  if (error || !data.user) throw new ApiError(401, 'unauthorized', 'Your session expired. Sign in again.');
  return { user: data.user, db: serviceClient() };
}
export async function requireAdmin(db: SupabaseClient, user: User) {
  const { data, error } = await db.from('admins').select('user_id').eq('user_id', user.id).maybeSingle();
  checkDb(error);
  if (!data) throw new ApiError(403, 'admin_required', 'Administrator access is required.');
}
export async function jsonBody(request: Request): Promise<unknown> {
  if (!request.headers.get('content-type')?.includes('application/json')) throw new ApiError(415, 'json_required', 'Send an application/json request.');
  if (Number(request.headers.get('content-length') || 0) > 65536) throw new ApiError(413, 'body_too_large', 'Request is too large.');
  // Limit chunked requests too; do not allocate an unbounded request body.
  const reader = request.body?.getReader();
  if (!reader) throw new ApiError(400, 'invalid_json', 'A JSON body is required.');
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > 65536) { await reader.cancel(); throw new ApiError(413, 'body_too_large', 'Request is too large.'); }
    chunks.push(value);
  }
  const merged = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.length; }
  try { return JSON.parse(new TextDecoder().decode(merged)); }
  catch { throw new ApiError(400, 'invalid_json', 'The request contains invalid JSON.'); }
}
const dbErrors: Record<string, [number, string]> = {
  subscription_inactive: [403, 'Your subscription is inactive or expired. Contact the administrator.'],
  credits_exhausted: [402, 'Your lead credits are exhausted.'],
  active_job_exists: [409, 'Resume or stop your existing collection before starting another.'],
  job_not_found: [404, 'Collection not found.'],
  job_not_active: [409, 'This collection is no longer active.'],
  job_limit_reached: [409, 'This collection reached its lead limit.'],
  job_is_terminal: [409, 'A finished collection cannot be resumed.'],
  customer_not_found: [404, 'Customer not found.'],
  admin_required: [403, 'Administrator access is required.'],
  future_expiry_required: [400, 'An active subscription needs a future expiry date.'],
};
export function checkDb(error: { message: string; code?: string } | null) {
  if (!error) return;
  const mapped = dbErrors[error.message];
  if (mapped) throw new ApiError(mapped[0], error.message, mapped[1]);
  console.error('Database operation failed', { code: error.code });
  throw new ApiError(503, 'database_error', 'The database is unavailable or migrations have not been applied.');
}
export function errorResponse(error: unknown) {
  if (error instanceof ZodError) return Response.json({ error: 'invalid_input', message: error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ') }, { status: 400 });
  if (error instanceof ApiError) return Response.json({ error: error.code, message: error.message }, { status: error.status });
  console.error('Unhandled API error', error instanceof Error ? error.name : 'unknown');
  return Response.json({ error: 'internal_error', message: 'The request could not be completed. Try again.' }, { status: 500 });
}
export const uuid = z.string().uuid();
