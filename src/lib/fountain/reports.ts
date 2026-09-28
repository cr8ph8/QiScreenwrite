// Production-style reports derived from a parsed screenplay and its pagination.
import { countWords, type Screenplay } from "./spec";
import type { Page } from "./paginate";

export const STORY_WORD_COUNT_DESCRIPTION = "Story text in action, dialogue, centered text and lyrics. Headings, character cues, parentheticals, title pages and private notes are excluded.";

export interface CharacterRow { name: string; speeches: number; words: number; scenes: number[]; firstScene: number | null }
export interface SceneRow { index: number; sceneNumber?: string; heading: string; intExt: string; location: string; time: string; characters: string[]; words: number; page: number | null; eighths: number; synopsis: string }
export interface LocationRow { location: string; intExt: string[]; scenes: number[] }
export interface ScreenplayStats { pages: number; scenes: number; words: number; dialogueWords: number; actionWords: number; dialogueShare: number; characters: number; estimatedMinutes: number }

export function characterReport(screenplay: Screenplay): CharacterRow[] {
  const rows = new Map<string, CharacterRow>();
  let scene = 0;
  screenplay.blocks.forEach((block, index) => {
    if (block.type === "scene_heading") scene = block.sceneIndex ?? scene + 1;
    if (block.type !== "character" || !block.character) return;
    const row = rows.get(block.character.name) ?? { name: block.character.name, speeches: 0, words: 0, scenes: [], firstScene: null };
    row.speeches++;
    if (scene && !row.scenes.includes(scene)) row.scenes.push(scene);
    if (row.firstScene === null) row.firstScene = scene || null;
    for (let next = index + 1; next < screenplay.blocks.length && ["dialogue", "parenthetical"].includes(screenplay.blocks[next].type); next++) {
      if (screenplay.blocks[next].type === "dialogue") row.words += countWords(screenplay.blocks[next].plain);
    }
    rows.set(block.character.name, row);
  });
  return [...rows.values()].sort((a, b) => b.speeches - a.speeches || a.name.localeCompare(b.name));
}

/** Eighths of a page per scene, measured from the paginated lines. */
export function sceneReport(screenplay: Screenplay, pages: Page[]): SceneRow[] {
  const linesPerPage = Math.max(1, ...pages.map((page) => page.lines.length), 55);
  const lineCount = new Map<number, number>();
  const firstPage = new Map<number, number>();
  for (const page of pages) for (const line of page.lines) {
    if (line.sceneIndex === undefined) continue;
    lineCount.set(line.sceneIndex, (lineCount.get(line.sceneIndex) ?? 0) + 1);
    if (!firstPage.has(line.sceneIndex)) firstPage.set(line.sceneIndex, page.number);
  }
  return screenplay.scenes.map((scene) => ({
    index: scene.index, ...(scene.sceneNumber ? { sceneNumber: scene.sceneNumber } : {}), heading: scene.heading, intExt: scene.intExt, location: scene.location, time: scene.time, characters: scene.characters,
    words: screenplay.blocks.slice(scene.blockStart, scene.blockEnd).reduce((sum, block) => sum + (["action", "dialogue", "parenthetical", "centered", "lyrics"].includes(block.type) ? countWords(block.plain) : 0), 0),
    page: firstPage.get(scene.index) ?? null,
    eighths: Math.max(1, Math.round(((lineCount.get(scene.index) ?? 0) / linesPerPage) * 8)),
    synopsis: scene.synopsis,
  }));
}

export function locationReport(screenplay: Screenplay): LocationRow[] {
  const rows = new Map<string, LocationRow>();
  for (const scene of screenplay.scenes) {
    const key = scene.location.toUpperCase() || scene.heading;
    const row = rows.get(key) ?? { location: key, intExt: [], scenes: [] };
    if (scene.intExt && !row.intExt.includes(scene.intExt)) row.intExt.push(scene.intExt);
    row.scenes.push(scene.index);
    rows.set(key, row);
  }
  return [...rows.values()].sort((a, b) => b.scenes.length - a.scenes.length || a.location.localeCompare(b.location));
}

export function screenplayStats(screenplay: Screenplay, pages: Page[]): ScreenplayStats {
  let dialogueWords = 0, actionWords = 0;
  for (const block of screenplay.blocks) {
    if (block.type === "dialogue") dialogueWords += countWords(block.plain);
    else if (["action", "centered", "lyrics"].includes(block.type)) actionWords += countWords(block.plain);
  }
  const words = dialogueWords + actionWords;
  return { pages: pages.length, scenes: screenplay.scenes.length, words, dialogueWords, actionWords, dialogueShare: words ? dialogueWords / words : 0, characters: characterReport(screenplay).length, estimatedMinutes: pages.length };
}

export function reportCsv(rows: Record<string, unknown>[]): string {
  if (!rows.length) return "";
  const keys = Object.keys(rows[0]);
  const cell = (value: unknown) => { const text = Array.isArray(value) ? value.join("; ") : value == null ? "" : String(value); return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text; };
  return [keys.join(","), ...rows.map((row) => keys.map((key) => cell(row[key])).join(","))].join("\n");
}
