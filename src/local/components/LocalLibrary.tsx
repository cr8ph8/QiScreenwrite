import { useId, useMemo, useState } from "react";
import { ArrowRight, FilePlus2, FileText, RotateCcw, Search, Upload } from "lucide-react";
import { parseScreenplay } from "@/lib/fountain/spec";
import { screenplayStats, STORY_WORD_COUNT_DESCRIPTION } from "@/lib/fountain/reports";
import { canonicalJson, FORMAT_LABELS, isDraft, TEMPLATES, type RecoveryCopy } from "../model";
import type { DraftRecord, ScreenplayDraftData, WorkspaceRecord } from "../types";
import "./local-library.css";

export interface LocalLibraryProps {
  drafts: DraftRecord[];
  records: WorkspaceRecord[];
  recoveries: RecoveryCopy[];
  onOpen: (draft: DraftRecord) => void;
  onRecover: (copy: RecoveryCopy) => void;
  onNew: (templateId: string) => void;
  onImport: () => void;
  view: "drafts" | "templates";
}

const descriptions: Record<string, string> = {
  blank: "An empty Fountain document. Make room for your own structure.",
  short: "Scene headings, action and dialogue, with opening and closing cues to get you started.",
  pilot_30: "A cold open, two acts and a tag, with editable starter scenes.",
  feature: "Three act headings and starter scenes for a feature screenplay.",
};
const identity = (id: string, data: ScreenplayDraftData) => `${data.projectId}/${id}`;
const titleOrder = (a: { data: ScreenplayDraftData }, b: { data: ScreenplayDraftData }) =>
  a.data.title.localeCompare(b.data.title, undefined, { sensitivity: "base", numeric: true });
const formatLabel = (data: ScreenplayDraftData) => data.projectFormat ? FORMAT_LABELS[data.projectFormat] : "Format not set";

function DraftDetails({ data, revision }: { data: ScreenplayDraftData; revision: string }) {
  // Use the local Fountain reader: title pages and discarded notes are not scenes.
  const stats = useMemo(() => screenplayStats(parseScreenplay(data.body), []), [data.body]);
  return <>
    <p className={`local-library-logline${data.logline ? "" : " local-library-placeholder"}`}>{data.logline || "No logline yet."}</p>
    <ul className="local-library-metadata" aria-label="Draft details">
      <li className="local-library-format">{formatLabel(data)}</li>
      <li>{stats.scenes.toLocaleString()} {stats.scenes === 1 ? "scene" : "scenes"}</li>
      <li title={STORY_WORD_COUNT_DESCRIPTION}>{stats.words.toLocaleString()} {stats.words === 1 ? "word" : "words"}</li>
      <li>{revision}</li>
    </ul>
  </>;
}

/** Full-page, offline library. All opening, importing and creation stays with the host. */
export function LocalLibrary({ drafts, records, recoveries, onOpen, onRecover, onNew, onImport, view }: LocalLibraryProps) {
  const headingId = useId();
  const searchId = useId();
  const formatId = useId();
  const [query, setQuery] = useState("");
  const [format, setFormat] = useState("all");
  const sortedDrafts = useMemo(() => [...drafts].sort((a, b) => titleOrder(a, b) || a.id.localeCompare(b.id)), [drafts]);
  const recoveryState = useMemo(() => {
    const saved = new Map<string, DraftRecord>();
    for (const draft of [...records.filter(isDraft), ...drafts]) {
      const key = identity(draft.id, draft.data);
      if (!saved.has(key) || saved.get(key)!.version < draft.version) saved.set(key, draft);
    }
    const newest = new Map<string, RecoveryCopy>();
    for (const copy of recoveries) {
      const key = identity(copy.draftId, copy.data);
      const prior = newest.get(key);
      if (!prior || (Date.parse(copy.savedAt) || 0) > (Date.parse(prior.savedAt) || 0)) newest.set(key, copy);
    }
    // A saved-equivalent copy has nothing to restore. Never-saved copies may
    // contain only meaningful title/format/logline metadata, so retain them.
    for (const [key, copy] of newest) {
      const draft = saved.get(key);
      if (draft && canonicalJson(copy.data) === canonicalJson(draft.data)) newest.delete(key);
    }
    const displayed = new Set(drafts.map((draft) => identity(draft.id, draft.data)));
    return {
      newest,
      separate: [...newest.entries()].filter(([key]) => !displayed.has(key)).map(([, copy]) => ({ copy, saved: saved.get(identity(copy.draftId, copy.data)) })).sort((a, b) => titleOrder(a.copy, b.copy) || a.copy.draftId.localeCompare(b.copy.draftId)),
    };
  }, [drafts, records, recoveries]);
  const needle = query.trim().toLocaleLowerCase();
  const matches = (data: ScreenplayDraftData) =>
    (format === "all" || (data.projectFormat ?? "unset") === format) &&
    (!needle || `${data.title} ${data.logline ?? ""} ${data.genre ?? ""} ${formatLabel(data)}`.toLocaleLowerCase().includes(needle));
  const visibleDrafts = sortedDrafts.filter((draft) => matches(draft.data));
  const visibleRecoveries = recoveryState.separate.filter(({ copy }) => matches(copy.data));
  const empty = drafts.length === 0 && recoveryState.separate.length === 0;
  const filtered = Boolean(needle) || format !== "all";
  const clearFilters = () => { setQuery(""); setFormat("all"); };
  const newAndImport = <>
    <button type="button" className="local-library-button local-library-primary" onClick={() => onNew("blank")}><FilePlus2 aria-hidden="true" />New draft</button>
    <button type="button" className="local-library-button" onClick={() => onImport()}><Upload aria-hidden="true" />Import screenplay</button>
  </>;

  return <section className="local-library" aria-labelledby={headingId}>
    <div className="local-library-content">
      <header className="local-library-header">
        <div>
          <p className="local-library-eyebrow">Your local studio</p>
          <h1 id={headingId}>{view === "templates" ? "Templates" : "My Drafts"}</h1>
          <p className="local-library-intro">{view === "templates" ? "A starting point for your next screenplay. Every template is editable." : "Saved drafts and recovery copies on this Mac."}</p>
        </div>
        {view === "drafts" && !empty && <div className="local-library-actions">{newAndImport}</div>}
      </header>

      {view === "templates" ? <>
        <div className="local-library-section-heading"><h2>Start with a structure</h2><span>{TEMPLATES.length} local templates</span></div>
        <ul className="local-library-rows" aria-label="Screenplay templates">
          {TEMPLATES.map((template, index) => <li className="local-library-row local-library-template" key={template.id}>
            <span className="local-library-template-number" aria-hidden="true">{String(index + 1).padStart(2, "0")}</span>
            <div className="local-library-row-content">
              <h3>{template.label}</h3>
              <p className="local-library-logline">{descriptions[template.id] ?? "An editable local screenplay template."}</p>
              <span className="local-library-format">{FORMAT_LABELS[template.projectFormat]}</span>
            </div>
            <button type="button" className="local-library-button" aria-label={`Use ${template.label} template`} onClick={() => onNew(template.id)}>Use template<ArrowRight aria-hidden="true" /></button>
          </li>)}
        </ul>
        <p className="local-library-footnote">Available offline. A template opens a new draft for you to write and save.</p>
      </> : empty ? <div className="local-library-empty">
        <FileText className="local-library-empty-icon" aria-hidden="true" />
        <h2>Create your first screenplay</h2>
        <p>Start a blank draft or bring in a screenplay you already have.</p>
        <div className="local-library-actions">{newAndImport}</div>
        <p className="local-library-footnote">Import Fountain, plain text or Final Draft (.fdx).</p>
      </div> : <>
        <div className="local-library-filters" role="search" aria-label="Find a screenplay">
          <div className="local-library-search">
            <label className="local-library-sr-only" htmlFor={searchId}>Search drafts</label>
            <Search aria-hidden="true" />
            <input id={searchId} type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search titles, loglines or genres" />
          </div>
          <div className="local-library-format-filter">
            <label htmlFor={formatId}>Format</label>
            <select id={formatId} value={format} onChange={(event) => setFormat(event.target.value)}>
              <option value="all">All formats</option>
              {Object.entries(FORMAT_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              <option value="unset">Format not set</option>
            </select>
          </div>
        </div>
        <div className="local-library-results">
          <p role="status">{visibleDrafts.length} saved {visibleDrafts.length === 1 ? "draft" : "drafts"}{visibleRecoveries.length > 0 ? ` · ${visibleRecoveries.length} recovery ${visibleRecoveries.length === 1 ? "copy" : "copies"}` : ""}{filtered ? " matching your filters" : ""}</p>
          <span>Title A–Z</span>
        </div>

        {visibleRecoveries.length > 0 && <section className="local-library-recoveries" aria-label="Recovery copies">
          <div className="local-library-section-heading"><h2><RotateCcw aria-hidden="true" />Recovery copies</h2></div>
          <p className="local-library-section-intro">Unsaved work kept on this Mac. Open a copy to review it before saving.</p>
          <ul className="local-library-rows" aria-label="Draft recovery copies">
            {visibleRecoveries.map(({ copy, saved }) => <li className="local-library-row" key={identity(copy.draftId, copy.data)}>
              <div className="local-library-row-content">
                <h3>{copy.data.title}</h3>
                <DraftDetails data={copy.data} revision={copy.baseVersion !== null ? `Based on revision ${copy.baseVersion}` : saved ? "Unsaved recovery copy" : "Never saved"} />
              </div>
              <button type="button" className="local-library-button" aria-label={`Recover ${copy.data.title}`} onClick={() => onRecover(copy)}>Recover draft<ArrowRight aria-hidden="true" /></button>
            </li>)}
          </ul>
        </section>}

        {visibleDrafts.length > 0 && <section aria-label="Saved drafts">
          <div className="local-library-section-heading"><h2>Saved drafts</h2></div>
          <ul className="local-library-rows" aria-label="Saved screenplays">
            {visibleDrafts.map((draft) => {
              const recovery = recoveryState.newest.get(identity(draft.id, draft.data));
              return <li className="local-library-row" key={identity(draft.id, draft.data)}>
                <div className="local-library-row-content">
                  <h3>{draft.data.title}</h3>
                  <DraftDetails data={draft.data} revision={`Revision ${draft.version}`} />
                </div>
                <div className="local-library-row-actions">
                  <button type="button" className="local-library-button local-library-open" aria-label={`Open ${draft.data.title}`} onClick={() => onOpen(draft)}>Open draft<ArrowRight aria-hidden="true" /></button>
                  {recovery && <button type="button" className="local-library-recover-link" aria-label={`Recover unsaved work for ${draft.data.title}`} onClick={() => onRecover(recovery)}><RotateCcw aria-hidden="true" />Unsaved work</button>}
                </div>
              </li>;
            })}
          </ul>
        </section>}
        {visibleDrafts.length === 0 && visibleRecoveries.length === 0 && <div className="local-library-no-results">
          <h2>No matching drafts</h2>
          <p>Try another title, logline, genre or format.</p>
          <button type="button" className="local-library-button" onClick={clearFilters}>Clear filters</button>
        </div>}
      </>}
    </div>
  </section>;
}
