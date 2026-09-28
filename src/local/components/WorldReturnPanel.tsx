import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import { worldReturnApi, type WorldReturnDecision, type WorldReturnPreview, type WorldReturnResult } from '../world-return-api';
import './world-return-panel.css';

interface Props {
  draftId: string; context: string; enabled: boolean; disabled?: boolean;
  onChanged: () => Promise<void>; onBusy: (busy: boolean) => void;
}
const labels = { name: 'Name', description: 'Description', storyFunction: 'Story function', sensoryDetails: 'On screen & in sound', continuity: 'Continuity & open questions' };
type Review = { context: string; preview: WorldReturnPreview; choices: Record<string, WorldReturnDecision> };

/** A deliberate field review over the existing connection, never an automatic sync. */
export function WorldReturnPanel({ draftId, context, enabled, disabled = false, onChanged, onBusy }: Props) {
  const [review, setReview] = useState<Review | null>(null);
  const [result, setResult] = useState<{ context: string; value: WorldReturnResult } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'preview' | 'apply' | null>(null);
  const active = useRef(context); active.current = context;
  const generation = useRef(0);
  useEffect(() => { generation.current++; setReview(null); setError(null); setResult(null); }, [context]);
  useEffect(() => () => { generation.current++; }, []);
  const current = review?.context === context ? review : null;
  const selectable = current?.preview.items.filter(item => item.selectable) ?? [];
  const unresolved = selectable.filter(item => !current?.choices[item.id]).length;
  const done = result?.context === context ? result.value : null;
  const operate = async (apply: boolean) => {
    if (!enabled || disabled || busy || (apply && (!current || !selectable.length || unresolved))) return;
    const captured = context, requestId = ++generation.current;
    const stillCurrent = () => active.current === captured && requestId === generation.current;
    setBusy(apply ? 'apply' : 'preview'); onBusy(true); setError(null);
    if (!apply) { setReview(null); setResult(null); }
    try {
      if (apply && current) {
        const value = await worldReturnApi.apply(draftId, current.preview.token, selectable.map(item => ({ id: item.id, decision: current.choices[item.id] })));
        if (!stillCurrent()) return;
        setReview(null); setResult({ context: captured, value });
        toast.success(value.changed ? `World changes saved in development v${value.development.version}.` : 'Writer text kept; no new revision needed.');
        try { await onChanged(); }
        catch { if (stillCurrent()) setError('Your reviewed choices were saved, but the workspace view could not refresh. Reopen the draft to see the saved revision.'); }
      } else {
        const preview = await worldReturnApi.preview(draftId);
        if (stillCurrent()) setReview({ context: captured, preview, choices: {} });
      }
    } catch (failure) {
      if (stillCurrent()) {
        setReview(null);
        setError(failure instanceof Error ? failure.message : 'The world review could not be completed. Preview again.');
      }
    } finally { setBusy(null); onBusy(false); }
  };
  return <section className="world-return" aria-label="Bring world changes back" aria-busy={busy !== null}>
    <h5>Bring world changes back</h5>
    <p>Compare text edited in QiMovi with these saved World Builder entries. Choose what to keep before saving a new development revision.</p>
    <Button type="button" size="sm" variant="outline" disabled={!enabled || disabled || busy !== null} onClick={() => void operate(false)}>{busy === 'preview' ? 'Comparing world changes…' : 'Review changes from QiMovi'}</Button>
    {!enabled && <p>Save this screenplay and its world, then connect the intended QiMovi project.</p>}
    {error && <p role="alert">{error}</p>}
    {current && <div role="region" aria-label="World changes review">
      <div className="world-return-summary"><strong>{current.preview.project.title}</strong><span>Saved development v{current.preview.development.version}</span></div>
      <p>{selectable.length} field(s) to choose · {current.preview.counts.bothChanged} changed in both apps · {current.preview.counts.localOnly} local edits kept</p>
      {current.preview.items.filter(item => item.selectable || item.state === 'unsupported').map(item => <fieldset className="world-return-field" key={item.id}>
        <legend>{item.elementName || 'Untitled element'} · {labels[item.field]}</legend>
        {item.state === 'both-changed' && <strong className="world-return-conflict">Changed in both apps</strong>}
        {item.selectable ? <>
          <div className="world-return-values"><div><strong>Writer now</strong><pre>{item.local || '(empty)'}</pre></div><div><strong>QiMovi now</strong><pre>{item.remote || '(empty)'}</pre></div></div>
          <details><summary>Previously sent text</summary><pre>{item.base || '(empty)'}</pre></details>
          <div className="world-return-choices">{(['keep-local', 'use-qimovi'] as const).map(decision => <label key={decision}><input type="radio" name={`world-return-${item.id}`} checked={current.choices[item.id] === decision} disabled={busy !== null || disabled || !enabled} onChange={() => setReview({ ...current, choices: { ...current.choices, [item.id]: decision } })} />{decision === 'keep-local' ? 'Keep writer text' : 'Use QiMovi text'}</label>)}</div>
        </> : <p>{item.reason || 'This entry needs review in QiMovi; its writer text will stay as it is.'}</p>}
      </fieldset>)}
      {!selectable.length && <p>No supported text changes need a choice.</p>}
      {current.preview.notes.length > 0 && <ul>{current.preview.notes.map((note, i) => <li key={i}>{note}</li>)}</ul>}
      <div className="world-return-actions">
        {selectable.length > 0 && <Button type="button" size="sm" disabled={!enabled || disabled || busy !== null || unresolved > 0} onClick={() => void operate(true)}>{busy === 'apply' ? 'Saving reviewed choices…' : 'Save reviewed choices'}</Button>}
        <Button type="button" size="sm" variant="ghost" disabled={busy !== null} onClick={() => { generation.current++; setReview(null); }}>Dismiss review</Button>
      </div>
      {unresolved > 0 && <p role="status">Choose a version for {unresolved} remaining field(s).</p>}
    </div>}
    {done && <p role="status">{done.changed ? `${done.applied} field(s) saved in development v${done.development.version}.` : 'Your writer text was kept; no development revision was needed.'}</p>}
  </section>;
}
