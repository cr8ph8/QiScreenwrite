// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import ResearchLab from './ResearchLab';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const snapshot = (extra = {}) => ({ schema: 'qi-research-loop/v1', app: 'qiscreenwrite', projectId: 'fixture', degraded: false,
  target: { id: 'synthetic', title: 'Sample source retrieval', description: 'Public synthetic examples.' }, contract: {},
  accepted: { version: 0, hash: '0'.repeat(64), config: { titleWeight: 1, textWeight: 0, tagWeight: 0 } }, active: null, pendingReviews: [], runs: [], events: [], ...extra });
const reply = (value: unknown) => Promise.resolve({ ok: true, json: async () => value });

it('opening and closing research does not submit work or lose unsaved writing', async () => {
  const fetcher = vi.fn((_route: string, _options?: RequestInit) => reply(snapshot())); vi.stubGlobal('fetch', fetcher);
  render(<><textarea aria-label="Working draft" defaultValue="My unsaved dialogue"/><ResearchLab projectId="fixture" app="qiscreenwrite"/></>);
  expect(fetcher).not.toHaveBeenCalled(); fireEvent.click(screen.getByRole('button', { name: 'Research lab' }));
  await screen.findByText('Sample source retrieval');
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher.mock.calls[0]?.[1]?.method).toBeUndefined();
  fireEvent.click(screen.getByRole('button', { name: 'Close research' }));
  expect((screen.getByLabelText('Working draft') as HTMLTextAreaElement).value).toBe('My unsaved dialogue');
  expect(screen.queryByRole('dialog')).toBeNull();
});

it('uncertain start retains the same request ID and exact budget on retry', async () => {
  let posts = 0;
  const fetcher = vi.fn((route: string, _options?: RequestInit) => route.endsWith('/start')
    ? ++posts === 1 ? Promise.reject(new Error('Response lost')) : reply(snapshot({ active: { id: 'run', completedTrials: 0, maxTrials: 6 } }))
    : reply(snapshot()));
  vi.stubGlobal('fetch', fetcher);
  render(<ResearchLab projectId="fixture" app="qiscreenwrite"/>);
  fireEvent.click(screen.getByRole('button', { name: 'Research lab' }));
  const start = await screen.findByRole('button', { name: 'Start bounded run' });
  fireEvent.submit(start.closest('form')!); await screen.findByRole('alert');
  const first = fetcher.mock.calls.find(call => call[0].endsWith('/start'))!;
  fireEvent.submit(screen.getByRole('button', { name: 'Retry same request' }).closest('form')!);
  await waitFor(() => expect(posts).toBe(2));
  const second = fetcher.mock.calls.filter(call => call[0].endsWith('/start'))[1];
  expect(first[1]?.body).toBe(second[1]?.body);
  expect(JSON.parse(String(first[1]?.body))).toMatchObject({ projectId: 'fixture', maxTrials: 6, maxWallMs: 60000, trialTimeoutMs: 5000 });
  await screen.findByRole('button', { name: 'Cancel run' });
});

it('foreign workspace responses cannot enable a run', async () => {
  vi.stubGlobal('fetch', vi.fn(() => reply(snapshot({ projectId: 'foreign' }))));
  render(<ResearchLab projectId="fixture" app="qiscreenwrite"/>);
  fireEvent.click(screen.getByRole('button', { name: 'Research lab' }));
  expect((await screen.findByRole('alert')).textContent).toContain('does not match this workspace');
  expect(screen.queryByRole('button', { name: 'Start bounded run' })).toBeNull();
});

it('degraded journal state disables execution and reports unknown accepted state', async () => {
  vi.stubGlobal('fetch', vi.fn(() => reply(snapshot({ degraded: true, accepted: null, error: 'RESEARCH_LEDGER_CORRUPT' }))));
  render(<ResearchLab projectId="fixture" app="qiscreenwrite"/>);
  fireEvent.click(screen.getByRole('button', { name: 'Research lab' }));
  expect((await screen.findByRole('alert')).textContent).toContain('RESEARCH_LEDGER_CORRUPT');
  expect((screen.getByRole('button', { name: 'Start bounded run' }) as HTMLButtonElement).disabled).toBe(true);
});

it('shows the exact proposed changes before approval and submits only their review binding', async () => {
  const proposalHash = 'b'.repeat(64);
  const proposal = { id: 'proposed-run', proposalHash, acceptedVersion: 0, sourceHash: 'a'.repeat(64),
    config: { titleWeight: 0, textWeight: 1, tagWeight: 0 }, checks: { verification: 'PASS', budget: 'PASS' },
    development: { baseline: { correct: 1, total: 6 }, candidate: { correct: 6, total: 6 } },
    confirmation: { baseline: { correct: 1, total: 6 }, candidate: { correct: 5, total: 6 } } };
  const fetcher = vi.fn((route: string, _options?: RequestInit) => route.endsWith('/review')
    ? reply(snapshot({ accepted: { version: 1, hash: 'c'.repeat(64), config: proposal.config } }))
    : reply(snapshot({ pendingReviews: [proposal] })));
  vi.stubGlobal('fetch', fetcher);
  render(<ResearchLab projectId="fixture" app="qiscreenwrite"/>);
  fireEvent.click(screen.getByRole('button', { name: 'Research lab' }));
  const approve = await screen.findByRole('button', { name: 'Approve research settings' });
  expect(screen.getByText(/Title weight 1 → 0/)).toBeTruthy();
  expect(screen.getByText(/Confirmation 1 \/ 6 → 5 \/ 6/)).toBeTruthy();
  expect(fetcher.mock.calls.some(([, options]) => options?.method === 'POST')).toBe(false);
  fireEvent.click(approve);
  await screen.findByText('Accepted research settings · version 1');
  const review = fetcher.mock.calls.find(([route]) => route.endsWith('/review'))!;
  expect(JSON.parse(String(review[1]?.body))).toEqual({ projectId: 'fixture', runId: 'proposed-run', proposalHash, action: 'APPROVE' });
});
