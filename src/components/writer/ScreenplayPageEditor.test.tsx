import { createRef, useState } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ScreenplayPageEditor } from './ScreenplayPageEditor';
import type { ScreenplayPageEditorHandle, ScreenplayPageEditorProps } from './ScreenplayPageEditor';

afterEach(cleanup);

function open(initial: string, props: Partial<ScreenplayPageEditorProps> = {}) {
  const ref = createRef<ScreenplayPageEditorHandle>();
  const changed = vi.fn();
  let latest = initial;
  function Harness() {
    const [value, setValue] = useState(initial);
    latest = value;
    return <ScreenplayPageEditor {...props} ref={ref} value={value} onChange={next => { changed(next); setValue(next); }}/>;
  }
  const view = render(<Harness/>);
  return { ...view, ref, changed, text: () => latest };
}
const input = () => screen.getByRole('textbox', { name: 'Screenplay page line' }) as HTMLTextAreaElement;
function type(text: string) { fireEvent.change(input(), { target: { value: text, selectionStart: text.length, selectionEnd: text.length } }); }
function caret(offset: number) { input().setSelectionRange(offset, offset); fireEvent.select(input()); }

it('keeps all physical source lines, title metadata, notes and spaces while switching the active line', () => {
  const original = 'Title: A precise draft\n\nINT. ROOM - DAY\n\n  @ADA\n  I keep my spaces.  \n\n[[A private note.]]\n';
  const page = open(original);
  expect(page.changed).not.toHaveBeenCalled();
  expect(page.container.querySelectorAll('[data-source-start]')).toHaveLength(original.split('\n').length);
  expect(screen.getAllByRole('textbox')).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: 'Character, line 5: ADA' }));
  expect(input()).toHaveValue('  ADA');
  expect(input()).toHaveFocus();
  expect(screen.getAllByRole('textbox')).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: 'Source text, line 8: [[A private note.]]' }));
  expect(input()).toHaveValue('[[A private note.]]');
  expect(page.text()).toBe(original);
  expect(page.changed).not.toHaveBeenCalled();
});

it('uses the rendered text caret to map a click through a hidden force marker', () => {
  const page = open('Opening.\n\n  @ADA\nHello.');
  const button = screen.getByRole('button', { name: 'Character, line 3: ADA' });
  const span = button.firstElementChild!;
  const documentWithCaret = document as Document & { caretPositionFromPoint?: unknown };
  documentWithCaret.caretPositionFromPoint = () => ({ offsetNode: span.firstChild, offset: 4, getClientRect: () => span.getBoundingClientRect() });
  fireEvent.click(button, { clientX: 20, clientY: 20 });
  delete documentWithCaret.caretPositionFromPoint;
  expect(input().selectionStart).toBe(4);
  expect(page.ref.current?.getSelection().start).toBe('Opening.\n\n'.length + 5);
  type('  ADAM');
  expect(page.text()).toBe('Opening.\n\n  @ADAM\nHello.');
});

it('carries character to dialogue and dialogue to action with a live caret after typing', () => {
  const page = open('INT. ROOM - DAY\n\n@ADA');
  act(() => page.ref.current?.focusOffset(page.text().length));
  fireEvent.keyDown(input(), { key: 'Enter' });
  expect(page.text()).toBe('INT. ROOM - DAY\n\n@ADA\n');
  expect(page.ref.current?.getSelection().kind).toBe('dialogue');
  type('I can write here.');
  expect(page.text()).toBe('INT. ROOM - DAY\n\n@ADA\nI can write here.');
  expect(input().selectionStart).toBe('I can write here.'.length);
  fireEvent.keyDown(input(), { key: 'Enter' });
  expect(page.ref.current?.getSelection().kind).toBe('action');
  type('She turns away.');
  expect(page.text()).toBe('INT. ROOM - DAY\n\n@ADA\nI can write here.\n\n!She turns away.');
  expect(input()).toHaveFocus();
  expect(input()).toHaveValue('She turns away.');
  expect(input().selectionStart).toBe('She turns away.'.length);
});

it('cycles elements explicitly, retains selection offsets and undoes formatting and typing', () => {
  const page = open('Ada');
  act(() => page.ref.current?.focusOffset(3));
  fireEvent.keyDown(input(), { key: 'Tab' });
  expect(page.text()).toBe('@ADA');
  expect(input()).toHaveValue('ADA');
  expect(input().selectionStart).toBe(3);
  type('ADAM');
  fireEvent.keyDown(input(), { key: 'z', metaKey: true });
  expect(page.text()).toBe('@ADA');
  fireEvent.keyDown(input(), { key: 'z', ctrlKey: true });
  expect(page.text()).toBe('Ada');
  fireEvent.keyDown(input(), { key: 'z', metaKey: true, shiftKey: true });
  expect(page.text()).toBe('@ADA');
  fireEvent.keyDown(input(), { key: 'Tab', shiftKey: true });
  expect(page.text()).toBe('!ADA');
});

it('navigates line boundaries and joins only the adjacent newline', () => {
  const page = open('One.\nTwo.\nThree.');
  act(() => page.ref.current?.focusOffset(0));
  caret(4);
  fireEvent.keyDown(input(), { key: 'ArrowDown' });
  expect(input()).toHaveValue('Two.');
  expect(input().selectionStart).toBe(0);
  fireEvent.keyDown(input(), { key: 'Backspace' });
  expect(page.text()).toBe('One.Two.\nThree.');
  expect(input().selectionStart).toBe(4);
  caret(8);
  fireEvent.keyDown(input(), { key: 'Delete' });
  expect(page.text()).toBe('One.Two.Three.');
  expect(input().selectionStart).toBe(8);
});

it('accepts only existing draft suggestions explicitly and dismisses Escape without propagation', () => {
  const page = open('@ADA\nHello.\n\n@AD');
  const outerKey = vi.fn();
  document.addEventListener('keydown', outerKey);
  act(() => page.ref.current?.focusOffset(page.text().length));
  expect(screen.getByRole('option', { name: 'ADA' })).toBeVisible();
  fireEvent.keyDown(input(), { key: 'Escape' });
  expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  expect(outerKey).not.toHaveBeenCalled();
  expect(page.text()).toBe('@ADA\nHello.\n\n@AD');
  type('A');
  fireEvent.keyDown(input(), { key: 'Enter' });
  expect(page.text()).toBe('@ADA\nHello.\n\n@ADA');
  expect(input().selectionStart).toBe(3);
  document.removeEventListener('keydown', outerKey);
});

it('preserves multiline paste and composition without firing element or save commands', () => {
  const save = vi.fn();
  const page = open('Original.', { onSave: save });
  act(() => page.ref.current?.focusOffset(0));
  fireEvent.compositionStart(input());
  fireEvent.keyDown(input(), { key: 'Enter', isComposing: true });
  fireEvent.keyDown(input(), { key: 'Tab', isComposing: true });
  expect(page.text()).toBe('Original.');
  type('日本語');
  fireEvent.compositionEnd(input());
  expect(page.text()).toBe('日本語');
  fireEvent.keyDown(input(), { key: 's', metaKey: true });
  expect(save).toHaveBeenCalledOnce();
  type('  First.  \n\n@ADA\nSecond.\n');
  expect(page.text()).toBe('  First.  \n\n@ADA\nSecond.\n');
  expect(input()).toHaveValue('');
  expect(input()).toHaveFocus();
});

it('keeps a long draft editable at the end and delegates shared undo when provided', () => {
  const onUndo = vi.fn(), onRedo = vi.fn();
  const source = Array.from({ length: 500 }, (_, index) => `Action ${index}.`).join('\n\n');
  const page = open(source, { onUndo, onRedo });
  act(() => page.ref.current?.focusOffset(source.length));
  type('Action 499. Continued.');
  expect(page.text()).toBe(source + ' Continued.');
  expect(input()).toHaveFocus();
  fireEvent.keyDown(input(), { key: 'z', metaKey: true });
  fireEvent.keyDown(input(), { key: 'z', metaKey: true, shiftKey: true });
  expect(onUndo).toHaveBeenCalledOnce();
  expect(onRedo).toHaveBeenCalledOnce();
});

it('restores a same-line selection without emitting a repeated selection callback', () => {
  const onSelectionChange = vi.fn();
  const page = open('First line.\n\nA second action.', { onSelectionChange });
  const selection = { start: 15, end: 21, kind: 'action' as const };
  act(() => page.ref.current?.focusSelection(selection));
  expect(input()).toHaveValue('A second action.');
  expect(input().selectionStart).toBe(2);
  expect(input().selectionEnd).toBe(8);
  expect(page.ref.current?.getSelection()).toEqual(selection);
  const calls = onSelectionChange.mock.calls.length;
  act(() => page.ref.current?.focusSelection(selection));
  expect(onSelectionChange).toHaveBeenCalledTimes(calls);
  expect(input()).toHaveFocus();
  expect(page.changed).not.toHaveBeenCalled();
});

it('restores the pending type of a blank line for the next element command', () => {
  const source = '@ADA\n';
  const page = open(source);
  act(() => page.ref.current?.focusSelection({ start: source.length, end: source.length, kind: 'dialogue' }));
  expect(page.ref.current?.getSelection().kind).toBe('dialogue');
  expect(input().closest('[data-element]')).toHaveAttribute('data-element', 'dialogue');
  fireEvent.keyDown(input(), { key: 'Tab' });
  expect(page.text()).toBe('@ADA\n()');
  expect(input().selectionStart).toBe(1);
  expect(page.ref.current?.getSelection().kind).toBe('parenthetical');
});

it.each([
  ['@ADA', 'ADA', 'ADAM', '@ADAM'],
  ['!An action.', 'An action.', 'Another action.', '!Another action.'],
  ['.THE ROOFTOP', 'THE ROOFTOP', 'THE HALL', '.THE HALL'],
  ['>CUT TO:', 'CUT TO:', 'DISSOLVE TO:', '>DISSOLVE TO:'],
])('hides and preserves the %s marker during an ordinary body edit', (source, visible, typed, result) => {
  const page = open(source);
  act(() => page.ref.current?.focusOffset(source.length));
  expect(input()).toHaveValue(visible);
  expect(input().selectionStart).toBe(visible.length);
  type(typed);
  expect(input()).toHaveValue(typed);
  expect(page.text()).toBe(result);
  expect(page.ref.current?.getSelection().start).toBe(result.length);
  expect(input().selectionStart).toBe(typed.length);
});

it('restores source selections through a hidden marker and retains literal leading spaces', () => {
  const page = open('Before.\n\n  !A second action.');
  const selection = { start: 14, end: 20, kind: 'action' as const };
  act(() => page.ref.current?.focusSelection(selection));
  expect(input()).toHaveValue('  A second action.');
  expect(input().selectionStart).toBe(4);
  expect(input().selectionEnd).toBe(10);
  expect(page.ref.current?.getSelection()).toEqual(selection);
  type('  A revised action.');
  expect(page.text()).toBe('Before.\n\n  !A revised action.');
  expect(input()).toHaveValue('  A revised action.');
});

it('preserves a hidden marker during IME and only on the first line of a multiline paste', () => {
  const page = open('  !Original.');
  act(() => page.ref.current?.focusOffset(page.text().length));
  const restoreCaret = vi.spyOn(input(), 'setSelectionRange');
  fireEvent.compositionStart(input());
  type('  日本語');
  expect(restoreCaret).not.toHaveBeenCalled();
  fireEvent.compositionEnd(input());
  expect(input()).toHaveValue('  日本語');
  expect(page.text()).toBe('  !日本語');
  expect(page.ref.current?.getSelection().start).toBe(page.text().length);
  restoreCaret.mockRestore();
  type('  First.\n  Second.\nThird.');
  expect(page.text()).toBe('  !First.\n  Second.\nThird.');
  expect(input()).toHaveValue('Third.');
  expect(input().selectionStart).toBe('Third.'.length);
  expect(input()).toHaveFocus();
});

it.each(['Backspace', 'Delete'])('joins paragraphs with %s without exposing a merged-away marker', key => {
  const page = open('!One.\n  @ADA\nHello.');
  act(() => page.ref.current?.focusOffset(key === 'Backspace' ? '!One.\n'.length : '!One.'.length));
  fireEvent.keyDown(input(), { key });
  expect(page.text()).toBe('!One.  ADA\nHello.');
  expect(input()).toHaveValue('One.  ADA');
  expect(input().selectionStart).toBe('One.'.length);
  expect(page.ref.current?.getSelection().start).toBe('!One.'.length);
});
