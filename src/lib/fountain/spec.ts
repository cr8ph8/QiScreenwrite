// Spec-complete Fountain reader for the local writer.
//
// Reads the whole Fountain syntax (title page, forced elements, dual dialogue,
// centered text, sections, synopses, notes, boneyard, page breaks, lyrics,
// scene numbers, emphasis) into blocks that keep exact source offsets. It is a
// reading aid: nothing here rewrites the author's text. The hosted app keeps
// using src/lib/fountain-parser.ts; this module serves pagination, exchange
// formats (FDX, DOCX, PDF), reports and scene tools.
import { readCharacterCue, readSceneHeading } from "@/lib/screenplay-elements";
import { inlineRuns } from "./inline";

export type BlockType =
  | "title_page" | "scene_heading" | "action" | "character" | "parenthetical" | "dialogue"
  | "transition" | "centered" | "section" | "synopsis" | "note" | "boneyard" | "page_break" | "lyrics";

export interface Block {
  type: BlockType;
  /** Exact source text of the block (may span lines). */
  text: string;
  /** Text as printed: force markers, emphasis markers and inline notes removed. */
  plain: string;
  /** Char offsets into the original source; `end` excludes the trailing newline. */
  start: number;
  end: number;
  /** Zero-based first and last source line. */
  lineStart: number;
  lineEnd: number;
  /** Scene headings: 1-based order and, when authored, the printed `#number#`. */
  sceneIndex?: number;
  sceneNumber?: string;
  /** Character cues: normalised name, extension such as V.O., and dual-dialogue mark (`^`). */
  character?: { name: string; extension: string; dual: boolean };
  /** Sections: number of leading `#`. */
  depth?: number;
}

export interface TitleEntry { key: string; value: string }

export interface Scene {
  index: number;
  heading: string;
  sceneNumber?: string;
  intExt: string;
  location: string;
  time: string;
  /** Block indexes [blockStart, blockEnd). */
  blockStart: number;
  blockEnd: number;
  /** Char offsets of the scene's source span: heading start to next heading start (or end of text). */
  start: number;
  end: number;
  characters: string[];
  synopsis: string;
}

export interface Screenplay {
  source: string;
  title: TitleEntry[];
  /** Offset where the body starts (after the title page). */
  bodyStart: number;
  blocks: Block[];
  scenes: Scene[];
}

export const TITLE_KEYS = ["Title", "Credit", "Author", "Authors", "Source", "Draft date", "Date", "Contact", "Copyright", "Notes", "Revision"];
const TITLE_KEY_RE = /^([A-Za-z][A-Za-z ]{0,30}):(.*)$/;
const TRANSITION_RE = /^(?:FADE (?:IN|OUT|TO BLACK)\s*[:.]?|CUT TO BLACK[.:]?|(?:[A-Z][A-Z0-9 '.-]* )?TO:|THE END)$/;

/** Remove Fountain emphasis and inline notes for display. Escaped `\*` stays literal. */
export function plainText(text: string): string {
  return inlineRuns(text).map((run) => run.text).join("");
}

/** Source coordinates stay valid for CRLF, CR, mixed endings and a BOM. */
export function sourceLines(source: string) {
  const rows: { text: string; start: number; end: number; ending: string }[] = [];
  let start = 0;
  for (const match of source.matchAll(/\r\n|\r|\n/g)) {
    rows.push({ text: source.slice(start, match.index), start, end: match.index!, ending: match[0] });
    start = match.index! + match[0].length;
  }
  rows.push({ text: source.slice(start), start, end: source.length, ending: "" });
  return rows;
}

function parseHeading(heading: string) {
  const match = /^(INT\.?\/EXT\.?|EXT\.?\/INT\.?|I\/E\.?|INT\.?|EXT\.?|EST\.?)\s*(.*)$/i.exec(heading);
  const intExt = match ? match[1].toUpperCase().replace(/\.$/, "") : "";
  const rest = match ? match[2] : heading;
  // Only a standard INT/EXT heading has a reliable "LOCATION - TIME" split; forced headings stay whole.
  const dash = intExt ? rest.lastIndexOf(" - ") : -1;
  return { intExt, location: (dash >= 0 ? rest.slice(0, dash) : rest).trim(), time: dash >= 0 ? rest.slice(dash + 3).trim() : "" };
}

/** Parse the title page at the top of the text. Returns entries and the offset where the body begins. */
export function readTitlePage(text: string): { entries: TitleEntry[]; bodyStart: number; lineCount: number } {
  const rows = sourceLines(text);
  const lines = rows.map((row, index) => index === 0 ? row.text.replace(/^\uFEFF/, "") : row.text);
  const entries: TitleEntry[] = [];
  let index = 0;
  if (!TITLE_KEY_RE.test(lines[0] ?? "") || !TITLE_KEYS.some((key) => (lines[0] ?? "").toLowerCase().startsWith(key.toLowerCase() + ":"))) return { entries: [], bodyStart: 0, lineCount: 0 };
  while (index < lines.length && lines[index].trim() !== "") {
    const match = TITLE_KEY_RE.exec(lines[index]);
    if (match && !/^[ \t]/.test(lines[index])) entries.push({ key: match[1].trim(), value: match[2].trim() });
    else if (entries.length) entries[entries.length - 1].value = (entries[entries.length - 1].value + "\n" + lines[index].trim()).replace(/^\n/, "");
    index++;
  }
  // Skip the blank separator line(s) after the title page.
  let bodyLine = index;
  while (bodyLine < lines.length && lines[bodyLine].trim() === "") bodyLine++;
  const bodyStart = rows[bodyLine]?.start ?? text.length;
  return { entries, bodyStart: Math.min(bodyStart, text.length), lineCount: bodyLine };
}

export function parseScreenplay(raw: string): Screenplay {
  const source = raw;
  const title = readTitlePage(source);
  const rows = sourceLines(source);
  const lines = rows.map((row) => row.text);
  const offsets = rows.map((row) => row.start);
  const blocks: Block[] = [];
  if (title.entries.length) blocks.push({ type: "title_page", text: source.slice(0, Math.max(0, title.bodyStart - 1)), plain: "", start: 0, end: Math.max(0, title.bodyStart - 1), lineStart: 0, lineEnd: Math.max(0, title.lineCount - 1) });

  let sceneCount = 0;
  let index = title.lineCount;
  const push = (type: BlockType, from: number, to: number, extra: Partial<Block> = {}) => {
    const text = source.slice(offsets[from], rows[to].end);
    const block: Block = { type, text, plain: plainText(text).trim(), start: offsets[from], end: offsets[to] + lines[to].length, lineStart: from, lineEnd: to, ...extra };
    blocks.push(block);
    return block;
  };
  while (index < lines.length) {
    const line = lines[index];
    const trimmed = line.trim();
    if (trimmed === "") { index++; continue; }
    // Boneyard: /* ... */ possibly spanning many lines.
    if (trimmed.startsWith("/*")) {
      let end = index;
      while (end < lines.length && !lines[end].includes("*/")) end++;
      push("boneyard", index, Math.min(end, lines.length - 1));
      index = end + 1; continue;
    }
    // Whole-paragraph note: [[ ... ]]
    if (trimmed.startsWith("[[")) {
      let end = index;
      while (end < lines.length && !lines[end].includes("]]")) end++;
      const block = push("note", index, Math.min(end, lines.length - 1));
      block.plain = block.text.replace(/^\s*\[\[/, "").replace(/\]\]\s*$/, "").trim();
      index = end + 1; continue;
    }
    if (/^={3,}\s*$/.test(trimmed)) { push("page_break", index, index); index++; continue; }
    if (/^#{1,6}(?:\s|$)/.test(trimmed)) { const depth = trimmed.match(/^#+/)![0].length; push("section", index, index, { depth }).plain = trimmed.slice(depth).trim(); index++; continue; }
    if (/^=(?!=)/.test(trimmed)) { push("synopsis", index, index).plain = trimmed.slice(1).trim(); index++; continue; }
    // Paragraph: consecutive non-blank lines.
    let end = index;
    while (end + 1 < lines.length && lines[end + 1].trim() !== "") end++;
    const paragraph = lines.slice(index, end + 1);
    const first = paragraph[0].trim();
    const heading = readSceneHeading(first);
    if (heading) {
      sceneCount++;
      const block = push("scene_heading", index, index, { sceneIndex: sceneCount, ...(heading.sceneNumber ? { sceneNumber: heading.sceneNumber } : {}) });
      block.plain = plainText(heading.heading).trim();
      index++; continue;
    }
    if (/^>\s*.*<\s*$/.test(first) && paragraph.length === 1) { push("centered", index, index).plain = plainText(first.replace(/^>\s*/, "").replace(/\s*<$/, "")).trim(); index = end + 1; continue; }
    if (first.startsWith(">") && paragraph.length === 1) { push("transition", index, index).plain = plainText(first.slice(1)).trim(); index = end + 1; continue; }
    if (first.startsWith("!")) { push("action", index, end).plain = plainText(paragraph.join("\n").replace(/^\s*!/, "")).trim(); index = end + 1; continue; }
    if (first.startsWith("~")) { push("lyrics", index, end).plain = plainText(paragraph.map((row) => row.replace(/^\s*~/, "")).join("\n")).trim(); index = end + 1; continue; }
    if (TRANSITION_RE.test(first) && paragraph.length === 1 && first === first.toUpperCase()) { push("transition", index, index); index = end + 1; continue; }
    const forcedCue = first.startsWith("@");
    const cue = readCharacterCue(plainText(first).trim(), { forced: forcedCue });
    if (cue && paragraph.length > 1) {
      const dual = /\^\s*$/.test(first);
      const block = push("character", index, index, { character: { name: cue.characterName, extension: cue.extensions.join(" "), dual } });
      block.plain = block.plain.replace(/^@/, "").replace(/\s*\^$/, "");
      for (let row = index + 1; row <= end; row++) {
        const rowText = lines[row].trim();
        if (/^\(.*\)$/.test(plainText(rowText).trim())) push("parenthetical", row, row);
        else {
          let last = row;
          while (last + 1 <= end && !/^\(.*\)$/.test(lines[last + 1].trim())) last++;
          push("dialogue", row, last);
          row = last;
        }
      }
      index = end + 1; continue;
    }
    push("action", index, end);
    index = end + 1;
  }

  const scenes: Scene[] = [];
  blocks.forEach((block, blockIndex) => {
    if (block.type !== "scene_heading") return;
    let blockEnd = blockIndex + 1;
    while (blockEnd < blocks.length && blocks[blockEnd].type !== "scene_heading") blockEnd++;
    const parts = parseHeading(block.plain);
    const characters: string[] = [];
    let synopsis = "";
    for (const inner of blocks.slice(blockIndex + 1, blockEnd)) {
      if (inner.type === "character" && inner.character && !characters.includes(inner.character.name)) characters.push(inner.character.name);
      if (inner.type === "synopsis" && !synopsis) synopsis = inner.plain;
    }
    const nextHeading = blocks[blockEnd];
    scenes.push({ index: block.sceneIndex!, heading: block.plain, ...(block.sceneNumber ? { sceneNumber: block.sceneNumber } : {}), ...parts, blockStart: blockIndex, blockEnd, start: block.start, end: nextHeading ? nextHeading.start : source.length, characters, synopsis });
  });
  return { source, title: title.entries, bodyStart: title.bodyStart, blocks, scenes };
}

export const countWords = (text: string) => (text.match(/[\p{L}\p{N}'’-]+/gu) ?? []).length;
