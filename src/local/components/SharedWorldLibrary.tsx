import { forwardRef, useCallback, useEffect, useId, useImperativeHandle, useRef, useState } from 'react';
import { BookOpen, Plus, RefreshCw, Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { localApi, LocalApiError } from '../api';
import { canonicalJson, downloadText } from '../model';
import { createWorld, worldMarkdown, type WorldData } from '../world';
import {
  appendSharedWorldNotes, appendWorldSnapshot, isSharedWorldRecord, newSharedWorldId,
  publishWorldSnapshot, sharedWorldSave, SHARED_WORLD_KIND,
  type SharedWorldRecord, type SharedWorldSave,
} from '../shared-world';
import './shared-world-library.css';
import { LinkedWorldPanel } from './LinkedWorldPanel';
import { publishConnectedWorld, type WorldSource } from '../world-sources';
import type { WorkspaceRecord } from '../types';

export interface SharedWorldLibraryHandle { assertSaved: () => void }
export interface SharedWorldLibraryProps {
  projectId: string;
  draftId?: string;
  worldSources?: WorldSource[];
  onLinkedImport?: (world: WorldData, notes: string, sources: WorldSource[]) => string | null;
  onOpenDraft?: (id: string) => void;
  world: WorldData;
  notes: string;
  disabled?: boolean;
  onImport: (world: WorldData, notes: string) => string | null;
  onEditDraft: () => void;
}
type Preview = { type: 'publish'; input: SharedWorldSave; excluded: number; source: string | null; previous: SharedWorldRecord | null }
  | { type: 'import'; world: WorldData; notes: string; source: string; record: SharedWorldRecord };
const fingerprint = (world: WorldData, notes: string) => canonicalJson(world) + JSON.stringify(notes);
const message = (cause: unknown) => cause instanceof Error ? cause.message : 'The shared world action could not be completed.';
const count = (value: number, singular: string) => `${value.toLocaleString()} ${singular}${value === 1 ? '' : 's'}`;

/** All authoring stays in DevelopmentPanel's durable draft recovery. Library writes are explicit snapshots. */
export const SharedWorldLibrary = forwardRef<SharedWorldLibraryHandle, SharedWorldLibraryProps>(function SharedWorldLibrary({ projectId, draftId, worldSources = [], onLinkedImport, onOpenDraft, world, notes, disabled = false, onImport, onEditDraft }, ref) {
  const [records, setRecords] = useState<SharedWorldRecord[]>([]);
  const [workspaceRecords, setWorkspaceRecords] = useState<WorkspaceRecord[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [pending, setPending] = useState<SharedWorldSave | null>(null);
  const [conflict, setConflict] = useState(false);
  const working = useRef(false);
  const pendingRef = useRef<SharedWorldSave | null>(null);
  const mounted = useRef(true);
  const selected = records.find(item => item.id === selectedId) ?? null;
  const formId = useId();
  const locked = disabled || busy || !!pending;
  const select = (record: SharedWorldRecord | null) => {
    if (working.current || pendingRef.current) return;
    setSelectedId(record?.id ?? null); setName(record?.data.name ?? ''); setPreview(null); setError(''); setNotice(''); setConflict(false);
  };
  const load = useCallback(async () => {
    if (working.current || pendingRef.current) return;
    working.current = true; setBusy(true); setError(''); setPreview(null);
    try {
      const bootstrap = await localApi.bootstrap();
      if (bootstrap.project.id !== projectId) throw new Error('The library response belongs to another workspace.');
      const worlds = bootstrap.records.filter(item => item.kind === SHARED_WORLD_KIND);
      if (worlds.some(item => !isSharedWorldRecord(item, projectId))) throw new Error('A shared world could not be validated. Existing draft notes are unchanged.');
      if (mounted.current) { setRecords(worlds as SharedWorldRecord[]); setWorkspaceRecords(bootstrap.records); setLoaded(true); setConflict(false); }
    } catch (cause) { if (mounted.current) setError(message(cause)); }
    finally { working.current = false; if (mounted.current) setBusy(false); }
  }, [projectId]);
  useEffect(() => { mounted.current = true; void load(); return () => { mounted.current = false; }; }, [load]);
  useImperativeHandle(ref, () => ({ assertSaved() {
    if (working.current || pendingRef.current) throw new Error('Finish or retry the shared world save before closing or switching drafts. Your draft notes are still retained.');
  } }), []);
  useEffect(() => {
    const guard = (event: BeforeUnloadEvent) => {
      if (working.current || pendingRef.current) { event.preventDefault(); event.returnValue = ''; }
    };
    window.addEventListener('beforeunload', guard);
    return () => window.removeEventListener('beforeunload', guard);
  }, []);

  const planPublish = (mode: 'empty' | 'new' | 'revision') => {
    if (locked || !loaded || (mode === 'revision' && (!selected || conflict))) return;
    try {
      const snapshot = mode === 'revision' && selected ? publishConnectedWorld(world, worldSources, selected) : publishWorldSnapshot(mode === 'empty' ? createWorld() : world);
      const data = { schemaVersion: 1 as const, projectId, name, description: mode === 'empty' ? '' : notes, world: snapshot.world };
      const previous = mode === 'revision' ? selected : null;
      const input = sharedWorldSave(previous?.id ?? newSharedWorldId(), data, previous?.version ?? null);
      setPreview({ type: 'publish', input, excluded: snapshot.excluded, source: mode === 'empty' ? null : fingerprint(world, notes), previous }); setError(''); setNotice('');
    } catch (cause) { setError(message(cause)); }
  };
  const planImport = () => {
    if (locked || !selected) return;
    try {
      setPreview({ type: 'import', world: appendWorldSnapshot(world, selected.data.world), notes: appendSharedWorldNotes(notes, selected.data, selected.version), source: fingerprint(world, notes), record: selected }); setError(''); setNotice('');
    } catch (cause) { setError(message(cause)); }
  };
  const publish = async (input: SharedWorldSave) => {
    if (working.current) return;
    working.current = true; pendingRef.current = input; setPending(input); setBusy(true); setError(''); setNotice('');
    try {
      const saved = await localApi.save(input);
      if (!isSharedWorldRecord(saved, projectId)) throw new LocalApiError('Shared world save could not be verified. Retry the same save.', 502, 'SAVE_UNCONFIRMED');
      pendingRef.current = null;
      if (!mounted.current) return;
      setPending(null); setPreview(null); setConflict(false);
      setRecords(previous => [...previous.filter(item => item.id !== saved.id), saved]); setSelectedId(saved.id); setName(saved.data.name);
      setNotice(`Published “${saved.data.name}” v${saved.version} to this workspace. Draft copies stay unchanged.`);
    } catch (cause) {
      const uncertain = !(cause instanceof LocalApiError) || cause.status === 0 || cause.status >= 500;
      if (!uncertain) { pendingRef.current = null; if (mounted.current) setPending(null); }
      if (!mounted.current) return;
      if (cause instanceof LocalApiError && ['VERSION_CONFLICT', 'REQUEST_ID_CONFLICT'].includes(cause.code)) {
        setConflict(true); setPreview(null); setError('This shared world changed elsewhere. Refresh the library and review its saved content before publishing another revision. Your draft is unchanged.');
      } else setError(uncertain ? 'Publication is unconfirmed. Retry to check the same save before closing or switching drafts. Your draft notes are retained.' : message(cause));
    } finally { working.current = false; if (mounted.current) setBusy(false); }
  };
  const confirm = () => {
    if (!preview || locked) return;
    if (preview.source !== null && preview.source !== fingerprint(world, notes)) { setPreview(null); setError('The draft world changed after this preview. Preview again before copying.'); return; }
    if (preview.type === 'publish') { void publish(preview.input); return; }
    const problem = onImport(preview.world, preview.notes);
    if (problem) { setError(problem); return; }
    setPreview(null); setNotice(`Added a snapshot of “${preview.record.data.name}” v${preview.record.version} to this draft. Edit it in Draft world and save development when ready.`);
  };
  const visible = records.filter(record => `${record.data.name} ${record.data.description}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())).sort((a, b) => a.data.name.localeCompare(b.data.name));

  return <section className="shared-world-library" aria-label="Shared world library">
    <header className="shared-world-heading"><div><h3><BookOpen aria-hidden="true" />Shared worlds</h3><p>Saved in this workspace and reusable across drafts. Link drafts to review updates, or reuse an independent snapshot.</p></div><Button type="button" size="sm" variant="ghost" disabled={locked} onClick={() => void load()}><RefreshCw aria-hidden="true" />Refresh library</Button></header>
    {error && <p role="alert" className="shared-world-message">{error}</p>}
    {notice && <p role="status" className="shared-world-message">{notice}</p>}
    {busy && <p role="status">{pending ? 'Publishing shared world…' : 'Loading shared worlds…'}</p>}
    {pending && !busy && <Button type="button" size="sm" onClick={() => void publish(pending)}>Retry publication</Button>}
    <div className="shared-world-layout">
      <aside aria-label="Saved shared worlds" className="shared-world-index">
        <label className="world-search"><Search aria-hidden="true" /><input aria-label="Search shared worlds" placeholder="Search shared worlds…" value={query} onChange={event => setQuery(event.target.value)} /></label>
        <Button type="button" size="sm" variant="outline" disabled={locked || !loaded} onClick={() => select(null)}><Plus aria-hidden="true" />New shared world</Button>
        <div className="shared-world-list">{visible.map(record => <button type="button" key={record.id} disabled={locked} aria-pressed={selectedId === record.id} onClick={() => select(record)}><strong>{record.data.name}</strong><span>v{record.version} · {count(record.data.world.elements.length, 'element')} · {count(record.data.world.links.length, 'connection')}</span></button>)}</div>
        {loaded && !visible.length && <p className="world-prompt">{records.length ? 'No shared worlds match this search.' : 'No shared worlds yet. Publish your draft world or create an empty one.'}</p>}
      </aside>
      <div className="shared-world-detail">
        <fieldset disabled={locked || !loaded}>
          <legend className="sr-only">Publish a shared world</legend>
          <label htmlFor={formId}>Shared world name</label><Input id={formId} value={name} maxLength={160} onChange={event => { setName(event.target.value); setPreview(null); }} />
          <p className="world-prompt">Edit world details in Draft world. Publishing copies its current elements and complete overview to the library.</p>
          <div className="shared-world-actions">
            <Button type="button" size="sm" onClick={() => planPublish('new')}>Preview publication as new world</Button>
            {selected ? <Button type="button" size="sm" variant="outline" disabled={conflict} onClick={() => planPublish('revision')}>Preview revision of selected world</Button> : <Button type="button" size="sm" variant="outline" onClick={() => planPublish('empty')}>Preview empty world</Button>}
          </div>
        </fieldset>
        {selected && draftId && onLinkedImport && <LinkedWorldPanel key={selected.id} projectId={projectId} draftId={draftId} record={selected} records={workspaceRecords} world={world} notes={notes} sources={worldSources} disabled={locked} onApply={onLinkedImport} onOpenDraft={onOpenDraft} />}
        {selected && <section className="shared-world-saved" aria-label="Selected shared world">
          <h4>{selected.data.name} <span>Saved v{selected.version}</span></h4>
          <p className="world-prompt">{count(selected.data.world.elements.length, 'element')} · {count(selected.data.world.links.length, 'internal connection')} · {count(selected.data.description.length, 'overview character')}</p>
          <div className="shared-world-actions"><Button type="button" size="sm" disabled={locked} onClick={planImport}>Preview adding to draft</Button><Button type="button" size="sm" variant="ghost" onClick={() => {
            try { downloadText(`${selected.id}-v${selected.version}.json`, JSON.stringify(selected, null, 2) + '\n', 'application/json;charset=utf-8'); } catch (cause) { setError(message(cause)); }
          }}>Export saved world</Button></div>
          <details><summary>Read saved world</summary><pre>{selected.data.description}{'\n\n'}{worldMarkdown(selected.data.world)}</pre></details>
        </section>}
        {preview && <section className="shared-world-preview" role="region" aria-label="World copy preview">
          <h4>{preview.type === 'publish' ? preview.previous ? `Publish a new revision of “${preview.previous.data.name}”` : `Create “${preview.input.data.name}”` : `Add “${preview.record.data.name}” v${preview.record.version} to this draft`}</h4>
          {preview.type === 'publish' ? <>
            <p>{count(preview.input.data.world.elements.length, 'element')}, {count(preview.input.data.world.links.length, 'internal connection')} and {count(preview.input.data.description.length, 'overview character')} will be saved.</p>
            <p>{count(preview.excluded, 'scene or screenplay-character connection')} excluded. Labels and notes remain in the source draft.</p>
            {preview.previous && <p>This replaces all {count(preview.previous.data.world.elements.length, 'element')} and {count(preview.previous.data.world.links.length, 'connection')} in library v{preview.previous.version}. Earlier revisions remain in history. Connected identities are retained; other drafts change only after review.</p>}
          </> : <><p>Adds {count(preview.record.data.world.elements.length, 'element')} and {count(preview.record.data.world.links.length, 'connection')} as new copies. Existing draft elements and notes remain.</p><p>Result: {count(preview.world.elements.length, 'element')}, {count(preview.world.links.length, 'connection')} and {count(preview.notes.length, 'overview character')}. Repeating an import creates additional copies.</p></>}
          <div className="shared-world-actions"><Button type="button" size="sm" disabled={locked} onClick={confirm}>{preview.type === 'publish' ? 'Publish snapshot' : 'Add snapshot to draft'}</Button><Button type="button" size="sm" variant="ghost" disabled={busy || !!pending} onClick={() => setPreview(null)}>Cancel preview</Button></div>
        </section>}
        <Button type="button" size="sm" variant="link" onClick={onEditDraft}>Edit in Draft world</Button>
      </div>
    </div>
  </section>;
});
