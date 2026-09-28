import { computeDiff, type DiffLine } from '@/lib/diff';
import { parseScreenplay, type Scene } from '@/lib/fountain/spec';
import type { DraftRecord, ScreenplayDraftData } from './types';

export const MAX_COMPARISON_BODY = 200_000;
export const MAX_DIFF_CELLS = 250_000;
const MAX_PRECISE_CHARACTERS = 60_000;
export const DIFF_PAGE_SIZE = 80;
export const DIFF_LINE_PREVIEW = 1_200;
export const SCENE_PAGE_SIZE = 40;

export interface RevisionDiffLine {
  type: DiffLine['type'];
  /** Exact physical line including its original ending. Joining one side restores its source. */
  text: string;
  beforeLine?: number;
  afterLine?: number;
}
export interface RevisionTextDiff {
  lines: RevisionDiffLine[];
  identical: boolean;
  coarse: boolean;
  added: number;
  removed: number;
  unchanged: number;
  /** Zero for a coarse diff; exposed so the fixed work budget is testable. */
  preciseCells: number;
}

function assertBodySize(text: string) {
  if (text.length > MAX_COMPARISON_BODY) throw new Error('Comparison supports saved bodies up to 200,000 characters each.');
}

function physicalLines(text: string): string[] {
  // Unlike split("\n"), keep CR, CRLF, missing final newline and empty source distinct.
  const lines = text.match(/[^\r\n]*(?:\r\n|\r|\n|$)/g) ?? [];
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

/** Reuse the hosted line LCS only inside a fixed cell/character budget.
 * Prefix/suffix trimming makes isolated edits cheap. Large middles are shown as
 * replacement blocks, never passed to the quadratic donor (including editor comparisons).
 */
export function compareRevisionText(before: string, after: string): RevisionTextDiff {
  assertBodySize(before); assertBodySize(after);
  const oldLines = physicalLines(before), newLines = physicalLines(after);
  let prefix = 0, suffix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix++;
  while (suffix < oldLines.length - prefix && suffix < newLines.length - prefix && oldLines[oldLines.length - suffix - 1] === newLines[newLines.length - suffix - 1]) suffix++;
  const oldMiddle = oldLines.slice(prefix, oldLines.length - suffix);
  const newMiddle = newLines.slice(prefix, newLines.length - suffix);
  const cells = (oldMiddle.length + 1) * (newMiddle.length + 1);
  const characters = oldMiddle.reduce((n, line) => n + line.length, 0) + newMiddle.reduce((n, line) => n + line.length, 0);
  const precise = oldMiddle.length > 0 && newMiddle.length > 0 && cells <= MAX_DIFF_CELLS && characters <= MAX_PRECISE_CHARACTERS;
  const coarse = oldMiddle.length > 0 && newMiddle.length > 0 && !precise;
  const lines: RevisionDiffLine[] = [];
  let beforeLine = 1, afterLine = 1, added = 0, removed = 0, unchanged = 0;
  const append = (type: DiffLine['type'], text: string) => {
    lines.push({ type, text, ...(type !== 'add' ? { beforeLine: beforeLine++ } : {}), ...(type !== 'remove' ? { afterLine: afterLine++ } : {}) });
    if (type === 'add') added++;
    else if (type === 'remove') removed++;
    else unchanged++;
  };
  for (let i = 0; i < prefix; i++) append('equal', oldLines[i]);
  if (precise) {
    // JSON encodes each entire physical line as one donor token. This preserves
    // endings and literal escapes while avoiding normalization of either source.
    for (const line of computeDiff(oldMiddle.map(line => JSON.stringify(line)).join('\n'), newMiddle.map(line => JSON.stringify(line)).join('\n'))) {
      append(line.type, JSON.parse(line.text) as string);
    }
  } else {
    for (const line of oldMiddle) append('remove', line);
    for (const line of newMiddle) append('add', line);
  }
  for (let i = oldLines.length - suffix; i < oldLines.length; i++) append('equal', oldLines[i]);
  return { lines, identical: before === after, coarse, added, removed, unchanged, preciseCells: precise ? cells : 0 };
}

export type DiffDisplayRow = { kind: 'line'; line: RevisionDiffLine } | { kind: 'unchanged'; count: number };
export function diffDisplayRows(diff: RevisionTextDiff, showUnchanged: boolean): DiffDisplayRow[] {
  const rows: DiffDisplayRow[] = [];
  for (const line of diff.lines) {
    if (showUnchanged || line.type !== 'equal') rows.push({ kind: 'line', line });
    else {
      const last = rows.at(-1);
      if (last?.kind === 'unchanged') last.count++;
      else rows.push({ kind: 'unchanged', count: 1 });
    }
  }
  return rows;
}

export interface SceneReference { index: number; heading: string; number?: string }
export interface SceneDifference {
  type: 'added' | 'removed' | 'changed';
  before?: SceneReference;
  after?: SceneReference;
  basis: 'number and heading' | 'unique heading';
}
export interface RevisionScenes {
  status: 'compared' | 'limited';
  beforeCount: number | null;
  afterCount: number | null;
  differences: SceneDifference[];
  unchanged: number;
  ambiguousBefore: number;
  ambiguousAfter: number;
  orderChanged: boolean;
}

function sceneParseFits(text: string): boolean {
  // The shared parser rescans consecutive heading paragraphs. Bound its inputs
  // as well as LCS work; text comparison remains available when this guard trips.
  const lines = physicalLines(text);
  if (lines.length > 8_000) return false;
  let paragraphLines = 0;
  for (const line of lines) {
    if (line.length > 4_000) return false;
    paragraphLines = line.trim() ? paragraphLines + 1 : 0;
    if (paragraphLines > 200) return false;
  }
  return true;
}

function sceneIndex(scenes: Scene[]) {
  const numbers = new Map<string, number>(), headings = new Map<string, number>();
  for (const scene of scenes) {
    if (scene.sceneNumber) numbers.set(scene.sceneNumber, (numbers.get(scene.sceneNumber) ?? 0) + 1);
    headings.set(scene.heading, (headings.get(scene.heading) ?? 0) + 1);
  }
  return { numbers, headings };
}

/** Snapshot matching only, not persistent scene identity. Never pair by ordinal,
 * fuzzy text, duplicate numbers, or a number whose heading has been replaced.
 */
export function compareRevisionScenes(before: string, after: string): RevisionScenes {
  assertBodySize(before); assertBodySize(after);
  if (!sceneParseFits(before) || !sceneParseFits(after)) return { status: 'limited', beforeCount: null, afterCount: null, differences: [], unchanged: 0, ambiguousBefore: 0, ambiguousAfter: 0, orderChanged: false };
  const oldParsed = parseScreenplay(before), newParsed = before === after ? oldParsed : parseScreenplay(after);
  const oldIndex = sceneIndex(oldParsed.scenes), newIndex = sceneIndex(newParsed.scenes);
  const keyFor = (scene: Scene, own: ReturnType<typeof sceneIndex>, other: ReturnType<typeof sceneIndex>): string | null => {
    if (!scene.heading) return null;
    if (scene.sceneNumber) {
      if (own.numbers.get(scene.sceneNumber) !== 1 || (other.numbers.get(scene.sceneNumber) ?? 0) > 1) return null;
      return JSON.stringify(['number', scene.sceneNumber, scene.heading]);
    }
    if (own.headings.get(scene.heading) !== 1 || (other.headings.get(scene.heading) ?? 0) > 1) return null;
    return JSON.stringify(['heading', scene.heading]);
  };
  const newByKey = new Map<string, Scene>();
  for (const scene of newParsed.scenes) {
    const key = keyFor(scene, newIndex, oldIndex);
    if (key) newByKey.set(key, scene);
  }
  const reference = (scene: Scene): SceneReference => ({ index: scene.index, heading: scene.heading, ...(scene.sceneNumber ? { number: scene.sceneNumber } : {}) });
  const span = (text: string, scene: Scene, parsed: typeof oldParsed) => text.slice(scene.start, parsed.blocks[scene.blockEnd - 1].end);
  const exclusive = (scene: Scene, other: ReturnType<typeof sceneIndex>) => !other.headings.has(scene.heading) && (!scene.sceneNumber || !other.numbers.has(scene.sceneNumber));
  const differences: SceneDifference[] = [], matched = new Set<number>();
  let unchanged = 0, ambiguousBefore = 0, ambiguousAfter = 0, lastMatchedIndex = 0, orderChanged = false;
  for (const scene of oldParsed.scenes) {
    const key = keyFor(scene, oldIndex, newIndex);
    const next = key ? newByKey.get(key) : undefined;
    const basis = scene.sceneNumber ? 'number and heading' : 'unique heading';
    if (next) {
      matched.add(next.index);
      if (next.index < lastMatchedIndex) orderChanged = true;
      lastMatchedIndex = next.index;
      if (span(before, scene, oldParsed) === span(after, next, newParsed)) unchanged++;
      else differences.push({ type: 'changed', before: reference(scene), after: reference(next), basis });
    } else if (key && exclusive(scene, newIndex)) differences.push({ type: 'removed', before: reference(scene), basis });
    else ambiguousBefore++;
  }
  for (const scene of newParsed.scenes) {
    if (matched.has(scene.index)) continue;
    const key = keyFor(scene, newIndex, oldIndex);
    if (key && exclusive(scene, oldIndex)) differences.push({ type: 'added', after: reference(scene), basis: scene.sceneNumber ? 'number and heading' : 'unique heading' });
    else ambiguousAfter++;
  }
  return { status: 'compared', beforeCount: oldParsed.scenes.length, afterCount: newParsed.scenes.length, differences, unchanged, ambiguousBefore, ambiguousAfter, orderChanged };
}

const METADATA_FIELDS = [
  ['title', 'Title'], ['genre', 'Genre'], ['logline', 'Logline'],
  ['projectFormat', 'Format'], ['format', 'Source format'], ['targetPages', 'Target pages'],
] as const;
export function revisionMetadata(before: ScreenplayDraftData, after: ScreenplayDraftData) {
  return METADATA_FIELDS.map(([field, label]) => ({ field, label, before: before[field], after: after[field], changed: before[field] !== after[field] }));
}

export function revisionKey(record: DraftRecord): string {
  return JSON.stringify([record.id, record.version, record.sha256]);
}

export function compareSavedRevisions(before: DraftRecord, after: DraftRecord) {
  if (before.id !== after.id || before.data.projectId !== after.data.projectId) throw new Error('Choose two saved revisions of the same draft.');
  return { text: compareRevisionText(before.data.body, after.data.body), metadata: revisionMetadata(before.data, after.data), scenes: compareRevisionScenes(before.data.body, after.data.body) };
}
