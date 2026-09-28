import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { WorldReturnPanel } from './WorldReturnPanel';
import { worldReturnApi, type WorldReturnPreview } from '../world-return-api';

vi.mock('../world-return-api', () => ({ worldReturnApi: { preview: vi.fn(), apply: vi.fn() } }));
const reference = { id: 'development:fixture', version: 4, sha256: 'a'.repeat(64) };
const preview: WorldReturnPreview = {
  schemaVersion: 'caniscreenwrite-world-return-preview/v1', token: 'b'.repeat(64),
  project: { id: 'film', title: 'Fixture film' }, draft: { ...reference, id: 'draft' }, development: reference,
  counts: { unchanged: 2, localOnly: 1, remoteOnly: 1, bothChanged: 1, converged: 0, unsupported: 0 },
  items: [
    { id: 'one:description', elementId: 'one', elementName: 'Harbor', field: 'description', base: 'Original harbor', local: 'Original harbor', remote: 'Fog at the harbor', state: 'remote-only', selectable: true, remoteRecords: [] },
    { id: 'two:storyFunction', elementId: 'two', elementName: 'Ari', field: 'storyFunction', base: 'Find home', local: 'Find her friend', remote: 'Find the missing map', state: 'both-changed', selectable: true, remoteRecords: [] },
    { id: 'two:continuity', elementId: 'two', elementName: 'Ari', field: 'continuity', base: '', local: 'Local reminder', remote: '', state: 'local-only', selectable: false, remoteRecords: [] },
  ], notes: ['Character identities and world connections remain unchanged.'],
};
const props = () => ({ draftId: 'draft', context: 'version-4', enabled: true, onChanged: vi.fn(async () => {}), onBusy: vi.fn() });
beforeEach(() => { vi.clearAllMocks(); vi.mocked(worldReturnApi.preview).mockResolvedValue(preview); });
afterEach(cleanup);
const review = async () => { await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Review changes from QiMovi' }))); };

it('requires an explicit decision for each remote difference and sends only those choices', async () => {
  const p = props(); render(<WorldReturnPanel {...p} />);
  expect(worldReturnApi.preview).not.toHaveBeenCalled();
  await review();
  const save = screen.getByRole('button', { name: 'Save reviewed choices' });
  expect(save).toBeDisabled();
  expect(screen.getByText('Changed in both apps')).toBeInTheDocument();
  expect(screen.queryByText('Local reminder')).not.toBeInTheDocument();
  const harbor = screen.getByRole('group', { name: 'Harbor · Description' });
  const ari = screen.getByRole('group', { name: 'Ari · Story function' });
  fireEvent.click(within(harbor).getByLabelText('Use QiMovi text'));
  expect(save).toBeDisabled();
  fireEvent.click(within(ari).getByLabelText('Keep writer text'));
  expect(save).toBeEnabled();
  vi.mocked(worldReturnApi.apply).mockResolvedValue({ changed: true, applied: 1, kept: 1, replayed: false, development: { ...reference, version: 5 } as never });
  await act(async () => fireEvent.click(save));
  expect(worldReturnApi.apply).toHaveBeenCalledWith('draft', preview.token, [ { id: 'one:description', decision: 'use-qimovi' }, { id: 'two:storyFunction', decision: 'keep-local' } ]);
  expect(p.onChanged).toHaveBeenCalledOnce();
  expect(screen.getByRole('status')).toHaveTextContent('1 field(s) saved in development v5');
});

it('ignores a pending preview after the draft or connection changes', async () => {
  let resolve!: (v: WorldReturnPreview) => void;
  vi.mocked(worldReturnApi.preview).mockReturnValue(new Promise(r => { resolve = r; }));
  const p = props(), view = render(<WorldReturnPanel {...p} />);
  fireEvent.click(screen.getByRole('button', { name: 'Review changes from QiMovi' }));
  view.rerender(<WorldReturnPanel {...p} draftId="other" context="other-film" />);
  await act(async () => resolve(preview));
  expect(screen.queryByRole('region', { name: 'World changes review' })).not.toBeInTheDocument();
  expect(worldReturnApi.apply).not.toHaveBeenCalled();
});

it('invalidates reviewed choices when unsaved edits change the review context', async () => {
  const p = props(), view = render(<WorldReturnPanel {...p} />); await review();
  view.rerender(<WorldReturnPanel {...p} context="version-4-dirty" enabled={false} />);
  expect(screen.queryByRole('button', { name: 'Save reviewed choices' })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Review changes from QiMovi' })).toBeDisabled();
});

it('shows unsupported entries without offering an import', async () => {
  vi.mocked(worldReturnApi.preview).mockResolvedValue({ ...preview, items: [{ ...preview.items[0], state: 'unsupported', selectable: false, reason: 'The remote entry was set aside.' }] });
  render(<WorldReturnPanel {...props()} />); await review();
  expect(screen.getByText('The remote entry was set aside.')).toBeInTheDocument();
  expect(screen.queryByRole('radio')).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Save reviewed choices' })).not.toBeInTheDocument();
});

it('clears stale review after a service failure and allows a fresh preview', async () => {
  vi.mocked(worldReturnApi.preview).mockRejectedValueOnce(new Error('Open QiMovi and try again.'));
  render(<WorldReturnPanel {...props()} />); await review();
  expect(screen.getByRole('alert')).toHaveTextContent('Open QiMovi');
  await review();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  expect(screen.getByRole('region', { name: 'World changes review' })).toBeInTheDocument();
});
