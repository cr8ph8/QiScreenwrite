// Explicit local creative snapshots. Checksums prove byte integrity only.
import crypto from 'node:crypto';
import { check, sha256, hashCanonical, canonicalJson, ID, LocalError } from './storage.mjs';
import { RecoveryStore, DevelopmentRecoveryStore } from './recovery.mjs';
import { validateScreenplayDraft } from './contracts.mjs';
import { validateDevelopment } from './development.mjs';

export const POCKET_SCHEMA = 'qicaniscreenwrite-pocket/v1';
export const POCKET_CONTINUATION_SCHEMA = 'qicaniscreenwrite-pocket/v2';
export const MAX_POCKET_BYTES = 8 * 1024 * 1024;
export const MAX_POCKET_PAYLOAD_BYTES = 4 * 1024 * 1024;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const SHA = /^[a-f0-9]{64}$/;
const developmentFields = ['concept', 'logline', 'synopsis', 'outline', 'beats', 'characters', 'worldNotes', 'researchNotes', 'world'];
const shape = (value, keys) => value !== null && typeof value === 'object'
  && [Object.prototype, null].includes(Object.getPrototypeOf(value))
  && Reflect.ownKeys(value).length === keys.length && keys.every(key => {
    const property = Object.getOwnPropertyDescriptor(value, key);
    return property?.enumerable && Object.hasOwn(property, 'value');
  });
const need = (value, code) => check(value, code, 422);

/** Fatal UTF-8, bounded nesting, and duplicate JSON member detection before
 * JSON.parse can silently discard a field. JSON syntax is checked first. */
function parseJson(bytes) {
  let text, value;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    value = JSON.parse(text);
  } catch { throw new LocalError('POCKET_JSON_INVALID', 422); }
  let at = 0, nodes = 0;
  const whitespace = () => { while (/[\x20\t\r\n]/.test(text[at] ?? 'x')) at++; };
  const string = () => {
    const start = at++;
    while (at < text.length) {
      if (text[at++] === '"') break;
      if (text[at - 1] === '\\') at++;
    }
    return JSON.parse(text.slice(start, at));
  };
  const walk = depth => {
    need(depth <= 32 && ++nodes <= 40000, 'POCKET_JSON_TOO_COMPLEX');
    whitespace();
    if (text[at] === '"') { string(); return; }
    if (text[at] === '{' || text[at] === '[') {
      const object = text[at++] === '{', end = object ? '}' : ']';
      const keys = new Set();
      whitespace();
      while (text[at] !== end) {
        if (object) {
          const key = string();
          need(!keys.has(key), 'POCKET_DUPLICATE_FIELD'); keys.add(key);
          whitespace(); at++; // colon (syntax already checked)
        }
        walk(depth + 1); whitespace();
        if (text[at] === ',') { at++; whitespace(); } else break;
      }
      at++; return;
    }
    while (at < text.length && !/[\x20\t\r\n,}\]]/.test(text[at])) at++;
  };
  walk(0);
  return value;
}

function draftData(snapshot, projectId) {
  return { schemaVersion: 2, projectId, sourceHash: null, title: snapshot.title,
    format: 'FOUNTAIN', body: snapshot.body, status: 'DRAFT', genre: snapshot.genre,
    logline: snapshot.logline, ...(snapshot.projectFormat ? { projectFormat: snapshot.projectFormat } : {}),
    ...(Object.hasOwn(snapshot, 'targetPages') ? { targetPages: snapshot.targetPages } : {}) };
}
function developmentData(snapshot, projectId, draftId) {
  return { ...snapshot.development, schemaVersion: 2, projectId, draftId };
}

export function validatePocketSnapshot(value) {
  const keys = ['id', 'title', 'body', 'genre', 'logline', 'projectFormat', 'development'];
  if (value && Object.hasOwn(value, 'targetPages')) keys.push('targetPages');
  need(shape(value, keys), 'POCKET_SNAPSHOT_FIELDS_INVALID');
  need(typeof value.id === 'string' && UUID.test(value.id), 'POCKET_ID_INVALID');
  need(typeof value.title === 'string' && value.title.isWellFormed() && !value.title.includes('\0') && value.title.length <= 200, 'POCKET_TITLE_INVALID');
  need(typeof value.projectFormat === 'string', 'POCKET_FORMAT_INVALID');
  // Portable titles may be empty or multiline. Desktop storage is stricter;
  // preview/import checks representability separately without rewriting text.
  validateScreenplayDraft({ ...draftData(value, 'pocket:validation'), title: 'Snapshot' });
  need(shape(value.development, developmentFields), 'POCKET_DEVELOPMENT_FIELDS_INVALID');
  validateDevelopment(developmentData(value, 'pocket:validation', `screenplay-draft:${value.id}`));
  return value;
}

export function decodePocketPackage(input) {
  need(typeof input === 'string' || Buffer.isBuffer(input) || input instanceof Uint8Array, 'POCKET_BYTES_REQUIRED');
  const bytes = Buffer.from(input);
  check(bytes.length > 0 && bytes.length <= MAX_POCKET_BYTES, 'POCKET_SIZE_INVALID', 413);
  const envelope = parseJson(bytes);
  need(shape(envelope, ['schema', 'contentEncoding', 'contentSha256', 'payloadBase64']), 'POCKET_ENVELOPE_FIELDS_INVALID');
  need([POCKET_SCHEMA, POCKET_CONTINUATION_SCHEMA].includes(envelope.schema) && envelope.contentEncoding === 'base64-json-utf8', 'POCKET_SCHEMA_INVALID');
  need(typeof envelope.contentSha256 === 'string' && SHA.test(envelope.contentSha256), 'POCKET_CHECKSUM_INVALID');
  const encoded = envelope.payloadBase64;
  need(typeof encoded === 'string' && encoded.length > 0 && encoded.length % 4 === 0
    && /^[A-Za-z0-9+/]*={0,2}$/.test(encoded), 'POCKET_BASE64_INVALID');
  const payload = Buffer.from(encoded, 'base64');
  check(payload.length <= MAX_POCKET_PAYLOAD_BYTES, 'POCKET_PAYLOAD_TOO_LARGE', 413);
  need(payload.toString('base64') === encoded, 'POCKET_BASE64_INVALID');
  need(sha256(payload) === envelope.contentSha256, 'POCKET_CHECKSUM_MISMATCH');
  const value = parseJson(payload);
  if (envelope.schema === POCKET_CONTINUATION_SCHEMA) {
    need(shape(value, ['snapshot', 'continuation']), 'POCKET_CONTINUATION_FIELDS_INVALID');
    validatePocketSnapshot(value.snapshot); validateContinuation(value.continuation, value.snapshot.id);
    return { snapshot: value.snapshot, continuation: value.continuation, contentSha256: envelope.contentSha256 };
  }
  return { snapshot: validatePocketSnapshot(value), contentSha256: envelope.contentSha256 };
}

export function encodePocketPackage(snapshot) {
  validatePocketSnapshot(snapshot);
  // JSON.stringify has no canonical-node budget: the strict validators above
  // supply the limits. Full 300-element/1000-link worlds must remain portable.
  const payload = Buffer.from(JSON.stringify(snapshot), 'utf8');
  check(payload.length <= MAX_POCKET_PAYLOAD_BYTES, 'POCKET_PAYLOAD_TOO_LARGE', 413);
  return { schema: POCKET_SCHEMA, contentEncoding: 'base64-json-utf8', contentSha256: sha256(payload), payloadBase64: payload.toString('base64') };
}

export function exportPocketPackage(store, draftId, bases = null) {
  need(typeof draftId === 'string' && draftId.startsWith('screenplay-draft:') && UUID.test(draftId.slice(17)), 'POCKET_DRAFT_ID_INVALID');
  const project = store.project(), draft = bases ? store.history(draftId).find(r => r.version === bases.draft.version && r.sha256 === bases.draft.sha256) : store.current(draftId);
  check(draft?.kind === 'screenplay-draft', 'POCKET_DRAFT_NOT_FOUND', 404);
  validateScreenplayDraft(draft.data, project);
  need(hashCanonical(draft.data) === draft.sha256, 'POCKET_SAVED_CHECKSUM_MISMATCH');
  const developmentId = `story-development:${draftId.slice(17)}`;
  const saved = bases ? store.history(developmentId).find(r => r.version === bases.development.version && r.sha256 === bases.development.sha256) : store.current(developmentId);
  if (bases) check(saved, 'POCKET_CONTINUATION_SOURCE_MISSING', 409);
  let development = { concept: '', logline: '', synopsis: '', outline: '', beats: [], characters: [], worldNotes: '', researchNotes: [], world: { schemaVersion: 1, elements: [], links: [] } };
  if (saved) {
    need(saved.kind === 'story-development', 'POCKET_DEVELOPMENT_INVALID');
    validateDevelopment(saved.data, project, { id: saved.id, store });
    need(hashCanonical(saved.data) === saved.sha256, 'POCKET_SAVED_CHECKSUM_MISMATCH');
    development = Object.fromEntries(developmentFields.map(key => [key, key === 'world' && saved.data.schemaVersion === 1 ? development.world : saved.data[key]]));
  }
  const data = draft.data;
  return encodePocketPackage({ id: draftId.slice(17), title: data.title, body: data.body, genre: data.genre ?? '', logline: data.logline ?? '', projectFormat: data.projectFormat ?? '',
    ...(Object.hasOwn(data, 'targetPages') ? { targetPages: data.targetPages } : {}), development });
}

function importIdentity(projectId, contentSha256) {
  const hash = sha256(`qicaniscreenwrite-pocket-import/v1\n${projectId}\n${contentSha256}`);
  // Separate deterministic UUID namespace; imported source id is never reused.
  const uuid = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
  return { draftId: `screenplay-draft:${uuid}`, developmentId: `story-development:${uuid}`, requestPrefix: `pocket-exchange:${hash}` };
}

export function previewPocketPackage(store, input) {
  const decoded = decodePocketPackage(input);
  // Preserve portable text exactly; fail visibly if the existing desktop
  // record contract cannot represent it (empty/multiline title).
  validateScreenplayDraft(draftData(decoded.snapshot, store.project().id), store.project());
  return decoded.continuation ? { ...decoded, returnReview: continuationReview(store, decoded) } : decoded;
}

export function importPocketPackage(store, input, reviewedSha256) {
  const { snapshot, contentSha256 } = previewPocketPackage(store, input);
  check(typeof reviewedSha256 === 'string' && SHA.test(reviewedSha256) && reviewedSha256 === contentSha256, 'POCKET_PREVIEW_MISMATCH', 409);
  const project = store.project();
  const { draftId, developmentId, requestPrefix } = importIdentity(project.id, contentSha256);
  return store.atomic(() => {
    const draft = store.save(draftId, { kind: 'screenplay-draft', expectedVersion: null, requestId: `${requestPrefix}:draft`, data: draftData(snapshot, project.id) });
    const development = store.save(developmentId, { kind: 'story-development', expectedVersion: null, requestId: `${requestPrefix}:development`, data: developmentData(snapshot, project.id, draftId) });
    // Existing save receipts replay the original requests, even after edits.
    // Return current records so clients never replace later edits with v1.
    return { contentSha256, replayed: draft.replayed && development.replayed, draft: store.current(draftId), development: store.current(developmentId) };
  });
}


// v2 is a single reviewed round trip to its issuing workspace. It deliberately
// leaves v1 copy semantics and each store's independent history untouched.
function validateContinuation(value, snapshotId) {
  need(shape(value, ['exchangeId', 'projectId', 'draft', 'development']) && typeof value.exchangeId === 'string'
    && UUID.test(value.exchangeId) && typeof value.projectId === 'string' && ID.test(value.projectId), 'POCKET_CONTINUATION_INVALID');
  for (const [field, prefix] of [['draft', 'screenplay-draft:'], ['development', 'story-development:']]) {
    const ref = value[field];
    need(shape(ref, ['id', 'version', 'sha256']) && ref.id === prefix + snapshotId
      && Number.isSafeInteger(ref.version) && ref.version >= 1 && ref.version < 2147483647
      && typeof ref.sha256 === 'string' && SHA.test(ref.sha256), 'POCKET_CONTINUATION_REVISION_INVALID');
  }
  return value;
}

export function encodePocketContinuation(snapshot, continuation) {
  validatePocketSnapshot(snapshot); validateContinuation(continuation, snapshot.id);
  const payload = Buffer.from(JSON.stringify({ snapshot, continuation: JSON.parse(canonicalJson(continuation)) }), 'utf8');
  check(payload.length <= MAX_POCKET_PAYLOAD_BYTES, 'POCKET_PAYLOAD_TOO_LARGE', 413);
  return { schema: POCKET_CONTINUATION_SCHEMA, contentEncoding: 'base64-json-utf8', contentSha256: sha256(payload), payloadBase64: payload.toString('base64') };
}

const recordRef = record => ({ id: record.id, version: record.version, sha256: record.sha256 });
const hasTable = (store, name) => !!store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name);
function continuationRecoveryClear(store, draft, development) {
  for (const [table, Constructor, saved] of [['recovery', RecoveryStore, draft], ['development_recovery', DevelopmentRecoveryStore, development]]) {
    if (!hasTable(store, table)) continue;
    const copy = new Constructor(store).get(draft.id);
    const base = copy && store.history(saved.id).find(r => r.version === copy.baseVersion && r.sha256 === copy.baseSha256);
    const clean = !copy || [saved, base].filter(Boolean).some(r => hashCanonical(copy.data) === r.sha256
      && (!copy.pendingSave || hashCanonical(copy.pendingSave.data) === r.sha256));
    check(clean, 'POCKET_CONTINUATION_RECOVERY_PENDING', 409, 'Save or resolve the Mac screenplay and development recovery edits before continuing this trip.');
  }
}
function currentContinuationSource(store, continuation) {
  const draft = store.current(continuation.draft.id), development = store.current(continuation.development.id);
  check(draft?.kind === 'screenplay-draft' && development?.kind === 'story-development', 'POCKET_CONTINUATION_SOURCE_MISSING', 409, 'The originating saved draft and development are unavailable in this workspace.');
  validateScreenplayDraft(draft.data, store.project());
  validateDevelopment(development.data, store.project(), { id: development.id, store });
  check(hashCanonical(draft.data) === draft.sha256 && hashCanonical(development.data) === development.sha256, 'POCKET_SAVED_CHECKSUM_MISMATCH', 409);
  return { draft, development };
}
function tripReceipt(store, continuation) {
  const receipt = hasTable(store, 'pocket_trips') && store.db.prepare('SELECT * FROM pocket_trips WHERE id=?').get(continuation.exchangeId);
  check(continuation.projectId === store.project().id && receipt && receipt.manifest_sha256 === sha256(receipt.manifest)
    && receipt.manifest === canonicalJson(continuation), 'POCKET_CONTINUATION_UNKNOWN', 409, 'This linked trip was not issued by this Mac workspace. Import a separate copy or return it to the originating workspace.');
  return receipt;
}
function continuationState(store, decoded) {
  const { continuation, contentSha256 } = decoded;
  check(continuation, 'POCKET_CONTINUATION_REQUIRED', 422);
  const receipt = tripReceipt(store, continuation), source = currentContinuationSource(store, continuation);
  if (receipt.returned_sha256 !== null) {
    check(receipt.returned_sha256 === contentSha256, 'POCKET_CONTINUATION_USED', 409, 'This trip already accepted a return. Prepare a fresh trip on the Mac; preserve further phone changes as a separate copy.');
    const refs = JSON.parse(receipt.result);
    check(['draft', 'development'].every(key => store.history(source[key].id).some(r => canonicalJson(recordRef(r)) === canonicalJson(refs[key]))), 'POCKET_CONTINUATION_RECEIPT_INVALID', 409);
    return { ...source, replayed: true };
  }
  for (const key of ['draft', 'development']) check(canonicalJson(recordRef(source[key])) === canonicalJson(continuation[key]),
    'POCKET_CONTINUATION_CONFLICT', 409, 'The Mac screenplay or development changed since this trip began. Existing writing is preserved. Review separately or import a copy.');
  continuationRecoveryClear(store, source.draft, source.development);
  return { ...source, replayed: false };
}
function continuationData(store, decoded, source) {
  const draft = draftData(decoded.snapshot, store.project().id);
  for (const key of ['genre', 'logline']) if (!Object.hasOwn(source.draft.data, key) && draft[key] === '') delete draft[key];
  // Keep the original schema and verified shared-world publication links.
  const development = { ...source.development.data, ...decoded.snapshot.development };
  validateScreenplayDraft(draft, store.project());
  validateDevelopment(development, store.project(), { id: source.development.id, previous: source.development, store });
  return { draft, development };
}
function continuationReview(store, decoded) {
  try {
    const source = continuationState(store, decoded);
    if (source.replayed) return { status: 'returned', message: 'This exact return was already saved. Reopening it preserves later Mac edits.' };
    continuationData(store, decoded, source);
    const baseSnapshot = decodePocketPackage(JSON.stringify(exportPocketPackage(store, source.draft.id))).snapshot;
    const changed = (incoming, base) => [...new Set([...Object.keys(incoming), ...Object.keys(base)])].filter(key => hashCanonical(incoming[key] ?? null) !== hashCanonical(base[key] ?? null));
    return { status: 'ready', message: 'Both saved Mac revisions still match this trip. Review the changes before updating the linked draft.', baseSnapshot,
      changedDraftFields: changed({ ...decoded.snapshot, development: undefined }, { ...baseSnapshot, development: undefined }),
      changedDevelopmentFields: changed(decoded.snapshot.development, baseSnapshot.development) };
  } catch (error) {
    if (!(error instanceof LocalError) && !error?.code) throw error;
    return { status: 'conflict', message: error.message, code: error.code };
  }
}

/** Explicit POST only: issuing a trip records its exact base in this workspace. */
export function preparePocketContinuation(store, draftId) {
  const packet = exportPocketPackage(store, draftId), { snapshot } = decodePocketPackage(JSON.stringify(packet));
  const draft = store.current(draftId), development = store.current(`story-development:${snapshot.id}`);
  check(development?.kind === 'story-development' && [2, 3].includes(development.data.schemaVersion), 'POCKET_CONTINUATION_SAVE_REQUIRED', 409, 'Save this screenplay and its structured development before preparing a linked phone trip.');
  return store.atomic(() => {
    continuationRecoveryClear(store, draft, development);
    const continuation = { exchangeId: crypto.randomUUID(), projectId: store.project().id, draft: recordRef(draft), development: recordRef(development) };
    const result = encodePocketContinuation(snapshot, continuation);
    store.db.exec('CREATE TABLE IF NOT EXISTS pocket_trips (id TEXT PRIMARY KEY, manifest_sha256 TEXT NOT NULL, manifest TEXT NOT NULL, returned_sha256 TEXT, result TEXT)');
    check(store.db.prepare('SELECT COUNT(*) n FROM pocket_trips').get().n < 10000, 'POCKET_CONTINUATION_LIMIT', 409, 'This workspace has reached its linked-trip receipt limit. Independent copies remain available.');
    const manifest = canonicalJson(continuation);
    store.db.prepare('INSERT INTO pocket_trips VALUES(?,?,?,NULL,NULL)').run(continuation.exchangeId, sha256(manifest), manifest);
    return result;
  });
}

export function returnPocketContinuation(store, input, reviewedSha256) {
  const decoded = decodePocketPackage(input);
  check(typeof reviewedSha256 === 'string' && SHA.test(reviewedSha256) && reviewedSha256 === decoded.contentSha256, 'POCKET_PREVIEW_MISMATCH', 409);
  return store.atomic(() => {
    const source = continuationState(store, decoded);
    if (source.replayed) return { mode: 'continuation', contentSha256: decoded.contentSha256, replayed: true, draft: source.draft, development: source.development };
    const values = continuationData(store, decoded, source), saved = {};
    for (const key of ['draft', 'development']) {
      const current = source[key], data = values[key];
      saved[key] = hashCanonical(data) === current.sha256 ? current : store.save(current.id, { kind: current.kind, expectedVersion: current.version,
        requestId: `pocket-return:${decoded.continuation.exchangeId}:${key}`, data });
    }
    store.db.prepare('UPDATE pocket_trips SET returned_sha256=?, result=? WHERE id=? AND returned_sha256 IS NULL')
      .run(decoded.contentSha256, canonicalJson({ draft: recordRef(saved.draft), development: recordRef(saved.development) }), decoded.continuation.exchangeId);
    return { mode: 'continuation', contentSha256: decoded.contentSha256, replayed: false, ...saved };
  });
}


/** Same-origin native download from retained immutable base revisions. */
export function exportPreparedPocketContinuation(store, exchangeId) {
  need(typeof exchangeId === 'string' && UUID.test(exchangeId), 'POCKET_CONTINUATION_INVALID');
  const receipt = hasTable(store, 'pocket_trips') && store.db.prepare('SELECT * FROM pocket_trips WHERE id=?').get(exchangeId);
  check(receipt, 'POCKET_CONTINUATION_UNKNOWN', 404);
  const continuation = JSON.parse(receipt.manifest);
  tripReceipt(store, continuation);
  const { snapshot } = decodePocketPackage(JSON.stringify(exportPocketPackage(store, continuation.draft.id, continuation)));
  return encodePocketContinuation(snapshot, continuation);
}
