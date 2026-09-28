// Portable saved history only. Credentials, sessions, connector configuration,
// replay receipts and unsaved recovery are deliberately outside this format.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { WorkspaceStore, CONFIG_SCHEMA, ID, SHA, LocalError, check, canonicalJson, hashCanonical, validateProject, acquireLock, loadConfig, atomicPrivateFile } from './storage.mjs';
import { validateRecord } from './contracts.mjs';

export const BACKUP_SCHEMA = 'caniscreenwrite-local-writer-backup/v1';
export const MAX_BACKUP_BYTES = 128 * 1024 * 1024;
export const MAX_BACKUP_RECORDS = 100000;
const shape = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === keys.split(',').sort().join(',');
export const isoTimestamp = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;

/** Hash the ordered manifest, including record metadata, without imposing a
 * single record's canonical-JSON size/node limit on an entire workspace. */
export function backupChecksum(backup) {
  const digest = crypto.createHash('sha256');
  let size = 0;
  const add = value => {
    const line = canonicalJson(value) + '\n';
    size += Buffer.byteLength(line);
    check(size <= MAX_BACKUP_BYTES, 'BACKUP_TOO_LARGE', 413);
    digest.update(line);
  };
  add({ schema: backup.schema, createdAt: backup.createdAt, project: backup.project, recordCount: backup.records.length });
  for (const record of backup.records) add(record);
  return digest.digest('hex');
}

/** Validate every revision, chain, project binding and cross-record receipt. */
export function validateBackup(backup) {
  check(shape(backup, 'schema,createdAt,project,records,sha256') && backup.schema === BACKUP_SCHEMA, 'BACKUP_SCHEMA_INVALID', 422);
  check(isoTimestamp(backup.createdAt), 'BACKUP_TIMESTAMP_INVALID', 422);
  validateProject(backup.project);
  check(Array.isArray(backup.records) && backup.records.length <= MAX_BACKUP_RECORDS, 'BACKUP_RECORDS_INVALID', 422);
  check(typeof backup.sha256 === 'string' && SHA.test(backup.sha256), 'BACKUP_CHECKSUM_INVALID', 422);
  const histories = new Map();
  for (const record of backup.records) {
    check(shape(record, 'id,kind,version,sha256,data'), 'BACKUP_RECORD_INVALID', 422);
    check(typeof record.id === 'string' && ID.test(record.id) && typeof record.kind === 'string' && ID.test(record.kind) && record.id.startsWith(`${record.kind}:`) && record.id.length > record.kind.length + 1, 'BACKUP_RECORD_ID_INVALID', 422);
    check(Number.isSafeInteger(record.version) && record.version >= 1 && record.version <= 2147483647, 'BACKUP_VERSION_INVALID', 422);
    check(typeof record.sha256 === 'string' && SHA.test(record.sha256) && hashCanonical(record.data) === record.sha256, 'BACKUP_RECORD_CHECKSUM_MISMATCH', 422);
    const history = histories.get(record.id) ?? [];
    history.push(record); histories.set(record.id, history);
  }
  for (const history of histories.values()) history.sort((a, b) => a.version - b.version);
  const contextStore = {
    project: () => backup.project,
    history: id => histories.get(id) ?? [],
    current: id => histories.get(id)?.at(-1) ?? null,
  };
  for (const history of histories.values()) {
    history.forEach((record, index) => {
      check(record.version === index + 1 && record.kind === history[0].kind, 'BACKUP_HISTORY_INVALID', 422);
      validateRecord(record.kind, record.data, backup.project, { id: record.id, previous: history[index - 1], store: contextStore });
    });
  }
  check(backupChecksum(backup) === backup.sha256, 'BACKUP_CHECKSUM_MISMATCH', 422);
  return backup;
}

export function createBackup(store) {
  // One SQLite read transaction guarantees project + history share a snapshot.
  store.db.exec('BEGIN');
  try {
    const count = store.db.prepare('SELECT COUNT(*) AS count FROM records').get().count;
    check(count <= MAX_BACKUP_RECORDS, 'BACKUP_TOO_LARGE', 413);
    const records = [];
    let bytes = 0;
    for (const row of store.db.prepare('SELECT * FROM records ORDER BY id, version').iterate()) {
      bytes += Buffer.byteLength(row.data) + 512;
      check(bytes <= MAX_BACKUP_BYTES, 'BACKUP_TOO_LARGE', 413);
      records.push({ id: row.id, kind: row.kind, version: row.version, sha256: row.sha256, data: JSON.parse(row.data) });
    }
    const backup = { schema: BACKUP_SCHEMA, createdAt: new Date().toISOString(), project: store.project(), records };
    backup.sha256 = backupChecksum(backup);
    validateBackup(backup);
    check(Buffer.byteLength(JSON.stringify(backup)) <= MAX_BACKUP_BYTES, 'BACKUP_TOO_LARGE', 413);
    store.db.exec('COMMIT');
    return backup;
  } catch (error) { if (store.db.isTransaction) store.db.exec('ROLLBACK'); throw error; }
}

/** Stopped-workspace CLI backup. Running owners use the authenticated HTTP API. */
export function backupWorkspace(directory, output) {
  directory = path.resolve(directory); output = path.resolve(output);
  loadConfig(directory);
  const unlock = acquireLock(directory);
  let store;
  let temp;
  try {
    store = new WorkspaceStore(directory, validateRecord);
    const backup = createBackup(store);
    temp = `${output}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(backup) + '\n', { flag: 'wx', mode: 0o600 });
    const fd = fs.openSync(temp, 'r');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    // link is an atomic no-clobber publication, including dangling symlinks.
    try { fs.linkSync(temp, output); }
    catch (error) { if (error.code === 'EEXIST') throw new LocalError('BACKUP_DESTINATION_EXISTS', 409); throw error; }
    return { backedUp: true, file: output, project: backup.project, revisions: backup.records.length, sha256: backup.sha256 };
  } finally {
    try { if (temp) fs.rmSync(temp, { force: true }); }
    finally { try { store?.close(); } finally { unlock(); } }
  }
}

export function readBackup(filename) {
  const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    check(stat.isFile() && stat.size <= MAX_BACKUP_BYTES, 'BACKUP_FILE_INVALID', 422);
    // A bounded read also handles a file growing after fstat.
    const bytes = Buffer.alloc(Math.min(stat.size + 1, MAX_BACKUP_BYTES + 1));
    let count = 0;
    while (count < bytes.length) {
      const n = fs.readSync(fd, bytes, count, bytes.length - count, null);
      if (!n) break;
      count += n;
    }
    check(count === stat.size, 'BACKUP_FILE_CHANGED', 422);
    let backup;
    try { backup = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, count))); }
    catch { throw new LocalError('BACKUP_JSON_INVALID', 422); }
    return validateBackup(backup);
  } finally { fs.closeSync(fd); }
}

/** Restore only into an atomically reserved NEW directory. All project/record
 * inserts commit together; config is published last with a fresh credential. */
export function restoreWorkspace(directory, backup) {
  validateBackup(backup);
  directory = path.resolve(directory);
  try { fs.mkdirSync(directory, { mode: 0o700 }); }
  catch (error) { if (error.code === 'EEXIST') throw new LocalError('RESTORE_DESTINATION_EXISTS', 409); throw error; }
  let store;
  let unlock;
  try {
    unlock = acquireLock(directory);
    store = new WorkspaceStore(directory, validateRecord);
    store.db.exec('BEGIN IMMEDIATE');
    try {
      store.db.prepare('INSERT INTO metadata VALUES(?,?)').run('project', canonicalJson(backup.project));
      const insert = store.db.prepare('INSERT INTO records VALUES(?,?,?,?,?)');
      const ordered = [...backup.records].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : a.version - b.version);
      for (const record of ordered) insert.run(record.id, record.kind, record.version, record.sha256, canonicalJson(record.data));
      store.db.exec('COMMIT');
    } catch (error) { if (store.db.isTransaction) store.db.exec('ROLLBACK'); throw error; }
    store.close(); store = null;
    atomicPrivateFile(path.join(directory, 'config.json'), JSON.stringify({ schema_version: CONFIG_SCHEMA, ownerActorId: 'local-owner', ownerToken: crypto.randomBytes(32).toString('hex') }, null, 2) + '\n');
    unlock(); unlock = null;
    return { restored: true, directory, project: backup.project, revisions: backup.records.length, config: path.join(directory, 'config.json') };
  } catch (error) {
    try { store?.close(); }
    finally {
      if (unlock) {
        // Remove only files this invocation owns, while holding its lock.
        // Never recursively remove the destination after unlocking: another
        // initializer could acquire it in that gap and lose its new work.
        try {
          for (const name of ['config.json', 'workspace.sqlite', 'workspace.sqlite-journal', 'workspace.sqlite-wal', 'workspace.sqlite-shm']) {
            fs.rmSync(path.join(directory, name), { force: true });
          }
        } finally { unlock(); }
      }
      try { fs.rmdirSync(directory); }
      catch (cleanupError) { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(cleanupError.code)) throw cleanupError; }
    }
    throw error;
  }
}
