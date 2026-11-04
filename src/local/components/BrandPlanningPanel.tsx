import { useEffect, useRef, useState } from 'react';
import { brandPlanningApi, type BrandPlanningApi, type BrandPlan, type BrandReviewData, type BrandContext } from '../brand-planning';
import type { DraftRecord, RecordInput, WorkspaceRecord } from '../types';
import './brand-planning.css';

export function BrandPlanningPanel({ draft, dirty, active = true, onSaved, api = brandPlanningApi }: {
  draft: DraftRecord | null; dirty: boolean; active?: boolean; onSaved: (record: WorkspaceRecord) => void; api?: BrandPlanningApi;
}) {
  const [plan, setPlan] = useState<BrandPlan | null>(null), [context, setContext] = useState<BrandContext | null>(null);
  const [reason, setReason] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [pending, setPending] = useState<RecordInput<BrandReviewData> | null>(null);
  const generation = useRef(0), locked = useRef(false), pendingRef = useRef<RecordInput<BrandReviewData> | null>(null);
  const identity = draft ? `${draft.id}:${draft.version}:${draft.sha256}` : 'unsaved';
  useEffect(() => {
    ++generation.current; setPlan(null); setContext(null); setPending(null); pendingRef.current = null;
    setError(''); setNotice('Saved revision changed. Scan again before reviewing placements.');
    return () => { ++generation.current; };
  }, [identity]);
  async function run(operation: () => Promise<void>) {
    if (locked.current) return;
    const serial = generation.current; locked.current = true; setBusy(true); setError('');
    try { await operation(); }
    catch (failure) { if (serial === generation.current) setError(failure instanceof Error ? failure.message : 'The request could not be confirmed.'); }
    finally { locked.current = false; setBusy(false); }
  }
  async function scan() {
    if (!draft || dirty || !active) return;
    const serial = generation.current;
    await run(async () => {
      const result = await api.scan(draft);
      if (serial !== generation.current) return;
      setPlan(result); pendingRef.current = null; setPending(null);
      setNotice('Scanned the saved draft locally. No screenplay changes or approvals were made.');
    });
  }
  async function send(input: RecordInput<BrandReviewData>) {
    const serial = generation.current;
    await run(async () => {
      const record = await api.save(input);
      if (serial !== generation.current) return;
      pendingRef.current = null; setPending(null); setPlan(value => value ? { ...value, reviewRecord: record, stale: false } : value);
      onSaved(record); setNotice('Creative review saved locally. It does not sign a deal, clear rights, or change QiMovi approvals.');
    });
  }
  async function review(opportunityId: string, decision: 'approved' | 'rejected') {
    if (!draft || !plan || dirty || !active || !reason.trim() || locked.current || pendingRef.current) return;
    const reviews = (plan.stale ? [] : plan.reviewRecord?.data.reviews ?? []).filter(row => row.opportunityId !== opportunityId);
    const input: RecordInput<BrandReviewData> = { id: plan.reviewId, kind: 'brand-review', expectedVersion: plan.reviewRecord?.version ?? null,
      requestId: crypto.randomUUID(), data: { schemaVersion: 1, projectId: draft.data.projectId, draftId: draft.id,
        sourceRef: plan.source.recordRef, reviews: [...reviews, { opportunityId, decision, reason }], approvalGranted: false } };
    pendingRef.current = input; setPending(input); await send(input);
  }
  async function loadContext() {
    if (!draft || dirty || !active) return;
    const serial = generation.current; setContext(null);
    await run(async () => {
      const value = await api.context(draft); if (serial !== generation.current) return;
      setContext(value); setNotice('Read the linked QiMovi ledger. No financial records were copied or changed.');
    });
  }
  function exportPlan() {
    if (!plan || dirty) return;
    const packet = { schemaVersion: 'qiscreenwrite-brand-plan-export/v1', projectId: plan.projectId, source: plan.source,
      opportunities: plan.opportunities, reviewRecord: plan.reviewRecord, stale: plan.stale,
      authority: 'CREATIVE_PLANNING_ONLY', approvalGranted: false };
    const url = URL.createObjectURL(new Blob([JSON.stringify(packet, null, 2)], { type: 'application/json' }));
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'brand-placement-plan.json'; anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
  const blocked = busy || dirty || !draft || !active || Boolean(pending);
  return <section className="lw-brand-planning" aria-label="Brand Integration & Financing" hidden={!active} aria-busy={busy}>
    <h2>Brand Integration &amp; Financing</h2>
    <p>Find natural opportunities without rewriting your story. The local English keyword scanner works offline; your reasons and reviews stay in this writer workspace.</p>
    {!draft && <p>Save this screenplay before scanning.</p>}
    {dirty && <p role="status">Unsaved writing is preserved. Save or resolve your working copy before scanning, reviewing, or reading connected financing.</p>}
    <div className="lw-brand-actions"><button type="button" disabled={busy || dirty || !draft} onClick={() => void scan()}>Scan saved screenplay</button>
      <button type="button" disabled={!plan || blocked} onClick={exportPlan}>Export placement plan</button></div>
    {error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    {pending && <p>A review request is unconfirmed. <button type="button" disabled={busy || dirty || !active} onClick={() => void send(pending)}>Retry exact review</button> Or scan again to inspect saved state before submitting a new request.</p>}
    {plan && <>
      <p>{plan.opportunities.length} opportunities · saved revision {plan.source.recordRef.version}. Exports contain private screenplay excerpts; share deliberately.</p>
      {plan.truncated && <p role="status">The scanner reached its 200-opportunity limit. This is not a complete inventory.</p>}
      {plan.stale && <p role="status">Earlier creative reviews belong to another revision. New reviews start a fresh set; old records remain in workspace history.</p>}
      <label>Creative review reason<input value={reason} maxLength={1000} disabled={blocked} onChange={event => setReason(event.target.value)} /></label>
      {plan.opportunities.length === 0 && <p>No keyword opportunities found in recognized scenes. This is not evidence that no placements are possible.</p>}
      {plan.opportunities.map(row => {
        const decision = !plan.stale && plan.reviewRecord?.data.reviews.find(review => review.opportunityId === row.id);
        return <article key={row.id}><h3>{row.heading} · {row.category}</h3><blockquote>{row.context}</blockquote>
          <p>{decision ? `${decision.decision}: ${decision.reason}` : 'Unreviewed creative suggestion'}</p>
          <div className="lw-brand-actions"><button type="button" disabled={blocked || !reason.trim()} onClick={() => void review(row.id, 'approved')}>Approve creative opportunity</button>
            <button type="button" disabled={blocked || !reason.trim()} onClick={() => void review(row.id, 'rejected')}>Reject opportunity</button></div>
        </article>;
      })}
    </>}
    <h3>Connected QiMovi financing</h3>
    <p>Use Connect → QiMovi to transfer the saved draft first. Both local apps must be running. This reads only the matching revision and a project-level summary; contracts, receipts and financial edits remain in QiMovi → Budget.</p>
    <button type="button" disabled={blocked} onClick={() => void loadContext()}>Read linked financing</button>
    {context && <div aria-label="Connected financing summary">
      <p>Read-only snapshot · QiMovi ledger v{context.ledgerVersion}. Project totals, not funding assigned to this draft. Signed cash includes received cash.</p>
      {context.totals.length === 0 && <p>No saved project financing yet.</p>}
      {context.totals.map(row => <p key={row.currency}>{row.currency}: signed {row.signedCash}; received {row.receivedCash}; remaining before other funding {row.remainingBeforeOtherFunding ?? 'unknown'}.</p>)}
      {context.deals.map(row => <p key={row.id}>{row.sponsor}: {row.status} · {row.cash} {row.currency}.</p>)}
      {context.reviews.map(row => <p key={row.id}>{row.heading}: {row.stale ? 'STALE — review in QiMovi' : row.decision} · {row.reason}</p>)}
    </div>}
  </section>;
}
