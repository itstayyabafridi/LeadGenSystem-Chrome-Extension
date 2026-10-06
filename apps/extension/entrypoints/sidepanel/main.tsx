import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { browser } from 'wxt/browser';
import { ArrowUpRight, Download, MapPin, Pause, Play, Square, LogOut, Search, CheckCircle2 } from 'lucide-react';
import { hasAccess, type Entitlement, type ExtensionState } from '@leadgen/shared';
import { send } from '../../lib/protocol';
import './style.css';

const WEB = (import.meta.env.WXT_API_URL || 'http://localhost:3000').replace(/\/$/, '');
function App() {
  const [state, setState] = useState<ExtensionState>({ checkpoint: null, email: null, accountId: null });
  const [account, setAccount] = useState<{ entitlement: Entitlement } | null>(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [business, setBusiness] = useState('');
  const [area, setArea] = useState('');
  const [limit, setLimit] = useState(100);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  async function refresh() {
    const next = await send<ExtensionState>({ type: 'GET_STATE' });
    setState(next);
    if (next.accountId) setAccount(await send({ type: 'ACCOUNT' }));
    else setAccount(null);
  }
  useEffect(() => {
    void refresh().catch(e => setError(e.message));
    const listener = (changes: Record<string, unknown>, areaName: string) => {
      if (areaName === 'local' && ('checkpoint' in changes || 'session' in changes)) void refresh().catch(e => setError(e.message));
    };
    browser.storage.onChanged.addListener(listener);
    return () => browser.storage.onChanged.removeListener(listener);
  }, []);
  async function action(fn: () => Promise<unknown>) {
    setBusy(true); setError(''); setNotice('');
    try { await fn(); await refresh(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Action failed.'); }
    finally { setBusy(false); }
  }
  async function tabId() {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error('Open Google Maps in the current tab first.');
    return tab.id;
  }
  const cp = state.checkpoint;
  const active = !!cp && ['running','paused'].includes(cp.job.status);
  const running = cp?.job.status === 'running';
  const count = cp ? cp.job.saved_count + cp.job.duplicate_count : 0;
  const allowed = hasAccess(account?.entitlement || null);
  return <main>
    <header><a className="brand" href={WEB} target="_blank" rel="noreferrer"><span className="mark"><MapPin size={21} /></span>LeadGen</a><a className="icon-link" href={WEB} target="_blank" rel="noreferrer" aria-label="Open dashboard"><ArrowUpRight size={20} /></a></header>
    {error && <div className="alert" role="alert">{error}</div>}
    {notice && <div className="notice" role="status">{notice}</div>}
    {!state.accountId ? <>
      <div className="intro"><span className="illustration"><Search size={30} /></span><h1>Your next customers<br />are on the map.</h1><p>Sign in to collect business details and build your lead list.</p></div>
      <form onSubmit={e => { e.preventDefault(); void action(async () => { await send({ type: 'LOGIN', email, password }); setPassword(''); }); }}>
        <label>Email<input type="email" autoComplete="email" required value={email} onChange={e => setEmail(e.target.value)} /></label>
        <label>Password<input type="password" autoComplete="current-password" required value={password} onChange={e => setPassword(e.target.value)} /></label>
        <button disabled={busy} className="primary">{busy ? 'Signing in…' : 'Sign in'}</button>
      </form>
      <p className="footnote">New here? <a href={WEB} target="_blank" rel="noreferrer">Create your account</a></p>
    </> : <>
      <div className="account"><span title={state.email || ''}>{state.email}</span><button className="icon-link" aria-label="Sign out" disabled={busy} onClick={() => void action(() => send({ type: 'LOGOUT' }))}><LogOut size={16} /></button></div>
      <div className="balance"><span>Lead credits</span><strong>{account?.entitlement.credits.toLocaleString() ?? '—'}</strong></div>
      {!allowed && <div className="notice">Your subscription needs activation or renewal. Contact your administrator to start collecting.</div>}
      <div className="section-title"><h1>Find businesses</h1><p>Choose a business type and an area to search.</p></div>
      <form onSubmit={e => { e.preventDefault(); void action(async () => send({ type: 'START', business, area, limit, tabId: await tabId() })); }}>
        <label>Business type<input required minLength={2} maxLength={120} placeholder="e.g. Dental clinics" value={business} disabled={active} onChange={e => setBusiness(e.target.value)} /></label>
        <label>Target area<input required minLength={2} maxLength={180} placeholder="e.g. Lahore, Pakistan" value={area} disabled={active} onChange={e => setArea(e.target.value)} /></label>
        <label>Maximum leads<input type="number" min={1} max={200} required value={limit} disabled={active} onChange={e => setLimit(Number(e.target.value))} /><span className="hint">Up to 200 per search. Available results may be fewer.</span></label>
        {!active && <button className="primary" disabled={busy || !allowed || !account?.entitlement.credits}><Search size={16} />Start collection</button>}
      </form>
      {cp && <section className="progress-panel">
        <div className="progress-heading"><h2>{cp.job.business}</h2><span className={`status ${cp.job.status}`}>{cp.job.status}</span></div>
        <p className="area"><MapPin size={13} />{cp.job.area}</p>
        <div className="progress-track" role="progressbar" aria-valuemin={0} aria-valuemax={cp.job.lead_limit} aria-valuenow={count}><span style={{ width: `${Math.min(100, count / cp.job.lead_limit * 100)}%` }} /></div>
        <p className="progress-caption">{count} of {cp.job.lead_limit} businesses</p>
        <div className="counts"><div><strong>{cp.job.saved_count}</strong><span>New leads</span></div><div><strong>{cp.job.duplicate_count}</strong><span>Already saved</span></div><div><strong>{cp.job.skipped_count}</strong><span>Skipped</span></div></div>
        {cp.reason && <p className="reason">{cp.reason}</p>}
        {cp.pending && active && <p className="reason">One lead is waiting to sync. Resume to retry, or stop and save a recovery CSV.</p>}
        {cp.controlPending && <p className="reason">Collection status is waiting to sync.</p>}
        {active && <div className="controls"><button disabled={busy || (!running && !allowed)} onClick={() => void action(async () => running ? send({ type: 'PAUSE' }) : send({ type: 'RESUME', tabId: await tabId() }))}>{running ? <Pause size={15} /> : <Play size={15} />}{running ? 'Pause' : 'Resume'}</button><button disabled={busy} onClick={() => void action(() => send({ type: 'STOP' }))}><Square size={14} />Stop</button></div>}
        <button className="export" disabled={busy || !count} onClick={() => void action(async () => {
          const csv = await send<string>({ type: 'EXPORT', jobId: cp.job.id });
          const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
          const link = document.createElement('a'); link.href = url; link.download = `leadgen-${cp.job.business.replace(/[^a-z0-9]/gi, '-')}.csv`; link.click();
          setTimeout(() => URL.revokeObjectURL(url), 10000);
          setNotice('CSV export downloaded.');
        })}><Download size={15} />Export collected leads</button>
      </section>}
      {!!state.unsynced_count && <div className="notice"><div>{state.unsynced_count} business record(s) are saved locally but have not been confirmed as uploaded.<button className="export" disabled={busy} onClick={() => void action(async () => {
        const csv = await send<string>({ type: 'EXPORT_UNSYNCED' });
        const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
        const link = document.createElement('a'); link.href = url; link.download = 'leadgen-recovery.csv'; link.click();
        setTimeout(() => URL.revokeObjectURL(url), 10000);
        setNotice('Local recovery CSV downloaded. These records may not be in your dashboard.');
      })}><Download size={14} />Download recovery CSV</button></div></div>}
      <div className="included"><CheckCircle2 size={16} /><p>Public website emails are discovered in the background. View enrichment results in your dashboard.</p></div>
      <a className="dashboard-link" href={WEB} target="_blank" rel="noreferrer">Open your lead dashboard<ArrowUpRight size={15} /></a>
    </>}
    <footer>One credit per new business. Repeat results are included.</footer>
  </main>;
}
createRoot(document.getElementById('root')!).render(<App />);
