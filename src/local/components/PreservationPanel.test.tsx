import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { PreservationPanel } from './PreservationPanel';
import { localApi } from '../api';
import { downloadText } from '../model';
import type { PreservationPreview, PreservationVerification } from '../preservation';

vi.mock('../api', () => ({ localApi: { preservation: { preview: vi.fn(), export: vi.fn(), verify: vi.fn() } } }));
vi.mock('../model', () => ({ downloadText: vi.fn() }));
const snapshot: PreservationPreview = { schema: 'caniscreenwrite-preservation-preview/v1', project: { id: 'project:test', title: 'My screenplays' }, sourceSha256: 'a'.repeat(64), inventory: [{ id: 'screenplay-draft:one', kind: 'screenplay-draft', version: 2, sha256: 'b'.repeat(64), title: 'The Harbor' }], revisionCount: 2, recoveryCounts: { screenplay: 1, development: 0 }, exclusions: ['Unsaved recovery', 'Remote media'] };
const result: PreservationVerification = { valid: true, schema: 'caniscreenwrite-preservation-package/v1', project: snapshot.project, sourceSha256: snapshot.sourceSha256, packageSha256: 'c'.repeat(64), recordCount: 1, revisionCount: 2, exclusions: snapshot.exclusions, checks: { recordHashes: true, history: true, sourceBindings: true, packageHash: true }, limitations: ['No authorship claim'] };
const flush = vi.fn(), open = vi.fn(), connect = vi.fn(), back = vi.fn();
beforeEach(() => { vi.clearAllMocks(); flush.mockResolvedValue(undefined); vi.mocked(localApi.preservation.preview).mockResolvedValue(snapshot); vi.mocked(localApi.preservation.export).mockResolvedValue({ schema: result.schema }); vi.mocked(localApi.preservation.verify).mockResolvedValue(result); });
afterEach(cleanup);
const mount = () => render(<PreservationPanel beforeInspect={flush} onOpenDraft={open} onConnections={connect} onBack={back} />);
async function ready() { const view = mount(); await screen.findByRole('button', { name: 'The Harbor' }); return view; }
function choose(text: string, name = 'saved.json') { const file = new File([text], name, { type: 'application/json' }); Object.defineProperty(file, 'text', { value: async () => text }); fireEvent.change(screen.getByLabelText('Choose preservation package'), { target: { files: [file] } }); }

it('flushes recovery before inventory and shows saved records with an explicit exclusion', async () => {
  await ready(); expect(flush.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(localApi.preservation.preview).mock.invocationCallOrder[0]);
  expect(screen.getByText(/1 recovery copy is outside this package/)).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'The Harbor' })); expect(open).toHaveBeenCalledWith('screenplay-draft:one');
  fireEvent.click(screen.getByRole('button', { name: 'Open QiMovi connection' })); expect(connect).toHaveBeenCalledOnce();
});
it('exports only the reviewed snapshot and does not call download preparation verification', async () => {
  await ready(); fireEvent.click(screen.getByRole('button', { name: 'Export saved package' }));
  await waitFor(() => expect(downloadText).toHaveBeenCalledOnce());
  expect(localApi.preservation.export).toHaveBeenCalledWith(snapshot.sourceSha256);
  expect(localApi.preservation.verify).not.toHaveBeenCalled(); expect(screen.queryByText('FILE CONTENTS VERIFIED')).not.toBeInTheDocument();
  expect(screen.getByText(/Package prepared for download/)).toBeVisible();
});
it('does not export when flushing recovery fails', async () => {
  await ready(); flush.mockRejectedValueOnce(new Error('Recovery disk unavailable'));
  fireEvent.click(screen.getByRole('button', { name: 'Export saved package' })); expect(await screen.findByRole('alert')).toHaveTextContent('Recovery disk unavailable');
  expect(localApi.preservation.export).not.toHaveBeenCalled(); expect(downloadText).not.toHaveBeenCalled();
});
it('rejects a stale export and only uses a newer fingerprint after refreshing', async () => {
  await ready(); vi.mocked(localApi.preservation.export).mockRejectedValueOnce(new Error('Saved revisions changed. Refresh the inventory.'));
  fireEvent.click(screen.getByRole('button', { name: 'Export saved package' })); expect(await screen.findByRole('alert')).toHaveTextContent('Refresh'); expect(downloadText).not.toHaveBeenCalled();
  vi.mocked(localApi.preservation.preview).mockResolvedValueOnce({ ...snapshot, sourceSha256: 'd'.repeat(64), revisionCount: 3 });
  fireEvent.click(screen.getByRole('button', { name: 'Refresh inventory' })); await screen.findByText('1 records · 3 saved revisions');
  fireEvent.click(screen.getByRole('button', { name: 'Export saved package' })); await waitFor(() => expect(localApi.preservation.export).toHaveBeenLastCalledWith('d'.repeat(64)));
});
it('shows verification only for the selected file and clears it when a later file fails', async () => {
  await ready(); choose('{"saved":true}'); expect(await screen.findByText('FILE CONTENTS VERIFIED')).toBeVisible(); expect(localApi.preservation.verify).toHaveBeenCalledWith({ saved: true });
  expect(screen.getByText(/does not establish authorship/)).toBeVisible();
  vi.mocked(localApi.preservation.verify).mockRejectedValueOnce(new Error('Package checksum mismatch'));
  choose('{"corrupt":true}', 'changed.json'); expect(await screen.findByRole('alert')).toHaveTextContent('Package checksum mismatch'); expect(screen.queryByText('FILE CONTENTS VERIFIED')).not.toBeInTheDocument();
});
it('rejects malformed and oversized files before sending them to the verifier', async () => {
  await ready(); choose('not JSON'); expect(await screen.findByRole('alert')).toHaveTextContent('not a readable JSON');
  const file = new File(['{}'], 'large.json'); Object.defineProperty(file, 'size', { value: 128 * 1024 * 1024 + 1 });
  fireEvent.change(screen.getByLabelText('Choose preservation package'), { target: { files: [file] } });
  expect(await screen.findByRole('alert')).toHaveTextContent('128 MiB'); expect(localApi.preservation.verify).not.toHaveBeenCalled();
});
it('does not download an in-flight package after leaving the panel', async () => {
  const view = await ready(); let finish!: (value: unknown) => void;
  vi.mocked(localApi.preservation.export).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  fireEvent.click(screen.getByRole('button', { name: 'Export saved package' })); await waitFor(() => expect(localApi.preservation.export).toHaveBeenCalled()); view.unmount();
  await act(async () => finish({ schema: result.schema })); expect(downloadText).not.toHaveBeenCalled();
});
