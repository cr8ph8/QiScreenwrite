import '@testing-library/jest-dom/vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { localApi } from '../api';
import { DevelopmentPanel } from '../components/DevelopmentPanel';
import {
  DEVELOPMENT_KIND, DEVELOPMENT_LIMITS, cloneDevelopment, createDevelopment, developmentError,
  developmentId, developmentMarkdown, developmentRecoveryKey, developmentSave, isDevelopmentRecord,
  newDevelopmentBeat, newDevelopmentCharacter, newDevelopmentResearchNote, readDevelopmentRecovery,
  type DevelopmentData, type DevelopmentRecord, type DevelopmentSave,
} from '../development';
import { buildDraftData, canonicalJson, downloadText } from '../model';
import { initialize, WorkspaceStore } from '../../../local/server/storage.mjs';
import { validateRecord } from '../../../local/server/contracts.mjs';
import { validateDevelopment, DEVELOPMENT_LIMITS as serverLimits } from '../../../local/server/development.mjs';

vi.mock('../model', async importOriginal => ({ ...await importOriginal<typeof import('../model')>(), downloadText: vi.fn() }));

const draftId = 'screenplay-draft:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const otherDraftId = 'screenplay-draft:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
let directory: string;
let store: InstanceType<typeof WorkspaceStore>;
let projectId: string;
let fetchMock: ReturnType<typeof vi.fn>;

function put(input: DevelopmentSave): DevelopmentRecord {
  const { id, ...body } = input;
  return store.save(id, body);
}
function record(data: DevelopmentData, expectedVersion: number | null = null) { return put(developmentSave(data, expectedVersion)); }
function seedDraft(id = draftId) {
  store.save(id, { kind: 'screenplay-draft', expectedVersion: null, requestId: crypto.randomUUID(), data: buildDraftData(projectId, { title: 'Test draft', body: '' }) });
}
const response = (value: unknown, status = 200) => ({ ok: status < 400, status, json: async () => value }) as Response;
function localFetch(url: string, init?: RequestInit): Response {
  expect(url).toMatch(/^\/api\/records\//);
  const match = /^\/api\/records\/([^/]+)(\/history)?$/.exec(url)!;
  const id = decodeURIComponent(match[1]);
  try {
    if (match[2]) return response(store.history(id));
    expect(init?.method).toBe('PUT');
    expect(init?.credentials).toBe('same-origin');
    return response(store.save(id, JSON.parse(String(init?.body))));
  } catch (error) {
    return response({ error: error.code, detail: error.message }, error.status ?? 400);
  }
}
async function setup(initialRecord?: DevelopmentRecord | null, onSaved = vi.fn()) {
  const props = { projectId, draftId, initialRecord, onSaved };
  const view = render(<DevelopmentPanel {...props} />);
  await act(async () => {});
  return { ...view, props, onSaved };
}
const write = (name: string, value: string) => fireEvent.change(screen.getByRole('textbox', { name }), { target: { value } });
function tab(name: string) { fireEvent.mouseDown(screen.getByRole('tab', { name }), { button: 0, ctrlKey: false }); }
async function save() {
  fireEvent.click(screen.getByRole('button', { name: 'Save development' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Save development' })).toBeDisabled());
}
function defer<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

beforeEach(() => {
  window.localStorage.clear();
  vi.clearAllMocks();
  vi.spyOn(localApi.developmentRecovery, 'get').mockResolvedValue(null);
  vi.spyOn(localApi.developmentRecovery, 'put').mockImplementation(async copy => copy);
  vi.spyOn(localApi.developmentRecovery, 'remove').mockResolvedValue({ deleted: true });
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'writer-development-test-'));
  initialize(directory);
  // Only this disposable fixture composes the new validator; production routes
  // and contracts remain untouched until main performs the documented wiring.
  store = new WorkspaceStore(directory, (kind, data, project, context) => kind === DEVELOPMENT_KIND ? validateDevelopment(data, project, context) : validateRecord(kind, data, project, context));
  projectId = store.project().id;
  seedDraft();
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => localFetch(url, init));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(async () => {
  cleanup();
  await act(async () => {});
  store.close();
  fs.rmSync(directory, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('development helpers and server contract', () => {
  it('starts blank, derives one identity per draft, and shares server bounds', () => {
    const data = createDevelopment(projectId, draftId);
    expect(DEVELOPMENT_LIMITS).toEqual(serverLimits);
    expect(developmentId(draftId)).toBe('story-development:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    expect(data).toMatchObject({ concept: '', logline: '', synopsis: '', outline: '', beats: [], characters: [], worldNotes: '', researchNotes: [] });
    expect(developmentError(data, projectId, draftId)).toBeNull();
    expect(validateDevelopment(data, store.project(), { id: developmentId(draftId), store })).toBe(data);
    expect(() => developmentId('screenplay-draft:other')).toThrow(/UUID/);
    expect(() => createDevelopment('../bad', draftId)).toThrow(/project/);
  });

  it('keeps snapshot inputs independent and exports exact authored text', () => {
    const data = createDevelopment(projectId, draftId);
    data.concept = '  Owner words\nwith spacing  ';
    data.beats = [{ ...newDevelopmentBeat(), title: 'Test beat', description: 'A test note.' }];
    data.characters = [{ ...newDevelopmentCharacter(), name: 'Test name', arc: 'Owner arc' }];
    data.researchNotes = [{ ...newDevelopmentResearchNote(), source: 'file:///owner/reference', notes: 'Owner notes' }];
    const snapshot = developmentSave(data, null);
    data.beats[0].title = 'Changed';
    expect(snapshot.data.beats[0].title).toBe('Test beat');
    expect(developmentMarkdown(snapshot.data)).toContain('  Owner words\nwith spacing  ');
    expect(developmentMarkdown(data)).toContain('file:///owner/reference');
    expect(developmentMarkdown(data)).toContain('Owner arc');
  });

  it('appends revisions, replays identical saves, rejects CAS conflicts and preserves immutable history', () => {
    const data = createDevelopment(projectId, draftId);
    const input = developmentSave(data, null);
    const first = put(input);
    expect(put(input)).toMatchObject({ version: 1, replayed: true });
    expect(isDevelopmentRecord(first, projectId, draftId)).toBe(true);
    expect(() => put({ ...input, data: { ...data, concept: 'Changed' } })).toThrow(/REQUEST_ID_CONFLICT/);
    expect(() => record({ ...data, concept: 'Changed' })).toThrow(/VERSION_CONFLICT/);
    const second = record({ ...data, concept: 'Changed' }, first.version);
    expect(second.version).toBe(2);
    expect(store.history(first.id).map(item => item.data.concept)).toEqual(['', 'Changed']);
    expect(store.list(DEVELOPMENT_KIND)).toHaveLength(1);
    expect(() => store.db.prepare('DELETE FROM records WHERE id = ?').run(first.id)).toThrow(/IMMUTABLE_RECORD/);
    expect(() => store.db.prepare('UPDATE records SET data = ? WHERE id = ?').run('{}', first.id)).toThrow(/IMMUTABLE_RECORD/);
    store.close();
    store = new WorkspaceStore(directory);
    expect(store.current(first.id)).toEqual(second);
  });

  it.each([
    ['foreign project', (data: DevelopmentData) => ({ ...data, projectId: 'local-writer:other' })],
    ['foreign draft', (data: DevelopmentData) => ({ ...data, draftId: otherDraftId })],
    ['non-UUID draft', (data: DevelopmentData) => ({ ...data, draftId: 'screenplay-draft:bad' })],
    ['unknown field', (data: DevelopmentData) => ({ ...data, approval: true })],
    ['wrong schema', (data: DevelopmentData) => ({ ...data, schemaVersion: 2 })],
    ['null field', (data: DevelopmentData) => ({ ...data, synopsis: null })],
    ['oversized field', (data: DevelopmentData) => ({ ...data, logline: 'a'.repeat(DEVELOPMENT_LIMITS.logline + 1) })],
    ['NUL', (data: DevelopmentData) => ({ ...data, concept: '\0' })],
    ['lone surrogate', (data: DevelopmentData) => ({ ...data, concept: '\uD800' })],
    ['too many beats', (data: DevelopmentData) => ({ ...data, beats: Array.from({ length: DEVELOPMENT_LIMITS.beats + 1 }, newDevelopmentBeat) })],
    ['duplicate ID', (data: DevelopmentData) => { const beat = newDevelopmentBeat(); return { ...data, beats: [beat, { ...beat, id: beat.id.toUpperCase() }] }; }],
    ['nested foreign field', (data: DevelopmentData) => ({ ...data, beats: [{ ...newDevelopmentBeat(), approved: true }] })],
    ['invalid item identity', (data: DevelopmentData) => ({ ...data, characters: [{ ...newDevelopmentCharacter(), id: '../bad' }] })],
    ['sparse array', (data: DevelopmentData) => ({ ...data, researchNotes: new Array(2) })],
  ])('rejects %s in browser and server', (_name, change) => {
    const data = change(createDevelopment(projectId, draftId));
    expect(developmentError(data, projectId, draftId)).toBeTruthy();
    expect(() => validateDevelopment(data, store.project(), { id: developmentId(draftId), store })).toThrow();
    expect(store.list(DEVELOPMENT_KIND)).toHaveLength(0);
  });

  it('bounds total text, preserves valid Unicode, and checks all collection field lengths', () => {
    const data = createDevelopment(projectId, draftId);
    data.concept = 'Unicode 🎬 é 字';
    expect(developmentError(data, projectId, draftId)).toBeNull();
    validateDevelopment(data, store.project());
    data.beats = Array.from({ length: 51 }, () => ({ ...newDevelopmentBeat(), description: 'a'.repeat(4000) }));
    expect(developmentError(data, projectId, draftId)).toMatch(/total/);
    expect(() => validateDevelopment(data, store.project())).toThrow(/TEXT_LIMIT/);
    for (const [key, row, fields] of [
      ['beats', newDevelopmentBeat(), { title: 200, description: 4000 }],
      ['characters', newDevelopmentCharacter(), { name: 120, role: 200, description: 6000, arc: 4000 }],
      ['researchNotes', newDevelopmentResearchNote(), { title: 200, notes: 6000, source: 2000 }],
    ] as const) {
      for (const [field, max] of Object.entries(fields)) {
        const changed = { ...createDevelopment(projectId, draftId), [key]: [{ ...row, [field]: 'a'.repeat(max + 1) }] };
        expect(developmentError(changed, projectId, draftId)).toBeTruthy();
        expect(() => validateDevelopment(changed, store.project())).toThrow(/TEXT_INVALID/);
      }
    }
  });

  it('requires an existing draft in this project and locks project/draft ownership', () => {
    const data = createDevelopment(projectId, otherDraftId);
    expect(() => record(data)).toThrow(/DRAFT_UNKNOWN/);
    expect(() => validateDevelopment(data, store.project(), { store: { current: () => ({ id: otherDraftId, kind: 'screenplay-draft', data: { projectId: 'wrong' } }) } })).toThrow(/DRAFT_PROJECT_MISMATCH/);
    const original = record(createDevelopment(projectId, draftId));
    expect(() => validateDevelopment(original.data, store.project(), { id: `${DEVELOPMENT_KIND}:wrong` })).toThrow(/IDENTITY_MISMATCH/);
    expect(() => validateDevelopment(original.data, store.project(), { previous: { ...original, data: { ...original.data, draftId: otherDraftId } } })).toThrow(/IDENTITY_IMMUTABLE/);
  });
});

describe('offline development panel', () => {
  it('does not fetch or save on open or typing, and explicitly saves to SQLite through localApi', async () => {
    const { onSaved } = await setup();
    expect(screen.getByRole('textbox', { name: 'Concept' })).toHaveValue('');
    expect(fetchMock).not.toHaveBeenCalled();
    write('Concept', 'Owner concept'); write('Logline', 'Owner logline'); write('Synopsis', 'Owner synopsis');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(readDevelopmentRecovery(localStorage, projectId, draftId)?.data.concept).toBe('Owner concept');
    await save();
    expect(onSaved).toHaveBeenCalledTimes(1);
    expect(store.current(developmentId(draftId))).toMatchObject({ kind: DEVELOPMENT_KIND, version: 1, data: { concept: 'Owner concept', logline: 'Owner logline', synopsis: 'Owner synopsis' } });
    expect(localStorage.getItem(developmentRecoveryKey(projectId, draftId))).toBeNull();
    const input = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(input.expectedVersion).toBeNull();
    expect(input.requestId).toBeTruthy();
  });

  it('creates, reorders, updates and removes entries across tabs; reads them after reopening', async () => {
    const view = await setup();
    tab('Outline & beats'); write('Outline', 'Owner outline');
    fireEvent.click(screen.getByRole('button', { name: 'Add beat' })); write('Beat 1 title', 'First'); write('Beat 1 description', 'First description');
    fireEvent.click(screen.getByRole('button', { name: 'Add beat' })); write('Beat 2 title', 'Second');
    fireEvent.click(screen.getByRole('button', { name: 'Move beat 2 up' }));
    expect(screen.getByLabelText('Beat 1 title')).toHaveValue('Second');
    tab('Characters'); fireEvent.click(screen.getByRole('button', { name: 'Add character' }));
    write('Character 1 name', 'Owner character'); write('Character 1 arc', 'Owner arc');
    tab('World & research'); write('World notes', 'Owner world');
    fireEvent.click(screen.getByRole('button', { name: 'Add research note' })); write('Research 1 title', 'Owner reference'); write('Research 1 source', 'Local reference, page 2');
    await save();
    const first = store.current(developmentId(draftId));
    view.unmount(); await setup(first);
    tab('Outline & beats'); expect(screen.getByLabelText('Outline')).toHaveValue('Owner outline');
    write('Beat 1 title', 'Revised'); fireEvent.click(screen.getByRole('button', { name: 'Remove beat 2' }));
    fireEvent.click(screen.getByRole('button', { name: 'Undo removal' })); expect(screen.getByLabelText('Beat 2 title')).toHaveValue('First');
    fireEvent.click(screen.getByRole('button', { name: 'Remove beat 2' }));
    tab('Characters'); expect(screen.getByLabelText('Character 1 arc')).toHaveValue('Owner arc');
    fireEvent.click(screen.getByRole('button', { name: 'Remove character 1' }));
    tab('World & research'); expect(screen.getByLabelText('World notes')).toHaveValue('Owner world');
    fireEvent.click(screen.getByRole('button', { name: 'Remove research note 1' }));
    await save();
    const second = store.current(developmentId(draftId));
    expect(second.version).toBe(2); expect(second.data.beats.map(beat => beat.title)).toEqual(['Revised']);
    expect(second.data.characters).toEqual([]); expect(second.data.researchNotes).toEqual([]);
    expect(store.history(second.id)[0]).toEqual(first);
  });

  it('preserves typing during save and a parent record refresh, then uses the new CAS version', async () => {
    const held = defer<Response>();
    let committed: Response;
    fetchMock.mockImplementationOnce((url, init) => { committed = localFetch(url, init); return held.promise; });
    const view = await setup(); write('Concept', 'First snapshot');
    fireEvent.click(screen.getByRole('button', { name: 'Save development' }));
    write('Concept', 'Typed while saving');
    await act(async () => held.resolve(committed!));
    const first = store.current(developmentId(draftId));
    view.rerender(<DevelopmentPanel {...view.props} initialRecord={first} />);
    expect(screen.getByRole('textbox', { name: 'Concept' })).toHaveValue('Typed while saving');
    expect(screen.getByText('Unsaved changes')).toBeInTheDocument();
    expect(readDevelopmentRecovery(localStorage, projectId, draftId)?.data.concept).toBe('Typed while saving');
    await save();
    expect(store.current(first.id).version).toBe(2);
    expect(store.history(first.id).map(item => item.data.concept)).toEqual(['First snapshot', 'Typed while saving']);
  });

  it('replays a lost response exactly even if the user types more before retrying', async () => {
    fetchMock.mockImplementationOnce(async (url, init) => { localFetch(url, init); throw new Error('Lost response'); });
    await setup(); write('Concept', 'First'); fireEvent.click(screen.getByRole('button', { name: 'Save development' }));
    await screen.findByRole('button', { name: 'Retry save' });
    write('Concept', 'Later typing');
    fireEvent.click(screen.getByRole('button', { name: 'Retry save' }));
    await screen.findByRole('button', { name: 'Save development' });
    expect(fetchMock.mock.calls[0][1].body).toBe(fetchMock.mock.calls[1][1].body);
    expect(screen.getByRole('textbox', { name: 'Concept' })).toHaveValue('Later typing');
    expect(store.history(developmentId(draftId))).toHaveLength(1);
    await save(); expect(store.current(developmentId(draftId)).data.concept).toBe('Later typing');
  });

  it('recovers an uncertain save after reopening without duplicating the revision', async () => {
    fetchMock.mockImplementationOnce(async (url, init) => { localFetch(url, init); throw new Error('Lost response'); });
    const view = await setup(); write('Concept', 'Committed'); fireEvent.click(screen.getByRole('button', { name: 'Save development' }));
    await screen.findByRole('button', { name: 'Retry save' }); write('Concept', 'Still editing');
    view.unmount(); await setup(store.current(developmentId(draftId)));
    fireEvent.click(screen.getByRole('button', { name: 'Restore recovery' }));
    fireEvent.click(screen.getByRole('button', { name: 'Retry save' }));
    await screen.findByRole('button', { name: 'Save development' });
    expect(store.history(developmentId(draftId))).toHaveLength(1);
    expect(screen.getByRole('textbox', { name: 'Concept' })).toHaveValue('Still editing');
    await save(); expect(store.history(developmentId(draftId))).toHaveLength(2);
  });

  it('keeps edits after a conflict, reviews the latest, and requires another explicit save', async () => {
    const first = record({ ...createDevelopment(projectId, draftId), concept: 'Original' });
    await setup(first); write('Concept', 'Local edits');
    record({ ...first.data, concept: 'Other window' }, 1);
    fireEvent.click(screen.getByRole('button', { name: 'Save development' }));
    await screen.findByRole('region', { name: 'Development conflict' });
    expect(screen.getByRole('textbox', { name: 'Concept' })).toHaveValue('Local edits');
    expect(screen.getByRole('button', { name: 'Save development' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Review latest saved' }));
    await screen.findByRole('button', { name: 'Keep my edits against v2' });
    write('Concept', 'Local edits after review');
    fireEvent.click(screen.getByRole('button', { name: 'Keep my edits against v2' }));
    expect(store.current(first.id).version).toBe(2);
    await save();
    expect(store.history(first.id).map(item => item.data.concept)).toEqual(['Original', 'Other window', 'Local edits after review']);
  });

  it('adopts clean incoming revisions but preserves dirty text when newer props arrive', async () => {
    const first = record(createDevelopment(projectId, draftId));
    const view = await setup(first);
    const second = record({ ...first.data, concept: 'Fresh' }, 1);
    view.rerender(<DevelopmentPanel {...view.props} initialRecord={second} />);
    expect(screen.getByRole('textbox', { name: 'Concept' })).toHaveValue('Fresh');
    write('Concept', 'Keep typing');
    const third = record({ ...second.data, concept: 'External' }, 2);
    view.rerender(<DevelopmentPanel {...view.props} initialRecord={third} />);
    expect(screen.getByRole('textbox', { name: 'Concept' })).toHaveValue('Keep typing');
    expect(screen.getByRole('region', { name: 'Development conflict' })).toBeInTheDocument();
    view.rerender(<DevelopmentPanel {...view.props} initialRecord={first} />);
    expect(screen.getByRole('button', { name: 'Keep my edits against v3' })).toBeInTheDocument();
    view.rerender(<DevelopmentPanel {...view.props} initialRecord={second} />);
    expect(screen.getByRole('button', { name: 'Keep my edits against v3' })).toBeInTheDocument();
  });

  it('keeps per-draft recovery across immediate navigation and explicitly restores or discards it', async () => {
    seedDraft(otherDraftId);
    const view = await setup(); write('Concept', 'Last keystroke');
    view.rerender(<DevelopmentPanel {...view.props} draftId={otherDraftId} />);
    expect(screen.getByRole('textbox', { name: 'Concept' })).toHaveValue('');
    view.rerender(<DevelopmentPanel {...view.props} />);
    await act(async () => {});
    expect(screen.getByRole('textbox', { name: 'Concept' })).toBeDisabled();
    expect(readDevelopmentRecovery(localStorage, projectId, draftId)?.data.concept).toBe('Last keystroke');
    fireEvent.click(screen.getByRole('button', { name: 'Restore recovery' }));
    expect(screen.getByRole('textbox', { name: 'Concept' })).toHaveValue('Last keystroke');
    view.unmount(); await setup();
    fireEvent.click(screen.getByRole('button', { name: 'Discard recovery' }));
    await act(async () => {});
    expect(localStorage.getItem(developmentRecoveryKey(projectId, draftId))).toBeNull();
    expect(screen.getByRole('textbox', { name: 'Concept' })).toHaveValue('');
  });

  it('requires review when the recovered base differs from current storage', async () => {
    const first = record(createDevelopment(projectId, draftId));
    const view = await setup(first); write('Concept', 'Recovered'); view.unmount();
    const second = record({ ...first.data, concept: 'New external' }, 1);
    await setup(second); fireEvent.click(screen.getByRole('button', { name: 'Restore recovery' }));
    expect(screen.getByRole('region', { name: 'Development conflict' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save development' })).toBeDisabled();
    expect(screen.getByRole('textbox', { name: 'Concept' })).toHaveValue('Recovered');
  });

  it('handles failed storage gracefully and can still explicitly save', async () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('Quota', 'QuotaExceededError'); });
    await setup(); write('Concept', 'Keep in memory');
    expect(screen.getByText(/Browser recovery is unavailable/)).toBeInTheDocument();
    await save(); expect(store.current(developmentId(draftId)).data.concept).toBe('Keep in memory');
  });

  it('rejects malformed and foreign recovery instead of mounting its data', async () => {
    const view = await setup(); write('Concept', 'Local'); view.unmount();
    const key = developmentRecoveryKey(projectId, draftId);
    const good = localStorage.getItem(key)!;
    for (const raw of ['{bad', JSON.stringify({ ...JSON.parse(good), projectId: 'foreign' }), JSON.stringify({ ...JSON.parse(good), data: { ...JSON.parse(good).data, concept: 1 } }), JSON.stringify({ ...JSON.parse(good), pendingSave: { requestId: 'bad' } })]) {
      localStorage.setItem(key, raw); expect(readDevelopmentRecovery(localStorage, projectId, draftId)).toBeNull();
    }
    await setup(); expect(screen.getByRole('textbox', { name: 'Concept' })).toHaveValue('');
  });

  it('does not allow a foreign initial record to be edited or saved', async () => {
    const first = record(createDevelopment(projectId, draftId));
    await setup({ ...first, data: { ...first.data, draftId: otherDraftId } });
    expect(screen.getByRole('alert')).toHaveTextContent(/does not match/);
    expect(screen.queryByRole('button', { name: 'Save development' })).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('exports unsaved JSON and Markdown through the existing download helper', async () => {
    await setup(); write('Concept', 'Unsaved export');
    fireEvent.click(screen.getByRole('button', { name: 'Export JSON' }));
    expect(JSON.parse(vi.mocked(downloadText).mock.calls[0][1]).concept).toBe('Unsaved export');
    fireEvent.click(screen.getByRole('button', { name: 'Export Markdown' }));
    expect(vi.mocked(downloadText).mock.calls[1][1]).toContain('Unsaved export');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('scopes the save shortcut to this panel, guards unload, and has labelled keyboard tabs', async () => {
    await setup(); write('Concept', 'Keyboard edit');
    expect(screen.getByRole('tablist', { name: 'Development sections' })).toBeInTheDocument();
    expect(screen.getAllByRole('tab')).toHaveLength(4);
    const event = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    const shellShortcut = vi.fn(); window.addEventListener('keydown', shellShortcut);
    try {
      fireEvent.keyDown(screen.getByRole('textbox', { name: 'Concept' }), { key: 's', ctrlKey: true });
      await waitFor(() => expect(store.current(developmentId(draftId))).not.toBeNull());
      expect(shellShortcut).not.toHaveBeenCalled();
    } finally { window.removeEventListener('keydown', shellShortcut); }
  });
});
