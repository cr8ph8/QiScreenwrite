import { projectOwnedContext } from './creative-project.mjs';

// Attributed draft claims and hypothetical arithmetic. DOCUMENTED means that
// evidence was supplied; this module verifies neither its legal effect nor consent.
const KIND = 'project-participation';
const MAX_ROWS = 100, MAX_TOTAL_ROWS = 1000, MAX_BYTES = 512 * 1024;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const need = (ok, code, message, status = 422) => { if (!ok) throw Object.assign(new Error(message ?? code), { code, status }); };
const shape = (value, keys, code = 'PARTICIPATION_FIELDS_INVALID') => need(object(value) && Reflect.ownKeys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)), code, 'The participation draft contains missing or unsupported fields.');
const text = (value, max = 4000, multiline = true) => typeof value === 'string' && value.length <= max && value.isWellFormed() && !(multiline ? /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/ : /[\x00-\x1f\x7f]/).test(value);
const id = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(value);
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const integer = (value, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(value) && !Object.is(value, -0) && value >= 0 && value <= max;
const money = value => value === null || integer(value);
const list = (value, code = 'PARTICIPATION_LIST_INVALID') => need(Array.isArray(value) && value.length <= MAX_ROWS && Reflect.ownKeys(value).length === value.length + 1 && Array.from({ length: value.length }, (_, index) => Object.hasOwn(value, index)).every(Boolean), code, 'Each participation list supports at most 100 entries.');
function strings(values, predicate, code) {
  list(values, code);
  need(values.every(predicate) && new Set(values).size === values.length, code, 'References must be valid and unique.');
}
function rowId(value, seen) {
  need(id(value) && !seen.has(value), 'PARTICIPATION_ID_INVALID', 'Each participation entry needs a unique id.');
  seen.add(value);
}
function subject(value) {
  shape(value, ['kind', 'label', 'assetHash', 'recordRef'], 'PARTICIPATION_SUBJECT_FIELDS_INVALID');
  need(['PROJECT', 'ASSET', 'RECORD'].includes(value.kind) && text(value.label, 500, false), 'PARTICIPATION_SUBJECT_INVALID', 'Choose a project, retained asset or saved record subject.');
  if (value.kind === 'PROJECT') need(value.assetHash === null && value.recordRef === null, 'PARTICIPATION_SUBJECT_INVALID', 'A project subject cannot carry asset or record references.');
  if (value.kind === 'ASSET') need(hash(value.assetHash) && value.recordRef === null, 'PARTICIPATION_SUBJECT_INVALID', 'An asset subject needs one retained asset hash.');
  if (value.kind === 'RECORD') {
    shape(value.recordRef, ['id', 'version', 'sha256'], 'PARTICIPATION_RECORD_REF_INVALID');
    need(value.assetHash === null && id(value.recordRef.id) && integer(value.recordRef.version) && value.recordRef.version > 0 && hash(value.recordRef.sha256), 'PARTICIPATION_RECORD_REF_INVALID', 'A record subject needs an exact saved id, version and hash.');
  }
}
function evidence(values, documented = false) {
  strings(values, hash, 'PARTICIPATION_EVIDENCE_INVALID');
  need(!documented || values.length > 0, 'PARTICIPATION_DOCUMENT_EVIDENCE_REQUIRED', 'Attach at least one evidence file before marking an entry documented.');
}
function poolFields(pool, seen = new Set(), parties) {
  shape(pool, ['id', 'name', 'kind', 'subject', 'definition', 'entityName', 'currency', 'receiptsMinor', 'deductionsMinor', 'recoupmentMinor', 'allocations'], 'PARTICIPATION_POOL_FIELDS_INVALID');
  rowId(pool.id, seen); subject(pool.subject);
  need(text(pool.name, 240, false) && text(pool.definition, 8000) && text(pool.entityName, 240, false), 'PARTICIPATION_POOL_TEXT_INVALID', 'Keep the pool name, definition and company name within their text limits.');
  need(['RECEIPTS', 'DEFINED_PROCEEDS', 'COPYRIGHT_INTEREST', 'COMPANY_EQUITY'].includes(pool.kind), 'PARTICIPATION_POOL_KIND_INVALID', 'Choose a supported participation pool kind.');
  need(['', 'USD', 'CAD', 'EUR', 'GBP'].includes(pool.currency), 'PARTICIPATION_CURRENCY_INVALID', 'Choose USD, CAD, EUR or GBP, or leave the currency unknown.');
  need(['receiptsMinor', 'deductionsMinor', 'recoupmentMinor'].every(key => money(pool[key])), 'PARTICIPATION_AMOUNT_INVALID', 'Amounts must be nonnegative safe integers in minor currency units, or null while unknown.');
  if (pool.kind === 'RECEIPTS') need(pool.deductionsMinor === null && pool.recoupmentMinor === null, 'PARTICIPATION_RECEIPTS_TERMS_INVALID', 'A receipts pool cannot deduct costs or recoupment. Use defined proceeds for those terms.');
  if (['COPYRIGHT_INTEREST', 'COMPANY_EQUITY'].includes(pool.kind)) need(pool.currency === '' && ['receiptsMinor', 'deductionsMinor', 'recoupmentMinor'].every(key => pool[key] === null), 'PARTICIPATION_INTEREST_MONEY_INVALID', 'Ownership interest pools have no currency, revenue or payout amounts.');
  list(pool.allocations);
  let total = 0;
  const allocatedParties = new Set();
  for (const allocation of pool.allocations) {
    shape(allocation, ['id', 'partyId', 'shareBps', 'agreementStatus', 'evidenceHashes'], 'PARTICIPATION_ALLOCATION_FIELDS_INVALID');
    rowId(allocation.id, seen);
    need(id(allocation.partyId) && (!parties || parties.has(allocation.partyId)), 'PARTICIPATION_PARTY_MISSING', 'Each entry must refer to a party in this participation draft.');
    need(!allocatedParties.has(allocation.partyId), 'PARTICIPATION_ALLOCATION_DUPLICATE_PARTY', 'A party may have only one allocation in each pool.');
    allocatedParties.add(allocation.partyId);
    need(allocation.shareBps === null || integer(allocation.shareBps, 10000), 'PARTICIPATION_SHARE_INVALID', 'A share must be null while unknown, or whole basis points from 0 to 10000.');
    total += allocation.shareBps ?? 0;
    need(['PROPOSED', 'DOCUMENTED', 'DISPUTED'].includes(allocation.agreementStatus), 'PARTICIPATION_AGREEMENT_INVALID', 'Choose proposed, documented or disputed agreement status.');
    evidence(allocation.evidenceHashes, allocation.agreementStatus === 'DOCUMENTED');
  }
  need(total <= 10000, 'PARTICIPATION_POOL_OVERALLOCATED', 'Known shares in one pool cannot exceed 100 percent.');
  return total;
}

export function defaultParticipation(project) {
  const owner = projectOwnedContext(project, KIND, { projectId: project?.id, sourceHash: null });
  return validateParticipation({ schemaVersion: 1, projectId: owner?.id, sourceHash: owner?.sourceHash, status: 'DRAFT', parties: [], contributions: [], rights: [], pools: [] }, project);
}

export function validateParticipation(data, project) {
  shape(data, ['schemaVersion', 'projectId', 'sourceHash', 'status', 'parties', 'contributions', 'rights', 'pools']);
  need(data.schemaVersion === 1 && data.status === 'DRAFT', 'PARTICIPATION_AUTHORITY_INVALID', 'Participation records remain authored drafts and grant no rights or payment authority.');
  need(id(data.projectId) && (data.sourceHash === null || hash(data.sourceHash)), 'PARTICIPATION_PROJECT_INVALID', 'The draft must identify its project and source revision.');
  const owner = projectOwnedContext(project, KIND, data);
  if (owner) need(owner.id === data.projectId && owner.sourceHash === data.sourceHash, 'PARTICIPATION_PROJECT_MISMATCH', 'The participation draft belongs to another project or source revision.', 409);
  for (const key of ['parties', 'contributions', 'rights', 'pools']) list(data[key]);
  const seen = new Set(), parties = new Set();
  for (const party of data.parties) {
    shape(party, ['id', 'name', 'kind'], 'PARTICIPATION_PARTY_FIELDS_INVALID'); rowId(party.id, seen);
    need(text(party.name, 240, false) && ['PERSON', 'ORGANIZATION'].includes(party.kind), 'PARTICIPATION_PARTY_INVALID', 'A party needs a bounded name and person or organization kind.');
    parties.add(party.id);
  }
  for (const contribution of data.contributions) {
    shape(contribution, ['id', 'partyId', 'role', 'subject', 'description', 'credit', 'evidenceHashes', 'budgetLineIds'], 'PARTICIPATION_CONTRIBUTION_FIELDS_INVALID');
    rowId(contribution.id, seen); subject(contribution.subject);
    need(parties.has(contribution.partyId), 'PARTICIPATION_PARTY_MISSING', 'Each entry must refer to a party in this participation draft.');
    need(text(contribution.role, 240, false) && text(contribution.description, 8000) && text(contribution.credit, 2000), 'PARTICIPATION_CONTRIBUTION_TEXT_INVALID', 'Keep the contribution role, description and credit within their text limits.');
    evidence(contribution.evidenceHashes); strings(contribution.budgetLineIds, value => text(value, 512, false) && value.trim().length > 0 && value === value.trim(), 'PARTICIPATION_BUDGET_LINES_INVALID');
  }
  for (const right of data.rights) {
    shape(right, ['id', 'partyId', 'subject', 'rightType', 'scope', 'territory', 'term', 'jurisdiction', 'status', 'evidenceHashes'], 'PARTICIPATION_RIGHT_FIELDS_INVALID');
    rowId(right.id, seen); subject(right.subject);
    need(parties.has(right.partyId), 'PARTICIPATION_PARTY_MISSING', 'Each entry must refer to a party in this participation draft.');
    need(['COPYRIGHT', 'LICENCE', 'PERFORMANCE', 'VOICE_LIKENESS', 'DIGITAL_REPLICA', 'OTHER'].includes(right.rightType) && ['CLAIMED', 'DOCUMENTED', 'DISPUTED'].includes(right.status), 'PARTICIPATION_RIGHT_INVALID', 'Choose a supported right type and claim status.');
    need(text(right.scope, 8000) && text(right.territory, 1000) && text(right.term, 2000) && text(right.jurisdiction, 1000), 'PARTICIPATION_RIGHT_TEXT_INVALID', 'Keep the rights scope, territory, term and jurisdiction within their text limits.');
    evidence(right.evidenceHashes, right.status === 'DOCUMENTED');
  }
  for (const pool of data.pools) poolFields(pool, seen, parties);
  need(seen.size <= MAX_TOTAL_ROWS, 'PARTICIPATION_TOTAL_LIMIT', 'The participation draft exceeds the total entry limit.', 413);
  need(new TextEncoder().encode(JSON.stringify(data)).byteLength <= MAX_BYTES, 'PARTICIPATION_SIZE_LIMIT', 'The participation draft exceeds the supported size.', 413);
  return data;
}

export function validateParticipationIdentity(recordId, kind, data, previous = null) {
  if (kind !== KIND && !(typeof recordId === 'string' && recordId.startsWith('participation:'))) return;
  need(kind === KIND && id(data?.projectId) && recordId === `participation:${data.projectId}`, 'PARTICIPATION_IDENTITY_INVALID', 'The participation record id must match its project.', 409);
  if (previous) need(previous.projectId === data.projectId && previous.sourceHash === data.sourceHash, 'PARTICIPATION_IDENTITY_CHANGED', 'A saved participation record cannot change project or source identity.', 409);
}

const SUBJECT_RECORD_KINDS = new Set(['screenplay-draft', 'concept-draft', 'story-plan-draft', 'pitch-draft', 'writing-note', 'casting-draft', 'universe-entity', 'universe-claim', 'universe-link', 'universe-artwork', 'universe-agent', 'universe-rehearsal', 'universe-profile', 'universe-production-plan', 'universe-continuity-plan']);
export function validateParticipationReferences(data, { lookupRecord, lookupBlob, project, requireCurrent = true }) {
  validateParticipation(data, requireCurrent ? project : undefined);
  // Historical revisions can outlive a source change, but never the project
  // identity. A foreign context must not widen the accepted reference scope.
  need(project === undefined || project?.id === data.projectId, 'PARTICIPATION_PROJECT_MISMATCH', 'The reference context belongs to another project.', 409);
  const sameScope = target => {
    if (!object(target)) return false;
    if (Object.hasOwn(target, 'projectId') && target.projectId !== data.projectId) return false;
    if (target.sourceHash === null) return target.projectId === data.projectId;
    return hash(target.sourceHash) && (target.sourceHash === data.sourceHash || target.sourceHash === project?.sourceHash);
  };
  function blob(hashValue) {
    const value = lookupBlob(hashValue);
    const byteLength = value?.byteLength ?? value?.byte_length;
    // Metadata is a boundary too: never coerce sizes or accept conflicting
    // descriptions of the retained evidence selected by its hash.
    need(object(value) && integer(byteLength) && byteLength > 0 && ['byteLength', 'byte_length'].some(key => Object.hasOwn(value, key)) && ['byteLength', 'byte_length'].every(key => !Object.hasOwn(value, key) || value[key] === byteLength), 'PARTICIPATION_EVIDENCE_MISSING', 'A retained participation asset or evidence file is missing or has invalid size metadata.', 409);
    if (Object.hasOwn(value, 'sha256')) need(value.sha256 === hashValue, 'PARTICIPATION_EVIDENCE_HASH_MISMATCH', 'A retained participation asset or evidence file does not match its selected hash.', 409);
    if (Object.hasOwn(value, 'projectId')) need(value.projectId === data.projectId, 'PARTICIPATION_ASSET_PROJECT_MISMATCH', 'A participation asset or evidence file belongs to another project.', 409);
    if (Object.hasOwn(value, 'sourceHash')) need(sameScope(value), 'PARTICIPATION_ASSET_PROJECT_MISMATCH', 'A participation asset or evidence file belongs to another source revision.', 409);
  }
  const seenBlobs = new Set();
  function checkBlob(hashValue) { if (!seenBlobs.has(hashValue)) { blob(hashValue); seenBlobs.add(hashValue); } }
  const entries = [...data.contributions, ...data.rights, ...data.pools];
  for (const entry of entries) {
    const target = entry.subject;
    if (target.kind === 'ASSET') checkBlob(target.assetHash);
    if (target.kind === 'RECORD') {
      const ref = target.recordRef;
      const record = requireCurrent ? lookupRecord(ref.id) : lookupRecord(ref.id, ref.version);
      need(record && record.id === ref.id && record.version === ref.version && record.sha256 === ref.sha256, 'PARTICIPATION_RECORD_MISSING_OR_CHANGED', 'A participation subject record is missing or its version changed. Review and select the intended saved version.', 409);
      need(SUBJECT_RECORD_KINDS.has(record.kind), 'PARTICIPATION_RECORD_KIND_INVALID', 'Select a writing, universe or casting record as the participation subject.', 409);
      need(sameScope(record.data), 'PARTICIPATION_RECORD_PROJECT_MISMATCH', 'A participation subject belongs to another project or source revision.', 409);
    }
    for (const hashValue of entry.evidenceHashes ?? []) checkBlob(hashValue);
    for (const allocation of entry.allocations ?? []) for (const hashValue of allocation.evidenceHashes) checkBlob(hashValue);
  }
  const budgetLineIds = new Set(data.contributions.flatMap(entry => entry.budgetLineIds));
  if (requireCurrent && budgetLineIds.size > 0) {
    const record = lookupRecord(`production-budget:${data.projectId}`);
    need(record?.kind === 'production-budget' && record.id === `production-budget:${data.projectId}` && integer(record.version) && record.version > 0 && hash(record.sha256) && sameScope(record.data) && Array.isArray(record.data.lines), 'PARTICIPATION_BUDGET_MISSING_OR_CHANGED', 'Linked contributions require a saved production budget for this project.', 409);
    const available = new Set(record.data.lines.map(line => line.id));
    need([...budgetLineIds].every(lineId => available.has(lineId)), 'PARTICIPATION_BUDGET_LINE_MISSING', 'A linked production budget line is missing. Review the contribution link.', 409);
  }
}

export function calculateParticipationPool(pool) {
  const result = { status: 'INVALID', errors: [], allocatedBps: 0, unallocatedBps: 10000, baseMinor: null, availableMinor: null, appliedRecoupmentMinor: null, unrecoveredMinor: null, unallocatedMinor: null, payouts: [], roundingMinor: null };
  if (Array.isArray(pool?.allocations) && pool.allocations.length <= MAX_ROWS && pool.allocations.every(row => row?.shareBps === null || integer(row?.shareBps, 10000))) {
    result.allocatedBps = pool.allocations.reduce((total, row) => total + (row.shareBps ?? 0), 0);
    result.unallocatedBps = Math.max(0, 10000 - result.allocatedBps);
  }
  try { poolFields(pool); } catch (error) { result.errors.push(error.message); return result; }
  if (!pool.definition.trim()) result.errors.push('Describe the terms or basis for this pool.');
  if (pool.allocations.some(row => row.shareBps === null)) result.errors.push('Enter an explicit share for every allocation; blank shares remain unknown.');
  const interest = ['COPYRIGHT_INTEREST', 'COMPANY_EQUITY'].includes(pool.kind);
  if (pool.kind === 'COMPANY_EQUITY' && !pool.entityName.trim()) result.errors.push('Identify the company whose equity is being described.');
  if (!interest) {
    if (!pool.currency) result.errors.push('Choose a currency for the hypothetical amounts.');
    if (pool.receiptsMinor === null) result.errors.push('Enter hypothetical receipts, including an explicit zero if intended.');
    if (pool.kind === 'DEFINED_PROCEEDS') {
      if (pool.deductionsMinor === null) result.errors.push('Enter defined deductions, including an explicit zero if intended.');
      if (pool.recoupmentMinor === null) result.errors.push('Enter recoupment, including an explicit zero if intended.');
    }
  }
  if (result.errors.length) { result.status = 'INCOMPLETE'; return result; }
  if (interest) { result.status = 'INTEREST_ONLY'; return result; }
  const receipts = BigInt(pool.receiptsMinor);
  const afterDeductions = receipts - BigInt(pool.kind === 'DEFINED_PROCEEDS' ? pool.deductionsMinor : 0);
  const base = afterDeductions > 0n ? afterDeductions : 0n;
  const recoupment = BigInt(pool.kind === 'DEFINED_PROCEEDS' ? pool.recoupmentMinor : 0);
  const applied = recoupment < base ? recoupment : base, available = base - applied;
  const payouts = pool.allocations.map(row => ({ partyId: row.partyId, amountMinor: Number(available * BigInt(row.shareBps) / 10000n) }));
  // True unallocated reserve and discarded fractional pennies are separate.
  const unallocated = available * BigInt(result.unallocatedBps) / 10000n;
  const paid = payouts.reduce((total, row) => total + BigInt(row.amountMinor), 0n);
  return { ...result, status: 'CALCULATED', baseMinor: Number(base), availableMinor: Number(available), appliedRecoupmentMinor: Number(applied), unrecoveredMinor: Number(recoupment - applied), unallocatedMinor: Number(unallocated), payouts, roundingMinor: Number(available - paid - unallocated) };
}
