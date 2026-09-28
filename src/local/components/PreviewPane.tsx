import { useMemo } from "react";
import { paginate, PAGE_WIDTH, type PageLine } from "@/lib/fountain/paginate";
import { parseScreenplay } from "@/lib/fountain/spec";

interface Props { text: string; sceneNumbers: boolean; revisedBlocks?: ReadonlySet<number>; onJump?: (offset: number) => void }

function lineText(line: PageLine): string {
  const pad = line.align === "right" ? " ".repeat(Math.max(0, line.col + line.width - line.text.length)) + line.text
    : line.align === "center" ? " ".repeat(Math.max(0, line.col + Math.floor((line.width - line.text.length) / 2))) + line.text
    : " ".repeat(line.col) + line.text;
  return line.dual ? pad.padEnd(line.dual.col) + line.dual.text : pad;
}

/** Print preview: exactly the lines the PDF will print, page by page, in Courier at 10 characters per inch. */
export function PreviewPane({ text, sceneNumbers, revisedBlocks, onJump }: Props) {
  const screenplay = useMemo(() => parseScreenplay(text), [text]);
  const pages = useMemo(() => paginate(screenplay, { sceneNumbers }), [screenplay, sceneNumbers]);
  const title = screenplay.title;
  const get = (key: string) => title.find((entry) => entry.key.toLowerCase() === key)?.value ?? "";
  return (
    <div className="lw-preview">
      {title.length > 0 && (
        <div className="lw-print-page" aria-label="Title page">
          <div className="lw-print-title">
            <div className="lw-print-title-main">
              <div>{get("title").toUpperCase()}</div>
              {get("credit") && <div className="mt-6">{get("credit")}</div>}
              {(get("author") || get("authors")) && <div className="mt-2">{get("author") || get("authors")}</div>}
              {get("source") && <div className="mt-2">{get("source")}</div>}
            </div>
            <div className="lw-print-title-foot">{["draft date", "revision", "copyright", "contact", "notes"].map((key) => get(key) && <div key={key} className="whitespace-pre-wrap">{get(key)}</div>)}</div>
          </div>
        </div>
      )}
      {pages.map((page) => (
        <div key={page.number} className="lw-print-page" aria-label={`Page ${page.number}`}>
          {page.number > 1 && <div className="lw-print-number">{page.number}.</div>}
          <div className="lw-print-body">
            {page.lines.map((line, index) => {
              const revised = revisedBlocks && line.blockIndex !== undefined && revisedBlocks.has(line.blockIndex);
              const block = line.blockIndex !== undefined ? screenplay.blocks[line.blockIndex] : undefined;
              return (
                <div key={index} className={`lw-print-line${line.type === "scene_heading" ? " font-bold" : ""}${onJump && block ? " cursor-pointer hover:bg-amber-100/60" : ""}`} onClick={() => block && onJump?.(block.start)}>
                  {sceneNumbers && line.sceneNumber ? <span className="lw-print-scene-number-left">{line.sceneNumber}</span> : null}
                  <span>{lineText(line).padEnd(PAGE_WIDTH) || " "}</span>
                  {sceneNumbers && line.sceneNumber ? <span className="lw-print-scene-number-right">{line.sceneNumber}</span> : null}
                  {revised ? <span className="lw-print-revised">*</span> : null}
                </div>
              );
            })}
          </div>
        </div>
      ))}
      {pages.length === 0 && <p className="text-sm text-muted-foreground">Nothing to print yet.</p>}
    </div>
  );
}
