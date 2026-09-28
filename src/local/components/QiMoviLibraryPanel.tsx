import { useEffect, useId, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { LocalApiError, localApi } from '../api';
import { conversionCaveat, conversionLabel, reviewLibraryPreview, validImportTitle, type ImportReview } from '../import-review';
import type { LibraryAsset, LibraryCatalog, LibraryImportInput, LibraryImportResult } from '../library-import';
import './qimovi-library-panel.css';

export interface QiMoviLibraryPanelProps {
  project: { id: string; title: string };
  disabled: boolean;
  onChanged: () => Promise<void>;
  onOpenDraft?: (id: string) => void;
}

type Busy = 'list' | 'preview' | 'import' | 'refresh' | null;
const message = (error: unknown) => error instanceof Error ? error.message : 'The Library request could not be completed.';
const referenceReason = (asset: LibraryAsset) => asset.reason || 'This document is reference only. Text extraction is not available.';

/** A new project gets a fresh session; old requests cannot revive its review or token. */
export function QiMoviLibraryPanel(props: QiMoviLibraryPanelProps) {
  return <LibrarySession key={JSON.stringify([props.project.id, props.project.title])} {...props} />;
}

function LibrarySession({ project, disabled, onChanged, onOpenDraft }: QiMoviLibraryPanelProps) {
  const id = useId();
  const [catalog, setCatalog] = useState<LibraryCatalog | null>(null);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const [review, setReview] = useState<ImportReview | null>(null);
  const [title, setTitle] = useState('');
  const [pending, setPending] = useState<Readonly<LibraryImportInput> | null>(null);
  const [result, setResult] = useState<LibraryImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [needsReload, setNeedsReload] = useState(false);
  const [busy, setBusy] = useState<Busy>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const mounted = useRef(false);
  const request = useRef(0);
  const busyRef = useRef<Busy>(null);
  const pendingRef = useRef<Readonly<LibraryImportInput> | null>(null);
  const disabledRef = useRef(disabled);
  disabledRef.current = disabled;

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; request.current += 1; };
  }, []);

  const start = (operation: Busy) => {
    const ticket = ++request.current;
    busyRef.current = operation;
    setBusy(operation);
    return () => mounted.current && ticket === request.current;
  };
  const finish = () => { busyRef.current = null; setBusy(null); };

  const load = async () => {
    if (busyRef.current || pendingRef.current) return;
    const current = start('list');
    setError(null); setReview(null); setResult(null); setSelectedId(null); setRefreshError(null); setNeedsReload(false);
    setCatalog(null);
    try {
      const value = await localApi.qimovi.library.list();
      if (!current()) return;
      if (value.project.id !== project.id) throw new Error('QiMovi changed projects. Reconnect to the intended project before loading its Library.');
      setCatalog(value);
    } catch (cause) { if (current()) setError(message(cause)); }
    finally { if (current()) finish(); }
  };

  const preview = async (asset: LibraryAsset) => {
    if (pendingRef.current || (busyRef.current && busyRef.current !== 'preview') || asset.format === 'REFERENCE' || asset.reason) return;
    const current = start('preview');
    setSelectedId(asset.id); setReview(null); setResult(null); setError(null); setRefreshError(null); setTitle(''); setNeedsReload(false);
    try {
      const value = await localApi.qimovi.library.preview(asset.id);
      if (!current()) return;
      const next = reviewLibraryPreview(value, project.id, asset.id);
      setReview(next);
      setTitle(value.asset.title.trim() ? value.asset.title : value.asset.filename.replace(/\.(fdx|fountain)$/i, ''));
    } catch (cause) { if (current()) setError(message(cause)); }
    finally { if (current()) finish(); }
  };

  const refresh = async () => {
    if (busyRef.current) return;
    const current = start('refresh');
    setRefreshError(null);
    try { await onChanged(); }
    catch (cause) { if (current()) setRefreshError(`The draft was saved, but the workspace list could not refresh. ${message(cause)}`); }
    finally { if (current()) finish(); }
  };

  const commit = async () => {
    if (disabledRef.current || busyRef.current || !review || result || needsReload || review.preview.asset.importedDraftId) return;
    if (!pendingRef.current && !validImportTitle(title)) return;
    // Retain the exact reviewed request across ambiguous failures, including its token.
    const input = pendingRef.current ?? Object.freeze({ token: review.preview.token, title, body: review.body, conversion: review.conversion });
    pendingRef.current = input;
    setPending(input);
    const current = start('import');
    setError(null); setRefreshError(null);
    try {
      const saved = await localApi.qimovi.library.import(input);
      if (!current()) return;
      setResult(saved);
      setCatalog(value => value && ({ ...value, assets: value.assets.map(asset => asset.id === review.preview.asset.id ? { ...asset, importedDraftId: saved.draft.id } : asset) }));
      pendingRef.current = null; setPending(null);
      // Refresh failure is not an unconfirmed import: never offer to create it again.
      try { await onChanged(); }
      catch (cause) { if (current()) setRefreshError(`The draft was saved, but the workspace list could not refresh. ${message(cause)}`); }
    } catch (cause) {
      if (!current()) return;
      setError(message(cause));
      if (cause instanceof LocalApiError && ['QIMOVI_LIBRARY_PREVIEW_EXPIRED', 'QIMOVI_LIBRARY_STALE', 'QIMOVI_LIBRARY_ALREADY_IMPORTED'].includes(cause.code)) {
        // These explicit rejections cannot be retried with this token. Check the
        // catalog for a previously saved copy before obtaining another review.
        setNeedsReload(true); pendingRef.current = null; setPending(null);
      }
    }
    finally { if (current()) finish(); }
  };

  const locked = !!pending || busy === 'import' || busy === 'refresh';
  const importedId = result?.draft.id ?? review?.preview.asset.importedDraftId;
  const assets = catalog?.assets.filter(asset => asset.filename.toLowerCase().includes(query.toLowerCase()) && (filter === 'all' || asset.format === filter)) ?? [];
  const openDraft = (draftId: string) => { if (!disabledRef.current && !busyRef.current && !pendingRef.current) onOpenDraft?.(draftId); };

  return <section className="qimovi-library" aria-label="QiMovi Library">
    <h4>QiMovi Library</h4>
    <p className="qimovi-library-help">Choose a document from <strong>{project.title}</strong>, review its text, then create a separate local working draft. Your current draft and QiMovi’s canonical source stay unchanged.</p>
    <Button type="button" size="sm" variant="outline" disabled={!!busy || !!pending} onClick={() => void load()}>{busy === 'list' ? 'Loading Library…' : 'Load Library'}</Button>
    {catalog && <>
      <div className="qimovi-library-filters">
        <label htmlFor={`${id}-search`}>Search filenames</label>
        <Input id={`${id}-search`} type="search" value={query} onChange={event => setQuery(event.target.value)} />
        <label htmlFor={`${id}-format`}>Document format</label>
        <select id={`${id}-format`} value={filter} onChange={event => setFilter(event.target.value)}>
          <option value="all">All documents</option><option value="FDX">Final Draft (.fdx)</option><option value="FOUNTAIN">Fountain</option><option value="REFERENCE">Reference only</option>
        </select>
      </div>
      <p className="qimovi-library-help" role="status">{assets.length} of {catalog.assets.length} documents shown.</p>
      {!catalog.assets.length && <p className="qimovi-library-help">No Library documents were returned for this project.</p>}
      {!!catalog.assets.length && !assets.length && <p className="qimovi-library-help">No filenames match this search and filter.</p>}
      <ul className="qimovi-library-assets" aria-label="Library documents">
        {assets.map(asset => <li key={asset.id} data-selected={selectedId === asset.id}>
          <strong>{asset.filename}</strong>
          <span className="qimovi-library-help">{asset.format === 'REFERENCE' ? 'Reference only' : asset.format} · {asset.byteLength.toLocaleString()} bytes · source v{asset.version}</span>
          {asset.format === 'REFERENCE' || asset.reason ? <p className="qimovi-library-help">{referenceReason(asset)}</p> : <Button type="button" size="sm" variant="outline" disabled={locked || busy === 'list'} aria-label={`Preview ${asset.filename}`} onClick={() => void preview(asset)}>Preview document</Button>}
          {asset.importedDraftId && <div className="qimovi-library-actions"><span className="qimovi-library-help">Already imported.</span>{onOpenDraft && <Button type="button" size="sm" variant="ghost" disabled={disabled || !!busy || !!pending} onClick={() => openDraft(asset.importedDraftId!)}>Open imported draft</Button>}</div>}
        </li>)}
      </ul>
    </>}
    {busy === 'preview' && <p role="status">Loading and converting the selected document…</p>}
    {error && <div role="alert" className="qimovi-library-notice"><p>{error}</p>{pending && <p>The import could not be confirmed and may already be saved. The reviewed title and text are frozen. Retry the same import to check its saved result.</p>}</div>}
    {needsReload && <p role="status" className="qimovi-library-help">Load Library to check saved imports and review the current source again.</p>}
    {review && <section className="qimovi-library-review" aria-label="Library import review">
      <h5>Review local working draft</h5>
      <dl className="qimovi-source-facts">
        <dt>Source file</dt><dd>{review.preview.asset.filename}</dd>
        <dt>QiMovi project</dt><dd>{review.preview.project.title} <code>{review.preview.project.id}</code></dd>
        <dt>Original bytes</dt><dd>{review.preview.asset.byteLength.toLocaleString()}</dd>
        <dt>Original SHA-256</dt><dd><code>{review.preview.asset.contentSha256}</code></dd>
      </dl>
      <details><summary>Source revision</summary><dl className="qimovi-source-facts"><dt>Library record</dt><dd><code>{review.preview.asset.id}</code></dd><dt>Saved revision</dt><dd>v{review.preview.asset.version}</dd><dt>Record SHA-256</dt><dd><code>{review.preview.asset.sha256}</code></dd></dl></details>
      <p><strong>{conversionLabel(review.conversion)}</strong></p>
      <p className="qimovi-library-help">{conversionCaveat(review.conversion)}</p>
      <label htmlFor={`${id}-title`}>Local draft title</label>
      <Input id={`${id}-title`} value={title} maxLength={200} readOnly={locked || !!importedId || needsReload} onChange={event => { if (!locked && !importedId && !needsReload) setTitle(event.target.value); }} />
      {!validImportTitle(title) && <p className="qimovi-library-help">Enter a title of 1–200 characters on one line.</p>}
      <p className="qimovi-library-help">{review.sceneCount !== null && review.characters !== null && <>{review.sceneCount} scenes · {review.characters.length} characters · </>}{review.body.length.toLocaleString()} / 200,000 text characters</p>
      {review.sceneCount === null && <p className="qimovi-library-help">Scene and character statistics unavailable: this document exceeds the summary limits. The full text is available below and can still be imported.</p>}
      {!!review.characters?.length && <details><summary>Characters in the preview</summary><p className="qimovi-library-help">{review.characters.join(', ')}</p></details>}
      <label htmlFor={`${id}-body`}>Full Fountain preview (read only)</label>
      <textarea id={`${id}-body`} className="qimovi-library-fountain" value={review.body} readOnly spellCheck={false} rows={16} />
      {!importedId && <p className="qimovi-library-help">This review creates no draft until you choose Create local working draft. The saved copy is working text, not canonical source approval.</p>}
      {disabled && <p role="status" className="qimovi-library-help">Save your current edits and finish any pending workspace action before creating or opening an imported draft.</p>}
      {!importedId && <Button type="button" size="sm" disabled={disabled || !!busy || needsReload || !validImportTitle(title)} onClick={() => void commit()}>{busy === 'import' ? 'Saving local working draft…' : pending ? 'Retry same import' : 'Create local working draft'}</Button>}
      {result && <div role="status" className="qimovi-library-notice"><p>{result.replayed ? 'This import was already saved' : 'Local working draft created'}: <strong>{result.draft.data.title}</strong>.</p>{result.replayed && <p>The existing draft may contain later edits. Open it to see its current saved text.</p>}</div>}
      {!result && importedId && <p role="status" className="qimovi-library-help">This source already has a local working draft.</p>}
      {importedId && onOpenDraft && <Button type="button" size="sm" variant="outline" disabled={disabled || !!busy} onClick={() => openDraft(importedId)}>Open imported draft</Button>}
    </section>}
    {refreshError && <div role="alert" className="qimovi-library-notice"><p>{refreshError}</p><Button type="button" size="sm" variant="outline" disabled={!!busy} onClick={() => void refresh()}>Refresh local drafts</Button></div>}
  </section>;
}
