import { useEffect, useMemo, useRef, useState } from 'react';
import { Link2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { localApi } from '../api';
import { canonicalJson } from '../model';
import { isDevelopmentRecord } from '../development';
import { appendSharedWorldNotes, isSharedWorldRecord, type SharedWorldRecord } from '../shared-world';
import { linkWorldSnapshot, reviewWorldUpdate, trackPublishedWorld, type WorldMergeChoices, type WorldSource } from '../world-sources';
import type { WorkspaceRecord } from '../types';
import type { WorldData } from '../world';

interface Props {
  projectId: string; draftId: string; record: SharedWorldRecord; records: WorkspaceRecord[];
  world: WorldData; notes: string; sources: WorldSource[]; disabled: boolean;
  onApply: (world: WorldData, notes: string, sources: WorldSource[]) => string | null;
  onOpenDraft?: (id: string) => void;
}
type Preview = { mode: 'link' | 'track' | 'update'; record: SharedWorldRecord; base?: SharedWorldRecord; stamp: string };
const fingerprint = (world: WorldData, notes: string, sources: WorldSource[]) => canonicalJson(world) + JSON.stringify(notes) + JSON.stringify(sources);
const message = (error: unknown) => error instanceof Error ? error.message : 'The world connection could not be reviewed.';

export function LinkedWorldPanel(props: Props) {
  const { projectId, draftId, record, records, world, notes, sources, disabled, onApply, onOpenDraft } = props;
  const [preview, setPreview] = useState<Preview | null>(null);
  const [choices, setChoices] = useState<WorldMergeChoices>({});
  const [appendOverview, setAppendOverview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const mounted = useRef(true), working = useRef(false), current = useRef(props);
  current.current = props;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const source = sources.find(item => item.worldId === record.id);
  const stamp = fingerprint(world, notes, sources);
  const stale = !!preview && (preview.stamp !== stamp || preview.record.sha256 !== record.sha256 || preview.record.version !== record.version);
  const uses = records.filter(item => item.kind === 'story-development').flatMap(item => {
    const data = item.data as { draftId?: string };
    if (!data.draftId || !isDevelopmentRecord(item, projectId, data.draftId) || item.data.schemaVersion !== 3) return [];
    const linked = item.data.worldSources.find(candidate => candidate.worldId === record.id);
    if (!linked) return [];
    const screenplay = records.find(candidate => candidate.id === item.data.draftId && candidate.kind === 'screenplay-draft');
    return [{ id: item.data.draftId, title: String((screenplay?.data as { title?: string })?.title ?? 'Untitled screenplay'), version: linked.version }];
  });
  const plan = useMemo(() => {
    if (!preview || stale) return null;
    try {
      if (preview.mode === 'link') return { ...linkWorldSnapshot(world, sources, preview.record), conflicts: [], counts: null, notices: [] };
      if (preview.mode === 'track') return { ...trackPublishedWorld(world, sources, preview.record), conflicts: [], counts: null, notices: [] };
      return reviewWorldUpdate(world, sources, preview.base!, preview.record, choices);
    } catch (cause) { return { error: message(cause) }; }
  }, [preview, stale, world, sources, choices]);
  const validPlan = plan && !('error' in plan) ? plan : null;
  const conflicts = plan && !('error' in plan) ? plan.conflicts : [];
  const unresolved = conflicts.filter(item => !choices[item.id]).length;
  const review = async (mode: Preview['mode']) => {
    if (disabled || working.current) return;
    working.current = true; setBusy(true); setError(''); setNotice(''); setPreview(null); setChoices({}); setAppendOverview(mode === 'link');
    try {
      let base: SharedWorldRecord | undefined;
      if (mode === 'update') {
        if (!source) throw new Error('Link this world first.');
        const history = await localApi.history(record.id);
        const value = history.find(item => item.version === source.version);
        if (!isSharedWorldRecord(value, projectId) || value.sha256 !== source.sha256) throw new Error('The library revision used by this draft is unavailable. Keep the draft unchanged and check its backup.');
        const latest = history.at(-1);
        if (!latest || latest.version !== record.version || latest.sha256 !== record.sha256) throw new Error('The library changed. Refresh the library and review again.');
        base = value;
      }
      if (mounted.current) setPreview({ mode, record, base, stamp });
    } catch (cause) { if (mounted.current) setError(message(cause)); }
    finally { working.current = false; if (mounted.current) setBusy(false); }
  };
  const apply = async () => {
    if (!preview || !plan || 'error' in plan || stale || unresolved || disabled || working.current) return;
    // Keep the exact reviewed result; re-rendering must never allocate replacement identities.
    const reviewed = plan;
    working.current = true; setBusy(true); setError('');
    try {
      const history = await localApi.history(record.id), latest = history.at(-1);
      if (!isSharedWorldRecord(latest, projectId) || latest.version !== preview.record.version || latest.sha256 !== preview.record.sha256) throw new Error('The library changed after this preview. Refresh and review again.');
      const now = current.current;
      if (now.disabled || now.record.id !== preview.record.id || fingerprint(now.world, now.notes, now.sources) !== preview.stamp) throw new Error('The draft changed after this preview. Review again before applying.');
      if (!mounted.current) return;
      const nextNotes = appendOverview ? appendSharedWorldNotes(notes, preview.record.data, preview.record.version) : notes;
      const problem = onApply(reviewed.world, nextNotes, reviewed.sources);
      if (problem) throw new Error(problem);
      setPreview(null); setNotice(`Connected to “${record.data.name}” v${record.version}. Save development to retain this revision. Other drafts stay unchanged.`);
    } catch (cause) { if (mounted.current) setError(message(cause)); }
    finally { working.current = false; if (mounted.current) setBusy(false); }
  };

  return <section className="linked-world-panel" aria-label="Linked world revisions">
    <h4><Link2 aria-hidden="true" />{source ? `This draft follows v${source.version}` : 'Connect this world to your draft'}</h4>
    <p className="world-prompt">{source ? source.version < record.version ? `Library v${record.version} is available. Review changes before applying them.` : 'This draft has reviewed the latest library revision. Its own edits remain independent.' : 'Linked copies remember their source and can receive reviewed updates without duplicate elements.'}</p>
    <div className="shared-world-actions">{source ? <Button type="button" size="sm" disabled={disabled || busy || source.version >= record.version} onClick={() => void review('update')}>Review library updates</Button> : <><Button type="button" size="sm" disabled={disabled || busy} onClick={() => void review('link')}>Preview linked import</Button><Button type="button" size="sm" variant="outline" disabled={disabled || busy} onClick={() => void review('track')}>Track this publication</Button></>}</div>
    {!source && <p className="world-prompt">“Track this publication” connects the original draft after publishing, keeping its existing identities and scene links.</p>}
    {busy && <p role="status" className="world-prompt">Checking saved world history…</p>}
    {error && <p role="alert" className="shared-world-message">{error}</p>}
    {notice && <p role="status" className="shared-world-message">{notice}</p>}
    {preview && <section className="shared-world-preview" aria-label="Linked world review">
      <h4>{preview.mode === 'update' ? `Review v${preview.base!.version} → v${record.version}` : preview.mode === 'track' ? 'Track the published world' : `Import and link “${record.data.name}”`}</h4>
      {stale ? <p role="alert">The draft or library changed. Start a new review.</p> : plan && 'error' in plan ? <p role="alert">{plan.error}</p> : validPlan && <>
        {validPlan.counts ? <p>{validPlan.counts.added} added · {validPlan.counts.updated} updated · {validPlan.counts.keptLocal} with draft edits kept. Local order and scene links stay intact.</p> : <p>{record.data.world.elements.length} elements and {record.data.world.links.length} connections will be {preview.mode === 'track' ? 'tracked without making copies' : 'added with separate local identities'}. Save development after applying.</p>}
        {validPlan.notices.map((text, index) => <p key={index}>{text}</p>)}
        {conflicts.length > 0 && <p>Choose which version to keep for each difference edited in both places.</p>}
        <div className="linked-world-conflicts">{conflicts.map(item => <div className="linked-world-conflict" key={item.id}>
          <strong>{item.name} · {item.field}</strong>
          <div className="linked-world-comparison"><div><span>This draft</span><pre>{item.local || '(empty)'}</pre></div><div><span>Library v{record.version}</span><pre>{item.library || '(empty)'}</pre></div></div>
          <label>Keep version<select aria-label={`Keep version for ${item.name} ${item.field}`} value={choices[item.id] ?? ''} onChange={event => setChoices(previous => ({ ...previous, [item.id]: event.target.value as 'draft' | 'library' }))}><option value="" disabled>Choose a version…</option><option value="draft">Keep draft version</option><option value="library">Use library version</option></select></label>
        </div>)}</div>
        {!!record.data.description && preview.mode !== 'track' && <label className="linked-world-overview"><input type="checkbox" checked={appendOverview} onChange={event => setAppendOverview(event.target.checked)} />Append the library overview to draft notes (keep existing notes)</label>}
      </>}
      <div className="shared-world-actions"><Button type="button" size="sm" disabled={disabled || busy || stale || !plan || 'error' in plan || unresolved > 0} onClick={() => void apply()}>{preview.mode === 'update' ? 'Apply reviewed update' : preview.mode === 'track' ? 'Track published revision' : 'Link world to draft'}</Button><Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => setPreview(null)}>Cancel review</Button></div>
    </section>}
    <details className="linked-world-usage"><summary>Used in {uses.length} saved draft{uses.length === 1 ? '' : 's'}</summary><p className="world-prompt">Saved connections only. Save development and refresh the library to include new links.</p><ul>{uses.map(use => <li key={use.id}>{onOpenDraft && use.id !== draftId ? <button type="button" disabled={disabled || busy} onClick={() => onOpenDraft(use.id)}>{use.title}</button> : <span>{use.title}{use.id === draftId ? ' · this draft' : ''}</span>}<span>v{use.version}{use.version < record.version ? ' · update available' : ' · current'}</span></li>)}</ul></details>
  </section>;
}
