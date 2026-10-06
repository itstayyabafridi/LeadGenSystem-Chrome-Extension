'use client';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
let client: SupabaseClient | null | undefined;
export function getClient(): SupabaseClient | null {
  if (client !== undefined) return client;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  client = url && key ? createClient(url, key) : null;
  return client;
}
export async function api<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const session = await getClient()?.auth.getSession();
  const token = session?.data.session?.access_token;
  if (!token) throw new Error('Your session expired. Sign in again.');
  const response = await fetch(`/api/v1/${path}`, {
    method, headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ message: 'The server could not complete this request.' }));
    throw new Error(error.message);
  }
  return response.headers.get('content-type')?.includes('text/csv') ? await response.text() as T : await response.json() as T;
}
export function downloadCsv(csv: string) {
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a'); link.href = url; link.download = 'leadgen-leads.csv'; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
