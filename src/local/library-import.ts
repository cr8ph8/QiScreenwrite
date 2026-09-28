import type { DraftRecord, WorkspaceRecord } from './types';

export interface LibraryAsset {
  id: string; version: number; sha256: string; title: string; filename: string;
  mimeType: string; byteLength: number; contentSha256: string;
  format: 'FDX' | 'FOUNTAIN' | 'REFERENCE'; reason: string | null;
  importedDraftId: string | null;
}
export interface LibraryCatalog { project: { id: string; title: string }; assets: LibraryAsset[] }
export interface LibraryPreview { token: string; project: { id: string; title: string }; asset: LibraryAsset; text: string; expiresAt: string }
export interface LibraryImportInput { token: string; title: string; body: string; conversion: 'FDX_REVIEWED' | 'FOUNTAIN_UTF8' }
export interface LibraryImportResult { replayed: boolean; draft: DraftRecord; receipt: WorkspaceRecord<SourceImportData>; document: WorkspaceRecord<SourceDocumentData> }
export interface SourceRef { id: string; version: number; sha256: string }
export interface SourceDocumentData {
  schemaVersion: 1; projectId: string; status: 'RETAINED_REFERENCE';
  origin: { system: 'qimovi'; projectId: string; projectTitle: string; projectSourceHash: string | null; recordRef: SourceRef };
  filename: string; mimeType: string; byteLength: number; contentSha256: string; base64: string;
}
export interface SourceImportData {
  schemaVersion: 1; projectId: string; status: 'REVIEWED_WORKING_COPY';
  documentRef: SourceRef; draftRef: SourceRef;
  conversion: 'FDX_REVIEWED' | 'FOUNTAIN_UTF8'; bodySha256: string;
}
