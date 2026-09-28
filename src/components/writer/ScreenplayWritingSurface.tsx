import { forwardRef, useCallback, useImperativeHandle, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { FountainEditor, type FountainEditorHandle } from './FountainEditor';
import { ScreenplayPageEditor, type ScreenplayPageEditorHandle, type ScreenplayWritingSelection } from './ScreenplayPageEditor';
import { cycleWritingElement, enterWritingElement, setWritingElement, writingLineAt, writingVisibleText, type WritingEdit, type WritingElement } from './screenplayWritingModel';
import './screenplay-writing-surface.css';

// Textareas normalize line endings. Project their coordinates back onto the
// authored source and replace only the changed span, retaining all other bytes.
function sourceProjection(value: string) {
  const offsets = [0];
  let text = '';
  for (let index = 0; index < value.length; index++) {
    const char = value[index];
    text += char === '\r' ? '\n' : char;
    if (char === '\r' && value[index + 1] === '\n') index++;
    offsets.push(index + 1);
  }
  return {
    text,
    toSource: (offset: number) => offsets[Math.max(0, Math.min(text.length, offset))],
    toVisible: (offset: number) => value.slice(0, offset).replace(/\r\n|\r/g, '\n').length,
    edit(next: string) {
      let start = 0;
      while (start < text.length && start < next.length && text[start] === next[start]) start++;
      let end = text.length, nextEnd = next.length;
      while (end > start && nextEnd > start && text[end - 1] === next[nextEnd - 1]) { end--; nextEnd--; }
      const eol = value.match(/\r\n|\r|\n/)?.[0] ?? '\n';
      return value.slice(0, offsets[start]) + next.slice(start, nextEnd).replace(/\n/g, eol) + value.slice(offsets[end]);
    },
  };
}

export interface ScreenplayWritingSurfaceHandle { focusOffset(offset: number): void; focusRange(start: number, end: number): void; insertAtCursor(text: string): void; undo(): void; redo(): void }
type Props = { value: string; onChange(value: string): void; disabled?: boolean; onSave?(): void; ariaLabel?: string; onSelectionChange?(selection: ScreenplayWritingSelection): void; historyValue?: string; onRestoreValue?(value: string): void; revisedLineStarts?: ReadonlySet<number> };
const ELEMENTS: [WritingElement, string][] = [['scene_heading', 'Scene heading'], ['action', 'Action'], ['character', 'Character'], ['dialogue', 'Dialogue'], ['parenthetical', 'Parenthetical'], ['transition', 'Transition']];
interface Snapshot { value: string; historyValue?: string; selection: ScreenplayWritingSelection }
const selectionFor = (value: string, start: number, end = start): ScreenplayWritingSelection => {
  const kind = writingLineAt(value, start).kind;
  return { start, end, kind: kind === 'empty' || kind === 'other' ? 'action' : kind };
};
function retain(stack: Snapshot[], snapshot: Snapshot) {
  stack.push(snapshot);
  let size = stack.reduce((sum, item) => sum + item.value.length + (item.historyValue?.length ?? 0), 0);
  while (stack.length > 1 && (stack.length > 100 || size > 4_000_000)) { const first = stack.shift()!; size -= first.value.length + (first.historyValue?.length ?? 0); }
}

/** A single local draft and undo history shared by page and source views. Key by draft identity. */
export const ScreenplayWritingSurface = forwardRef<ScreenplayWritingSurfaceHandle, Props>(function ScreenplayWritingSurface({ value, onChange, disabled = false, onSave, ariaLabel = 'Fountain screenplay', onSelectionChange, historyValue, onRestoreValue, revisedLineStarts }, ref) {
  const [mode, setMode] = useState<'page' | 'source'>('page');
  const [zoom, setZoom] = useState(100);
  const [selection, setSelection] = useState(() => selectionFor(value, 0));
  const selectionRef = useRef(selection), current = useRef(value);
  const rawValue = useRef(historyValue), localUpdate = useRef(false);
  const back = useRef<Snapshot[]>([]), ahead = useRef<Snapshot[]>([]);
  const [historyRevision, setHistoryRevision] = useState(0);
  const [feedback, setFeedback] = useState('');
  const projectedSource = sourceProjection(value);
  const source = useRef<FountainEditorHandle>(null), page = useRef<ScreenplayPageEditorHandle>(null);
  const pendingFocus = useRef<ScreenplayWritingSelection | null>(null);
  const pendingSourceKind = useRef<{ start: number; kind: WritingElement } | null>(null);
  const report = useCallback((next: ScreenplayWritingSelection) => {
    selectionRef.current = next;
    setSelection(previous => previous.start === next.start && previous.end === next.end && previous.kind === next.kind ? previous : next);
    onSelectionChange?.(next);
  }, [onSelectionChange]);
  useLayoutEffect(() => {
    // Loading/recovering a different body outside the editor starts a fresh undo branch.
    const external = !localUpdate.current && (current.current !== value || rawValue.current !== historyValue);
    current.current = value; rawValue.current = historyValue; localUpdate.current = false;
    if (external) {
      current.current = value; back.current = []; ahead.current = [];
      setHistoryRevision(revision => revision + 1);
      report(selectionFor(value, Math.min(selectionRef.current.start, value.length)));
    }
  }, [value, historyValue, report]);
  const focus = useCallback((next: ScreenplayWritingSelection) => {
    report(next);
    const line = writingLineAt(value, next.start);
    pendingSourceKind.current = !line.text.trim() && next.kind !== 'action' ? { start: line.start, kind: next.kind } : null;
    if (mode === 'page') {
      const projection = sourceProjection(value);
      page.current?.focusSelection({ ...next, start: projection.toVisible(next.start), end: projection.toVisible(next.end) });
    }
    else {
      const textarea = source.current?.getTextarea();
      if (textarea) { const projection = sourceProjection(value); textarea.focus(); textarea.setSelectionRange(projection.toVisible(next.start), projection.toVisible(next.end)); textarea.scrollTop = Math.max(0, value.slice(0, next.start).split('\n').length * 24 - textarea.clientHeight / 3); }
    }
  }, [mode, report, value]);
  useLayoutEffect(() => { if (pendingFocus.current) { const next = pendingFocus.current; pendingFocus.current = null; focus(next); } }, [value, mode, historyRevision, focus]);
  const change = useCallback((next: string) => {
    if (disabled || next === current.current) return;
    retain(back.current, { value: current.current, historyValue, selection: selectionRef.current });
    ahead.current = []; current.current = next; localUpdate.current = true; onChange(next); setFeedback('');
    setHistoryRevision(revision => revision + 1);
  }, [disabled, onChange, historyValue]);
  const pageChange = useCallback((next: string) => change(sourceProjection(current.current).edit(next)), [change]);
  const pageSelection = useCallback((next: ScreenplayWritingSelection) => {
    const projection = sourceProjection(current.current);
    report({ ...next, start: projection.toSource(next.start), end: projection.toSource(next.end) });
  }, [report]);
  function apply(edit: WritingEdit | null) {
    if (!edit) { setFeedback('Choose one paragraph. Dialogue and parentheticals need a preceding character cue.'); return; }
    pendingFocus.current = { start: edit.selectionStart, end: edit.selectionEnd, kind: edit.nextKind ?? selection.kind };
    change(edit.value); setHistoryRevision(revision => revision + 1);
  }
  function applySource(edit: WritingEdit | null) {
    if (!edit) { apply(null); return; }
    const next = projectedSource.edit(edit.value);
    const projection = sourceProjection(next);
    apply({ ...edit, value: next, selectionStart: projection.toSource(edit.selectionStart), selectionEnd: projection.toSource(edit.selectionEnd) });
  }
  const restore = useCallback((direction: 'undo' | 'redo') => {
    if (disabled) return;
    const from = direction === 'undo' ? back.current : ahead.current;
    const to = direction === 'undo' ? ahead.current : back.current;
    const snapshot = from.pop(); if (!snapshot) return;
    retain(to, { value: current.current, historyValue, selection: selectionRef.current });
    current.current = snapshot.value; localUpdate.current = true; pendingFocus.current = snapshot.selection;
    if (snapshot.historyValue !== undefined && onRestoreValue) onRestoreValue(snapshot.historyValue); else onChange(snapshot.value); setHistoryRevision(revision => revision + 1); setFeedback('');
  }, [disabled, onChange, historyValue, onRestoreValue]);
  function insertAtCursor(text: string) {
    if (disabled) return;
    let { start, end } = selectionRef.current;
    const line = writingLineAt(value, start);
    const marker = line.text.length - writingVisibleText(line).length;
    const leading = line.text.length - line.text.trimStart().length;
    if (mode === 'page' && marker && start === end && start === line.start + leading + marker) start = end = line.start;
    const before = value.slice(0, start), after = value.slice(end);
    const pad = before && !before.endsWith('\n\n') ? before.endsWith('\n') ? '\n' : '\n\n' : '';
    const next = before + pad + text + '\n' + after;
    const at = before.length + pad.length + text.length + 1;
    apply({ value: next, selectionStart: at, selectionEnd: at });
  }
  useImperativeHandle(ref, () => ({
    focusOffset(offset) { focus(selectionFor(value, Math.max(0, Math.min(value.length, offset)))); },
    focusRange(start, end) {
      const next = selectionFor(value, Math.max(0, Math.min(value.length, start)), Math.max(0, Math.min(value.length, end)));
      // Source view can show every match, including markers and multiline hits.
      if (mode !== 'source') { pendingFocus.current = next; setMode('source'); }
      else focus(next);
    },
    insertAtCursor, undo: () => restore('undo'), redo: () => restore('redo'),
  }));
  function sourceKey(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (disabled || event.nativeEvent.isComposing) return;
    const { selectionStart: start, selectionEnd: end } = event.currentTarget;
    if ((event.metaKey || event.ctrlKey) && !event.altKey) {
      const key = event.key.toLowerCase();
      if (key === 's' && !event.shiftKey) { event.preventDefault(); event.stopPropagation(); onSave?.(); }
      else if (key === 'z') { event.preventDefault(); restore(event.shiftKey ? 'redo' : 'undo'); }
      else if (/^[1-6]$/.test(key)) { event.preventDefault(); applySource(setWritingElement(projectedSource.text, start, end, ELEMENTS[Number(key) - 1][0])); }
      return;
    }
    if (event.altKey || event.metaKey || event.ctrlKey) return;
    const line = writingLineAt(projectedSource.text, start);
    const kind = pendingSourceKind.current?.start === projectedSource.toSource(line.start) ? pendingSourceKind.current.kind : selectionFor(projectedSource.text, start).kind;
    if (event.key === 'Tab') { event.preventDefault(); applySource(cycleWritingElement(projectedSource.text, start, end, event.shiftKey ? -1 : 1, kind)); }
    else if (event.key === 'Enter') { event.preventDefault(); applySource(enterWritingElement(projectedSource.text, start, end, kind, event.shiftKey)); }
  }
  function sourceChange(next: string, composing = false) {
    next = projectedSource.edit(next);
    if (composing) { pendingSourceKind.current = null; change(next); return; }
    const intent = pendingSourceKind.current;
    const oldLine = writingLineAt(value, selectionRef.current.start);
    if (intent?.start === oldLine.start && !oldLine.text.trim()) {
      const textarea = source.current?.getTextarea();
      const projection = sourceProjection(next);
      const start = textarea ? projection.toSource(textarea.selectionStart) : selectionRef.current.start;
      const end = textarea ? projection.toSource(textarea.selectionEnd) : start;
      const replacementLength = next.length - value.length + oldLine.text.length;
      const inserted = next.slice(oldLine.start, oldLine.start + replacementLength);
      if (inserted.trim() && !inserted.includes('\n')) {
        const edit = setWritingElement(next, start, end, intent.kind);
        if (edit) { apply(edit); return; }
      }
    }
    pendingSourceKind.current = null;
    change(next);
  }
  function sourceSelection(start: number, end: number) {
    const projection = sourceProjection(current.current);
    start = projection.toSource(start); end = projection.toSource(end);
    const next = selectionFor(value, start, end);
    const line = writingLineAt(value, start);
    if (pendingSourceKind.current?.start === line.start && !line.text.trim()) next.kind = pendingSourceKind.current.kind;
    else pendingSourceKind.current = null;
    report(next);
  }
  function chooseElement(kind: WritingElement) {
    if (disabled) return;
    if (mode === 'page') page.current?.setElement(kind);
    else applySource(setWritingElement(projectedSource.text, projectedSource.toVisible(selectionRef.current.start), projectedSource.toVisible(selectionRef.current.end), kind));
  }
  return <section className="screenplay-writing-surface" aria-label="Screenplay writing surface">
    <div className="screenplay-writing-toolbar" aria-label="Screenplay controls">
      <div className="screenplay-writing-modes" aria-label="Writing view">{([['page', 'Page'], ['source', 'Fountain']] as const).map(([key, label]) => <button type="button" key={key} aria-pressed={mode === key} onClick={() => { if (mode !== key) { pendingFocus.current = selectionRef.current; setMode(key); } }}>{label}</button>)}</div>
      <label className="screenplay-element-control"><span>Element</span><select aria-label="Screenplay element" value={selection.kind} disabled={disabled} onChange={event => chooseElement(event.target.value as WritingElement)}>{ELEMENTS.map(([kind, label]) => <option key={kind} value={kind}>{label}</option>)}</select></label>
      <div className="screenplay-history-controls"><button type="button" disabled={disabled || !back.current.length} title="Undo · ⌘Z / Ctrl+Z" onClick={() => restore('undo')}>Undo</button><button type="button" disabled={disabled || !ahead.current.length} title="Redo · ⇧⌘Z / Ctrl+Shift+Z" onClick={() => restore('redo')}>Redo</button></div>
      {mode === 'page' && <label className="screenplay-zoom-control"><span className="screenplay-sr-only">Page zoom</span><select aria-label="Page zoom" value={zoom} onChange={event => setZoom(Number(event.target.value))}>{[85, 100, 115].map(size => <option key={size} value={size}>{size}%</option>)}</select></label>}
      <details className="screenplay-insert-menu"><summary>Insert</summary><div aria-label="Fountain formatting">{[['Scene', 'INT. LOCATION - DAY'], ['Dialogue', 'CHARACTER\nDialogue here.'], ['Action', 'Action description.'], ['Transition', 'CUT TO:']].map(([label, text]) => <button key={label} type="button" disabled={disabled} onClick={event => { event.currentTarget.closest('details')?.removeAttribute('open'); insertAtCursor(text); }}>{label}</button>)}</div></details>
    </div>
    {feedback && <p className="screenplay-writing-feedback" role="status">{feedback}</p>}
    {mode === 'page' ? <ScreenplayPageEditor ref={page} value={projectedSource.text} onChange={pageChange} disabled={disabled} onSelectionChange={pageSelection} onSave={onSave} onUndo={() => restore('undo')} onRedo={() => restore('redo')} zoom={zoom} revisedLineStarts={revisedLineStarts && new Set([...revisedLineStarts].map(projectedSource.toVisible))}/> : <FountainEditor ref={source} value={projectedSource.text} onChange={sourceChange} disabled={disabled} ariaLabel={ariaLabel} smartFormatting={false} onEditorKeyDown={sourceKey} onSelectionChange={sourceSelection} className="screenplay-source-editor" minHeight={440} placeholder="INT. YOUR SCENE - DAY"/>}
    <footer className="screenplay-writing-footer"><span>Enter · next element <b> / </b> Tab · change element <b> / </b> ⌘1–6 · element <b> / </b> ⌘S · save</span><details><summary>Writing help</summary><p>Click any paragraph to write. Character and location suggestions come from this draft. Shift+Enter adds a line within the current element. On Windows use Ctrl in place of ⌘. Page view edits one paragraph at a time; use Fountain for whole-script selection. Screenplay layout is approximate; review export pagination before delivery.</p></details></footer>
  </section>;
});
