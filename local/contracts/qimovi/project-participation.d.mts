/** Authored drafts and hypothetical arithmetic only; no grant, payment or settlement authority. */
export interface ParticipationProject { id: string; sourceHash: string | null }
export interface ParticipationRecordRef { id: string; version: number; sha256: string }
export interface ParticipationSubject { kind: 'PROJECT' | 'ASSET' | 'RECORD'; label: string; assetHash: string | null; recordRef: ParticipationRecordRef | null }
export interface ParticipationParty { id: string; name: string; kind: 'PERSON' | 'ORGANIZATION' }
export interface ParticipationContribution { id: string; partyId: string; role: string; subject: ParticipationSubject; description: string; credit: string; evidenceHashes: string[]; budgetLineIds: string[] }
export interface ParticipationRight { id: string; partyId: string; subject: ParticipationSubject; rightType: 'COPYRIGHT' | 'LICENCE' | 'PERFORMANCE' | 'VOICE_LIKENESS' | 'DIGITAL_REPLICA' | 'OTHER'; scope: string; territory: string; term: string; jurisdiction: string; status: 'CLAIMED' | 'DOCUMENTED' | 'DISPUTED'; evidenceHashes: string[] }
export interface ParticipationAllocation { id: string; partyId: string; shareBps: number | null; agreementStatus: 'PROPOSED' | 'DOCUMENTED' | 'DISPUTED'; evidenceHashes: string[] }
export type ParticipationPoolKind = 'RECEIPTS' | 'DEFINED_PROCEEDS' | 'COPYRIGHT_INTEREST' | 'COMPANY_EQUITY';
export interface ParticipationPool { id: string; name: string; kind: ParticipationPoolKind; subject: ParticipationSubject; definition: string; entityName: string; currency: '' | 'USD' | 'CAD' | 'EUR' | 'GBP'; receiptsMinor: number | null; deductionsMinor: number | null; recoupmentMinor: number | null; allocations: ParticipationAllocation[] }
export interface ProjectParticipation { schemaVersion: 1; projectId: string; sourceHash: string | null; status: 'DRAFT'; parties: ParticipationParty[]; contributions: ParticipationContribution[]; rights: ParticipationRight[]; pools: ParticipationPool[] }
export interface ParticipationPoolCalculation { status: 'INCOMPLETE' | 'INVALID' | 'CALCULATED' | 'INTEREST_ONLY'; errors: string[]; allocatedBps: number; unallocatedBps: number; baseMinor: number | null; availableMinor: number | null; appliedRecoupmentMinor: number | null; unrecoveredMinor: number | null; unallocatedMinor: number | null; payouts: {partyId: string; amountMinor: number}[]; roundingMinor: number | null }
export interface ParticipationRecord { id: string; kind: string; version: number; sha256: string; data: Record<string, unknown> }
/** Byte lengths must be positive safe integers and agree when both aliases are supplied. */
export interface ParticipationBlob { byteLength?: number; byte_length?: number; sha256?: string; projectId?: string; sourceHash?: string | null; [key: string]: unknown }
export interface ParticipationReferenceContext { lookupRecord: (id: string, version?: number) => ParticipationRecord | null | undefined; lookupBlob: (hash: string) => ParticipationBlob | null | undefined; project?: ParticipationProject; requireCurrent?: boolean }
export function defaultParticipation(project: ParticipationProject): ProjectParticipation;
export function validateParticipation(data: unknown, project?: ParticipationProject): ProjectParticipation;
/** Unrelated record kinds and ids are ignored; a saved participation identity cannot change. */
export function validateParticipationIdentity(id: string, kind: string, data: unknown, previous?: ProjectParticipation | null): void;
/** Checks retained evidence metadata, exact record versions and saved same-project budget lines.
 * The lookup provider must verify retained bytes against the requested hash. Historical
 * validation permits older sources; any supplied project must still have the same id. */
export function validateParticipationReferences(data: ProjectParticipation, context: ParticipationReferenceContext): void;
/** Uses integer basis points (100 = 1 percent) and floors each hypothetical payout. */
export function calculateParticipationPool(pool: ParticipationPool): ParticipationPoolCalculation;
