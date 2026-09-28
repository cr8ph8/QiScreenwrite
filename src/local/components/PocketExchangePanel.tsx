import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { localApi } from '../api';
import { MAX_POCKET_BYTES, type PocketPreview, type PocketImportResult, type PocketPreparedTrip } from '../pocket-exchange';
import type { DraftRecord } from '../types';
import './pocket-exchange.css';

export function PocketExchangePanel({ drafts, onChanged, onOpenDraft }: {
  drafts: DraftRecord[];
  onChanged: () => void | Promise<void>;
  onOpenDraft: (id: string) => void;
}) {
  const [selectedId, setSelectedId] = useState('');
  const [review, setReview] = useState<{ fileText: string; name: string; preview: PocketPreview } | null>(null);
  const [result, setResult] = useState<PocketImportResult | null>(null);
  const [busy, setBusy] = useState<'preview' | 'import' | 'prepare' | null>(null);
  const [prepared, setPrepared] = useState<PocketPreparedTrip | null>(null);
  const [error, setError] = useState('');
  const sequence = useRef(0);
  useEffect(() => () => { sequence.current++; }, []);
  const selected = drafts.find(draft => draft.id === selectedId);

  const prepareLinked = async () => {
    if (!selected || busy) return;
    const operation = ++sequence.current;
    setBusy('prepare'); setError(''); setPrepared(null);
    try {
      const trip = await localApi.pocket.prepare(selected.id);
      if (sequence.current === operation) setPrepared(trip);
    } catch (caught) {
      if (sequence.current === operation) setError(caught instanceof Error ? caught.message : 'The linked trip could not be prepared.');
    } finally { if (sequence.current === operation) setBusy(null); }
  };
  const previewFile = async (file?: File) => {
    const operation = ++sequence.current;
    setReview(null); setResult(null); setError(''); setBusy(null);
    if (!file) return;
    if (!file.size || file.size > MAX_POCKET_BYTES) { setError('Choose a nonempty .qiscript file no larger than 8 MiB.'); return; }
    setBusy('preview');
    try {
      // Decode fatally so malformed input cannot be silently replaced by U+FFFD.
      const fileText = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(await file.arrayBuffer());
      if (sequence.current !== operation) return;
      const preview = await localApi.pocket.preview(fileText);
      if (sequence.current === operation) setReview({ fileText, name: file.name, preview });
    } catch (caught) {
      if (sequence.current === operation) setError(caught instanceof Error ? caught.message : 'This snapshot could not be previewed.');
    } finally { if (sequence.current === operation) setBusy(null); }
  };
  const importFile = async (linked = false) => {
    if (!review || busy || result) return;
    const operation = ++sequence.current;
    setBusy('import'); setError('');
    try {
      const imported = linked
        ? await localApi.pocket.returnLinked(review.fileText, review.preview.contentSha256)
        : await localApi.pocket.import(review.fileText, review.preview.contentSha256);
      if (sequence.current !== operation) return;
      setResult(imported);
      await onChanged();
    } catch (caught) {
      if (sequence.current === operation) setError(caught instanceof Error ? caught.message : 'Import could not be confirmed. Retry this same file safely.');
    } finally { if (sequence.current === operation) setBusy(null); }
  };
  const snapshot = review?.preview.snapshot;

  return <section className="pocket-exchange" aria-labelledby="pocket-heading">
    <p className="lw-eyebrow">LOCAL FILE EXCHANGE</p>
    <h2 id="pocket-heading">iPhone exchange</h2>
    <p>Move one screenplay and its creative development between devices with a <strong>.qiscript</strong> file. Choose each transfer yourself; there is no automatic sync or hosted service.</p>
    <div className="pocket-scope">
      <p><strong>Included:</strong> the selected saved screenplay, genre, format, page target, loglines, concept, synopsis, outline, beats, characters, research notes, world notes, and the full world with its element and link identities.</p>
      <p><strong>Stays on the source device:</strong> unsaved edits, revision history, shared-world connections and publication lineage (worldSources), rights and production records, retained originals, credentials, and competition state.</p>
      <p>Import copy creates an independent working copy. A linked trip can return reviewed changes to this same Mac draft while its starting revisions still match. Scene references stay as authored text and may need review. A matching checksum confirms file integrity; it does not establish authorship, rights, or production approval.</p>
    </div>
    <div className="pocket-actions">
      <div>
        <h3>Export from this Mac</h3>
        <label htmlFor="pocket-draft">Saved screenplay</label>
        <select id="pocket-draft" disabled={busy !== null} value={selected ? selectedId : ''} onChange={event => { setSelectedId(event.target.value); setPrepared(null); }}>
          <option value="">Select a saved draft…</option>
          {drafts.map(draft => <option key={draft.id} value={draft.id}>{draft.data.title} · v{draft.version}</option>)}
        </select>
        <p>Save screenplay and development edits first. The download uses their latest saved revisions.</p>
        {selected ? <a className="pocket-download" href={localApi.pocket.exportUrl(selected.id)} download="screenplay-snapshot.qiscript">Download selected snapshot</a> : <p className="pocket-help">{drafts.length ? 'Select a saved draft to download.' : 'Save a draft to enable export.'}</p>}
        {selected && <div>
          <Button disabled={busy !== null} onClick={() => void prepareLinked()}>{busy === 'prepare' ? 'Preparing…' : 'Prepare linked phone trip'}</Button>
          <p className="pocket-help">A linked trip remembers both saved Mac revisions. Its reviewed return keeps this draft identity and shared-world connections. One accepted return per trip; prepare a fresh trip for another cycle. Prior phone copies and histories remain.</p>
          {prepared && <a className="pocket-download" href={localApi.pocket.linkedUrl(prepared.exchangeId)} download="screenplay-linked-trip.qiscript">Download linked phone trip</a>}
        </div>}
        <p className="pocket-help">Transfer the downloaded file using Files or AirDrop, then import it on your iPhone. Downloading does not confirm delivery.</p>
      </div>
      <div>
        <h3>Import onto this Mac</h3>
        <label htmlFor="pocket-file">Choose snapshot to preview (up to 8 MiB)</label>
        <input id="pocket-file" type="file" accept=".qiscript,.json,application/json" disabled={busy !== null} onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; void previewFile(file); }} />
        {busy === 'preview' && <p role="status">Checking the selected file…</p>}
        {snapshot && <div className="pocket-preview">
          <h4>{snapshot.title}</h4>
          <p>{review.name} · {snapshot.body.length.toLocaleString()} screenplay characters</p>
          <p>{snapshot.development.beats.length} beats · {snapshot.development.characters.length} characters · {snapshot.development.researchNotes.length} research notes · {snapshot.development.world.elements.length} world elements · {snapshot.development.world.links.length} links</p>
          <p>{snapshot.genre || 'Genre unspecified'} · {snapshot.projectFormat || 'Format unspecified'} · {snapshot.targetPages === undefined ? 'Page target unknown' : `${snapshot.targetPages} target pages`}</p>
          {snapshot.logline && <p>{snapshot.logline}</p>}
          <details><summary>Read screenplay and development preview</summary><pre>{snapshot.body}</pre><pre>{JSON.stringify(snapshot.development, null, 2)}</pre></details>
          {review.preview.continuation && <div>
            <h4>Return to linked Mac draft</h4>
            <p>Starting screenplay v{review.preview.continuation.draft.version} · development v{review.preview.continuation.development.version}</p>
            <p role="status">{review.preview.returnReview?.message ?? 'This linked return is unavailable for review.'}</p>
            {review.preview.returnReview?.baseSnapshot && <>
              <p>Changed screenplay fields: {review.preview.returnReview.changedDraftFields?.join(', ') || 'none'}. Changed development fields: {review.preview.returnReview.changedDevelopmentFields?.join(', ') || 'none'}.</p>
              <details><summary>Compare with saved Mac starting copy</summary><pre>{JSON.stringify(review.preview.returnReview.baseSnapshot, null, 2)}</pre></details>
            </>}
            <Button disabled={busy !== null || result !== null || !['ready', 'returned'].includes(review.preview.returnReview?.status ?? '')} onClick={() => void importFile(true)}>{busy === 'import' ? 'Saving…' : review.preview.returnReview?.status === 'returned' ? 'Reopen confirmed linked return' : 'Apply reviewed return to linked draft'}</Button>
            <p className="pocket-help">Existing saved histories stay on both devices. This updates only writer creative records; use the Mac’s reviewed QiMovi connection afterward. Scene identity conflicts still require review.</p>
          </div>}
          <p className="pocket-help">File integrity checked. No authorship or rights claim. Import saves screenplay and development together. Repeating this exact snapshot opens the same copy and preserves later edits.</p>
          <Button disabled={busy !== null || result !== null} onClick={() => void importFile()}>{busy === 'import' ? 'Importing…' : 'Import: create independent copy'}</Button>
        </div>}
      </div>
    </div>
    {error && <p role="alert">{error}</p>}
    {result && <div role="status"><p>{result.mode === 'continuation' ? result.replayed ? 'This linked return was already saved. Your later Mac edits are preserved.' : 'Linked Mac draft updated with its development and world. Previous revisions and shared-world connections remain.' : result.replayed ? 'This snapshot was already imported. Your later edits are preserved.' : 'Independent working copy saved with its development and world.'}</p><Button variant="outline" onClick={() => onOpenDraft(result.draft.id)}>Open working copy</Button></div>}
  </section>;
}
