import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ImportedSourcePanel } from './ImportedSourcePanel';
import type { SourceDocumentData, SourceImportData } from '../library-import';
import type { WorkspaceRecord } from '../types';

const originalText = '\uFEFFTitle: Café 🌙\r\n\r\nINT. LAB - DAY\r\n\r\nOriginal.  \r\n';
const originalBytes = new TextEncoder().encode(originalText);
const originalBase64 = btoa(String.fromCharCode(...originalBytes));
const source: WorkspaceRecord<SourceDocumentData> = {
  id: 'source-document:original', kind: 'source-document', version: 2, sha256: 'a'.repeat(64),
  data: { schemaVersion: 1, projectId: 'project:local', status: 'RETAINED_REFERENCE',
    origin: { system: 'qimovi', projectId: 'project:remote', projectTitle: 'Remote film', projectSourceHash: null, recordRef: { id: 'project-asset:remote', version: 7, sha256: 'b'.repeat(64) } },
    filename: 'Original Café.fountain', mimeType: 'text/plain', byteLength: originalBytes.length, contentSha256: 'c'.repeat(64), base64: originalBase64 },
};
const receipt: WorkspaceRecord<SourceImportData> = {
  id: 'source-import:receipt', kind: 'source-import', version: 1, sha256: 'd'.repeat(64),
  data: { schemaVersion: 1, projectId: 'project:local', status: 'REVIEWED_WORKING_COPY',
    documentRef: { id: source.id, version: source.version, sha256: source.sha256 }, draftRef: { id: 'screenplay-draft:working', version: 1, sha256: 'e'.repeat(64) }, conversion: 'FOUNTAIN_UTF8', bodySha256: 'f'.repeat(64) },
};
const records: WorkspaceRecord[] = [source, receipt];
const createObjectURL = vi.fn((_blob: Blob) => 'blob:http://localhost/retained-original');
const revokeObjectURL = vi.fn();
let clicked: { href: string; filename: string; rel: string }[];
const mount = (items = records, draftId = receipt.data.draftRef.id) => render(<ImportedSourcePanel draftId={draftId} records={items} />);

beforeEach(() => {
  vi.useFakeTimers();
  clicked = [];
  createObjectURL.mockClear(); revokeObjectURL.mockClear();
  vi.stubGlobal('URL', class extends URL { static createObjectURL = createObjectURL; static revokeObjectURL = revokeObjectURL; });
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { clicked.push({ href: this.href, filename: this.download, rel: this.rel }); });
});
afterEach(() => { cleanup(); if (vi.isFakeTimers()) vi.runOnlyPendingTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('retained import source display', () => {
  it('links the exact source, draft and receipt revisions while preserving working-copy status', () => {
    mount();
    expect(screen.getByText(source.data.filename)).toBeVisible();
    expect(screen.getByText('QiMovi project: Remote film')).toBeVisible();
    expect(screen.getByText(/local working copy, not QiMovi’s canonical source/)).toBeVisible();
    expect(screen.getByText('Imported working draft v1')).toBeVisible();
    expect(screen.getByText('Exact UTF-8 Fountain')).toBeVisible();
    fireEvent.click(screen.getByText('Saved source and import receipt'));
    for (const text of [receipt.id, source.id, source.data.origin.recordRef.id, receipt.data.draftRef.id, 'v7', source.data.contentSha256, receipt.data.bodySha256, source.data.origin.recordRef.sha256]) {
      expect(screen.getByText(text)).toBeInTheDocument();
    }
    expect(document.body.textContent).not.toContain(originalBase64);
    expect(createObjectURL).not.toHaveBeenCalled(); expect(document.querySelector('a')).toBeNull();
  });

  it('displays the user-reviewed FDX caveat without claiming complete conversion fidelity', () => {
    mount([source, { ...receipt, data: { ...receipt.data, conversion: 'FDX_REVIEWED' } }]);
    expect(screen.getByText('FDX converted to Fountain')).toBeVisible();
    expect(screen.getByText(/User-reviewed Fountain conversion.*layout and metadata may differ/)).toBeVisible();
  });

  it('does not show another draft’s source or unrelated private record data', () => {
    mount([...records, { id: 'unrelated', kind: 'other', version: 1, sha256: 'a'.repeat(64), data: { secret: 'unrelated private text' } }], 'screenplay-draft:other');
    expect(screen.getByText('No retained import source is linked to this draft.')).toBeVisible();
    expect(screen.queryByText(source.data.filename)).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain('unrelated private text');
  });

  it.each([
    { ...source, version: 3 },
    { ...source, sha256: '9'.repeat(64) },
    { ...source, data: { ...source.data, projectId: 'project:other' } },
  ])('refuses to substitute a different source revision, hash or project', replacement => {
    mount([receipt, replacement]);
    expect(screen.getByRole('alert')).toHaveTextContent('The exact retained source document revision is unavailable.');
    expect(screen.queryByRole('button', { name: 'Download retained original' })).not.toBeInTheDocument();
    expect(screen.getByText(receipt.data.documentRef.sha256)).toBeInTheDocument();
  });

  it('finds the exact linked document even when a newer revision comes first', () => {
    mount([{ ...source, version: 3, data: { ...source.data, filename: 'Newer copy.fountain' } }, ...records]);
    expect(screen.getByText(source.data.filename)).toBeVisible();
    expect(screen.queryByText('Newer copy.fountain')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Download retained original' })).toBeEnabled();
  });
});

describe('retained original downloads', () => {
  it('downloads exact retained bytes through a local Blob, preserving BOM, Unicode and line endings', async () => {
    vi.useFakeTimers(); mount();
    fireEvent.click(screen.getByRole('button', { name: 'Download retained original' }));
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    const blob = createObjectURL.mock.calls[0][0] as Blob;
    expect(blob.type).toBe(source.data.mimeType); expect(blob.size).toBe(originalBytes.length);
    // FileReader is jsdom's native Blob reader; this verifies the download bytes,
    // not a decoded string that could conceal changed BOM or newline bytes.
    act(() => vi.advanceTimersByTime(1000));
    vi.useRealTimers();
    const bytes = await new Promise<Uint8Array>((resolve, reject) => {
      const reader = new FileReader(); reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer)); reader.onerror = () => reject(reader.error); reader.readAsArrayBuffer(blob);
    });
    expect([...bytes]).toEqual([...originalBytes]);
    expect(clicked).toEqual([{ href: 'blob:http://localhost/retained-original', filename: source.data.filename, rel: 'noopener' }]);
    expect(document.querySelector('a')).toBeNull();
    expect(screen.getByRole('status')).toHaveTextContent('prepared for local download');
  });

  it('releases the Blob URL after the download has been initiated', () => {
    vi.useFakeTimers(); mount(); fireEvent.click(screen.getByRole('button', { name: 'Download retained original' }));
    expect(revokeObjectURL).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1000));
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:http://localhost/retained-original');
  });

  it.each([
    { base64: '%%%INVALID%%%' },
    { byteLength: originalBytes.length + 1 },
    { filename: '/private/source.fountain' },
    { filename: '..\\source.fountain' },
  ])('reports unavailable or invalid retained bytes without creating a link', patch => {
    mount([{ ...source, data: { ...source.data, ...patch } }, receipt]);
    fireEvent.click(screen.getByRole('button', { name: 'Download retained original' }));
    expect(screen.getByRole('alert')).toBeVisible(); expect(createObjectURL).not.toHaveBeenCalled(); expect(clicked).toEqual([]);
  });

  it('clears download notice when changing drafts', () => {
    const view = mount(); fireEvent.click(screen.getByRole('button', { name: 'Download retained original' }));
    view.rerender(<ImportedSourcePanel records={records} draftId="screenplay-draft:other" />);
    expect(screen.queryByRole('status')).not.toBeInTheDocument(); expect(screen.queryByText(source.data.filename)).not.toBeInTheDocument();
  });
});
