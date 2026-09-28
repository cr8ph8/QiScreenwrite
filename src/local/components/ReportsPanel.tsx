import { useMemo } from "react";
import { Button } from "@/components/ui/button";
import { paginate } from "@/lib/fountain/paginate";
import { characterReport, locationReport, reportCsv, sceneReport, screenplayStats, STORY_WORD_COUNT_DESCRIPTION } from "@/lib/fountain/reports";
import { parseScreenplay } from "@/lib/fountain/spec";
import { downloadText, safeFilename } from "../model";

interface Props { text: string; title: string; sceneNumbers: boolean }

export function ReportsPanel({ text, title, sceneNumbers }: Props) {
  const screenplay = useMemo(() => parseScreenplay(text), [text]);
  const pages = useMemo(() => paginate(screenplay, { sceneNumbers }), [screenplay, sceneNumbers]);
  const stats = screenplayStats(screenplay, pages);
  const characters = characterReport(screenplay);
  const scenes = sceneReport(screenplay, pages);
  const locations = locationReport(screenplay);
  const csv = (name: string, rows: Record<string, unknown>[]) => downloadText(`${safeFilename(title)}-${name}.csv`, reportCsv(rows), "text/csv;charset=utf-8");
  return (
    <div className="flex flex-col gap-5 text-sm">
      <section className="grid grid-cols-2 md:grid-cols-4 gap-2">
        {[["Formatted pages", stats.pages], ["Scenes", stats.scenes], ["Words", stats.words.toLocaleString()], ["Characters", stats.characters], ["Dialogue", `${Math.round(stats.dialogueShare * 100)}%`], ["Action words", stats.actionWords.toLocaleString()], ["Dialogue words", stats.dialogueWords.toLocaleString()], ["Page-based minutes", `${stats.estimatedMinutes} min`]].map(([label, value]) => (
          <div key={String(label)} className="rounded-md border border-border p-2"><div className="text-xs text-muted-foreground">{label}</div><div className="text-lg font-semibold">{value}</div></div>
        ))}
      </section>
      <p className="text-xs text-muted-foreground">{STORY_WORD_COUNT_DESCRIPTION} Pages follow this writer’s formatted preview. One page per minute is a planning estimate, not a measured running time.</p>
      <Report title="Characters" onCsv={() => csv("characters", characters as unknown as Record<string, unknown>[])} head={["Character", "Speeches", "Words", "Scenes"]} rows={characters.map((row) => [row.name, row.speeches, row.words, row.scenes.join(", ")])} />
      <Report title="Scenes" onCsv={() => csv("scenes", scenes as unknown as Record<string, unknown>[])} head={["#", "Heading", "Page", "Length", "Characters"]} rows={scenes.map((row) => [row.sceneNumber ?? row.index, row.heading, row.page ?? "", `${row.eighths}/8`, row.characters.join(", ")])} />
      <Report title="Locations" onCsv={() => csv("locations", locations as unknown as Record<string, unknown>[])} head={["Location", "Int/Ext", "Scenes"]} rows={locations.map((row) => [row.location, row.intExt.join("/"), row.scenes.join(", ")])} />
    </div>
  );
}

function Report({ title, head, rows, onCsv }: { title: string; head: string[]; rows: (string | number)[][]; onCsv: () => void }) {
  return (
    <section>
      <div className="flex items-center gap-2 mb-1"><h3 className="font-medium">{title}</h3><Button size="sm" variant="ghost" className="h-7 ml-auto" onClick={onCsv} disabled={!rows.length}>CSV</Button></div>
      <div className="overflow-auto rounded-md border border-border">
        <table className="w-full text-xs">
          <thead className="bg-muted/50"><tr>{head.map((cell) => <th key={cell} className="text-left px-2 py-1 font-medium">{cell}</th>)}</tr></thead>
          <tbody>{rows.map((row, index) => <tr key={index} className="border-t border-border/60">{row.map((cell, cellIndex) => <td key={cellIndex} className="px-2 py-1 align-top">{cell}</td>)}</tr>)}{!rows.length && <tr><td className="px-2 py-2 text-muted-foreground" colSpan={head.length}>Nothing yet.</td></tr>}</tbody>
        </table>
      </div>
    </section>
  );
}
