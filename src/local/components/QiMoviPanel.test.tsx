import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toast } from 'sonner';
import { QiMoviPanel } from './QiMoviPanel';
import { localApi } from '../api';
import { createDevelopment, developmentId, type DevelopmentRecord } from '../development';
import { buildDraftData } from '../model';
import { createWorld, newWorldElement } from '../world';
import type { DraftRecord, QiMoviInstalled, QiMoviStatus, QiMoviSummary, QiMoviWorldTransfer } from '../types';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('../api', async (importOriginal) => {
  const original = await importOriginal<typeof import('../api')>();
  return { ...original, localApi: { ...original.localApi, qimovi: {
    ...original.localApi.qimovi, previewUniverse: vi.fn(), pushUniverse: vi.fn(),
  } } };
});

const projectId = 'project:world-ui-test';
const draftId = 'screenplay-draft:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const remoteProject = { id: 'project:qimovi-destination', title: 'Destination project', profile: 'caniscreenwrite-creative/v1', sourceHash: null, sourceStatus: 'NO_SOURCE' };
const disconnected: QiMoviStatus = { configured: false, connected: false, origin: null, project: null };
const connected: QiMoviSummary = { configured: true, connected: true, origin: 'http://127.0.0.1:4317', project: remoteProject, canonical: null, drafts: [] };
const draft: DraftRecord = { id: draftId, kind: 'screenplay-draft', version: 2, sha256: 'a'.repeat(64), data: buildDraftData(projectId, { title: 'Authored screenplay', body: 'INT. LAB - DAY\n\nOwner action.' }) };
const development: DevelopmentRecord = {
  id: developmentId(draftId), kind: 'story-development', version: 3, sha256: 'b'.repeat(64),
  data: { ...createDevelopment(projectId, draftId), schemaVersion: 2, world: { ...createWorld(), elements: [{ ...newWorldElement('location'), name: 'Archive', description: 'Owner notes.' }] } },
};
const transfer: QiMoviWorldTransfer = {
  developmentVersion: development.version,
  files: [
    { filename: 'world.json', recordId: 'library-file:world-json', sha256: 'c'.repeat(64), verified: true },
    { filename: 'world.md', recordId: 'library-file:world-md', sha256: 'd'.repeat(64), verified: true },
  ],
};
const universePreview = {
  token: 'reviewed-universe-token', project: remoteProject, developmentVersion: development.version,
  counts: { create: 1, update: 1, unchanged: 1, conflicts: 0 },
  items: [
    { id: 'universe-entity:archive', kind: 'universe-entity', label: 'Archive', action: 'create' as const },
    { id: 'universe-profile:archive', kind: 'universe-profile', label: 'Archive details', action: 'update' as const, reason: 'New saved world details.' },
    { id: 'universe-link:archive', kind: 'universe-link', label: 'Archive connection', action: 'unchanged' as const },
  ],
  notes: ['Scene references remain in the reference files.'],
};
const universeTransfer = {
  changed: true, project: remoteProject, developmentVersion: development.version,
  counts: universePreview.counts,
  records: [{ id: 'universe-entity:archive', kind: 'universe-entity', version: 1, sha256: 'e'.repeat(64) }],
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const response = (data: unknown, status = 200) => ({ ok: status < 400, status, json: async () => data }) as Response;
let status: QiMoviStatus;
let installed: QiMoviInstalled;
let fetchMock: ReturnType<typeof vi.fn>;

async function setup(overrides: Partial<React.ComponentProps<typeof QiMoviPanel>> = {}) {
  const props = { draft, dirty: false, links: [], onChanged: vi.fn(async () => {}), development, developmentDirty: false, ...overrides };
  const view = render(<QiMoviPanel {...props} />);
  await act(async () => {});
  return { ...view, props };
}
const click = (name: string | RegExp) => fireEvent.click(screen.getByRole('button', { name }));
const callsTo = (path: string) => fetchMock.mock.calls.filter(([url]) => url === path);
const worldButton = () => screen.getByRole('button', { name: /^Send world/ });

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(localApi.qimovi.previewUniverse).mockReset().mockResolvedValue(universePreview);
  vi.mocked(localApi.qimovi.pushUniverse).mockReset().mockResolvedValue(universeTransfer);
  status = disconnected;
  installed = { available: true, origin: connected.origin!, directory: '/fixture/qimovi-project', project: { id: remoteProject.id, title: remoteProject.title } };
  // Exercise the real API adapter, but every endpoint is an in-memory fixture.
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    expect(init?.credentials).toBe('same-origin');
    if (url === '/api/connectors/qimovi') return response(status);
    if (url === '/api/connectors/qimovi/installed' && !init?.method) return response(installed);
    if (url === '/api/connectors/qimovi/installed' && init?.method === 'POST') return response({ ...connected, connected: false });
    if (url === '/api/connectors/qimovi/connect' && init?.method === 'POST') return response(connected);
    if (url === '/api/connectors/qimovi/world' && init?.method === 'POST') return response(transfer);
    throw new Error(`Unexpected QiMovi test request: ${init?.method ?? 'GET'} ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
});

describe('QiMovi Universe review and apply', () => {
  beforeEach(() => { status = connected; });
  const previewButton = () => screen.getByRole('button', { name: 'Preview Universe transfer' });
  const applyButton = () => screen.getByRole('button', { name: 'Apply reviewed transfer' });

  it('reviews the target, counts, entry actions, reasons and notes without applying anything', async () => {
    await setup();
    expect(screen.queryByRole('region', { name: 'Universe transfer preview' })).not.toBeInTheDocument();
    expect(localApi.qimovi.previewUniverse).not.toHaveBeenCalled();
    await act(async () => fireEvent.click(previewButton()));
    expect(localApi.qimovi.previewUniverse).toHaveBeenCalledExactlyOnceWith(draftId);
    const review = within(screen.getByRole('region', { name: 'Universe transfer preview' }));
    expect(review.getByText(remoteProject.title)).toBeVisible();
    expect(review.getByText('Development v3 · draft entries')).toBeVisible();
    for (const label of ['Create', 'Update', 'Unchanged', 'Conflicts']) {
      expect(within(review.getByLabelText('Preview changes')).getByText(label)).toBeVisible();
    }
    const entries = within(review.getByRole('list', { name: 'Entries to review' })).getAllByRole('listitem');
    expect(entries).toHaveLength(3);
    expect(entries[0]).toHaveTextContent('ArchiveCreateElement');
    expect(entries[1]).toHaveTextContent('Archive detailsUpdateDetailsNew saved world details.');
    expect(entries[2]).toHaveTextContent('Archive connectionUnchangedConnection');
    expect(review.getByRole('list', { name: 'Transfer notes' })).toHaveTextContent(universePreview.notes[0]);
    expect(screen.getByText(/Canon and source approval remain in QiMovi/)).toBeVisible();
    expect(applyButton()).toBeEnabled();
    expect(localApi.qimovi.pushUniverse).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
    expect(worldButton()).toBeEnabled();
  });

  it.each([
    { dirty: true }, { developmentDirty: true },
    { development: null },
    { development: { ...development, data: createDevelopment(projectId, draftId) } },
    { development: { ...development, data: { ...development.data, draftId: 'screenplay-draft:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' } } },
  ])('requires a matching saved world and clean screenplay/development: %o', async overrides => {
    await setup(overrides);
    expect(previewButton()).toBeDisabled();
    fireEvent.click(previewButton());
    expect(localApi.qimovi.previewUniverse).not.toHaveBeenCalled();
    expect(localApi.qimovi.pushUniverse).not.toHaveBeenCalled();
  });

  it('sends only the saved draft ID and reviewed token after explicit apply, then shows the saved receipt', async () => {
    const view = await setup();
    await act(async () => fireEvent.click(previewButton()));
    await act(async () => fireEvent.click(applyButton()));
    expect(localApi.qimovi.pushUniverse).toHaveBeenCalledExactlyOnceWith(draftId, universePreview.token);
    expect(screen.queryByRole('region', { name: 'Universe transfer preview' })).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Saved in Destination project · development v3.');
    expect(screen.getByRole('status')).toHaveTextContent('1 created · 1 updated · 1 unchanged.');
    expect(screen.getByText('Saved draft entries (1)')).toBeVisible();
    expect(toast.success).toHaveBeenCalledExactlyOnceWith('World draft entries saved in QiMovi Universe.');
    expect(view.props.onChanged).not.toHaveBeenCalled();
  });

  it('reports an unchanged transfer as already matching without claiming newly saved entries', async () => {
    vi.mocked(localApi.qimovi.pushUniverse).mockResolvedValueOnce({ ...universeTransfer, changed: false, counts: { create: 0, update: 0, unchanged: 3, conflicts: 0 } });
    await setup();
    await act(async () => fireEvent.click(previewButton()));
    await act(async () => fireEvent.click(applyButton()));
    expect(screen.getByRole('status')).toHaveTextContent('Already matches Destination project');
    expect(screen.getByRole('status')).toHaveTextContent('0 created · 0 updated · 3 unchanged.');
    expect(toast.success).toHaveBeenCalledExactlyOnceWith('QiMovi Universe already matches this world.');
  });

  it('shows authored claim records as notes and explains entries being set aside before applying', async () => {
    vi.mocked(localApi.qimovi.previewUniverse).mockResolvedValueOnce({
      ...universePreview, counts: { create: 1, update: 1, unchanged: 0, conflicts: 0 },
      items: [
        { id: 'universe-claim:archive-continuity', kind: 'universe-claim', label: 'Archive · Continuity notes', action: 'create' },
        { id: 'universe-entity:old-location', kind: 'universe-entity', label: 'Set aside: Old location', action: 'update', reason: 'Removed from this writer world; retained in QiMovi as Set aside.' },
      ],
      notes: [
        'Story function, sensory details and continuity are retained as attributed notes.',
        'Faction becomes Group. Props, timeline notes and relationship entries become References.',
        'Scene and character-cue connections remain notes until mapped to QiMovi source identities.',
      ],
    });
    await setup();
    await act(async () => fireEvent.click(previewButton()));
    const review = within(screen.getByRole('region', { name: 'Universe transfer preview' }));
    const entries = within(review.getByRole('list', { name: 'Entries to review' })).getAllByRole('listitem');
    expect(within(entries[0]).getByText('Notes', { exact: true })).toBeVisible();
    expect(entries[1]).toHaveTextContent('Set aside: Old locationUpdateElement');
    expect(entries[1]).toHaveTextContent('Removed from this writer world; retained in QiMovi as Set aside.');
    expect(review.getByRole('list', { name: 'Transfer notes' })).toHaveTextContent('Story function, sensory details and continuity');
    expect(review.getByRole('list', { name: 'Transfer notes' })).toHaveTextContent('Scene and character-cue connections remain notes');
    expect(localApi.qimovi.pushUniverse).not.toHaveBeenCalled();
  });

  it.each([true, false])('blocks conflicting entries even if the conflict count is inconsistent: count=%s', async counted => {
    vi.mocked(localApi.qimovi.previewUniverse).mockResolvedValueOnce({
      ...universePreview, counts: { ...universePreview.counts, conflicts: counted ? 1 : 0 },
      items: [{ ...universePreview.items[0], action: 'conflict', reason: 'This entry was edited in QiMovi.' }],
    });
    await setup();
    await act(async () => fireEvent.click(previewButton()));
    expect(screen.getByText('This entry was edited in QiMovi.')).toBeVisible();
    expect(screen.getByText('Resolve the conflicts in QiMovi, then preview again before applying.')).toBeVisible();
    expect(applyButton()).toBeDisabled();
    fireEvent.click(applyButton());
    expect(localApi.qimovi.pushUniverse).not.toHaveBeenCalled();
  });

  it.each([
    { ...universePreview, items: [], counts: { create: 0, update: 0, unchanged: 0, conflicts: 0 } },
    { ...universePreview, token: '' },
    { ...universePreview, counts: { ...universePreview.counts, conflicts: 1 } },
  ])('does not allow an empty, unreviewable or conflicting preview to apply', async result => {
    vi.mocked(localApi.qimovi.previewUniverse).mockResolvedValueOnce(result);
    await setup();
    await act(async () => fireEvent.click(previewButton()));
    expect(applyButton()).toBeDisabled();
    fireEvent.click(applyButton());
    expect(localApi.qimovi.pushUniverse).not.toHaveBeenCalled();
  });

  it.each([
    { dirty: true }, { developmentDirty: true },
    { development: { ...development, version: 4, sha256: 'f'.repeat(64) } },
    { draft: { ...draft, version: 3, sha256: 'f'.repeat(64) } },
    { draft: { ...draft, id: 'screenplay-draft:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' } },
  ])('discards the reviewed token when its local context changes: %o', async overrides => {
    const view = await setup();
    await act(async () => fireEvent.click(previewButton()));
    expect(applyButton()).toBeEnabled();
    view.rerender(<QiMoviPanel {...view.props} {...overrides} />);
    expect(screen.queryByRole('region', { name: 'Universe transfer preview' })).not.toBeInTheDocument();
    view.rerender(<QiMoviPanel {...view.props} />);
    expect(screen.queryByRole('button', { name: 'Apply reviewed transfer' })).not.toBeInTheDocument();
    expect(localApi.qimovi.pushUniverse).not.toHaveBeenCalled();
  });

  it.each(['Refresh', 'Change', 'Forget', 'Send world v3 to QiMovi', 'Dismiss'])('discards the reviewed token on %s', async action => {
    const view = await setup();
    await act(async () => fireEvent.click(previewButton()));
    if (action === 'Forget') fetchMock.mockResolvedValueOnce(response(disconnected));
    await act(async () => click(action));
    expect(screen.queryByRole('region', { name: 'Universe transfer preview' })).not.toBeInTheDocument();
    if (action === 'Change') {
      await act(async () => click('Cancel change'));
      expect(screen.queryByRole('button', { name: 'Apply reviewed transfer' })).not.toBeInTheDocument();
    }
    expect(localApi.qimovi.pushUniverse).not.toHaveBeenCalled();
    view.unmount();
  });

  it('clears the previous preview immediately when a replacement request fails', async () => {
    await setup();
    await act(async () => fireEvent.click(previewButton()));
    const pending = deferred<typeof universePreview>();
    vi.mocked(localApi.qimovi.previewUniverse).mockReturnValueOnce(pending.promise);
    fireEvent.click(previewButton());
    expect(screen.queryByRole('button', { name: 'Apply reviewed transfer' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Preparing preview…' })).toBeDisabled();
    await act(async () => pending.reject(new Error('QiMovi is unavailable.')));
    expect(screen.getByRole('alert')).toHaveTextContent('QiMovi is unavailable.');
    expect(screen.getByRole('alert')).toHaveTextContent('No transfer was applied.');
    expect(screen.queryByRole('region', { name: 'Universe transfer preview' })).not.toBeInTheDocument();
    expect(localApi.qimovi.pushUniverse).not.toHaveBeenCalled();
  });

  it.each([
    'Connection closed after one entry was saved.',
    'The saved development changed after preview. Preview again.',
  ])('requires a fresh preview after an unconfirmed apply before retrying: %s', async failure => {
    await setup();
    await act(async () => fireEvent.click(previewButton()));
    vi.mocked(localApi.qimovi.pushUniverse).mockRejectedValueOnce(new Error(failure));
    await act(async () => fireEvent.click(applyButton()));
    expect(screen.getByRole('alert')).toHaveTextContent(failure);
    expect(screen.getByRole('alert')).toHaveTextContent('Preview again to check any entries already saved in QiMovi.');
    expect(screen.queryByRole('button', { name: 'Apply reviewed transfer' })).not.toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(toast.success).not.toHaveBeenCalled();
    vi.mocked(localApi.qimovi.previewUniverse).mockResolvedValueOnce({ ...universePreview, token: 'fresh-reviewed-token' });
    await act(async () => fireEvent.click(previewButton()));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    await act(async () => fireEvent.click(applyButton()));
    expect(localApi.qimovi.pushUniverse).toHaveBeenNthCalledWith(2, draftId, 'fresh-reviewed-token');
    expect(screen.getByRole('status')).toHaveTextContent('Saved in Destination project');
  });

  it('does not restore a delayed preview after changing drafts and switching back', async () => {
    const pending = deferred<typeof universePreview>();
    vi.mocked(localApi.qimovi.previewUniverse).mockReturnValueOnce(pending.promise);
    const view = await setup();
    fireEvent.click(previewButton());
    view.rerender(<QiMoviPanel {...view.props} draft={{ ...draft, id: 'screenplay-draft:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }} />);
    view.rerender(<QiMoviPanel {...view.props} />);
    await act(async () => pending.resolve(universePreview));
    expect(screen.queryByRole('region', { name: 'Universe transfer preview' })).not.toBeInTheDocument();
    expect(previewButton()).toBeEnabled();
    expect(localApi.qimovi.pushUniverse).not.toHaveBeenCalled();
  });

  it('does not restore a preview after development is edited and reset while the request is pending', async () => {
    const pending = deferred<typeof universePreview>();
    vi.mocked(localApi.qimovi.previewUniverse).mockReturnValueOnce(pending.promise);
    const view = await setup();
    fireEvent.click(previewButton());
    view.rerender(<QiMoviPanel {...view.props} developmentDirty />);
    view.rerender(<QiMoviPanel {...view.props} />);
    await act(async () => pending.resolve(universePreview));
    expect(screen.queryByRole('region', { name: 'Universe transfer preview' })).not.toBeInTheDocument();
    expect(previewButton()).toBeEnabled();
    expect(localApi.qimovi.pushUniverse).not.toHaveBeenCalled();
  });

  it('suppresses a delayed apply receipt when the screenplay changes during the request', async () => {
    const pending = deferred<typeof universeTransfer>();
    vi.mocked(localApi.qimovi.pushUniverse).mockReturnValueOnce(pending.promise);
    const view = await setup();
    await act(async () => fireEvent.click(previewButton()));
    fireEvent.click(applyButton());
    expect(screen.queryByRole('button', { name: 'Apply reviewed transfer' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Change' })).toBeDisabled();
    view.rerender(<QiMoviPanel {...view.props} dirty />);
    await act(async () => pending.resolve(universeTransfer));
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(toast.success).not.toHaveBeenCalled();
    expect(localApi.qimovi.pushUniverse).toHaveBeenCalledTimes(1);
  });

  it('removes a previous successful receipt before another attempt fails', async () => {
    await setup();
    await act(async () => fireEvent.click(previewButton()));
    await act(async () => fireEvent.click(applyButton()));
    expect(screen.getByRole('status')).toBeVisible();
    vi.mocked(toast.success).mockClear();
    vi.mocked(localApi.qimovi.previewUniverse).mockRejectedValueOnce(new Error('The selected project changed.'));
    await act(async () => fireEvent.click(previewButton()));
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('The selected project changed.');
    expect(toast.success).not.toHaveBeenCalled();
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('QiMovi installed setup and world transfer', () => {
  it('defaults to finding an open project and connects using only its project ID, without requiring token entry', async () => {
    await setup();
    expect(screen.getByRole('button', { name: 'Find open QiMovi project' })).toBeEnabled();
    expect(screen.queryByRole('textbox', { name: 'QiMovi origin' })).not.toBeInTheDocument();
    // Password fields have no implicit textbox role; check actual visibility.
    expect(screen.getByLabelText('QiMovi owner token')).not.toBeVisible();
    expect(callsTo('/api/connectors/qimovi/installed')).toHaveLength(0);
    await act(async () => click('Find open QiMovi project'));
    expect(screen.getByText(remoteProject.title)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Connect this project' })).toBeEnabled();
    expect(callsTo('/api/connectors/qimovi/connect')).toHaveLength(0);
    await act(async () => click('Connect this project'));
    expect(screen.getByText('connected', { exact: true })).toBeVisible();
    const installedCalls = callsTo('/api/connectors/qimovi/installed');
    expect(installedCalls).toHaveLength(2);
    expect(installedCalls[0][1]?.method).toBeUndefined();
    expect(installedCalls[1][1]).toMatchObject({ method: 'POST', body: JSON.stringify({ projectId: remoteProject.id }) });
    expect(callsTo('/api/connectors/qimovi/connect')).toHaveLength(1);
    expect(callsTo('/api/connectors/qimovi/connect')[0][1]).toMatchObject({ method: 'POST', body: '{}' });
    expect(callsTo('/api/connectors/qimovi/config')).toHaveLength(0);
    expect(fetchMock.mock.calls.every(([, init]) => !String(init?.body).includes('ownerToken'))).toBe(true);
    expect(toast.success).toHaveBeenCalledExactlyOnceWith('QiMovi connected on this Mac.');
  });

  it('keeps a discovered project that is not running unavailable for connection', async () => {
    installed = { ...installed, available: false, reason: 'QIMOVI_NOT_RUNNING' };
    await setup();
    await act(async () => click('Find open QiMovi project'));
    expect(screen.getByRole('status')).toHaveTextContent('Open this project in QiMovi, then find it again.');
    expect(screen.getByRole('button', { name: 'Connect this project' })).toBeDisabled();
    click('Connect this project');
    expect(callsTo('/api/connectors/qimovi/installed')).toHaveLength(1);
    expect(callsTo('/api/connectors/qimovi/connect')).toHaveLength(0);
  });

  it('does not connect or claim success when installed-project configuration fails', async () => {
    await setup();
    await act(async () => click('Find open QiMovi project'));
    fetchMock.mockResolvedValueOnce(response({ error: 'DESTINATION_CHANGED', detail: 'The selected project changed.' }, 409));
    await act(async () => click('Connect this project'));
    expect(toast.error).toHaveBeenCalledExactlyOnceWith('The selected project changed.');
    expect(toast.success).not.toHaveBeenCalled();
    expect(callsTo('/api/connectors/qimovi/connect')).toHaveLength(0);
    expect(screen.getByRole('button', { name: 'Connect this project' })).toBeEnabled();
  });

  it.each([
    { dirty: false, developmentDirty: true },
    { dirty: true, developmentDirty: false },
    { dirty: true, developmentDirty: true },
  ])('blocks world transfer with dirty state $dirty / $developmentDirty until both are saved', async flags => {
    status = connected;
    const view = await setup(flags);
    expect(worldButton()).toBeDisabled();
    expect(screen.getByText('Save screenplay and development changes before sending.')).toBeVisible();
    fireEvent.click(worldButton());
    expect(callsTo('/api/connectors/qimovi/world')).toHaveLength(0);
    view.rerender(<QiMoviPanel {...view.props} dirty={false} developmentDirty={false} />);
    expect(worldButton()).toBeEnabled();
    expect(callsTo('/api/connectors/qimovi/world')).toHaveLength(0);
  });

  it('sends only the selected saved draft identity and displays the returned verified files', async () => {
    status = connected;
    const view = await setup();
    expect(screen.queryByText(/Files verified:/)).not.toBeInTheDocument();
    await act(async () => fireEvent.click(worldButton()));
    expect(callsTo('/api/connectors/qimovi/world')).toHaveLength(1);
    expect(callsTo('/api/connectors/qimovi/world')[0][1]).toMatchObject({ method: 'POST', body: JSON.stringify({ draftId }) });
    expect(screen.getByRole('status')).toHaveTextContent('Sent development v3. Files verified:');
    expect(screen.getByRole('status')).toHaveTextContent('world.json · cccccccccccc');
    expect(screen.getByRole('status')).toHaveTextContent('world.md · dddddddddddd');
    expect(toast.success).toHaveBeenCalledExactlyOnceWith('World files verified in QiMovi’s project library.');
    expect(view.props.onChanged).not.toHaveBeenCalled();
  });

  it('shows no verified receipt or success message when pushWorld fails', async () => {
    status = connected;
    await setup();
    fetchMock.mockResolvedValueOnce(response({ error: 'WORLD_VERIFICATION_FAILED', detail: 'The transferred file could not be verified.' }, 502));
    await act(async () => fireEvent.click(worldButton()));
    expect(toast.error).toHaveBeenCalledExactlyOnceWith('The transferred file could not be verified.');
    expect(toast.success).not.toHaveBeenCalled();
    expect(screen.queryByText(/Files verified:/)).not.toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(worldButton()).toBeEnabled();
  });

  it('does not leave an earlier verified receipt visible after sending a newer development revision fails', async () => {
    status = connected;
    const view = await setup();
    await act(async () => fireEvent.click(worldButton()));
    expect(screen.getByRole('status')).toHaveTextContent('Sent development v3. Files verified:');
    vi.mocked(toast.success).mockClear();
    view.rerender(<QiMoviPanel {...view.props} development={{ ...development, version: 4, sha256: 'e'.repeat(64) }} />);
    fetchMock.mockResolvedValueOnce(response({ error: 'WORLD_VERIFICATION_FAILED', detail: 'The newer transfer could not be verified.' }, 502));
    click('Send world v4 to QiMovi');
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('The newer transfer could not be verified.'));
    expect(toast.success).not.toHaveBeenCalled();
    expect(screen.queryByText(/Files verified:/)).not.toBeInTheDocument();
    expect(worldButton()).toBeEnabled();
  });
});

describe('local connection recovery and incoming revisions', () => {
  it('keeps a failed check visible and provides a bounded retry action', async () => {
    fetchMock.mockRejectedValueOnce(new Error('Service unavailable'));
    await setup();
    expect(screen.getByRole('alert')).toHaveTextContent('The local writer service is not answering');
    click('Retry connection status');
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
    expect(callsTo('/api/connectors/qimovi')).toHaveLength(2);
  });

  it.each([{ dirty: true }, { developmentDirty: true }])('prevents incoming revisions while authored edits are unsaved: %o', async (pending) => {
    status = { ...connected, drafts: [{ id: draftId, version: 3, sha256: 'f'.repeat(64), title: 'Remote edit', bodyLength: 42 }] } as QiMoviSummary;
    await setup(pending);
    expect(screen.getByRole('button', { name: 'Pull' })).toBeDisabled();
    expect(screen.getByText('Save your screenplay and development edits before pulling revisions from QiMovi.')).toBeInTheDocument();
    click('Pull');
    expect(callsTo('/api/connectors/qimovi/pull')).toHaveLength(0);
  });

  it('bounds a stalled connection request instead of leaving controls busy forever', async () => {
    vi.useFakeTimers();
    try {
      fetchMock.mockImplementationOnce((_url, init) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('Aborted')), { once: true });
      }));
      const result = localApi.qimovi.status().catch(error => error);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(await result).toMatchObject({ code: 'CONNECTION_TIMEOUT' });
    } finally { vi.useRealTimers(); }
  });
});


describe('Native QiMovi folder access', () => {
  it('keeps the connection unchanged when the folder chooser is cancelled', async () => {
    const postMessage = vi.fn().mockResolvedValue(false);
    vi.stubGlobal('webkit', { messageHandlers: { writerSession: { postMessage } } });
    await setup();
    await act(async () => click('Allow project folder access'));
    expect(postMessage).toHaveBeenCalledExactlyOnceWith({ action: 'authorize-qimovi' });
    expect(callsTo('/api/connectors/qimovi/installed')).toHaveLength(0);
    expect(callsTo('/api/connectors/qimovi/connect')).toHaveLength(0);
    expect(toast.success).not.toHaveBeenCalled();
  });
  it('rediscovers after access and reconnects only the already configured project', async () => {
    status = { ...connected, connected: false };
    const postMessage = vi.fn().mockResolvedValue(true);
    vi.stubGlobal('webkit', { messageHandlers: { writerSession: { postMessage } } });
    await setup();
    await act(async () => click('Allow project folder access'));
    expect(callsTo('/api/connectors/qimovi/installed')).toHaveLength(1);
    expect(callsTo('/api/connectors/qimovi/connect')).toHaveLength(1);
    expect(callsTo('/api/connectors/qimovi/config')).toHaveLength(0);
    expect(screen.getByText('connected', { exact: true })).toBeVisible();
  });
  it('requires project selection for a new connection after granting access', async () => {
    vi.stubGlobal('webkit', { messageHandlers: { writerSession: { postMessage: vi.fn().mockResolvedValue(true) } } });
    await setup();
    await act(async () => click('Allow project folder access'));
    expect(screen.getByRole('button', { name: 'Connect this project' })).toBeEnabled();
    expect(callsTo('/api/connectors/qimovi/connect')).toHaveLength(0);
  });
  it('shows native access rejection without retrying or configuring the bridge', async () => {
    vi.stubGlobal('webkit', { messageHandlers: { writerSession: { postMessage: vi.fn().mockRejectedValue(new Error('Choose the project currently open in QiMovi.')) } } });
    await setup();
    await act(async () => click('Allow project folder access'));
    expect(screen.getByRole('alert')).toHaveTextContent('Choose the project currently open in QiMovi.');
    expect(callsTo('/api/connectors/qimovi/installed')).toHaveLength(0);
    expect(callsTo('/api/connectors/qimovi/connect')).toHaveLength(0);
  });
});
