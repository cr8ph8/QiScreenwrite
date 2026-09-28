import '@testing-library/jest-dom/vitest';
import { createRef } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FilmcraftPanel } from '../components/FilmcraftPanel';
import { DevelopmentPanel, type DevelopmentPanelHandle } from '../components/DevelopmentPanel';
import { WriterDesk } from '../components/WriterDesk';
import { localApi } from '../api';
import { FILMCRAFT_CATALOG, appendFilmcraftResearch, createFilmcraftIndex, filmcraftResearchNote, filmcraftSourceLabel, filmcraftSourceUrl, parseFilmcraftCatalog, searchFilmcraft, type FilmcraftEntry } from '../filmcraft';
import { buildDraftData } from '../model';
import { createDevelopment, developmentId, developmentRecoveryKey, type DevelopmentRecord, type DevelopmentRecovery } from '../development';
import type { DraftRecord, LocalProject } from '../types';

vi.mock('../api', () => ({ localApi: { history: vi.fn(), save: vi.fn(), recovery: { get: vi.fn(), put: vi.fn(), remove: vi.fn() }, developmentRecovery: { get: vi.fn(), put: vi.fn(), remove: vi.fn() } }, LocalApiError: class extends Error { code = ''; } }));
vi.mock('../components/QiMoviPanel', () => ({ QiMoviPanel: () => null }));
vi.mock('../components/HistoryPanel', () => ({ HistoryPanel: () => null }));
vi.mock('@/lib/fountain/pdf', () => ({ exportScreenplayPdf: vi.fn() }));

const project: LocalProject = { id: 'local-writer:test', title: 'Test workspace', profile: 'caniscreenwrite-local-writer/v1', sourceHash: null, sourceStatus: 'NO_SOURCE' };
const draftId = 'screenplay-draft:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const otherId = 'screenplay-draft:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const draft: DraftRecord = { id: draftId, kind: 'screenplay-draft', version: 1, sha256: 'a'.repeat(64), data: buildDraftData(project.id, { title: 'Owner title', body: 'Original screenplay words.' }) };
const fixture: FilmcraftEntry = { id: 'test-entry', title: 'Test term', category: 'story', kind: 'theory', aliases: ['Alternate label'], definition: 'A test definition.', application: 'Apply the test idea.', prompt: 'Consider a test question?', caveats: ['This fixture is only a test.'], sources: [{ title: 'Test source', url: 'https://example.com/slides', slideNumber: 3 }] };
const developmentRecord = (): DevelopmentRecord => ({ id: developmentId(draftId), kind: 'story-development', version: 1, sha256: 'b'.repeat(64), data: { ...createDevelopment(project.id, draftId), concept: 'Owner concept', researchNotes: [{ id: crypto.randomUUID(), title: 'Owner reference', notes: 'Existing text\n  preserved exactly.', source: 'Owner source' }] } });
const recovery = (concept: string, savedAt: string): DevelopmentRecovery => ({ schema: 'caniscreenwrite-story-development-recovery/v1', projectId: project.id, draftId, baseVersion: 1, baseSha256: 'b'.repeat(64), data: { ...developmentRecord().data, concept }, pendingSave: null, savedAt });
const host = () => window as unknown as { __flushDevelopmentRecovery?: () => Promise<void>; __flushWriterRecovery?: () => Promise<void> };
const tab = (name: string) => {
  const target = screen.getByRole('tab', { name });
  fireEvent.mouseDown(target, { button: 0, ctrlKey: false });
  fireEvent.mouseUp(target, { button: 0 });
};
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }

beforeEach(() => {
  localStorage.clear(); vi.clearAllMocks();
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('No network in filmcraft tests'); }));
  vi.mocked(localApi.history).mockResolvedValue([draft]);
  vi.mocked(localApi.recovery.get).mockResolvedValue(null);
  vi.mocked(localApi.recovery.put).mockImplementation(async copy => copy);
  vi.mocked(localApi.recovery.remove).mockResolvedValue({ deleted: true });
  vi.mocked(localApi.developmentRecovery.get).mockResolvedValue(null);
  vi.mocked(localApi.developmentRecovery.put).mockImplementation(async copy => copy);
  vi.mocked(localApi.developmentRecovery.remove).mockResolvedValue({ deleted: true });
  vi.mocked(localApi.save).mockImplementation(async input => ({ ...input, version: (input.expectedVersion ?? 0) + 1, sha256: 'c'.repeat(64) }));
});
afterEach(async () => { cleanup(); await act(async () => {}); vi.unstubAllGlobals(); });

describe('bundled film language', () => {
  it('validates the installed package and all entries fit development notes without truncation', () => {
    expect(parseFilmcraftCatalog(FILMCRAFT_CATALOG)).toBe(FILMCRAFT_CATALOG);
    expect(FILMCRAFT_CATALOG.entries.length).toBeGreaterThan(0);
    for (const entry of FILMCRAFT_CATALOG.entries) {
      const result = appendFilmcraftResearch(createDevelopment(project.id, draftId), entry);
      expect(result.error, entry.id).toBeNull();
      expect(result.data.researchNotes[0].notes).toContain(entry.prompt);
    }
  });
  it('searches aliases, folds accents/punctuation and intersects category/kind filters', () => {
    const index = createFilmcraftIndex([fixture, { ...fixture, id: 'second', title: 'Other camera', category: 'camera', kind: 'technical', aliases: ['Térm—alias'] }]);
    expect(searchFilmcraft({ query: 'alternate label' }, index).map(item => item.id)).toEqual(['test-entry']);
    expect(searchFilmcraft({ query: 'TERM alias' }, index).map(item => item.id)).toEqual(['second']);
    expect(searchFilmcraft({ category: 'story', kind: 'technical' }, index)).toEqual([]);
    expect(searchFilmcraft({ category: 'camera', kind: 'technical' }, index).map(item => item.id)).toEqual(['second']);
  });
  it('keeps existing text exact, includes caveats and attribution, and deduplicates an unchanged reference', () => {
    const data = developmentRecord().data;
    const original = JSON.stringify(data);
    const next = appendFilmcraftResearch(data, fixture);
    expect(JSON.stringify(data)).toBe(original);
    expect(next.data.researchNotes[0]).toEqual(data.researchNotes[0]);
    expect(next.data.researchNotes[1]).toMatchObject({ title: fixture.title, notes: expect.stringContaining(fixture.prompt), source: expect.stringContaining('Test source · slide 3') });
    expect(next.data.researchNotes[1].notes).toContain(fixture.caveats[0]);
    expect(appendFilmcraftResearch(next.data, fixture)).toMatchObject({ added: false, data: next.data, error: null });
    expect(filmcraftSourceUrl({ title: 'Unsafe', url: 'javascript:alert(1)' })).toBeNull();
    expect(filmcraftSourceUrl({ title: 'PDF', url: 'https://example.com/file.pdf', slideNumber: 7 })).toBe('https://example.com/file.pdf#page=7');
    expect(filmcraftSourceLabel({ title: 'Source — slide 45', url: 'https://example.com/slides', slideNumber: 45 })).toBe('Source — slide 45');
  });
  it('shows source links marked online and keeps unsaved drafts read-only for research', () => {
    const entry = FILMCRAFT_CATALOG.entries.find(item => item.aliases.length)!;
    const add = vi.fn();
    render(<FilmcraftPanel browse={{ query: entry.aliases[0] }} canAddResearch={false} onAddResearch={add} />);
    expect(screen.getByRole('heading', { level: 3 })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add to research' })).toBeDisabled();
    expect(screen.getByText(/Save this screenplay first/)).toBeInTheDocument();
    fireEvent.click(screen.getByText('Caveats & sources'));
    const sources = screen.getAllByRole('link', { name: /online/ });
    expect(sources[0]).toHaveAttribute('target', '_blank');
    expect(sources[0]).toHaveAttribute('rel', 'noopener noreferrer');
    expect(sources[0].getAttribute('href')).toMatch(/^https?:/);
    fireEvent.click(screen.getByRole('button', { name: 'Add to research' }));
    expect(add).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });
  it('filters real results, announces zero matches and clears filters', () => {
    render(<FilmcraftPanel canAddResearch onAddResearch={() => ({ ok: true, message: 'Added' })} />);
    fireEvent.change(screen.getByLabelText('Category'), { target: { value: 'sound' } });
    fireEvent.change(screen.getByLabelText('Kind'), { target: { value: 'term' } });
    const expected = searchFilmcraft({ category: 'sound', kind: 'term' });
    expect(within(screen.getByRole('navigation', { name: 'Film language results' })).getAllByRole('button')).toHaveLength(expected.length);
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search film language' }), { target: { value: 'zzzz-no-such-reference' } });
    expect(screen.getByText('No matching film language.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Browse all entries' }));
    expect(screen.getByRole('searchbox')).toHaveValue('');
    expect(screen.getByLabelText('Category')).toHaveValue('all'); expect(fetch).not.toHaveBeenCalled();
  });
});

describe('writer and development integration', () => {
  it('keeps Film language open when a research addition is blocked by unresolved development recovery', async () => {
    const dev = developmentRecord();
    vi.mocked(localApi.developmentRecovery.get).mockResolvedValue(recovery('Waiting recovery', '2026-09-26T12:00:00.000Z'));
    render(<WriterDesk project={project} open={{ id: draftId, saved: draft, initial: null }} records={[draft, dev]} onSaved={vi.fn()} onRecordsChanged={vi.fn()} />);
    await act(async () => {});
    tab('Film language'); fireEvent.click(screen.getByRole('button', { name: 'Add to research' }));
    expect(screen.getByRole('tab', { name: 'Film language' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('searchbox', { name: 'Search film language' })).toBeVisible();
    expect(localApi.save).not.toHaveBeenCalled();
    expect(localApi.developmentRecovery.put).not.toHaveBeenCalled();
  });

  it('adds to current research only on click, opens Develop, preserves pending text and waits for Save development', async () => {
    const dev = developmentRecord();
    render(<WriterDesk project={project} open={{ id: draftId, saved: draft, initial: null }} records={[draft, dev]} onSaved={vi.fn()} onRecordsChanged={vi.fn()} />);
    await act(async () => {});
    tab('Develop');
    fireEvent.change(screen.getByRole('textbox', { name: 'Concept' }), { target: { value: 'Pending concept' } });
    tab('World & research');
    fireEvent.change(screen.getByRole('textbox', { name: 'Research 1 notes' }), { target: { value: 'Pending research\n exact text.' } });
    tab('Film language');
    const title = within(screen.getByRole('article')).getByRole('heading', { level: 3 }).textContent!;
    expect(localApi.save).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Add to research' }));
    expect(screen.getByRole('tab', { name: 'Develop' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('textbox', { name: 'Research 1 notes' })).toHaveValue('Pending research\n exact text.');
    expect(screen.getByRole('textbox', { name: 'Research 2 title' })).toHaveValue(title);
    expect(localApi.save).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Save development' }));
    await waitFor(() => expect(localApi.save).toHaveBeenCalledTimes(1));
    expect(vi.mocked(localApi.save).mock.calls[0][0]).toMatchObject({ kind: 'story-development', expectedVersion: 1, data: { concept: 'Pending concept', researchNotes: [expect.objectContaining({ notes: 'Pending research\n exact text.' }), expect.objectContaining({ title })] } });
    tab('Write'); fireEvent.click(screen.getByRole('button', { name: 'Fountain' }));
    expect(screen.getByRole('textbox', { name: 'Fountain screenplay' })).toHaveValue(draft.data.body);
  }, 15000);
  it('uses contextual links and seeds reference search from a selected screenplay term', async () => {
    render(<WriterDesk project={project} open={{ id: draftId, saved: draft, initial: null }} records={[draft]} onSaved={vi.fn()} onRecordsChanged={vi.fn()} />);
    await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: 'Fountain' }));
    const input = screen.getByRole('textbox', { name: 'Fountain screenplay' }) as HTMLTextAreaElement;
    await act(async () => new Promise(resolve => setTimeout(resolve, 30)));
    act(() => input.focus()); fireEvent.mouseDown(input); input.setSelectionRange(0, 8); fireEvent.mouseUp(input); fireEvent.select(input);
    tab('Film language');
    expect(screen.getByRole('searchbox')).toHaveValue('Original');
    tab('Develop'); tab('Characters'); fireEvent.click(screen.getByRole('button', { name: 'Character & motivation' }));
    expect(screen.getByRole('searchbox')).toHaveValue('character'); expect(screen.getByLabelText('Category')).toHaveValue('story');
  });
  it('makes library usable for a new draft without permitting research writes', async () => {
    render(<WriterDesk project={project} open={{ id: draftId, saved: null, initial: draft.data }} records={[]} onSaved={vi.fn()} onRecordsChanged={vi.fn()} />);
    await act(async () => {});
    tab('Film language');
    expect(screen.getByRole('button', { name: 'Add to research' })).toBeDisabled();
    expect(screen.getByRole('searchbox')).toBeEnabled(); expect(localApi.save).not.toHaveBeenCalled();
  });
  it('rejects cross-draft research callbacks and does not modify an unresolved recovery offer', async () => {
    const copy = recovery('Recovery waiting', '2026-09-26T12:00:00.000Z');
    vi.mocked(localApi.developmentRecovery.get).mockResolvedValue(copy);
    const ref = createRef<DevelopmentPanelHandle>();
    render(<DevelopmentPanel ref={ref} projectId={project.id} draftId={draftId} initialRecord={developmentRecord()} onSaved={vi.fn()} />);
    await act(async () => {});
    expect(ref.current!.addResearch({ projectId: project.id, draftId: otherId, entryId: FILMCRAFT_CATALOG.entries[0].id }).ok).toBe(false);
    expect(ref.current!.addResearch({ projectId: project.id, draftId, entryId: FILMCRAFT_CATALOG.entries[0].id }).message).toMatch(/recovery/);
    expect(localApi.developmentRecovery.put).not.toHaveBeenCalled(); expect(localApi.save).not.toHaveBeenCalled();
  });
  it('routes native Save and Cmd/Ctrl+S to development while Develop is active', async () => {
    render(<WriterDesk project={project} open={{ id: draftId, saved: draft, initial: null }} records={[draft]} onSaved={vi.fn()} onRecordsChanged={vi.fn()} />);
    await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: 'Fountain' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Fountain screenplay' }), { target: { value: 'Pending screenplay' } });
    tab('Develop'); fireEvent.change(screen.getByRole('textbox', { name: 'Concept' }), { target: { value: 'Native save target' } });
    await act(async () => window.dispatchEvent(new CustomEvent('writer:command', { detail: 'save' })));
    expect(localApi.save).toHaveBeenCalledTimes(1);
    expect(vi.mocked(localApi.save).mock.calls[0][0].kind).toBe('story-development');
    fireEvent.change(screen.getByRole('textbox', { name: 'Concept' }), { target: { value: 'Keyboard save target' } });
    await act(async () => fireEvent.keyDown(window, { key: 's', metaKey: true }));
    expect(localApi.save).toHaveBeenCalledTimes(2);
    expect(vi.mocked(localApi.save).mock.calls[1][0].kind).toBe('story-development');
  });
});

describe('development disk recovery and native flush', () => {
  it('blocks initial editing and selects newest recovery after a browser origin changes', async () => {
    const read = deferred<DevelopmentRecovery | null>();
    vi.mocked(localApi.developmentRecovery.get).mockReturnValue(read.promise);
    render(<DevelopmentPanel projectId={project.id} draftId={draftId} initialRecord={developmentRecord()} onSaved={vi.fn()} />);
    expect(screen.getByRole('textbox', { name: 'Concept' })).toBeDisabled();
    const disk = recovery('Disk after restart', '2026-09-26T12:00:00.000Z');
    await act(async () => read.resolve(disk));
    expect(screen.getByRole('button', { name: 'Restore recovery' })).toBeEnabled();
    expect(localApi.developmentRecovery.put).not.toHaveBeenCalled();
    await act(async () => host().__flushDevelopmentRecovery!());
    expect(localApi.developmentRecovery.put).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Restore recovery' }));
    expect(screen.getByRole('textbox', { name: 'Concept' })).toHaveValue('Disk after restart');
  });
  it('chooses a newer browser offer and refuses to overwrite the older unresolved disk offer on quit', async () => {
    const browser = recovery('Browser newer', '2026-09-26T12:01:00.000Z');
    localStorage.setItem(developmentRecoveryKey(project.id, draftId), JSON.stringify(browser));
    vi.mocked(localApi.developmentRecovery.get).mockResolvedValue(recovery('Disk older', '2026-09-26T12:00:00.000Z'));
    render(<DevelopmentPanel projectId={project.id} draftId={draftId} initialRecord={developmentRecord()} onSaved={vi.fn()} />);
    await act(async () => {});
    await expect(host().__flushDevelopmentRecovery!()).rejects.toThrow(/newest copy/);
    expect(localApi.developmentRecovery.put).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Restore recovery' }));
    expect(screen.getByRole('textbox', { name: 'Concept' })).toHaveValue('Browser newer');
  });
  it('flushes immediately, serializes writes, coalesces later typing, and unregisters on unmount', async () => {
    const held = deferred<DevelopmentRecovery>();
    vi.mocked(localApi.developmentRecovery.put).mockReturnValueOnce(held.promise);
    const view = render(<DevelopmentPanel projectId={project.id} draftId={draftId} onSaved={vi.fn()} />);
    await act(async () => {});
    fireEvent.change(screen.getByRole('textbox', { name: 'Concept' }), { target: { value: 'First' } });
    let flushing: Promise<void>;
    await act(async () => { flushing = host().__flushDevelopmentRecovery!(); await Promise.resolve(); });
    expect(localApi.developmentRecovery.put).toHaveBeenCalledTimes(1);
    fireEvent.change(screen.getByRole('textbox', { name: 'Concept' }), { target: { value: 'Second' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Concept' }), { target: { value: 'Latest' } });
    expect(localApi.developmentRecovery.put).toHaveBeenCalledTimes(1);
    await act(async () => { held.resolve(vi.mocked(localApi.developmentRecovery.put).mock.calls[0][0]); await flushing; });
    expect(localApi.developmentRecovery.put).toHaveBeenCalledTimes(2);
    expect(vi.mocked(localApi.developmentRecovery.put).mock.calls[1][0].data.concept).toBe('Latest');
    view.unmount(); expect(host().__flushDevelopmentRecovery).toBeUndefined();
  });
  it('rejects a failed flush, can retry it, and conditionally deletes only a saved equivalent copy', async () => {
    const initial = developmentRecord();
    render(<DevelopmentPanel projectId={project.id} draftId={draftId} initialRecord={initial} onSaved={vi.fn()} />);
    await act(async () => {});
    fireEvent.change(screen.getByRole('textbox', { name: 'Concept' }), { target: { value: 'Durable edit' } });
    vi.mocked(localApi.developmentRecovery.put).mockRejectedValueOnce(new Error('Disk unavailable'));
    await act(async () => { await expect(host().__flushDevelopmentRecovery!()).rejects.toThrow('Disk unavailable'); });
    expect(screen.getByRole('alert')).toHaveTextContent('Disk unavailable');
    await act(async () => host().__flushDevelopmentRecovery!());
    const persisted = vi.mocked(localApi.developmentRecovery.put).mock.lastCall![0];
    fireEvent.click(screen.getByRole('button', { name: 'Save development' }));
    await waitFor(() => expect(localApi.developmentRecovery.remove).toHaveBeenCalled());
    const removedAt = vi.mocked(localApi.developmentRecovery.remove).mock.lastCall![1];
    expect(removedAt).toBeTruthy(); expect(Date.parse(removedAt!)).toBeGreaterThanOrEqual(Date.parse(persisted.savedAt));
    expect(localApi.save).toHaveBeenCalledTimes(1);
  });
  it('visibly handles an unavailable initial read and retry without losing browser edits', async () => {
    vi.mocked(localApi.developmentRecovery.get).mockRejectedValueOnce(new Error('Not connected'));
    render(<DevelopmentPanel projectId={project.id} draftId={draftId} onSaved={vi.fn()} />);
    await act(async () => {});
    fireEvent.change(screen.getByRole('textbox', { name: 'Concept' }), { target: { value: 'Browser only' } });
    await expect(host().__flushDevelopmentRecovery!()).rejects.toThrow(/Check development/);
    expect(localStorage.getItem(developmentRecoveryKey(project.id, draftId))).toContain('Browser only');
    fireEvent.click(screen.getByRole('button', { name: 'Retry disk recovery check' }));
    await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: 'Restore recovery' }));
    expect(screen.getByRole('textbox', { name: 'Concept' })).toHaveValue('Browser only');
    await act(async () => host().__flushDevelopmentRecovery!());
    expect(localApi.developmentRecovery.put).toHaveBeenCalled();
  });
});
