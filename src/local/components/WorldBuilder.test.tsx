import { useState, type ComponentProps } from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseScreenplay } from '@/lib/fountain/spec';
import { WorldBuilder } from './WorldBuilder';
import { newDevelopmentCharacter } from '../development';
import { createWorld, newWorldElement, newWorldLink, type WorldData } from '../world';
import { worldContext } from '../world-context';
import { searchFilmcraft } from '../filmcraft';

type Props = ComponentProps<typeof WorldBuilder>;
const emptyContext = worldContext(parseScreenplay(''));
const write = (name: string, value: string) => fireEvent.change(screen.getByRole('textbox', { name }), { target: { value } });
const choose = (name: string, value: string) => fireEvent.change(screen.getByRole('combobox', { name }), { target: { value } });
const click = (name: string | RegExp) => fireEvent.click(screen.getByRole('button', { name }));
const openElement = (name: string) => fireEvent.click(within(screen.getByRole('complementary', { name: 'World elements' })).getByRole('button', { name: new RegExp(name) }));

function setup(initial = createWorld(), options: Partial<Props> = {}) {
  let latest = initial;
  const onChange = vi.fn();
  function Harness({ context = emptyContext, focusElement }: { context?: Props['context']; focusElement?: Props['focusElement'] }) {
    const [world, setWorld] = useState(initial);
    const [notes, setNotes] = useState('');
    latest = world;
    return <WorldBuilder world={world} notes={notes} onNotes={setNotes} characters={[]} {...options} context={context} focusElement={focusElement} onChange={next => { onChange(next); setWorld(next); }} />;
  }
  let props = { context: options.context, focusElement: options.focusElement };
  const view = render(<Harness {...props} />);
  const update = (next: Partial<typeof props>) => { props = { ...props, ...next }; view.rerender(<Harness {...props} />); };
  return { ...view, onChange, current: () => latest, context: (context: Props['context']) => update({ context }), focus: (focusElement: Props['focusElement']) => update({ focusElement }) };
}

afterEach(cleanup);

describe('WorldBuilder authoring', () => {
  it.each(['location', 'character', 'thematic_note'] as const)('opens installed catalog entries from %s contextual reference actions', type => {
    const element = { ...newWorldElement(type), name: 'Owner element', description: 'Keep the authored text.' };
    const initial: WorldData = { schemaVersion: 1, elements: [element], links: [] };
    const onBrowseFilmcraft = vi.fn<NonNullable<Props['onBrowseFilmcraft']>>();
    const view = setup(initial, { onBrowseFilmcraft });
    openElement('Owner element'); click('Explore visual choices in Film language');
    expect(searchFilmcraft(onBrowseFilmcraft.mock.lastCall![0])[0]?.id).toBe('image:mise-en-scene');
    click('Story & continuity');
    click(type === 'thematic_note' ? 'Explore intention in Film language' : 'Explore story theory');
    expect(searchFilmcraft(onBrowseFilmcraft.mock.lastCall![0]).map(entry => entry.id)).toContain('story:character');
    expect(onBrowseFilmcraft).toHaveBeenCalledTimes(2);
    expect(view.current()).toEqual(initial); expect(view.onChange).not.toHaveBeenCalled();
  });

  it('creates blank elements, edits every authored field, and retains them when reopening', () => {
    const view = setup();
    expect(view.onChange).not.toHaveBeenCalled();
    click('Add');
    expect(view.current().elements[0]).toMatchObject({ type: 'location', name: '', description: '', sensoryDetails: '', storyFunction: '', continuity: '', status: 'idea' });
    write('Element name', '  Flooded archive  ');
    write('Description', 'Owner description.\nNo invented history.');
    write('On screen & in sound', 'Blue light. A pipe rattles.');
    choose('Story status', 'established');
    choose('Element type', 'world_rule');
    click('Story & continuity');
    write('Story function', 'Limits the search.');
    write('Continuity & open questions', 'The lower floor stays flooded.');
    const authored = structuredClone(view.current().elements[0]);
    click('Add');
    openElement('Flooded archive');
    expect(screen.getByRole('textbox', { name: 'Element name' })).toHaveValue('  Flooded archive  ');
    expect(screen.getByRole('textbox', { name: 'Description' })).toHaveValue('Owner description.\nNo invented history.');
    expect(screen.getByRole('textbox', { name: 'On screen & in sound' })).toHaveValue('Blue light. A pipe rattles.');
    expect(screen.getByRole('combobox', { name: 'Story status' })).toHaveValue('established');
    click('Story & continuity');
    expect(screen.getByRole('textbox', { name: 'Story function' })).toHaveValue('Limits the search.');
    expect(screen.getByRole('textbox', { name: 'Continuity & open questions' })).toHaveValue('The lower floor stays flooded.');
    expect(view.current().elements[0]).toEqual(authored);
    click('Remove world element');
    expect(view.current().elements).toHaveLength(1);
    click('Undo removal');
    expect(view.current().elements[0]).toEqual(authored);
  });

  it('adds an internal connection explicitly, prevents duplicates, and removes only that connection', () => {
    const archive = { ...newWorldElement('location'), name: 'Archive' };
    const key = { ...newWorldElement('prop'), name: 'Brass key', order: 1 };
    const view = setup({ schemaVersion: 1, elements: [archive, key], links: [] });
    openElement('Archive'); click(/Connections/);
    expect(screen.queryByRole('option', { name: 'Archive' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add connection' })).toBeDisabled();
    choose('Connection target', key.id);
    write('Connection notes', 'Opens the north door.'); click('Add connection');
    expect(view.current().links).toHaveLength(1);
    expect(view.current().links[0]).toMatchObject({ elementId: archive.id, targetType: 'element', targetRef: key.id, notes: 'Opens the north door.' });
    choose('Connection target', key.id); click('Add connection');
    expect(screen.getByRole('status')).toHaveTextContent('This connection already exists.');
    expect(view.current().links).toHaveLength(1);
    click('Open element'); click(/Connections/);
    expect(screen.getByText(/Linked from/)).toBeInTheDocument();
    click('Archive'); click(/Connections/); click('Remove connection to Brass key');
    expect(view.current().links).toEqual([]);
    expect(view.current().elements).toEqual([archive, key]);
  });

  it.each([{ source: true, target: false }, { source: false, target: true }, { source: true, target: true }])('navigates both directions and rejects duplicate UUID references with uppercase $source/$target', ({ source, target }) => {
    const archive = { ...newWorldElement('location'), id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', name: 'Archive' };
    const key = { ...newWorldElement('prop'), id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', name: 'Brass key' };
    const link = { ...newWorldLink(source ? archive.id.toUpperCase() : archive.id, 'element', target ? key.id.toUpperCase() : key.id, key.name), notes: '  Keep this note.\nExactly.  ' };
    const initial: WorldData = { schemaVersion: 1, elements: [archive, key], links: [link] };
    const view = setup(initial);
    openElement('Archive'); click(/Connections/);
    expect(screen.getByRole('group', { name: 'Connection to Brass key' })).toHaveTextContent('Keep this note.');
    expect(screen.queryByRole('option', { name: 'Archive' })).not.toBeInTheDocument();
    choose('Connection target', key.id); click('Add connection');
    expect(screen.getByRole('status')).toHaveTextContent('This connection already exists.');
    click('Open element');
    expect(screen.getByRole('textbox', { name: 'Element name' })).toHaveValue('Brass key');
    click(/Connections/); click('Archive');
    expect(screen.getByRole('textbox', { name: 'Element name' })).toHaveValue('Archive');
    expect(within(screen.getByRole('complementary', { name: 'World elements' })).getByRole('button', { name: /Archive/ })).toHaveAttribute('aria-pressed', 'true');
    expect(view.current()).toEqual(initial); expect(view.onChange).not.toHaveBeenCalled();
    write('Description', 'Edited after the inbound jump.');
    expect(view.current().elements[0]).toEqual({ ...archive, description: 'Edited after the inbound jump.' });
    expect(view.current().links).toEqual([link]);
    click(/Connections/); click('Remove connection to Brass key');
    expect(view.current().links).toEqual([]);
  });

  it('deletes incoming and outgoing links with an element and restores the exact world on undo', () => {
    const a = { ...newWorldElement('location'), name: 'Archive' };
    const b = { ...newWorldElement('prop'), name: 'Brass key', order: 1 };
    const c = { ...newWorldElement('character'), name: 'Mira', order: 2 };
    const outgoing = newWorldLink(a.id, 'element', b.id, b.name);
    const incoming = newWorldLink(c.id, 'element', a.id, a.name);
    const scene = newWorldLink(a.id, 'scene', 'number:7', 'INT. ARCHIVE - DAY');
    const unrelated = { ...newWorldLink(b.id, 'element', c.id, c.name), notes: 'Owner note stays intact.' };
    const initial: WorldData = { schemaVersion: 1, elements: [a, b, c], links: [outgoing, incoming, scene, unrelated] };
    const before = structuredClone(initial);
    const view = setup(initial);
    openElement('Archive'); click('Remove world element');
    expect(view.current()).toEqual({ schemaVersion: 1, elements: [b, c], links: [unrelated] });
    click('Undo removal');
    expect(view.current()).toEqual(before);
    expect(initial).toEqual(before);
  });

  it('does not offer an obsolete removal undo after a subsequent world edit', () => {
    const a = { ...newWorldElement('location'), name: 'Archive' };
    const b = { ...newWorldElement('prop'), name: 'Brass key', order: 1 };
    const view = setup({ schemaVersion: 1, elements: [a, b], links: [] });
    openElement('Archive'); click('Remove world element');
    openElement('Brass key'); write('Description', 'Newer owner text.');
    expect(screen.queryByRole('button', { name: 'Undo removal' })).not.toBeInTheDocument();
    expect(view.current().elements[0].description).toBe('Newer owner text.');
  });

  it('reviews a stale scene in place, permits cancel and preserves its UUID, source and exact notes', () => {
    const element = { ...newWorldElement('location'), name: 'Archive', description: 'An authored place.', status: 'established' as const };
    const link = { ...newWorldLink(element.id.toUpperCase(), 'scene', 'number:7', 'INT. ARCHIVE - DAY'), notes: '  Owner connection note.\nKeep exactly. 🎬  ' };
    const other = { ...newWorldElement('prop'), name: 'Key', description: 'An authored prop.' };
    const unrelated = newWorldLink(other.id, 'element', element.id, element.name);
    const initial: WorldData = { schemaVersion: 1, elements: [element, other], links: [link, unrelated] };
    const source = 'INT. ARCHIVE - DAY #7#\n\nThe door opens.';
    const onJump = vi.fn();
    const view = setup(initial, { context: worldContext(parseScreenplay(source)), onJump });
    openElement('Archive'); click(/Connections/); click('Go to scene');
    expect(onJump).toHaveBeenLastCalledWith(0);
    view.context(worldContext(parseScreenplay('EXT. QUARRY - NIGHT #7#\n\nStone falls.')));
    expect(screen.getByText(/Source changed or is missing/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Go to scene' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Review (1)' })).toBeInTheDocument();
    expect(view.current()).toEqual(initial);
    expect(view.onChange).not.toHaveBeenCalled();
    click('Relink connection');
    expect(screen.getByRole('button', { name: 'Apply relink' })).toBeDisabled();
    choose('Replacement target', 'number:7'); click('Cancel relink');
    expect(view.current()).toEqual(initial); expect(view.onChange).not.toHaveBeenCalled();
    expect(screen.queryByRole('combobox', { name: 'Replacement target' })).not.toBeInTheDocument();
    click('Relink connection'); choose('Replacement target', 'number:7'); click('Apply relink');
    expect(view.current()).toEqual({ ...initial, links: [{ ...link, targetLabel: 'EXT. QUARRY - NIGHT' }, unrelated] });
    expect(view.onChange).toHaveBeenCalledTimes(1);
    expect(initial.links).toEqual([link, unrelated]);
    expect(screen.queryByText(/Source changed or is missing/)).not.toBeInTheDocument();
    click('Go to scene'); expect(onJump).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['removed target', ''],
    ['same reference with a new label', 'EXT. QUARRY - NIGHT #7#\n\nStone falls.'],
    ['ambiguous target', 'INT. LAB - DAY #7#\n\nFirst.\n\nINT. LAB - DAY #7#\n\nSecond.'],
    ['unchanged reference and label in a new context', 'INT. LAB - DAY #7#\n\nNew action.'],
  ])('requires a fresh explicit choice when repair context changes: %s', (_label, changed) => {
    const element = { ...newWorldElement('location'), name: 'Archive' };
    const link = { ...newWorldLink(element.id, 'scene', 'number:1', 'INT. OLD ARCHIVE - DAY'), notes: 'Keep during review.' };
    const view = setup({ schemaVersion: 1, elements: [element], links: [link] }, { context: worldContext(parseScreenplay('INT. LAB - DAY #7#\n\nAction.')) });
    openElement('Archive'); click(/Connections/); click('Relink connection'); choose('Replacement target', 'number:7');
    view.context(worldContext(parseScreenplay(changed)));
    expect(screen.getByRole('alert')).toHaveTextContent('The screenplay changed.');
    expect(screen.getByRole('combobox', { name: 'Replacement target' })).toHaveValue('');
    expect(screen.getByRole('button', { name: 'Apply relink' })).toBeDisabled();
    click('Apply relink'); expect(view.onChange).not.toHaveBeenCalled(); expect(view.current().links).toEqual([link]);
    view.context(worldContext(parseScreenplay('EXT. PIER - NIGHT #9#\n\nRain.')));
    choose('Replacement target', 'number:9'); click('Apply relink');
    expect(view.current().links).toEqual([{ ...link, targetRef: 'number:9', targetLabel: 'EXT. PIER - NIGHT' }]);
  });

  it('rejects a duplicate cue repair but keeps case-distinct cues separate and all notes intact', () => {
    const element = { ...newWorldElement('character'), name: 'Character notes' };
    const stale = { ...newWorldLink(element.id, 'character', 'OLD NAME', 'OLD NAME'), notes: 'Original cue note.' };
    const existing = { ...newWorldLink(element.id.toUpperCase(), 'character', 'MIRA', 'MIRA'), notes: 'Existing cue note.' };
    const view = setup({ schemaVersion: 1, elements: [element], links: [stale, existing] }, { context: worldContext(parseScreenplay('INT. LAB - DAY\n\nMIRA\nLoud.\n\n@Mira\nSoft.')) });
    openElement('Character notes'); click(/Connections/); click('Relink connection'); choose('Replacement target', 'MIRA'); click('Apply relink');
    expect(screen.getByRole('status')).toHaveTextContent('This connection already exists.');
    expect(view.current().links).toEqual([stale, existing]); expect(view.onChange).not.toHaveBeenCalled();
    choose('Replacement target', 'Mira'); click('Apply relink');
    expect(view.current().links).toEqual([{ ...stale, targetRef: 'Mira', targetLabel: 'Mira' }, existing]);
  });

  it('jumps to the first exact character cue, not a prose mention, another case, or a scene heading', () => {
    const element = { ...newWorldElement('character'), name: 'Mira notes' };
    const link = newWorldLink(element.id, 'character', 'MIRA', 'MIRA');
    const source = 'INT. LAB - DAY\n\n!MIRA is missing.\n\n@Mira\nSomeone else.\n\nMIRA (V.O.)\nHere.\n\nMIRA\nAgain.';
    const onJump = vi.fn();
    const view = setup({ schemaVersion: 1, elements: [element], links: [link] }, { context: worldContext(parseScreenplay(source)), onJump });
    openElement('Mira notes'); click(/Connections/);
    expect(screen.queryByRole('button', { name: 'Go to scene' })).not.toBeInTheDocument();
    click('Go to character'); expect(onJump).toHaveBeenLastCalledWith(source.indexOf('MIRA (V.O.)'));
    const moved = `!More action.\n\n${source}`;
    view.context(worldContext(parseScreenplay(moved)));
    click('Go to character'); expect(onJump).toHaveBeenLastCalledWith(moved.indexOf('MIRA (V.O.)'));
    view.context(worldContext(parseScreenplay('INT. LAB - DAY\n\n@Mira\nOnly the other cue.')));
    expect(screen.queryByRole('button', { name: 'Go to character' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Relink connection' })).toBeInTheDocument();
    expect(view.current().links).toEqual([link]); expect(view.onChange).not.toHaveBeenCalled();
  });

  it('focuses a case-insensitive element request once per id/nonce and preserves edits on later renders', () => {
    const archive = { ...newWorldElement('location'), name: 'Archive', description: 'Authored location.' };
    const key = { ...newWorldElement('prop'), name: 'Key', description: 'Authored prop.' };
    const view = setup({ schemaVersion: 1, elements: [archive, key], links: [] });
    openElement('Archive'); write('Description', 'Unsaved location edit.'); click('Story & continuity');
    write('Continuity & open questions', 'Keep this question.');
    click(/^Review/); click(/^Props/); write('Search world', 'No match');
    const before = structuredClone(view.current()); view.onChange.mockClear();
    view.focus({ id: archive.id.toUpperCase(), nonce: 1 });
    expect(screen.getByRole('textbox', { name: 'Element name' })).toHaveValue('Archive');
    expect(screen.getByRole('textbox', { name: 'Description' })).toHaveValue('Unsaved location edit.');
    expect(screen.getByRole('textbox', { name: 'Search world' })).toHaveValue('');
    expect(screen.getByRole('button', { name: /^Review/ })).toHaveAttribute('aria-pressed', 'false');
    expect(within(screen.getByRole('navigation', { name: 'World categories' })).getByRole('button', { name: /^All/ })).toHaveAttribute('aria-pressed', 'true');
    expect(view.current()).toEqual(before); expect(view.onChange).not.toHaveBeenCalled();
    openElement('Key'); write('Description', 'Unsaved prop edit.');
    view.focus({ id: archive.id.toUpperCase(), nonce: 1 });
    expect(screen.getByRole('textbox', { name: 'Element name' })).toHaveValue('Key');
    expect(screen.getByRole('textbox', { name: 'Description' })).toHaveValue('Unsaved prop edit.');
    view.focus({ id: archive.id.toUpperCase(), nonce: 2 });
    expect(screen.getByRole('textbox', { name: 'Element name' })).toHaveValue('Archive');
    view.focus({ id: key.id.toUpperCase(), nonce: 2 });
    expect(screen.getByRole('textbox', { name: 'Element name' })).toHaveValue('Key');
    expect(view.current().elements).toEqual([{ ...archive, description: 'Unsaved location edit.', continuity: 'Keep this question.' }, { ...key, description: 'Unsaved prop edit.' }]);
    expect(view.onChange).toHaveBeenCalledTimes(1);
  });

  it('explains why ambiguous scenes cannot be selected as connection targets', () => {
    const element = { ...newWorldElement('location'), name: 'Archive' };
    setup({ schemaVersion: 1, elements: [element], links: [] }, { context: worldContext(parseScreenplay('INT. LAB - DAY\n\nFirst visit.\n\nINT. LAB - DAY\n\nSecond visit.')) });
    openElement('Archive'); click(/Connections/); choose('Connection type', 'scene');
    expect(screen.getByText(/2 scene\(s\) need unique scene numbers or headings/)).toBeInTheDocument();
    expect(within(screen.getByRole('combobox', { name: 'Connection target' })).getAllByRole('option')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Add connection' })).toBeDisabled();
  });

  it('brings in screenplay names only on explicit addition and leaves story text blank', () => {
    const character = { ...newDevelopmentCharacter(), name: 'Sol', role: 'Guard', description: 'Owner description.', arc: 'Owner arc.' };
    const view = setup(createWorld(), { context: worldContext(parseScreenplay('INT. LAB - DAY\n\nMIRA\nDo not turn this dialogue into a description.')), characters: [character] });
    expect(view.current()).toEqual(createWorld());
    expect(view.onChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('Bring in names from your screenplay & development'));
    click('MIRA Character cue');
    expect(view.current().elements[0]).toMatchObject({ type: 'character', name: 'MIRA', description: '', sensoryDetails: '', continuity: '', storyFunction: '' });
    expect(screen.getByRole('button', { name: 'MIRA Character cue' })).toBeDisabled();
    click('LAB Scene location');
    expect(view.current().elements[1]).toMatchObject({ type: 'location', name: 'LAB', description: '', sensoryDetails: '', continuity: '', storyFunction: '' });
    click('Sol Development character');
    expect(view.current().elements[2]).toMatchObject({ name: 'Sol', description: 'Guard\n\nOwner description.\n\nArc: Owner arc.', storyFunction: '', continuity: '' });
    expect(character.description).toBe('Owner description.');
  });

  it('moves timeline notes within their category and preserves their text and connections', () => {
    const first = { ...newWorldElement('timeline_note'), name: 'Before the flood', description: 'First authored event.', order: 10 };
    const location = { ...newWorldElement('location'), name: 'Archive', order: 20 };
    const second = { ...newWorldElement('timeline_note'), name: 'After the flood', description: 'Second authored event.', order: 30 };
    const link = newWorldLink(second.id, 'element', location.id, location.name);
    const view = setup({ schemaVersion: 1, elements: [first, location, second], links: [link] });
    openElement('After the flood');
    expect(screen.getByRole('button', { name: 'Move element later' })).toBeDisabled();
    click('Move element earlier');
    expect(view.current().elements.map(item => item.id)).toEqual([second.id, location.id, first.id]);
    expect(view.current().elements.map(item => item.order)).toEqual([0, 1, 2]);
    expect(screen.getByRole('button', { name: 'Move element earlier' })).toBeDisabled();
    expect(screen.getByRole('textbox', { name: 'Description' })).toHaveValue(second.description);
    expect(view.current().links).toEqual([link]);
    click('Move element later');
    expect(view.current().elements.map(({ order: _order, ...item }) => item)).toEqual([first, location, second].map(({ order: _order, ...item }) => item));
  });
});
