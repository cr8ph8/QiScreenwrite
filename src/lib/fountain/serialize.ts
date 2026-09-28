// Text-level screenplay operations. Each returns a new Fountain string and
// never touches text outside the lines it means to change.
import { parseScreenplay, readTitlePage, sourceLines, TITLE_KEYS, type TitleEntry } from "./spec";
import { readSceneHeading } from "@/lib/screenplay-elements";

const newline = (text: string) => text.match(/\r\n|\r|\n/)?.[0] ?? "\n";

/** Replace the title page block (or add one) with the given entries. Empty values are dropped. */
export function setTitlePage(text: string, entries: TitleEntry[]): string {
  const source = text;
  const eol = newline(text);
  const existing = readTitlePage(source);
  const kept = entries.filter((entry) => entry.value.trim() !== "");
  const block = kept.map((entry) => `${entry.key}: ${entry.value.trim().split(/\r\n|\r|\n/).map((line, index) => (index ? "    " + line : line)).join(eol)}`).join(eol);
  const bom = source.startsWith("\uFEFF") ? "\uFEFF" : "";
  const body = source.slice(existing.bodyStart || bom.length);
  if (!block) return bom + body;
  return `${bom}${block}${eol}${eol}${body}`;
}

export function getTitlePage(text: string): TitleEntry[] {
  const found = readTitlePage(text).entries;
  // Keep unknown keys and duplicate metadata instead of silently deleting them.
  const aliases = (key: string) => key.toLowerCase() === "authors" ? "author" : key.toLowerCase() === "date" ? "draft date" : key.toLowerCase();
  return [...found, ...TITLE_KEYS.filter((key) => !["Authors", "Date"].includes(key) && !found.some((entry) => aliases(entry.key) === aliases(key))).map((key) => ({ key, value: "" }))];
}

/** Move the scene at `from` so it lands at position `to` (both zero-based scene indexes). */
export function reorderScenes(text: string, from: number, to: number): string {
  const source = text;
  const { scenes } = parseScreenplay(source);
  if (!Number.isInteger(from) || !Number.isInteger(to) || from === to || from < 0 || to < 0 || from >= scenes.length || to >= scenes.length) return source;
  const preamble = source.slice(0, scenes[0].start);
  const chunks = scenes.map((scene) => source.slice(scene.start, scene.end));
  const [moved] = chunks.splice(from, 1);
  chunks.splice(to, 0, moved);
  return preamble + chunks.map((chunk, index) => {
    if (index === chunks.length - 1) return chunk;
    const endings = chunk.match(/(?:\r\n|\r|\n)+$/)?.[0] ?? "";
    const count = endings.match(/\r\n|\r|\n/g)?.length ?? 0;
    return chunk + newline(source).repeat(Math.max(0, 2 - count));
  }).join("");
}

/** Add sequential `#n#` numbers to unnumbered headings, or strip every number. */
export function numberScenes(text: string, on: boolean): string {
  const lines = sourceLines(text);
  const headingStarts = new Set(parseScreenplay(text).scenes.map((scene) => scene.start));
  let count = 0;
  const out = lines.map(({ text: line, start, ending }) => {
    if (!headingStarts.has(start)) return line + ending;
    const heading = readSceneHeading(line);
    if (!heading) return line + ending;
    count++;
    const trailing = line.match(/\s*$/)![0];
    const withoutNumber = line.trimEnd().replace(/\s+#([\p{L}\p{N}][\p{L}\p{N}._-]*)#$/u, "");
    if (!on) return withoutNumber + trailing + ending;
    return `${withoutNumber} #${heading.sceneNumber ?? count}#${trailing}${ending}`;
  });
  return out.join("");
}

/** Toggle dual dialogue (`^`) on the character cue that owns the dialogue at `offset`. */
export function toggleDualDialogue(text: string, offset: number): string | null {
  const source = text;
  const { blocks } = parseScreenplay(source);
  const at = blocks.findIndex((block) => offset >= block.start && offset <= block.end + 1);
  if (at < 0) return null;
  let cueIndex = at;
  while (cueIndex >= 0 && blocks[cueIndex].type !== "character") { if (!["dialogue", "parenthetical"].includes(blocks[cueIndex].type)) return null; cueIndex--; }
  if (cueIndex < 0) return null;
  const cue = blocks[cueIndex];
  const line = cue.text;
  const next = /\s*\^\s*$/.test(line) ? line.replace(/\s*\^\s*$/, "") : `${line.trimEnd()} ^`;
  return source.slice(0, cue.start) + next + source.slice(cue.end);
}

/** Write or replace the synopsis (`= …`) directly under a scene heading. */
export function setSceneSynopsis(text: string, sceneIndex: number, synopsis: string): string {
  const source = text;
  const { scenes, blocks } = parseScreenplay(source);
  const scene = scenes[sceneIndex];
  if (!scene) return source;
  const heading = blocks[scene.blockStart];
  const existing = blocks.slice(scene.blockStart + 1, scene.blockEnd).find((block) => block.type === "synopsis");
  const value = synopsis.trim().replace(/[\r\n]+/g, " ");
  if (existing) {
    const replacement = value ? `= ${value}` : "";
    const tail = value ? "" : source.slice(existing.end).match(/^(?:\r\n|\r|\n)/)?.[0] ?? "";
    return source.slice(0, existing.start) + replacement + source.slice(existing.end + tail.length);
  }
  if (!value) return source;
  const suffix = source.slice(heading.end);
  const eol = newline(source);
  return source.slice(0, heading.end) + `${eol}= ${value}` + (suffix || eol);
}

/** Case-insensitive search with source offsets. */
export function findAll(text: string, query: string, options: { matchCase?: boolean; wholeWord?: boolean } = {}): { start: number; end: number }[] {
  if (!query) return [];
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(options.wholeWord ? `(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])` : escaped, options.matchCase ? "gu" : "giu");
  const hits: { start: number; end: number }[] = [];
  for (const match of text.matchAll(pattern)) hits.push({ start: match.index!, end: match.index! + match[0].length });
  return hits;
}

export function replaceAll(text: string, query: string, replacement: string, options: { matchCase?: boolean; wholeWord?: boolean } = {}): { text: string; count: number } {
  const hits = findAll(text, query, options);
  let out = "", cursor = 0;
  for (const hit of hits) { out += text.slice(cursor, hit.start) + replacement; cursor = hit.end; }
  return { text: out + text.slice(cursor), count: hits.length };
}
