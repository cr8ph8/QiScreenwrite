import { useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ScreenplayWritingSurface } from './ScreenplayWritingSurface';
afterEach(cleanup);
function setup(text = '', disabled = false) {
 const change = vi.fn(), save = vi.fn();
 function Harness() { const [value, setValue] = useState(text); return <ScreenplayWritingSurface value={value} onChange={next => { change(next); setValue(next); }} onSave={save} disabled={disabled}/>; }
 return { ...render(<Harness/>), change, save };
}
const source = () => { fireEvent.click(screen.getByRole('button', { name: 'Fountain' })); return screen.getByRole('textbox', { name: 'Fountain screenplay' }) as HTMLTextAreaElement; };
it('opens a page without changing imported text; keeps the source exact across view switches', () => {
 const text = 'Title: Exact\n\nINT. ROOM - DAY\n\n  Keep punctuation — and spaces.  \n';
 const { change } = setup(text);
 expect(screen.getByRole('button', { name: 'Page' })).toHaveAttribute('aria-pressed','true');
 expect(source()).toHaveValue(text); fireEvent.click(screen.getByRole('button', { name: 'Page' })); expect(change).not.toHaveBeenCalled();
});
it('shares undo and redo across page and Fountain edits', () => {
 setup('A sentence.');
 const input = source(); fireEvent.change(input, { target: { value: 'A changed sentence.' } });
 fireEvent.click(screen.getByRole('button', { name: 'Page' }));
 fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
 expect(source()).toHaveValue('A sentence.');
 fireEvent.keyDown(source(), { key:'z', metaKey:true, shiftKey:true }); expect(source()).toHaveValue('A changed sentence.');
 fireEvent.click(screen.getByRole('button', { name: 'Page' }));
 const line=screen.getByRole('textbox',{name:'Screenplay page line'}); fireEvent.change(line,{target:{value:'A page edit.'}});
 expect(source()).toHaveValue('A page edit.'); fireEvent.click(screen.getByRole('button',{name:'Undo'})); expect(source()).toHaveValue('A changed sentence.');
});
it('uses element selection and contextual Enter; saves only on explicit command', () => {
 const { save } = setup('Mara'); const input = source(); input.focus(); input.setSelectionRange(4,4); fireEvent.select(input);
 fireEvent.change(screen.getByLabelText('Screenplay element'), { target:{value:'character'} }); expect(input).toHaveValue('@MARA');
 fireEvent.keyDown(input,{key:'Enter'}); expect(input).toHaveValue('@MARA\n'); expect(save).not.toHaveBeenCalled();
 fireEvent.keyDown(input,{key:'s',metaKey:true}); expect(save).toHaveBeenCalledTimes(1);
});
it('keeps multiline selections intact when a type cannot be applied', () => {
 setup('One action.\n\nAnother.'); const input=source(); input.focus(); input.setSelectionRange(0,input.value.length); fireEvent.select(input);
 fireEvent.change(screen.getByLabelText('Screenplay element'), {target:{value:'character'}}); expect(input).toHaveValue('One action.\n\nAnother.'); expect(screen.getByRole('status')).toHaveTextContent('Choose one paragraph');
});
it('blocks writing, undo and save shortcuts while busy, but allows view inspection', () => {
 const { change, save }=setup('Keep.',true); const input=source(); expect(input).toBeDisabled(); fireEvent.keyDown(input,{key:'s',metaKey:true}); expect(save).not.toHaveBeenCalled(); expect(change).not.toHaveBeenCalled();
 expect(screen.getByLabelText('Screenplay element')).toBeDisabled(); expect(screen.getByRole('button',{name:'Undo'})).toBeDisabled();
});

it('does not turn a blank view switch into an action-format command', () => {
 setup(); source(); fireEvent.click(screen.getByRole('button',{name:'Page'}));
 fireEvent.change(screen.getByRole('textbox',{name:'Screenplay page line'}),{target:{value:'int. room - day'}});
 expect(source()).toHaveValue('int. room - day');
});
it('preserves a same-line selection across writing views', () => {
 setup('Mara waits.'); const input=source(); input.focus(); input.setSelectionRange(5,10); fireEvent.select(input);
 fireEvent.click(screen.getByRole('button',{name:'Page'})); const restored=source(); expect(restored.selectionStart).toBe(5); expect(restored.selectionEnd).toBe(10);
});
it('retains the next scene-heading type after a transition but leaves composition text intact', () => {
 setup('CUT TO:'); const input=source(); input.focus(); input.setSelectionRange(7,7); fireEvent.select(input); fireEvent.keyDown(input,{key:'Enter'});
 expect(screen.getByLabelText('Screenplay element')).toHaveValue('scene_heading');
 fireEvent.change(input,{target:{value:'CUT TO:\n\nDream',selectionStart:14,selectionEnd:14}}); expect(input).toHaveValue('CUT TO:\n\n.Dream');
 fireEvent.keyDown(input,{key:'z',metaKey:true}); fireEvent.compositionStart(input);
 const before=input.value; fireEvent.keyDown(input,{key:'Enter'}); expect(input).toHaveValue(before);
 fireEvent.change(input,{target:{value:'CUT TO:\n\n夢'}}); expect(input).toHaveValue('CUT TO:\n\n夢'); fireEvent.compositionEnd(input);
});

it('edits textarea text without normalizing untouched imported bytes', () => {
 const original = '\uFEFFTitle: Exact\r\n\r\nINT. ROOM - DAY\n\nAction.\r\nFinal.\r';
 const { change } = setup(original);
 const input = source();
 fireEvent.change(input, { target: { value: input.value.replace('Action.', 'Changed action.') } });
 expect(change).toHaveBeenLastCalledWith(original.replace('Action.', 'Changed action.'));
 fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
 expect(change).toHaveBeenLastCalledWith(original);
});

it('consumes the source save shortcut instead of bubbling into a second save', () => {
 const outer = vi.fn(); window.addEventListener('keydown', outer);
 const { save } = setup('Action.');
 fireEvent.keyDown(source(), { key: 's', metaKey: true });
 expect(save).toHaveBeenCalledTimes(1); expect(outer).not.toHaveBeenCalled();
 window.removeEventListener('keydown', outer);
});

it('preserves CRLF bytes through page editing and switching views', () => {
 const original = 'INT. ROOM - DAY\r\n\r\nAction.\r\n\r\nFinal.';
 const { change } = setup(original);
 fireEvent.click(screen.getByRole('button', { name: 'Action, line 3: Action.' }));
 fireEvent.change(screen.getByRole('textbox', { name: 'Screenplay page line' }), { target: { value: 'Changed.' } });
 expect(change).toHaveBeenLastCalledWith(original.replace('Action.', 'Changed.'));
 const input = source();
 expect(input.value).toContain('Changed.');
 fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
 expect(change).toHaveBeenLastCalledWith(original);
});

it('uses imported line endings for contextual Enter in source view', () => {
 const { change } = setup('INT. ROOM - DAY\r\n\r\nAction.');
 const input = source(); input.focus(); input.setSelectionRange(input.value.length, input.value.length); fireEvent.select(input);
 fireEvent.keyDown(input, { key: 'Enter' });
 expect(change).toHaveBeenLastCalledWith('INT. ROOM - DAY\r\n\r\nAction.\r\n\r\n');
});
