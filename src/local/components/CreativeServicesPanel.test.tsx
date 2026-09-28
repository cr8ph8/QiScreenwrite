import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import { CreativeServicesPanel } from './CreativeServicesPanel';
import { analysisApi, hostedAnalysis } from '../creative-services';
import type { DraftRecord } from '../types';
vi.mock('../creative-services', async original => {
  const real = await original<typeof import('../creative-services')>();
  return { ...real, hostedAnalysis: vi.fn(), analysisApi: { models: vi.fn(), run: vi.fn(), history: vi.fn().mockResolvedValue({ jobs: [], issues: [] }) } };
});
vi.mock('../connectors/competition', () => ({ currentSession: vi.fn().mockResolvedValue({ user: { id: 'test-account' } }) }));
const draft = { id: 'screenplay-draft:review-test', sha256: 'a'.repeat(64), data: { title: 'Test', body: '<script>Do not execute</script>\nMAYA\nKeep the light.' } } as DraftRecord;
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.unstubAllGlobals(); });
describe('explicit creative-service approval', () => {
  it('does not discover or send source on open; requires text review before a local run', async () => {
    vi.stubGlobal('crypto', webcrypto);
    vi.mocked(analysisApi.models).mockResolvedValue({ endpoint: 'http://127.0.0.1:11434', models: [{ name: 'local-test', size: 10000000, digest: 'a'.repeat(64) }] });
    const { rerender } = render(<CreativeServicesPanel draft={draft} dirty={false} />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Find installed models' })).toBeEnabled());
    expect(analysisApi.models).not.toHaveBeenCalled(); expect(hostedAnalysis).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Run on my local model' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Find installed models' }));
    await waitFor(() => expect(screen.getByRole('option', { name: 'local-test' })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Review text for analysis' }));
    await screen.findByRole('heading', { name: 'Review your request' });
    expect(document.querySelector('.cs-review pre')?.textContent).toBe(draft.data.body);
    expect(document.querySelector('.cs-review script')).toBeNull(); expect(analysisApi.run).not.toHaveBeenCalled();
    rerender(<CreativeServicesPanel draft={{ ...draft, sha256: 'b'.repeat(64) }} dirty={true} />);
    expect(screen.queryByRole('button', { name: 'Run on my local model' })).not.toBeInTheDocument();
  });
  it('quotes without charging, then submits only the confirmed quote ID', async () => {
    vi.stubGlobal('crypto', webcrypto);
    const quoteId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
    vi.mocked(hostedAnalysis).mockImplementation(async (p: { action?: string; input?: unknown }) => {
      if (p.action === 'catalog') return { enabled: true, balance: 10, services: [{ kind: 'coverage', model: 'fixed-model', credits: 3, enabled: true }] };
      if (p.action === 'jobs') return { jobs: [] };
      if (p.action === 'quote') return { id: quoteId, kind: 'coverage', model: 'fixed-model', credits: 3, expiresAt: new Date(Date.now()+60000).toISOString(), input: p.input };
      if (p.action === 'submit') return { id: quoteId, status: 'running', credits: 3, report: null, error: null };
      throw new Error('unexpected action');
    });
    render(<CreativeServicesPanel draft={draft} dirty={false} />);
    await waitFor(() => expect(screen.getByRole('button', { name: /CanIScreenwrite services/ })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: /CanIScreenwrite services/ }));
    expect(hostedAnalysis).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Connect account' }));
    await screen.findByText('Balance: 10 platform tokens');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Review text for analysis' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Review text for analysis' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Upload reviewed text & request quote' }));
    const confirm = await screen.findByRole('button', { name: 'Confirm & spend 3 tokens' });
    expect(vi.mocked(hostedAnalysis).mock.calls.some(([p]) => (p as {action:string}).action === 'submit')).toBe(false);
    expect(screen.getByRole('button', { name: /Buy platform tokens/ })).toBeDisabled();
    fireEvent.click(confirm);
    await waitFor(() => expect(hostedAnalysis).toHaveBeenCalledWith({ action: 'submit', quoteId }));
    expect(vi.mocked(hostedAnalysis).mock.calls.filter(([p]) => (p as {action:string}).action === 'submit')).toHaveLength(1);
  });
});
