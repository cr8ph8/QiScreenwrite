import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { localApi } from '../api';
import { canonicalJson, downloadText } from '../model';
import { RIGHTS_ID, MAX_EVIDENCE_BYTES, defaultParticipation, newRightsId, parseSharePercent, recordRef, sameRef, validateWriterParticipation, type EvidenceData, type ProjectParticipation, type RightsRecovery, type TokenDraftData } from '../rights';
import type { LocalProject, RecordInput, WorkspaceRecord } from '../types';
import { RightsField, RightsSection, RightsSnapshot } from './RightsFields';
import { RightsEditor } from './RightsEditor';
import { RightsTokenPreparation } from './RightsTokenPreparation';
import './rights.css';

interface Props { project: LocalProject; records: WorkspaceRecord[]; onSaved: (record: WorkspaceRecord) => void; onRefresh: () => Promise<void>; active: boolean }
type Ledger = WorkspaceRecord<ProjectParticipation>;
type ReviewData = { schemaVersion: 1; projectId: string; status: 'LOCAL_REVIEW'; participationRef: ReturnType<typeof recordRef>; note: string; actor: 'local-owner' };
type RecoveryHost = Window & { __flushRightsRecovery?: () => Promise<void> };
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value));
const errorText = (error: unknown) => error instanceof Error ? error.message : 'The local operation could not be completed.';
const subjectKinds = ['screenplay-draft', 'story-development', 'shared-world', 'rights-evidence', 'source-document'];
const isLedger = (record: WorkspaceRecord): record is Ledger => record.id === RIGHTS_ID && record.kind === 'project-participation';
function moneyInput(value: string) {
  if (!value.trim()) return null;
  if (!/^(0|[1-9]\d*)(\.\d{1,2})?$/.test(value)) throw new Error('Use a nonnegative amount with up to two decimal places, or leave unknown.');
  const [whole, fraction = ''] = value.split('.');
  const minor = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  if (minor > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('This amount is too large.');
  return Number(minor);
}

/** The workspace remains mounted when its navigation item is inactive. */
export function RightsPanel(props: Props) { return <RightsWorkspace key={props.project.id} {...props} />; }

function RightsWorkspace({ project, records, onSaved, onRefresh, active }: Props) {
  const initial = records.find(isLedger);
  const [base, setBase] = useState<Ledger | undefined>(initial);
  const [editing, setEditing] = useState<ProjectParticipation>(() => clone(initial?.data ?? defaultParticipation(project)));
  const [tokenDirty, setTokenDirty] = useState(false);
  const [numbers, setNumbers] = useState<Record<string, string>>({});
  const [retained, setRetained] = useState<WorkspaceRecord[]>([]);
  const [pending, setPending] = useState<RecordInput<ProjectParticipation> | null>(null);
  const [loaded, setLoaded] = useState(false), [loadAttempt, setLoadAttempt] = useState(0);
  const [recovery, setRecovery] = useState<RightsRecovery | null>(null), [reviewRecovery, setReviewRecovery] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState<'editing' | 'recovery' | null>(null);
  const [busy, setBusy] = useState(''), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [recoveryError, setRecoveryError] = useState(''), [recoveredKey, setRecoveredKey] = useState('');
  const [conflict, setConflict] = useState(false), [history, setHistory] = useState<Ledger[] | null>(null);
  const [reviewNote, setReviewNote] = useState(''), [reviewPending, setReviewPending] = useState<RecordInput<ReviewData> | null>(null);
  const working = useRef(false), mounted = useRef(true), recoveryQueue = useRef<Promise<void>>(Promise.resolve());
  const retainedRecovery = useRef<RightsRecovery | null>(null), lastRecoveryKey = useRef('');
  const pendingRef = useRef(pending); pendingRef.current = pending;
  const allRecords = useMemo(() => {
    const byId = new Map<string, WorkspaceRecord>();
    for (const row of [...retained, ...records]) {
      if ((row.data as { projectId?: string })?.projectId !== project.id) continue;
      if (!byId.has(row.id) || byId.get(row.id).version <= row.version) byId.set(row.id, row);
    }
    return [...byId.values()];
  }, [records, retained, project.id]);
  const latest = allRecords.find(isLedger);
  const subjects = allRecords.filter(row => subjectKinds.includes(row.kind));
  const evidence = allRecords.filter(row => row.kind === 'rights-evidence') as WorkspaceRecord<EvidenceData>[];
  const tokens = allRecords.filter(row => row.kind === 'token-preparation') as WorkspaceRecord<TokenDraftData>[];
  const reviews = allRecords.filter(row => row.kind === 'rights-review') as WorkspaceRecord<ReviewData>[];
  const candidate = useMemo(() => {
    const data = clone(editing), errors: string[] = [];
    for (const pool of data.pools) {
      for (const row of pool.allocations) if (Object.hasOwn(numbers, row.id)) {
        try { row.shareBps = parseSharePercent(numbers[row.id]); } catch (cause) { errors.push(errorText(cause)); }
      }
      for (const field of ['receiptsMinor', 'deductionsMinor', 'recoupmentMinor'] as const) if (Object.hasOwn(numbers, `${pool.id}:${field}`)) {
        try { pool[field] = moneyInput(numbers[`${pool.id}:${field}`]); } catch (cause) { errors.push(errorText(cause)); }
      }
    }
    try { validateWriterParticipation(data, project); } catch (cause) { errors.push(errorText(cause)); }
    return { data, errors: [...new Set(errors)] };
  }, [editing, numbers, project]);
  const draftKey = canonicalJson(candidate.data);
  const dirty = candidate.errors.length > 0 || draftKey !== canonicalJson(base?.data ?? defaultParticipation(project));
  const stale = !!latest !== !!base || !!latest && !!base && !sameRef(recordRef(base), latest);
  const sourceErrors = [...candidate.data.contributions, ...candidate.data.rights, ...candidate.data.pools].some(row => row.subject.kind === 'RECORD' && !sameRef(row.subject.recordRef, subjects.find(item => item.id === row.subject.recordRef.id)));
  const missingEvidence = [...candidate.data.contributions, ...candidate.data.rights, ...candidate.data.pools.flatMap(pool => pool.allocations)].some(row => row.evidenceHashes.some(hash => !evidence.some(item => item.data.sha256 === hash)));
  const boundRecovery = recovery && recovery.baseVersion === (latest?.version ?? null) && recovery.baseSha256 === (latest?.sha256 ?? null);
  const blocked = !!busy || !loaded || !!recovery || !!pending;
  const savedActionsDisabled = blocked || dirty || stale || conflict || !base;
  const recoveryKey = canonicalJson({ baseVersion: base?.version ?? null, baseSha256: base?.sha256 ?? null, data: candidate.data, pendingSave: pending });
  const auxiliaryDirty = tokenDirty || !!reviewNote || !!reviewPending;
  const snapshot = useRef({ loaded, recovery, dirty, candidate, base, recoveryKey, auxiliaryDirty });
  snapshot.current = { loaded, recovery, dirty, candidate, base, recoveryKey, auxiliaryDirty };
  const latestRef = useRef(latest); latestRef.current = latest;
  const callbacks = useRef({ onSaved, onRefresh }); callbacks.current = { onSaved, onRefresh };

  const acceptRecord = (record: WorkspaceRecord) => {
    setRetained(rows => [...rows.filter(row => row.id !== record.id), record]);
    callbacks.current.onSaved(record);
  };
  const enqueue = (operation: () => Promise<void>) => {
    const next = recoveryQueue.current.catch(() => undefined).then(operation);
    recoveryQueue.current = next;
    return next;
  };
  const persist = (copy: Omit<RightsRecovery, 'savedAt'>, key: string) => enqueue(async () => {
    if (lastRecoveryKey.current === key) return;
    const savedAt = new Date(Math.max(Date.now(), Date.parse(retainedRecovery.current?.savedAt ?? '') + 1 || 0)).toISOString();
    const stored = await localApi.rights.recovery.put({ ...copy, savedAt });
    retainedRecovery.current = stored; lastRecoveryKey.current = key;
    if (mounted.current) { setRecoveredKey(key); setRecoveryError(''); }
  });
  const flush = async () => {
    const value = snapshot.current;
    if (value.auxiliaryDirty) throw new Error('Unsaved token preparation or review notes are not recovered. Save or discard those edits before quitting.');
    if (!value.loaded || value.recovery) {
      if (value.dirty || pendingRef.current) throw new Error('Review local recovery before closing with unsaved rights edits.');
      await recoveryQueue.current; return;
    }
    if (!value.dirty && !pendingRef.current) { await recoveryQueue.current; return; }
    if (value.candidate.errors.length) throw new Error('Current edits are invalid and have not been recovered. Fix the highlighted fields or explicitly save a valid draft.');
    await persist({ schemaVersion: 1, projectId: project.id, baseVersion: value.base?.version ?? null, baseSha256: value.base?.sha256 ?? null, data: clone(value.candidate.data), pendingSave: pendingRef.current }, canonicalJson({ baseVersion: value.base?.version ?? null, baseSha256: value.base?.sha256 ?? null, data: value.candidate.data, pendingSave: pendingRef.current }));
  };
  const flushRef = useRef(flush); flushRef.current = flush;
  const clearRecovery = () => enqueue(async () => {
    if (retainedRecovery.current) await localApi.rights.recovery.clear(retainedRecovery.current.savedAt);
    retainedRecovery.current = null; lastRecoveryKey.current = '';
    if (mounted.current) { setRecoveredKey(''); setRecoveryError(''); }
  });
  useEffect(() => {
    mounted.current = true;
    const host = window as RecoveryHost;
    const handler = () => flushRef.current();
    host.__flushRightsRecovery = handler;
    const unload = (event: BeforeUnloadEvent) => {
      if (snapshot.current.dirty || pendingRef.current || snapshot.current.auxiliaryDirty) {
        void handler().catch(() => undefined);
        event.preventDefault(); event.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', unload);
    return () => {
      mounted.current = false;
      window.removeEventListener('beforeunload', unload);
      if (host.__flushRightsRecovery === handler) delete host.__flushRightsRecovery;
      void handler().catch(() => undefined);
    };
  }, []);
  useEffect(() => {
    let cancelled = false;
    setLoaded(false); setRecoveryError('');
    void localApi.rights.recovery.get().then(copy => {
      if (cancelled) return;
      if (copy) {
        validateWriterParticipation(copy.data, project);
        if (copy.projectId !== project.id || copy.schemaVersion !== 1) throw new Error('The recovery copy belongs to a different workspace.');
      }
      retainedRecovery.current = copy;
      setRecovery(copy); setReviewRecovery(false); setLoaded(true);
    }).catch(cause => { if (!cancelled) setRecoveryError(`Recovery could not be loaded: ${errorText(cause)}`); });
    return () => { cancelled = true; };
    // Project identity remounts this workspace; refreshed project objects must not reset recovery.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id, loadAttempt]);
  useEffect(() => {
    if (!loaded || recovery || !dirty || candidate.errors.length || pending) return;
    const timer = window.setTimeout(() => { void flushRef.current().catch(cause => { if (mounted.current) setRecoveryError(errorText(cause)); }); }, 650);
    return () => window.clearTimeout(timer);
  }, [loaded, recovery, dirty, recoveryKey, candidate.errors.length, pending]);
  const run = async (mode: string, action: () => Promise<void>) => {
    if (working.current) return;
    working.current = true; setBusy(mode); setError(''); setNotice('');
    try { await action(); }
    catch (cause) { if (mounted.current) setError(errorText(cause)); }
    finally { working.current = false; if (mounted.current) setBusy(''); }
  };
  const save = (recovered?: RightsRecovery) => run('save', async () => {
    let input = recovered?.pendingSave ?? pendingRef.current;
    const saveBase = recovered ? { version: recovered.baseVersion, sha256: recovered.baseSha256 } : { version: base?.version ?? null, sha256: base?.sha256 ?? null };
    if (!input) {
      if (stale || conflict) throw new Error('Saved rights changed. Review the latest saved revision before replacing your edits.');
      if (candidate.errors.length || sourceErrors || missingEvidence) throw new Error('Fix invalid fields and reselect changed or missing sources before saving.');
      input = { id: RIGHTS_ID, kind: 'project-participation', expectedVersion: base?.version ?? null, requestId: newRightsId('request'), data: clone(candidate.data) };
    }
    pendingRef.current = input; setPending(input);
    const copy = { schemaVersion: 1 as const, projectId: project.id, baseVersion: saveBase.version, baseSha256: saveBase.sha256, data: input.data, pendingSave: input };
    await persist(copy, canonicalJson({ baseVersion: copy.baseVersion, baseSha256: copy.baseSha256, data: copy.data, pendingSave: input }));
    let saved: Ledger;
    try { saved = await localApi.save(input); }
    catch (cause) {
      if (mounted.current && ['VERSION_CONFLICT', 'REQUEST_ID_CONFLICT'].includes((cause as { code?: string })?.code)) setConflict(true);
      throw cause;
    }
    pendingRef.current = null;
    if (mounted.current) {
      setPending(null); setBase(saved); setEditing(clone(saved.data)); setNumbers({}); setConflict(false); setRecovery(null); setReviewRecovery(false);
      acceptRecord(saved); setNotice(`Rights draft saved · revision ${saved.version}.`);
      setHistory(null);
    }
    try { await clearRecovery(); }
    catch (cause) { if (mounted.current) setRecoveryError(`Draft saved, but recovery cleanup failed: ${errorText(cause)}. Reopen recovery to review it.`); }
  });
  const discard = () => run('discard', async () => {
    if (confirmDiscard === 'recovery') {
      await clearRecovery();
      if (mounted.current) { setRecovery(null); setReviewRecovery(false); setConfirmDiscard(null); setPending(null); pendingRef.current = null; setConflict(false); setNotice('Recovery copy and its pending retry discarded.'); }
      return;
    }
    const versions = await localApi.history(RIGHTS_ID) as Ledger[];
    const current = versions.at(-1);
    await clearRecovery();
    if (!mounted.current) return;
    setBase(current); setEditing(clone(current?.data ?? defaultParticipation(project))); setNumbers({}); setPending(null); pendingRef.current = null;
    setConflict(false); setConfirmDiscard(null); setHistory(versions); setRecovery(null);
    if (current) acceptRecord(current);
    setNotice('Latest saved rights loaded. Local edits and their pending retry were discarded.');
  });
  const upload = (file: File) => run('evidence', async () => {
    if (!file.size || file.size > MAX_EVIDENCE_BYTES) throw new Error('Choose a nonempty evidence file no larger than 1 MiB.');
    const supported = ['application/pdf', 'text/plain', 'image/png', 'image/jpeg', 'application/octet-stream'];
    const mediaType = file.type || 'application/octet-stream';
    if (!supported.includes(mediaType)) throw new Error('Use a PDF, text file, PNG, JPEG or binary evidence file.');
    const base64 = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader(); reader.onerror = () => reject(new Error('The evidence file could not be read.'));
      reader.onload = () => resolve(String(reader.result).split(',')[1]); reader.readAsDataURL(file);
    });
    const saved = await localApi.rights.attachEvidence({ name: file.name, mediaType, base64 });
    if (mounted.current) { acceptRecord(saved); setNotice('Evidence retained locally. Choose its attachment checkbox on the relevant contribution, right or allocation.'); }
  });
  const recordReview = () => run('review', async () => {
    if (!base || savedActionsDisabled) return;
    const input: RecordInput<ReviewData> = reviewPending ?? { id: newRightsId('rights-review'), kind: 'rights-review', expectedVersion: null, requestId: newRightsId('request'), data: { schemaVersion: 1, projectId: project.id, status: 'LOCAL_REVIEW', participationRef: recordRef(base), note: reviewNote, actor: 'local-owner' } };
    setReviewPending(input);
    const saved = await localApi.save(input);
    if (mounted.current) { acceptRecord(saved); setReviewPending(null); setReviewNote(''); setNotice('Local review recorded for this saved revision.'); }
  });
  return <section className="rights-view" data-rights-dirty={dirty || !!pending || auxiliaryDirty ? 'true' : 'false'} hidden={!active} aria-label="Rights & collaborators">
    <header className="rights-heading"><div><p className="lw-eyebrow">PRIVATE WORKSPACE · DRAFT</p><h1>Rights & collaborators</h1><p>{project.title} · Record contributions, claims and proposed splits.</p></div><Button variant="outline" size="sm" disabled={!!busy} onClick={() => void run('refresh', () => callbacks.current.onRefresh())}>{busy === 'refresh' ? 'Refreshing…' : 'Refresh saved records'}</Button></header>
    {error && <p role="alert" className="rights-error">{error}</p>}{notice && <p role="status" className="rights-message">{notice}</p>}
    {recoveryError && <div className="rights-error" role="alert"><p>{recoveryError}</p><Button variant="outline" size="sm" disabled={!!busy} onClick={() => { setRecovery(null); setLoadAttempt(value => value + 1); }}>Reopen recovery</Button></div>}
    {!loaded && <p className="rights-help">Checking local recovery before editing…</p>}
    {recovery && <section className="rights-recovery" aria-label="Local recovery"><h2>Local recovery available</h2><p>Recovered copy from {new Date(recovery.savedAt).toLocaleString()} · based on {recovery.baseVersion === null ? 'an unsaved draft' : `revision ${recovery.baseVersion}`}.</p><p>{boundRecovery ? 'Its saved base matches the current rights revision. Review it before resuming.' : 'Its saved base has changed. This copy will not be merged into the current draft.'}</p><div className="rights-actions"><Button size="sm" variant="outline" onClick={() => setReviewRecovery(value => !value)}>{reviewRecovery ? 'Hide recovery review' : 'Review recovered copy'}</Button><Button size="sm" variant="ghost" disabled={!!busy} onClick={() => setConfirmDiscard('recovery')}>Discard recovery</Button></div>{reviewRecovery && <><RightsSnapshot data={recovery.data} />{latest && <details><summary>Compare latest saved revision {latest.version}</summary><RightsSnapshot data={latest.data} /></details>}<div className="rights-actions"><Button size="sm" disabled={!boundRecovery || !!busy} onClick={() => {
      setEditing(clone(recovery.data)); setNumbers({}); setPending(recovery.pendingSave); pendingRef.current = recovery.pendingSave;
      // Restoring is allowed only against the exact base the editor already holds.
      if (latest) setBase(latest);
      setRecovery(null); setReviewRecovery(false); setNotice('Reviewed recovery loaded. Save explicitly to add it to saved history.');
    }}>Use reviewed recovery</Button>{recovery.pendingSave && <Button size="sm" variant="outline" disabled={!!busy} onClick={() => void save(recovery)}>Retry original save</Button>}<Button size="sm" variant="ghost" onClick={() => downloadText('PRIVATE-rights-recovery.json', JSON.stringify(recovery, null, 2), 'application/json')}>Download private recovery</Button></div>{recovery.pendingSave && <p className="rights-help">Retry original save resends its unchanged request. It does not merge with a newer revision.</p>}</>}</section>}
    {confirmDiscard && <section className="rights-recovery" role="alert"><h2>{confirmDiscard === 'editing' ? 'Discard local edits and reload?' : 'Discard this recovery copy?'}</h2><p>Saved history remains available. Unsaved edits in this copy will be removed. An unconfirmed save may already be in history.</p><div className="rights-actions"><Button size="sm" disabled={!!busy} onClick={() => void discard()}>Confirm discard</Button><Button variant="ghost" size="sm" disabled={!!busy} onClick={() => setConfirmDiscard(null)}>Keep editing</Button></div></section>}
    {(stale || conflict) && <p className="rights-error" role="alert">A newer or conflicting saved revision needs review. Your edits have been kept. Load saved history, then explicitly discard and reload when ready.</p>}
    <div className="rights-layout"><main className="rights-editor">
      <fieldset className="rights-fieldset" disabled={blocked}><RightsEditor data={candidate.data} records={subjects} evidence={evidence} numbers={numbers} onNumber={(key, value) => { setNumbers(values => ({ ...values, [key]: value })); setNotice(''); }} onChange={value => { setEditing(value); setNotice(''); }} /></fieldset>
      <RightsSection title="Evidence files" help="Retained privately on this workspace. Up to 1 MiB per file."><RightsField label="Upload evidence"><input type="file" disabled={!!busy || !loaded || !!recovery} accept=".pdf,.txt,.png,.jpg,.jpeg,.bin,application/pdf,text/plain,image/png,image/jpeg,application/octet-stream" onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void upload(file); }} /></RightsField>{evidence.map(row => <div className="rights-evidence-row" key={row.id}><strong>{row.data.name}</strong><span>{Math.ceil(row.data.byteLength / 1024)} KiB</span><details><summary>File checksum</summary><code>{row.data.sha256}</code></details></div>)}<p className="rights-help">Evidence attached records that a file was supplied. It does not establish approval, consent or ownership.</p></RightsSection>
      <RightsTokenPreparation project={project} ledger={latest} subjects={subjects} tokens={tokens} disabled={savedActionsDisabled} onSaved={acceptRecord} onDirtyChange={setTokenDirty} />
    </main><aside className="rights-inspector" aria-label="Save and review">
      <RightsSection title="Draft status"><p className="rights-save-state">{pending ? 'Save unconfirmed' : dirty ? 'Unsaved changes' : base ? `Saved draft · revision ${base.version}` : 'New local draft'}</p><p className="rights-help">Draft entries record proposed terms. They do not grant rights or authenticate agreement.</p>{candidate.errors.length > 0 && <div className="rights-error" role="alert"><p>Current edits are invalid and are not recovered.</p><ul>{candidate.errors.map(message => <li key={message}>{message}</li>)}</ul></div>}{sourceErrors && <p className="rights-error" role="alert">A selected saved subject changed or is missing. Choose its current saved version to continue.</p>}{missingEvidence && <p className="rights-error" role="alert">An attached evidence file is unavailable. Review the attachment before saving.</p>}<div className="rights-actions"><Button disabled={!!busy || !loaded || !!recovery || (!pending && (!!candidate.errors.length || sourceErrors || missingEvidence || stale || conflict || (!dirty && !!base)))} onClick={() => void save()}>{busy === 'save' ? 'Saving…' : pending ? 'Retry same save' : 'Save rights draft'}</Button><Button size="sm" variant="ghost" disabled={!!busy || !loaded || !!recovery} onClick={() => setConfirmDiscard('editing')}>Discard edits & reload</Button></div>{pending && <p className="rights-help">Editing is paused until this exact save is acknowledged or explicitly discarded.</p>}<p className="rights-help" role="status">{candidate.errors.length ? 'Recovery paused until fields are valid.' : recoveryError ? 'Recovery needs attention.' : dirty && recoveredKey === recoveryKey ? 'Current valid edits recovered locally. Not yet saved to history.' : dirty ? 'Current edits have not yet been confirmed in recovery.' : 'No unsaved changes to recover.'}</p></RightsSection>
      <RightsSection title="Saved history"><Button variant="outline" size="sm" disabled={!!busy} onClick={() => void run('history', async () => { const rows = await localApi.history(RIGHTS_ID); if (mounted.current) setHistory(rows as Ledger[]); })}>Load saved history</Button>{history && <div className="rights-history">{!history.length && <p className="rights-empty">No saved revisions yet.</p>}{[...history].reverse().map(row => <details key={row.version}><summary>Revision {row.version} · read only</summary><RightsSnapshot data={row.data} /><code>{row.sha256}</code></details>)}</div>}</RightsSection>
      <RightsSection title="Local review" help="Record your review of a saved revision. No signer authentication."><RightsField label="Review note"><textarea rows={3} maxLength={4000} value={reviewNote} disabled={savedActionsDisabled || !!reviewPending} onChange={event => setReviewNote(event.target.value)} /></RightsField><div className="rights-actions">{reviewNote && !reviewPending && <Button variant="ghost" size="sm" disabled={!!busy} onClick={() => setReviewNote('')}>Discard review note</Button>}<Button variant="outline" size="sm" disabled={savedActionsDisabled} onClick={() => void recordReview()}>{reviewPending ? 'Retry local review' : 'Record local review'}</Button>{reviewPending && <Button variant="ghost" size="sm" disabled={!!busy} onClick={() => setReviewPending(null)}>Discard review retry</Button>}</div>{reviews.map(row => <details key={row.id}><summary>{sameRef(row.data.participationRef, latest) ? 'Current saved revision reviewed locally' : 'Review is stale · saved rights changed'}</summary><p>{row.data.note || 'No review note.'}</p><p className="rights-help">Local owner · revision {row.data.participationRef.version}. This records a local review, not assent or approval.</p></details>)}</RightsSection>
      <RightsSection title="Private worksheet" help="Includes collaborator names, claims, terms and shares. Evidence bytes are excluded."><Button variant="outline" size="sm" disabled={savedActionsDisabled} onClick={() => void run('worksheet', async () => { if (!base) return; const value = await localApi.rights.worksheet(recordRef(base)); if (!mounted.current) return; if (!sameRef(recordRef(base), latestRef.current)) throw new Error('Saved rights changed while exporting. Refresh and review the latest revision.'); downloadText('PRIVATE-rights-worksheet.json', JSON.stringify(value, null, 2), 'application/json'); setNotice('Private worksheet prepared for download. It includes names and terms.'); })}>Export PRIVATE worksheet</Button><p className="rights-help">Exports use the saved draft. Save current edits first.</p></RightsSection>
    </aside></div>
  </section>;
}
