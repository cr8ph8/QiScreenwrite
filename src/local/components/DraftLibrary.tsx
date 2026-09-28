import { useRef, useState } from "react";
import { FilePlus2, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { TEMPLATES, linksFor } from "../model";
import type { DraftRecord, WorkspaceRecord } from "../types";

interface Props {
  drafts: DraftRecord[];
  records: WorkspaceRecord[];
  activeId: string | null;
  onOpen: (draft: DraftRecord) => void;
  onNew: (templateId: string) => void;
  onImport: (file: File) => void;
}

export function DraftLibrary({ drafts, records, activeId, onOpen, onNew, onImport }: Props) {
  const [query, setQuery] = useState("");
  const [template, setTemplate] = useState(TEMPLATES[0].id);
  const fileInput = useRef<HTMLInputElement>(null);
  const needle = query.trim().toLowerCase();
  const visible = needle ? drafts.filter((draft) => `${draft.data.title} ${draft.data.genre ?? ""} ${draft.data.logline ?? ""}`.toLowerCase().includes(needle)) : drafts;
  return (
    <div className="flex flex-col gap-3 p-3">
      <div className="flex gap-2">
        <select className="flex-1 h-9 rounded-md border border-input bg-background px-2 text-sm" value={template} onChange={(event) => setTemplate(event.target.value)} aria-label="Template">
          {TEMPLATES.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
        </select>
        <Button size="sm" onClick={() => onNew(template)} title="New draft"><FilePlus2 className="h-4 w-4 mr-1" />New</Button>
      </div>
      <Button size="sm" variant="outline" onClick={() => fileInput.current?.click()}><Upload className="h-4 w-4 mr-1" />Import .fountain / .fdx</Button>
      <input ref={fileInput} type="file" accept=".fountain,.txt,.fdx,text/plain,application/xml" className="hidden" onChange={(event) => { const file = event.target.files?.[0]; if (file) onImport(file); event.target.value = ""; }} />
      <Input placeholder="Search drafts" value={query} onChange={(event) => setQuery(event.target.value)} />
      <ul className="flex flex-col gap-1" aria-label="Drafts">
        {visible.length === 0 && <li className="text-sm text-muted-foreground px-2 py-4">{drafts.length ? "No drafts match." : "No drafts yet."}</li>}
        {visible.map((draft) => {
          const links = linksFor(records, draft.id);
          const active = draft.id === activeId;
          return (
            <li key={draft.id}>
              <button type="button" onClick={() => onOpen(draft)} aria-current={active ? "true" : undefined} className={`w-full text-left rounded-md px-2 py-2 hover:bg-muted transition-colors ${active ? "bg-muted ring-1 ring-primary/40" : ""}`}>
                <div className="font-medium truncate">{draft.data.title}</div>
                <div className="text-xs text-muted-foreground flex gap-2 flex-wrap items-center">
                  <span>v{draft.version}</span>
                  {draft.data.projectFormat && <span>{draft.data.projectFormat}</span>}
                  {links.map((link) => <Badge key={link.id} variant="outline" className="text-[10px] px-1 py-0">{link.data.target === "qimovi" ? "QiMovi" : "Competition"}{link.data.draftVersion !== draft.version ? " ·stale" : ""}</Badge>)}
                </div>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
