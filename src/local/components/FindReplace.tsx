import { useEffect, useMemo, useState } from "react";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { findAll, replaceAll } from "@/lib/fountain/serialize";

interface Props { text: string; onReplace: (next: string) => void; onFocus: (start: number, end: number) => void; onClose: () => void }

export function FindReplace({ text, onReplace, onFocus, onClose }: Props) {
  const [query, setQuery] = useState("");
  const [replacement, setReplacement] = useState("");
  const [matchCase, setMatchCase] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [cursor, setCursor] = useState(-1);
  const hits = useMemo(() => findAll(text, query, { matchCase, wholeWord }), [text, query, matchCase, wholeWord]);
  useEffect(() => { setCursor(-1); }, [query, matchCase, wholeWord]);
  const current = hits.length ? hits[Math.max(0, Math.min(cursor, hits.length - 1))] : null;
  const go = (delta: number) => {
    if (!hits.length) return;
    const next = cursor < 0 ? (delta > 0 ? 0 : hits.length - 1) : (Math.min(cursor, hits.length - 1) + delta + hits.length) % hits.length;
    setCursor(next); onFocus(hits[next].start, hits[next].end);
  };
  const replaceOne = () => {
    if (!current) return;
    onReplace(text.slice(0, current.start) + replacement + text.slice(current.end));
  };
  return (
    <div className="flex flex-wrap items-center gap-2 px-3 py-2 border-b border-border text-sm bg-muted/40" role="search">
      <Input className="w-44 h-8" aria-label="Find" placeholder="Find" value={query} autoFocus onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); go(event.shiftKey ? -1 : 1); } if (event.key === "Escape") onClose(); }} />
      <Input className="w-44 h-8" aria-label="Replace with" placeholder="Replace with" value={replacement} onChange={(event) => setReplacement(event.target.value)} />
      <label className="flex items-center gap-1 text-xs"><input type="checkbox" checked={matchCase} onChange={(event) => setMatchCase(event.target.checked)} />Match case</label>
      <label className="flex items-center gap-1 text-xs"><input type="checkbox" checked={wholeWord} onChange={(event) => setWholeWord(event.target.checked)} />Whole word</label>
      <span className="text-xs text-muted-foreground w-16">{hits.length ? cursor < 0 ? `${hits.length} found` : `${Math.min(cursor, hits.length - 1) + 1} of ${hits.length}` : query ? "0 found" : ""}</span>
      <Button size="sm" variant="outline" className="h-8" disabled={!hits.length} onClick={() => go(-1)}>Prev</Button>
      <Button size="sm" variant="outline" className="h-8" disabled={!hits.length} onClick={() => go(1)}>Next</Button>
      <Button size="sm" variant="outline" className="h-8" disabled={!current} onClick={replaceOne}>Replace</Button>
      <Button size="sm" variant="outline" className="h-8" disabled={!hits.length} onClick={() => onReplace(replaceAll(text, query, replacement, { matchCase, wholeWord }).text)}>Replace all</Button>
      <Button size="sm" variant="ghost" className="h-8 ml-auto" onClick={onClose} aria-label="Close find"><X className="h-4 w-4" /></Button>
    </div>
  );
}
