// Local writer workspace storage. Node 24 built-ins only: node:sqlite, node:fs,
// node:crypto. One owner, one private data directory, immutable record history.
//
// The record table layout, request replay and canonical-JSON hashing are the
// same as the QiMovi / FilmStack local service (workspace.sqlite), so a record
// saved here can be carried to QiMovi with the same id, sha256 and version
// semantics. This service does not own a FilmStack kernel or canonical
// database: writing drafts are speculative workspace text, never source
// authority.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

export const CONFIG_SCHEMA = 'caniscreenwrite-local-writer-config/v1';
export const PROJECT_PROFILE = 'caniscreenwrite-local-writer/v1';
export const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
export const SHA = /^[a-f0-9]{64}$/;
// A full development v2 record has 11,916 nodes; v3 with 32 sources and all
// 300/1000 mappings has 16,009. Independent v3 pending recovery has 32,030.
// Keep one bounded serializer for
// records, request receipts and backup hashes, with room for their envelopes.
export const MAX_CANONICAL_NODES = 10000;
export const MAX_CANONICAL_BYTES = 2 * 1024 * 1024;
export const MAX_WORLD_CANONICAL_NODES = 40000;
export const MAX_WORLD_CANONICAL_BYTES = 4 * 1024 * 1024;

export class LocalError extends Error {
  constructor(code, status = 400, detail) { super(detail ?? code); this.code = code; this.status = status; }
}
export function check(condition, code, status = 400, detail) { if (!condition) throw new LocalError(code, status, detail); }

// Canonical JSON: sorted keys, dense arrays, safe integers only. Byte-identical
// to local/kernel/src/canonical-json.mjs in the QiMovi checkout so hashes agree.
export function canonicalJson(value) {
  // Mirror this bounded shape check in src/local/model.ts. A budget increase
  // is not contract validation; save/recovery/backup validators still run.
  const shape = (item, keys) => item !== null && typeof item === 'object'
    && [Object.prototype, null].includes(Object.getPrototypeOf(item))
    && Reflect.ownKeys(item).length === keys.length && keys.every(key => {
      const property = Object.getOwnPropertyDescriptor(item, key);
      return property?.enumerable && Object.hasOwn(property, 'value');
    });
  const developmentKeys = ['schemaVersion', 'projectId', 'draftId', 'concept', 'logline', 'synopsis', 'outline', 'beats', 'characters', 'worldNotes', 'researchNotes', 'world'];
  const worldV1 = item => shape(item, ['schemaVersion', 'elements', 'links']) && item.schemaVersion === 1
    && Array.isArray(item.elements) && Array.isArray(item.links);
  const developmentWorld = item => (
    shape(item, developmentKeys) && item.schemaVersion === 2
    || shape(item, [...developmentKeys, 'worldSources']) && item.schemaVersion === 3 && Array.isArray(item.worldSources)
  )
    && worldV1(item.world)
    && ['beats', 'characters', 'researchNotes'].every(key => Array.isArray(item[key]));
  const sharedWorld = item => shape(item, ['schemaVersion', 'projectId', 'name', 'description', 'world']) && item.schemaVersion === 1 && worldV1(item.world);
  const requestKeys = ['id', 'kind', 'expectedVersion', 'requestId', 'data'];
  const request = item => shape(item, requestKeys) && ['story-development', 'shared-world'].includes(String(item.kind));
  const record = item => (
    request(item)
    || shape(item, ['kind', 'expectedVersion', 'requestId', 'data'])
    || shape(item, ['id', 'kind', 'version', 'sha256', 'data'])
    || shape(item, ['id', 'kind', 'version', 'sha256', 'data', 'replayed'])
  ) && (item.kind === 'story-development' && developmentWorld(item.data) || item.kind === 'shared-world' && sharedWorld(item.data));
  const recovery = item => shape(item, ['schema', 'projectId', 'draftId', 'baseVersion', 'baseSha256', 'data', 'pendingSave', 'savedAt'])
    && item.schema === 'caniscreenwrite-story-development-recovery/v1'
    && (developmentWorld(item.data) || (request(item.pendingSave) && item.pendingSave.kind === 'story-development' && developmentWorld(item.pendingSave.data)));
  const largeWorld = worldV1(value) || developmentWorld(value) || sharedWorld(value) || record(value) || recovery(value);
  const maxNodes = largeWorld ? MAX_WORLD_CANONICAL_NODES : MAX_CANONICAL_NODES;
  const maxBytes = largeWorld ? MAX_WORLD_CANONICAL_BYTES : MAX_CANONICAL_BYTES;
  let nodes = 0;
  const normalize = (item, depth) => {
    check(depth <= 32 && ++nodes <= maxNodes, 'JSON_TOO_LARGE');
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return item;
    if (typeof item === 'number') { check(Number.isSafeInteger(item) && !Object.is(item, -0), 'NON_CANONICAL_NUMBER'); return item; }
    if (Array.isArray(item)) {
      const keys = Reflect.ownKeys(item).filter(key => key !== 'length');
      check(keys.length === item.length && keys.every(key => typeof key === 'string' && /^(?:0|[1-9]\d*)$/.test(key) && Number(key) < item.length), 'NON_CANONICAL_ARRAY');
      return item.map(child => normalize(child, depth + 1));
    }
    check(item && typeof item === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(item)), 'NON_JSON_VALUE');
    const output = {};
    for (const key of Object.keys(item).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
      check(!['__proto__', 'constructor', 'prototype'].includes(key), 'FORBIDDEN_JSON_KEY');
      output[key] = normalize(item[key], depth + 1);
    }
    return output;
  };
  const serialized = JSON.stringify(normalize(value, 0));
  check(Buffer.byteLength(serialized, 'utf8') <= maxBytes, 'JSON_TOO_LARGE');
  return serialized;
}
export const sha256 = value => crypto.createHash('sha256').update(value, 'utf8').digest('hex');
export const hashCanonical = value => sha256(canonicalJson(value));

export function privateDirectory(directory) {
  const absolute = path.resolve(directory);
  fs.mkdirSync(absolute, { recursive: true, mode: 0o700 });
  check(!fs.lstatSync(absolute).isSymbolicLink(), 'DATA_DIRECTORY_SYMLINK');
  fs.chmodSync(absolute, 0o700);
  return absolute;
}
export function atomicPrivateFile(filename, bytes) {
  const temp = `${filename}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temp, bytes, { mode: 0o600, flag: 'wx' });
    const fd = fs.openSync(temp, 'r');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temp, filename);
  } finally { fs.rmSync(temp, { force: true }); }
}
function readPrivateJson(filename, code) {
  check(fs.existsSync(filename), code);
  check(!fs.lstatSync(filename).isSymbolicLink(), 'PRIVATE_FILE_SYMLINK');
  check((fs.statSync(filename).mode & 0o077) === 0, 'PRIVATE_FILE_PERMISSIONS_TOO_OPEN');
  return JSON.parse(fs.readFileSync(filename, 'utf8'));
}

export function acquireLock(directory) {
  const filename = path.join(directory, 'process.lock');
  const nonce = crypto.randomUUID();
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(filename, JSON.stringify({ pid: process.pid, nonce }), { flag: 'wx', mode: 0o600 });
      return () => { try { if (JSON.parse(fs.readFileSync(filename, 'utf8')).nonce === nonce) fs.unlinkSync(filename); } catch { /* released */ } };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      // Serialize stale-lock inspection/removal. Without this guard, two
      // contenders can both see a dead PID and one can unlink the other's
      // newly acquired lock. An abandoned inspection fails closed.
      const inspection = path.join(directory, 'process.lock.inspect');
      try { fs.mkdirSync(inspection, { mode: 0o700 }); }
      catch { throw new LocalError('PROCESS_LOCK_REQUIRES_INSPECTION', 409); }
      try {
        if (!fs.existsSync(filename)) continue;
        check(fs.lstatSync(filename).isFile(), 'INVALID_PROCESS_LOCK');
        const lock = JSON.parse(fs.readFileSync(filename, 'utf8'));
        check(Number.isSafeInteger(lock.pid) && lock.pid > 0 && typeof lock.nonce === 'string', 'INVALID_PROCESS_LOCK');
        let alive = true;
        try { process.kill(lock.pid, 0); } catch (e) { if (e.code === 'ESRCH') alive = false; else throw e; }
        check(!alive, 'LOCAL_WRITER_ALREADY_RUNNING', 409);
        fs.unlinkSync(filename);
      } catch (error) {
        if (error.code === 'LOCAL_WRITER_ALREADY_RUNNING') throw error;
        throw new LocalError('PROCESS_LOCK_REQUIRES_INSPECTION', 409);
      } finally { fs.rmdirSync(inspection); }
    }
  }
  throw new LocalError('PROCESS_LOCK_CONFLICT', 409);
}

export function loadConfig(directory) {
  const config = readPrivateJson(path.join(directory, 'config.json'), 'RUN_INIT_FIRST');
  check(config.schema_version === CONFIG_SCHEMA && config.ownerActorId === 'local-owner' && SHA.test(config.ownerToken), 'INVALID_CONFIG');
  return config;
}

/** Create the private data directory, owner credential and default project. Idempotent. */
export function initialize(directory, { title = 'My screenplays' } = {}) {
  directory = privateDirectory(directory);
  const unlock = acquireLock(directory);
  let store;
  try {
    const filename = path.join(directory, 'config.json');
    if (!fs.existsSync(filename)) {
      atomicPrivateFile(filename, JSON.stringify({ schema_version: CONFIG_SCHEMA, ownerActorId: 'local-owner', ownerToken: crypto.randomBytes(32).toString('hex') }, null, 2) + '\n');
    }
    const config = loadConfig(directory);
    store = new WorkspaceStore(directory);
    if (!store.project()) store.initializeProject({ id: `local-writer:${crypto.randomUUID()}`, title, profile: PROJECT_PROFILE, sourceHash: null, sourceStatus: 'NO_SOURCE' });
    return config;
  } finally { try { store?.close(); } finally { unlock(); } }
}

// Connector settings hold another local service's owner credential. They stay
// in a separate 0600 file, never in a record, never returned to the browser.
export function loadConnections(directory) {
  const filename = path.join(directory, 'connections.json');
  if (!fs.existsSync(filename)) return { schema_version: 'caniscreenwrite-local-writer-connections/v1' };
  return readPrivateJson(filename, 'CONNECTIONS_UNREADABLE');
}
export function saveConnections(directory, connections) {
  atomicPrivateFile(path.join(directory, 'connections.json'), JSON.stringify({ schema_version: 'caniscreenwrite-local-writer-connections/v1', ...connections }, null, 2) + '\n');
}

export function validateProject(project) {
  check(project && typeof project === 'object' && !Array.isArray(project) && Object.keys(project).sort().join(',') === 'id,profile,sourceHash,sourceStatus,title', 'INVALID_PROJECT');
  check(typeof project.id === 'string' && ID.test(project.id) && typeof project.title === 'string' && project.title.isWellFormed() && !/[\0\r\n]/.test(project.title) && project.title.trim() && project.title.length <= 240, 'INVALID_PROJECT');
  check(project.profile === PROJECT_PROFILE && project.sourceHash === null && project.sourceStatus === 'NO_SOURCE', 'INVALID_PROJECT');
  return project;
}

export class WorkspaceStore {
  constructor(directory, validateRecord = () => {}) {
    this.directory = directory;
    this.validateRecord = validateRecord;
    const filename = path.join(directory, 'workspace.sqlite');
    try { check(fs.lstatSync(filename).isFile(), 'WORKSPACE_FILE_INVALID'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    this.db = new DatabaseSync(path.join(directory, 'workspace.sqlite'));
    try {
    fs.chmodSync(path.join(directory, 'workspace.sqlite'), 0o600);
    this.db.exec(`PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS records (id TEXT NOT NULL, kind TEXT NOT NULL, version INTEGER NOT NULL, sha256 TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(id,version));
      CREATE TABLE IF NOT EXISTS requests (id TEXT PRIMARY KEY, request_sha256 TEXT NOT NULL, result TEXT NOT NULL);
      CREATE TRIGGER IF NOT EXISTS immutable_records_update BEFORE UPDATE ON records BEGIN SELECT RAISE(ABORT,'IMMUTABLE_RECORD'); END;
      CREATE TRIGGER IF NOT EXISTS immutable_records_delete BEFORE DELETE ON records BEGIN SELECT RAISE(ABORT,'IMMUTABLE_RECORD'); END;`);
    } catch (error) { this.db.close(); throw error; }
  }
  close() { this.db.close(); }
  project() {
    const row = this.db.prepare("SELECT value FROM metadata WHERE key='project'").get();
    return row ? validateProject(JSON.parse(row.value)) : null;
  }
  initializeProject(project) {
    validateProject(project);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      check(this.db.prepare('SELECT COUNT(*) AS count FROM metadata').get().count === 0, 'WORKSPACE_NOT_EMPTY', 409);
      this.db.prepare('INSERT INTO metadata VALUES(?,?)').run('project', canonicalJson(project));
      this.db.exec('COMMIT');
    } catch (error) { if (this.db.isTransaction) this.db.exec('ROLLBACK'); throw error; }
    return project;
  }
  row(row, replayed = false) { return { id: row.id, kind: row.kind, version: row.version, sha256: row.sha256, data: JSON.parse(row.data), replayed }; }
  /** Current version of every record, optionally filtered by kind. */
  list(kind) {
    const rows = kind
      ? this.db.prepare('SELECT r.* FROM records r JOIN (SELECT id, MAX(version) AS version FROM records GROUP BY id) m ON r.id=m.id AND r.version=m.version WHERE r.kind=? ORDER BY r.id').all(kind)
      : this.db.prepare('SELECT r.* FROM records r JOIN (SELECT id, MAX(version) AS version FROM records GROUP BY id) m ON r.id=m.id AND r.version=m.version ORDER BY r.id').all();
    return rows.map(row => this.row(row));
  }
  current(id) {
    const row = this.db.prepare('SELECT * FROM records WHERE id=? ORDER BY version DESC LIMIT 1').get(id);
    return row ? this.row(row) : null;
  }
  history(id) {
    check(ID.test(id), 'INVALID_RECORD_ID');
    return this.db.prepare('SELECT * FROM records WHERE id=? ORDER BY version ASC').all(id).map(row => this.row(row));
  }
  /** Commit related local records and their request receipts together. Only
   * synchronous service operations may run inside this transaction. */
  atomic(operation) {
    check(!this.db.isTransaction, 'TRANSACTION_ALREADY_ACTIVE', 409);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      check(!result || typeof result.then !== 'function', 'ASYNC_TRANSACTION_REJECTED', 409);
      this.db.exec('COMMIT'); return result;
    } catch (error) { if (this.db.isTransaction) this.db.exec('ROLLBACK'); throw error; }
  }
  /**
   * Compare-and-set append. `expectedVersion` is null for a new record or the
   * exact current version. Identical `requestId` + identical input replays the
   * stored result; the same `requestId` with different input conflicts.
   */
  save(id, input) {
    check(input && Object.keys(input).sort().join(',') === 'data,expectedVersion,kind,requestId', 'INVALID_RECORD_REQUEST');
    const { kind, requestId, expectedVersion } = input;
    check(ID.test(id) && ID.test(kind) && ID.test(requestId), 'INVALID_RECORD_ID');
    check(id.startsWith(`${kind}:`) && id.length > kind.length + 1, 'RECORD_IDENTITY_MISMATCH');
    check(expectedVersion === null || (Number.isInteger(expectedVersion) && expectedVersion >= 1 && expectedVersion < 2147483647), 'INVALID_EXPECTED_VERSION');
    const dataText = canonicalJson(input.data);
    const snapshot = JSON.parse(dataText);
    const requestHash = sha256(canonicalJson({ id, kind, requestId, expectedVersion, data: snapshot }));
    const ownsTransaction = !this.db.isTransaction;
    if (ownsTransaction) this.db.exec('BEGIN IMMEDIATE');
    try {
      const prior = this.db.prepare('SELECT * FROM requests WHERE id=?').get(requestId);
      if (prior) {
        check(prior.request_sha256 === requestHash, 'REQUEST_ID_CONFLICT', 409);
        if (ownsTransaction) this.db.exec('COMMIT');
        return { ...JSON.parse(prior.result), replayed: true };
      }
      const project = this.project();
      check(project, 'PROJECT_NOT_INITIALIZED', 409);
      const current = this.current(id);
      check((current?.version ?? null) === expectedVersion, 'VERSION_CONFLICT', 409);
      check(!current || current.kind === kind, 'RECORD_KIND_CONFLICT', 409);
      this.validateRecord(kind, snapshot, project, { id, previous: current, store: this, writing: true });
      const result = { id, kind, version: (current?.version ?? 0) + 1, sha256: sha256(dataText), data: snapshot, replayed: false };
      this.db.prepare('INSERT INTO records VALUES(?,?,?,?,?)').run(id, kind, result.version, result.sha256, dataText);
      this.db.prepare('INSERT INTO requests VALUES(?,?,?)').run(requestId, requestHash, canonicalJson(result));
      if (ownsTransaction) this.db.exec('COMMIT');
      return result;
    } catch (error) { if (ownsTransaction && this.db.isTransaction) this.db.exec('ROLLBACK'); throw error; }
  }
}
