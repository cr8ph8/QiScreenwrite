import { describe, expect, it, vi } from 'vitest';
import * as fountain from '@/lib/fountain/spec';
import { MAX_IMPORT_BODY_LENGTH, MAX_IMPORT_BYTES, reviewLibraryPreview, validImportTitle } from './import-review';
import type { LibraryPreview } from './library-import';

function preview(text: string, format: 'FDX' | 'FOUNTAIN' = 'FOUNTAIN'): LibraryPreview {
  return { token: 'review-token', project: { id: 'project:remote', title: 'Remote' }, expiresAt: '2026-09-27T20:00:00Z', text,
    asset: { id: 'project-asset:source', version: 3, sha256: 'a'.repeat(64), title: 'Source', filename: format === 'FDX' ? 'source.fdx' : 'source.fountain',
      mimeType: 'text/plain', byteLength: new TextEncoder().encode(text).length, contentSha256: 'b'.repeat(64), format, reason: null, importedDraftId: null } };
}
const review = (value: LibraryPreview) => reviewLibraryPreview(value, 'project:remote', 'project-asset:source');

describe('bounded Library conversion review', () => {
  it('preserves BOM, mixed endings, Unicode, whitespace and full Fountain text while summarizing it', () => {
    const text = '\uFEFFTitle: Café 🌙\r\n\r\nINT. LAB - DAY\r\n\r\n@ADA\r\nHello.  \n\nEXT. DOCK - NIGHT\r\n';
    const result = review(preview(text));
    expect(result.body).toBe(text);
    expect(result.conversion).toBe('FOUNTAIN_UTF8');
    expect(result.sceneCount).toBe(2);
    expect(result.characters).toEqual(['ADA']);
  });

  it('uses the existing FDX conversion including dialogue and scene numbers', () => {
    const text = '<FinalDraft><Content><Paragraph Type="Scene Heading" Number="4"><Text>INT. LAB - DAY</Text></Paragraph><Paragraph Type="Character"><Text>Ada</Text></Paragraph><Paragraph Type="Dialogue"><Text>Hello &amp; welcome.</Text></Paragraph></Content></FinalDraft>';
    const result = review(preview(text, 'FDX'));
    expect(result.body).toBe('INT. LAB - DAY #4#\n\n@Ada\nHello & welcome.\n');
    expect(result.conversion).toBe('FDX_REVIEWED');
    expect(result.sceneCount).toBe(1);
    expect(result.characters).toEqual(['Ada']);
  });

  it.each([
    '<!DOCTYPE FinalDraft SYSTEM "file:///private/source"><FinalDraft><Content/></FinalDraft>',
    '<!DOCTYPE FinalDraft [<!ENTITY word "expanded">]><FinalDraft><Content/></FinalDraft>',
    '<!ENTITY word SYSTEM "https://example.test/source"><FinalDraft><Content/></FinalDraft>',
    '<!doctype FinalDraft><FinalDraft><Content/></FinalDraft>',
  ])('rejects declarations before invoking any XML parser: %s', text => {
    const parse = vi.spyOn(DOMParser.prototype, 'parseFromString');
    try { expect(() => review(preview(text, 'FDX'))).toThrow(/DTD or entity/); expect(parse).not.toHaveBeenCalled(); }
    finally { parse.mockRestore(); }
  });

  it.each(['<FinalDraft><Content>', '<html/>', '<FinalDraft/>', '<FinalDraft><Content><Paragraph><Text>&unknown;</Text></Paragraph></Content></FinalDraft>'])('rejects malformed or unsupported XML: %s', text => {
    expect(() => review(preview(text, 'FDX'))).toThrow(/Final Draft/);
  });

  it('allows the body boundary and rejects larger text without slicing', () => {
    expect(review(preview('x'.repeat(MAX_IMPORT_BODY_LENGTH))).body.length).toBe(MAX_IMPORT_BODY_LENGTH);
    expect(() => review(preview('x'.repeat(MAX_IMPORT_BODY_LENGTH + 1)))).toThrow(/200,000.*Nothing has been truncated/);
  });

  it.each([
    ['many physical lines', 'Action.\n\n'.repeat(4_001)],
    ['consecutive headings', '.SCENE\r\n'.repeat(201)],
    ['consecutive paragraph lines', 'action\r'.repeat(201)],
    ['long line', 'x'.repeat(4_001)],
    ['maximum body', 'x'.repeat(MAX_IMPORT_BODY_LENGTH)],
  ])('skips optional parser work for %s while preserving the complete source', (_name, text) => {
    const parse = vi.spyOn(fountain, 'parseScreenplay');
    try {
      const result = review(preview(text));
      expect(parse).not.toHaveBeenCalled();
      expect(result.sceneCount).toBeNull(); expect(result.characters).toBeNull();
      expect(result.body).toBe(text); expect(result.conversion).toBe('FOUNTAIN_UTF8');
    } finally { parse.mockRestore(); }
  });

  it('also skips statistics for a long FDX conversion while retaining the full conversion', () => {
    const text = `<FinalDraft><Content><Paragraph><Text>${'x'.repeat(4_000)}</Text></Paragraph></Content></FinalDraft>`;
    const parse = vi.spyOn(fountain, 'parseScreenplay');
    try {
      const result = review(preview(text, 'FDX'));
      expect(parse).not.toHaveBeenCalled(); expect(result.sceneCount).toBeNull();
      expect(result.body).toBe(`!${'x'.repeat(4_000)}\n`); expect(result.conversion).toBe('FDX_REVIEWED');
    } finally { parse.mockRestore(); }
  });

  it('bounds FDX after escaped Fountain conversion expands the original text', () => {
    const text = `<FinalDraft><Content><Paragraph Type="Action"><Text>${'_'.repeat(100_001)}</Text></Paragraph></Content></FinalDraft>`;
    expect(new TextEncoder().encode(text).length).toBeLessThan(MAX_IMPORT_BYTES);
    expect(() => review(preview(text, 'FDX'))).toThrow(/200,000/);
  });

  it('checks both declared original size and actual UTF-8 byte size', () => {
    const value = preview('small'); value.asset.byteLength = MAX_IMPORT_BYTES + 1;
    expect(() => review(value)).toThrow(/1 MiB/);
    const tooManyBytes = preview('é'.repeat(MAX_IMPORT_BYTES / 2 + 1)); tooManyBytes.asset.byteLength = 4;
    expect(() => review(tooManyBytes)).toThrow(/1 MiB/);
  });

  it('rejects reference documents and mismatched project/document bindings', () => {
    const value = preview('reference'); value.asset.format = 'REFERENCE'; value.asset.reason = 'PDF text extraction is unavailable.';
    expect(() => review(value)).toThrow(/PDF text extraction is unavailable/);
    expect(() => reviewLibraryPreview(preview('text'), 'project:other', 'project-asset:source')).toThrow(/does not match/);
    expect(() => reviewLibraryPreview(preview('text'), 'project:remote', 'project-asset:other')).toThrow(/does not match/);
  });

  it.each(['\0', '\uD800', '\uDC00'])('rejects unsupported text without replacing it', text => {
    expect(() => review(preview(text))).toThrow(/unsupported text/);
  });

  it('validates the exact title that will be sent', () => {
    for (const title of ['', '   ', 'line\nbreak', 'x'.repeat(201), '\uD800', 'null\0']) expect(validImportTitle(title)).toBe(false);
    for (const title of ['  Café 🌙  ', 'x'.repeat(200)]) expect(validImportTitle(title)).toBe(true);
  });
});
