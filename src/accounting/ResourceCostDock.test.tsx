// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import ResourceCostDock from './ResourceCostDock';
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const snapshot = (extra = {}) => ({ schema: 'qi-resource-accounting/v1', projectId: 'fixture', app: 'qiscreenwrite', authority: 'OBSERVATION_ONLY', spendAuthorized: false,
  degraded: false, issues: [], production: null, financing: null, usage: { groups: [], attempts: [] }, requestActivity: { started: 0, finished: 0, unresolved: 0, byFamily: [] }, entryTotals: [], coverage: { hardwareEnergy: 'UNMETERED' }, ...extra });
const reply = (value: unknown, ok = true) => Promise.resolve({ ok, status: ok ? 200 : 409, json: async () => value });
it('is app-wide but does no work before opening; closing preserves mounted writing', async () => {
  const fetcher = vi.fn((_route: string) => reply(snapshot())); vi.stubGlobal('fetch', fetcher);
  render(<><textarea aria-label="Working screenplay" defaultValue="Keep my writing"/><ResourceCostDock projectId="fixture" app="qiscreenwrite"/></>);
  expect(fetcher).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText('Working screenplay'), { target: { value: 'Unsaved writing stays here' } });
  fireEvent.click(screen.getByText('Costs · money, tokens & resources'));
  await screen.findByText(/No production budget is available/);
  expect(fetcher).toHaveBeenCalledTimes(1); expect(fetcher.mock.calls[0]?.[0]).toBe('/api/resource-accounting');
  fireEvent.click(screen.getByText('Close costs'));
  expect((screen.getByLabelText('Working screenplay') as HTMLTextAreaElement).value).toBe('Unsaved writing stays here');
});
it('shows unknown totals instead of inventing free work, and refuses a foreign project', async () => {
  const fetcher = vi.fn().mockImplementationOnce(() => reply(snapshot({ production: { totals: [], gaps: 3 } })))
    .mockImplementationOnce(() => reply(snapshot({ projectId: 'someone-else' })));
  vi.stubGlobal('fetch', fetcher); render(<ResourceCostDock projectId="fixture" app="qiscreenwrite"/>);
  fireEvent.click(screen.getByText('Costs · money, tokens & resources'));
  await screen.findByText('No priced budget lines yet. Project cost is unknown, not zero.');
  fireEvent.click(screen.getByText('Refresh costs'));
  await screen.findByRole('alert'); expect(screen.getByRole('alert').textContent).toContain('did not match this workspace');
});
it('retains the exact uncertain observation payload for retry without transferring money', async () => {
  const fetcher = vi.fn().mockImplementation((route: string) => route.endsWith('/entry') ? Promise.reject(new Error('Network response lost')) : reply(snapshot()));
  vi.stubGlobal('fetch', fetcher); render(<ResourceCostDock projectId="fixture" app="qiscreenwrite"/>);
  fireEvent.click(screen.getByText('Costs · money, tokens & resources')); await screen.findByText(/No production budget is available/);
  fireEvent.click(screen.getByText('Record money, credits, time or energy'));
  const form = screen.getByText('Save / retry exact observation').closest('form')!;
  for (const input of Array.from(form.querySelectorAll('input'))) fireEvent.change(input, { target: { value: input.closest('label')!.textContent === 'amount' ? '12.50' : 'synthetic' } });
  fireEvent.submit(form); await screen.findByText('Network response lost');
  const first = fetcher.mock.calls.find((c: unknown[]) => c[0] === '/api/resource-accounting/entry')!;
  fireEvent.submit(form); await waitFor(() => expect(fetcher.mock.calls.filter((c: unknown[]) => c[0] === '/api/resource-accounting/entry')).toHaveLength(2));
  const second = fetcher.mock.calls.filter((c: unknown[]) => c[0] === '/api/resource-accounting/entry')[1];
  expect(first[1].body).toBe(second[1].body); const payload = JSON.parse(first[1].body);
  expect(payload.projectId).toBe('fixture'); expect(payload.data.amount).toBe('12.50'); expect(payload.data.stage).toBe('incurred');
});
it('linked film costs require an explicit click and cannot become a local ledger', async () => {
  const fetcher = vi.fn((route: string) => reply(route.includes('qimovi-context') ? { draftId: 'draft:one', readOnly: true, projectId: 'film', costContext: { schema: 'qi-resource-context/v1', scope: 'PROJECT_NOT_DRAFT', projectId: 'film', readOnly: true, production: null, financing: null, usageGroups: [] } } : snapshot()));
  vi.stubGlobal('fetch', fetcher); render(<ResourceCostDock projectId="fixture" app="qiscreenwrite" draftId="draft:one"/>);
  fireEvent.click(screen.getByText('Costs · money, tokens & resources')); await screen.findByText(/No production budget is available/);
  expect(fetcher).toHaveBeenCalledTimes(1); fireEvent.click(screen.getByText('Read linked QiMovi costs'));
  await screen.findByText('Linked film · film'); expect(fetcher.mock.calls.filter(c => c[0].includes('/entry'))).toHaveLength(0);
});
