import { createClient } from '@supabase/supabase-js';
import { enrichWebsite } from './enrichment';

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) throw new Error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY for the enrichment worker.');
const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
const pollMs = Math.max(1000, Number(process.env.WORKER_POLL_MS) || 3000);
let stopping = false;
process.on('SIGINT', () => { stopping = true; });
process.on('SIGTERM', () => { stopping = true; });

console.log('Contact discovery worker started');
while (!stopping) {
  try {
    const { data: task, error } = await db.rpc('claim_enrichment');
    if (error) throw new Error(`Claim failed (${error.code})`);
    if (!task) { await new Promise(resolve => setTimeout(resolve, pollMs)); continue; }
    let contacts = { emails: [] as { value: string; source_url: string }[], socials: [] as { value: string; source_url: string }[] };
    let failure: string | null = null;
    try { contacts = await enrichWebsite(task.website); }
    catch (error) { failure = error instanceof Error ? error.message : 'Website discovery failed'; }
    const { data: accepted, error: finishError } = await db.rpc('finish_enrichment', {
      p_task: task.id, p_token: task.lease_token, p_emails: contacts.emails, p_socials: contacts.socials, p_error: failure,
    });
    if (finishError) throw new Error(`Finish failed (${finishError.code})`);
    console.log(`Task ${task.id}: ${accepted ? failure ? 'retry or failure recorded' : 'completed' : 'lease superseded'}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Worker failed');
    await new Promise(resolve => setTimeout(resolve, pollMs));
  }
}
console.log('Contact discovery worker stopped');
