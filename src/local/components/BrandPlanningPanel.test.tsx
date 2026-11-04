// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { BrandPlanningPanel } from './BrandPlanningPanel';
import type { BrandPlan, BrandPlanningApi } from '../brand-planning';
import type { DraftRecord } from '../types';
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const draft: DraftRecord = { id: 'screenplay-draft:test', kind: 'screenplay-draft', version: 1, sha256: 'a'.repeat(64),
  data: { schemaVersion: 2, projectId: 'project:test', sourceHash: null, title: 'Synthetic', format: 'FOUNTAIN', status: 'DRAFT', body: 'INT. ROOM - DAY\nA coffee.' } };
const plan: BrandPlan = { schemaVersion: 'qiscreenwrite-brand-planning/v1', projectId: draft.data.projectId,
  source: { id: draft.id, fingerprint: 'b'.repeat(64), sourceHash: 'c'.repeat(64), recordRef: { id: draft.id, version: 1, sha256: draft.sha256 } },
  opportunities: [{ id: `placement:${'d'.repeat(40)}`, category: 'beverage', quote: 'coffee', context: 'A coffee.', heading: 'INT. ROOM - DAY', start: 16, end: 22 }],
  reviewId: `brand-review:${'e'.repeat(64)}`, reviewRecord: null, stale: false, truncated: false, authority: 'CREATIVE_PLANNING_ONLY', approvalGranted: false };
function client(): BrandPlanningApi { return { scan: vi.fn().mockResolvedValue(plan), save: vi.fn().mockImplementation(async input => ({ ...input, version: 1, sha256: 'f'.repeat(64) })), context: vi.fn() }; }
it('does not scan automatically, preserves unsaved writing, and requires a review reason', async () => {
  const api = client(), onSaved = vi.fn(); const view = render(<BrandPlanningPanel draft={draft} dirty={true} onSaved={onSaved} api={api}/>);
  expect(api.scan).not.toHaveBeenCalled(); expect(screen.getByRole('button', { name: 'Scan saved screenplay' })).toBeDisabled();
  view.rerender(<BrandPlanningPanel draft={draft} dirty={false} onSaved={onSaved} api={api}/>);
  fireEvent.click(screen.getByRole('button', { name: 'Scan saved screenplay' })); await screen.findByText('A coffee.');
  expect(screen.getByRole('button', { name: 'Approve creative opportunity' })).toBeDisabled();
  fireEvent.change(screen.getByLabelText('Creative review reason'), { target: { value: 'Fits this action.' } });
  fireEvent.click(screen.getByRole('button', { name: 'Approve creative opportunity' }));
  await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
  expect(api.save).toHaveBeenCalledWith(expect.objectContaining({ kind: 'brand-review', data: expect.objectContaining({ approvalGranted: false, sourceRef: plan.source.recordRef }) }));
  expect(api.context).not.toHaveBeenCalled();
});
it('retains an unconfirmed request for exact retry rather than creating another review', async () => {
  const api = client(); vi.mocked(api.save).mockRejectedValueOnce(new Error('Connection interrupted'));
  render(<BrandPlanningPanel draft={draft} dirty={false} onSaved={vi.fn()} api={api}/>);
  fireEvent.click(screen.getByText('Scan saved screenplay')); await screen.findByText('A coffee.');
  fireEvent.change(screen.getByLabelText('Creative review reason'), { target: { value: 'Keep this reason.' } });
  fireEvent.click(screen.getByText('Reject opportunity')); await screen.findByRole('alert');
  fireEvent.click(screen.getByText('Retry exact review')); await waitFor(() => expect(api.save).toHaveBeenCalledTimes(2));
  expect(vi.mocked(api.save).mock.calls[0][0]).toEqual(vi.mocked(api.save).mock.calls[1][0]);
});
it('never displays an in-flight scan for a different saved revision', async () => {
  const api = client(); let resolve!: (value: BrandPlan) => void;
  vi.mocked(api.scan).mockImplementation(() => new Promise(done => { resolve = done; }));
  const view = render(<BrandPlanningPanel draft={draft} dirty={false} onSaved={vi.fn()} api={api}/>);
  fireEvent.click(screen.getByText('Scan saved screenplay'));
  view.rerender(<BrandPlanningPanel draft={{ ...draft, version: 2, sha256: '9'.repeat(64) }} dirty={false} onSaved={vi.fn()} api={api}/>);
  resolve(plan); await waitFor(() => expect(screen.getByText('Scan saved screenplay')).not.toBeDisabled());
  expect(screen.queryByText('A coffee.')).toBeNull();
});
