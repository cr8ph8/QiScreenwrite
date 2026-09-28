import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { getTitlePage, setTitlePage } from "@/lib/fountain/serialize";
import type { TitleEntry } from "@/lib/fountain/spec";

interface Props { open: boolean; text: string; onClose: () => void; onApply: (next: string) => void }

const MULTILINE = new Set(["Contact", "Notes", "Copyright"]);

/** Final Draft-style title page form. Writes the Fountain title page block at the top of the draft. */
export function TitlePageDialog({ open, text, onClose, onApply }: Props) {
  const [entries, setEntries] = useState<TitleEntry[]>([]);
  useEffect(() => { if (open) setEntries(getTitlePage(text)); }, [open, text]);
  const update = (index: number, value: string) => setEntries((current) => current.map((entry, position) => (position === index ? { ...entry, value } : entry)));
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
        <DialogHeader><DialogTitle>Title page</DialogTitle><DialogDescription>Printed as the first page of PDF, DOCX and Final Draft exports. Leave a field blank to omit it.</DialogDescription></DialogHeader>
        <form className="grid gap-3" onSubmit={(event) => { event.preventDefault(); onApply(setTitlePage(text, entries)); onClose(); }}>
          {entries.map((entry, index) => (
            <label key={index} className="grid gap-1 text-sm">
              <span className="text-muted-foreground">{entry.key}</span>
              {MULTILINE.has(entry.key) || entry.value.includes("\n")
                ? <textarea className="rounded-md border border-input bg-background p-2 text-sm min-h-16" value={entry.value} onChange={(event) => update(index, event.target.value)} />
                : <Input value={entry.value} onChange={(event) => update(index, event.target.value)} placeholder={entry.key === "Credit" ? "Written by" : entry.key === "Draft date" ? new Date().toISOString().slice(0, 10) : ""} />}
            </label>
          ))}
          <DialogFooter><Button type="button" variant="ghost" onClick={onClose}>Cancel</Button><Button type="submit">Apply to draft</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
