import type { WorkspaceRecord } from './types';
export type { ProjectParticipation, ParticipationParty, ParticipationPool, ParticipationSubject, ParticipationRecordRef } from '../../local/contracts/qimovi/project-participation.mjs';
export { RIGHTS_ID, MAX_EVIDENCE_BYTES, defaultParticipation, calculateParticipationPool, projectSubject, recordRef, emptyPublicFields, validateWriterParticipation, validateTokenDraft } from '../../local/contracts/writer-rights.mjs';
export interface EvidenceData { schemaVersion: 1; projectId: string; name: string; mediaType: string; byteLength: number; sha256: string; base64: string }
export interface RightsRef { id: string; version: number; sha256: string }
export interface PublicTokenFields { name: string; description: string; imageUri: string; licenceUri: string; licenceSummary: string }
export interface TokenDraftData { schemaVersion: 1; projectId: string; status: 'DRAFT'; subjectRef: RightsRef; participationRef: RightsRef; standard: 'UNDECIDED' | 'ERC721' | 'ERC1155'; editionCap: number | null; royaltyRequestBps: number | null; publicFields: PublicTokenFields; nonce: string }
export interface TokenPreview { recordRef: RightsRef; metadata: Record<string, unknown>; metadataSha256: string; omitted: string[]; status: 'LOCAL_DRAFT'; executionEnabled: false }
export interface RightsRecovery { schemaVersion: 1; projectId: string; baseVersion: number | null; baseSha256: string | null; data: import('../../local/contracts/qimovi/project-participation.mjs').ProjectParticipation; pendingSave: import('./types').RecordInput<import('../../local/contracts/qimovi/project-participation.mjs').ProjectParticipation> | null; savedAt: string }
export const newRightsId = (kind: string) => `${kind}:${crypto.randomUUID()}`;
export function parseSharePercent(value: string): number | null {
  if (!value.trim()) return null;
  if (!/^(?:0|[1-9]\d{0,2})(?:\.\d{1,2})?$/.test(value) || Number(value) > 100) throw new Error('Use a percentage from 0 to 100 with up to two decimal places, or leave unknown.');
  const [whole, fraction = ''] = value.split('.');
  return Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
}
export const sharePercent = (bps: number | null) => bps === null ? '' : String(bps / 100);
export const randomNonce = () => [...crypto.getRandomValues(new Uint8Array(32))].map(byte => byte.toString(16).padStart(2, '0')).join('');
export const sameRef = (ref: RightsRef, record: WorkspaceRecord | undefined) => Boolean(record && ref.id === record.id && ref.version === record.version && ref.sha256 === record.sha256);
