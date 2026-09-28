import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { RUBRIC, scoreTotal } from '../../../shared/creative-services/contract.mjs';
import { analysisApi, checkedJob, checkedHostedJob, hostedAnalysis, prepareAnalysis, SERVICE_NAMES, type AnalysisInput, type AnalysisJob, type AnalysisReport, type ServiceCatalog, type ServiceKind, type ServiceQuote } from '../creative-services';
import { canonicalJson, downloadText, safeFilename } from '../model';
import type { DraftRecord } from '../types';
import './creative-services.css';

export function AnalysisResult({ report }: { report: AnalysisReport }) {
  return <article className="cs-result" aria-label="Analysis report">
    <div className="cs-heading"><div><small>ADVISORY · {report.input.source.scope === 'full' ? 'FULL SUPPLIED TEXT' : 'OPENING PASSAGE ONLY'}</small><h3>{SERVICE_NAMES[report.input.kind]}</h3></div>
      <Button size="sm" variant="outline" onClick={() => downloadText(`${safeFilename(report.input.source.title)}-analysis.json`, JSON.stringify(report, null, 2), 'application/json')}>Export report</Button></div>
    <p>{report.output.summary}</p>
    {report.output.scores.length > 0 && <><strong className="cs-total">{scoreTotal(report.output)} <small>/ 120</small></strong><dl className="cs-scores">{report.output.scores.map(s => <div key={s.key}><dt>{s.key}</dt><dd>{s.score} / {RUBRIC[s.key]}</dd>{s.evidence && <blockquote>{s.evidence}</blockquote>}</div>)}</dl></>}
    {(['strengths', 'concerns', 'nextSteps'] as const).map(key => report.output[key].length > 0 && <section key={key}><h4>{{ strengths: 'Strengths', concerns: 'Questions to explore', nextSteps: 'Next steps' }[key]}</h4><ul>{report.output[key].map((s, i) => <li key={i}>{s}</li>)}</ul></section>)}
    {report.output.sections.map((s, i) => <section key={i}><h4>{s.heading}</h4><p>{s.body}</p>{s.evidence && <blockquote>{s.evidence}</blockquote>}</section>)}
    <footer>{report.model} · {report.provider === 'ollama' ? 'Your local model · 0 platform tokens' : `${report.platformCredits} platform tokens`}<br/>Model usage: {report.usage.inputTokens ?? 'unknown'} input / {report.usage.outputTokens ?? 'unknown'} output tokens · {new Date(report.createdAt).toLocaleString()}<br/>Source: {report.input.source.title} · SHA-256 {report.input.source.bodySha256.slice(0, 12)}…</footer>
  </article>;
}

export function CreativeServicesPanel({ draft, dirty }: { draft: DraftRecord | null; dirty: boolean }) {
  const [kind, setKind] = useState<ServiceKind>('coverage');
  const [character, setCharacter] = useState('');
  const [excerptApproved, setExcerptApproved] = useState(false);
  const [provider, setProvider] = useState<'local' | 'hosted'>('local');
  const [endpoint, setEndpoint] = useState('http://127.0.0.1:11434');
  const [models, setModels] = useState<string[]>([]), [model, setModel] = useState('');
  const [prepared, setPrepared] = useState<AnalysisInput | null>(null);
  const [attempt, setAttempt] = useState<string | null>(null);
  const [jobs, setJobs] = useState<AnalysisJob[]>([]), [report, setReport] = useState<AnalysisReport | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [catalog, setCatalog] = useState<ServiceCatalog | null>(null), [quote, setQuote] = useState<ServiceQuote | null>(null);
  const [connected, setConnected] = useState(false), [email, setEmail] = useState(''), [password, setPassword] = useState('');
  const [hostedJobs, setHostedJobs] = useState<AnalysisJob[]>([]);
  const revision = `${draft?.id}:${draft?.sha256}:${dirty}:${kind}:${character}:${provider}:${endpoint}:${model}:${excerptApproved}`;
  const latest = useRef(revision); latest.current = revision;
  useEffect(() => { setPrepared(null); setQuote(null); setAttempt(null); }, [revision]);
  const work = async (fn: () => Promise<void>) => { setBusy(true); setError(''); setNotice(''); try { await fn(); } catch (e) { setError(e instanceof Error ? e.message : 'The service request failed.'); } finally { setBusy(false); } };
  const history = async () => {
    if (!draft) return;
    const data = await analysisApi.history(draft.id);
    setJobs(data.jobs.map(j => checkedJob(j)));
    if (data.issues.length) setNotice(`${data.issues.length} stored analysis receipt(s) could not be read. Their files have been preserved.`);
  };
  useEffect(() => { if (draft) void work(history); }, [draft?.id]);
  const prepare = () => work(async () => {
    if (!draft || dirty) throw new Error('Save this draft before preparing analysis.');
    const atStart = revision;
    const input = await prepareAnalysis(draft, kind, character, excerptApproved);
    if (latest.current === atStart) { setPrepared(input); setAttempt(null); setQuote(null); }
  });
  const loadHosted = async () => {
    const c = await hostedAnalysis<ServiceCatalog>({ action: 'catalog' });
    if (typeof c.enabled !== 'boolean' || !Array.isArray(c.services) || !(c.balance === null || Number.isSafeInteger(c.balance) && c.balance >= 0)) throw new Error('The hosted catalog is invalid.');
    setCatalog(c);
    const result = await hostedAnalysis<{ jobs: AnalysisJob[] }>({ action: 'jobs' });
    setHostedJobs(result.jobs.map(j => checkedHostedJob(j)));
  };
  const connect = () => work(async () => {
    const auth = await import('../connectors/competition');
    const session = password ? await auth.signInWithPassword(email, password) : await auth.currentSession();
    setPassword('');
    if (!session) throw new Error('Enter your CanIScreenwrite account email and password to connect.');
    setConnected(true); await loadHosted();
  });
  const runLocal = () => work(async () => {
    if (!prepared || dirty || !model) return;
    const requestId = attempt ?? crypto.randomUUID(); setAttempt(requestId);
    const result = checkedJob(await analysisApi.run(requestId, endpoint, model, prepared), prepared);
    if (result.report) setReport(result.report);
    else setNotice(result.status === 'running' ? 'Analysis is running. Refresh saved reports to check its status.' : `Analysis ${result.status}. ${result.error ?? ''} No platform tokens charged.`);
    await history();
  });
  const getQuote = () => work(async () => {
    if (!prepared) return;
    const atStart = revision;
    const q = await hostedAnalysis<ServiceQuote>({ action: 'quote', input: prepared });
    if (!q || q.kind !== prepared.kind || canonicalJson(q.input) !== canonicalJson(prepared) || !Number.isSafeInteger(q.credits) || q.credits < 1 || !q.model || !/^[a-f\d-]{36}$/i.test(q.id) || !(Date.parse(q.expiresAt) > Date.now())) throw new Error('The quote does not match the reviewed request.');
    if (latest.current === atStart) setQuote(q);
  });
  const submit = () => work(async () => {
    if (!quote || dirty || !prepared) return;
    // Reuse this quote ID on retry; the server owns charge and dispatch identity.
    const result = checkedHostedJob(await hostedAnalysis<AnalysisJob>({ action: 'submit', quoteId: quote.id }), quote);
    if (result.report) setReport(result.report);
    setNotice(`Hosted analysis: ${result.status}. ${result.error ?? ''}`); await loadHosted();
  });
  const service = catalog?.services.find(s => s.kind === kind && s.enabled);
  return <div className="cs-panel">
    <header><small>THE WRITER’S DESK</small><h2>Scoring & creative profiles</h2><p>Explore your screenplay with your own model, or request a quoted service from CanIScreenwrite. Reports remain separate from your writing and world canon.</p></header>
    <div className="cs-provider" role="group" aria-label="Analysis provider"><button aria-pressed={provider === 'local'} disabled={busy} onClick={() => setProvider('local')}><strong>Your local model</strong><span>0 platform tokens · runs on your Mac</span></button><button aria-pressed={provider === 'hosted'} disabled={busy} onClick={() => setProvider('hosted')}><strong>CanIScreenwrite services</strong><span>Your account · quoted platform tokens</span></button></div>
    <p className="cs-caption">Advisory analysis uses the 9-dimension / 120-point rubric. Official competition entries and judging remain in the Competition connection.</p>
    {(!draft || dirty) && <p role="status">Save your screenplay to prepare analysis of its current revision.</p>}
    <fieldset disabled={busy} className="cs-form"><label>Service<select value={kind} onChange={e => setKind(e.target.value as ServiceKind)}>{Object.entries(SERVICE_NAMES).map(([value, name]) => <option key={value} value={value}>{name}</option>)}</select></label>
      {kind === 'character_profile' && <label>Character name<Input value={character} maxLength={160} onChange={e => setCharacter(e.target.value)} placeholder="Character in this screenplay" /></label>}
      {draft && draft.data.body.length > 12000 && <label className="cs-check"><input type="checkbox" checked={excerptApproved} onChange={e => setExcerptApproved(e.target.checked)} />Analyze only the opening passage (up to 12,000 characters). This will not score the full screenplay.</label>}
      {provider === 'local' ? <><label>Ollama on this Mac<Input value={endpoint} onChange={e => { setEndpoint(e.target.value); setModels([]); setModel(''); }} /></label><p className="cs-caption">Your installed model uses your hardware. No platform tokens or cloud fallback. Ollama must already be running.</p><Button variant="outline" onClick={() => void work(async () => { const result = await analysisApi.models(endpoint); setModels(result.models.map(m => m.name)); setModel(result.models[0]?.name ?? ''); if (!result.models.length) setNotice('No eligible local models found. Cloud models are excluded.'); })}>Find installed models</Button><label>Model<select value={model} onChange={e => setModel(e.target.value)}><option value="">Select an installed model</option>{models.map(m => <option key={m}>{m}</option>)}</select></label></> : <div className="cs-hosted"><h3>Your service account</h3>{!connected ? <><label>Email<Input type="email" autoComplete="username" value={email} onChange={e => setEmail(e.target.value)} /></label><label>Password<Input type="password" autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} /></label><Button variant="outline" onClick={connect}>Connect account</Button></> : <><p>Balance: {catalog?.balance == null ? 'unavailable' : `${catalog.balance} platform tokens`}</p><Button variant="outline" onClick={() => void work(loadHosted)}>Refresh balance & jobs</Button><Button variant="ghost" onClick={() => void work(async () => { await (await import('../connectors/competition')).signOut(); setConnected(false); setCatalog(null); setQuote(null); setHostedJobs([]); })}>Sign out</Button></>}
        <p>{catalog?.enabled && service ? `${service.credits} tokens · ${service.model}. Request a current quote before submitting.` : 'Hosted analysis is unavailable until the service catalog and provider are configured.'}</p><Button variant="outline" disabled>Buy platform tokens — not yet enabled</Button><p className="cs-caption">The purchase and receipt system must be verified before token sales open. No payment is taken here.</p></div>}
      <Button disabled={!draft || dirty || !draft.data.body.trim() || (kind === 'character_profile' && !character.trim()) || (draft.data.body.length > 12000 && !excerptApproved)} onClick={prepare}>Review text for analysis</Button>
    </fieldset>
    {prepared && <section className="cs-review"><h3>Review your request</h3><p>{SERVICE_NAMES[prepared.kind]} · {prepared.source.title} · {prepared.source.scope === 'full' ? 'Full supplied text' : 'Opening passage only'}</p><pre>{prepared.source.excerpt}</pre><p>{provider === 'local' ? `Destination: ${endpoint} · ${model || 'select a model'}. 0 platform tokens.` : 'This exact text will be uploaded to CanIScreenwrite when you request a quote.'}</p>
      {provider === 'local' ? <Button disabled={busy || dirty || !model} onClick={runLocal}>{attempt ? 'Retrieve / retry this request' : 'Run on my local model'}</Button> : <><Button variant="outline" disabled={busy || dirty || !connected || !catalog?.enabled || !service} onClick={getQuote}>Upload reviewed text & request quote</Button>{quote && <div className="cs-quote"><strong>{quote.credits} platform tokens · {quote.model}</strong><p>Quote expires {new Date(quote.expiresAt).toLocaleTimeString()}. A confirmed failed analysis is refunded; interrupted jobs require status review.</p><Button disabled={busy || dirty || Date.parse(quote.expiresAt) <= Date.now()} onClick={submit}>Confirm & spend {quote.credits} tokens</Button></div>}</>}
    </section>}
    <div aria-live="polite">{busy && <p role="status">Working… Your screenplay remains saved.</p>}{notice && <p role="status">{notice}</p>}{error && <p role="alert" className="text-destructive">{error}</p>}</div>
    {report && <AnalysisResult report={report} />}
    <section className="cs-history"><div className="cs-heading"><h3>Saved local reports</h3><Button size="sm" variant="ghost" disabled={busy || !draft} onClick={() => void work(history)}>Refresh reports</Button></div><p className="cs-caption">Analysis reports are stored separately from workspace backups. Export reports to keep portable copies.</p>{!jobs.length && <p>No local analysis yet for this screenplay.</p>}{jobs.map(j => <div key={j.id}><span>{j.input ? SERVICE_NAMES[j.input.kind] : 'Analysis'} · {j.status}{j.error ? ` · ${j.error}` : ''}</span>{j.report && <Button size="sm" variant="ghost" onClick={() => setReport(j.report)}>Read report</Button>}</div>)}</section>
    {connected && hostedJobs.length > 0 && <section className="cs-history"><h3>Hosted service jobs</h3>{hostedJobs.map(j => <div key={j.id}><span>{j.report?.input.source.title ?? `Request ${j.id.slice(0, 8)}`} · {j.status} · {j.credits} tokens</span><Button size="sm" variant="ghost" disabled={busy} onClick={() => void work(async () => { const updated = checkedHostedJob(await hostedAnalysis<AnalysisJob>({ action: 'job', jobId: j.id }), undefined, j.id); if (updated.report) setReport(updated.report); await loadHosted(); setNotice(`${updated.status}: ${updated.error ?? 'Status refreshed.'}`); })}>{j.report ? 'Read report' : 'Check status'}</Button></div>)}</section>}
  </div>;
}
