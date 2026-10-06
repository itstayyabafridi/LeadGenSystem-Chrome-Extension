'use client';
import { useEffect, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import { ArrowDownToLine, ArrowUpRight, Building2, Check, ChevronLeft, ChevronRight, Clock3, CreditCard, ExternalLink, Globe, History, ListFilter, Loader2, LogOut, Mail, MapPin, Phone, RefreshCw, Search, Shield, SlidersHorizontal, X } from 'lucide-react';
import { hasAccess, type Entitlement, type Job, type Lead } from '@leadgen/shared';
import { api, downloadCsv, getClient } from '../lib/client';

interface Account { email: string; user_id: string; admin: boolean; entitlement: Entitlement; total_leads: number; with_email: number }
interface Customer { user_id: string; email: string; created_at: string; entitlement: Entitlement }
type View = 'leads' | 'collections' | 'subscription' | 'admin';
const formatDate = (date: string | null) => date ? new Date(date).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : 'Not set';
const message = (error: unknown) => error instanceof Error ? error.message : 'This action could not be completed.';

function Brand() { return <span className="brand"><span className="brand-mark"><MapPin size={23} strokeWidth={2.4} /></span>LeadGen</span>; }
function Auth({ recovery, onRecovered }: { recovery: boolean; onRecovered: () => void }) {
  const [mode, setMode] = useState<'login' | 'register' | 'reset' | 'update'>(recovery ? 'update' : 'login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const client = getClient();
  useEffect(() => { if (recovery) setMode('update'); }, [recovery]);
  async function submit(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setError(''); setNotice('');
    try {
      if (!client) throw new Error('Your workspace is not configured yet. Contact your administrator.');
      if (mode === 'login') {
        const { error } = await client.auth.signInWithPassword({ email, password }); if (error) throw error;
      } else if (mode === 'register') {
        const { error } = await client.auth.signUp({ email, password, options: { emailRedirectTo: window.location.origin } }); if (error) throw error;
        setNotice('Check your email to verify your account. Your administrator can then activate your subscription.');
      } else if (mode === 'reset') {
        const { error } = await client.auth.resetPasswordForEmail(email, { redirectTo: window.location.origin }); if (error) throw error;
        setNotice('If this email has an account, a password reset link is on its way.');
      } else {
        const { error } = await client.auth.updateUser({ password }); if (error) throw error;
        onRecovered();
      }
      setPassword('');
    } catch (e) { setError(message(e)); } finally { setBusy(false); }
  }
  return <div className="auth-layout">
    <section className="auth-story"><Brand /><div className="story-copy"><h1>A local search.<br />Your next opportunity.</h1><p>Turn the businesses you find on Google Maps into a lead list you can actually work with.</p><div className="story-route"><span><MapPin size={18} />Search an area</span><i /><span><Building2 size={18} />Collect businesses</span><i /><span><Mail size={18} />Find public contacts</span></div></div><p className="story-footer">Built for agencies, freelancers, and growing businesses.</p></section>
    <section className="auth-form"><div className="auth-form-inner"><h2>{mode === 'login' ? 'Welcome back' : mode === 'register' ? 'Create your workspace' : mode === 'reset' ? 'Reset your password' : 'Choose a new password'}</h2><p>{mode === 'login' ? 'Sign in to your business lead workspace.' : mode === 'register' ? 'Start with an account. Your subscription is activated by an administrator.' : 'Use your account email to recover access.'}</p>
      {!client && <div className="notice">Your workspace is not configured yet. Ask your administrator to finish setup.</div>}
      {error && <div className="alert" role="alert">{error}</div>}{notice && <div className="notice" role="status">{notice}</div>}
      <form onSubmit={submit}>
        {mode !== 'update' && <label>Email address<input type="email" autoComplete="email" required value={email} onChange={e => setEmail(e.target.value)} placeholder="you@company.com" /></label>}
        {mode !== 'reset' && <label>Password<input type="password" autoComplete={mode === 'login' ? 'current-password' : 'new-password'} required minLength={mode === 'login' ? 1 : 8} maxLength={128} value={password} onChange={e => setPassword(e.target.value)} placeholder={mode === 'login' ? 'Your password' : 'At least 8 characters'} /></label>}
        <button className="primary" disabled={busy || !client}>{busy ? <Loader2 className="spin" size={17} /> : null}{mode === 'login' ? 'Sign in' : mode === 'register' ? 'Create account' : mode === 'reset' ? 'Send reset link' : 'Save password'}</button>
      </form>
      {mode === 'login' && <button className="text-button" onClick={() => { setMode('reset'); setError(''); setNotice(''); }}>Forgot your password?</button>}
      {mode !== 'update' && <p className="auth-switch">{mode === 'login' ? 'New to LeadGen?' : 'Already have an account?'} <button className="text-button" onClick={() => { setMode(mode === 'login' ? 'register' : 'login'); setError(''); setNotice(''); }}>{mode === 'login' ? 'Create account' : 'Sign in'}</button></p>}
    </div></section>
  </div>;
}

export default function Dashboard({ extensionAvailable }: { extensionAvailable: boolean }) {
  const [session, setSession] = useState<Session | null>(null);
  const [initializing, setInitializing] = useState(true);
  const [recovery, setRecovery] = useState(false);
  const [account, setAccount] = useState<Account | null>(null);
  const [view, setView] = useState<View>('leads');
  const [leads, setLeads] = useState<Lead[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [selected, setSelected] = useState<Lead | null>(null);
  const [editCustomer, setEditCustomer] = useState<Customer | null>(null);
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState('');
  const [emailOnly, setEmailOnly] = useState(false);
  const [rating, setRating] = useState('');
  const [jobFilter, setJobFilter] = useState('');
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  useEffect(() => {
    const client = getClient();
    if (!client) { setInitializing(false); return; }
    void client.auth.getSession().then(({ data }) => { setSession(data.session); setInitializing(false); }).catch(() => setInitializing(false));
    const { data } = client.auth.onAuthStateChange((event, session) => { setSession(session); if (event === 'PASSWORD_RECOVERY') setRecovery(true); });
    return () => data.subscription.unsubscribe();
  }, []);
  useEffect(() => { const timeout = setTimeout(() => { setSearch(query); setPage(1); }, 300); return () => clearTimeout(timeout); }, [query]);
  useEffect(() => { setAccount(null); setLeads([]); setJobs([]); setCustomers([]); setSelected(null); setView('leads'); setError(''); }, [session?.user.id]);
  const filters = new URLSearchParams({ q: search, page: String(page), ...(emailOnly ? { email: 'true' } : {}), ...(rating ? { rating } : {}), ...(jobFilter ? { job: jobFilter } : {}) }).toString();
  useEffect(() => {
    if (!session || recovery) return;
    let alive = true;
    let inFlight = false;
    async function load(showLoading = false) {
      if (inFlight) return;
      inFlight = true;
      if (showLoading) setLoading(true);
      try {
        const [a, j, l] = await Promise.all([api<Account>('account'), api<{ jobs: Job[] }>('jobs'), api<{ leads: Lead[]; total: number }>(`leads?${filters}`)]);
        if (!alive) return;
        setAccount(a); setJobs(j.jobs); setLeads(l.leads); setTotal(l.total); setError('');
        if (view === 'admin' && a.admin) {
          const c = await api<{ customers: Customer[] }>('admin/customers');
          if (alive) setCustomers(c.customers);
        }
      } catch (e) { if (alive) setError(message(e)); }
      finally { inFlight = false; if (alive) setLoading(false); }
    }
    void load(true);
    const interval = setInterval(() => void load(), 15000);
    return () => { alive = false; clearInterval(interval); };
  }, [session?.user.id, recovery, filters, refreshKey, view]);
  async function act(fn: () => Promise<void>) {
    setBusy(true); setError(''); setNotice('');
    try { await fn(); setRefreshKey(v => v + 1); }
    catch (e) { setError(message(e)); }
    finally { setBusy(false); }
  }
  if (initializing) return <div className="loading-screen"><Brand /><Loader2 size={24} className="spin" /><p>Opening your workspace…</p></div>;
  if (!session || recovery) return <Auth recovery={recovery} onRecovered={() => { setRecovery(false); setNotice('Password updated.'); }} />;
  const activeJob = jobs.find(j => ['running','paused'].includes(j.status));
  const allowed = hasAccess(account?.entitlement || null);
  return <div className="app-shell">
    <aside className="sidebar"><Brand /><div className="workspace-name"><span className="workspace-avatar">{session.user.email?.[0]?.toUpperCase() || 'W'}</span><div><strong>Your workspace</strong><span>Business leads</span></div></div>
      <nav aria-label="Main navigation">{([
        ['leads', Building2, 'Lead library'], ['collections', History, 'Collections'], ['subscription', CreditCard, 'Subscription'],
        ...(account?.admin ? [['admin', Shield, 'Customers']] : []),
      ] as [View, typeof Building2, string][]).map(([key, Icon, label]) => <button key={key} className={view === key ? 'nav-item active' : 'nav-item'} onClick={() => { setView(key); setSelected(null); }}><Icon size={19} />{label}{key === 'leads' && !!account?.total_leads && <span className="nav-count">{account.total_leads}</span>}</button>)}</nav>
      <div className="extension-box"><MapPin size={23} /><strong>Find your next leads</strong><p>Open Google Maps and collect businesses with the Chrome extension.</p>{extensionAvailable ? <a className="extension-download" href="/downloads/leadgen-extension.zip"><ArrowDownToLine size={15} />Download extension</a> : <span className="muted small">Ask your administrator for the extension installation package.</span>}<a className="maps-link" href="https://www.google.com/maps?hl=en" target="_blank" rel="noreferrer">Open Google Maps<ArrowUpRight size={14} /></a></div>
      <div className="sidebar-user"><span className="user-email">{session.user.email}</span><button title="Sign out" aria-label="Sign out" className="icon-button" onClick={() => void act(async () => { const result = await getClient()!.auth.signOut(); if (result.error) throw result.error; })}><LogOut size={17} /></button></div>
    </aside>
    <div className="main-shell"><header className="topbar"><span>Workspace <ChevronRight size={13} /><strong>{view === 'leads' ? 'Lead library' : view === 'collections' ? 'Collections' : view === 'admin' ? 'Customers' : 'Subscription'}</strong></span><div className="topbar-right"><span className={`subscription-dot ${allowed ? 'is-active' : ''}`} /><span>{allowed ? 'Subscription active' : 'Activation needed'}</span><span className="credit-chip"><CreditCard size={14} />{account?.entitlement.credits.toLocaleString() ?? '—'} credits</span></div></header>
      <main className="workspace-main">
        {error && <div className="alert" role="alert">{error}<button className="text-button" onClick={() => setRefreshKey(v => v + 1)}>Retry</button></div>}
        {notice && <div className="notice success" role="status"><Check size={16} />{notice}<button className="icon-button" aria-label="Dismiss notice" onClick={() => setNotice('')}><X size={15} /></button></div>}
        {view === 'leads' && <>
          <div className="page-heading"><div><h1>Your lead library</h1><p>Businesses you found. Opportunities worth following up.</p></div><button className="primary" disabled={busy || !total} onClick={() => void act(async () => { downloadCsv(await api<string>(`leads/export?${filters}`)); setNotice('Your CSV export is ready.'); })}><ArrowDownToLine size={17} />Export CSV</button></div>
          <div className="summary-strip"><div><Building2 size={20} /><strong>{account?.total_leads.toLocaleString() ?? '—'}</strong><span>saved businesses</span></div><div><Mail size={20} /><strong>{account?.with_email.toLocaleString() ?? '—'}</strong><span>with public emails</span></div><div><CreditCard size={20} /><strong>{account?.entitlement.credits.toLocaleString() ?? '—'}</strong><span>credits available</span></div></div>
          {activeJob && <div className="active-collection"><span className={`status-dot ${activeJob.status === 'running' ? 'blue' : ''}`} /><div><strong>{activeJob.business}</strong><span>{activeJob.area} · {activeJob.saved_count + activeJob.duplicate_count} / {activeJob.lead_limit} collected</span></div><span className={`badge ${activeJob.status}`}>{activeJob.status}</span><button className="text-button" onClick={() => setView('collections')}>View collection<ChevronRight size={15} /></button></div>}
          <section className="lead-table-panel"><div className="table-toolbar"><label className="search-field"><Search size={18} /><input aria-label="Search leads" placeholder="Search business, category, or location…" value={query} onChange={e => setQuery(e.target.value)} /></label><div className="filters"><label className="checkbox-filter"><input type="checkbox" checked={emailOnly} onChange={e => { setEmailOnly(e.target.checked); setPage(1); }} /><Mail size={14} />Has email</label><label className="select-filter"><SlidersHorizontal size={14} /><select aria-label="Minimum rating" value={rating} onChange={e => { setRating(e.target.value); setPage(1); }}><option value="">All ratings</option><option value="4">4+ stars</option><option value="4.5">4.5+ stars</option></select></label><button className="icon-button" aria-label="Refresh leads" onClick={() => setRefreshKey(v => v + 1)}><RefreshCw size={16} className={loading ? 'spin' : ''} /></button></div></div>
            {jobFilter && <div className="filter-banner"><ListFilter size={14} />Showing one collection<button className="text-button" onClick={() => { setJobFilter(''); setPage(1); }}>Clear filter</button></div>}
            <div className="table-scroll"><table><thead><tr><th>Business</th><th>Location</th><th>Contact</th><th>Rating</th><th>Email discovery</th><th><span className="sr-only">Details</span></th></tr></thead><tbody>{leads.map(lead => <tr key={lead.id} onClick={() => setSelected(lead)}><td><button className="business-cell" onClick={() => setSelected(lead)}><span className="business-icon"><Building2 size={18} /></span><span><strong>{lead.name}</strong><small>{lead.category || 'Business'}</small></span></button></td><td className="location-cell"><span>{lead.address || 'Address unavailable'}</span></td><td><div className="contact-cell">{lead.phone ? <a href={`tel:${lead.phone}`} onClick={e => e.stopPropagation()}><Phone size={13} />{lead.phone}</a> : <span className="muted">No phone listed</span>}{lead.website && <a href={lead.website} target="_blank" rel="noreferrer" onClick={e => e.stopPropagation()}><Globe size={13} />Website<ExternalLink size={11} /></a>}</div></td><td><span className="rating">{lead.rating ? <><span>★</span> {lead.rating.toFixed(1)}</> : '—'}</span><small className="review-count">{lead.review_count === null ? '' : `${lead.review_count.toLocaleString()} reviews`}</small></td><td>{lead.emails.length ? <span className="badge completed"><Mail size={12} />{lead.emails.length} found</span> : <span className={`badge ${lead.enrichment_status}`}>{({ pending: 'Queued', running: 'Discovering', completed: 'None found', failed: 'Unavailable', not_available: 'No website' })[lead.enrichment_status]}</span>}</td><td><button className="icon-button" aria-label={`View ${lead.name}`}><ChevronRight size={17} /></button></td></tr>)}</tbody></table></div>
            {!leads.length && <div className="empty-state"><span className="empty-icon">{search || emailOnly || rating || jobFilter ? <Search size={28} /> : <MapPin size={28} />}</span><h2>{loading ? 'Loading your leads…' : search || emailOnly || rating || jobFilter ? 'No matching businesses' : 'Your first lead starts with a search'}</h2><p>{search || emailOnly || rating || jobFilter ? 'Try another search or adjust your filters.' : 'Open Google Maps, enter a business type and target area in the extension, and start collecting.'}</p>{!loading && !(search || emailOnly || rating || jobFilter) && <a className="primary" href="https://www.google.com/maps?hl=en" target="_blank" rel="noreferrer"><MapPin size={16} />Open Google Maps</a>}</div>}
            <div className="table-footer"><span>{total ? `${(page - 1) * 25 + 1}–${Math.min(page * 25, total)} of ${total.toLocaleString()} businesses` : '0 businesses'}<span className="refresh-note">Refreshes every 15 seconds</span></span><div className="pagination"><button aria-label="Previous page" disabled={page === 1 || loading} onClick={() => setPage(p => p - 1)}><ChevronLeft size={16} /></button><span>Page {page}</span><button aria-label="Next page" disabled={page * 25 >= total || loading} onClick={() => setPage(p => p + 1)}><ChevronRight size={16} /></button></div></div>
          </section><p className="data-note">Email addresses are found on public business websites. Deliverability has not been verified.</p>
        </>}
        {view === 'collections' && <><div className="page-heading"><div><h1>Your collections</h1><p>Follow progress and revisit businesses from each search.</p></div></div><div className="collection-list">{jobs.map(job => <article className="collection-row" key={job.id}><span className="collection-icon"><MapPin size={22} /></span><div className="collection-info"><h2>{job.business}</h2><p>{job.area}</p><small>{formatDate(job.created_at)}{job.reason ? ` · ${job.reason}` : ''}</small></div><div className="collection-metrics"><strong>{job.saved_count + job.duplicate_count}<span> / {job.lead_limit}</span></strong><small>{job.saved_count} new · {job.duplicate_count} existing · {job.skipped_count} skipped</small></div><span className={`badge ${job.status}`}>{job.status}</span><button onClick={() => { setJobFilter(job.id); setPage(1); setView('leads'); }}>View leads</button>{['running','paused'].includes(job.status) && <button disabled={busy} onClick={() => void act(async () => { await api(`jobs/${job.id}`, 'PATCH', { status: 'stopped', reason: 'Stopped from dashboard.', skipped_count: job.skipped_count }); setNotice('Collection stopped.'); })}>Stop</button>}</article>)}{!jobs.length && <div className="empty-state"><History size={30} /><h2>No collections yet</h2><p>Start a search in the Chrome extension to see it here.</p></div>}</div><p className="data-note">Pause and resume from the extension in your Google Maps tab. A paused collection must be resumed or stopped before starting another.</p></>}
        {view === 'subscription' && <><div className="page-heading"><div><h1>Your subscription</h1><p>Access and credits for your lead workspace.</p></div></div><section className="subscription-panel"><div><span className={`badge ${allowed ? 'completed' : 'paused'}`}>{allowed ? 'Active' : 'Activation needed'}</span><h2>{allowed ? 'Ready for your next search' : 'Activate your workspace'}</h2><p>Payments and renewals are handled by your administrator.</p></div><dl><div><dt>Credits remaining</dt><dd>{account?.entitlement.credits.toLocaleString() ?? '—'}</dd></div><div><dt>Subscription expires</dt><dd>{formatDate(account?.entitlement.expires_at || null)}</dd></div><div><dt>Customer account</dt><dd>{session.user.email}</dd></div></dl><div className="credit-explainer"><CreditCard size={21} /><div><strong>One credit per new business</strong><p>Repeat businesses update your existing lead without another charge. Website contact discovery is included.</p></div></div></section></>}
        {view === 'admin' && account?.admin && <><div className="page-heading"><div><h1>Customer access</h1><p>Activate subscriptions and grant credits after confirming payment.</p></div></div><div className="lead-table-panel table-scroll"><table><thead><tr><th>Customer</th><th>Access</th><th>Credits</th><th>Expires</th><th /></tr></thead><tbody>{customers.map(c => <tr key={c.user_id}><td><strong>{c.email}</strong><small className="review-count">Joined {formatDate(c.created_at)}</small></td><td><span className={`badge ${hasAccess(c.entitlement) ? 'completed' : 'paused'}`}>{hasAccess(c.entitlement) ? 'Active' : 'Inactive'}</span></td><td>{c.entitlement.credits.toLocaleString()}</td><td>{formatDate(c.entitlement.expires_at)}</td><td><button onClick={() => setEditCustomer(c)}>Manage access</button></td></tr>)}</tbody></table></div><p className="data-note">Showing the 100 most recently registered customers. Every access change is recorded in the credit ledger.</p></>}
      </main>
    </div>
    {selected && <LeadDetails lead={selected} onClose={() => setSelected(null)} />}
    {editCustomer && <CustomerEditor customer={editCustomer} busy={busy} onClose={() => setEditCustomer(null)} onSave={input => void act(async () => { await api(`admin/customers/${editCustomer.user_id}`, 'PATCH', input); setEditCustomer(null); setNotice('Customer access updated.'); })} />}
  </div>;
}

function LeadDetails({ lead, onClose }: { lead: Lead; onClose: () => void }) {
  const [current, setCurrent] = useState(lead);
  useEffect(() => {
    let alive = true;
    const load = () => void api<Lead>(`leads/${lead.id}`).then(l => { if (alive) setCurrent(l); }).catch(() => {});
    load(); const interval = setInterval(load, 15000);
    return () => { alive = false; clearInterval(interval); };
  }, [lead.id]);
  return <Modal onClose={onClose} title={current.name} className="lead-drawer"><div className="detail-category"><Building2 size={16} />{current.category || 'Business'}</div><h3>Business details</h3><dl className="detail-list">{([
    ['Address', current.address, MapPin], ['Phone', current.phone, Phone], ['Opening hours', current.hours, Clock3],
  ] as const).map(([label, value, Icon]) => <div key={label}><dt><Icon size={16} />{label}</dt><dd>{value || 'Not listed'}</dd></div>)}<div><dt><Globe size={16} />Website</dt><dd>{current.website ? <a href={current.website} target="_blank" rel="noreferrer">{new URL(current.website).hostname}<ExternalLink size={13} /></a> : 'Not listed'}</dd></div><div><dt>Rating</dt><dd>{current.rating ? `${current.rating} / 5` : 'Not listed'}{current.review_count !== null ? ` (${current.review_count} reviews)` : ''}</dd></div></dl><h3>Public email addresses</h3>{current.emails.length ? current.emails.map(contact => <div className="contact-result" key={contact.value}><a href={`mailto:${contact.value}`}><Mail size={15} />{contact.value}</a><a className="source-link" href={contact.source_url} target="_blank" rel="noreferrer">View source<ExternalLink size={11} /></a></div>) : <p className="muted">{['pending','running'].includes(current.enrichment_status) ? 'Contact discovery is in progress. This view refreshes automatically.' : current.enrichment_status === 'not_available' ? 'No business website is listed.' : current.enrichment_status === 'failed' ? 'The business website could not be read.' : 'No public email addresses were found.'}</p>}<h3>Social profiles</h3>{current.socials.length ? current.socials.map(c => <a className="social-link" href={c.value} target="_blank" rel="noreferrer" key={c.value}>{new URL(c.value).hostname.replace('www.', '')}<ExternalLink size={13} /></a>) : <p className="muted">No social links found.</p>}<a className="maps-button" href={current.maps_url} target="_blank" rel="noreferrer"><MapPin size={16} />View on Google Maps<ArrowUpRight size={15} /></a><p className="data-note">Last collected {formatDate(current.collected_at)}. Email deliverability is unverified.</p></Modal>;
}
function CustomerEditor({ customer, busy, onClose, onSave }: { customer: Customer; busy: boolean; onClose: () => void; onSave: (input: { active: boolean; expires_at: string | null; grant: number }) => void }) {
  const [active, setActive] = useState(customer.entitlement.active);
  const [date, setDate] = useState(customer.entitlement.expires_at ? new Date(customer.entitlement.expires_at).toISOString().slice(0,10) : '');
  const [grant, setGrant] = useState(0);
  return <Modal title="Manage customer access" onClose={onClose}><p>{customer.email}</p><form onSubmit={e => { e.preventDefault(); onSave({ active, expires_at: date ? new Date(`${date}T23:59:59Z`).toISOString() : null, grant }); }}><label className="checkbox-filter"><input type="checkbox" checked={active} onChange={e => setActive(e.target.checked)} />Subscription active</label><label>Expiry date (UTC)<input type="date" required={active} value={date} min={active ? new Date().toISOString().slice(0,10) : undefined} onChange={e => setDate(e.target.value)} /></label><label>Credits to add<input type="number" min={0} max={1000000} required value={grant} onChange={e => setGrant(Number(e.target.value))} /><small className="muted">Current balance: {customer.entitlement.credits}. This adds credits; it does not replace the balance.</small></label><button className="primary" disabled={busy}>Save access</button></form></Modal>;
}
function Modal({ title, onClose, children, className = '' }: { title: string; onClose: () => void; children: React.ReactNode; className?: string }) {
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
    dialog?.focus();
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
      if (event.key === 'Tab' && dialog) {
        const elements = [...dialog.querySelectorAll<HTMLElement>('a[href],button:not(:disabled),input:not(:disabled),select:not(:disabled),[tabindex="0"]')];
        const first = elements[0], last = elements[elements.length - 1];
        if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog)) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialog)) { event.preventDefault(); first?.focus(); }
      }
    };
    document.addEventListener('keydown', handler);
    return () => { document.removeEventListener('keydown', handler); document.body.style.overflow = previousOverflow; previous?.focus(); };
  }, [onClose]);
  return <div className={`modal-backdrop ${className}`} onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}><section className="modal" role="dialog" aria-modal="true" aria-label={title} tabIndex={-1}><header><h2>{title}</h2><button className="icon-button" onClick={onClose} aria-label="Close dialog"><X size={20} /></button></header>{children}</section></div>;
}
