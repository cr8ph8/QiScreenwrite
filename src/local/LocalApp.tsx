import { lazy, Suspense, useCallback, useEffect, useMemo, useState, useRef } from "react";
import { BookOpen, ChevronDown, HardDrive, Layers, LayoutTemplate, Link2, PenLine, Plus, Users } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { localApi, LocalApiError, SESSION_LOST_EVENT } from "./api";
import { DRAFT_KIND, TEMPLATES, buildDraftData, isDraft, newDraftId, sortDrafts, type RecoveryCopy } from "./model";
import type { Bootstrap, DraftRecord, WorkspaceRecord } from "./types";
import type { OpenDraft } from "./components/WriterDesk";
import { LocalLibrary } from "./components/LocalLibrary";
import { FilmcraftPanel } from "./components/FilmcraftPanel";
import { QiMoviPanel } from "./components/QiMoviPanel";
import { PocketExchangePanel } from "./components/PocketExchangePanel";

const CompetitionPanel = lazy(() => import("./components/CompetitionPanel").then(module => ({ default: module.CompetitionPanel })));
const WriterDesk = lazy(() => import("./components/WriterDesk").then(module => ({ default: module.WriterDesk })));
const PreservationPanel = lazy(() => import('./components/PreservationPanel').then(module => ({ default: module.PreservationPanel })));
const RightsPanel = lazy(() => import('./components/RightsPanel').then(module => ({ default: module.RightsPanel })));
type StudioView = "drafts" | "templates" | "knowledge" | "connections" | "write" | "preservation" | "rights";
type RecoveryHost = Window & { __localWriterDirty?: boolean; __flushWriterRecovery?: () => Promise<void>; __flushDevelopmentRecovery?: () => Promise<void>; __flushRightsRecovery?: () => Promise<void> };

type Phase = { name: "checking" } | { name: "unreachable"; message: string } | { name: "login"; error?: string } | { name: "ready"; bootstrap: Bootstrap };

/** Read a one-time login nonce from the URL fragment and remove it from history. */
function takeLoginNonce(): string | null {
  const match = /^#login=([a-f0-9]{64})$/.exec(window.location.hash);
  if (!match) return null;
  window.history.replaceState(null, "", window.location.pathname + window.location.search);
  return match[1];
}

export default function LocalApp() {
  const [phase, setPhase] = useState<Phase>({ name: "checking" });
  const [open, setOpen] = useState<OpenDraft | null>(null);
  const [recoveries, setRecoveries] = useState<RecoveryCopy[]>([]);
  const [view, setView] = useState<StudioView>("drafts");
  const [competitionEnabled, setCompetitionEnabled] = useState(false);
  const switching = useRef(false);
  const importRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    const bootstrap = await localApi.bootstrap();
    setPhase({ name: "ready", bootstrap });
    try { setRecoveries(await localApi.recovery.list()); }
    catch (error) { toast.error(`Saved work is available, but recovery could not be listed: ${error instanceof Error ? error.message : "unavailable"}`); }
    return bootstrap;
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await localApi.health();
        const nonce = takeLoginNonce();
        if (nonce) {
          try { await localApi.login({ loginNonce: nonce }); } catch { /* fall through to the token form */ }
        }
        try { await load(); } catch (error) {
          if (!cancelled) setPhase({ name: "login", error: error instanceof LocalApiError && error.code !== "OWNER_SESSION_REQUIRED" ? error.message : undefined });
        }
      } catch (error) {
        if (!cancelled) setPhase({ name: "unreachable", message: error instanceof Error ? error.message : "The local writer service is not running." });
      }
    })();
    return () => { cancelled = true; };
  }, [load]);

  useEffect(() => {
    const relock = () => setPhase((current) => (current.name === "ready" ? { name: "login", error: "The local session ended (a newer login or expiry). Unsaved text is kept as a recovery copy; unlock to continue." } : current));
    window.addEventListener(SESSION_LOST_EVENT, relock);
    return () => window.removeEventListener(SESSION_LOST_EVENT, relock);
  }, []);

  useEffect(() => {
    (window as unknown as {__localWriterReady?:boolean}).__localWriterReady = phase.name === "ready";
    if (phase.name === "ready") window.dispatchEvent(new Event("writer:ready"));
  }, [phase.name]);

  const records = useMemo(() => (phase.name === "ready" ? phase.bootstrap.records : []), [phase]);
  const drafts = useMemo(() => sortDrafts(records.filter(isDraft)), [records]);

  // Keep the open draft pointed at the newest saved revision after any reload.
  useEffect(() => {
    if (!open || open.saved === null) return;
    const latest = drafts.find((draft) => draft.id === open.id);
    if (latest && latest.version !== open.saved.version) setOpen({ id: open.id, saved: latest, initial: null });
  }, [drafts, open]);

  const onSaved = useCallback((record: WorkspaceRecord) => {
    setPhase((current) => {
      if (current.name !== "ready") return current;
      const others = current.bootstrap.records.filter((item) => item.id !== record.id);
      return { name: "ready", bootstrap: { ...current.bootstrap, records: [...others, record] } };
    });
    if (record.kind === DRAFT_KIND) setOpen({ id: record.id, saved: record as DraftRecord, initial: null });
  }, []);

  const refresh = useCallback(async () => {
    try { await load(); } catch (error) { toast.error(error instanceof Error ? error.message : "Could not reload the workspace."); }
  }, [load]);

  const flushRecovery = async () => {
    const host = window as RecoveryHost;
    await Promise.all([host.__flushWriterRecovery?.(), host.__flushDevelopmentRecovery?.(), host.__flushRightsRecovery?.()]);
  };

  // Browsing other studio views keeps the editor mounted, including undo and
  // pending development edits. Replacing a draft first makes recovery durable.
  const showView = (next: StudioView) => {
    setView(next);
    if (next === "drafts") void flushRecovery().then(() => localApi.recovery.list()).then(setRecoveries).catch(error => toast.error(error instanceof Error ? error.message : "Recovery is not available yet."));
  };

  const replaceDraft = async (next: OpenDraft) => {
    if (next.id === open?.id) { setView("write"); return; }
    if (switching.current) return;
    const dirty = (window as RecoveryHost).__localWriterDirty || document.querySelector('[data-development-dirty="true"]');
    if (dirty && !window.confirm("Open another screenplay? Your unsaved work will stay in recovery. Save first if you want a revision.")) return;
    switching.current = true;
    try {
      await flushRecovery();
      setOpen(next); setView("write");
    } catch (error) {
      toast.error(`Keep this screenplay open: ${error instanceof Error ? error.message : "recovery could not be saved"}`);
    } finally { switching.current = false; }
  };

  const openLinkedDraft = async (id: string) => {
    try {
      const bootstrap = await localApi.bootstrap();
      if (phase.name !== "ready" || bootstrap.project.id !== phase.bootstrap.project.id) throw new Error("The workspace changed. Reopen the draft from My drafts.");
      const draft = bootstrap.records.find(record => record.id === id && isDraft(record));
      if (!draft || !isDraft(draft)) throw new Error("This screenplay is no longer available. Refresh the library.");
      setPhase(current => current.name === "ready" && current.bootstrap.project.id === bootstrap.project.id ? { name: "ready", bootstrap } : current);
      await replaceDraft({ id: draft.id, saved: draft, initial: null });
    } catch (error) { toast.error(error instanceof Error ? error.message : "Could not open the linked draft."); }
  };

  const startDraft = (templateId: string) => {
    if (phase.name !== "ready") return;
    const template = TEMPLATES.find((item) => item.id === templateId) ?? TEMPLATES[0];
    void replaceDraft({ id: newDraftId(), saved: null, initial: buildDraftData(phase.bootstrap.project.id, { title: "Untitled screenplay", body: template.body, projectFormat: template.projectFormat }) });
  };

  const importFountain = async (file: File) => {
    if (phase.name !== "ready") return;
    if (file.size > 4000000) { toast.error("Choose a screenplay file smaller than 4 MB."); return; }
    const text = await file.text();
    let decoded = text.replace(/^\uFEFF/, "");
    if (/\.fdx$/i.test(file.name) || /<FinalDraft/i.test(decoded.slice(0, 2000))) {
      try { decoded = (await import("@/lib/fountain/fdx")).fromFdx(decoded); }
      catch (error) { toast.error(error instanceof Error ? error.message : "Could not read that Final Draft file."); return; }
    }
    if (decoded.length > 200000) { toast.error("That file is longer than the 200,000-character draft limit."); return; }
    const titleLine = /^Title:\s*(.+)$/im.exec(decoded)?.[1]?.trim();
    await replaceDraft({ id: newDraftId(), saved: null, initial: buildDraftData(phase.bootstrap.project.id, { title: titleLine || file.name.replace(/\.[^.]+$/, ""), body: decoded }) });
  };

  useEffect(() => {
    const command = (event: Event) => {
      const name = (event as CustomEvent<string>).detail;
      if (name === "new") startDraft("blank");
      if (name === "library") showView("drafts");
      if (name === "knowledge") showView("knowledge");
      if (name === "connections") showView("connections");
      if (name === "rights") showView("rights");
      if (name === 'preservation') showView('preservation');
      if (name === "import") importRef.current?.click();
      if (name === "backup") { const a = document.createElement("a"); a.href = "/api/backup"; a.download = "QiCanIScreenwrite-backup.json"; a.click(); }
    };
    const imported = (event: Event) => {
      const { name, text } = (event as CustomEvent<{name:string; text:string}>).detail;
      void importFountain(new File([text], name, { type: "text/plain" }));
    };
    const restored = () => { void refresh(); };
    window.addEventListener("writer:command", command);
    window.addEventListener("writer:import-file", imported);
    window.addEventListener("writer:session-restored", restored);
    return () => { window.removeEventListener("writer:command", command); window.removeEventListener("writer:import-file", imported); window.removeEventListener("writer:session-restored", restored); };
  });

  if (phase.name === "checking") return <Centered><p className="text-muted-foreground">Connecting to the local writer service…</p></Centered>;
  if (phase.name === "unreachable") return (
    <Centered>
      <h1 className="text-xl font-semibold">Local writer service not running</h1>
      <p className="text-muted-foreground max-w-md text-center">{phase.message}</p>
      <pre className="text-xs bg-muted rounded p-3">npm run local:app</pre>
      <Button variant="outline" onClick={() => window.location.reload()}>Retry</Button>
    </Centered>
  );
  if (phase.name === "login") return <LoginGate error={phase.error} onSubmit={async (token) => {
    try { await localApi.login({ token }); await load(); }
    catch (error) { setPhase({ name: "login", error: error instanceof Error ? error.message : "Sign-in failed." }); }
  }} />;

  const { project } = phase.bootstrap;
  return (
    <div className="lw-shell">
      <header className="lw-studio-header">
        <button className="lw-brand" onClick={() => showView("drafts")} aria-label="QiCanIScreenwrite home"><img src="/qicaniscreenwrite-mark.svg" alt="" width={38} height={38} /><span>QiCanIScreenwrite<small>QUOTIENT INTELLIGENT</small></span></button>
        <nav className="lw-studio-nav" aria-label="Studio">
          {([{ id: "drafts", label: "My drafts", icon: Layers }, { id: "templates", label: "Templates", icon: LayoutTemplate }, { id: "knowledge", label: "Knowledge", icon: BookOpen }, { id: "connections", label: "Connections", icon: Link2 }] as const).map(({ id, label, icon: Icon }) => <button key={id} onClick={() => showView(id)} aria-current={view === id ? "page" : undefined}><Icon aria-hidden="true" />{label}</button>)}
          <button onClick={() => showView('rights')} aria-current={view === 'rights' ? 'page' : undefined}><Users aria-hidden="true" />Rights</button>
          {open && <button onClick={() => setView("write")} aria-current={view === "write" ? "page" : undefined}><PenLine aria-hidden="true" />Workspace</button>}
        </nav>
        <div className="lw-studio-utilities">
          <span className="lw-local-status"><HardDrive aria-hidden="true" />Local</span>
          <DropdownMenu><DropdownMenuTrigger asChild><Button variant="ghost" size="sm" aria-label="Workspace menu"><ChevronDown className="h-4 w-4" /></Button></DropdownMenuTrigger><DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={() => importRef.current?.click()}>Import screenplay…</DropdownMenuItem>
            <DropdownMenuItem asChild><a href="/api/backup" download="QiCanIScreenwrite-backup.json">Back up saved workspace…</a></DropdownMenuItem>
            <DropdownMenuItem onSelect={() => showView('preservation')}>Preservation inventory…</DropdownMenuItem>
            <DropdownMenuItem onSelect={refresh}>Refresh library</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={async () => {
              try { await flushRecovery(); await localApi.logout(); setOpen(null); setPhase({ name: "login" }); }
              catch (error) { toast.error(error instanceof Error ? error.message : "Could not lock the workspace safely."); }
            }}>Lock workspace</DropdownMenuItem>
          </DropdownMenuContent></DropdownMenu>
          <Button size="sm" onClick={() => startDraft("blank")}><Plus className="mr-1.5 h-4 w-4" />New draft</Button>
        </div>
      </header>
      <main className="lw-studio-content">
        <div hidden={view !== 'rights'}><Suspense fallback={<Centered><p>Opening rights workspace…</p></Centered>}><RightsPanel project={project} records={records} onSaved={onSaved} onRefresh={refresh} active={view === 'rights'} /></Suspense></div>
        {view === 'preservation' && <Suspense fallback={<Centered><p>Inspecting saved work…</p></Centered>}><PreservationPanel beforeInspect={flushRecovery} onOpenDraft={id => void openLinkedDraft(id)} onConnections={() => showView('connections')} onBack={() => showView(open ? 'write' : 'drafts')} /></Suspense>}
        <input ref={importRef} type="file" accept=".fountain,.fdx,.txt" className="hidden" aria-label="Import screenplay from desktop" onChange={(event) => { const file=event.target.files?.[0]; if(file) void importFountain(file); event.target.value=""; }} />
        {(view === "drafts" || view === "templates") && <LocalLibrary view={view} drafts={drafts} records={records} recoveries={recoveries} onOpen={draft => void replaceDraft({ id: draft.id, saved: draft, initial: null })} onRecover={copy => void replaceDraft({ id: copy.draftId, saved: drafts.find(draft => draft.id === copy.draftId) ?? null, initial: copy.data })} onNew={startDraft} onImport={() => importRef.current?.click()} />}
        <div className="lw-reference-view" hidden={view !== "knowledge"}><div className="lw-view-heading"><p className="lw-eyebrow">KNOWLEDGE</p><h1>The filmmaker’s reference</h1><p>Explore the bundled film-language reference and writing exercises offline.</p></div><FilmcraftPanel active={view === "knowledge"} referenceOnly canAddResearch={false} onAddResearch={() => ({ ok: false, message: "Open a screenplay to add research." })} /></div>
        {view === "connections" && <div className="lw-connections-view"><div className="lw-view-heading"><p className="lw-eyebrow">CONNECTED WORKSPACES</p><h1>Bring your work together</h1><p>Import existing drafts or connect a production project when you’re ready.</p></div><div className="lw-connection-layout"><div><p className="lw-eyebrow">LOCAL PRODUCTION</p><QiMoviPanel draft={null} dirty={false} links={[]} onChanged={refresh} onOpenDraft={id => void openLinkedDraft(id)} /></div><div><p className="lw-eyebrow">ONLINE · OPTIONAL</p>{competitionEnabled ? <Suspense fallback={<p>Opening competition connection…</p>}><CompetitionPanel project={project} draft={null} dirty={false} links={[]} onChanged={refresh} /></Suspense> : <section className="space-y-4"><h2>CanIScreenwrite competition</h2><p className="text-sm text-muted-foreground">Sign in to import copies of your online drafts, view entries, or continue to the competition system.</p><Button variant="outline" onClick={() => setCompetitionEnabled(true)}>Enable online competition</Button><p className="text-xs text-muted-foreground">Writing and your local library work without this connection.</p></section>}</div></div><PocketExchangePanel drafts={drafts} onChanged={refresh} onOpenDraft={id => void openLinkedDraft(id)} /></div>}
        {open && <div className="lw-open-draft" hidden={view !== "write"}><Suspense fallback={<Centered><p className="text-muted-foreground">Opening screenplay…</p></Centered>}><WriterDesk key={open.id} active={view === "write"} project={project} open={open} records={records} onSaved={onSaved} onRecordsChanged={refresh} onOpenDraft={id => void openLinkedDraft(id)} /></Suspense></div>}
      </main>
    </div>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="h-full w-full flex flex-col items-center justify-center gap-3 p-6">{children}</div>;
}

function LoginGate({ error, onSubmit }: { error?: string; onSubmit: (token: string) => Promise<void> }) {
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <Centered>
      <form className="flex flex-col gap-3 w-full max-w-sm" onSubmit={async (event) => { event.preventDefault(); setBusy(true); try { await onSubmit(token.trim()); } finally { setBusy(false); setToken(""); } }}>
        <h1 className="text-xl font-semibold">Unlock the local workspace</h1>
        <p className="text-sm text-muted-foreground">Open QiCanIScreenwrite from Applications to access this workspace automatically. Browser users can enter their local owner token.</p>
        {(window as unknown as {webkit?: {messageHandlers?: {writerSession?: unknown}}}).webkit?.messageHandlers?.writerSession && <Button type="button" variant="outline" onClick={async () => {
          const native = (window as unknown as {webkit: {messageHandlers: {writerSession: {postMessage(value: unknown): Promise<unknown>}}}}).webkit.messageHandlers.writerSession;
          try { await native.postMessage({action:"restore"}); window.dispatchEvent(new Event("writer:session-restored")); } catch { toast.error("Could not reopen the local session. Use View → Reconnect to Workspace."); }
        }}>Reopen local workspace</Button>}
        <Input type="password" autoComplete="off" placeholder="Owner token" value={token} onChange={(event) => setToken(event.target.value)} />
        {error && <p className="text-sm text-destructive">{error}</p>}
        <Button type="submit" disabled={busy || token.trim().length !== 64}>Unlock</Button>
      </form>
    </Centered>
  );
}
