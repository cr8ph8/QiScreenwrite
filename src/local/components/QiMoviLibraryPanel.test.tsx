import { StrictMode } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { localApi, LocalApiError } from '../api';
import type { LibraryAsset, LibraryCatalog, LibraryImportResult, LibraryPreview } from '../library-import';
import { QiMoviLibraryPanel, type QiMoviLibraryPanelProps } from './QiMoviLibraryPanel';

vi.mock('../api', async importOriginal => {
  const original = await importOriginal<typeof import('../api')>();
  return { ...original, localApi: { qimovi: { library: { list: vi.fn(), preview: vi.fn(), import: vi.fn() } } } };
});

const project = { id: 'project:qimovi', title: 'Remote film' };
const asset: LibraryAsset = { id: 'project-asset:source', version: 3, sha256: 'a'.repeat(64), title: 'Original title', filename: 'original.fountain', mimeType: 'text/plain',
  byteLength: 41, contentSha256: 'b'.repeat(64), format: 'FOUNTAIN', reason: null, importedDraftId: null };
const fdx: LibraryAsset = { ...asset, id: 'project-asset:fdx', filename: 'draft.fdx', format: 'FDX' };
const pdf: LibraryAsset = { ...asset, id: 'project-asset:pdf', filename: 'reference.pdf', format: 'REFERENCE', reason: 'PDF reference only. Text extraction is unavailable.' };
const text = '\uFEFFINT. LAB - DAY\r\n\r\n@ADA\r\nHello.  \r\n';
const source: LibraryPreview = { token: 'preview-token', project, asset, text, expiresAt: '2026-09-27T23:59:59Z' };
const catalog: LibraryCatalog = { project, assets: [asset, fdx, pdf] };
const saved: LibraryImportResult = {
  replayed: false,
  draft: { id: 'screenplay-draft:imported', kind: 'screenplay-draft', version: 1, sha256: 'c'.repeat(64),
    data: { schemaVersion: 2, projectId: 'project:local', sourceHash: null, title: 'Local title', format: 'FOUNTAIN', body: text, status: 'DRAFT' } },
  receipt: { id: 'source-import:receipt', kind: 'source-import', version: 1, sha256: 'd'.repeat(64), data: { schemaVersion: 1, projectId: 'project:local', status: 'REVIEWED_WORKING_COPY',
    documentRef: { id: 'source-document:original', version: 1, sha256: 'e'.repeat(64) }, draftRef: { id: 'screenplay-draft:imported', version: 1, sha256: 'c'.repeat(64) }, conversion: 'FOUNTAIN_UTF8', bodySha256: 'f'.repeat(64) } },
  document: { id: 'source-document:original', kind: 'source-document', version: 1, sha256: 'e'.repeat(64), data: { schemaVersion: 1, projectId: 'project:local', status: 'RETAINED_REFERENCE', origin: { system: 'qimovi', projectId: project.id, projectTitle: project.title, projectSourceHash: null, recordRef: { id: asset.id, version: asset.version, sha256: asset.sha256 } }, filename: asset.filename, mimeType: asset.mimeType, byteLength: 1, contentSha256: asset.contentSha256, base64: 'YQ==' } },
};
const library = vi.mocked(localApi.qimovi.library);
const click = (name: string | RegExp) => fireEvent.click(screen.getByRole('button', { name }));
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function setup(overrides: Partial<QiMoviLibraryPanelProps> = {}) {
  const props = { project, disabled: false, onChanged: vi.fn(async () => {}), onOpenDraft: vi.fn(), ...overrides };
  return { props, ...render(<QiMoviLibraryPanel {...props} />) };
}
async function load() { click('Load Library'); await screen.findByRole('button', { name: 'Preview original.fountain' }); }
async function review() { await load(); click('Preview original.fountain'); await screen.findByLabelText('Full Fountain preview (read only)'); }

beforeEach(() => {
  vi.resetAllMocks();
  library.list.mockResolvedValue(catalog);
  library.preview.mockResolvedValue(source);
  library.import.mockResolvedValue(saved);
});
afterEach(cleanup);

describe('explicit Library review and import', () => {
  it('does not list or select automatically, filters filenames, and explains reference-only PDF', async () => {
    setup();
    expect(library.list).not.toHaveBeenCalled(); expect(library.preview).not.toHaveBeenCalled(); expect(library.import).not.toHaveBeenCalled();
    await load();
    expect(library.preview).not.toHaveBeenCalled();
    expect(screen.getByText(pdf.reason!)).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Preview reference.pdf' })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Search filenames'), { target: { value: 'DRAFT' } });
    expect(screen.getByText('draft.fdx')).toBeVisible(); expect(screen.queryByText('original.fountain')).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Document format'), { target: { value: 'FOUNTAIN' } });
    expect(screen.getByText(/No filenames match/)).toBeVisible();
    expect(library.list).toHaveBeenCalledTimes(1); expect(library.import).not.toHaveBeenCalled();
  });

  it('shows full read-only text and source identity, then sends only the explicit reviewed input', async () => {
    const { props } = setup(); await review();
    const body = screen.getByLabelText('Full Fountain preview (read only)');
    expect(body).toHaveAttribute('readonly');
    expect(body).toHaveValue(text.replace(/\r\n/g, '\n'));
    expect(screen.getByText(asset.contentSha256)).toBeVisible();
    expect(screen.getByText(`1 scenes · 1 characters · ${text.length} / 200,000 text characters`)).toBeInTheDocument();
    expect(library.import).not.toHaveBeenCalled(); expect(props.onChanged).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Local draft title'), { target: { value: '  My reviewed title  ' } });
    click('Create local working draft');
    await waitFor(() => expect(props.onChanged).toHaveBeenCalledTimes(1));
    expect(library.import).toHaveBeenCalledWith({ token: source.token, title: '  My reviewed title  ', body: text, conversion: 'FOUNTAIN_UTF8' });
    expect(props.onOpenDraft).not.toHaveBeenCalled();
    fireEvent.click(within(screen.getByRole('region', { name: 'Library import review' })).getByRole('button', { name: 'Open imported draft' }));
    expect(props.onOpenDraft).toHaveBeenCalledWith(saved.draft.id);
  });

  it('converts FDX locally and shows the conversion caveat before explicit creation', async () => {
    library.preview.mockResolvedValue({ ...source, asset: fdx, text: '<FinalDraft><Content><Paragraph Type="Action"><Text>Reviewed action.</Text></Paragraph></Content></FinalDraft>' });
    setup(); await load(); click('Preview draft.fdx');
    expect(await screen.findByLabelText('Full Fountain preview (read only)')).toHaveValue('!Reviewed action.\n');
    expect(screen.getByText(/Layout, fonts, pagination/)).toBeVisible(); expect(library.import).not.toHaveBeenCalled();
    click('Create local working draft');
    await waitFor(() => expect(library.import).toHaveBeenCalledWith({ token: source.token, title: asset.title, body: '!Reviewed action.\n', conversion: 'FDX_REVIEWED' }));
  });

  it('labels skipped statistics while allowing review and exact import of the complete source', async () => {
    const largeText = '.SCENE\r\n'.repeat(201);
    library.preview.mockResolvedValue({ ...source, text: largeText, asset: { ...asset, byteLength: largeText.length } });
    setup(); await review();
    expect(screen.getByText(/Scene and character statistics unavailable/)).toBeVisible();
    expect(screen.queryByText('Characters in the preview')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Full Fountain preview (read only)')).toHaveValue(largeText.replace(/\r\n/g, '\n'));
    expect(screen.getByRole('button', { name: 'Create local working draft' })).toBeEnabled();
    click('Create local working draft');
    await waitFor(() => expect(library.import).toHaveBeenCalledWith({ token: source.token, title: asset.title, body: largeText, conversion: 'FOUNTAIN_UTF8' }));
  });

  it.each([
    '<!DOCTYPE FinalDraft><FinalDraft><Content/></FinalDraft>', '<FinalDraft><Content>',
    `<FinalDraft><Content><Paragraph><Text>${'x'.repeat(200_001)}</Text></Paragraph></Content></FinalDraft>`,
  ])('never offers create for rejected XML or oversized conversion', async bad => {
    library.preview.mockResolvedValue({ ...source, asset: fdx, text: bad });
    setup(); await load(); click('Preview draft.fdx');
    await screen.findByRole('alert');
    expect(screen.queryByRole('button', { name: 'Create local working draft' })).not.toBeInTheDocument(); expect(library.import).not.toHaveBeenCalled();
  });

  it('freezes the exact input and preview after an unconfirmed save, then replays into the returned draft', async () => {
    library.import.mockRejectedValueOnce(new Error('Response lost.')).mockResolvedValueOnce({ ...saved, replayed: true, draft: { ...saved.draft, version: 5, data: { ...saved.draft.data, title: 'Later working title', body: 'Later edits.' } } });
    const { props } = setup(); await review(); click('Create local working draft');
    await screen.findByRole('button', { name: 'Retry same import' });
    const input = library.import.mock.calls[0][0];
    expect(Object.isFrozen(input)).toBe(true);
    expect(screen.getByLabelText('Local draft title')).toHaveAttribute('readonly');
    expect(screen.getByRole('button', { name: 'Load Library' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Preview draft.fdx' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Local draft title'), { target: { value: 'Must not change' } });
    click('Retry same import');
    await screen.findByText(/This import was already saved/);
    expect(library.import.mock.calls[1][0]).toBe(input);
    expect(screen.getByLabelText('Full Fountain preview (read only)')).toHaveValue(text.replace(/\r\n/g, '\n'));
    expect(screen.getByText(/existing draft may contain later edits/)).toBeVisible();
    expect(props.onOpenDraft).not.toHaveBeenCalled();
  });

  it.each(['QIMOVI_LIBRARY_PREVIEW_EXPIRED', 'QIMOVI_LIBRARY_STALE', 'QIMOVI_LIBRARY_ALREADY_IMPORTED'])('allows catalog reload after a definite %s rejection while retaining the review', async code => {
    library.import.mockRejectedValue(new LocalApiError('Review needs a Library reload.', 409, code));
    setup(); await review(); click('Create local working draft'); await screen.findByRole('alert');
    expect(screen.getByLabelText('Full Fountain preview (read only)')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Create local working draft' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Load Library' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'Retry same import' })).not.toBeInTheDocument();
  });

  it('keeps a confirmed saved result when refresh fails and retries only the refresh', async () => {
    const onChanged = vi.fn().mockRejectedValueOnce(new Error('Refresh failed.')).mockResolvedValueOnce(undefined);
    setup({ onChanged }); await review(); click('Create local working draft');
    await screen.findByRole('button', { name: 'Refresh local drafts' });
    expect(screen.getByText(/Local working draft created/)).toBeVisible();
    expect(screen.queryByRole('button', { name: /Create local|Retry same/ })).not.toBeInTheDocument();
    click('Refresh local drafts');
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(2));
    expect(library.import).toHaveBeenCalledTimes(1);
  });

  it('requires saved parent state for creation and opening while allowing read-only review', async () => {
    const { props, rerender } = setup({ disabled: true }); await review();
    expect(screen.getByRole('button', { name: 'Create local working draft' })).toBeDisabled();
    click('Create local working draft'); expect(library.import).not.toHaveBeenCalled();
    rerender(<QiMoviLibraryPanel {...props} disabled={false} />); click('Create local working draft');
    await screen.findByText(/Local working draft created/);
    rerender(<QiMoviLibraryPanel {...props} disabled />);
    for (const button of screen.getAllByRole('button', { name: 'Open imported draft' })) expect(button).toBeDisabled();
  });

  it('can open an already imported catalog entry without a preview or new import', async () => {
    library.list.mockResolvedValue({ project, assets: [{ ...asset, importedDraftId: 'screenplay-draft:previous' }] });
    const { props } = setup(); await load(); click('Open imported draft');
    expect(props.onOpenDraft).toHaveBeenCalledWith('screenplay-draft:previous'); expect(library.preview).not.toHaveBeenCalled(); expect(library.import).not.toHaveBeenCalled();
  });

  it('keeps an unconfirmed retry frozen while parent edits are unsaved', async () => {
    library.import.mockRejectedValueOnce(new Error('Response lost.'));
    const { props, rerender } = setup(); await review(); click('Create local working draft');
    await screen.findByRole('button', { name: 'Retry same import' });
    const input = library.import.mock.calls[0][0];
    rerender(<QiMoviLibraryPanel {...props} disabled />);
    expect(screen.getByRole('button', { name: 'Retry same import' })).toBeDisabled();
    click('Retry same import'); expect(library.import).toHaveBeenCalledTimes(1);
    rerender(<QiMoviLibraryPanel {...props} disabled={false} />);
    click('Retry same import'); await screen.findByText(/Local working draft created/);
    expect(library.import.mock.calls[1][0]).toBe(input);
  });

  it('shows a supported document’s size restriction without allowing preview', async () => {
    library.list.mockResolvedValue({ project, assets: [{ ...asset, byteLength: 1_048_577, reason: 'This original exceeds the 1 MiB retained-document limit.' }] });
    setup(); click('Load Library'); await screen.findByText(/exceeds the 1 MiB retained-document limit/);
    expect(screen.queryByRole('button', { name: 'Preview original.fountain' })).not.toBeInTheDocument(); expect(library.preview).not.toHaveBeenCalled();
  });
});

describe('async Library session boundaries', () => {
  it('does not create if parent edits become unsaved while a preview is loading', async () => {
    const waiting = deferred<LibraryPreview>(); library.preview.mockReturnValue(waiting.promise);
    const { props, rerender } = setup(); await load(); click('Preview original.fountain');
    rerender(<QiMoviLibraryPanel {...props} disabled />);
    await act(async () => waiting.resolve(source));
    expect(screen.getByRole('button', { name: 'Create local working draft' })).toBeDisabled();
    expect(library.import).not.toHaveBeenCalled();
  });

  it('blocks duplicate submits and changes to the review while saving', async () => {
    const waiting = deferred<LibraryImportResult>(); library.import.mockReturnValue(waiting.promise);
    setup(); await review();
    const create = screen.getByRole('button', { name: 'Create local working draft' });
    act(() => { fireEvent.click(create); fireEvent.click(create); });
    expect(library.import).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Preview draft.fdx' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Load Library' })).toBeDisabled();
    expect(screen.getByLabelText('Local draft title')).toHaveAttribute('readonly');
    await act(async () => waiting.resolve(saved));
  });

  it('ignores an older preview arriving after a newer selection and blocks create while loading', async () => {
    const first = deferred<LibraryPreview>(), second = deferred<LibraryPreview>();
    library.preview.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    setup(); await load(); click('Preview original.fountain'); click('Preview draft.fdx');
    expect(screen.queryByRole('button', { name: 'Create local working draft' })).not.toBeInTheDocument();
    await act(async () => second.resolve({ ...source, asset: fdx, text: '<FinalDraft><Content><Paragraph><Text>Latest review.</Text></Paragraph></Content></FinalDraft>' }));
    expect(screen.getByLabelText('Full Fountain preview (read only)')).toHaveValue('!Latest review.\n');
    await act(async () => first.resolve(source));
    expect(screen.getByLabelText('Full Fountain preview (read only)')).toHaveValue('!Latest review.\n'); expect(library.import).not.toHaveBeenCalled();
  });

  it('does not let stale request cleanup unlock a newer preview request', async () => {
    const first = deferred<LibraryPreview>(), second = deferred<LibraryPreview>();
    library.preview.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    setup(); await load(); click('Preview original.fountain'); click('Preview draft.fdx');
    await act(async () => first.reject(new Error('Old failure.')));
    expect(screen.getByText('Loading and converting the selected document…')).toBeVisible();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument(); expect(screen.getByRole('button', { name: 'Load Library' })).toBeDisabled();
    await act(async () => second.resolve({ ...source, asset: fdx, text: '<FinalDraft><Content/></FinalDraft>' }));
  });

  it('invalidates an in-flight catalog even after switching back to the same project', async () => {
    const waiting = deferred<LibraryCatalog>(); library.list.mockReturnValueOnce(waiting.promise);
    const { props, rerender } = setup(); click('Load Library');
    rerender(<QiMoviLibraryPanel {...props} project={{ id: 'project:other', title: 'Other' }} />);
    rerender(<QiMoviLibraryPanel {...props} />);
    await act(async () => waiting.resolve(catalog));
    expect(screen.queryByText(asset.filename)).not.toBeInTheDocument(); expect(library.list).toHaveBeenCalledTimes(1);
  });

  it.each(['resolve', 'reject'] as const)('invalidates an in-flight preview on project change: %s', async outcome => {
    const waiting = deferred<LibraryPreview>(); library.preview.mockReturnValue(waiting.promise);
    const { props, rerender } = setup(); await load(); click('Preview original.fountain');
    rerender(<QiMoviLibraryPanel {...props} project={{ id: 'project:other', title: 'Other' }} />);
    await act(async () => { if (outcome === 'resolve') waiting.resolve(source); else waiting.reject(new Error('Old error.')); });
    expect(screen.queryByLabelText('Full Fountain preview (read only)')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument(); expect(library.import).not.toHaveBeenCalled();
  });

  it('clears an existing review on project change without automatic loading', async () => {
    const { props, rerender } = setup(); await review();
    rerender(<QiMoviLibraryPanel {...props} project={{ id: 'project:other', title: 'Other' }} />);
    expect(screen.queryByLabelText('Full Fountain preview (read only)')).not.toBeInTheDocument(); expect(library.list).toHaveBeenCalledTimes(1);
  });

  it('does not publish old import success or call callbacks after project change', async () => {
    const waiting = deferred<LibraryImportResult>(); library.import.mockReturnValue(waiting.promise);
    const { props, rerender } = setup(); await review(); click('Create local working draft');
    expect(screen.getByRole('button', { name: 'Saving local working draft…' })).toBeDisabled();
    rerender(<QiMoviLibraryPanel {...props} project={{ id: 'project:other', title: 'Other' }} />);
    await act(async () => waiting.resolve(saved));
    expect(props.onChanged).not.toHaveBeenCalled(); expect(props.onOpenDraft).not.toHaveBeenCalled();
    expect(screen.queryByText(/Local working draft created/)).not.toBeInTheDocument();
  });

  it('does not handle a completed import after unmount', async () => {
    const waiting = deferred<LibraryImportResult>(); library.import.mockReturnValue(waiting.promise);
    const { props, unmount } = setup(); await review(); click('Create local working draft'); unmount();
    await act(async () => waiting.resolve(saved));
    expect(props.onChanged).not.toHaveBeenCalled(); expect(props.onOpenDraft).not.toHaveBeenCalled();
  });

  it('works under StrictMode without effect-driven requests', async () => {
    render(<StrictMode><QiMoviLibraryPanel project={project} disabled={false} onChanged={vi.fn(async () => {})} /></StrictMode>);
    expect(library.list).not.toHaveBeenCalled(); await review();
    expect(screen.getByLabelText('Full Fountain preview (read only)')).toBeVisible(); expect(library.preview).toHaveBeenCalledTimes(1);
  });

  it('rejects a catalog for a different project', async () => {
    library.list.mockResolvedValue({ ...catalog, project: { id: 'project:other', title: 'Other' } });
    setup(); click('Load Library'); await screen.findByRole('alert');
    expect(screen.queryByRole('button', { name: 'Preview original.fountain' })).not.toBeInTheDocument();
  });
});
