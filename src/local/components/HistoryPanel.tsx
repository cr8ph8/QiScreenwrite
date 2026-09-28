import { useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { localApi } from '../api';
import { compareRevisionText, revisionKey } from '../revision-compare';
import type { DraftRecord } from '../types';
import { RevisionComparePanel, RevisionTextDiffView } from './RevisionComparePanel';

interface Props {
  draftId: string;
  saved: DraftRecord | null;
  currentBody: string;
  onRestore: (body: string) => void;
  onSelectBaseline?: (record: DraftRecord) => void;
}

/** Comparison never writes a revision or editor text. Restore remains an explicit callback. */
export function HistoryPanel(props: Props) {
  if (!props.saved) return <p className="text-sm text-muted-foreground">Save the draft to start its revision history.</p>;
  // Draft changes remount loading/selection state before a previous request can resolve.
  return <SavedHistory key={props.draftId} {...props} saved={props.saved} />;
}

function SavedHistory({ draftId, saved, currentBody, onRestore, onSelectBaseline }: Props & { saved: DraftRecord }) {
  const [history, setHistory] = useState<DraftRecord[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [mode, setMode] = useState<'saved' | 'editor'>('saved');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setLoading(true); setError('');
    localApi.history(draftId).then(records => {
      if (cancelled) return;
      const drafts = (records as DraftRecord[]).filter(record => record.id === draftId && record.kind === 'screenplay-draft').sort((a, b) => a.version - b.version);
      setHistory(drafts);
      setSelected(current => drafts.some(record => revisionKey(record) === current) ? current : drafts.length ? revisionKey(drafts[drafts.length - 1]) : null);
      setLoading(false);
    }).catch(caught => {
      if (!cancelled) { setError(caught instanceof Error ? caught.message : 'History unavailable.'); setLoading(false); }
    });
    return () => { cancelled = true; };
  }, [draftId, saved.version, saved.sha256, attempt]);
  const version = history.find(record => revisionKey(record) === selected);
  const comparison = useMemo(() => {
    if (!version || mode !== 'editor') return { diff: null, error: '' };
    try { return { diff: compareRevisionText(version.data.body, currentBody), error: '' }; }
    catch (caught) { return { diff: null, error: caught instanceof Error ? caught.message : 'Comparison unavailable.' }; }
  }, [version, currentBody, mode]);
  if (loading && !history.length) return <p className="text-sm text-muted-foreground" role="status">Loading saved revisions…</p>;
  if (error) return <div><p role="alert" className="text-sm text-destructive">{error}</p><Button size="sm" variant="outline" onClick={() => setAttempt(value => value + 1)}>Retry history</Button></div>;
  if (!history.length) return <p className="text-sm text-muted-foreground">No saved revisions are available.</p>;
  return <div className="lw-history" aria-busy={loading}>
    <div className="lw-history-modes" aria-label="Comparison mode">
      <Button size="sm" variant="outline" aria-pressed={mode === 'saved'} onClick={() => setMode('saved')}>Saved revisions</Button>
      <Button size="sm" variant="outline" aria-pressed={mode === 'editor'} onClick={() => setMode('editor')}>Compare with editor / restore</Button>
      {loading && <span className="lw-compare-note" role="status">Refreshing saved revisions…</span>}
    </div>
    <div hidden={mode !== 'saved'}><RevisionComparePanel revisions={history} onSelectBaseline={onSelectBaseline} /></div>
    {mode === 'editor' && <div className="grid gap-3 md:grid-cols-[200px_1fr]">
      <ul className="flex flex-col gap-1" aria-label="Revisions">
        {[...history].reverse().map(record => <li key={revisionKey(record)}>
          <button type="button" aria-pressed={record === version} onClick={() => setSelected(revisionKey(record))} className={`w-full text-left rounded px-2 py-1 text-sm hover:bg-muted ${record === version ? 'bg-muted' : ''}`}>
            v{record.version} · {record.data.title}<div className="text-xs text-muted-foreground">{record.data.body.length.toLocaleString()} chars · {record.sha256.slice(0, 10)}</div>
          </button>
        </li>)}
      </ul>
      <div className="min-w-0">{version ? <>
        <div className="flex flex-wrap items-center gap-2 mb-2 text-sm"><span>v{version.version} vs editor: {version.data.body === currentBody ? 'identical' : 'text differs'}</span>
          <Button size="sm" variant="outline" className="ml-auto" onClick={() => onRestore(version.data.body)} disabled={version.data.body === currentBody}>Restore v{version.version} into editor</Button>
          {onSelectBaseline && <Button size="sm" variant="ghost" onClick={() => onSelectBaseline(version)}>Use v{version.version} as revision-mark baseline</Button>}
        </div>
        <p className="lw-compare-note break-all">Stored SHA-256: {version.sha256}</p>
        {comparison.error && <p role="alert">{comparison.error}</p>}
        {comparison.diff && <RevisionTextDiffView key={revisionKey(version)} diff={comparison.diff} />}
      </> : <p className="text-sm text-muted-foreground">Select a revision.</p>}</div>
    </div>}
  </div>;
}
