/** An inventory of saved creative records, not an observation of remote media. */
export const MAX_PRESERVATION_BYTES = 128 * 1024 * 1024;
export interface PreservationItem { id: string; kind: string; version: number; sha256: string; title: string }
export interface PreservationPreview {
  schema: 'caniscreenwrite-preservation-preview/v1'; project: { id: string; title: string };
  sourceSha256: string; inventory: PreservationItem[]; revisionCount: number;
  recoveryCounts: { screenplay: number; development: number; rights?: number }; exclusions: string[];
}
export interface PreservationVerification {
  valid: true; schema: string; project: { id: string; title: string };
  sourceSha256: string; packageSha256: string; recordCount: number; revisionCount: number;
  exclusions: string[]; limitations: string[];
  checks: { recordHashes: true; history: true; sourceBindings: true; packageHash: true };
}
export const preservationKind: Record<string, string> = {
  'screenplay-draft': 'Screenplay', 'story-development': 'World & development',
  'shared-world': 'Shared world', 'sync-link': 'Transfer receipt', 'universe-sync': 'Universe receipt',
  'project-participation': 'Rights & collaborators', 'rights-evidence': 'Private evidence file',
  'rights-review': 'Local rights review', 'token-preparation': 'Token metadata draft',
  'source-document': 'Retained original', 'source-import': 'Reviewed import receipt',
};
