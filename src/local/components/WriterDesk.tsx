import { BrandPlanningPanel } from './BrandPlanningPanel';
import { lazy, Suspense, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { BarChart3, BookOpen, Download, Eye, FileText, Globe2, History, LayoutGrid, Lightbulb, Maximize2, Minimize2, PanelRight, PenLine, Save, Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { ScreenplayWritingSurface, type ScreenplayWritingSurfaceHandle } from "@/components/writer/ScreenplayWritingSurface";
import type { ScreenplayWritingSelection } from "@/components/writer/ScreenplayPageEditor";
import { SceneNavigator } from "@/components/writer/SceneNavigator";
import { parseFountain } from "@/lib/fountain-parser";
import { screenplayStats, STORY_WORD_COUNT_DESCRIPTION } from "@/lib/fountain/reports";
import { parseScreenplay } from "@/lib/fountain/spec";
import { paginate, pageToText } from "@/lib/fountain/paginate";
import { numberScenes, toggleDualDialogue } from "@/lib/fountain/serialize";
import { toFdx } from "@/lib/fountain/fdx";
import { computeDiff } from "@/lib/diff";
import { localApi, LocalApiError } from "../api";
import { DRAFT_KIND, FORMAT_LABELS, MAX_BODY_LENGTH, buildDraftData, canonicalJson, downloadText, fieldsFromData, linksFor, readRecovery, recoveryKey, safeFilename, type DraftFields, type RecoveryCopy } from "../model";
import type { AuthoringFormat, DraftRecord, LocalProject, ScreenplayDraftData, WorkspaceRecord } from "../types";
import { HistoryPanel } from "./HistoryPanel";
import { QiMoviPanel } from "./QiMoviPanel";
import { ImportedSourcePanel } from './ImportedSourcePanel';
import { TitlePageDialog } from "./TitlePageDialog";
import { FindReplace } from "./FindReplace";
import { PreviewPane } from "./PreviewPane";
import { CardsBoard } from "./CardsBoard";
import { ReportsPanel } from "./ReportsPanel";
import { CreativeServicesPanel } from './CreativeServicesPanel';
import { DevelopmentPanel, type DevelopmentPanelHandle } from "./DevelopmentPanel";
import { FilmcraftPanel } from "./FilmcraftPanel";
import type { FilmcraftBrowse, FilmcraftResearchResult } from "../filmcraft";
import { isDevelopmentRecord } from "../development";
import { resolveWorldLink, worldContext } from "../world-context";
import "./writer-desk.css";
import type { WorldData } from "../world";

const CompetitionPanel = lazy(() => import("./CompetitionPanel").then((module) => ({ default: module.CompetitionPanel })));

export interface OpenDraft { id: string; saved: DraftRecord | null; initial: ScreenplayDraftData | null }

interface Props {
  active?: boolean;
  project: LocalProject;
  open: OpenDraft;
  records: WorkspaceRecord[];
  onSaved: (record: WorkspaceRecord) => void;
  onRecordsChanged: () => Promise<void>;
  onOpenDraft?: (id: string) => void;
}

const INSERTS: [string, string][] = [
  ["Centered text", "> CENTERED <"],
  ["Note", "[[Note to self.]]"],
  ["Section", "# Sequence"],
  ["Synopsis", "= What this scene must do."],
  ["Page break", "==="],
  ["Lyrics", "~Sing the line"],
  ["Shot", "!CLOSE ON the reel."],
  ["Montage", "!MONTAGE - THE LONG NIGHT"],
];

// A title, logline, genre or format choice is meaningful recovery even before
// the first body paragraph has been written.
const usefulWriterRecovery = (copy: RecoveryCopy | null, saved: DraftRecord | null) => !!copy && canonicalJson(copy.data) !== canonicalJson(saved?.data ?? buildDraftData(copy.data.projectId, { title: "Untitled screenplay", body: "" }));

/** Source-line starts (in `current`) that differ from `baseline`, for revision marks. */
function revisedLines(baseline: string, current: string): Set<number> {
  const starts = new Set<number>();
  const offsets: number[] = [];
  let running = 0;
  for (const line of current.split("\n")) { offsets.push(running); running += line.length + 1; }
  let lineIndex = 0;
  for (const line of computeDiff(baseline, current)) {
    if (line.type === "remove") continue;
    if (line.type === "add") starts.add(offsets[lineIndex] ?? 0);
    lineIndex++;
  }
  return starts;
}

export function WriterDesk({ project, open, records, onSaved, onRecordsChanged, onOpenDraft, active = true }: Props) {
  const [saved, setSaved] = useState<DraftRecord | null>(open.saved);
  const [fields, setFields] = useState<Required<DraftFields>>(() => fieldsFromData(open.saved?.data ?? open.initial!));
  const browserRecoveryOnOpen = useRef<RecoveryCopy | null>(null);
  const [recovery, setRecovery] = useState<RecoveryCopy | null>(() => {
    const copy = readRecovery(localStorage, open.id);
    browserRecoveryOnOpen.current = copy;
    return usefulWriterRecovery(copy, open.saved) ? copy : null;
  });
  const [recoveryLoaded, setRecoveryLoaded] = useState(false);
  const [recoveryError, setRecoveryError] = useState("");
  const [recoveryCheck, setRecoveryCheck] = useState(0);
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [tab, setTab] = useState("write");
  const [inspectorOpen, setInspectorOpen] = useState(() => window.matchMedia("(min-width: 1280px)").matches);
  const [focusMode, setFocusMode] = useState(false);
  const inspectorId = useId();
  const workspace = useRef<HTMLDivElement>(null);
  const inspectorToggle = useRef<HTMLButtonElement>(null);
  const focusToggle = useRef<HTMLButtonElement>(null);
  const inspectorVisible = inspectorOpen && !focusMode;
  const [activeOffset, setActiveOffset] = useState<number | undefined>();
  const [selection, setSelection] = useState<ScreenplayWritingSelection>({ start: 0, end: 0, kind: "action" });
  const [titleOpen, setTitleOpen] = useState(false);
  const [findOpen, setFindOpen] = useState(false);
  const [competitionEnabled, setCompetitionEnabled] = useState(false);
  const [sceneNumbers, setSceneNumbers] = useState(() => /#[\p{L}\p{N}][\p{L}\p{N}._-]*#\s*$/mu.test(fields.body));
  const [baseline, setBaseline] = useState<DraftRecord | null>(null);
  const [history, setHistory] = useState<DraftRecord[]>([]);
  const surface = useRef<ScreenplayWritingSurfaceHandle>(null);
  const development = useRef<DevelopmentPanelHandle>(null);
  const [developmentState, setDevelopmentState] = useState({ dirty: false, canSave: false, status: 'Checking development…' });
  const [draftWorld, setDraftWorld] = useState<WorldData | undefined>();
  const [worldFocus, setWorldFocus] = useState<{ id: string; nonce: number }>();
  const [filmcraftReturn, setFilmcraftReturn] = useState<string | null>(null);
  const [filmcraftBrowse, setFilmcraftBrowse] = useState<FilmcraftBrowse>({});
  const attempt = useRef<{ fingerprint: string; requestId: string } | null>(null);
  const saving = useRef(false);
  const diskCopy = useRef<RecoveryCopy | null>(null);
  const pendingDisk = useRef<RecoveryCopy | null>(null);
  const recoveryQueue = useRef<Promise<void>>(Promise.resolve());
  const lastRecoveryTime = useRef(0);
  const recoveryFailure = useRef<Error | null>(null);
  const queueRecovery = useCallback((copy: RecoveryCopy) => {
    recoveryQueue.current = recoveryQueue.current.then(async () => {
      const written = await localApi.recovery.put(copy);
      if (canonicalJson(written) !== canonicalJson(copy)) throw new Error("Disk recovery was not confirmed.");
      diskCopy.current = written; recoveryFailure.current = null;
      setRecoveryError("");
    }).catch((error) => { recoveryFailure.current = error instanceof Error ? error : new Error("Disk recovery could not be saved."); setRecoveryError(recoveryFailure.current.message); });
    return recoveryQueue.current;
  }, []);

  useEffect(() => {
    let active = true;
    if (saved) localApi.history(open.id).then((items) => { if (active) setHistory(items as DraftRecord[]); }).catch(() => { if (active) setHistory([]); });
    else setHistory([]);
    return () => { active = false; };
  }, [open.id, saved]);

  const data = useMemo(() => buildDraftData(project.id, fields), [project.id, fields]);
  const fingerprint = useMemo(() => canonicalJson(data), [data]);
  const dirty = fingerprint !== canonicalJson(saved?.data ?? buildDraftData(project.id, { title: "Untitled screenplay", body: "" }));
  const latestEdit = useRef({ data, dirty, saved });
  latestEdit.current = { data, dirty, saved };
  useEffect(() => {
    let active = true;
    setRecoveryLoaded(false);
    void localApi.recovery.get(open.id).then((copy) => {
      if (!active) return;
      diskCopy.current = copy;
      if (copy) lastRecoveryTime.current = Math.max(lastRecoveryTime.current, Date.parse(copy.savedAt) || 0);
      // Only offer browser data that existed before this editor mounted.
      // Its synchronous recovery effect may already have stored this session's
      // own new draft while the disk read was in flight.
      const browser = browserRecoveryOnOpen.current;
      browserRecoveryOnOpen.current = null;
      const latest = [copy, browser].filter((item): item is RecoveryCopy => usefulWriterRecovery(item, latestEdit.current.saved)).sort((a, b) => Date.parse(b.savedAt) - Date.parse(a.savedAt))[0];
      if (latest) setRecovery((local) => !local || latest.savedAt > local.savedAt ? latest : local);
      setRecoveryLoaded(true); setRecoveryError(""); recoveryFailure.current = null;
    }).catch((error) => {
      if (active) setRecoveryError(`Disk recovery could not be checked: ${error instanceof Error ? error.message : "unavailable"}. Your browser copy is retained.`);
    });
    return () => { active = false; };
  }, [open.id, recoveryCheck]);
  useEffect(() => {
    if (!open.saved || open.saved.version <= (saved?.version ?? 0)) return;
    // Incoming records can be save acknowledgements or another client's work.
    // Neither is permission to replace text typed since the request began.
    if (dirty || busy) { setConflict(true); return; }
    setSaved(open.saved); setFields(fieldsFromData(open.saved.data)); setConflict(false);
  }, [open.saved, saved, dirty, busy]);
  const parsed = useMemo(() => parseFountain(fields.body, { inputMode: "fountain" }), [fields.body]);
  const screenplay = useMemo(() => parseScreenplay(fields.body), [fields.body]);
  const worldSources = useMemo(() => worldContext(screenplay), [screenplay]);
  const activeScene = [...screenplay.scenes].reverse().find(scene => scene.start <= (activeOffset ?? selection.start)) ?? screenplay.scenes[0];
  const sceneWorldElements = (draftWorld?.elements ?? []).filter(element => draftWorld?.links.some(link => {
    if (link.elementId.toLowerCase() !== element.id.toLowerCase() || !activeScene) return false;
    const resolved = resolveWorldLink(link, worldSources);
    return !!resolved && (link.targetType === 'scene' ? resolved.offset === activeScene.start : link.targetType === 'character' && activeScene.characters.includes(resolved.ref));
  }));
  const pageCount = useMemo(() => paginate(screenplay, { sceneNumbers }).length, [screenplay, sceneNumbers]);
  const links = linksFor(records, open.id);
  const revisedStarts = useMemo(() => (baseline ? revisedLines(baseline.data.body, fields.body) : undefined), [baseline, fields.body]);
  const revisedBlocks = useMemo(() => {
    if (!revisedStarts) return undefined;
    const set = new Set<number>();
    screenplay.blocks.forEach((block, index) => { for (const start of revisedStarts) if (start >= block.start && start <= block.end) { set.add(index); break; } });
    return set;
  }, [revisedStarts, screenplay]);

  // The desktop host asks before quitting while this flag is set.
  useEffect(() => { (window as unknown as { __localWriterDirty?: boolean }).__localWriterDirty = dirty; return () => { (window as unknown as { __localWriterDirty?: boolean }).__localWriterDirty = false; }; }, [dirty]);

  useEffect(() => {
    // Keep a discovered copy until Restore/Discard. Write edits immediately so
    // switching drafts or closing inside a debounce window cannot lose them.
    if (recovery) return;
    try {
      if (dirty) localStorage.setItem(recoveryKey(open.id), JSON.stringify({ schema: "caniscreenwrite-local-writer-recovery/v1", draftId: open.id, baseVersion: saved?.version ?? null, baseSha256: saved?.sha256 ?? null, data, savedAt: new Date().toISOString() } satisfies RecoveryCopy));
      else localStorage.removeItem(recoveryKey(open.id));
    } catch { /* storage unavailable: the explicit save still works */ }
  }, [data, dirty, open.id, saved, recovery]);

  useEffect(() => {
    if (!recoveryLoaded || recovery || !dirty) { pendingDisk.current = null; return; }
    lastRecoveryTime.current = Math.max(Date.now(), lastRecoveryTime.current + 1);
    const copy: RecoveryCopy = { schema: "caniscreenwrite-local-writer-recovery/v1", draftId: open.id, baseVersion: saved?.version ?? null, baseSha256: saved?.sha256 ?? null, data, savedAt: new Date(lastRecoveryTime.current).toISOString() };
    pendingDisk.current = copy;
    const timer = setTimeout(() => { if (pendingDisk.current !== copy) return; pendingDisk.current = null; void queueRecovery(copy); }, 400);
    return () => clearTimeout(timer);
  }, [data, dirty, open.id, saved, recovery, recoveryLoaded, queueRecovery]);

  useEffect(() => () => {
    const copy = pendingDisk.current;
    pendingDisk.current = null;
    if (copy) void queueRecovery(copy);
  }, [queueRecovery]);

  useEffect(() => {
    const host = window as unknown as { __flushWriterRecovery?: () => Promise<void> };
    const flush = async () => {
      if (recovery) {
        if (!diskCopy.current || canonicalJson(diskCopy.current) !== canonicalJson(recovery)) throw new Error("Restore or discard screenplay recovery before quitting; the newest copy is only in this browser.");
        return;
      }
      let edit = latestEdit.current;
      while (edit.dirty) {
        await recoveryQueue.current;
        edit = latestEdit.current;
        if (!edit.dirty) break;
        if (!recoveryLoaded) throw new Error("Check screenplay disk recovery or save the screenplay before quitting.");
        const durable = diskCopy.current;
        if (!durable || canonicalJson(durable.data) !== canonicalJson(edit.data) || durable.baseVersion !== (edit.saved?.version ?? null)) {
          lastRecoveryTime.current = Math.max(Date.now(), lastRecoveryTime.current + 1);
          const copy: RecoveryCopy = { schema: "caniscreenwrite-local-writer-recovery/v1", draftId: open.id, baseVersion: edit.saved?.version ?? null, baseSha256: edit.saved?.sha256 ?? null, data: edit.data, savedAt: new Date(lastRecoveryTime.current).toISOString() };
          pendingDisk.current = null;
          await queueRecovery(copy);
          if (recoveryFailure.current) throw recoveryFailure.current;
          edit = latestEdit.current;
        } else { pendingDisk.current = null; recoveryFailure.current = null; break; }
      }
      await recoveryQueue.current;
      if (recoveryFailure.current && latestEdit.current.dirty) throw recoveryFailure.current;
    };
    host.__flushWriterRecovery = flush;
    return () => { if (host.__flushWriterRecovery === flush) delete host.__flushWriterRecovery; };
  }, [open.id, recovery, recoveryLoaded, queueRecovery]);

  const discardRecovery = async () => {
    try {
      await recoveryQueue.current;
      // A timestamp condition cannot delete another client's newer recovery.
      if (diskCopy.current) await localApi.recovery.remove(open.id, diskCopy.current.savedAt);
      diskCopy.current = null;
      localStorage.removeItem(recoveryKey(open.id));
      setRecovery(null); setRecoveryError("");
    } catch (error) { setRecoveryError(error instanceof Error ? error.message : "Recovery could not be discarded."); }
  };

  useEffect(() => {
    const guard = (event: BeforeUnloadEvent) => { if (dirty) { event.preventDefault(); event.returnValue = ""; } };
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, [dirty]);

  const save = useCallback(async () => {
    if (saving.current || !dirty) return;
    if (fields.body.length > MAX_BODY_LENGTH) { toast.error(`Drafts are limited to ${MAX_BODY_LENGTH.toLocaleString()} characters.`); return; }
    if (attempt.current?.fingerprint !== fingerprint) attempt.current = { fingerprint, requestId: crypto.randomUUID() };
    const recoveryCutoff = lastRecoveryTime.current;
    saving.current = true; setBusy(true);
    try {
      const record = await localApi.save<ScreenplayDraftData>({ id: open.id, kind: DRAFT_KIND, expectedVersion: saved?.version ?? null, requestId: attempt.current.requestId, data });
      setSaved(record as DraftRecord); setConflict(false);
      onSaved(record);
      toast.success(`Saved v${record.version}`);
      // The acknowledged save supersedes our known copies made before this
      // request, including a debounced older body. Later edits and unresolved
      // offers remain intact; conditional deletion protects other clients.
      if (!recovery) {
        if (pendingDisk.current && Date.parse(pendingDisk.current.savedAt) <= recoveryCutoff) pendingDisk.current = null;
        await recoveryQueue.current;
        const copy = diskCopy.current;
        if (copy && Date.parse(copy.savedAt) <= recoveryCutoff) {
          try { const result = await localApi.recovery.remove(open.id, copy.savedAt); if (result.deleted && diskCopy.current === copy) diskCopy.current = null; }
          catch (error) { setRecoveryError(error instanceof Error ? error.message : "Saved, but recovery cleanup failed."); }
        }
      }
    } catch (error) {
      if (error instanceof LocalApiError && error.code === "VERSION_CONFLICT") setConflict(true);
      toast.error(error instanceof Error ? error.message : "Save failed.");
    } finally { saving.current = false; setBusy(false); }
  }, [dirty, fields.body.length, fingerprint, open.id, saved, data, onSaved, recovery]);

  useEffect(() => {
    if (!active) return;
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey)) return;
      const key = event.key.toLowerCase();
      if (key === "s" && !event.shiftKey && tab !== "develop" && tab !== "world") { event.preventDefault(); void save(); }
      if (key === "f" && !event.shiftKey) { event.preventDefault(); setFindOpen(true); setTab("write"); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [save, tab, active]);

  useEffect(() => {
    if (!active || !focusMode) return;
    const exitFocus = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing) return;
      // A dialog, menu, suggestion list or Find owns its own Escape key.
      if (titleOpen || findOpen || document.querySelector('[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]')) return;
      event.preventDefault();
      setFocusMode(false);
      focusToggle.current?.focus();
    };
    window.addEventListener("keydown", exitFocus);
    return () => window.removeEventListener("keydown", exitFocus);
  }, [active, focusMode, titleOpen, findOpen]);

  useEffect(() => {
    if (!active && workspace.current?.contains(document.activeElement)) (document.activeElement as HTMLElement)?.blur();
  }, [active]);

  const reloadLatest = async () => {
    try {
    const latest = (await localApi.history(open.id)).at(-1) as DraftRecord | undefined;
    if (!latest) return;
    const edit = latestEdit.current;
    if (edit.dirty) {
      if (recovery) { toast.error("Restore or discard the existing recovery copy before loading another revision."); return; }
      lastRecoveryTime.current = Math.max(Date.now(), lastRecoveryTime.current + 1);
      const copy: RecoveryCopy = { schema: "caniscreenwrite-local-writer-recovery/v1", draftId: open.id, baseVersion: edit.saved?.version ?? null, baseSha256: edit.saved?.sha256 ?? null, data: edit.data, savedAt: new Date(lastRecoveryTime.current).toISOString() };
      localStorage.setItem(recoveryKey(open.id), JSON.stringify(copy));
      pendingDisk.current = null;
      await queueRecovery(copy);
      if (diskCopy.current?.savedAt !== copy.savedAt) return;
      if (canonicalJson(latestEdit.current.data) !== canonicalJson(edit.data)) { toast.message("You continued editing. Your text is kept; load the revision again when ready."); return; }
      setRecovery(copy);
    }
    setSaved(latest); setConflict(false); attempt.current = null;
    onSaved(latest);
    toast.message(`Loaded v${latest.version}. Your unsaved text is kept as a recovery copy.`);
    setFields(fieldsFromData(latest.data));
    } catch (error) { toast.error(error instanceof Error ? error.message : "Could not load the revision and preserve recovery."); }
  };

  const set = <K extends keyof DraftFields>(key: K, value: Required<DraftFields>[K]) => setFields((current) => ({ ...current, [key]: value }));
  const setBody = (body: string) => set("body", body);
  const jumpTo = (offset: number) => { setTab("write"); setActiveOffset(offset); requestAnimationFrame(() => surface.current?.focusOffset(offset)); };

  const exportAs = useCallback(async (format: "fountain" | "pdf" | "fdx" | "docx" | "txt") => {
    const name = safeFilename(fields.title);
    try {
      if (format === "fountain") downloadText(`${name}.fountain`, fields.body);
      else if (format === "txt") downloadText(`${name}.txt`, paginate(screenplay, { sceneNumbers }).map((page) => pageToText(page, { sceneNumbers })).join("\n\n\f\n"));
      else if (format === "fdx") downloadText(`${name}.fdx`, toFdx(screenplay), "application/xml;charset=utf-8");
      else if (format === "pdf") { const { exportScreenplayPdf } = await import("@/lib/fountain/pdf"); exportScreenplayPdf(fields.body, `${name}.pdf`, { sceneNumbers, revisedBlocks, revisionLabel: baseline ? `Revised against v${baseline.version}` : undefined }); }
      else if (format === "docx") { const { buildScreenplayDocx } = await import("@/lib/fountain/docx"); const blob = await buildScreenplayDocx(fields.body, { sceneNumbers }); const url = URL.createObjectURL(blob); const a = document.createElement("a"); a.href = url; a.download = `${name}.docx`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
    } catch (error) { toast.error(error instanceof Error ? error.message : "Export failed."); }
  }, [fields.title, fields.body, screenplay, sceneNumbers, revisedBlocks, baseline]);

  useEffect(() => {
    if (!active) return;
    const command = (event: Event) => {
      switch ((event as CustomEvent<string>).detail) {
        case "save": if (tab !== "develop" && tab !== "world") void save(); break;
        case "find": setFindOpen(true); setTab("write"); break;
        case "undo": if (tab === "write") surface.current?.undo(); break;
        case "redo": if (tab === "write") surface.current?.redo(); break;
        case "export-pdf": void exportAs("pdf"); break;
      }
    };
    window.addEventListener("writer:command", command);
    return () => window.removeEventListener("writer:command", command);
  }, [save, exportAs, tab, active]);

  const browseFilmcraft = (browse: FilmcraftBrowse) => { setFilmcraftReturn(tab); setFilmcraftBrowse(browse); setTab("filmcraft"); };
  const changeMode = (next: string) => {
    if (next === 'world') setInspectorOpen(false);
    if (next === "filmcraft" && tab === "write") {
      const query = fields.body.slice(Math.min(selection.start, selection.end), Math.max(selection.start, selection.end)).trim().slice(0, 200);
      if (query) setFilmcraftBrowse({ query });
    }
    setTab(next);
  };
  const addFilmcraftResearch = (entryId: string): FilmcraftResearchResult => {
    if (!saved || saved.id !== open.id) return { ok: false, message: "Save this screenplay first to add research." };
    const result = development.current?.addResearch({ projectId: project.id, draftId: open.id, entryId }) ?? { ok: false, message: "Development is not ready. Open Develop and try again." };
    if (result.ok) setTab("develop");
    if (!result.ok) toast.message(result.message);
    return result;
  };

  const stats = useMemo(() => screenplayStats(screenplay, []), [screenplay]);
  const saveStatus = busy ? "Saving…" : conflict ? "Newer revision available" : dirty ? "Unsaved changes" : saved ? `Saved on this Mac · v${saved.version}` : "New draft";
  const developmentMode = !!saved && (tab === 'develop' || tab === 'world');
  const closeInspector = () => { setInspectorOpen(false); inspectorToggle.current?.focus(); };

  return (
    <div ref={workspace} className="lw-workspace" hidden={!active} data-focus={active && focusMode ? "true" : "false"} data-inspector={inspectorVisible ? "open" : "closed"}>
      <div className="lw-workspace-grid">
      <section className="lw-desk">
        <header className="lw-document-header">
          <div className="lw-document-identity">
            <Input className="lw-document-title" value={fields.title} onChange={(event) => set("title", event.target.value)} aria-label="Title" />
            <div className="lw-document-meta">
              <span className="lw-save-status" data-dirty={developmentMode ? developmentState.dirty : dirty} role="status">{developmentMode ? `${tab === 'world' ? 'World & development' : 'Development'} · ${developmentState.status}` : saveStatus}</span>
              {developmentMode && dirty && <span>Screenplay has unsaved changes</span>}
              <span aria-label="Screenplay measures"><span title="Pages in this writer’s formatted preview. Other applications may paginate differently.">{pageCount} formatted pp</span> · {stats.scenes} {stats.scenes === 1 ? "scene" : "scenes"} · <span title={STORY_WORD_COUNT_DESCRIPTION}>{stats.words.toLocaleString()} {stats.words === 1 ? "word" : "words"}</span></span>
            </div>
          </div>
          <div className="lw-document-actions" aria-label="Screenplay actions">
            <Button size="sm" variant="outline" onClick={() => { setFindOpen((value) => !value); setTab("write"); }} aria-label="Find and replace" title="Find & replace (⌘F)"><Search className="h-4 w-4" /></Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild><Button size="sm" variant="outline">Format</Button></DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={() => setTitleOpen(true)}>Title page…</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => { const next = numberScenes(fields.body, !sceneNumbers); setBody(next); setSceneNumbers(!sceneNumbers); }}>{sceneNumbers ? "Remove scene numbers" : "Number scenes"}</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => { const next = toggleDualDialogue(fields.body, selection.start); if (next === null) toast.message("Put the caret in a dialogue block first."); else setBody(next); }}>Toggle dual dialogue (^)</DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuLabel>Insert</DropdownMenuLabel>
                {INSERTS.map(([label, text]) => <DropdownMenuItem key={label} onSelect={() => { setTab("write"); requestAnimationFrame(() => surface.current?.insertAtCursor(text)); }}>{label}</DropdownMenuItem>)}
                <DropdownMenuSeparator />
                <DropdownMenuLabel>Revision marks</DropdownMenuLabel>
                <DropdownMenuItem onSelect={() => setBaseline(null)}>{baseline ? "Off" : "Off ✓"}</DropdownMenuItem>
                {history.slice().reverse().slice(0, 8).map((record) => <DropdownMenuItem key={record.version} onSelect={() => setBaseline(record)}>Against v{record.version}{baseline?.version === record.version ? " ✓" : ""}</DropdownMenuItem>)}
              </DropdownMenuContent>
            </DropdownMenu>
            <DropdownMenu>
              <DropdownMenuTrigger asChild><Button size="sm" variant="outline" title="Export" aria-label="Export screenplay"><Download className="h-4 w-4" /></Button></DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={() => exportAs("pdf")}>PDF (industry layout)</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => exportAs("fdx")}>Final Draft (.fdx)</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => exportAs("docx")}>Word (.docx)</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => exportAs("fountain")}>Fountain (.fountain)</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => exportAs("txt")}>Plain text, paginated (.txt)</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <Button size="sm" onClick={() => developmentMode ? development.current?.save() : void save()} disabled={developmentMode ? !developmentState.canSave : busy || !dirty} title={developmentMode ? 'Save world and development (⌘S)' : 'Save screenplay (⌘S)'}><Save className="h-4 w-4 mr-1" />{!developmentMode && busy ? "Saving…" : "Save"}</Button>
            <span className="lw-action-divider" aria-hidden="true" />
            <Button ref={inspectorToggle} size="sm" variant="ghost" aria-label="Inspector" title="Scenes, details and connections" aria-expanded={inspectorVisible} aria-controls={inspectorId} onClick={() => { setFocusMode(false); setInspectorOpen(!inspectorVisible); }}><PanelRight className="h-4 w-4" aria-hidden="true" /><span className="lw-inspector-label">Inspector</span></Button>
            <Button ref={focusToggle} size="sm" variant="ghost" aria-label={focusMode ? "Exit focus mode" : "Focus mode"} title={focusMode ? "Exit focus mode (Esc)" : "Focus on writing"} aria-pressed={focusMode} onClick={() => { setFocusMode(value => !value); setTab("write"); }}>{focusMode ? <Minimize2 className="h-4 w-4" aria-hidden="true" /> : <Maximize2 className="h-4 w-4" aria-hidden="true" />}<span>{focusMode ? "Exit focus" : "Focus"}</span></Button>
          </div>
        </header>
        {recovery && (
          <div className="px-3 py-2 text-sm bg-amber-950/40 border-b border-amber-700/40 flex gap-2 items-center flex-wrap">
            <span>Unsaved work from {new Date(recovery.savedAt).toLocaleString()} was found on this Mac.</span>
            <Button size="sm" variant="secondary" onClick={() => { setFields(fieldsFromData(recovery.data)); setRecovery(null); }}>Restore</Button>
            <Button size="sm" variant="ghost" onClick={() => void discardRecovery()}>Discard</Button>
          </div>
        )}
        {recoveryError && <div className="px-3 py-2 text-sm"><p role="alert" className="text-destructive">{recoveryError}</p><Button type="button" size="sm" variant="outline" onClick={() => setRecoveryCheck(value => value + 1)}>Retry recovery check</Button></div>}
        {conflict && (
          <div className="px-3 py-2 text-sm bg-destructive/20 border-b border-destructive/40 flex gap-2 items-center flex-wrap">
            <span>A newer revision of this draft exists in the workspace. Your text is unchanged here.</span>
            <Button size="sm" variant="secondary" onClick={reloadLatest}>Load latest revision</Button>
          </div>
        )}
        {findOpen && <FindReplace text={fields.body} onReplace={setBody} onFocus={(start, end) => { setTab("write"); surface.current?.focusRange(start, end); }} onClose={() => setFindOpen(false)} />}
        <Tabs value={tab} onValueChange={changeMode} className="lw-workspace-tabs">
          <TabsList className="lw-workspace-modes" aria-label="Workspace modes" hidden={focusMode}>
            <TabsTrigger value="write"><PenLine aria-hidden="true" />Write</TabsTrigger>
            <TabsTrigger value="develop"><Lightbulb aria-hidden="true" />Develop</TabsTrigger>
            <TabsTrigger value="world"><Globe2 aria-hidden="true" />World Builder</TabsTrigger>
            <TabsTrigger value="filmcraft"><BookOpen aria-hidden="true" />Film language</TabsTrigger>
            <TabsTrigger value="preview"><Eye aria-hidden="true" />Preview</TabsTrigger>
            <TabsTrigger value="cards"><LayoutGrid aria-hidden="true" />Cards</TabsTrigger>
            <TabsTrigger value="reports"><BarChart3 aria-hidden="true" />Reports</TabsTrigger>
            <TabsTrigger value="brands"><BarChart3 aria-hidden="true" />Brands & financing</TabsTrigger>
            <TabsTrigger value="services"><Lightbulb aria-hidden="true" />Scoring & profiles</TabsTrigger>
            <TabsTrigger value="history" aria-label="History"><History aria-hidden="true" />History{saved ? <span className="lw-mode-count" aria-hidden="true">{saved.version}</span> : null}</TabsTrigger>
          </TabsList>
          <TabsContent value="write" className="flex-1 min-h-0 overflow-auto p-3" forceMount hidden={tab !== "write"}>
            <ScreenplayWritingSurface ref={surface} value={fields.body} onChange={setBody} onSave={() => { if (active) void save(); }} onSelectionChange={(next) => { setSelection(next); setActiveOffset(next.start); }} revisedLineStarts={revisedStarts} />
          </TabsContent>
          <TabsContent value={tab === "world" ? "world" : "develop"} className="flex-1 min-h-0 overflow-auto p-3" forceMount hidden={tab !== "develop" && tab !== "world"}>
            {saved ? <DevelopmentPanel ref={development} focusElement={worldFocus} onWorldChange={setDraftWorld} onOpenDraft={onOpenDraft} active={active && (tab === "develop" || tab === "world")} view={tab === "world" ? "world" : "develop"} onStateChange={setDevelopmentState} worldContext={worldSources} onJump={jumpTo} projectId={project.id} draftId={open.id} initialRecord={records.find((record) => isDevelopmentRecord(record, project.id, open.id))} onSaved={onSaved} onBrowseFilmcraft={browseFilmcraft} /> : <div className="p-5 text-sm"><h2 className="mb-2 font-semibold">{tab === 'world' ? 'Start your world' : 'Start developing your story'}</h2><p className="mb-4 text-muted-foreground">Save this screenplay once to give its world and development notes a home on this Mac.</p><Button type="button" size="sm" disabled={busy || !!recovery} onClick={() => void save()}>Save screenplay to begin</Button></div>}
          </TabsContent>
          <TabsContent value="filmcraft" className="flex-1 min-h-0 overflow-auto p-4" forceMount hidden={tab !== "filmcraft"}>
            {filmcraftReturn && <Button type="button" size="sm" variant="ghost" className="mb-3" onClick={() => setTab(filmcraftReturn)}>Back to {filmcraftReturn === 'world' ? 'World Builder' : filmcraftReturn === 'develop' ? 'Develop' : 'Write'}</Button>}
            <FilmcraftPanel active={active && tab === "filmcraft"} browse={filmcraftBrowse} canAddResearch={!!saved} onAddResearch={addFilmcraftResearch} />
          </TabsContent>
          <TabsContent value="preview" className="flex-1 min-h-0 overflow-auto p-3">
            <PreviewPane text={fields.body} sceneNumbers={sceneNumbers} revisedBlocks={revisedBlocks} onJump={jumpTo} />
          </TabsContent>
          <TabsContent value="cards" className="flex-1 min-h-0 overflow-auto p-3">
            <CardsBoard text={fields.body} onChange={setBody} onOpenScene={jumpTo} />
          </TabsContent>
          <TabsContent value="reports" className="flex-1 min-h-0 overflow-auto p-3">
            <ReportsPanel text={fields.body} title={fields.title} sceneNumbers={sceneNumbers} />
          </TabsContent>
          <TabsContent value="history" className="flex-1 min-h-0 overflow-auto p-3">
            <HistoryPanel draftId={open.id} saved={saved} currentBody={fields.body} onRestore={(body) => { setBody(body); toast.message("Restored into the editor. Save to keep it as a new revision."); }} />
          </TabsContent>
          <TabsContent value="brands" className="flex-1 min-h-0 overflow-auto p-3" forceMount hidden={tab !== 'brands'}>
            <BrandPlanningPanel key={open.id} draft={saved} dirty={dirty} active={active && tab === 'brands'} onSaved={onSaved}/>
          </TabsContent>
          <TabsContent value="services" className="flex-1 min-h-0 overflow-auto p-3" forceMount hidden={tab !== 'services'}>
            {tab === 'services' && <CreativeServicesPanel draft={saved} dirty={dirty} />}
          </TabsContent>
        </Tabs>
      </section>
      <aside id={inspectorId} className="lw-inspector" aria-label="Screenplay inspector" hidden={!inspectorVisible}>
        <div className="lw-inspector-heading"><span>Inspector</span><Button size="sm" variant="ghost" aria-label="Close inspector" onClick={closeInspector}><X className="h-4 w-4" aria-hidden="true" /></Button></div>
        <Tabs defaultValue="scenes" className="p-3">
          <TabsList className="w-full">
            <TabsTrigger value="scenes" className="flex-1">Scenes</TabsTrigger>
            <TabsTrigger value="details" className="flex-1">Details</TabsTrigger>
            <TabsTrigger value="connect" className="flex-1">Connect</TabsTrigger>
          </TabsList>
          <TabsContent value="scenes"><SceneNavigator fountainText={fields.body} parsed={parsed} screenplay={screenplay} onJump={jumpTo} activeOffset={activeOffset} baselineKey={saved?.sha256 ?? null} />
            {draftWorld && <section className="lw-scene-world" aria-label="World in this scene"><h3>World in this scene</h3><p>{activeScene?.heading || 'Select a scene to see its connections.'}</p>{sceneWorldElements.length ? sceneWorldElements.map(element => <button type="button" key={element.id} onClick={() => { setWorldFocus(previous => ({ id: element.id, nonce: (previous?.nonce ?? 0) + 1 })); setTab('world'); setInspectorOpen(false); }}><Globe2 aria-hidden="true" /><span>{element.name || 'Untitled element'}</span></button>) : <p>Connect world elements to this scene or its character cues in World Builder.</p>}</section>}
          </TabsContent>
          <TabsContent value="details" className="flex flex-col gap-3">
            <label className="text-sm flex flex-col gap-1">Logline<textarea className="rounded-md border border-input bg-background p-2 text-sm min-h-20" value={fields.logline} maxLength={1000} onChange={(event) => set("logline", event.target.value)} /></label>
            <label className="text-sm flex flex-col gap-1">Genre<Input value={fields.genre} maxLength={120} onChange={(event) => set("genre", event.target.value)} /></label>
            <label className="text-sm flex flex-col gap-1">Format
              <select className="h-9 rounded-md border border-input bg-background px-2 text-sm" value={fields.projectFormat} onChange={(event) => set("projectFormat", event.target.value as AuthoringFormat | "")}>
                <option value="">Not set</option>
                {(Object.keys(FORMAT_LABELS) as AuthoringFormat[]).map((key) => <option key={key} value={key}>{FORMAT_LABELS[key]}</option>)}
              </select>
            </label>
            <label className="text-sm flex flex-col gap-1">Target pages<Input type="number" min={1} max={1000} value={fields.targetPages} onChange={(event) => set("targetPages", event.target.value === "" ? "" : Number(event.target.value))} /></label>
            <Button size="sm" variant="outline" onClick={() => setTitleOpen(true)}><FileText className="h-4 w-4 mr-1" />Title page…</Button>
            <div className="text-xs text-muted-foreground flex flex-col gap-1">
              <span>Record: <code>{open.id}</code></span>
              {saved && <span>Revision hash: <code>{saved.sha256.slice(0, 16)}…</code></span>}
              {links.map((link) => <Badge key={link.id} variant="outline" className="w-fit">{link.data.target === "qimovi" ? "In QiMovi" : "On competition system"} · v{link.data.draftVersion}</Badge>)}
            </div>
            <ImportedSourcePanel draftId={open.id} records={records} />
          </TabsContent>
          <TabsContent value="connect" className="flex flex-col gap-4">
            <QiMoviPanel draft={saved} dirty={dirty} links={links} onChanged={onRecordsChanged} onOpenDraft={onOpenDraft} development={records.find((record) => isDevelopmentRecord(record, project.id, open.id)) as import("../development").DevelopmentRecord | undefined} developmentDirty={developmentState.dirty} />
            {competitionEnabled ? <Suspense fallback={<p className="text-xs text-muted-foreground">Loading competition connector…</p>}>
              <CompetitionPanel project={project} draft={saved} dirty={dirty} links={links} onChanged={onRecordsChanged} />
            </Suspense> : <Button variant="outline" onClick={() => setCompetitionEnabled(true)}>Enable online competition</Button>}
          </TabsContent>
        </Tabs>
      </aside>
      </div>
      <TitlePageDialog open={active && titleOpen} text={fields.body} onClose={() => setTitleOpen(false)} onApply={setBody} />
    </div>
  );
}
