import { parseFountain } from '@/lib/fountain-parser';
import { readCharacterCue, readSceneHeading } from '@/lib/screenplay-elements';

export type WritingElement = 'scene_heading' | 'action' | 'character' | 'dialogue' | 'parenthetical' | 'transition';
export interface WritingLine {
  /** Offsets into the original LF-normalized source; end excludes the newline. */
  start: number;
  end: number;
  text: string;
  kind: WritingElement | 'empty' | 'other';
}
export interface WritingEdit {
  value: string;
  selectionStart: number;
  selectionEnd: number;
  nextKind?: WritingElement;
}

const elements: WritingElement[] = ['scene_heading', 'action', 'character', 'dialogue', 'parenthetical', 'transition'];
const titleField = /^(?:title|credit|authors?|source|draft date|contact|copyright|notes):/i;

/** Read source without normalizing, trimming, or rewriting the author's draft. */
export function writingLines(value: string): WritingLine[] {
  const parsed = parseFountain(value, { inputMode: 'fountain' }).elements;
  let start = 0;
  let comment: 'note' | 'boneyard' | null = null;
  let titlePage: boolean | undefined;
  let pendingCue = false;
  return value.split('\n').map((text, index) => {
    const trimmed = text.trim();
    let kind: WritingLine['kind'] = parsed[index]?.type === 'empty' || !trimmed
      ? 'empty'
      : elements.includes(parsed[index]?.type as WritingElement) ? parsed[index].type as WritingElement : 'other';

    // The screenplay parser deliberately retains metadata as literal text. The
    // writing surface must not offer dialogue formatting for title-page/notes.
    if (titlePage === undefined && trimmed) titlePage = titleField.test(trimmed);
    if (titlePage && trimmed && !titleField.test(trimmed) && !/^[ \t]/.test(text)) titlePage = false;
    if (titlePage && trimmed) kind = 'other';
    if (comment || trimmed.includes('[[') || trimmed.includes('/*')) {
      if (!comment) comment = trimmed.includes('[[') && (!trimmed.includes('/*') || trimmed.indexOf('[[') < trimmed.indexOf('/*')) ? 'note' : 'boneyard';
      kind = 'other';
      if (trimmed.includes(comment === 'note' ? ']]' : '*/')) comment = null;
    } else if (/^(?:#{1,6}(?:\s|$)|=(?!=)|>.*<\s*$)/.test(trimmed)) {
      kind = 'other';
    }

    // A forced cue does not need its future dialogue to exist yet. Likewise,
    // bare markers retain the type explicitly selected on an unfinished line.
    if (kind !== 'other') {
      if (trimmed.startsWith('@') && (trimmed === '@' || readCharacterCue(trimmed, { forced: true }))) kind = 'character';
      else if (trimmed === '.') kind = 'scene_heading';
      else if (trimmed === '>') kind = 'transition';
      else if (pendingCue && kind === 'action' && /^\(.*\)$/.test(trimmed)) kind = 'parenthetical';
    }
    pendingCue = kind === 'character' ? Boolean(readCharacterCue(trimmed, { forced: trimmed.startsWith('@') }))
      : pendingCue && (kind === 'dialogue' || kind === 'parenthetical');
    const line = { start, end: start + text.length, text, kind };
    start += text.length + 1;
    return line;
  });
}

function bound(value: string, offset: number): number {
  return Math.max(0, Math.min(value.length, Number.isFinite(offset) ? Math.trunc(offset) : 0));
}

export function writingLineAt(value: string, offset: number): WritingLine {
  const point = bound(value, offset);
  const lines = writingLines(value);
  return lines.find(line => point <= line.end) ?? lines[lines.length - 1];
}

function markerLength(line: WritingLine): number {
  const text = line.text.trimStart();
  return (line.kind === 'character' && text.startsWith('@'))
    || (line.kind === 'action' && text.startsWith('!'))
    || (line.kind === 'scene_heading' && text.startsWith('.'))
    || (line.kind === 'transition' && text.startsWith('>')) ? 1 : 0;
}

/** Visible authored text, hiding only this line's recognized force marker. */
export function writingVisibleText(line: WritingLine): string {
  const leading = line.text.length - line.text.trimStart().length;
  return line.text.slice(0, leading) + line.text.slice(leading + markerLength(line));
}

function range(value: string, start: number, end: number): [number, number] {
  const a = bound(value, start), b = bound(value, end);
  return [Math.min(a, b), Math.max(a, b)];
}

/** Whether replacing this line can continue an immediately preceding cue. */
function hasDialogueContext(lines: WritingLine[], index: number): boolean {
  for (let previous = index - 1; previous >= 0; previous--) {
    const line = lines[previous];
    if (line.kind === 'character') return Boolean(readCharacterCue(line.text, { forced: line.text.trimStart().startsWith('@') }));
    if (line.kind === 'dialogue' || line.kind === 'parenthetical') continue;
    // Before dialogue is entered, a legal unforced cue is still parsed as
    // action. Only the adjacent candidate with a preceding break can qualify.
    return line.kind === 'action' && (previous === 0 || lines[previous - 1].kind === 'empty')
      && Boolean(readCharacterCue(line.text));
  }
  return false;
}

/** Explicitly change one physical line; no type inference ever edits text. */
export function setWritingElement(value: string, start: number, end: number, kind: WritingElement): WritingEdit | null {
  const [from, to] = range(value, start, end);
  const lines = writingLines(value);
  const index = lines.findIndex(line => from <= line.end);
  const line = lines[index];
  if (to > line.end) return null;
  if ((kind === 'dialogue' || kind === 'parenthetical') && !hasDialogueContext(lines, index)) return null;

  let contentStart = line.text.length - line.text.trimStart().length;
  const leading = line.text.slice(0, contentStart);
  let contentEnd = Math.max(contentStart, line.text.trimEnd().length);
  const trailing = line.text.slice(contentEnd);
  contentStart += markerLength(line);
  // Parentheses are syntax only when the parser already identifies them as a
  // parenthetical. Parentheses in an action sentence remain authored content.
  if ((line.kind === 'parenthetical' || (!markerLength(line) && hasDialogueContext(lines, index)))
    && line.text[contentStart] === '(' && line.text[contentEnd - 1] === ')') {
    contentStart++;
    contentEnd--;
  }
  const content = line.text.slice(contentStart, contentEnd);
  let prefix = '', suffix = '';
  let visible = content;
  if (kind === 'character') { prefix = '@'; visible = content.toUpperCase(); }
  else if (kind === 'action') prefix = '!';
  else if (kind === 'transition') prefix = '>';
  else if (kind === 'scene_heading') prefix = readSceneHeading(content)?.forced === false ? '' : '.';
  else if (kind === 'parenthetical') { prefix = '('; suffix = ')'; }

  // A dot must touch its heading. Retain marker-adjacent spaces by moving them
  // before the new dot, instead of discarding any authored whitespace.
  const headingSpaces = kind === 'scene_heading' && prefix ? visible.match(/^[ \t]*/)?.[0] ?? '' : '';
  const nextLine = leading + headingSpaces + prefix + visible.slice(headingSpaces.length) + suffix + trailing;
  const nextValue = value.slice(0, line.start) + nextLine + value.slice(line.end);
  // Fountain cannot force dialogue (e.g. a scene-heading-shaped sentence).
  // Do not report a type change that its shared parser cannot represent.
  if (content.trim() && writingLines(nextValue)[index].kind !== kind
    && !(kind === 'parenthetical' && hasDialogueContext(lines, index))) return null;
  const mapOffset = (offset: number) => {
    const relative = Math.max(0, Math.min(content.length, offset - line.start - contentStart));
    const transformed = kind === 'character' ? content.slice(0, relative).toUpperCase().length : relative;
    return line.start + leading.length + prefix.length + Math.max(headingSpaces.length, transformed);
  };
  return { value: nextValue, selectionStart: mapOffset(from), selectionEnd: mapOffset(to), nextKind: kind };
}

const followingKind: Record<WritingElement, WritingElement> = {
  scene_heading: 'action', action: 'action', character: 'dialogue', dialogue: 'action',
  parenthetical: 'dialogue', transition: 'scene_heading',
};

export function enterWritingElement(value: string, start: number, end: number, kind: WritingElement, soft = false): WritingEdit {
  const [from, to] = range(value, start, end);
  const line = writingLineAt(value, from);
  // Formatting inserts the parenthetical's closing wrapper for the author.
  // Enter at the end of its content finishes that wrapper before continuing.
  const atClosingParenthesis = kind === 'parenthetical' && line.text.trimStart().startsWith('(')
    && line.text.trimEnd().endsWith(')') && from === line.start + line.text.trimEnd().length - 1;
  const structural = !soft && from === to && (from === line.end || atClosingParenthesis);
  const insertionPoint = structural && atClosingParenthesis ? line.end : from;
  const insertion = structural && kind !== 'character' && kind !== 'parenthetical' ? '\n\n' : '\n';
  const caret = insertionPoint + insertion.length;
  return {
    value: value.slice(0, insertionPoint) + insertion + value.slice(structural && atClosingParenthesis ? insertionPoint : to),
    selectionStart: caret,
    selectionEnd: caret,
    nextKind: structural ? followingKind[kind] : kind,
  };
}

export function cycleWritingElement(value: string, start: number, end: number, direction: 1 | -1, currentKind?: WritingElement): WritingEdit | null {
  const current = currentKind ?? writingLineAt(value, start).kind;
  const initial = elements.indexOf(current === 'empty' || current === 'other' ? 'action' : current);
  // Skip types that cannot be represented in this location (dialogue without
  // a cue), but never lowercase text while cycling out of a character cue.
  for (let step = 1; step < elements.length; step++) {
    const kind = elements[(initial + direction * step + elements.length) % elements.length];
    const edit = setWritingElement(value, start, end, kind);
    if (edit) return edit;
  }
  return null;
}

/** Reuse only names/headings actually present in this draft. */
export function writingSuggestions(value: string, offset: number, kind: WritingElement): string[] {
  if (kind !== 'character' && kind !== 'scene_heading') return [];
  const lines = writingLines(value);
  const current = writingLineAt(value, offset);
  let prefix = writingVisibleText(current).trim();
  // A freshly typed force marker may precede a line's complete parseable text.
  if (kind === 'character') prefix = prefix.replace(/^@/, '');
  else prefix = prefix.replace(/^\.(?!\.)/, '');
  const foldedPrefix = prefix.toLocaleLowerCase();
  const seen = new Set<string>();
  const result: string[] = [];
  for (const line of lines) {
    if (line.start === current.start || line.kind !== kind) continue;
    const suggestion = kind === 'character'
      ? readCharacterCue(line.text, { forced: line.text.trimStart().startsWith('@') })?.characterName
      : readSceneHeading(line.text)?.heading;
    if (!suggestion) continue;
    const folded = suggestion.toLocaleLowerCase();
    if (!seen.has(folded) && folded.startsWith(foldedPrefix) && folded !== foldedPrefix) {
      seen.add(folded);
      result.push(suggestion);
      if (result.length === 8) break;
    }
  }
  return result;
}
