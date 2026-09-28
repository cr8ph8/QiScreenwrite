// Industry-format pagination: US Letter, Courier 12, 55 lines per page,
// standard element indents, (MORE)/(CONT'D) dialogue breaks, no orphaned
// scene headings, side-by-side dual dialogue and automatic (CONT'D) cues.
// Output is a list of printed lines per page in character columns (10 cpi
// from a 1.5" left margin), which the PDF, DOCX and preview renderers share.
import type { Block, BlockType, Screenplay } from "./spec";

export interface PageLine {
  text: string;
  type: BlockType | "more" | "blank";
  /** Column from the left margin, in 10-cpi characters. */
  col: number;
  width: number;
  align: "left" | "right" | "center";
  blockIndex?: number;
  sceneIndex?: number;
  /** Printed scene number for heading lines (also drawn in the margins). */
  sceneNumber?: string;
  /** Present on dual-dialogue rows: the right column's text and layout. */
  dual?: { text: string; type: BlockType | "more" | "blank"; col: number; width: number };
}
export interface Page { number: number; lines: PageLine[] }
export interface PaginateOptions { linesPerPage?: number; sceneNumbers?: boolean; autoContd?: boolean }

export const PAGE_WIDTH = 60;
const LAYOUT: Record<string, { col: number; width: number; align: PageLine["align"] }> = {
  scene_heading: { col: 0, width: 60, align: "left" },
  action: { col: 0, width: 60, align: "left" },
  lyrics: { col: 0, width: 60, align: "left" },
  character: { col: 22, width: 38, align: "left" },
  parenthetical: { col: 16, width: 25, align: "left" },
  dialogue: { col: 10, width: 35, align: "left" },
  transition: { col: 0, width: 60, align: "right" },
  centered: { col: 0, width: 60, align: "center" },
  more: { col: 16, width: 25, align: "left" },
};
const DUAL: Record<string, { col: number; width: number }> = { character: { col: 6, width: 22 }, parenthetical: { col: 3, width: 24 }, dialogue: { col: 0, width: 28 } };
const DUAL_RIGHT = 32;

/** Greedy word wrap; words longer than the width are hard-split. */
export function wrap(text: string, width: number): string[] {
  if (!Number.isInteger(width) || width < 1) throw new RangeError("Wrap width must be a positive integer.");
  const out: string[] = [];
  for (const paragraph of text.split("\n")) {
    const words = paragraph.split(/\s+/).filter(Boolean);
    if (!words.length) { out.push(""); continue; }
    let line = "";
    for (let word of words) {
      while (word.length > width) { if (line) { out.push(line); line = ""; } out.push(word.slice(0, width)); word = word.slice(width); }
      if (!line) line = word;
      else if (line.length + 1 + word.length <= width) line += " " + word;
      else { out.push(line); line = word; }
    }
    out.push(line);
  }
  return out;
}

interface Unit { lines: PageLine[]; kind: "heading" | "dialogue" | "action" | "other" | "dual" | "break"; splittable: boolean; character?: string }

function lineFor(block: Block, index: number, text: string, type: BlockType | "more" = block.type, sceneIndex?: number): PageLine {
  const layout = LAYOUT[type] ?? LAYOUT.action;
  return { text, type, col: layout.col, width: layout.width, align: layout.align, blockIndex: index, ...(sceneIndex !== undefined ? { sceneIndex } : {}) };
}

function cueText(block: Block, contd: boolean): string {
  const base = block.plain.replace(/\s*\^$/, "").toUpperCase();
  return contd && !/CONT'?D/i.test(base) ? `${base} (CONT'D)` : base;
}

export function paginate(screenplay: Screenplay, options: PaginateOptions = {}): Page[] {
  const linesPerPage = options.linesPerPage ?? 55;
  if (!Number.isInteger(linesPerPage) || linesPerPage < 4) throw new RangeError("A screenplay page needs at least four lines.");
  const autoContd = options.autoContd ?? true;
  const { blocks } = screenplay;
  const units: Unit[] = [];
  let scene: number | undefined;
  let lastSpeaker: string | null = null;
  let sequential = 0;

  const dialogueUnit = (start: number, contd: boolean, dualColumn = false): { unit: Unit; next: number } => {
    const cue = blocks[start];
    const layout = (type: BlockType | "more") => dualColumn ? { ...(DUAL[type] ?? DUAL.dialogue), align: "left" as const } : LAYOUT[type] ?? LAYOUT.action;
    const make = (text: string, type: BlockType | "more", index: number): PageLine => ({ text, type, ...layout(type), blockIndex: index, ...(scene !== undefined ? { sceneIndex: scene } : {}) });
    const lines: PageLine[] = [make(cueText(cue, contd), "character", start)];
    let next = start + 1;
    while (next < blocks.length && (blocks[next].type === "dialogue" || blocks[next].type === "parenthetical")) {
      const block = blocks[next];
      const width = layout(block.type).width;
      for (const row of wrap(block.plain, width)) lines.push(make(row, block.type, next));
      next++;
    }
    return { unit: { lines, kind: "dialogue", splittable: true, character: cue.character?.name }, next };
  };

  for (let index = 0; index < blocks.length; index++) {
    const block = blocks[index];
    switch (block.type) {
      case "title_page": case "section": case "synopsis": case "note": case "boneyard": continue;
      case "page_break": units.push({ lines: [], kind: "break", splittable: false }); continue;
      case "scene_heading": {
        scene = block.sceneIndex; lastSpeaker = null; sequential++;
        const number = block.sceneNumber ?? (options.sceneNumbers ? String(sequential) : undefined);
        const lines = wrap(block.plain.toUpperCase(), LAYOUT.scene_heading.width).map((row, rowIndex) => ({ ...lineFor(block, index, row, "scene_heading", scene), ...(rowIndex === 0 && number ? { sceneNumber: number } : {}) }));
        units.push({ lines, kind: "heading", splittable: false });
        continue;
      }
      case "character": {
        const contd = autoContd && lastSpeaker === block.character?.name;
        if (block.character?.dual && units.length && units[units.length - 1].kind === "dialogue") {
          // Rebuild the previous speech in the narrow left column and zip it with this one on the right.
          const previous = units.pop()!;
          const leftStart = previous.lines[0].blockIndex!;
          const left = dialogueUnit(leftStart, /CONT'D/.test(previous.lines[0].text), true).unit.lines;
          const right = dialogueUnit(index, false, true);
          const rows = Math.max(left.length, right.unit.lines.length);
          const lines: PageLine[] = [];
          for (let row = 0; row < rows; row++) {
            const l = left[row], r = right.unit.lines[row];
            lines.push({ text: l?.text ?? "", type: l?.type ?? "blank", col: l?.col ?? 0, width: l?.width ?? 28, align: "left", blockIndex: l?.blockIndex ?? leftStart, ...(scene !== undefined ? { sceneIndex: scene } : {}), dual: { text: r?.text ?? "", type: r?.type ?? "blank", col: DUAL_RIGHT + (r?.col ?? 0), width: r?.width ?? 28 } });
          }
          units.push({ lines, kind: "dual", splittable: false });
          lastSpeaker = block.character?.name ?? null;
          index = right.next - 1;
          continue;
        }
        const { unit, next } = dialogueUnit(index, contd);
        units.push(unit);
        lastSpeaker = block.character?.name ?? null;
        index = next - 1;
        continue;
      }
      case "dialogue": case "parenthetical": continue; // consumed by the cue
      case "transition": {
        units.push({ lines: wrap(block.plain.toUpperCase(), LAYOUT.transition.width).map((row) => lineFor(block, index, row, "transition", scene)), kind: "other", splittable: false });
        continue;
      }
      case "centered": case "lyrics": case "action": {
        const lines = wrap(block.plain, LAYOUT[block.type].width).map((row) => lineFor(block, index, row, block.type, scene));
        units.push({ lines, kind: "action", splittable: block.type === "action" });
        continue;
      }
    }
  }

  const pages: Page[] = [];
  let current: Page = { number: 1, lines: [] };
  const newPage = () => { pages.push(current); current = { number: pages.length + 1, lines: [] }; };
  const blank = (): PageLine => ({ text: "", type: "blank", col: 0, width: PAGE_WIDTH, align: "left" });
  const spacing = (unit: Unit) => current.lines.length === 0 ? 0 : unit.kind === "heading" ? 2 : 1;
  const place = (lines: PageLine[], space: number) => { for (let n = 0; n < space; n++) current.lines.push(blank()); current.lines.push(...lines); };

  for (let u = 0; u < units.length; u++) {
    const unit = units[u];
    if (unit.kind === "break") { if (current.lines.length) newPage(); continue; }
    if (!unit.lines.length) continue;
    let space = spacing(unit);
    let available = linesPerPage - current.lines.length - space;
    const following = units[u + 1];
    const needed = unit.kind === "heading" ? unit.lines.length + 1 + Math.min(2, following?.lines.length ?? 0) : unit.lines.length;
    if (needed <= available) { place(unit.lines, space); continue; }
    // Move short, indivisible elements to a fresh page. Long units are consumed
    // in a loop so no remainder can run past the physical bottom of a page.
    if (current.lines.length && (!unit.splittable || available < (unit.kind === "dialogue" ? 4 : 2))) {
      newPage(); space = 0; available = linesPerPage;
    }
    let remaining = unit.lines;
    while (remaining.length > available) {
      if (unit.kind === "dialogue") {
        let cut = Math.min(available - 1, remaining.length - 2);
        while (cut > 3 && (remaining[cut - 1].type === "parenthetical" || remaining[cut].type === "parenthetical")) cut--;
        if (cut < 3 && current.lines.length) {
          newPage(); space = 0; available = linesPerPage; continue;
        }
        const cue = unit.lines[0];
        place([...remaining.slice(0, cut), { ...cue, text: "(MORE)", type: "more", ...LAYOUT.more }], space);
        newPage();
        remaining = [{ ...cue, text: /CONT'?D/i.test(cue.text) ? cue.text : `${cue.text} (CONT'D)` }, ...remaining.slice(cut)];
      } else {
        let cut = available;
        if (unit.kind === "action" && remaining.length - cut === 1 && cut > 2) cut--;
        place(remaining.slice(0, cut), space);
        remaining = remaining.slice(cut);
        newPage();
      }
      space = 0; available = linesPerPage;
    }
    place(remaining, space);
  }
  if (current.lines.length || pages.length === 0) pages.push(current);
  return pages;
}

/** Render a page as fixed-width text, used by the preview and plain-text export. */
export function pageToText(page: Page, options: { sceneNumbers?: boolean } = {}): string {
  return page.lines.map((line) => {
    const pad = (text: string, l: PageLine) => l.align === "right" ? " ".repeat(Math.max(0, l.col + l.width - text.length)) + text : l.align === "center" ? " ".repeat(Math.max(0, l.col + Math.floor((l.width - text.length) / 2))) + text : " ".repeat(l.col) + text;
    let row = pad(line.text, line);
    if (line.dual) row = row.padEnd(line.dual.col) + line.dual.text;
    if (line.sceneNumber && options.sceneNumbers !== false) row = `${line.sceneNumber.padEnd(4)}${row}`.padEnd(PAGE_WIDTH + 6) + line.sceneNumber;
    return row.replace(/\s+$/, "");
  }).join("\n");
}
