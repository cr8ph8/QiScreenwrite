import { webcrypto } from 'node:crypto';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { RightsPanel } from './RightsPanel';
import { localApi } from '../api';
import { downloadText } from '../model';
import { defaultParticipation, RIGHTS_ID, recordRef, type ProjectParticipation, type RightsRecovery, type TokenDraftData, type TokenPreview } from '../rights';
import type { LocalProject, RecordInput, WorkspaceRecord } from '../types';

vi.mock('../api', () => ({ localApi: { save: vi.fn(), history: vi.fn(), rights: { attachEvidence: vi.fn(), worksheet: vi.fn(), tokenPreview: vi.fn(), tokenExport: vi.fn(), recovery: { get: vi.fn(), put: vi.fn(), clear: vi.fn() } } } }));
vi.mock('../model', async importOriginal => ({ ...await importOriginal<typeof import('../model')>(), downloadText: vi.fn() }));
const project: LocalProject = { id: 'project:test', title: 'Private film', profile: 'caniscreenwrite-local-writer/v1', sourceHash: null, sourceStatus: 'NO_SOURCE' };
const saved = (data: ProjectParticipation, version = 1): WorkspaceRecord<ProjectParticipation> => ({ id: RIGHTS_ID, kind: 'project-participation', data, version, sha256: String(version).repeat(64) });
const partyData = (): ProjectParticipation => ({ ...defaultParticipation(project), parties: [{ id: 'party:one', name: 'Private collaborator', kind: 'PERSON' }] });
const screenplay: WorkspaceRecord = { id: 'screenplay-draft:one', kind: 'screenplay-draft', version: 1, sha256: 'a'.repeat(64), data: { projectId: project.id, title: 'Secret screenplay', body: 'Private story body', sourceHash: null } };
const onSaved = vi.fn(), onRefresh = vi.fn();
const flush = () => (window as Window & { __flushRightsRecovery?: () => Promise<void> }).__flushRightsRecovery();
const button = (name: string) => screen.getByRole('button', { name });
const click = (name: string) => fireEvent.click(button(name));
const edit = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label, { exact: true }), { target: { value } });
const panel = () => screen.getByRole('region', { name: 'Rights & collaborators' });
const recovery = (data: ProjectParticipation, base?: WorkspaceRecord): RightsRecovery => ({ schemaVersion: 1, projectId: project.id, baseVersion: base?.version ?? null, baseSha256: base?.sha256 ?? null, data, pendingSave: null, savedAt: '2026-09-27T12:00:00.000Z' });
async function mount(records: WorkspaceRecord[] = []) {
  const view = render(<RightsPanel project={project} records={records} onSaved={onSaved} onRefresh={onRefresh} active />);
  await waitFor(() => expect(screen.queryByText('Checking local recovery before editing…')).not.toBeInTheDocument());
  return view;
}
function addParty() { click('Add collaborator'); edit('Collaborator 1 name', 'Private collaborator'); }
function addAllocation() {
  click('Add copyright ownership'); click('Add allocation');
  edit('Collaborator', (screen.getByLabelText('Collaborator') as HTMLSelectElement).options[1].value);
}
beforeEach(() => {
  vi.resetAllMocks(); vi.stubGlobal('crypto', webcrypto);
  onRefresh.mockResolvedValue(undefined);
  vi.mocked(localApi.rights.recovery.get).mockResolvedValue(null);
  vi.mocked(localApi.rights.recovery.put).mockImplementation(async value => value);
  vi.mocked(localApi.rights.recovery.clear).mockResolvedValue({ removed: true });
  vi.mocked(localApi.history).mockResolvedValue([]);
  vi.mocked(localApi.save).mockImplementation(async input => ({ id: input.id, kind: input.kind, version: (input.expectedVersion ?? 0) + 1, sha256: 'b'.repeat(64), data: input.data }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });

it('saves an explicit draft with unknown shares and a durable identical pending request', async () => {
  await mount(); addParty(); addAllocation();
  expect(screen.getByLabelText('Share (%)')).toHaveValue('');
  click('Save rights draft');
  await waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
  const input = vi.mocked(localApi.save).mock.calls[0][0] as RecordInput<ProjectParticipation>;
  expect(input).toMatchObject({ id: RIGHTS_ID, kind: 'project-participation', expectedVersion: null });
  expect(input.data.pools[0].allocations[0].shareBps).toBeNull();
  expect(localApi.rights.recovery.put).toHaveBeenCalledWith(expect.objectContaining({ baseVersion: null, baseSha256: null, data: input.data, pendingSave: input }));
  expect(vi.mocked(localApi.rights.recovery.put).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(localApi.save).mock.invocationCallOrder[0]);
  await waitFor(() => expect(localApi.rights.recovery.clear).toHaveBeenCalledOnce());
  expect(panel()).toHaveAttribute('data-rights-dirty', 'false');
});

it('keeps exact two-decimal shares and rejects invalid input from native recovery', async () => {
  await mount(); addParty(); addAllocation(); edit('Share (%)', '33.333');
  expect(button('Save rights draft')).toBeDisabled();
  expect(panel()).toHaveAttribute('data-rights-dirty', 'true');
  await act(async () => { await expect(flush()).rejects.toThrow('invalid'); });
  expect(localApi.rights.recovery.put).not.toHaveBeenCalled();
  expect(screen.getByText('Current edits are invalid and are not recovered.')).toBeVisible();
  edit('Share (%)', '33.33');
  await act(async () => { await flush(); });
  const copy = vi.mocked(localApi.rights.recovery.put).mock.calls.at(-1)[0];
  expect(copy.data.pools[0].allocations[0].shareBps).toBe(3333);
  expect(screen.getByText('Current valid edits recovered locally. Not yet saved to history.')).toBeVisible();
});

it('retries an unconfirmed save with exactly the original request and prevents editing', async () => {
  vi.mocked(localApi.save).mockRejectedValueOnce(new Error('Response lost'));
  await mount(); addParty(); click('Save rights draft');
  await screen.findByText('Response lost');
  const original = vi.mocked(localApi.save).mock.calls[0][0];
  expect(screen.getByLabelText('Collaborator 1 name')).toBeDisabled();
  click('Retry same save'); await waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
  expect(vi.mocked(localApi.save).mock.calls[1][0]).toEqual(original);
  expect(localApi.rights.recovery.put).toHaveBeenCalledOnce();
});

it('preserves edits while inactive and flags refreshed records without rebasing', async () => {
  const base = saved(partyData()), view = await mount([base]);
  edit('Collaborator 1 name', 'Still editing');
  const newer = saved({ ...partyData(), parties: [{ ...partyData().parties[0], name: 'Elsewhere' }] }, 2);
  view.rerender(<RightsPanel project={{ ...project }} records={[newer]} onSaved={onSaved} onRefresh={onRefresh} active={false} />);
  expect(screen.getByLabelText('Collaborator 1 name')).toHaveValue('Still editing');
  expect(screen.getByLabelText('Collaborator 1 name')).not.toBeVisible();
  view.rerender(<RightsPanel project={{ ...project }} records={[newer]} onSaved={onSaved} onRefresh={onRefresh} active />);
  expect(button('Save rights draft')).toBeDisabled();
  await act(async () => { await flush(); });
  expect(localApi.rights.recovery.get).toHaveBeenCalledOnce();
  expect(localApi.rights.recovery.put).toHaveBeenCalledWith(expect.objectContaining({ baseVersion: 1, baseSha256: base.sha256 }));
});

it('requires recovery review and never merges a stale copy', async () => {
  const current = saved(partyData(), 2), old = saved(partyData());
  vi.mocked(localApi.rights.recovery.get).mockResolvedValue(recovery({ ...partyData(), parties: [{ ...partyData().parties[0], name: 'Recovered author' }] }, old));
  await mount([current]);
  expect(screen.getByLabelText('Collaborator 1 name')).toHaveValue('Private collaborator');
  expect(screen.getByLabelText('Collaborator 1 name')).toBeDisabled();
  click('Review recovered copy');
  expect(screen.getByText('Recovered author · Person')).toBeVisible();
  expect(button('Use reviewed recovery')).toBeDisabled();
  click('Discard recovery'); expect(localApi.rights.recovery.clear).not.toHaveBeenCalled();
  click('Confirm discard'); await waitFor(() => expect(localApi.rights.recovery.clear).toHaveBeenCalledWith('2026-09-27T12:00:00.000Z'));
});

it('restores only a matching reviewed recovery and retains its pending save identity', async () => {
  const base = saved(partyData()), data = { ...partyData(), parties: [{ ...partyData().parties[0], name: 'Recovered author' }] };
  const input: RecordInput<ProjectParticipation> = { id: RIGHTS_ID, kind: 'project-participation', expectedVersion: 1, requestId: 'request:retained', data };
  vi.mocked(localApi.rights.recovery.get).mockResolvedValue({ ...recovery(data, base), pendingSave: input });
  await mount([base]); click('Review recovered copy'); click('Use reviewed recovery');
  expect(screen.getByLabelText('Collaborator 1 name')).toHaveValue('Recovered author');
  click('Retry same save'); await waitFor(() => expect(localApi.save).toHaveBeenCalledWith(input));
});

it('uses increasing recovery timestamps even when the clock has not advanced', async () => {
  const base = saved(partyData());
  vi.mocked(localApi.rights.recovery.get).mockResolvedValue(recovery({ ...partyData(), parties: [{ ...partyData().parties[0], name: 'Recovered' }] }, base));
  await mount([base]); click('Review recovered copy'); click('Use reviewed recovery');
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-09-27T11:00:00.000Z'));
  await act(async () => { await flush(); }); edit('Collaborator 1 name', 'Next edit');
  await act(async () => { await flush(); });
  const copies = vi.mocked(localApi.rights.recovery.put).mock.calls.map(call => call[0]);
  expect(copies[0].savedAt).toBe('2026-09-27T12:00:00.001Z');
  expect(copies[1].savedAt).toBe('2026-09-27T12:00:00.002Z');
  vi.restoreAllMocks();
});

it('clears a conflicting recovered retry only after explicitly discarding its recovery', async () => {
  const base = saved(partyData()), latest = saved(partyData(), 2);
  const data = { ...partyData(), parties: [{ ...partyData().parties[0], name: 'Unconfirmed writer' }] };
  const pendingSave: RecordInput<ProjectParticipation> = { id: RIGHTS_ID, kind: 'project-participation', expectedVersion: 1, requestId: 'request:conflicted', data };
  vi.mocked(localApi.rights.recovery.get).mockResolvedValue({ ...recovery(data, base), pendingSave });
  vi.mocked(localApi.save).mockRejectedValueOnce(Object.assign(new Error('Version changed'), { code: 'VERSION_CONFLICT' }));
  await mount([latest]); click('Review recovered copy'); click('Retry original save');
  await screen.findByText('Version changed');
  expect(vi.mocked(localApi.save).mock.calls[0][0]).toEqual(pendingSave);
  click('Discard recovery'); click('Confirm discard');
  await waitFor(() => expect(screen.getByLabelText('Collaborator 1 name')).toBeEnabled());
  expect(screen.queryByRole('button', { name: 'Retry same save' })).not.toBeInTheDocument();
  edit('Collaborator 1 name', 'New reviewed edit'); click('Save rights draft');
  await waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
  const next = vi.mocked(localApi.save).mock.calls[1][0];
  expect(next.expectedVersion).toBe(2); expect(next.requestId).not.toBe(pendingSave.requestId);
});

it('reports recovery failure and does not send a save without retaining its request', async () => {
  vi.mocked(localApi.rights.recovery.put).mockRejectedValue(new Error('Disk unavailable'));
  await mount(); addParty(); click('Save rights draft');
  await screen.findByText('Disk unavailable'); expect(localApi.save).not.toHaveBeenCalled();
  await act(async () => { await expect(flush()).rejects.toThrow('Disk unavailable'); });
  expect(panel()).toHaveAttribute('data-rights-dirty', 'true');
});

it('debounces valid editing recovery without saving history automatically', async () => {
  await mount(); vi.useFakeTimers(); addParty(); edit('Collaborator 1 name', 'Latest typing');
  await act(async () => { await vi.advanceTimersByTimeAsync(649); });
  expect(localApi.rights.recovery.put).not.toHaveBeenCalled();
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  expect(localApi.rights.recovery.put).toHaveBeenCalledOnce();
  expect(vi.mocked(localApi.rights.recovery.put).mock.calls[0][0].data.parties[0].name).toBe('Latest typing');
  expect(localApi.save).not.toHaveBeenCalled();
});

it('rejects oversized evidence and attaches the retained content hash to a contribution', async () => {
  const base = saved(partyData()); await mount([base]);
  const large = new File(['x'], 'large.pdf', { type: 'application/pdf' }); Object.defineProperty(large, 'size', { value: 1024 * 1024 + 1 });
  fireEvent.change(screen.getByLabelText('Upload evidence'), { target: { files: [large] } });
  await screen.findByText('Choose a nonempty evidence file no larger than 1 MiB.');
  expect(localApi.rights.attachEvidence).not.toHaveBeenCalled();
  const evidence = { id: `rights-evidence:${'d'.repeat(64)}`, kind: 'rights-evidence', version: 1, sha256: 'e'.repeat(64), data: { schemaVersion: 1 as const, projectId: project.id, name: 'agreement.txt', mediaType: 'text/plain', byteLength: 5, sha256: 'd'.repeat(64), base64: 'aGVsbG8=' } };
  vi.mocked(localApi.rights.attachEvidence).mockResolvedValue(evidence);
  fireEvent.change(screen.getByLabelText('Upload evidence'), { target: { files: [new File(['hello'], 'agreement.txt', { type: 'text/plain' })] } });
  await waitFor(() => expect(onSaved).toHaveBeenCalledWith(evidence));
  expect(localApi.rights.attachEvidence).toHaveBeenCalledWith({ name: 'agreement.txt', mediaType: 'text/plain', base64: 'aGVsbG8=' });
  click('Add contribution'); edit('Collaborator', 'party:one');
  fireEvent.click(screen.getByText('Evidence attachments · 0'));
  fireEvent.click(screen.getByLabelText('agreement.txt'));
  click('Save rights draft'); await waitFor(() => expect(localApi.save).toHaveBeenCalled());
  expect((vi.mocked(localApi.save).mock.calls[0][0].data as ProjectParticipation).contributions[0].evidenceHashes).toEqual(['d'.repeat(64)]);
});

it('records immutable local review, derives staleness, and exports a private worksheet from the saved ref', async () => {
  const base = saved(partyData()), view = await mount([base]);
  edit('Review note', 'Checked locally'); click('Record local review');
  await waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
  const review = vi.mocked(localApi.save).mock.calls[0][0];
  expect(review).toMatchObject({ id: expect.stringMatching(/^rights-review:/), expectedVersion: null, data: { schemaVersion: 1, projectId: project.id, status: 'LOCAL_REVIEW', participationRef: recordRef(base), note: 'Checked locally', actor: 'local-owner' } });
  vi.mocked(localApi.rights.worksheet).mockResolvedValue({ participation: base.data, evidenceHashes: [] });
  click('Export PRIVATE worksheet'); await waitFor(() => expect(downloadText).toHaveBeenCalledOnce());
  expect(localApi.rights.worksheet).toHaveBeenCalledWith(recordRef(base));
  expect(screen.getByText('Includes collaborator names, claims, terms and shares. Evidence bytes are excluded.')).toBeVisible();
  view.rerender(<RightsPanel project={project} records={[saved(partyData(), 2)]} onSaved={onSaved} onRefresh={onRefresh} active />);
  expect(screen.getByText('Review is stale · saved rights changed')).toBeInTheDocument();
});

it('guards unsaved token edits, saves blank public defaults, and exports only after actual public preview', async () => {
  const ledger = saved(partyData()); await mount([ledger, screenplay]);
  for (const label of ['Public name', 'Public description', 'Public image URL', 'Public licence URL', 'Public licence summary']) expect(screen.getByLabelText(label)).toHaveValue('');
  edit('Token subject', JSON.stringify(recordRef(screenplay))); edit('Public name', 'Public edition'); edit('Royalty request (%) (optional)', '2.50');
  expect(panel()).toHaveAttribute('data-rights-dirty', 'true');
  await act(async () => { await expect(flush()).rejects.toThrow('Unsaved token'); });
  expect(screen.queryByRole('button', { name: 'Export shown public JSON' })).not.toBeInTheDocument();
  click('Save token preparation'); await waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
  const input = vi.mocked(localApi.save).mock.calls[0][0] as RecordInput<TokenDraftData>;
  expect(input).toMatchObject({ id: expect.stringMatching(/^token-preparation:/), expectedVersion: null, data: { participationRef: recordRef(ledger), subjectRef: recordRef(screenplay), standard: 'UNDECIDED', editionCap: null, royaltyRequestBps: 250, nonce: expect.stringMatching(/^[a-f0-9]{64}$/), publicFields: { name: 'Public edition', description: '', imageUri: '', licenceUri: '', licenceSummary: '' } } });
  expect(panel()).toHaveAttribute('data-rights-dirty', 'false');
  const token = onSaved.mock.calls[0][0];
  const metadata = { name: 'Public edition', description: '', properties: { standard: 'UNDECIDED' } };
  const preview: TokenPreview = { recordRef: recordRef(token), metadata, metadataSha256: 'c'.repeat(64), omitted: [], status: 'LOCAL_DRAFT', executionEnabled: false };
  vi.mocked(localApi.rights.tokenPreview).mockResolvedValue(preview); vi.mocked(localApi.rights.tokenExport).mockResolvedValue(metadata);
  click('Preview public JSON');
  const previewRegion = await screen.findByRole('region', { name: 'Public JSON preview' });
  expect(within(previewRegion).getByText(/"Public edition"/)).toBeInTheDocument();
  expect(previewRegion.textContent).not.toContain('Private collaborator'); expect(previewRegion.textContent).not.toContain('Private story body');
  expect(localApi.rights.tokenExport).not.toHaveBeenCalled();
  click('Export shown public JSON'); await waitFor(() => expect(downloadText).toHaveBeenCalledOnce());
  expect(localApi.rights.tokenExport).toHaveBeenCalledWith(recordRef(token), preview.metadataSha256);
  expect(downloadText).toHaveBeenCalledWith('token-metadata-draft.json', JSON.stringify(metadata, null, 2), 'application/json');
});

it('suppresses download when the token export service rejects stale metadata', async () => {
  const ledger = saved(partyData()); await mount([ledger, screenplay]);
  edit('Token subject', JSON.stringify(recordRef(screenplay))); edit('Public name', 'Edition'); click('Save token preparation');
  await waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
  const token = onSaved.mock.calls[0][0];
  vi.mocked(localApi.rights.tokenPreview).mockResolvedValue({ recordRef: recordRef(token), metadata: { name: 'Edition' }, metadataSha256: 'c'.repeat(64), omitted: [], status: 'LOCAL_DRAFT', executionEnabled: false });
  vi.mocked(localApi.rights.tokenExport).mockRejectedValue(new Error('Saved subject changed. Preview again.'));
  click('Preview public JSON'); await screen.findByRole('region', { name: 'Public JSON preview' });
  click('Export shown public JSON'); await screen.findByText('Saved subject changed. Preview again.');
  expect(downloadText).not.toHaveBeenCalled();
});
