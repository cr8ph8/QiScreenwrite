import { describe, it, expect, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import { checkedJob, checkedHostedJob, prepareAnalysis } from './creative-services';
import type { DraftRecord } from './types';
vi.mock('./api', () => ({ request: vi.fn() }));
const draft = (body: string) => ({ id: 'screenplay-draft:test', data: { title: 'Test', body } } as DraftRecord);
describe('creative request and receipt boundary', () => {
  it('requires explicit passage selection for long drafts and hashes the whole saved body', async () => {
    vi.stubGlobal('crypto', webcrypto);
    const source = draft('a'.repeat(11999) + '🎬' + 'b'.repeat(20));
    await expect(prepareAnalysis(source, 'coverage', '', false)).rejects.toThrow('opening-passage');
    const input = await prepareAnalysis(source, 'coverage', '', true);
    expect(input.source.excerpt).toBe('a'.repeat(11999));
    expect(input.source.scope).toBe('excerpt');
    const changed = await prepareAnalysis(draft(source.data.body + 'x'), 'coverage', '', true);
    expect(changed.source.excerpt).toBe(input.source.excerpt);
    expect(changed.source.bodySha256).not.toBe(input.source.bodySha256);
    vi.unstubAllGlobals();
  });
  it('accepts reordered JSON keys but rejects a report for a different source', async () => {
    vi.stubGlobal('crypto', webcrypto);
    const input = await prepareAnalysis(draft('MAYA protects the flame.'), 'screenplay_profile', '', false);
    const report = { schemaVersion: 1, id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', createdAt: new Date().toISOString(), provider: 'hosted', model: 'test', platformCredits: 4, input: { characterName: input.characterName, source: { ...input.source }, kind: input.kind, schemaVersion: input.schemaVersion }, usage: { inputTokens: null, outputTokens: null }, output: { summary: 'Interpretation.', strengths: [], concerns: [], nextSteps: [], sections: [], scores: [] } };
    const job = { id: report.id, status: 'completed', credits: 4, report, error: null };
    expect(() => checkedJob(job as never, input)).not.toThrow();
    const quote = { id: report.id, kind: input.kind, model: 'test', credits: 4, expiresAt: new Date(Date.now()+60000).toISOString(), input };
    expect(() => checkedHostedJob(job as never, quote, report.id)).not.toThrow();
    expect(() => checkedHostedJob(job as never, { ...quote, credits: 5 })).toThrow('confirmed model');
    expect(() => checkedHostedJob(job as never, { ...quote, model: 'other' })).toThrow('confirmed model');
    expect(() => checkedHostedJob({ ...job, id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' } as never, quote)).toThrow('confirmed model');
    expect(() => checkedJob(job as never, { ...input, source: { ...input.source, title: 'Other' } })).toThrow('does not match');
    vi.unstubAllGlobals();
  });
});
