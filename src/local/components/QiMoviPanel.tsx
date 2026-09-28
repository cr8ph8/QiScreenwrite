import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { localApi } from "../api";
import { QiMoviLibraryPanel } from './QiMoviLibraryPanel';
import { WorldReturnPanel } from './WorldReturnPanel';
import { canAuthorizeQiMoviFolder, authorizeQiMoviFolder } from "../nativeConnections";
import type { DraftRecord, LinkRecord, QiMoviInstalled, QiMoviLinkRemote, QiMoviStatus, QiMoviSummary, QiMoviWorldTransfer } from "../types";
import type { DevelopmentRecord } from '../development';
import './qimovi-universe-panel.css';

interface Props { draft: DraftRecord | null; dirty: boolean; links: LinkRecord[]; onChanged: () => Promise<void>; onOpenDraft?: (id: string) => void; development?: DevelopmentRecord | null; developmentDirty?: boolean }
type UniversePreview = Awaited<ReturnType<typeof localApi.qimovi.previewUniverse>>;
type UniverseTransfer = Awaited<ReturnType<typeof localApi.qimovi.pushUniverse>>;
type UniverseReviewState =
  | { context: string; type: 'preview'; result: UniversePreview }
  | { context: string; type: 'applied'; result: UniverseTransfer }
  | { context: string; type: 'error'; message: string; applying: boolean };
const universeActions = { create: 'Create', update: 'Update', unchanged: 'Unchanged', conflict: 'Conflict' } as const;
const universeKinds: Record<string, string> = {
  'universe-entity': 'Element',
  'universe-profile': 'Details',
  'universe-claim': 'Notes',
  'universe-link': 'Connection',
};
const universeKind = (kind: string) => universeKinds[kind] ?? kind.replace(/^universe-/, '').replaceAll('-', ' ');

/**
 * Carry drafts between this workspace and a QiMovi (Qi Movie Slate / FilmStack)
 * project. The QiMovi owner token is stored by the local service, not in the
 * page. Nothing here admits a film source or approves production.
 */
export function QiMoviPanel({ draft, dirty, links, onChanged, onOpenDraft, development, developmentDirty = false }: Props) {
  const [status, setStatus] = useState<QiMoviStatus | QiMoviSummary | null>(null);
  const [editing, setEditing] = useState(false);
  const [origin, setOrigin] = useState("http://127.0.0.1:4317");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [installed, setInstalled] = useState<QiMoviInstalled | null>(null);
  const [manual, setManual] = useState(false);
  const [worldTransfer, setWorldTransfer] = useState<QiMoviWorldTransfer | null>(null);
  const [universeReview, setUniverseReview] = useState<UniverseReviewState | null>(null);
  const universeRequest = useRef(0);
  const link = links.find((item) => item.data.target === "qimovi");
  const remote = link?.data.remote as QiMoviLinkRemote | undefined;
  const summary = status && "drafts" in status ? status : null;
  const current = status ?? { configured: false, origin: null, connected: false, project: null };
  const universeContext = JSON.stringify([
    draft?.id, draft?.version, draft?.sha256, dirty,
    development?.id, development?.version, development?.sha256, development?.data.schemaVersion,
    development?.data.draftId, developmentDirty,
    current.configured, current.connected, current.origin, current.project?.id, editing,
  ]);
  const activeUniverseContext = useRef(universeContext);
  activeUniverseContext.current = universeContext;
  const review = universeReview?.context === universeContext ? universeReview : null;
  const preview = review?.type === 'preview' ? review.result : null;
  const canPreviewUniverse = !!draft && !dirty && !developmentDirty && !!development?.data.world
    && development.data.draftId === draft.id && current.configured && !editing;
  const hasUniverseConflicts = !!preview && (preview.counts.conflicts > 0 || preview.items.some(item => item.action === 'conflict'));

  const clearUniverseReview = () => {
    universeRequest.current += 1;
    setUniverseReview(null);
  };
  useEffect(() => {
    universeRequest.current += 1;
    setUniverseReview(null);
    // A response for an earlier draft or connection must not restore its token,
    // even if the user switches back before that request completes.
    return () => { universeRequest.current += 1; };
  }, [universeContext]);

  const run = async (label: string, action: () => Promise<unknown>) => {
    clearUniverseReview();
    setBusy(label);
    setConnectionError(null);
    try { await action(); } catch (error) { const message = error instanceof Error ? error.message : `${label} failed.`; setConnectionError(message); toast.error(message); } finally { setBusy(null); }
  };
  useEffect(() => { let active = true; localApi.qimovi.status().then(value => { if (active) setStatus(value); }).catch(error => { if (active) setConnectionError(error instanceof Error ? error.message : "Could not read the local connection."); }); return () => { active = false; }; }, []);
  const transferUniverse = async (reviewed?: UniversePreview) => {
    if (!draft || !canPreviewUniverse || busy !== null) return;
    if (reviewed && (reviewed !== preview || !reviewed.token || !reviewed.items.length || hasUniverseConflicts)) return;
    clearUniverseReview();
    const request = universeRequest.current;
    const context = universeContext;
    const isCurrent = () => request === universeRequest.current && context === activeUniverseContext.current;
    setBusy(reviewed ? 'universe-apply' : 'universe-preview');
    try {
      if (reviewed) {
        const result = await localApi.qimovi.pushUniverse(draft.id, reviewed.token);
        if (!isCurrent()) return;
        setUniverseReview({ context, type: 'applied', result });
        toast.success(result.changed ? 'World draft entries saved in QiMovi Universe.' : 'QiMovi Universe already matches this world.');
      } else {
        const result = await localApi.qimovi.previewUniverse(draft.id);
        if (!isCurrent()) return;
        setUniverseReview({ context, type: 'preview', result });
      }
    } catch (error) {
      if (!isCurrent()) return;
      const message = error instanceof Error ? error.message : 'QiMovi Universe transfer could not be confirmed.';
      setUniverseReview({ context, type: 'error', message, applying: !!reviewed });
      toast.error(message);
    } finally { setBusy(null); }
  };

  return (
    <section className="flex flex-col gap-2 text-sm">
      <div className="flex items-center gap-2"><h3 className="font-medium">QiMovi / FilmStack</h3><span className="text-xs text-muted-foreground ml-auto">{status === null ? "connection not checked" : current.connected ? "connected" : current.configured ? "configured" : "not linked"}</span></div>
      {connectionError && <div role="alert" className="rounded-md border border-border p-3 text-xs space-y-2"><p>{connectionError}</p><p>Your writing stays in this workspace. Retry after opening the intended project in QiMovi.</p><Button size="sm" variant="outline" disabled={busy !== null} onClick={() => run("status", async () => setStatus(await localApi.qimovi.status()))}>Retry connection status</Button></div>}
      {canAuthorizeQiMoviFolder() && (!current.connected || editing || connectionError) && <div className="rounded-md border border-border p-3 text-xs space-y-2">
        <p>If macOS blocks discovery, allow access to the project folder currently open in QiMovi. Your writing workspace stays here.</p>
        <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => run('access', async () => {
          if (!await authorizeQiMoviFolder()) return;
          setInstalled(await localApi.qimovi.installed());
          if (current.configured && !editing) { setStatus(await localApi.qimovi.connect()); toast.success('Connected to QiMovi.'); }
        })}>{busy === 'access' ? 'Waiting for folder access…' : 'Allow project folder access'}</Button>
      </div>}
      {(!current.configured || editing) && <div className="flex flex-col gap-3 py-2">
        <p className="text-xs leading-relaxed text-muted-foreground">Open your destination project in QiMovi. Connect it here to carry saved screenplays and world reference files between the apps.</p>
        <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => run('find', async () => setInstalled(await localApi.qimovi.installed()))}>{busy === 'find' ? 'Finding QiMovi…' : 'Find open QiMovi project'}</Button>
        {installed?.project && <div className="rounded-md border border-border p-3 text-xs space-y-2"><strong>{installed.project.title}</strong><p className="break-all text-muted-foreground">{installed.directory}</p><Button size="sm" disabled={!installed.available || busy !== null} onClick={() => run('installed', async () => { await localApi.qimovi.configureInstalled(installed.project!.id); setStatus(await localApi.qimovi.connect()); setEditing(false); setInstalled(null); setWorldTransfer(null); toast.success('QiMovi connected on this Mac.'); })}>Connect this project</Button></div>}
        {installed && !installed.available && <p role="status" className="text-xs text-muted-foreground">{installed.reason === 'QIMOVI_NOT_RUNNING' ? 'Open this project in QiMovi, then find it again.' : 'No running QiMovi project was found. Open QiMovi and select a project, or use manual setup.'}</p>}
        <button type="button" className="self-start text-xs text-muted-foreground underline underline-offset-4" onClick={() => setManual(value => !value)}>{manual ? 'Hide manual setup' : 'Manual service setup'}</button>
        {editing && <Button size="sm" variant="ghost" onClick={() => { setEditing(false); setManual(false); setInstalled(null); }}>Cancel change</Button>}
      </div>}
      {(!current.configured || editing) ? (
        <form hidden={!manual} className="flex flex-col gap-2" onSubmit={(event) => { event.preventDefault(); void run("configure", async () => { setStatus(await localApi.qimovi.configure({ origin: origin.trim(), ownerToken: token.trim() })); setToken(""); setEditing(false); setWorldTransfer(null); toast.success("QiMovi connection saved on this Mac."); }); }}>
          <p className="text-xs text-muted-foreground">Open the project in QiMovi (or run its local service). Enter the exact service origin it printed and the <code>ownerToken</code> from that project folder's <code>config.json</code>. Both are stored in the local service's private connections file.</p>
          <Input value={origin} onChange={(event) => setOrigin(event.target.value)} placeholder="http://127.0.0.1:4317" aria-label="QiMovi origin" />
          <Input type="password" autoComplete="off" value={token} onChange={(event) => setToken(event.target.value)} placeholder="QiMovi owner token (64 hex characters)" aria-label="QiMovi owner token" />
          <div className="flex gap-2"><Button size="sm" type="submit" disabled={busy !== null || token.trim().length !== 64}>Save connection</Button>{editing && <Button size="sm" variant="ghost" type="button" onClick={() => setEditing(false)}>Cancel</Button>}</div>
        </form>
      ) : (
        <>
          <div className="text-xs text-muted-foreground">Service: <code>{current.origin}</code>{current.project && <> · Project: <strong>{current.project.title}</strong> ({current.project.profile === "caniscreenwrite-creative/v1" ? "creative" : "film"})</>}</div>
          <div className="flex gap-2 flex-wrap">
            <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => run("connect", async () => { setStatus(await localApi.qimovi.connect()); toast.success("Connected to QiMovi."); })}>{current.connected ? "Refresh" : "Connect"}</Button>
            <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => { clearUniverseReview(); setEditing(true); }}>Change</Button>
            <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => run("clear", async () => { setStatus(await localApi.qimovi.clear()); setInstalled(null); setWorldTransfer(null); })}>Forget</Button>
          </div>
          {current.connected && current.project && <QiMoviLibraryPanel key={`${current.origin}:${current.project.id}`} project={current.project} disabled={busy !== null || dirty || developmentDirty} onChanged={onChanged} onOpenDraft={onOpenDraft} />}
          {draft ? (
            <div className="flex flex-col gap-1 border-t border-border pt-2">
              <Button size="sm" disabled={busy !== null || dirty || !current.configured} onClick={() => run("push", async () => { const result = await localApi.qimovi.push(draft.id); await onChanged(); setStatus(await localApi.qimovi.status()); toast.success(result.changed ? `Pushed v${draft.version} to QiMovi as revision ${result.remote.version}.` : `QiMovi already holds v${draft.version}.`); })}>
                {busy === "push" ? "Pushing…" : `Push v${draft.version} to QiMovi`}
              </Button>
              {dirty && <span className="text-xs text-muted-foreground">Save the draft before pushing.</span>}
              {remote && link && (
                <span className="text-xs text-muted-foreground">Carried v{link.data.draftVersion} → QiMovi revision {remote.version} in "{remote.projectTitle}" · {new Date(link.data.linkedAt).toLocaleString()}{link.data.draftVersion !== draft.version ? " · local is newer" : ""}</span>
              )}
              {summary?.drafts.some((item) => item.id === draft.id && (!remote || item.version !== remote.version)) && (
                <Button size="sm" variant="outline" disabled={busy !== null || dirty || developmentDirty} onClick={() => run("pull", async () => { const result = await localApi.qimovi.pull(draft.id); await onChanged(); toast.success(result.changed ? `Pulled QiMovi's revision as local v${result.local.version}.` : "Local already matches QiMovi."); })}>Pull QiMovi's newer revision</Button>
              )}
            </div>
          ) : <span className="text-xs text-muted-foreground">Save the draft to push it.</span>}
          {draft && <div className="flex flex-col gap-2 border-t border-border pt-3">
            <h4 className="text-xs font-medium">World & development</h4>
            <section className="qimovi-universe" aria-label="QiMovi Universe transfer" aria-busy={busy === 'universe-preview' || busy === 'universe-apply'}>
              <h5>QiMovi Universe</h5>
              <p className="qimovi-universe-copy">Review saved world elements as editable draft entries in QiMovi. Canon and source approval remain in QiMovi.</p>
              <Button size="sm" variant="outline" disabled={busy !== null || !canPreviewUniverse} onClick={() => void transferUniverse()}>{busy === 'universe-preview' ? 'Preparing preview…' : 'Preview Universe transfer'}</Button>
              <div aria-live="polite">
                {busy === 'universe-apply' && <p className="qimovi-universe-copy">Applying reviewed entries…</p>}
                {preview && <div className="qimovi-universe-review" role="region" aria-label="Universe transfer preview">
                  <div className="qimovi-universe-destination"><span>Destination</span><strong>{preview.project.title}</strong><small>Development v{preview.developmentVersion} · draft entries</small></div>
                  <dl className="qimovi-universe-counts" aria-label="Preview changes">
                    <div><dt>Create</dt><dd>{preview.counts.create}</dd></div>
                    <div><dt>Update</dt><dd>{preview.counts.update}</dd></div>
                    <div><dt>Unchanged</dt><dd>{preview.counts.unchanged}</dd></div>
                    <div data-conflict={hasUniverseConflicts}><dt>Conflicts</dt><dd>{preview.counts.conflicts}</dd></div>
                  </dl>
                  {preview.items.length > 0 ? <ul className="qimovi-universe-items" aria-label="Entries to review">{preview.items.map(item => <li key={item.id} data-action={item.action}>
                    <div><strong>{item.label}</strong><span className="qimovi-universe-action">{universeActions[item.action]}</span></div>
                    <span className="qimovi-universe-kind">{universeKind(item.kind)}</span>
                    {item.reason && <p>{item.reason}</p>}
                  </li>)}</ul> : <p className="qimovi-universe-copy">The saved world has no entries to transfer.</p>}
                  {preview.notes.length > 0 && <ul className="qimovi-universe-notes" aria-label="Transfer notes">{preview.notes.map((note, index) => <li key={index}>{note}</li>)}</ul>}
                  {hasUniverseConflicts && <p className="qimovi-universe-warning">Resolve the conflicts in QiMovi, then preview again before applying.</p>}
                  <div className="qimovi-universe-buttons">
                    <Button size="sm" disabled={busy !== null || !canPreviewUniverse || hasUniverseConflicts || !preview.token || !preview.items.length} onClick={() => void transferUniverse(preview)}>Apply reviewed transfer</Button>
                    <Button size="sm" variant="ghost" disabled={busy !== null} onClick={clearUniverseReview}>Dismiss</Button>
                  </div>
                </div>}
                {review?.type === 'error' && <div className="qimovi-universe-notice" role="alert"><p>{review.message}</p><p>{review.applying ? 'This transfer was not confirmed. Preview again to check any entries already saved in QiMovi.' : 'No transfer was applied. Preview again when the connection is ready.'}</p></div>}
                {review?.type === 'applied' && <div className="qimovi-universe-notice" role="status">
                  <p>{review.result.changed ? 'Saved in' : 'Already matches'} <strong>{review.result.project.title}</strong> · development v{review.result.developmentVersion}.</p>
                  <p>{review.result.counts.create} created · {review.result.counts.update} updated · {review.result.counts.unchanged} unchanged.</p>
                  <details><summary>Saved draft entries ({review.result.records.length})</summary><ul>{review.result.records.map(record => <li key={record.id}><span>{universeKind(record.kind)} · v{record.version}</span><code>{record.id}</code><small>{record.sha256.slice(0, 12)}</small></li>)}</ul></details>
                </div>}
              </div>
            </section>
            <WorldReturnPanel draftId={draft.id} context={universeContext} enabled={canPreviewUniverse} disabled={busy !== null && busy !== 'world-return'} onChanged={onChanged} onBusy={value => { if (value) clearUniverseReview(); setBusy(value ? 'world-return' : null); }} />
            <p className="text-xs leading-relaxed text-muted-foreground">Reference files: send the complete saved world and development notes as JSON and Markdown to QiMovi’s project library.</p>
            <Button size="sm" variant="outline" disabled={busy !== null || dirty || developmentDirty || !development?.data.world || !current.configured} onClick={() => run('world', async () => { setWorldTransfer(null); const result = await localApi.qimovi.pushWorld(draft.id); setWorldTransfer(result); toast.success('World files verified in QiMovi’s project library.'); })}>{busy === 'world' ? 'Sending world…' : `Send world${development ? ` v${development.version}` : ''} to QiMovi`}</Button>
            {(dirty || developmentDirty) ? <p className="text-xs text-muted-foreground">Save screenplay and development changes before sending.</p> : !development?.data.world && <p className="text-xs text-muted-foreground">Add an element in World Builder and save development first.</p>}
            {worldTransfer && <div role="status" className="text-xs space-y-1"><p>Sent development v{worldTransfer.developmentVersion}. Files verified:</p>{worldTransfer.files.filter(file => file.verified).map(file => <p key={file.recordId} className="break-all text-muted-foreground">{file.filename} · {file.sha256.slice(0, 12)}</p>)}</div>}
          </div>}
          {(dirty || developmentDirty) && <p className="text-xs text-muted-foreground">Save your screenplay and development edits before pulling revisions from QiMovi.</p>}
          {summary && (
            <details className="text-xs">
              <summary className="cursor-pointer">Drafts in QiMovi ({summary.drafts.length})</summary>
              <ul className="mt-1 flex flex-col gap-1">
                {summary.drafts.map((item) => (
                  <li key={item.id} className="flex items-center gap-2">
                    <span className="truncate">{item.title} · r{item.version}</span>
                    <Button size="sm" variant="ghost" className="ml-auto h-6 px-2" disabled={busy !== null || dirty || developmentDirty} onClick={() => run("pull", async () => { const result = await localApi.qimovi.pull(item.id); await onChanged(); toast.success(result.changed ? `Pulled "${item.title}" as local v${result.local.version}.` : "Already in this workspace."); })}>Pull</Button>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}
    </section>
  );
}
