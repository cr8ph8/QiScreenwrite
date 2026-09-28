import { forwardRef, useCallback, useEffect, useId, useImperativeHandle, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, Plus, Save, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { WorldBuilder } from './WorldBuilder';
import { SharedWorldLibrary, type SharedWorldLibraryHandle } from './SharedWorldLibrary';
import { createWorld, type WorldData } from '../world';
import type { WorldContext } from '../world-context';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { localApi, LocalApiError } from '../api';
import { canonicalJson, downloadText } from '../model';
import { appendFilmcraftResearch, FILMCRAFT_CATALOG, type FilmcraftBrowse, type FilmcraftResearchRequest, type FilmcraftResearchResult } from '../filmcraft';
import {
  DEVELOPMENT_LIMITS as limits, withDevelopmentWorld, cloneDevelopment, createDevelopment, developmentError,
  developmentId, developmentMarkdown, developmentRecoveryKey, developmentSave,
  isDevelopmentRecord, newDevelopmentBeat, newDevelopmentCharacter, newDevelopmentResearchNote,
  readDevelopmentRecovery,
  type DevelopmentData, type DevelopmentRecord, type DevelopmentRecovery, type DevelopmentSave,
} from '../development';

export interface DevelopmentPanelProps {
  projectId: string;
  draftId: string;
  initialRecord?: DevelopmentRecord | null;
  onSaved: (record: DevelopmentRecord) => void;
  active?: boolean;
  onBrowseFilmcraft?: (browse: FilmcraftBrowse) => void;
  view?: 'develop' | 'world';
  worldContext?: WorldContext;
  onJump?: (offset: number) => void;
  onOpenDraft?: (id: string) => void;
  onWorldChange?: (world: WorldData | undefined) => void;
  focusElement?: { id: string; nonce: number };
  onStateChange?: (state: { dirty: boolean; canSave: boolean; status: string }) => void;
}
export interface DevelopmentPanelHandle {
  addResearch: (request: FilmcraftResearchRequest) => FilmcraftResearchResult;
  save: () => void;
}

interface EditorState {
  data: DevelopmentData;
  saved: DevelopmentRecord | null;
  recovery: DevelopmentRecovery | null;
  pending: DevelopmentSave | null;
  conflict: boolean;
  latest: DevelopmentRecord | null;
  error: string;
  notice: string;
}

/** Safe to change draft/project props without a parent key. Never mounts foreign data. */
export const DevelopmentPanel = forwardRef<DevelopmentPanelHandle, DevelopmentPanelProps>(function DevelopmentPanel(props, ref) {
  let error = '';
  try { createDevelopment(props.projectId, props.draftId); } catch (cause) { error = (cause as Error).message; }
  if (!error && props.initialRecord && !isDevelopmentRecord(props.initialRecord, props.projectId, props.draftId)) error = 'This development record does not match the selected draft or has invalid data. Reload the workspace.';
  if (error) return <section className="p-4 text-sm" aria-label="Story development"><p role="alert">{error}</p></section>;
  return <DevelopmentEditor key={`${props.projectId}/${props.draftId}`} ref={ref} {...props} />;
});

const DevelopmentEditor = forwardRef<DevelopmentPanelHandle, DevelopmentPanelProps>(function DevelopmentEditor({ projectId, draftId, initialRecord, onSaved, active = true, onBrowseFilmcraft, view = 'develop', worldContext, onJump, onOpenDraft, onWorldChange, focusElement, onStateChange }, ref) {
  const headingId = useId();
  const blank = useRef(createDevelopment(projectId, draftId)).current;
  const [state, setState] = useState<EditorState>(() => {
    const saved = initialRecord ? { ...initialRecord, data: cloneDevelopment(initialRecord.data) } : null;
    let recovery: DevelopmentRecovery | null = null;
    try { recovery = readDevelopmentRecovery(window.localStorage, projectId, draftId); } catch { /* handled on the first edit */ }
    if (recovery && !recovery.pendingSave && canonicalJson(recovery.data) === canonicalJson(saved?.data ?? blank)) recovery = null;
    return { data: cloneDevelopment(saved?.data ?? blank), saved, recovery, pending: null, conflict: false, latest: null, error: '', notice: '' };
  });
  const current = useRef(state);
  const mounted = useRef(true);
  const working = useRef(false);
  const [busy, setBusy] = useState(false);
  const [storageWarning, setStorageWarning] = useState(false);
  const [tab, setTab] = useState('story');
  const [worldOpened, setWorldOpened] = useState(view === 'world');
  const [worldTab, setWorldTab] = useState('draft-world');
  const [libraryOpened, setLibraryOpened] = useState(false);
  const sharedLibrary = useRef<SharedWorldLibraryHandle>(null);
  useEffect(() => { if (view === 'world') setWorldOpened(true); }, [view]);
  const [removed, setRemoved] = useState<{ before: DevelopmentData; after: string } | null>(null);
  const [recoveryLoaded, setRecoveryLoaded] = useState(false);
  const [diskWarning, setDiskWarning] = useState('');
  const [recoveryCheck, setRecoveryCheck] = useState(0);
  const diskReady = useRef(false);
  const diskCopy = useRef<DevelopmentRecovery | null>(null);
  const pendingDisk = useRef<DevelopmentRecovery | null>(null);
  const diskQueue = useRef<Promise<void>>(Promise.resolve());
  const diskFailure = useRef<Error | null>(null);
  const diskTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastRecoveryTime = useRef(0);

  const isDirty = useCallback((value: EditorState) => canonicalJson(value.data) !== canonicalJson(value.saved?.data ?? blank), [blank]);
  const recoveryCopy = useCallback((value: EditorState): DevelopmentRecovery => {
    lastRecoveryTime.current = Math.max(Date.now(), lastRecoveryTime.current + 1);
    return ({
    schema: 'caniscreenwrite-story-development-recovery/v1', projectId, draftId,
    baseVersion: value.saved?.version ?? null, baseSha256: value.saved?.sha256 ?? null,
    data: value.data, pendingSave: value.pending, savedAt: new Date(lastRecoveryTime.current).toISOString(),
  }); }, [projectId, draftId]);

  const drainDisk = useCallback(() => {
    if (diskTimer.current) clearTimeout(diskTimer.current);
    diskTimer.current = null;
    diskQueue.current = diskQueue.current.then(async () => {
      // One writer at a time; edits arriving during a write replace the queued
      // copy, so an older response never schedules an older write afterward.
      while (pendingDisk.current) {
        const copy = pendingDisk.current; pendingDisk.current = null;
        try {
          const written = await localApi.developmentRecovery.put(copy);
          if (canonicalJson(written) !== canonicalJson(copy)) throw new Error('Development disk recovery was not confirmed.');
          diskCopy.current = written; diskFailure.current = null;
          if (mounted.current) setDiskWarning('');
        } catch (cause) {
          diskFailure.current = cause instanceof Error ? cause : new Error('Development disk recovery failed.');
          if (mounted.current) setDiskWarning(diskFailure.current.message);
        }
      }
    });
    return diskQueue.current;
  }, []);

  const queueDisk = useCallback((copy: DevelopmentRecovery) => {
    if (!diskReady.current) return;
    pendingDisk.current = copy;
    if (diskTimer.current) clearTimeout(diskTimer.current);
    diskTimer.current = setTimeout(() => { void drainDisk(); }, 300);
  }, [drainDisk]);

  const clearCleanRecovery = useCallback(() => {
    diskQueue.current = diskQueue.current.then(async () => {
      const now = current.current;
      if (!diskReady.current || now.recovery || now.pending || isDirty(now)) return;
      const copy = diskCopy.current;
      if (!copy) return;
      try {
        const result = await localApi.developmentRecovery.remove(draftId, copy.savedAt);
        if (result.deleted && diskCopy.current === copy) diskCopy.current = null;
      } catch (cause) {
        if (mounted.current) setDiskWarning(`Saved development is intact, but an older recovery copy could not be cleared: ${cause instanceof Error ? cause.message : 'unavailable'}`);
      }
    });
  }, [draftId, isDirty]);

  // Synchronous on each edit: switching drafts or relocking the session cannot
  // cancel a debounce and silently drop the last keystrokes. A recovery offer
  // is never overwritten before the owner chooses whether to restore it.
  const update = useCallback((value: EditorState) => {
    current.current = value;
    if (mounted.current) setState(value);
    if (value.recovery) return;
    const copy = isDirty(value) || value.pending ? recoveryCopy(value) : null;
    if (copy) queueDisk(copy); else { pendingDisk.current = null; clearCleanRecovery(); }
    try {
      const key = developmentRecoveryKey(projectId, draftId);
      if (copy) window.localStorage.setItem(key, JSON.stringify(copy));
      else window.localStorage.removeItem(key);
      if (mounted.current) setStorageWarning(false);
    } catch { if (mounted.current) setStorageWarning(true); }
  }, [draftId, projectId, isDirty, recoveryCopy, queueDisk, clearCleanRecovery]);

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    let cancelled = false;
    diskReady.current = false; setRecoveryLoaded(false);
    void localApi.developmentRecovery.get(draftId).then(copy => {
      if (cancelled) return;
      if (copy && !readDevelopmentRecovery({ getItem: () => JSON.stringify(copy) }, projectId, draftId)) throw new Error('The disk recovery copy did not match this draft.');
      diskCopy.current = copy; diskReady.current = true; diskFailure.current = null;
      if (copy) lastRecoveryTime.current = Math.max(lastRecoveryTime.current, Date.parse(copy.savedAt));
      let browser: DevelopmentRecovery | null = null;
      try { browser = readDevelopmentRecovery(window.localStorage, projectId, draftId); } catch { /* disk copy is still usable */ }
      const now = current.current;
      const choices = [now.recovery, browser, copy].filter((item): item is DevelopmentRecovery => !!item && (!!item.pendingSave || canonicalJson(item.data) !== canonicalJson(now.saved?.data ?? blank)));
      choices.sort((a, b) => Date.parse(b.savedAt) - Date.parse(a.savedAt));
      const offer = choices[0] ?? null;
      // Loading disables edits; on a retry the immediate browser copy also
      // participates, so new typing cannot be replaced by a late response.
      update({ ...now, recovery: offer });
      setRecoveryLoaded(true); setDiskWarning('');
    }).catch(cause => {
      if (cancelled) return;
      diskFailure.current = cause instanceof Error ? cause : new Error('Disk recovery could not be checked.');
      setDiskWarning(`Disk recovery could not be checked: ${diskFailure.current.message}`);
      setRecoveryLoaded(true);
    });
    return () => { cancelled = true; };
  }, [draftId, projectId, blank, recoveryCheck, update]);

  const flushRecovery = useCallback(async () => {
    sharedLibrary.current?.assertSaved();
    const now = current.current;
    if (now.recovery) {
      // Do not overwrite a different unresolved offer on disk just to quit.
      if (!diskCopy.current || canonicalJson(diskCopy.current) !== canonicalJson(now.recovery)) throw new Error('Restore or discard the development recovery offer before quitting; its newest copy is only in this browser.');
      return;
    }
    if (isDirty(now) || now.pending) {
      if (!diskReady.current) throw new Error('Check development disk recovery or save development before quitting.');
      const copy = pendingDisk.current ?? recoveryCopy(now);
      if (!diskCopy.current || canonicalJson({ ...diskCopy.current, savedAt: copy.savedAt }) !== canonicalJson(copy)) pendingDisk.current = copy;
    }
    await drainDisk();
    if (diskFailure.current && (isDirty(current.current) || current.current.pending)) throw diskFailure.current;
  }, [isDirty, recoveryCopy, drainDisk]);
  useEffect(() => {
    const host = window as unknown as { __flushDevelopmentRecovery?: () => Promise<void> };
    host.__flushDevelopmentRecovery = flushRecovery;
    return () => {
      if (host.__flushDevelopmentRecovery === flushRecovery) delete host.__flushDevelopmentRecovery;
      void drainDisk();
    };
  }, [flushRecovery, drainDisk]);
  useEffect(() => {
    if (!initialRecord) return;
    const value = current.current;
    if (initialRecord.version <= Math.max(value.saved?.version ?? 0, value.latest?.version ?? 0)) return;
    const latest = { ...initialRecord, data: cloneDevelopment(initialRecord.data) };
    if (isDirty(value) || value.pending || value.recovery || working.current) {
      update({ ...value, latest, conflict: true, notice: '' });
    } else update({ ...value, saved: latest, data: cloneDevelopment(latest.data), latest: null, conflict: false });
  }, [initialRecord, isDirty, update]);
  useEffect(() => {
    const guard = (event: BeforeUnloadEvent) => {
      if (isDirty(current.current) || current.current.pending || current.current.recovery) { event.preventDefault(); event.returnValue = ''; }
    };
    window.addEventListener('beforeunload', guard);
    return () => window.removeEventListener('beforeunload', guard);
  }, [isDirty]);

  const edit = (data: DevelopmentData) => update({ ...current.current, data, error: '', notice: '' });
  const field = <K extends keyof DevelopmentData>(key: K, value: DevelopmentData[K]) => edit({ ...current.current.data, [key]: value });

  useImperativeHandle(ref, () => ({ save: () => { void saveRef.current(); }, addResearch(request) {
    if (request.projectId !== projectId || request.draftId !== draftId) return { ok: false, message: 'This reference belongs to another draft. Open Film language again.' };
    if (!recoveryLoaded) return { ok: false, message: 'Checking development recovery. Try adding the reference again when it finishes.' };
    if (current.current.recovery) return { ok: false, message: 'Restore or discard the development recovery copy, then add the reference again.' };
    const entry = FILMCRAFT_CATALOG.entries.find(item => item.id === request.entryId);
    if (!entry) return { ok: false, message: 'That reference is not in the installed catalog.' };
    const result = appendFilmcraftResearch(current.current.data, entry);
    if (result.error) return { ok: false, message: result.error };
    const message = result.added ? `Added “${entry.title}” to research. Save development when ready.` : `“${entry.title}” is already in research.`;
    update({ ...current.current, data: result.data, notice: message, error: '' }); setTab('world');
    return { ok: true, message };
  } }), [projectId, draftId, recoveryLoaded, update]);

  const clearSavedRecovery = async (recoveryCutoff: number) => {
    await drainDisk();
    const copy = diskCopy.current;
    // A quick explicit save can cancel a queued recovery write. Retire every
    // known earlier copy from this editing session, even if it predates the
    // saved text; retain edits that arrived while the save was in flight.
    if (!current.current.recovery && copy && Date.parse(copy.savedAt) <= recoveryCutoff) {
      try {
        const result = await localApi.developmentRecovery.remove(draftId, copy.savedAt);
        if (result.deleted && diskCopy.current === copy) diskCopy.current = null;
      } catch (cause) { if (mounted.current) setDiskWarning(`Development saved, but recovery cleanup failed: ${cause instanceof Error ? cause.message : 'unavailable'}`); }
    }
  };

  const save = async () => {
    const value = current.current;
    if (!recoveryLoaded || working.current || value.recovery || (value.conflict && !value.pending) || (!isDirty(value) && value.saved && !value.pending)) return;
    let input: DevelopmentSave;
    try { input = value.pending ?? developmentSave(value.data, value.saved?.version ?? null); }
    catch (error) { update({ ...value, error: (error as Error).message }); return; }
    working.current = true; setBusy(true);
    update({ ...value, pending: input, error: '', notice: '' });
    const recoveryCutoff = lastRecoveryTime.current;
    try {
      const record = await localApi.save(input);
      if (!isDevelopmentRecord(record, projectId, draftId)) throw new LocalApiError('The saved development could not be verified. Retry this save.', 502, 'SAVE_UNCONFIRMED');
      if (!mounted.current) return; // The saved pending request remains replayable on reopening.
      const now = current.current;
      const newer = [now.saved, now.latest].filter((item): item is DevelopmentRecord => !!item && item.version > record.version).sort((a, b) => b.version - a.version)[0] ?? null;
      // Never set data to the response: the owner may have typed since clicking Save.
      update({ ...now, saved: record, pending: null, conflict: !!newer, latest: newer, error: '', notice: `Saved v${record.version}.` });
      try { onSaved(record); } catch { update({ ...current.current, error: 'Development was saved, but the workspace could not refresh. Reload the workspace to refresh its list.' }); }
      await clearSavedRecovery(recoveryCutoff);
    } catch (error) {
      if (!mounted.current) return;
      const code = error instanceof LocalApiError ? error.code : '';
      const conflict = code === 'VERSION_CONFLICT' || code === 'REQUEST_ID_CONFLICT';
      const uncertain = !(error instanceof LocalApiError) || error.status === 0 || error.status >= 500;
      const message = conflict ? 'Development changed elsewhere. Your edits are still here. Review the latest saved version before saving again.'
        : code === 'STORY_DEVELOPMENT_DRAFT_UNKNOWN' ? 'Save the screenplay draft once before saving its development. Your notes are kept here.'
          : error instanceof Error ? error.message : 'Development could not be saved.';
      update({ ...current.current, pending: uncertain ? input : null, conflict: conflict || current.current.conflict, error: message });
    } finally { working.current = false; if (mounted.current) setBusy(false); }
  };
  const saveRef = useRef(save); saveRef.current = save;
  useEffect(() => {
    if (!active) return;
    const key = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's' && !event.shiftKey) { event.preventDefault(); void saveRef.current(); }
    };
    const command = (event: Event) => { if ((event as CustomEvent<string>).detail === 'save') void saveRef.current(); };
    window.addEventListener('keydown', key); window.addEventListener('writer:command', command);
    return () => { window.removeEventListener('keydown', key); window.removeEventListener('writer:command', command); };
  }, [active]);

  const discardRecovery = async () => {
    try {
      await drainDisk();
      const copy = diskCopy.current;
      if (copy) await localApi.developmentRecovery.remove(draftId, copy.savedAt);
      if (diskCopy.current === copy) diskCopy.current = null;
      update({ ...current.current, recovery: null, notice: 'Recovery discarded.' });
    } catch (cause) { setDiskWarning(`Recovery was retained: ${cause instanceof Error ? cause.message : 'could not discard it'}`); }
  };

  const reviewLatest = async () => {
    if (working.current) return;
    working.current = true; setBusy(true);
    try {
      const history = await localApi.history(developmentId(draftId));
      const latest = history[history.length - 1];
      if (!isDevelopmentRecord(latest, projectId, draftId)) throw new Error('No valid saved development was found. Your edits are unchanged.');
      if (mounted.current) update({ ...current.current, latest, error: '' });
    } catch (error) { if (mounted.current) update({ ...current.current, error: error instanceof Error ? error.message : 'Could not load saved development.' }); }
    finally { working.current = false; if (mounted.current) setBusy(false); }
  };

  const restore = () => {
    const value = current.current;
    if (!value.recovery) return;
    const copy = value.recovery;
    const changed = copy.baseVersion !== (value.saved?.version ?? null) || copy.baseSha256 !== (value.saved?.sha256 ?? null);
    update({ ...value, data: cloneDevelopment(copy.data), pending: copy.pendingSave, recovery: null, conflict: changed || value.conflict, notice: 'Recovery restored. Save when ready.', error: '' });
  };

  const exportData = (data: DevelopmentData, format: 'json' | 'md', suffix = '') => {
    try {
      downloadText(`story-development-${draftId.slice('screenplay-draft:'.length)}${suffix}.${format}`, format === 'json' ? JSON.stringify(data, null, 2) + '\n' : developmentMarkdown(data), format === 'json' ? 'application/json;charset=utf-8' : 'text/markdown;charset=utf-8');
    } catch { update({ ...current.current, error: 'Download failed. Your text is still here; try again.' }); }
  };

  const remove = (key: 'beats' | 'characters' | 'researchNotes', id: string) => {
    const before = current.current.data;
    const after = { ...before, [key]: before[key].filter(item => item.id !== id) };
    setRemoved({ before, after: canonicalJson(after) }); edit(after);
  };
  const moveBeat = (index: number, by: number) => {
    const beats = [...current.current.data.beats];
    if (index + by < 0 || index + by >= beats.length) return;
    [beats[index], beats[index + by]] = [beats[index + by], beats[index]];
    field('beats', beats);
  };
  const { data, saved, recovery, pending, conflict, latest, error, notice } = state;
  const dirty = isDirty(state);
  const invalid = developmentError(data, projectId, draftId);
  const status = !recoveryLoaded ? 'Checking disk recovery…' : busy ? 'Working…' : pending ? 'Save unconfirmed · retry available' : conflict ? 'Review needed' : dirty ? 'Unsaved changes' : saved ? `Saved v${saved.version}` : 'No saved development';
  const canSave = recoveryLoaded && !busy && !recovery && (!conflict || !!pending) && (!invalid || !!pending) && (dirty || !saved || !!pending);
  useEffect(() => { onWorldChange?.(data.world); }, [data.world, onWorldChange]);
  useEffect(() => { if (focusElement) { setWorldTab('draft-world'); setWorldOpened(true); } }, [focusElement]);
  useEffect(() => { onStateChange?.({ dirty: dirty || !!pending || !!recovery, canSave, status }); }, [dirty, pending, recovery, canSave, status, onStateChange]);

  return (
    <section aria-labelledby={headingId} data-development-dirty={dirty || !!pending || !!recovery} className={`flex min-h-0 min-w-0 flex-col text-sm${view === 'world' ? ' world-development' : ''}`} onKeyDown={event => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's' && !event.shiftKey) { event.preventDefault(); event.stopPropagation(); void save(); }
    }}>
      <header className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-3">
        <div className="min-w-0 flex-1"><h2 id={headingId} className="font-semibold tracking-tight">{view === 'world' ? 'World Builder' : 'Story development'}</h2><p className="mt-0.5 text-xs text-muted-foreground">{view === 'world' ? 'The people, places and logic of your story · saved with development' : 'Notes for this draft · saved locally'}</p></div>
        <span role="status" className="text-xs text-muted-foreground">{status}</span>
        <Button type="button" size="sm" onClick={() => void save()} disabled={!recoveryLoaded || busy || !!recovery || (conflict && !pending) || (!!invalid && !pending) || (!dirty && !!saved && !pending)}><Save className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />{pending && !busy ? 'Retry save' : 'Save development'}</Button>
      </header>

      <div className="min-h-0 overflow-y-auto px-4 py-3">
        {storageWarning && <p role="alert" className="mb-3 rounded-md border border-border p-3 text-xs">Browser recovery is unavailable. Keep this panel open and save or export your notes before leaving.</p>}
        {diskWarning && <div className="mb-3 space-y-2 rounded-md border border-border p-3 text-xs"><p role="alert">{diskWarning} Save development before closing if disk recovery is unavailable.</p><Button type="button" size="sm" variant="outline" disabled={!recoveryLoaded || busy} onClick={() => setRecoveryCheck(value => value + 1)}>Retry disk recovery check</Button></div>}
        {recovery && <div className="mb-3 space-y-2 rounded-md border border-border bg-muted/30 p-3" role="region" aria-label="Development recovery">
          <p className="font-medium">Unsaved development was found</p><p className="text-xs text-muted-foreground">Restore it to continue, or download a copy before discarding it.</p>
          <div className="flex flex-wrap gap-2"><Button size="sm" type="button" disabled={!recoveryLoaded} onClick={restore}>Restore recovery</Button><Button size="sm" variant="outline" type="button" onClick={() => exportData(recovery.data, 'json', '-recovery')}>Export recovery</Button><Button size="sm" variant="ghost" type="button" disabled={!recoveryLoaded} onClick={() => void discardRecovery()}>Discard recovery</Button></div>
        </div>}
        {error && <p role="alert" className="mb-3 text-sm text-destructive">{error}</p>}
        {invalid && <p role="alert" className="mb-3 text-sm text-destructive">{invalid}</p>}
        {notice && <p className="mb-3 text-xs text-muted-foreground" role="status">{notice}{dirty && saved ? ' Newer edits still need saving.' : ''}</p>}
        {conflict && <div className="mb-3 space-y-3 border-l-2 border-primary bg-muted/30 p-3" aria-label="Development conflict" role="region">
          <p>Your edits are preserved. Review the saved version before choosing the next revision.</p>
          <Button type="button" size="sm" variant="outline" disabled={busy || !!pending || !!recovery} onClick={() => void reviewLatest()}>Review latest saved</Button>
          {latest && <>
            <details><summary className="cursor-pointer font-medium">Saved v{latest.version} · read development</summary><pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded bg-background p-3 font-sans text-xs">{developmentMarkdown(latest.data)}</pre></details>
            <p className="text-xs text-muted-foreground">Keeping your edits uses v{latest.version} as the save base. Your next save replaces its development fields; earlier versions remain in history.</p>
            <div className="flex flex-wrap gap-2"><Button type="button" size="sm" disabled={busy || !!pending || !!recovery} onClick={() => update({ ...current.current, saved: latest, latest: null, conflict: false, error: '', notice: 'Your edits are ready to save against the reviewed version.' })}>Keep my edits against v{latest.version}</Button><Button type="button" size="sm" variant="ghost" onClick={() => exportData(latest.data, 'json', `-v${latest.version}`)}>Export saved version</Button></div>
          </>}
        </div>}
        {removed && canonicalJson(data) === removed.after && <div className="mb-2 flex items-center gap-2 text-xs"><span>Item removed from this working copy.</span><Button type="button" variant="ghost" size="sm" disabled={!!recovery} onClick={() => { edit(removed.before); setRemoved(null); }}>Undo removal</Button></div>}

        <fieldset hidden={view !== 'world'} disabled={!recoveryLoaded || !!recovery} className="min-w-0 border-0 p-0">
          <legend className="sr-only">World builder</legend>
          <Tabs value={worldTab} onValueChange={value => { setWorldTab(value); if (value === 'shared-worlds') setLibraryOpened(true); }}>
            <TabsList aria-label="World workspaces" className="mb-2"><TabsTrigger value="draft-world">Draft world</TabsTrigger><TabsTrigger value="shared-worlds">Shared library</TabsTrigger></TabsList>
            <TabsContent value="draft-world" forceMount hidden={worldTab !== 'draft-world'}>
              {(worldOpened || view === 'world') && <WorldBuilder focusElement={focusElement} world={data.world ?? createWorld()} notes={data.worldNotes} onNotes={value => field('worldNotes', value)} onChange={world => edit(withDevelopmentWorld(current.current.data, world))} context={worldContext ?? { scenes: [], characters: [], locations: [], ambiguousScenes: 0 }} characters={data.characters} onJump={onJump} onBrowseFilmcraft={onBrowseFilmcraft} />}
            </TabsContent>
            <TabsContent value="shared-worlds" forceMount hidden={worldTab !== 'shared-worlds'}>
              {libraryOpened && <SharedWorldLibrary ref={sharedLibrary} onOpenDraft={onOpenDraft} projectId={projectId} draftId={draftId} worldSources={data.worldSources ?? []} onLinkedImport={(world, notes, worldSources) => {
                if (!recoveryLoaded || current.current.recovery) return 'Restore or discard development recovery before updating a linked world.';
                const next: DevelopmentData = { ...current.current.data, schemaVersion: 3, world, worldNotes: notes, worldSources };
                const problem = developmentError(next, projectId, draftId);
                if (problem) return `Nothing was changed. ${problem}`;
                edit(next); return null;
              }} world={data.world ?? createWorld()} notes={data.worldNotes} disabled={!recoveryLoaded || !!recovery} onEditDraft={() => setWorldTab('draft-world')} onImport={(world, notes) => {
                if (!recoveryLoaded || current.current.recovery) return 'Restore or discard development recovery before importing a shared world.';
                const next = withDevelopmentWorld(current.current.data, world, notes);
                const problem = developmentError(next, projectId, draftId);
                if (problem) return `Nothing was copied. ${problem}`;
                edit(next); return null;
              }} />}
            </TabsContent>
          </Tabs>
        </fieldset>
        <div hidden={view !== 'develop'}><Tabs value={tab} onValueChange={setTab}>
          <TabsList aria-label="Development sections" className="grid h-auto w-full grid-cols-2 gap-1 sm:grid-cols-4">
            <TabsTrigger value="story">Concept</TabsTrigger><TabsTrigger value="outline">Outline & beats</TabsTrigger><TabsTrigger value="characters">Characters</TabsTrigger><TabsTrigger value="world">World & research</TabsTrigger>
          </TabsList>
          <fieldset disabled={!recoveryLoaded || !!recovery} className="min-w-0 border-0 p-0">
            <legend className="sr-only">Development notes</legend>
            <TabsContent value="story" className="space-y-4 pt-3">
              {onBrowseFilmcraft && <ReferenceLink label="Story concepts" onClick={() => onBrowseFilmcraft({ category: 'story' })} />}
              <TextField label="Concept" value={data.concept} limit={limits.concept} rows={3} onChange={value => field('concept', value)} />
              <TextField label="Logline" value={data.logline} limit={limits.logline} rows={2} onChange={value => field('logline', value)} />
              <TextField label="Synopsis" value={data.synopsis} limit={limits.synopsis} rows={7} onChange={value => field('synopsis', value)} />
            </TabsContent>
            <TabsContent value="outline" className="space-y-4 pt-3">
              {onBrowseFilmcraft && <ReferenceLink label="Structure & pacing" onClick={() => onBrowseFilmcraft({ query: 'structure', category: 'story' })} />}
              <TextField label="Outline" value={data.outline} limit={limits.outline} rows={6} onChange={value => field('outline', value)} />
              <ListHeader title="Beats" count={data.beats.length} limit={limits.beats} addLabel="Add beat" onAdd={() => field('beats', [...data.beats, newDevelopmentBeat()])} />
              {!data.beats.length && <Empty>No beats yet. Add them in the order your story needs.</Empty>}
              {data.beats.map((beat, index) => <fieldset key={beat.id} className="min-w-0 space-y-3 border-t border-border pt-3">
                <legend className="sr-only">Beat {index + 1}</legend>
                <div className="flex items-center gap-2"><span className="mr-auto text-xs font-medium text-muted-foreground">BEAT {String(index + 1).padStart(2, '0')}</span><IconButton label={`Move beat ${index + 1} up`} disabled={index === 0} onClick={() => moveBeat(index, -1)}><ArrowUp /></IconButton><IconButton label={`Move beat ${index + 1} down`} disabled={index === data.beats.length - 1} onClick={() => moveBeat(index, 1)}><ArrowDown /></IconButton><IconButton label={`Remove beat ${index + 1}`} onClick={() => remove('beats', beat.id)}><Trash2 /></IconButton></div>
                <TextField label={`Beat ${index + 1} title`} compact value={beat.title} limit={limits.title} onChange={value => field('beats', data.beats.map(item => item.id === beat.id ? { ...item, title: value } : item))} />
                <TextField label={`Beat ${index + 1} description`} value={beat.description} limit={limits.description} rows={3} onChange={value => field('beats', data.beats.map(item => item.id === beat.id ? { ...item, description: value } : item))} />
              </fieldset>)}
            </TabsContent>
            <TabsContent value="characters" className="space-y-4 pt-3">
              {onBrowseFilmcraft && <ReferenceLink label="Character & motivation" onClick={() => onBrowseFilmcraft({ query: 'character', category: 'story' })} />}
              <ListHeader title="Characters" count={data.characters.length} limit={limits.characters} addLabel="Add character" onAdd={() => field('characters', [...data.characters, newDevelopmentCharacter()])} />
              {!data.characters.length && <Empty>No characters yet. Add one when you are ready.</Empty>}
              {data.characters.map((character, index) => <fieldset key={character.id} className="min-w-0 space-y-3 border-t border-border pt-3">
                <legend className="sr-only">Character {index + 1}</legend><div className="flex items-center justify-between"><span className="text-xs font-medium text-muted-foreground">CHARACTER {String(index + 1).padStart(2, '0')}</span><IconButton label={`Remove character ${index + 1}`} onClick={() => remove('characters', character.id)}><Trash2 /></IconButton></div>
                {(['name', 'role', 'description', 'arc'] as const).map(key => <TextField key={key} label={`Character ${index + 1} ${key}`} compact={key === 'name' || key === 'role'} value={character[key]} limit={key === 'description' ? limits.characterNotes : limits[key]} rows={3} onChange={value => field('characters', data.characters.map(item => item.id === character.id ? { ...item, [key]: value } : item))} />)}
              </fieldset>)}
            </TabsContent>
            <TabsContent value="world" className="space-y-4 pt-3">
              {onBrowseFilmcraft && <ReferenceLink label="World, image & setting" onClick={() => onBrowseFilmcraft({ category: 'image' })} />}
              <TextField label="World notes" value={data.worldNotes} limit={limits.worldNotes} rows={6} onChange={value => field('worldNotes', value)} />
              <ListHeader title="Research notes" count={data.researchNotes.length} limit={limits.researchNotes} addLabel="Add research note" onAdd={() => field('researchNotes', [...data.researchNotes, newDevelopmentResearchNote()])} />
              {!data.researchNotes.length && <Empty>Keep research and its sources beside the story.</Empty>}
              {data.researchNotes.map((note, index) => <fieldset key={note.id} className="min-w-0 space-y-3 border-t border-border pt-3">
                <legend className="sr-only">Research note {index + 1}</legend><div className="flex items-center justify-between"><span className="text-xs font-medium text-muted-foreground">RESEARCH {String(index + 1).padStart(2, '0')}</span><IconButton label={`Remove research note ${index + 1}`} onClick={() => remove('researchNotes', note.id)}><Trash2 /></IconButton></div>
                {(['title', 'notes', 'source'] as const).map(key => <TextField key={key} label={`Research ${index + 1} ${key}`} compact={key === 'title'} value={note[key]} limit={limits[key]} rows={key === 'source' ? 2 : 4} onChange={value => field('researchNotes', data.researchNotes.map(item => item.id === note.id ? { ...item, [key]: value } : item))} />)}
              </fieldset>)}
            </TabsContent>
          </fieldset>
        </Tabs></div>
        <footer className="mt-5 flex flex-wrap items-center gap-2 border-t border-border pt-3 text-xs text-muted-foreground"><span className="mr-auto">Export includes your current edits.</span><Button type="button" variant="ghost" size="sm" onClick={() => exportData(data, 'json')}>Export JSON</Button><Button type="button" variant="ghost" size="sm" onClick={() => exportData(data, 'md')}>Export Markdown</Button></footer>
      </div>
    </section>
  );
});

function ReferenceLink({ label, onClick }: { label: string; onClick: () => void }) {
  return <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground"><span>Film language reference</span><Button type="button" variant="link" className="h-auto p-0 text-xs" onClick={onClick}>{label}</Button></div>;
}

function TextField({ label, value, limit, rows = 3, compact = false, onChange }: { label: string; value: string; limit: number; rows?: number; compact?: boolean; onChange: (value: string) => void }) {
  const id = useId();
  return <div className="space-y-1.5"><div className="flex items-baseline justify-between gap-3"><label htmlFor={id} className="font-medium">{label}</label><span id={`${id}-count`} className="shrink-0 text-[11px] tabular-nums text-muted-foreground">{value.length.toLocaleString()} / {limit.toLocaleString()}</span></div>{compact ? <Input id={id} value={value} aria-describedby={`${id}-count`} maxLength={limit} onChange={event => onChange(event.target.value)} /> : <Textarea id={id} value={value} aria-describedby={`${id}-count`} maxLength={limit} rows={rows} className="min-h-0 resize-y leading-relaxed" onChange={event => onChange(event.target.value)} />}</div>;
}
function ListHeader({ title, count, limit, addLabel, onAdd }: { title: string; count: number; limit: number; addLabel: string; onAdd: () => void }) {
  return <div className="flex items-center justify-between gap-2"><h3 className="font-medium">{title} <span className="ml-1 text-xs font-normal text-muted-foreground">{count} / {limit}</span></h3><Button type="button" size="sm" variant="outline" disabled={count >= limit} onClick={onAdd}><Plus className="mr-1 h-3.5 w-3.5" aria-hidden="true" />{addLabel}</Button></div>;
}
function IconButton({ label, disabled = false, onClick, children }: { label: string; disabled?: boolean; onClick: () => void; children: React.ReactNode }) {
  return <Button type="button" variant="ghost" size="sm" className="h-8 w-8 p-2 [&>svg]:h-4 [&>svg]:w-4" aria-label={label} title={label} disabled={disabled} onClick={onClick}><span aria-hidden="true" className="[&>svg]:h-4 [&>svg]:w-4">{children}</span></Button>;
}
function Empty({ children }: { children: React.ReactNode }) {
  return <p className="py-5 text-center text-xs text-muted-foreground">{children}</p>;
}
