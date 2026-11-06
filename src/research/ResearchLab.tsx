import { useCallback, useEffect, useRef, useState } from 'react';
import './research-lab.css';

type Score = { correct: number; total: number; accuracy: number };
type Config = { titleWeight: number; textWeight: number; tagWeight: number };
type Resources = { inputTokens: number; outputTokens: number; providerCostUsd: string; energyKwh: number | null; cpuMicros: number | null; resultBytes: number; elapsedMs: number };
type Run = { id: string; requestId?: string; status: string; reason: string | null; decision: string | null; completedTrials: number; elapsedMs: number | null;
  development: { baseline: Score; candidate: Score } | null; confirmation: { baseline: Score; candidate: Score } | null; resources: Resources | null;
  review: { decision: string; reason: string } | null };
type Proposal = Run & { proposalHash: string; config: Config; acceptedVersion: number; sourceHash: string; checks: Record<string, string> };
type Snapshot = { schema: string; app: string; projectId: string; degraded: boolean; error?: string;
  target: { id: string; title: string; description: string }; contract: { datasetHash?: string; evaluatorHash?: string; policyHash?: string };
  accepted: { version: number; hash: string; config: Config } | null;
  active: { id: string; completedTrials: number; maxTrials: number } | null; runs: Run[]; pendingReviews: Proposal[];
  events: { sequence: number; hash: string; type: string; data: { decision?: string; reason?: string } }[] };
type Request = { projectId: string; requestId: string; maxTrials: number; maxWallMs: number; trialTimeoutMs: number };
const score = (value: Score | undefined) => value ? `${value.correct} / ${value.total}` : 'Not evaluated';
const duration = (value: number | null | undefined) => value == null ? 'Unknown' : `${(value / 1000).toFixed(2)} s`;
async function request(route: string, data?: unknown): Promise<Snapshot> {
  const response = await fetch(`/api/research-loop${route}`, { credentials: 'same-origin', redirect: 'error',
    ...(data === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }) });
  const result = await response.json();
  if (!response.ok) throw new Error(result?.error ?? `Research request failed (${response.status}).`);
  return result;
}

export default function ResearchLab({ projectId, app, onOpen }: { projectId: string; app: 'qimovi' | 'qiscreenwrite'; onOpen?: () => void }) {
  const [open, setOpen] = useState(false), [value, setValue] = useState<Snapshot | null>(null), [error, setError] = useState('');
  const [busy, setBusy] = useState(false), [pending, setPending] = useState<Request | null>(null);
  const [trials, setTrials] = useState(6), [seconds, setSeconds] = useState(60), [timeout, setTimeoutSeconds] = useState(5);
  const dialog = useRef<HTMLDialogElement>(null), alive = useRef(true), sequence = useRef(0), working = useRef(false);
  const accept = useCallback((result: Snapshot) => {
    if (result?.schema !== 'qi-research-loop/v1' || result.projectId !== projectId || result.app !== app
      || typeof result.degraded !== 'boolean' || !Array.isArray(result.runs) || !Array.isArray(result.events) || !Array.isArray(result.pendingReviews)
      || !result.target || !result.contract || (!result.degraded && !result.accepted)) throw new Error('Research response does not match this workspace.');
    setValue(result); setError('');
  }, [projectId, app]);
  const load = useCallback(async () => {
    if (working.current) return;
    const current = ++sequence.current;
    try { const result = await request(''); if (alive.current && current === sequence.current) accept(result); }
    catch (e) { if (alive.current && current === sequence.current) { setValue(null); setError(e instanceof Error ? e.message : 'Research unavailable.'); } }
  }, [accept]);
  useEffect(() => { alive.current = true; return () => { alive.current = false; sequence.current++; }; }, []);
  useEffect(() => {
    if (!open) { if (dialog.current?.open) { if (dialog.current.close) dialog.current.close(); else dialog.current.removeAttribute('open'); } return; }
    if (dialog.current?.showModal) dialog.current.showModal(); else dialog.current?.setAttribute('open', '');
    void load();
    const tick = window.setInterval(() => { if (!document.hidden) void load(); }, 1000);
    return () => window.clearInterval(tick);
  }, [open, load]);
  async function mutate(route: string, data: unknown) {
    if (working.current) return;
    working.current = true; setBusy(true); sequence.current++; setError('');
    try {
      const result = await request(route, data);
      if (alive.current) { accept(result); if (route === '/start') setPending(null); }
    } catch (e) { if (alive.current) setError(e instanceof Error ? e.message : 'Request not confirmed. Retry the same request.'); }
    finally { working.current = false; if (alive.current) setBusy(false); }
  }
  const disabled = busy || !!value?.active || !!pending;
  return <>
    <button className="qi-cost-toggle qi-research-toggle" onClick={() => { onOpen?.(); setOpen(true); }} aria-haspopup="dialog">Research lab</button>
    <dialog className="qi-research-dialog" ref={dialog} aria-label="Research lab" onCancel={() => setOpen(false)} onClose={() => setOpen(false)}>
      <header><div><span className="qi-research-eyebrow">HAMPTON · LOCAL EXPERIMENTS</span><h2>Research lab</h2></div><button type="button" onClick={() => setOpen(false)}>Close research</button></header>
      <p className="qi-research-intro">Run an experiment, then review the evidence before approving a change.</p>
      <div className="qi-research-scope"><strong>Offline fixture pilot</strong><p>This lab searches retrieval settings on a built-in synthetic collection. Owner approval applies only to the lab’s accepted settings. Live project search, creative editing, and model proposals require separate adapters.</p></div>
      {error && <p role="alert">{error}{pending && ' The request ID is retained; retry uses the same ID.'}</p>}
      {!value && <button type="button" onClick={() => void load()} disabled={busy}>Refresh research</button>}
      {value && <>
        <h3>{value.target.title}</h3><p>{value.target.description}</p>
        {value.degraded && <p role="alert">Research is unavailable: {value.error ?? 'A required journal or check needs attention.'} Your creative workspace remains available.</p>}
        <form onSubmit={e => {
          e.preventDefault();
          if (!pending && timeout > seconds) { setError('Trial timeout must fit within the whole-job allowance.'); return; }
          const data = pending ?? { projectId, requestId: crypto.randomUUID(), maxTrials: trials, maxWallMs: seconds * 1000, trialTimeoutMs: timeout * 1000 };
          setPending(data); void mutate('/start', data);
        }}>
          <div className="qi-research-fields">
            <label>Maximum candidate trials<input type="number" min="1" max="24" step="1" required value={trials} disabled={disabled} onChange={e => setTrials(Number(e.target.value))}/></label>
            <label>Whole-job allowance (seconds)<input type="number" min="1" max="300" step="1" required value={seconds} disabled={disabled} onChange={e => setSeconds(Number(e.target.value))}/></label>
            <label>Evaluation timeout (seconds)<input type="number" min="1" max="10" step="1" required value={timeout} disabled={disabled} onChange={e => setTimeoutSeconds(Number(e.target.value))}/></label>
          </div>
          <p className="qi-research-note">The allowance includes baseline evaluation, candidate trials and confirmation. A finite search can finish earlier. Closing this panel lets work continue; use Cancel run to stop it.</p>
          <div className="qi-research-actions"><button className="qi-research-primary" disabled={busy || value.degraded || (!!value.active && !pending)}>{pending ? 'Retry same request' : 'Start bounded run'}</button>
            {value.active && <button type="button" disabled={busy} onClick={() => void mutate('/cancel', { projectId, runId: value.active!.id })}>Cancel run</button>}
            <a href="/api/research-loop/export" download="research-audit.json">Export research audit</a></div>
        </form>
        {value.active && <p role="status">Running · {value.active.completedTrials} of at most {value.active.maxTrials} candidate trials started.</p>}
        {value.accepted && <section className="qi-research-accepted" aria-label="Accepted research configuration"><h3>Accepted research settings · version {value.accepted.version}</h3>
          <p>Title weight {value.accepted.config.titleWeight} · Text weight {value.accepted.config.textWeight} · Tag weight {value.accepted.config.tagWeight}</p>
          <small>An approved proposal can commit to this configuration.</small></section>}
        {value.accepted && value.pendingReviews.length > 0 && <section aria-label="Proposals awaiting owner review">
          <h3>Proposals awaiting owner review</h3>
          {value.pendingReviews.map(proposal => {
            const current = value.accepted!.config;
            const binding = { projectId, runId: proposal.id, proposalHash: proposal.proposalHash };
            return <article className="qi-research-run" key={proposal.id} aria-label={`Proposal ${proposal.proposalHash.slice(0, 12)}`}>
              <h4>Proposed settings for version {proposal.acceptedVersion}</h4>
              <p>Title weight {current.titleWeight} → {proposal.config.titleWeight} · Text weight {current.textWeight} → {proposal.config.textWeight} · Tag weight {current.tagWeight} → {proposal.config.tagWeight}</p>
              <p>Development {score(proposal.development?.baseline)} → {score(proposal.development?.candidate)} · Confirmation {score(proposal.confirmation?.baseline)} → {score(proposal.confirmation?.candidate)}</p>
              <details><summary>Evidence and proposal identity</summary>
                <p>Proposal <code>{proposal.proposalHash}</code><br/>Saved source <code>{proposal.sourceHash}</code></p>
                <ul>{Object.entries(proposal.checks).map(([name, status]) => <li key={name}>{name} · {status}</li>)}</ul>
              </details>
              <div className="qi-research-actions">
                <button type="button" className="qi-research-primary" disabled={busy || value.degraded} onClick={() => void mutate('/review', { ...binding, action: 'APPROVE' })}>Approve research settings</button>
                <button type="button" disabled={busy || value.degraded} onClick={() => void mutate('/review', { ...binding, action: 'DECLINE' })}>Decline proposal</button>
              </div>
            </article>;
          })}
        </section>}
        <h3>Recent runs</h3>{value.runs.length === 0 && <p>No runs yet. Start a bounded run to test the controller on the sample collection.</p>}
        {value.runs.slice(0, 5).map(run => <article className="qi-research-run" key={run.id}>
          <div className="qi-research-run-heading"><strong>{run.review?.decision ?? run.decision ?? run.status}</strong><span>{run.completedTrials} trials · {duration(run.elapsedMs)}</span></div>
          <p>{(run.review?.reason ?? run.reason)?.replace(/_/g, ' ') ?? 'Evaluation is in progress.'}</p>
          <div className="qi-research-scores"><div><span>Development · correct first result</span><strong>{score(run.development?.baseline)} → {score(run.development?.candidate)}</strong></div>
            <div><span>Confirmation · correct first result</span><strong>{score(run.confirmation?.baseline)} → {score(run.confirmation?.candidate)}</strong></div></div>
          {run.resources ? <p className="qi-research-note">Provider tokens: {run.resources.inputTokens} in / {run.resources.outputTokens} out. Provider charge: USD {run.resources.providerCostUsd}. Worker CPU: {run.resources.cpuMicros == null ? 'unknown' : `${(run.resources.cpuMicros / 1000).toFixed(1)} ms`}. Results: {run.resources.resultBytes} serialized bytes. Electricity and hardware costs: unmeasured.</p>
            : <p className="qi-research-note">Completion measurements are unavailable. Unknown usage is not zero.</p>}
        </article>)}
        <p className="qi-research-note">These public samples are reused between runs. A fixture gain is evidence about this test, not a claim of improved performance on your projects.</p>
        <details><summary>Admission contract and recent audit</summary>
          <p>Required checks qualify a result for owner review. A changed source or accepted version sends the approval to escalation. Only one selected finalist reaches confirmation per run.</p>
          <p>Dataset: <code>{value.contract.datasetHash ?? 'Unavailable'}</code><br/>Evaluator: <code>{value.contract.evaluatorHash ?? 'Unavailable'}</code><br/>Policy: <code>{value.contract.policyHash ?? 'Unavailable'}</code></p>
          <ol>{value.events.slice(-15).map(event => <li key={event.sequence}>{event.sequence}. {event.type}{event.data.decision ? ` · ${event.data.decision}` : ''}{event.data.reason ? ` · ${event.data.reason}` : ''}</li>)}</ol>
          <p>The research audit is separate from creative backups. Export it separately. Its hash chain has no external anchor.</p>
        </details>
      </>}
    </dialog>
  </>;
}
