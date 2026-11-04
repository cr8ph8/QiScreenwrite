import { useCallback, useEffect, useRef, useState } from 'react';
import './resource-cost.css';
type Total = { currency: string; estimate: string | null; knownActual: string; actual: string | null; committed: string; forecast: string | null; unknownEstimateCount: number; unknownActualCount: number };
type Group = { provider: string; model: string; origin: string; attempts: number; inputKnown: string; outputKnown: string; inputUnknown: number; outputUnknown: number };
type Financing = { currency: string; signedCash: string; receivedCash: string; remainingBeforeOtherFunding: string | null };
type CostContext = { schema: string; scope: string; projectId: string; readOnly: boolean; production: { totals: Total[]; gaps: number } | null; financing: { totals: Financing[] } | null; usageGroups: Group[] };
type Snapshot = { schema: string; projectId: string; app: string; authority: string; spendAuthorized: boolean; degraded: boolean; issues: string[];
  production: CostContext['production']; financing: CostContext['financing']; usage: { groups: Group[]; attempts: { key: string; provider: string; model: string; status: string; quotedCredits?: string | null; cost?: string | null; costKind?: string; currency?: string | null; estimate?: { modelCost: string | null; electricityCost: string | null; energyKwh: string | null; currency: string | null } | null }[] };
  requestActivity: { started: number; finished: number; unresolved: number; byFamily: { family: string; count: number }[] };
  entryTotals: { stage: string; unit: string; provider: string; account: string; amount: string }[]; coverage: Record<string, string> };
type Rate = { id: string; provider: string; model: string; currency: string; inputPerMillion: string | null; outputPerMillion: string | null; cachedPerMillion: string | null; watts: string | null; electricityPerKwh: string | null; validFrom: string; expiresAt: string; basis: string };
type Entry = { id: string; stage: string; unit: string; amount: string; provider: string; account: string; taskId: string; evidence: string; recordedAt: string };
const unknown = (v: string | null | undefined) => v == null ? 'Unknown' : v;
async function api<T = unknown>(path: string, data?: unknown): Promise<T> {
  const response = await fetch(path, { credentials: 'same-origin', redirect: 'error', ...(data === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }) });
  const result = await response.json(); if (!response.ok) throw new Error(`Not confirmed: ${result?.error ?? response.status}. Check the saved record before entering another ID.`); return result;
}
function Totals({ production, financing }: Pick<Snapshot, 'production' | 'financing'>) {
  return <>
    {production ? <><h3>Saved production budget</h3>{production.totals.length === 0 && <p>No priced budget lines yet. Project cost is unknown, not zero.</p>}<div className="qi-cost-scroll"><table><thead><tr><th>Unit</th><th>Planned</th><th>Known incurred</th><th>Complete incurred</th><th>Committed</th><th>Forecast</th></tr></thead><tbody>{production.totals.map(t => <tr key={t.currency}><td>{t.currency}</td><td>{unknown(t.estimate)}</td><td>{t.knownActual}</td><td>{unknown(t.actual)}</td><td>{t.committed}</td><td>{unknown(t.forecast)}</td></tr>)}</tbody></table></div><p>{production.gaps} budget coverage gaps. Incurred costs are not proof of cash paid.</p></> : <p>No production budget is available here. That means unknown, not zero.</p>}
    {financing && <><h3>Sponsorship funding · separate from costs</h3>{financing.totals.map(t => <p key={t.currency}>{t.currency}: signed {t.signedCash}; received {t.receivedCash}; remaining before other funding {unknown(t.remainingBeforeOtherFunding)}.</p>)}</>}
  </>;
}
function Usage({ groups }: { groups: Group[] }) {
  return <div className="qi-cost-scroll"><table><thead><tr><th>Provider / model / source</th><th>Attempts</th><th>Input tokens</th><th>Output tokens</th></tr></thead><tbody>{groups.map((g, i) => <tr key={i}><td>{g.provider} / {g.model}<small>{g.origin}</small></td><td>{g.attempts}</td><td>{g.inputKnown} known · {g.inputUnknown} unknown</td><td>{g.outputKnown} known · {g.outputUnknown} unknown</td></tr>)}</tbody></table></div>;
}
/** Application-wide, lazy view. Opening this panel never edits the screenplay,
 * submits a model request, applies rates or establishes financial authority. */
export function ResourceCostDock({ projectId, app, draftId, draftVersion, draftSha256, transport = api }: { projectId: string; app: 'qimovi' | 'qiscreenwrite'; draftId?: string; draftVersion?: number; draftSha256?: string; transport?: typeof api }) {
  const [open, setOpen] = useState(false), [value, setValue] = useState<Snapshot | null>(null), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [linked, setLinked] = useState<CostContext | null>(null), [busy, setBusy] = useState(false);
  const [rates, setRates] = useState({ id: '', provider: 'OLLAMA', model: '', currency: 'USD', inputPerMillion: '', outputPerMillion: '', cachedPerMillion: '', watts: '', electricityPerKwh: '', expiresAt: '', basis: '' });
  const [entry, setEntry] = useState({ id: '', stage: 'incurred', unit: 'money:USD', amount: '', provider: '', account: '', taskId: '', evidence: '' });
  const [quantities, setQuantities] = useState({ inputTokens: '', outputTokens: '', cachedInputTokens: '', elapsedMs: '' });
  const [quote, setQuote] = useState<{ modelCost: string | null; electricityCost: string | null; energyKwh: string | null; currency: string | null; basis: string } | null>(null);
  const ratePending = useRef<Rate | null>(null), entryPending = useRef<Entry | null>(null), alive = useRef(true), context = useRef(''), loadId = useRef(0);
  context.current = `${projectId}:${draftId ?? ''}:${draftVersion ?? ''}:${draftSha256 ?? ''}`;
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { setLinked(null); }, [draftId, draftVersion, draftSha256]);
  const load = useCallback(async () => {
    const scope = context.current, requestId = ++loadId.current;
    try { const data = await transport<Snapshot>('/api/resource-accounting');
      if (data?.schema !== 'qi-resource-accounting/v1' || data.projectId !== projectId || data.app !== app || data.authority !== 'OBSERVATION_ONLY' || data.spendAuthorized !== false || !Array.isArray(data.usage?.groups) || !Array.isArray(data.usage?.attempts) || !Array.isArray(data.issues) || !Array.isArray(data.entryTotals) || !data.requestActivity || !data.coverage) throw new Error('Cost response did not match this workspace.');
      if (alive.current && scope === context.current && requestId === loadId.current) { setValue(data); setError(''); }
    } catch (e) { if (alive.current && scope === context.current && requestId === loadId.current) setError(e instanceof Error ? e.message : 'Accounting unavailable.'); }
  }, [app, projectId, transport]);
  useEffect(() => { if (!open) return; void load(); const tick = window.setInterval(() => { if (!document.hidden) void load(); }, 10000); return () => window.clearInterval(tick); }, [open, load]);
  async function work(fn: () => Promise<void>) { if (busy) return; setBusy(true); setError(''); try { await fn(); } catch (e) { setError(e instanceof Error ? e.message : 'Request not confirmed.'); } finally { if (alive.current) setBusy(false); } }
  function rateData(): Rate { const n = (v: string) => v.trim() || null; return { ...rates, inputPerMillion: n(rates.inputPerMillion), outputPerMillion: n(rates.outputPerMillion), cachedPerMillion: n(rates.cachedPerMillion), watts: n(rates.watts), electricityPerKwh: n(rates.electricityPerKwh), validFrom: new Date().toISOString(), expiresAt: new Date(`${rates.expiresAt}T23:59:59.999Z`).toISOString() }; }
  return <aside className="qi-cost-dock" aria-label="Resource and cost accounting">
    <button className="qi-cost-toggle" onClick={() => setOpen(v => !v)} aria-expanded={open}>Costs · money, tokens & resources</button>
    {open && <section className="qi-cost-panel" aria-label="Costs and resources">
      <header><h2>Costs & resources</h2><button onClick={() => setOpen(false)}>Close costs</button></header>
      <p>Saved-workspace observations. Unknown is not free. No payments or production approvals are made here.</p>
      <button disabled={busy} onClick={() => void load()}>Refresh costs</button>{' '}<a href="/api/resource-accounting/export" download="private-resource-journal.json">Export private resource journal</a>
      {error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
      {value && <>
        {(value.degraded || value.issues.length > 0) && <p role="alert">Accounting coverage is incomplete. {value.issues.join(', ')}</p>}
        <Totals production={value.production} financing={value.financing}/>
        <h3>Model usage · including failed attempts</h3><Usage groups={value.usage.groups}/>
        <p>Charges are not inferred from token counts without an explicit rate. Quotes are not invoices; cached input and reasoning are subsets.</p>
        <details><summary>Recent attempts and estimates</summary>{value.usage.attempts.map(a => <p key={a.key}>{a.provider} / {a.model}: {a.status}. Recorded monetary observation: {unknown(a.cost)} {a.currency} ({a.costKind ?? 'unknown'}). Quoted credits: {unknown(a.quotedCredits)}. Model-price estimate: {unknown(a.estimate?.modelCost)} {a.estimate?.currency}. Electricity estimate: {unknown(a.estimate?.electricityCost)}. Energy estimate: {unknown(a.estimate?.energyKwh)} kWh.</p>)}</details>
        <h3>Activity coverage</h3><p>{value.requestActivity.started} authenticated operations observed; {value.requestActivity.unresolved} have no completion observation. Request duration is not render time, CPU time or human work.</p>
        <details><summary>Coverage and exclusions</summary>{Object.entries(value.coverage).map(([k, v]) => <p key={k}><strong>{k}</strong>: {v}</p>)}<p>Standard creative backups do not contain this separate accounting journal. Export it separately. Physical electricity is unmetered; per-run wattage estimates must not be added across overlapping work.</p></details>
        <h3>Supplemental resource entries</h3><p>Shown separately, not added to the production budget or usage receipts. Do not record the same expense twice. Paid cash, incurred expenses, credit consumption and allocations are different views.</p>
        {value.entryTotals.map((e, i) => <p key={i}>{e.stage} · {e.provider} / {e.account} · {e.amount} {e.unit}</p>)}
      </>}
      {app === 'qiscreenwrite' && draftId && <><button disabled={busy} onClick={() => void work(async () => {
        const id = draftId, scope = context.current, result = await transport<{ draftId: string; draftVersion: number; draftSha256: string; readOnly: boolean; projectId: string; costContext: CostContext }>('/api/brands/qimovi-context', { draftId: id });
        const c: CostContext = result.costContext;
        if (result.draftId !== id || draftVersion !== undefined && result.draftVersion !== draftVersion || draftSha256 !== undefined && result.draftSha256 !== draftSha256 || result.readOnly !== true || c?.schema !== 'qi-resource-context/v1' || c.readOnly !== true || c.scope !== 'PROJECT_NOT_DRAFT' || c.projectId !== result.projectId) throw new Error('Transfer this saved draft to an updated local QiMovi, then retry.');
        if (alive.current && context.current === scope) setLinked(c);
      })}>Read linked QiMovi costs</button><p>Explicit read of the linked film’s project-wide totals for the saved revision, not unsaved writing. No ledger is copied or combined.</p>{linked && <><h3>Linked film · {linked.projectId}</h3><Totals production={linked.production} financing={linked.financing}/><Usage groups={linked.usageGroups}/></>}</>}
      <details><summary>Set rates and estimate work</summary><p>Owner-supplied assumptions, not current vendor prices. Empty fields mean unknown. Rates are immutable versions and expire; existing runs retain their original rate.</p>
        <form onSubmit={e => { e.preventDefault(); void work(async () => { const r = ratePending.current ?? rateData(); ratePending.current = r; await transport('/api/resource-accounting/rate', { projectId, data: r }); ratePending.current = null; setNotice('Rate version saved. Existing estimates were not repriced.'); await load(); }); }}>
          <div className="qi-cost-grid">{Object.entries(rates).map(([k, v]) => <label key={k}>{({ id: 'Rate version ID', inputPerMillion: 'Currency per million input tokens', outputPerMillion: 'Currency per million output tokens', cachedPerMillion: 'Currency per million cached input tokens', watts: 'Assumed average watts (local only)', electricityPerKwh: 'Currency per kWh', expiresAt: 'Expires on', basis: 'Rate source / assumption' } as Record<string, string>)[k] ?? k}<input value={v} disabled={busy || !!ratePending.current} type={k === 'expiresAt' ? 'date' : 'text'} required={['id','provider','model','currency','expiresAt','basis'].includes(k)} onChange={e => setRates(x => ({ ...x, [k]: e.target.value }))}/></label>)}</div>
          <button disabled={busy}>Save / retry exact rate</button><button type="button" onClick={() => { ratePending.current = null; setNotice('Review saved rate IDs before submitting changed assumptions.'); }}>Edit rate draft</button>
        </form>
        <div className="qi-cost-grid">{Object.entries(quantities).map(([k, v]) => <label key={k}>{k}<input value={v} inputMode="numeric" onChange={e => { setQuantities(x => ({ ...x, [k]: e.target.value })); setQuote(null); }}/></label>)}</div>
        <button disabled={busy} onClick={() => void work(async () => { const usage = Object.fromEntries(Object.entries(quantities).map(([k, v]) => [k, v.trim() ? Number(v) : null])); setQuote(await transport<NonNullable<typeof quote>>('/api/resource-accounting/quote', { projectId, data: { provider: rates.provider, model: rates.model, local: rates.provider === 'OLLAMA', usage } })); })}>Estimate without executing</button>
        {quote && <p>Model: {unknown(quote.modelCost)} {quote.currency}. Electricity: {unknown(quote.electricityCost)}. Energy: {unknown(quote.energyKwh)} kWh. {quote.basis}. This does not reserve a budget or authorize spending.</p>}
      </details>
      <details><summary>Record money, credits, time or energy</summary><form onSubmit={e => { e.preventDefault(); void work(async () => { const data = entryPending.current ?? { ...entry, recordedAt: new Date().toISOString() }; entryPending.current = data; await transport('/api/resource-accounting/entry', { projectId, data }); entryPending.current = null; setNotice('Observation recorded. No money was transferred.'); await load(); }); }}>
        <label>Stage<select value={entry.stage} disabled={busy || !!entryPending.current} onChange={e => setEntry(x => ({ ...x, stage: e.target.value }))}>{['estimate','incurred','paid','received','refund','allocation'].map(v => <option key={v}>{v}</option>)}</select></label>
        <label>Unit<select value={entry.unit} disabled={busy || !!entryPending.current} onChange={e => setEntry(x => ({ ...x, unit: e.target.value }))}>{['money:USD','money:CAD','money:EUR','money:GBP','credits','tokens:input','tokens:output','energy:kWh','time:hours','storage:GB-month','compute:seconds'].map(v => <option key={v}>{v}</option>)}</select></label>
        <div className="qi-cost-grid">{Object.entries(entry).filter(([k]) => !['stage','unit'].includes(k)).map(([k, v]) => <label key={k}>{k === 'id' ? 'Unique receipt / observation ID' : k}<input required value={v} disabled={busy || !!entryPending.current} onChange={e => setEntry(x => ({ ...x, [k]: e.target.value }))}/></label>)}</div><button disabled={busy}>Save / retry exact observation</button><button type="button" onClick={() => { entryPending.current = null; setNotice('Check the journal before creating another receipt ID.'); }}>Edit observation draft</button>
      </form></details>
    </section>}
  </aside>;
}
export default ResourceCostDock;
