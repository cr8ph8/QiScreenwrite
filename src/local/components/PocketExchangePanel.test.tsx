import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { PocketExchangePanel } from './PocketExchangePanel';
import { localApi } from '../api';
import type { PocketPreview, PocketImportResult } from '../pocket-exchange';
import type { DraftRecord } from '../types';

vi.mock('../api', () => ({ localApi: { pocket: { preview: vi.fn(), import: vi.fn(), prepare: vi.fn(), returnLinked: vi.fn(), linkedUrl: (id: string) => `/api/pocket-exchange/linked?exchangeId=${id}`, exportUrl: (id: string) => `/api/pocket-exchange/export?draftId=${encodeURIComponent(id)}` } } }));
const sourceId = '11111111-1111-4111-a111-111111111111';
const preview: PocketPreview = { contentSha256: 'a'.repeat(64), snapshot: {
  id: sourceId, title: 'Harbor', body: 'INT. HARBOR - DAY\r\n\r\n海 🎬', genre: 'Drama', logline: 'A return', projectFormat: 'short',
  development: { concept: 'Concept', logline: 'Development logline', synopsis: 'Synopsis', outline: 'Outline', beats: [], characters: [], researchNotes: [], worldNotes: 'Notes', world: { schemaVersion: 1, elements: [], links: [] } },
} };
const draft: DraftRecord = { id: `screenplay-draft:${sourceId}`, kind: 'screenplay-draft', version: 3, sha256: 'b'.repeat(64), data: {
  schemaVersion: 2, projectId: 'local-writer:test', sourceHash: null, status: 'DRAFT', title: 'Saved desktop screenplay', format: 'FOUNTAIN', body: 'Saved body',
} };
const result: PocketImportResult = { contentSha256: preview.contentSha256, replayed: false,
  draft: { ...draft, id: 'screenplay-draft:22222222-2222-5222-a222-222222222222', version: 1 },
  development: { id: 'story-development:22222222-2222-5222-a222-222222222222', kind: 'story-development', version: 1, sha256: 'c'.repeat(64), data: { ...preview.snapshot.development, schemaVersion: 2, projectId: draft.data.projectId, draftId: 'screenplay-draft:22222222-2222-5222-a222-222222222222' } },
};
const changed = vi.fn(), open = vi.fn();
beforeEach(() => { vi.clearAllMocks(); changed.mockResolvedValue(undefined); vi.mocked(localApi.pocket.preview).mockResolvedValue(preview); vi.mocked(localApi.pocket.import).mockResolvedValue(result); });
afterEach(cleanup);
const mount = (drafts = [draft]) => render(<PocketExchangePanel drafts={drafts} onChanged={changed} onOpenDraft={open} />);
function file(text = '{"exact":"selected bytes"}', size?: number) {
  const value = new File([text], 'phone.qiscript', { type: 'application/json' });
  Object.defineProperty(value, 'arrayBuffer', { value: vi.fn(async () => new TextEncoder().encode(text).buffer) });
  if (size !== undefined) Object.defineProperty(value, 'size', { value: size });
  return value;
}
function choose(value = file()) { fireEvent.change(screen.getByLabelText('Choose snapshot to preview (up to 8 MiB)'), { target: { files: [value] } }); }
const importButton = () => screen.getByRole('button', { name: 'Import: create independent copy' });

it('discloses snapshot scope and uses a selected saved draft with a same-origin native download link', () => {
  mount();
  expect(screen.getByText(/unsaved edits, revision history/)).toHaveTextContent('worldSources');
  expect(screen.getByText(/does not establish authorship/)).toBeVisible();
  expect(screen.queryByRole('link', { name: 'Download selected snapshot' })).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('Saved screenplay'), { target: { value: draft.id } });
  const link = screen.getByRole('link', { name: 'Download selected snapshot' });
  expect(link).toHaveAttribute('href', '/api/pocket-exchange/export?draftId=' + encodeURIComponent(draft.id));
  expect(link).toHaveAttribute('download', 'screenplay-snapshot.qiscript');
  expect(localApi.pocket.preview).not.toHaveBeenCalled(); expect(localApi.pocket.import).not.toHaveBeenCalled();
});

it('previews selected file without writing, then imports only on explicit action and opens the fresh copy', async () => {
  mount(); choose(); await screen.findByRole('heading', { name: 'Harbor' });
  expect(localApi.pocket.preview).toHaveBeenCalledWith('{"exact":"selected bytes"}');
  expect(localApi.pocket.import).not.toHaveBeenCalled(); expect(changed).not.toHaveBeenCalled();
  expect(screen.getByText(/Page target unknown/)).toBeVisible();
  fireEvent.click(importButton());
  await screen.findByText('Independent working copy saved with its development and world.');
  expect(localApi.pocket.import).toHaveBeenCalledWith('{"exact":"selected bytes"}', preview.contentSha256);
  expect(changed).toHaveBeenCalledOnce(); expect(importButton()).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Open working copy' })); expect(open).toHaveBeenCalledWith(result.draft.id);
});

it('invalid selection clears a previous preview and disables import; oversized input is not read or sent', async () => {
  mount(); choose(); await screen.findByRole('heading', { name: 'Harbor' });
  vi.mocked(localApi.pocket.preview).mockRejectedValueOnce(new Error('Package checksum mismatch'));
  choose(file('{"corrupt":true}'));
  expect(await screen.findByRole('alert')).toHaveTextContent('Package checksum mismatch');
  expect(screen.queryByRole('button', { name: /Import: create/ })).not.toBeInTheDocument();
  const large = file('{}', 8 * 1024 * 1024 + 1); choose(large);
  expect(await screen.findByRole('alert')).toHaveTextContent('8 MiB');
  expect(large.arrayBuffer).not.toHaveBeenCalled(); expect(localApi.pocket.preview).toHaveBeenCalledTimes(2);
  expect(localApi.pocket.import).not.toHaveBeenCalled();
});

it('ignores stale previews after a different file is selected', async () => {
  mount(); let resolve!: (value: PocketPreview) => void;
  vi.mocked(localApi.pocket.preview).mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  choose(file('first')); await waitFor(() => expect(localApi.pocket.preview).toHaveBeenCalledOnce());
  vi.mocked(localApi.pocket.preview).mockResolvedValueOnce({ ...preview, contentSha256: 'd'.repeat(64), snapshot: { ...preview.snapshot, title: 'Second' } });
  choose(file('second')); await screen.findByRole('heading', { name: 'Second' });
  await act(async () => resolve(preview));
  expect(screen.queryByRole('heading', { name: 'Harbor' })).not.toBeInTheDocument();
  fireEvent.click(importButton());
  await waitFor(() => expect(localApi.pocket.import).toHaveBeenCalledWith('second', 'd'.repeat(64)));
});

it('uncertain import can retry the identical file and explains that later edits are preserved', async () => {
  mount(); choose(); await screen.findByRole('heading', { name: 'Harbor' });
  vi.mocked(localApi.pocket.import).mockRejectedValueOnce(new Error('Local service unavailable; retry safely'));
  fireEvent.click(importButton()); expect(await screen.findByRole('alert')).toHaveTextContent('retry safely');
  expect(importButton()).not.toBeDisabled();
  vi.mocked(localApi.pocket.import).mockResolvedValueOnce({ ...result, replayed: true, draft: { ...result.draft, version: 2 } });
  fireEvent.click(importButton()); await screen.findByText('This snapshot was already imported. Your later edits are preserved.');
  expect(vi.mocked(localApi.pocket.import).mock.calls[0]).toEqual(vi.mocked(localApi.pocket.import).mock.calls[1]);
});

it('leaving during preview or import never triggers a later UI callback', async () => {
  const view = mount(); choose(); await screen.findByRole('heading', { name: 'Harbor' });
  let resolve!: (value: PocketImportResult) => void;
  vi.mocked(localApi.pocket.import).mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  fireEvent.click(importButton()); await waitFor(() => expect(localApi.pocket.import).toHaveBeenCalledOnce());
  view.unmount(); await act(async () => resolve(result));
  expect(changed).not.toHaveBeenCalled(); expect(open).not.toHaveBeenCalled();
});

it('has no export without saved drafts but still allows a file preview', async () => {
  mount([]); expect(screen.getByText('Save a draft to enable export.')).toBeVisible();
  choose(); await screen.findByRole('heading', { name: 'Harbor' }); expect(importButton()).not.toBeDisabled();
});


it('prepares a linked trip only on request and exposes a native download without changing the saved draft', async () => {
  vi.mocked(localApi.pocket.prepare).mockResolvedValueOnce({ exchangeId: sourceId, contentSha256: 'd'.repeat(64) });
  mount(); fireEvent.change(screen.getByLabelText('Saved screenplay'), { target: { value: draft.id } });
  expect(localApi.pocket.prepare).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Prepare linked phone trip' }));
  const link = await screen.findByRole('link', { name: 'Download linked phone trip' });
  expect(localApi.pocket.prepare).toHaveBeenCalledWith(draft.id);
  expect(link).toHaveAttribute('href', '/api/pocket-exchange/linked?exchangeId=' + sourceId);
  expect(link).toHaveAttribute('download', 'screenplay-linked-trip.qiscript');
  expect(changed).not.toHaveBeenCalled();
});

const linkedPreview = (status: 'ready' | 'conflict'): PocketPreview => ({ ...preview,
  continuation: { exchangeId: sourceId, projectId: draft.data.projectId, draft: { id: draft.id, version: draft.version, sha256: draft.sha256 },
    development: { id: draft.id.replace('screenplay-draft:', 'story-development:'), version: 4, sha256: 'c'.repeat(64) } },
  returnReview: { status, message: status === 'ready' ? 'Both saved bases match.' : 'Mac writing changed. Preserve both copies.',
    ...(status === 'ready' ? { baseSnapshot: preview.snapshot, changedDraftFields: ['body'], changedDevelopmentFields: ['world'] } : {}) },
});
it('requires explicit reviewed linked return and displays retained identity outcome', async () => {
  vi.mocked(localApi.pocket.preview).mockResolvedValueOnce(linkedPreview('ready'));
  vi.mocked(localApi.pocket.returnLinked).mockResolvedValueOnce({ ...result, mode: 'continuation', draft });
  mount(); choose(); await screen.findByText('Both saved bases match.');
  expect(localApi.pocket.returnLinked).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Apply reviewed return to linked draft' }));
  await screen.findByText('Linked Mac draft updated with its development and world. Previous revisions and shared-world connections remain.');
  expect(localApi.pocket.returnLinked).toHaveBeenCalledWith('{"exact":"selected bytes"}', preview.contentSha256);
  expect(localApi.pocket.import).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Open working copy' })); expect(open).toHaveBeenCalledWith(draft.id);
});
it('conflicting linked returns cannot apply and retain the explicit independent-copy option', async () => {
  vi.mocked(localApi.pocket.preview).mockResolvedValueOnce(linkedPreview('conflict'));
  mount(); choose(); await screen.findByText('Mac writing changed. Preserve both copies.');
  expect(screen.getByRole('button', { name: 'Apply reviewed return to linked draft' })).toBeDisabled();
  expect(importButton()).not.toBeDisabled();
  expect(localApi.pocket.returnLinked).not.toHaveBeenCalled();
});
