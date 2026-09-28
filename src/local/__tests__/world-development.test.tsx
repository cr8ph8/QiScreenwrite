import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { localApi } from '../api';
import { WriterDesk } from '../components/WriterDesk';
import { DevelopmentPanel } from '../components/DevelopmentPanel';
import { DEVELOPMENT_KIND, createDevelopment, developmentId, developmentSave, readDevelopmentRecovery, type DevelopmentData, type DevelopmentRecovery } from '../development';
import { buildDraftData } from '../model';
import type { DraftRecord, LocalProject } from '../types';
import { initialize, WorkspaceStore } from '../../../local/server/storage.mjs';
import { validateRecord } from '../../../local/server/contracts.mjs';
import { validateDevelopment } from '../../../local/server/development.mjs';
import { newWorldElement, newWorldLink } from '../world';
import { worldContext } from '../world-context';
import { parseScreenplay } from '@/lib/fountain/spec';

// Keep the real writer, DevelopmentPanel and WorldBuilder. These unrelated
// surfaces cannot reach a connector, render a PDF, or access production data.
vi.mock('../components/QiMoviPanel', () => ({ QiMoviPanel: () => null }));
vi.mock('../components/HistoryPanel', () => ({ HistoryPanel: () => null }));
vi.mock('../components/FilmcraftPanel', () => ({ FilmcraftPanel: () => null }));
vi.mock('../components/CompetitionPanel', () => ({ CompetitionPanel: () => null }));
vi.mock('@/lib/fountain/pdf', () => ({ exportScreenplayPdf: vi.fn() }));

const draftId = 'screenplay-draft:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const body = 'INT. LAB - DAY #12A#\n\nMIRA\nKeep this authored dialogue.\n\nEXT. PIER - NIGHT\n\nRain falls.';
let directory: string;
let store: InstanceType<typeof WorkspaceStore>;
let project: LocalProject;
let draft: DraftRecord;
let fetchMock: ReturnType<typeof vi.fn>;

const response = (value: unknown, status = 200) => ({ ok: status < 400, status, json: async () => value }) as Response;
function localFetch(url: string, init?: RequestInit): Response {
  const match = /^\/api\/records\/([^/]+)(\/history)?$/.exec(url);
  if (!match) throw new Error(`Unexpected request in world test: ${url}`);
  const id = decodeURIComponent(match[1]);
  try {
    if (match[2]) return response(store.history(id));
    expect(init?.method).toBe('PUT');
    expect(init?.credentials).toBe('same-origin');
    return response(store.save(id, JSON.parse(String(init?.body))));
  } catch (cause) {
    const error = cause as Error & { code?: string; status?: number };
    return response({ error: error.code, detail: error.message }, error.status ?? 400);
  }
}
const write = (name: string, value: string) => fireEvent.change(screen.getByRole('textbox', { name }), { target: { value } });
const click = (name: string | RegExp) => fireEvent.click(screen.getByRole('button', { name }));
const tab = (name: string) => fireEvent.mouseDown(screen.getByRole('tab', { name }), { button: 0, ctrlKey: false });
const development = () => store.current(developmentId(draftId))?.data as DevelopmentData | undefined;
const writes = () => fetchMock.mock.calls.filter(([, init]) => init?.method === 'PUT');

function mockDevelopmentDisk() {
  const disk = { current: null as DevelopmentRecovery | null };
  vi.mocked(localApi.developmentRecovery.get).mockImplementation(async () => structuredClone(disk.current));
  vi.mocked(localApi.developmentRecovery.put).mockImplementation(async copy => {
    disk.current = structuredClone(copy);
    return structuredClone(copy);
  });
  vi.mocked(localApi.developmentRecovery.remove).mockImplementation(async (_draftId, savedAt) => {
    const deleted = disk.current?.savedAt === savedAt;
    if (deleted) disk.current = null;
    return { deleted };
  });
  return disk;
}

const openWorldElement = (name: string) => fireEvent.click(within(screen.getByRole('complementary', { name: 'World elements' })).getByRole('button', { name: new RegExp(name) }));

async function setupWorldPanel() {
  const props = { projectId: project.id, draftId, view: 'world' as const, onSaved: vi.fn() };
  const view = render(<DevelopmentPanel {...props} />);
  await act(async () => {});
  // Control only the recovery debounce; timestamps still exercise the panel's
  // monotonic clock, including several edits during one wall-clock millisecond.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  return { ...view, props };
}

async function setupSavedWorldPanel() {
  const view = await setupWorldPanel();
  click('Add'); write('Element name', 'Archive'); write('Description', 'Saved description.');
  await act(async () => click('Save development'));
  const saved = store.current(developmentId(draftId));
  expect(saved.version).toBe(1);
  vi.mocked(localApi.developmentRecovery.put).mockClear();
  vi.mocked(localApi.developmentRecovery.remove).mockClear();
  return { ...view, saved };
}

async function setup(initial?: DevelopmentData) {
  const records = [draft];
  if (initial) {
    const { id, ...input } = developmentSave(initial, null);
    records.push(store.save(id, input));
  }
  const props = { project, open: { id: draftId, saved: draft, initial: null }, records, onSaved: vi.fn(), onRecordsChanged: vi.fn(async () => {}) };
  const view = render(<WriterDesk {...props} />);
  await act(async () => {});
  return { ...view, props };
}

beforeEach(() => {
  localStorage.clear(); vi.clearAllMocks();
  vi.spyOn(localApi.recovery, 'get').mockResolvedValue(null);
  vi.spyOn(localApi.recovery, 'put').mockImplementation(async copy => copy);
  vi.spyOn(localApi.recovery, 'remove').mockResolvedValue({ deleted: true });
  vi.spyOn(localApi.developmentRecovery, 'get').mockResolvedValue(null);
  vi.spyOn(localApi.developmentRecovery, 'put').mockImplementation(async copy => copy);
  vi.spyOn(localApi.developmentRecovery, 'remove').mockResolvedValue({ deleted: true });
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'writer-world-ui-test-'));
  initialize(directory);
  store = new WorkspaceStore(directory, (kind, data, owner, context) => kind === DEVELOPMENT_KIND ? validateDevelopment(data, owner, context) : validateRecord(kind, data, owner, context));
  project = store.project();
  draft = store.save(draftId, { kind: 'screenplay-draft', expectedVersion: null, requestId: crypto.randomUUID(), data: buildDraftData(project.id, { title: 'Authored fixture', body }) });
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => localFetch(url, init));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(async () => {
  cleanup();
  await act(async () => {});
  vi.useRealTimers();
  store.close();
  fs.rmSync(directory, { recursive: true, force: true });
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});

describe('world and development in the writer desk', () => {
  it('opens linked world elements from the current screenplay scene and returns from Film language with unsaved edits intact', async () => {
    const element = { ...newWorldElement('location'), name: 'Laboratory', description: 'Original setting.' };
    const scene = worldContext(parseScreenplay(body)).scenes[0];
    const initial: DevelopmentData = { ...createDevelopment(project.id, draftId), schemaVersion: 2, world: { schemaVersion: 1, elements: [element], links: [newWorldLink(element.id, 'scene', scene.ref, scene.label)] } };
    await setup(initial);
    click('Inspector');
    const backlinks = screen.getByRole('region', { name: 'World in this scene' });
    fireEvent.click(within(backlinks).getByRole('button', { name: 'Laboratory' }));
    expect(screen.getByRole('tab', { name: 'World Builder' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('textbox', { name: 'Element name' })).toHaveValue('Laboratory');
    write('Description', 'Unsaved, specific setting.');
    click('Explore visual choices in Film language');
    expect(screen.getByRole('tab', { name: 'Film language' })).toHaveAttribute('aria-selected', 'true');
    click('Back to World Builder');
    expect(screen.getByRole('textbox', { name: 'Description' })).toHaveValue('Unsaved, specific setting.');
    tab('Write'); click('Inspector');
    fireEvent.click(within(screen.getByRole('region', { name: 'World in this scene' })).getByRole('button', { name: 'Laboratory' }));
    expect(screen.getByRole('textbox', { name: 'Description' })).toHaveValue('Unsaved, specific setting.');
    expect(store.current(developmentId(draftId)).data.world.elements[0].description).toBe('Original setting.');
  }, 20000);

  it.each(['manual text reversion', 'Undo removal'])('retires disk recovery after %s returns to saved data without creating a revision', async action => {
    const disk = mockDevelopmentDisk();
    const view = await setupSavedWorldPanel();
    if (action === 'Undo removal') click('Remove world element');
    else write('Description', 'Temporary unsaved description.');
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    expect(localApi.developmentRecovery.put).toHaveBeenCalledTimes(1);
    expect(disk.current?.data).not.toEqual(view.saved.data);
    const oldTimestamp = disk.current!.savedAt;

    await act(async () => {
      if (action === 'Undo removal') click('Undo removal');
      else write('Description', 'Saved description.');
    });
    expect(screen.getByRole('button', { name: 'Save development' })).toBeDisabled();
    expect(localApi.developmentRecovery.remove).toHaveBeenCalledExactlyOnceWith(draftId, oldTimestamp);
    expect(disk.current).toBeNull();
    expect(readDevelopmentRecovery(localStorage, project.id, draftId)).toBeNull();
    expect(store.history(developmentId(draftId))).toEqual([view.saved]);
    expect(view.props.onSaved).toHaveBeenCalledTimes(1);
    expect(writes()).toHaveLength(1);

    view.unmount(); await act(async () => {}); localStorage.clear();
    render(<DevelopmentPanel {...view.props} initialRecord={view.saved} />);
    await act(async () => {});
    expect(screen.queryByRole('button', { name: 'Restore recovery' })).not.toBeInTheDocument();
    openWorldElement('Archive');
    expect(screen.getByRole('textbox', { name: 'Description' })).toHaveValue('Saved description.');
    expect(screen.getByRole('button', { name: 'Save development' })).toBeDisabled();
  });

  it('rechecks dirty state before queued clean recovery cleanup and retains edits arriving behind an unfinished disk write', async () => {
    const disk = mockDevelopmentDisk();
    const view = await setupSavedWorldPanel();
    let finishWrite!: () => void;
    const writeGate = new Promise<void>(resolve => { finishWrite = resolve; });
    vi.mocked(localApi.developmentRecovery.put).mockImplementationOnce(async copy => {
      await writeGate;
      disk.current = structuredClone(copy);
      return structuredClone(copy);
    });
    write('Description', 'Temporary description in an unfinished disk write.');
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    expect(localApi.developmentRecovery.put).toHaveBeenCalledTimes(1);
    expect(disk.current).toBeNull();

    write('Description', 'Saved description.'); // Cleanup waits behind the write.
    expect(screen.getByRole('button', { name: 'Save development' })).toBeDisabled();
    write('Description', 'Newer edits before cleanup can start.');
    const newest = readDevelopmentRecovery(localStorage, project.id, draftId)!;
    await act(async () => finishWrite());
    expect(localApi.developmentRecovery.remove).not.toHaveBeenCalled();
    expect(disk.current?.data).toEqual(newest.data);
    expect(screen.getByRole('textbox', { name: 'Description' })).toHaveValue('Newer edits before cleanup can start.');
    expect(screen.getByRole('button', { name: 'Save development' })).toBeEnabled();
    expect(store.history(developmentId(draftId))).toEqual([view.saved]);
    expect(writes()).toHaveLength(1);
  });

  it('preserves newer edits while conditional deletion of a reverted disk copy is in flight', async () => {
    const disk = mockDevelopmentDisk();
    const view = await setupSavedWorldPanel();
    write('Description', 'Temporary persisted description.');
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    const oldTimestamp = disk.current!.savedAt;
    let finishRemove!: () => void;
    const removeGate = new Promise<void>(resolve => { finishRemove = resolve; });
    vi.mocked(localApi.developmentRecovery.remove).mockImplementationOnce(async (_draftId, savedAt) => {
      await removeGate;
      const deleted = disk.current?.savedAt === savedAt;
      if (deleted) disk.current = null;
      return { deleted };
    });

    await act(async () => write('Description', 'Saved description.'));
    expect(localApi.developmentRecovery.remove).toHaveBeenCalledExactlyOnceWith(draftId, oldTimestamp);
    write('Description', 'Newer edits while old-copy deletion is pending.');
    const newest = readDevelopmentRecovery(localStorage, project.id, draftId)!;
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    expect(disk.current?.savedAt).toBe(oldTimestamp);
    await act(async () => finishRemove());
    expect(disk.current?.data).toEqual(newest.data);
    expect(disk.current?.savedAt).toBe(newest.savedAt);
    expect(readDevelopmentRecovery(localStorage, project.id, draftId)?.data).toEqual(newest.data);
    expect(screen.getByRole('textbox', { name: 'Description' })).toHaveValue('Newer edits while old-copy deletion is pending.');
    expect(screen.getByRole('button', { name: 'Save development' })).toBeEnabled();
    expect(store.history(developmentId(draftId))).toEqual([view.saved]);
    expect(writes()).toHaveLength(1);
  });

  it('removes an older disk recovery after a newer world save before the next debounce and does not offer it on reload', async () => {
    const disk = mockDevelopmentDisk();
    const view = await setupWorldPanel();
    click('Add'); write('Element name', 'Archive'); write('Description', 'Older unsaved description.');
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    expect(localApi.developmentRecovery.put).toHaveBeenCalledTimes(1);
    expect(disk.current?.data.world?.elements[0].description).toBe('Older unsaved description.');
    const oldTimestamp = disk.current!.savedAt;

    write('Description', 'Newer description submitted immediately.');
    await act(async () => click('Save development'));
    expect(view.props.onSaved).toHaveBeenCalledTimes(1);
    expect(development()?.world?.elements[0].description).toBe('Newer description submitted immediately.');
    expect(localApi.developmentRecovery.put).toHaveBeenCalledTimes(1);
    expect(localApi.developmentRecovery.remove).toHaveBeenCalledExactlyOnceWith(draftId, oldTimestamp);
    expect(disk.current).toBeNull();
    expect(readDevelopmentRecovery(localStorage, project.id, draftId)).toBeNull();

    view.unmount(); await act(async () => {});
    localStorage.clear();
    render(<DevelopmentPanel {...view.props} initialRecord={store.current(developmentId(draftId))} />);
    await act(async () => {});
    expect(screen.queryByRole('button', { name: 'Restore recovery' })).not.toBeInTheDocument();
    openWorldElement('Archive');
    expect(screen.getByRole('textbox', { name: 'Description' })).toHaveValue('Newer description submitted immediately.');
    expect(screen.getByRole('button', { name: 'Save development' })).toBeDisabled();
    expect(store.history(developmentId(draftId))).toHaveLength(1);
  });

  it.each([
    { location: 'already written to disk', flushBeforeResponse: true },
    { location: 'still queued for disk', flushBeforeResponse: false },
  ])('preserves edits made during a world save when their recovery is $location', async ({ flushBeforeResponse }) => {
    const disk = mockDevelopmentDisk();
    const view = await setupWorldPanel();
    click('Add'); write('Element name', 'Archive'); write('Description', 'Older disk description.');
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    const oldTimestamp = disk.current!.savedAt;

    let releaseResponse!: () => void;
    const responseGate = new Promise<void>(resolve => { releaseResponse = resolve; });
    fetchMock.mockImplementationOnce(async (url: string, init?: RequestInit) => {
      const savedResponse = localFetch(url, init);
      await responseGate;
      return savedResponse;
    });
    write('Description', 'Submitted description.');
    await act(async () => click('Save development'));
    const saveTimestamp = readDevelopmentRecovery(localStorage, project.id, draftId)!.savedAt;
    expect(view.props.onSaved).not.toHaveBeenCalled();
    expect(development()?.world?.elements[0].description).toBe('Submitted description.');

    write('Description', 'New typing while the save response is pending.');
    const newerRecovery = readDevelopmentRecovery(localStorage, project.id, draftId)!;
    expect(Date.parse(newerRecovery.savedAt)).toBeGreaterThan(Date.parse(saveTimestamp));
    if (flushBeforeResponse) {
      await act(async () => { await vi.advanceTimersByTimeAsync(300); });
      expect(disk.current?.data).toEqual(newerRecovery.data);
    } else {
      expect(disk.current?.savedAt).toBe(oldTimestamp);
    }
    await act(async () => releaseResponse());
    expect(view.props.onSaved).toHaveBeenCalledTimes(1);
    expect(localApi.developmentRecovery.remove).not.toHaveBeenCalled();
    expect(disk.current?.data).toEqual(newerRecovery.data);
    expect(disk.current).toMatchObject({ baseVersion: 1, pendingSave: null });
    expect(Date.parse(disk.current!.savedAt)).toBeGreaterThan(Date.parse(saveTimestamp));
    expect(readDevelopmentRecovery(localStorage, project.id, draftId)?.data).toEqual(newerRecovery.data);
    expect(screen.getByRole('textbox', { name: 'Description' })).toHaveValue('New typing while the save response is pending.');
    expect(screen.getByRole('button', { name: 'Save development' })).toBeEnabled();
    expect(development()?.world?.elements[0].description).toBe('Submitted description.');

    view.unmount(); await act(async () => {});
    localStorage.clear(); // Prove the newer edits survive through disk recovery.
    render(<DevelopmentPanel {...view.props} initialRecord={store.current(developmentId(draftId))} />);
    await act(async () => {});
    click('Restore recovery'); openWorldElement('Archive');
    expect(screen.getByRole('textbox', { name: 'Description' })).toHaveValue('New typing while the save response is pending.');
    expect(screen.getByRole('button', { name: 'Save development' })).toBeEnabled();
    expect(store.history(developmentId(draftId))).toHaveLength(1);
  });

  it('opens a legacy development record without migrating it, importing names, or inventing story text', async () => {
    const initial = { ...createDevelopment(project.id, draftId), concept: 'Owner premise.', worldNotes: 'Owner setting.' };
    await setup(initial);
    expect(screen.queryByRole('complementary', { name: 'World elements', hidden: true })).not.toBeInTheDocument();
    tab('World Builder');
    expect(screen.getByText('Build a world the audience can believe.')).toBeVisible();
    fireEvent.click(screen.getByText('Bring in names from your screenplay & development'));
    expect(screen.getByRole('button', { name: 'MIRA Character cue' })).toBeEnabled();
    expect(development()).toEqual(initial);
    expect(writes()).toHaveLength(0);
    expect(localApi.developmentRecovery.put).not.toHaveBeenCalled();
    expect(readDevelopmentRecovery(localStorage, project.id, draftId)).toBeNull();
    tab('Develop');
    expect(screen.getByRole('textbox', { name: 'Concept' })).toHaveValue('Owner premise.');
    expect(screen.getByRole('textbox', { name: 'Logline' })).toHaveValue('');
    expect(screen.getByRole('textbox', { name: 'Synopsis' })).toHaveValue('');
    expect(store.current(draftId)).toEqual(draft);
  });

  it('retains unsaved authored data both ways between Develop and World Builder, then saves and reopens it', async () => {
    const view = await setup();
    tab('Develop'); write('Concept', 'Owner premise.');
    tab('World & research'); write('World notes', 'Owner setting.\nSecond line.');
    tab('World Builder');
    fireEvent.click(screen.getByText('World overview', { selector: 'summary' }));
    expect(screen.getByRole('textbox', { name: 'World overview' })).toHaveValue('Owner setting.\nSecond line.');
    write('World overview', 'World view refinement.');
    click('Add'); write('Element name', 'Flooded archive'); write('Description', 'Authored description.');
    const mountedNameInput = screen.getByRole('textbox', { name: 'Element name' });
    click('Story & continuity'); write('Continuity & open questions', 'No dry exits.');
    tab('Develop');
    expect(screen.getByRole('textbox', { name: 'World notes' })).toHaveValue('World view refinement.');
    write('World notes', 'Develop view refinement.');
    tab('Concept'); expect(screen.getByRole('textbox', { name: 'Concept' })).toHaveValue('Owner premise.');
    write('Concept', 'Revised owner premise.');
    tab('World Builder');
    expect(screen.getByRole('textbox', { name: 'Element name' })).toBe(mountedNameInput);
    expect(screen.getByRole('textbox', { name: 'Element name' })).toHaveValue('Flooded archive');
    expect(screen.getByRole('textbox', { name: 'Continuity & open questions' })).toHaveValue('No dry exits.');
    expect(screen.getByRole('textbox', { name: 'World overview' })).toHaveValue('Develop view refinement.');
    const recovery = readDevelopmentRecovery(localStorage, project.id, draftId);
    expect(recovery?.data).toMatchObject({ schemaVersion: 2, concept: 'Revised owner premise.', worldNotes: 'Develop view refinement.', world: { elements: [{ name: 'Flooded archive', description: 'Authored description.', continuity: 'No dry exits.' }] } });
    expect(writes()).toHaveLength(0);
    click('Save development');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save development' })).toBeDisabled());
    expect(development()).toEqual(recovery?.data);
    expect(store.history(draftId)).toEqual([draft]);
    view.unmount();
    await act(async () => {});
    localStorage.clear(); // The reopened values must come from the saved record.
    const saved = store.current(developmentId(draftId));
    render(<WriterDesk {...view.props} records={[draft, saved]} />);
    await act(async () => {});
    tab('World Builder');
    fireEvent.click(within(screen.getByRole('complementary', { name: 'World elements' })).getByRole('button', { name: /Flooded archive/ }));
    expect(screen.getByRole('textbox', { name: 'Description' })).toHaveValue('Authored description.');
    click('Story & continuity');
    expect(screen.getByRole('textbox', { name: 'Continuity & open questions' })).toHaveValue('No dry exits.');
    tab('Develop');
    expect(screen.getByRole('textbox', { name: 'Concept' })).toHaveValue('Revised owner premise.');
  }, 20000);

  it.each([
    { label: 'Cmd+S inside the world editor', destination: 'editor', metaKey: true, ctrlKey: false },
    { label: 'Ctrl+S inside the world editor', destination: 'editor', metaKey: false, ctrlKey: true },
    { label: 'Cmd+S at the window', destination: 'window', metaKey: true, ctrlKey: false },
    { label: 'native save command', destination: 'command', metaKey: false, ctrlKey: false },
    { label: 'top Save button', destination: 'button', metaKey: false, ctrlKey: false },
  ])('routes $label to development while the screenplay has unsaved edits', async ({ destination, metaKey, ctrlKey }) => {
    await setup();
    click('Fountain'); write('Fountain screenplay', `${body}\n\nUncommitted screenplay text.`);
    tab('World Builder'); click('Add'); write('Element name', 'Owner location');
    expect(screen.getByText('World & development · Unsaved changes')).toHaveAttribute('role', 'status');
    expect(screen.getByText('Screenplay has unsaved changes')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
    if (destination === 'command') {
      act(() => { window.dispatchEvent(new CustomEvent('writer:command', { detail: 'save' })); });
    } else if (destination === 'button') {
      click('Save');
    } else {
      fireEvent.keyDown(destination === 'window' ? window : screen.getByRole('textbox', { name: 'Element name' }), { key: 's', metaKey, ctrlKey });
    }
    await waitFor(() => expect(development()?.schemaVersion).toBe(2));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save development' })).toBeDisabled());
    expect(screen.getByText('World & development · Saved v1')).toHaveAttribute('data-dirty', 'false');
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    expect(writes()).toHaveLength(1);
    expect(JSON.parse(String(writes()[0][1]?.body))).toMatchObject({ kind: DEVELOPMENT_KIND, data: { world: { elements: [{ name: 'Owner location', description: '', storyFunction: '', continuity: '' }] } } });
    expect(store.history(draftId)).toEqual([draft]);
    tab('Write');
    expect(screen.getByRole('textbox', { name: 'Fountain screenplay' })).toHaveValue(`${body}\n\nUncommitted screenplay text.`);
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
  }, 20000);

  it('routes top Save from Develop and reflects its status even when the screenplay is clean', async () => {
    await setup();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    tab('Develop'); write('Concept', 'Owner concept saved from the toolbar.');
    expect(screen.getByText('Development · Unsaved changes')).toHaveAttribute('data-dirty', 'true');
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
    click('Save');
    await waitFor(() => expect(screen.getByText('Development · Saved v1')).toHaveAttribute('data-dirty', 'false'));
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    expect(development()).toMatchObject({ schemaVersion: 1, concept: 'Owner concept saved from the toolbar.' });
    expect(store.history(draftId)).toEqual([draft]);
    tab('World Builder');
    expect(screen.getByText('World & development · Saved v1')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('keeps top Save disabled while checking development recovery and enables it after loading', async () => {
    let resolveRecovery!: (value: null) => void;
    vi.mocked(localApi.developmentRecovery.get).mockReturnValueOnce(new Promise(resolve => { resolveRecovery = resolve; }));
    await setup(); tab('World Builder');
    expect(screen.getByText('World & development · Checking disk recovery…')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Save development' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Add' })).toBeDisabled();
    await act(async () => resolveRecovery(null));
    expect(screen.getByText('World & development · No saved development')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
    expect(writes()).toHaveLength(0);
  });

  it('does not let the mounted world editor capture save after returning to Write', async () => {
    await setup();
    tab('World Builder'); click('Add'); write('Element name', 'Unsaved world name');
    tab('Write'); click('Fountain'); write('Fountain screenplay', `${body}\n\nOwner screenplay revision.`);
    fireEvent.keyDown(window, { key: 's', ctrlKey: true });
    await waitFor(() => expect(store.current(draftId).version).toBe(2));
    expect(development()).toBeUndefined();
    expect(writes()).toHaveLength(1);
    expect(JSON.parse(String(writes()[0][1]?.body))).toMatchObject({ kind: 'screenplay-draft' });
    tab('World Builder');
    expect(screen.getByRole('textbox', { name: 'Element name' })).toHaveValue('Unsaved world name');
    expect(screen.getByRole('button', { name: 'Save development' })).toBeEnabled();
  });
});
