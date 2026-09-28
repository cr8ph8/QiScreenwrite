import { forwardRef, useCallback, useId, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent, MouseEvent } from 'react';
import {
  cycleWritingElement, enterWritingElement, setWritingElement, writingLineAt,
  writingLines, writingSuggestions, writingVisibleText,
} from './screenplayWritingModel';
import type { WritingEdit, WritingElement, WritingLine } from './screenplayWritingModel';
import './screenplay-page-editor.css';

export interface ScreenplayWritingSelection { start: number; end: number; kind: WritingElement }
export interface ScreenplayPageEditorHandle {
  focusOffset(offset: number): void;
  focusSelection(selection: ScreenplayWritingSelection): void;
  setElement(kind: WritingElement): void;
  getSelection(): ScreenplayWritingSelection;
  undo(): void;
  redo(): void;
}
export interface ScreenplayPageEditorProps {
  value: string;
  onChange(next: string): void;
  disabled?: boolean;
  onSelectionChange?(selection: ScreenplayWritingSelection): void;
  onSave?(): void;
  onUndo?(): void;
  onRedo?(): void;
  ariaLabel?: string;
  zoom?: number;
  /** Source offsets of lines that changed since a chosen revision; drawn with a margin asterisk. */
  revisedLineStarts?: ReadonlySet<number>;
}

const ELEMENTS: WritingElement[] = ['scene_heading', 'action', 'character', 'dialogue', 'parenthetical', 'transition'];
const LABELS: Record<WritingElement, string> = {
  scene_heading: 'Scene heading', action: 'Action', character: 'Character', dialogue: 'Dialogue', parenthetical: 'Parenthetical', transition: 'Transition',
};
interface Snapshot { value: string; selection: ScreenplayWritingSelection }
const clamp = (offset: number, value: string) => Math.max(0, Math.min(value.length, offset));
const coreKind = (line: WritingLine): WritingElement => ELEMENTS.includes(line.kind as WritingElement) ? line.kind as WritingElement : 'action';

/** Hide only a recognized force marker; all authored spaces remain editable. */
function projectLine(line: WritingLine) {
  const visible = writingVisibleText(line);
  const hidden = line.text.length - visible.length;
  const markerAt = line.text.length - line.text.trimStart().length;
  return {
    visible,
    marker: hidden ? line.text.slice(markerAt, markerAt + hidden) : '',
    toSource: (offset: number) => line.start + Math.min(visible.length, Math.max(0, offset)) + (offset >= markerAt ? hidden : 0),
    toVisible: (offset: number) => {
      const relative = Math.min(line.text.length, Math.max(0, offset - line.start));
      return relative - (relative > markerAt ? Math.min(hidden, relative - markerAt) : 0);
    },
  };
}

/** Keep the original line's marker, including when pasted text adds new lines. */
function replaceVisibleLine(line: WritingLine, typed: string) {
  const marker = projectLine(line).marker;
  const firstLine = typed.split('\n', 1)[0];
  const markerAt = firstLine.length - firstLine.trimStart().length;
  return {
    text: typed.slice(0, markerAt) + marker + typed.slice(markerAt),
    toSource: (offset: number) => line.start + offset + (offset >= markerAt ? marker.length : 0),
  };
}

/** Bound both step count and retained text, including long screenplay drafts. */
function retain(stack: Snapshot[], snapshot: Snapshot) {
  stack.push(snapshot);
  let characters = stack.reduce((total, entry) => total + entry.value.length, 0);
  while (stack.length > 1 && (stack.length > 100 || characters > 4_000_000)) characters -= stack.shift()!.value.length;
}

/** The browser's text caret API accounts for wrapping and the actual rendered font. */
function clickedTextOffset(event: MouseEvent<HTMLElement>, content: HTMLElement): number {
  type CaretDocument = Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  };
  const document = content.ownerDocument as CaretDocument;
  const caret = document.caretPositionFromPoint?.(event.clientX, event.clientY);
  const range = caret ? null : document.caretRangeFromPoint?.(event.clientX, event.clientY);
  const node = caret?.offsetNode ?? range?.startContainer;
  const offset = caret?.offset ?? range?.startOffset;
  if (node && offset !== undefined && content.contains(node)) {
    const before = document.createRange();
    before.selectNodeContents(content);
    before.setEnd(node, offset);
    return before.toString().length;
  }
  return event.clientX <= content.getBoundingClientRect().left ? 0 : content.textContent?.length ?? 0;
}

/** One source-line textarea surrounded by a formatted, lossless view of the draft. */
export const ScreenplayPageEditor = forwardRef<ScreenplayPageEditorHandle, ScreenplayPageEditorProps>(function ScreenplayPageEditor({
  value, onChange, disabled = false, onSelectionChange, onSave, onUndo, onRedo,
  ariaLabel = 'Screenplay page line', zoom = 100, revisedLineStarts,
}, ref) {
  const id = useId();
  const textarea = useRef<HTMLTextAreaElement>(null);
  const documentValue = useRef(value);
  const initialSelection = { start: 0, end: 0, kind: coreKind(writingLineAt(value, 0)) };
  const selectionRef = useRef<ScreenplayWritingSelection>(initialSelection);
  const [selection, setSelection] = useState(initialSelection);
  const [focused, setFocused] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [dismissedSuggestions, setDismissedSuggestions] = useState('');
  const [suggestionIndex, setSuggestionIndex] = useState(0);
  const pendingFocus = useRef<ScreenplayWritingSelection | null>(null);
  const restoringSelection = useRef(false);
  const pendingKind = useRef<{ start: number; kind: WritingElement } | null>(null);
  const composing = useRef(false);
  const compositionRecorded = useRef(false);
  const undoStack = useRef<Snapshot[]>([]);
  const redoStack = useRef<Snapshot[]>([]);
  const lines = useMemo(() => writingLines(value), [value]);
  const activePoint = clamp(selection.start, value);
  const activeLine = lines.find(line => activePoint <= line.end) ?? lines[lines.length - 1];
  const activeKind = pendingKind.current?.start === activeLine.start ? pendingKind.current.kind : coreKind(activeLine);

  const updateSelection = useCallback((next: ScreenplayWritingSelection, focus = false) => {
    const previous = selectionRef.current;
    const changed = previous.start !== next.start || previous.end !== next.end || previous.kind !== next.kind;
    selectionRef.current = next;
    if (focus) pendingFocus.current = next;
    if (changed || focus) setSelection(next);
    if (changed) onSelectionChange?.(next);
  }, [onSelectionChange]);

  const moveTo = useCallback((offset: number, end = offset, kind?: WritingElement) => {
    const source = documentValue.current;
    const line = writingLineAt(source, clamp(offset, source));
    const projected = projectLine(line);
    pendingKind.current = kind ? { start: line.start, kind } : null;
    setDismissedSuggestions('');
    setSuggestionIndex(0);
    updateSelection({ start: projected.toSource(projected.toVisible(offset)), end: projected.toSource(projected.toVisible(end)), kind: kind ?? coreKind(line) }, true);
  }, [updateSelection]);

  const commit = useCallback((edit: WritingEdit, record = true) => {
    if (disabled) return;
    const previous = documentValue.current;
    if (edit.value !== previous && record && (!composing.current || !compositionRecorded.current)) {
      retain(undoStack.current, { value: previous, selection: { ...selectionRef.current } });
      redoStack.current = [];
      if (composing.current) compositionRecorded.current = true;
    }
    documentValue.current = edit.value;
    if (edit.value !== previous) onChange(edit.value);
    const line = writingLineAt(edit.value, edit.selectionStart);
    pendingKind.current = edit.nextKind ? { start: line.start, kind: edit.nextKind } : null;
    setDismissedSuggestions('');
    setSuggestionIndex(0);
    setFeedback('');
    updateSelection({ start: edit.selectionStart, end: edit.selectionEnd, kind: edit.nextKind ?? coreKind(line) }, !composing.current);
  }, [disabled, onChange, updateSelection]);

  const changeElement = useCallback((kind: WritingElement) => {
    if (disabled) return;
    const current = selectionRef.current;
    const edit = setWritingElement(documentValue.current, current.start, current.end, kind);
    if (!edit) {
      setFeedback(kind === 'dialogue' || kind === 'parenthetical'
        ? 'Add a character cue above this line before choosing dialogue or a parenthetical.'
        : 'Choose one screenplay line. Use Fountain view for other source text.');
      return;
    }
    commit(edit);
  }, [commit, disabled]);

  const undo = useCallback(() => {
    if (disabled) return;
    if (onUndo) { onUndo(); return; }
    const entry = undoStack.current.pop();
    if (!entry) return;
    retain(redoStack.current, { value: documentValue.current, selection: { ...selectionRef.current } });
    commit({ value: entry.value, selectionStart: entry.selection.start, selectionEnd: entry.selection.end, nextKind: entry.selection.kind }, false);
  }, [commit, disabled, onUndo]);
  const redo = useCallback(() => {
    if (disabled) return;
    if (onRedo) { onRedo(); return; }
    const entry = redoStack.current.pop();
    if (!entry) return;
    retain(undoStack.current, { value: documentValue.current, selection: { ...selectionRef.current } });
    commit({ value: entry.value, selectionStart: entry.selection.start, selectionEnd: entry.selection.end, nextKind: entry.selection.kind }, false);
  }, [commit, disabled, onRedo]);

  useImperativeHandle(ref, () => ({
    focusOffset: offset => moveTo(offset),
    focusSelection: next => moveTo(next.start, next.end, next.kind === 'action' && !writingLineAt(documentValue.current, next.start).text.trim() ? undefined : next.kind),
    setElement: changeElement,
    getSelection: () => ({ ...selectionRef.current }), undo, redo,
  }), [changeElement, moveTo, redo, undo]);

  useLayoutEffect(() => {
    // Parent changes (recovery, source editing, draft loading) are authoritative.
    if (documentValue.current !== value) {
      documentValue.current = value;
      undoStack.current = [];
      redoStack.current = [];
      const start = clamp(selectionRef.current.start, value);
      const line = writingLineAt(value, start);
      pendingKind.current = null;
      updateSelection({ start, end: Math.min(line.end, clamp(selectionRef.current.end, value)), kind: coreKind(line) });
    }
    const input = textarea.current;
    if (!input) return;
    input.style.height = '0px';
    input.style.height = `${Math.max(input.scrollHeight, 20)}px`;
    const next = pendingFocus.current;
    if (next && !disabled) {
      pendingFocus.current = null;
      restoringSelection.current = true;
      input.focus({ preventScroll: true });
      const projected = projectLine(activeLine);
      input.setSelectionRange(projected.toVisible(next.start), projected.toVisible(next.end));
      restoringSelection.current = false;
      const parent = input.closest('.screenplay-page-scroll');
      if (parent) {
        const outer = parent.getBoundingClientRect(), inner = input.getBoundingClientRect();
        if (inner.top < outer.top || inner.bottom > outer.bottom) input.scrollIntoView?.({ block: 'nearest' });
      }
    }
  }, [activeLine, disabled, selection, updateSelection, value, zoom]);

  const suggestionKey = `${activeLine.start}:${activeKind}:${activeLine.text}`;
  const suggestions = focused && !disabled && !composing.current && selection.start === selection.end && dismissedSuggestions !== suggestionKey
    ? writingSuggestions(value, selection.start, activeKind).slice(0, 6) : [];
  const selectedSuggestion = Math.min(suggestionIndex, Math.max(0, suggestions.length - 1));

  const acceptSuggestion = (text: string) => {
    const source = documentValue.current;
    const current = writingLineAt(source, selectionRef.current.start);
    const indentation = current.text.match(/^\s*/)?.[0] ?? '';
    const replacement = indentation + text;
    const next = source.slice(0, current.start) + replacement + source.slice(current.end);
    const end = current.start + replacement.length;
    const edit = setWritingElement(next, end, end, selectionRef.current.kind);
    if (edit) commit(edit);
  };

  const readSelection = () => {
    if (restoringSelection.current || pendingFocus.current) return selectionRef.current;
    const input = textarea.current;
    if (!input) return selectionRef.current;
    const projected = projectLine(activeLine);
    const next = { start: projected.toSource(input.selectionStart), end: projected.toSource(input.selectionEnd), kind: activeKind };
    updateSelection(next);
    return next;
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (disabled || composing.current || event.nativeEvent.isComposing || event.keyCode === 229) return;
    const current = readSelection();
    const command = event.metaKey || event.ctrlKey;
    if (command && !event.altKey) {
      const key = event.key.toLowerCase();
      if (key === 's' && !event.shiftKey && onSave) { event.preventDefault(); event.stopPropagation(); onSave(); return; }
      if (key === 'z') { event.preventDefault(); event.stopPropagation(); if (event.shiftKey) redo(); else undo(); return; }
      if (key === 'y' && !event.shiftKey) { event.preventDefault(); event.stopPropagation(); redo(); return; }
      if (!event.shiftKey && /^[1-6]$/.test(key)) {
        event.preventDefault(); event.stopPropagation(); changeElement(ELEMENTS[Number(key) - 1]); return;
      }
    }
    if (command || event.altKey) return;
    if (suggestions.length > 0) {
      if (event.key === 'Escape') {
        event.preventDefault(); event.stopPropagation(); setDismissedSuggestions(suggestionKey); return;
      }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault(); event.stopPropagation();
        setSuggestionIndex((selectedSuggestion + (event.key === 'ArrowDown' ? 1 : -1) + suggestions.length) % suggestions.length); return;
      }
      if ((event.key === 'Enter' || event.key === 'Tab') && !event.shiftKey) {
        event.preventDefault(); event.stopPropagation(); acceptSuggestion(suggestions[selectedSuggestion]); return;
      }
    }
    const source = documentValue.current;
    if (event.key === 'Enter') {
      event.preventDefault(); event.stopPropagation();
      commit(enterWritingElement(source, current.start, current.end, current.kind, event.shiftKey)); return;
    }
    if (event.key === 'Tab') {
      event.preventDefault(); event.stopPropagation();
      const edit = cycleWritingElement(source, current.start, current.end, event.shiftKey ? -1 : 1, current.kind);
      if (edit) commit(edit); else setFeedback('This source line has no screenplay element. Use Fountain view to edit its structure.');
      return;
    }
    if (event.shiftKey || current.start !== current.end) return;
    const atStart = event.currentTarget.selectionStart === 0, atEnd = current.start === activeLine.end;
    if (atStart && activeLine.start > 0 && (event.key === 'ArrowUp' || event.key === 'ArrowLeft')) {
      event.preventDefault(); moveTo(activeLine.start - 1); return;
    }
    if (atEnd && activeLine.end < source.length && (event.key === 'ArrowDown' || event.key === 'ArrowRight')) {
      event.preventDefault(); moveTo(activeLine.end + 1); return;
    }
    if (atStart && activeLine.start > 0 && event.key === 'Backspace') {
      event.preventDefault();
      const join = activeLine.start - 1;
      commit({ value: source.slice(0, join) + writingVisibleText(activeLine) + source.slice(activeLine.end), selectionStart: join, selectionEnd: join }); return;
    }
    if (atEnd && activeLine.end < source.length && event.key === 'Delete') {
      event.preventDefault();
      const nextLine = writingLineAt(source, activeLine.end + 1);
      commit({ value: source.slice(0, current.start) + writingVisibleText(nextLine) + source.slice(nextLine.end), selectionStart: current.start, selectionEnd: current.start });
    }
  };

  return <div className="screenplay-page-editor">
    <p id={`${id}-help`} className="screenplay-page-help">Click a line to write. Enter continues your screenplay; Tab changes its element. Use Fountain for selections across lines.</p>
    {feedback && <p className="screenplay-page-feedback" role="status">{feedback}</p>}
    <div className="screenplay-page-scroll" role="region" aria-label="Screenplay writing page">
      <div className="screenplay-paper" style={{ '--screenplay-zoom': Math.min(150, Math.max(75, zoom)) / 100 } as CSSProperties}>
        {lines.map((line, index) => {
          const active = line.start === activeLine.start;
          const visible = writingVisibleText(line);
          const lineKind = active && pendingKind.current?.start === line.start ? pendingKind.current.kind : line.kind;
          return <div key={index} className={`screenplay-page-line screenplay-page-line--${lineKind}${active ? ' is-active' : ''}${revisedLineStarts?.has(line.start) ? ' is-revised' : ''}`} data-source-start={line.start} data-source-end={line.end} data-element={lineKind}>
            {active ? <>
              <textarea
                ref={textarea}
                aria-label={ariaLabel}
                aria-describedby={`${id}-help`}
                aria-autocomplete={suggestions.length ? 'list' : 'none'}
                aria-controls={suggestions.length ? `${id}-suggestions` : undefined}
                aria-activedescendant={suggestions.length ? `${id}-suggestion-${selectedSuggestion}` : undefined}
                value={visible}
                disabled={disabled}
                rows={1}
                spellCheck
                onFocus={() => { setFocused(true); readSelection(); }}
                onBlur={() => setFocused(false)}
                onSelect={readSelection}
                onClick={readSelection}
                onKeyUp={event => { if (!composing.current && event.key !== 'Enter' && event.key !== 'Tab') readSelection(); }}
                onKeyDown={handleKeyDown}
                onCompositionStart={() => { composing.current = true; compositionRecorded.current = false; }}
                onCompositionEnd={() => { composing.current = false; compositionRecorded.current = false; readSelection(); }}
                onChange={event => {
                  const typed = event.currentTarget.value;
                  const source = documentValue.current;
                  const replacement = replaceVisibleLine(line, typed);
                  const next = source.slice(0, line.start) + replacement.text + source.slice(line.end);
                  let edit: WritingEdit = { value: next, selectionStart: replacement.toSource(event.currentTarget.selectionStart), selectionEnd: replacement.toSource(event.currentTarget.selectionEnd) };
                  const intent = pendingKind.current;
                  if (intent?.start === line.start && !line.text.trim() && typed.trim() && !typed.includes('\n') && !composing.current) {
                    edit = setWritingElement(next, edit.selectionStart, edit.selectionEnd, intent.kind) ?? edit;
                  } else if (intent?.start === line.start && !typed.trim()) edit.nextKind = intent.kind;
                  commit(edit);
                }}
              />
              {suggestions.length > 0 && <div className="screenplay-suggestions" role="listbox" id={`${id}-suggestions`} aria-label={activeKind === 'character' ? 'Existing character names' : 'Existing scene headings'}>
                {suggestions.map((suggestion, suggestionNumber) => <div
                  key={suggestion} id={`${id}-suggestion-${suggestionNumber}`} role="option" aria-selected={selectedSuggestion === suggestionNumber}
                  className={selectedSuggestion === suggestionNumber ? 'is-selected' : ''}
                  onMouseDown={event => { event.preventDefault(); acceptSuggestion(suggestion); }}
                >{suggestion}</div>)}
                <span className="screenplay-suggestions-help">↑ ↓ choose · Enter accepts · Esc closes</span>
              </div>}
            </> : <div
              className="screenplay-page-readline" role="button" tabIndex={-1} aria-disabled={disabled}
              aria-label={`${line.kind === 'empty' ? 'Blank line' : line.kind === 'other' ? 'Source text' : LABELS[line.kind]}, line ${index + 1}: ${visible}`}
              onClick={event => {
                if (disabled) return;
                const span = event.currentTarget.firstElementChild as HTMLElement;
                const clicked = clickedTextOffset(event, span);
                moveTo(projectLine(line).toSource(clicked));
              }}
              onKeyDown={event => {
                if (!disabled && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); moveTo(line.start); }
              }}
            ><span>{visible || '\u200b'}</span></div>}
          </div>;
        })}
      </div>
    </div>
  </div>;
});
