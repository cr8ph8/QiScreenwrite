import { fromFdx } from '@/lib/fountain/fdx';
import { parseScreenplay } from '@/lib/fountain/spec';
import type { LibraryImportInput, LibraryPreview } from './library-import';

export const MAX_IMPORT_BYTES = 1024 * 1024;
export const MAX_IMPORT_BODY_LENGTH = 200_000;

export interface ImportReview {
  preview: LibraryPreview;
  body: string;
  conversion: LibraryImportInput['conversion'];
  /** Null means optional statistics were skipped, not that the source has none. */
  sceneCount: number | null;
  characters: string[] | null;
}

export const conversionLabel = (conversion: LibraryImportInput['conversion']) =>
  conversion === 'FDX_REVIEWED' ? 'FDX converted to Fountain' : 'Exact UTF-8 Fountain';

export const conversionCaveat = (conversion: LibraryImportInput['conversion']) =>
  conversion === 'FDX_REVIEWED'
    ? 'FDX is converted to Fountain. Layout, fonts, pagination, and some Final Draft metadata may not carry over. Review the full text below. The original file is retained with the imported draft.'
    : 'Fountain text is kept exactly as decoded from verified UTF-8, including line endings. The original file is retained with the imported draft.';

const validText = (value: string) => !/[\0\uD800-\uDFFF]/u.test(value);
export const validImportTitle = (title: string) =>
  title.trim().length > 0 && title.length <= 200 && !/[\r\n]/.test(title) && validText(title);

function statsParseFits(body: string): boolean {
  // Match revision-compare.ts sceneParseFits bounds: the donor parser can
  // rescan consecutive headings/paragraphs. This linear check only limits
  // optional statistics; the reviewed source is always retained in full.
  let lineCount = 0, paragraphLines = 0;
  for (const [line] of body.matchAll(/[^\r\n]*(?:\r\n|\r|\n|$)/g)) {
    if (!line) continue;
    if (++lineCount > 8_000 || line.length > 4_000) return false;
    paragraphLines = line.trim() ? paragraphLines + 1 : 0;
    if (paragraphLines > 200) return false;
  }
  return true;
}

/** Validate before XML parsing, then bound the complete conversion without truncation. */
export function reviewLibraryPreview(preview: LibraryPreview, projectId: string, recordId: string): ImportReview {
  if (preview.project.id !== projectId || preview.asset.id !== recordId || !preview.token) {
    throw new Error('The preview does not match the selected project and document. Load the Library again.');
  }
  if (preview.asset.format === 'REFERENCE' || preview.asset.reason) {
    throw new Error(preview.asset.reason || 'This document is reference only. Text extraction is not available.');
  }
  if (!Number.isSafeInteger(preview.asset.byteLength) || preview.asset.byteLength < 0
    || preview.asset.byteLength > MAX_IMPORT_BYTES || new TextEncoder().encode(preview.text).byteLength > MAX_IMPORT_BYTES) {
    throw new Error('The original file exceeds the 1 MiB import limit. Nothing has been truncated or imported.');
  }
  if (!validText(preview.text)) throw new Error('The source contains unsupported text characters. Nothing has been imported.');

  let body: string;
  let conversion: LibraryImportInput['conversion'];
  if (preview.asset.format === 'FDX') {
    if (/<\s*!\s*(?:DOCTYPE|ENTITY)\b/i.test(preview.text)) {
      throw new Error('FDX files with DTD or entity declarations cannot be imported. Nothing has been imported.');
    }
    body = fromFdx(preview.text);
    conversion = 'FDX_REVIEWED';
  } else if (preview.asset.format === 'FOUNTAIN') {
    body = preview.text;
    conversion = 'FOUNTAIN_UTF8';
  } else {
    throw new Error('This document format is not supported for working drafts.');
  }
  if (body.length > MAX_IMPORT_BODY_LENGTH) {
    throw new Error('The full Fountain text exceeds the 200,000-character working draft limit. Nothing has been truncated or imported.');
  }
  if (!validText(body)) throw new Error('The conversion contains unsupported text characters. Nothing has been imported.');
  if (!statsParseFits(body)) return { preview, body, conversion, sceneCount: null, characters: null };
  const screenplay = parseScreenplay(body);
  const characters = [...new Set(screenplay.blocks.flatMap(block => block.character ? [block.character.name] : []))];
  return { preview, body, conversion, sceneCount: screenplay.scenes.length, characters };
}
