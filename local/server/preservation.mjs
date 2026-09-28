// A portable snapshot of saved writer records, with no filesystem discovery or
// remote lookup. Hashes establish internal integrity, not authenticity/authority.
import fs from 'node:fs';
import crypto from 'node:crypto';
import { check, LocalError, SHA, canonicalJson } from './storage.mjs';
import { BACKUP_SCHEMA, MAX_BACKUP_BYTES, createBackup, validateBackup, isoTimestamp } from './backup.mjs';

export const PRESERVATION_PREVIEW_SCHEMA = 'caniscreenwrite-preservation-preview/v1';
export const PRESERVATION_PACKAGE_SCHEMA = 'caniscreenwrite-preservation-package/v2';
const LEGACY_PACKAGE_SCHEMA = 'caniscreenwrite-preservation-package/v1';
export const MAX_PRESERVATION_BYTES = 128 * 1024 * 1024;

const LEGACY_EXCLUSIONS = Object.freeze([
  'Unsaved screenplay and development recovery content, including pending saves.',
  'Credentials, sessions, connector configuration and request replay receipts.',
  'Remote media and other external files; this is not a media archive.',
  'Remote authority, acceptance, publication and production state; saved links are local receipts only.',
]);
const LEGACY_README = [
  '# Saved writer workspace preservation',
  '',
  'Scope: SAVED_WRITER_WORKSPACE. This JSON package contains the exact saved project and complete saved record history in backup, plus an inventory of the latest revision of each record.',
  'Screenplays, story development, shared worlds and local transfer receipts retain their record IDs, versions and SHA-256 hashes. Linked worlds retain their saved base revisions.',
  '',
  'Exclusions:',
  ...LEGACY_EXCLUSIONS.map(value => `- ${value}`),
  '',
  'Verify without opening a workspace: node local/server/cli.mjs verify-preservation --file PACKAGE.json',
  'Restore to a new, nonexistent directory: node local/server/cli.mjs restore --data NEW_DIR --file PACKAGE.json',
  'Restore refuses every existing destination, preserves saved history and creates a fresh local credential. Reconnect external services separately.',
  '',
  'sourceSha256 binds the exact project and sorted saved revision identities. Export timestamps are excluded; timestamps within saved record content remain bound by record hashes.',
  'The package digest uses length-framed canonical metadata and backup.sha256. Verification recomputes record hashes, history, local source bindings and package integrity.',
  'These unkeyed hashes do not prove cryptographic authenticity, authorship, canon, remote authority or a scientific quotient. A self-consistent rewritten package can pass verification.',
  'Only the supplied snapshot is checked. Verification cannot prove that omitted independent records existed elsewhere, or inspect excluded recovery or remote content.',
  'The complete JSON package is limited to 128 MiB; existing backup and record limits also apply.',
  '',
].join('\n');
const EXCLUSIONS = Object.freeze([LEGACY_EXCLUSIONS[0].replace('screenplay and development', 'screenplay, development and rights'), ...LEGACY_EXCLUSIONS.slice(1)]);
const README = LEGACY_README.replace(LEGACY_EXCLUSIONS[0], EXCLUSIONS[0]) +
  'Saved rights drafts, local reviews, token metadata drafts and original rights attachment bytes are included as private saved records. This package can contain confidential agreements and personal names; keep it private. Unsaved rights recovery is excluded.\n';
const LIMITATIONS = Object.freeze([
  'Internal integrity only; no cryptographic authenticity, authorship, canon, remote authority or scientific quotient is established.',
  'Completeness is relative to the supplied saved snapshot; omitted independent records cannot be detected without an external trusted reference.',
  'Unsaved recovery, credentials, external files and remote media/state are not verified or restored.',
]);
const shape = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value))
  && Reflect.ownKeys(value).length === keys.length && keys.every(key => {
    const property = Object.getOwnPropertyDescriptor(value, key);
    return property?.enumerable && Object.hasOwn(property, 'value');
  });

/** Count exact compact JSON bytes without serializing the whole workspace or
 * invoking getters/toJSON. Per-record canonical limits still belong to backup.
 * Dense plain JSON, depth and bytes bound all subsequent validation work. */
function boundedJsonBytes(value, limit = MAX_PRESERVATION_BYTES, code = 'PRESERVATION_TOO_LARGE') {
  let bytes = 0;
  const add = amount => { bytes += amount; check(bytes <= limit, code, 413); };
  const string = value => {
    check(value.length <= limit - bytes, code, 413);
    check(value.isWellFormed(), 'PRESERVATION_JSON_INVALID', 422);
    add(Buffer.byteLength(JSON.stringify(value)));
  };
  const visit = (item, depth) => {
    check(depth <= 40, 'PRESERVATION_JSON_INVALID', 422);
    if (typeof item === 'string') { string(item); return; }
    if (item === null || typeof item === 'boolean') { add(String(item).length); return; }
    if (typeof item === 'number') {
      check(Number.isSafeInteger(item) && !Object.is(item, -0), 'PRESERVATION_JSON_INVALID', 422);
      add(String(item).length); return;
    }
    check(item && typeof item === 'object', 'PRESERVATION_JSON_INVALID', 422);
    const array = Array.isArray(item);
    check(array ? Object.getPrototypeOf(item) === Array.prototype : [Object.prototype, null].includes(Object.getPrototypeOf(item)), 'PRESERVATION_JSON_INVALID', 422);
    // A sparse huge array is rejected before allocating a matching key list.
    if (array) check(item.length <= limit - bytes, code, 413);
    const keys = Reflect.ownKeys(item).filter(key => !(array && key === 'length'));
    check(!array || keys.length === item.length, 'PRESERVATION_JSON_INVALID', 422);
    add(2);
    for (let index = 0; index < keys.length; index++) {
      const key = keys[index], property = Object.getOwnPropertyDescriptor(item, key);
      check(typeof key === 'string' && property.enumerable && Object.hasOwn(property, 'value')
        && (!array || key === String(index)), 'PRESERVATION_JSON_INVALID', 422);
      if (index) add(1);
      if (!array) { string(key); add(1); }
      visit(property.value, depth + 1);
    }
  };
  visit(value, 0);
  return bytes;
}

// Frames are UTF-8 canonical JSON prefixed by their ASCII byte length and ':'.
// Separate domains keep a source fingerprint distinct from a package checksum.
function framedDigest(domain) {
  const digest = crypto.createHash('sha256').update(`${domain}\n`);
  return {
    add(value) {
      const text = canonicalJson(value);
      digest.update(`${Buffer.byteLength(text)}:`).update(text);
    },
    finish: () => digest.digest('hex'),
  };
}
const compare = (a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : a.version - b.version;

function describeBackup(backup) {
  const records = [...backup.records].sort(compare), latest = new Map();
  const digest = framedDigest('caniscreenwrite-preservation-source/v1');
  digest.add({ project: backup.project, revisionCount: records.length });
  for (const record of records) {
    digest.add({ id: record.id, kind: record.kind, version: record.version, sha256: record.sha256 });
    latest.set(record.id, record);
  }
  const inventory = [...latest.values()].map(record => ({
    id: record.id, kind: record.kind, version: record.version, sha256: record.sha256,
    title: record.kind === 'source-document' ? record.data.filename
      : record.kind === 'source-import' ? 'Reviewed screenplay import'
      : record.kind === 'rights-evidence' ? record.data.name
      : record.kind === 'project-participation' ? 'Rights & collaborators'
      : record.kind === 'rights-review' ? 'Local rights review'
      : record.kind === 'token-preparation' ? record.data.publicFields.name || 'Token metadata draft'
      : record.kind === 'screenplay-draft' ? record.data.title
      : record.kind === 'shared-world' ? record.data.name
        : latest.get(record.data.draftId)?.data.title ?? record.id,
  }));
  return { sourceSha256: digest.finish(), inventory };
}

function packageChecksum(value) {
  const digest = framedDigest(value.schema);
  digest.add({ schema: value.schema, scope: value.scope, createdAt: value.createdAt,
    sourceSha256: value.sourceSha256, exclusions: value.exclusions, readme: value.readme,
    inventoryCount: value.inventory.length, backupSha256: value.backup.sha256 });
  for (const record of value.inventory) digest.add(record);
  return digest.finish();
}

function recoveryCounts(store) {
  // Advisory counts only, without reading copy bodies or creating absent tables.
  const count = table => store.db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(table)
    ? store.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count : 0;
  const rights = count('rights_recovery');
  return { screenplay: count('recovery'), development: count('development_recovery'), ...(rights ? { rights } : {}) };
}

export function preservationPreview(store) {
  const backup = createBackup(store), description = describeBackup(backup);
  const preview = { schema: PRESERVATION_PREVIEW_SCHEMA,
    project: { id: backup.project.id, title: backup.project.title }, ...description,
    revisionCount: backup.records.length, recoveryCounts: recoveryCounts(store), exclusions: [...EXCLUSIONS] };
  boundedJsonBytes(preview);
  return preview;
}

export function createPreservationPackage(store, expectedSourceSha256) {
  if (expectedSourceSha256 !== undefined) check(typeof expectedSourceSha256 === 'string' && SHA.test(expectedSourceSha256), 'PRESERVATION_SOURCE_INVALID', 422);
  const backup = createBackup(store), description = describeBackup(backup);
  check(expectedSourceSha256 === undefined || expectedSourceSha256 === description.sourceSha256, 'PRESERVATION_SOURCE_CHANGED', 409);
  const value = { schema: PRESERVATION_PACKAGE_SCHEMA, scope: 'SAVED_WRITER_WORKSPACE',
    createdAt: backup.createdAt, ...description, exclusions: [...EXCLUSIONS], readme: README, backup };
  value.sha256 = packageChecksum(value);
  boundedJsonBytes(value);
  return value;
}

export function verifyPreservationPackage(value) {
  boundedJsonBytes(value);
  check(shape(value, ['schema', 'scope', 'createdAt', 'sourceSha256', 'inventory', 'exclusions', 'readme', 'backup', 'sha256'])
    && [PRESERVATION_PACKAGE_SCHEMA, LEGACY_PACKAGE_SCHEMA].includes(value.schema) && value.scope === 'SAVED_WRITER_WORKSPACE', 'PRESERVATION_SCHEMA_INVALID', 422);
  check(isoTimestamp(value.createdAt), 'PRESERVATION_TIMESTAMP_INVALID', 422);
  check(typeof value.sourceSha256 === 'string' && SHA.test(value.sourceSha256), 'PRESERVATION_SOURCE_INVALID', 422);
  check(typeof value.sha256 === 'string' && SHA.test(value.sha256), 'PRESERVATION_CHECKSUM_INVALID', 422);
  const legacy = value.schema === LEGACY_PACKAGE_SCHEMA;
  check(JSON.stringify(value.exclusions) === JSON.stringify(legacy ? LEGACY_EXCLUSIONS : EXCLUSIONS), 'PRESERVATION_EXCLUSIONS_INVALID', 422);
  check(value.readme === (legacy ? LEGACY_README : README), 'PRESERVATION_README_INVALID', 422);
  boundedJsonBytes(value.backup, MAX_BACKUP_BYTES, 'BACKUP_TOO_LARGE');
  validateBackup(value.backup);
  const derived = describeBackup(value.backup);
  check(value.sourceSha256 === derived.sourceSha256, 'PRESERVATION_SOURCE_MISMATCH', 422);
  check(Array.isArray(value.inventory) && value.inventory.length === derived.inventory.length, 'PRESERVATION_INVENTORY_INVALID', 422);
  value.inventory.forEach((record, index) => {
    check(shape(record, ['id', 'kind', 'version', 'sha256', 'title'])
      && Object.keys(derived.inventory[index]).every(key => record[key] === derived.inventory[index][key]), 'PRESERVATION_INVENTORY_MISMATCH', 422);
  });
  check(packageChecksum(value) === value.sha256, 'PRESERVATION_CHECKSUM_MISMATCH', 422);
  return { valid: true, schema: value.schema,
    project: { id: value.backup.project.id, title: value.backup.project.title },
    sourceSha256: derived.sourceSha256, packageSha256: value.sha256,
    recordCount: derived.inventory.length, revisionCount: value.backup.records.length,
    exclusions: [...value.exclusions], checks: { recordHashes: true, history: true, sourceBindings: true, packageHash: true },
    limitations: [...LIMITATIONS] };
}

/** Returns a verified package. The CLI restore path alone opts into accepting a
 * validated legacy backup too, using one bounded read and no workspace access. */
export function readPreservationFile(filename, { allowLegacyBackup = false } = {}) {
  const prefix = allowLegacyBackup ? 'BACKUP' : 'PRESERVATION';
  const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const before = fs.fstatSync(fd);
    check(before.isFile(), `${prefix}_FILE_INVALID`, 422);
    check(before.size <= MAX_PRESERVATION_BYTES, 'PRESERVATION_TOO_LARGE', 413);
    const bytes = Buffer.alloc(before.size + 1);
    let count = 0;
    while (count < bytes.length) {
      const n = fs.readSync(fd, bytes, count, bytes.length - count, null);
      if (!n) break;
      count += n;
    }
    const after = fs.fstatSync(fd);
    check(count === before.size && after.size === before.size && after.mtimeMs === before.mtimeMs && after.ctimeMs === before.ctimeMs, `${prefix}_FILE_CHANGED`, 422);
    let value;
    try {
      // Keep a BOM rather than silently stripping it; JSON.parse rejects it.
      const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, count));
      value = JSON.parse(text);
    } catch { throw new LocalError(`${prefix}_JSON_INVALID`, 422); }
    if (allowLegacyBackup && value?.schema === BACKUP_SCHEMA) {
      check(count <= MAX_BACKUP_BYTES, 'BACKUP_TOO_LARGE', 413);
      boundedJsonBytes(value, MAX_BACKUP_BYTES, 'BACKUP_TOO_LARGE');
      return validateBackup(value);
    }
    verifyPreservationPackage(value);
    return value;
  } finally { fs.closeSync(fd); }
}
