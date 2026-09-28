#!/usr/bin/env node
// Repeatable, offline desktop -> Swift Core -> desktop integration check.
// Run with Node >=22.13 (node:sqlite) and swiftc on PATH. No npm/SwiftPM build.
// Optional evidence: node iphone/scripts/check-exchange.mjs --evidence-prefix output/iphone/2026-09-27/interop
// Only a unique mkdtemp directory is removed; an existing workspace is never opened.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../../', import.meta.url));
const argv = process.argv.slice(2);
if (argv.length && (argv.length !== 2 || argv[0] !== '--evidence-prefix')) {
  console.error('Usage: node iphone/scripts/check-exchange.mjs [--evidence-prefix PATH]');
  process.exit(2);
}
const evidencePrefix = argv.length ? path.resolve(argv[1]) : null;
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
const command = args => args.map(quote).join(' ');
const report = { startedAt: new Date().toISOString(), cwd: process.cwd(), root,
  command: command([process.execPath, ...process.execArgv, ...process.argv.slice(1)]),
  node: process.version, nodeExecutable: process.execPath, status: 'running', checks: [], cases: [], commands: [] };
const log = [];
let scratch, store;
function say(line) { log.push(line); console.log(line); }
function passed(line) { report.checks.push(line); say(`PASS ${line}`); }
function run(executable, args, env = process.env) {
  const invocation = command([executable, ...args]);
  say(`$ ${invocation}`);
  const result = spawnSync(executable, args, { cwd: root, env, encoding: 'utf8', timeout: 120_000, maxBuffer: 4 * 1024 * 1024 });
  report.commands.push({ command: invocation, status: result.status, signal: result.signal,
    stdout: result.stdout ?? '', stderr: result.stderr ?? '', ...(result.error ? { error: result.error.message } : {}) });
  if (result.stdout?.trim()) say(result.stdout.trimEnd());
  if (result.stderr?.trim()) say(result.stderr.trimEnd());
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${executable} failed (${result.signal ?? result.status})`);
  return result.stdout.trim();
}
function artifact(name, bytes) {
  if (evidencePrefix) fs.writeFileSync(`${evidencePrefix}-${name}`, bytes);
}
function save(id, data, expectedVersion = null) {
  return store.save(id, { kind: id.split(':')[0], data, expectedVersion, requestId: randomUUID() });
}
function storageState() {
  return { records: store.db.prepare('SELECT * FROM records ORDER BY id, version').all(),
    requests: store.db.prepare('SELECT * FROM requests ORDER BY id').all() };
}
function originalState(draftId, developmentId) {
  return { draft: store.current(draftId), development: store.current(developmentId),
    draftHistory: store.history(draftId), developmentHistory: store.history(developmentId),
    rawRecords: store.db.prepare('SELECT * FROM records WHERE id IN (?, ?) ORDER BY id, version').all(draftId, developmentId) };
}

// Stable synthetic identities and text make changes inspectable across runs.
function fixture(index, targetPages) {
  const uuid = n => `aabbccdd-1234-4567-89ab-${String(n).padStart(12, '0')}`;
  const authored = '  café e\u0301 🎬 👩🏽‍🚀 海 العربية\r\nsecond\rthird\nlast\t  ';
  return { id: uuid(100 + index), title: '  Harbor 海 🎬 café e\u0301  ',
    body: `Title: Harbor\r\n\r\nINT. HARBOR - NIGHT #α-12#\r\n\r\nÉ\r\n${authored}`,
    genre: '  Drama / ドラマ  ', logline: `A return.\r\n${authored}`, projectFormat: 'feature',
    ...(targetPages === undefined ? {} : { targetPages }),
    development: { concept: authored, logline: 'Development logline\r\n海', synopsis: `Synopsis\n${authored}`,
      outline: `I. Arrival\r\nII. Return\r${authored}`, worldNotes: `World\r\n${authored}`,
      beats: [{ id: uuid(1), title: '  Arrival 🎬  ', description: authored },
        { id: uuid(2), title: 'Return', description: '  Last beat.\r\n  ' }],
      characters: [{ id: uuid(3), name: 'É / 海', role: '  Lead  ', description: authored, arc: `Returns\r\n${authored}` }],
      researchNotes: [{ id: uuid(4), title: 'Tides 🌊', notes: authored, source: '  Synthetic journal\r\npage e\u0301  ' }],
      world: { schemaVersion: 1, elements: [
        { id: uuid(5), type: 'location', name: '  Port 海  ', description: authored,
          storyFunction: 'Arrival\r\nDeparture', sensoryDetails: authored, continuity: 'Night\r\nDawn', status: 'established', order: 8 },
        { id: uuid(6), type: 'prop', name: 'Compass 🎬', description: '  Brass\r\n  ',
          storyFunction: 'Guide', sensoryDetails: 'Cold\rmetal', continuity: authored, status: 'needs_review', order: 2 }],
        links: [
          { id: uuid(7), elementId: uuid(5).toUpperCase(), targetType: 'element', targetRef: uuid(6).toUpperCase(), targetLabel: '  Compass  ', notes: authored },
          { id: uuid(8), elementId: uuid(5), targetType: 'scene', targetRef: '  opaque:scene/α#12?cut=海&e=e\u0301\r\n  ', targetLabel: '  Opening 🎬  ', notes: authored },
          { id: uuid(9), elementId: uuid(6), targetType: 'character', targetRef: '  É / 海\r\nopaque character  ', targetLabel: 'É / 海', notes: authored },
        ] } } };
}

// Independent expected edits: no output from the Swift program supplies the oracle.
function edited(snapshot) {
  const value = structuredClone(snapshot);
  value.body += '\r\nEXT. 帰り道 - DAWN #opaque-final#\r\n\r\nÉ\r\nStill e\u0301; still 海 🎬.\r\n';
  value.development.worldNotes += '\r\nSwift world note: café / e\u0301 / العربية.  ';
  value.development.world.elements[0].description += '\r\nSwift: the tide returns 🌊.  ';
  value.development.world.links[1].notes += '\r\nSwift: keep this scene reference opaque.  ';
  return value;
}
function defaultSnapshot(id) {
  return { id, title: 'Untitled', body: '', genre: '', logline: '', projectFormat: '',
    development: { concept: '', logline: '', synopsis: '', outline: '', beats: [], characters: [],
      worldNotes: '', researchNotes: [], world: { schemaVersion: 1, elements: [], links: [] } } };
}

try {
  if (evidencePrefix) fs.mkdirSync(path.dirname(evidencePrefix), { recursive: true });
  say(`$ ${report.command}`);
  const [major, minor] = process.versions.node.split('.').map(Number);
  assert.ok(major > 22 || (major === 22 && minor >= 13), `Node >=22.13 is required for node:sqlite; received ${process.version}`);
  say(`Runtime: ${process.version} (${process.execPath})`);
  const { initialize, WorkspaceStore } = await import('../../local/server/storage.mjs');
  const { validateRecord } = await import('../../local/server/contracts.mjs');
  const { decodePocketPackage, exportPocketPackage, previewPocketPackage, importPocketPackage } = await import('../../local/server/pocket-exchange.mjs');
  const sourceFiles = ['iphone/CONTRACT.md', 'iphone/Core/Package.swift',
    'iphone/Core/Sources/ScreenwriteCore/Models.swift', 'iphone/Core/Sources/ScreenwriteCore/PocketPackage.swift',
    'iphone/scripts/ExchangeRoundtrip.swift', 'iphone/scripts/check-exchange.mjs',
    'local/server/pocket-exchange.mjs', 'local/server/storage.mjs', 'local/server/contracts.mjs',
    'local/server/development.mjs', 'local/server/world.mjs'];
  const sourceHashes = () => Object.fromEntries(sourceFiles.map(name => [name, sha256(fs.readFileSync(path.join(root, name)))]));
  report.sources = sourceHashes();
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'qiscript-interop-'));
  report.scratch = scratch;
  const workspace = path.join(scratch, 'workspace');
  const binary = path.join(scratch, 'ExchangeRoundtrip');
  const cache = path.join(scratch, 'module-cache');
  fs.mkdirSync(cache);
  const compiler = process.env.SWIFTC ?? 'swiftc';
  report.swift = run(compiler, ['--version']);
  run(compiler, ['-parse-as-library', '-module-cache-path', cache,
    path.join(root, 'iphone/Core/Sources/ScreenwriteCore/Models.swift'),
    path.join(root, 'iphone/Core/Sources/ScreenwriteCore/PocketPackage.swift'),
    path.join(root, 'iphone/scripts/ExchangeRoundtrip.swift'), '-o', binary],
  { ...process.env, CLANG_MODULE_CACHE_PATH: cache });
  passed('Swift CLI compiled directly from Core sources; isolated binary and module cache');
  initialize(workspace, { title: 'Synthetic .qiscript interoperability check' });
  store = new WorkspaceStore(workspace, validateRecord);

  function returnedCopy(bytes, expected) {
    const before = storageState();
    const preview = previewPocketPackage(store, bytes);
    assert.deepEqual(preview.snapshot, expected);
    assert.deepEqual(storageState(), before, 'Preview must be read-only');
    assert.throws(() => importPocketPackage(store, bytes, '0'.repeat(64)), { code: 'POCKET_PREVIEW_MISMATCH' });
    assert.deepEqual(storageState(), before, 'Wrong reviewed hash must not write');
    const result = importPocketPackage(store, bytes, preview.contentSha256);
    assert.equal(result.replayed, false);
    assert.notEqual(result.draft.id, `screenplay-draft:${expected.id}`);
    assert.equal(result.draft.version, 1);
    assert.equal(result.development.version, 1);
    assert.equal(result.draft.data.projectId, store.project().id);
    assert.equal(result.development.data.draftId, result.draft.id);
    assert.equal(result.draft.data.sourceHash, null);
    assert.equal(result.draft.data.status, 'DRAFT');
    const exported = Buffer.from(JSON.stringify(exportPocketPackage(store, result.draft.id)));
    const mapped = { ...expected, id: result.draft.id.slice('screenplay-draft:'.length) };
    assert.deepEqual(decodePocketPackage(exported).snapshot, mapped, 'All creative fields must survive storage and export exactly');
    const importedState = storageState();
    const retry = importPocketPackage(store, bytes, preview.contentSha256);
    assert.equal(retry.replayed, true);
    assert.deepEqual(retry.draft, result.draft);
    assert.deepEqual(retry.development, result.development);
    assert.deepEqual(storageState(), importedState, 'Retry must not append records or receipts');
    return { result, exported, mapped };
  }

  for (const [index, targetPages] of [undefined, 1, 1000].entries()) {
    const name = targetPages === undefined ? 'pages-absent' : `pages-${targetPages}`;
    const input = fixture(index, targetPages), expected = edited(input);
    const draftId = `screenplay-draft:${input.id}`, developmentId = `story-development:${input.id}`;
    const { id, development, ...creative } = input;
    const draftData = { schemaVersion: 2, projectId: store.project().id, sourceHash: null,
      format: 'FOUNTAIN', status: 'DRAFT', ...creative };
    save(draftId, { ...draftData, body: 'Synthetic earlier draft\r\n' });
    save(draftId, draftData, 1);
    const developmentData = { ...development, schemaVersion: 2, projectId: store.project().id, draftId };
    save(developmentId, { ...developmentData, concept: 'Synthetic earlier concept' });
    save(developmentId, developmentData, 1);
    const original = originalState(draftId, developmentId);
    const beforeExport = storageState();
    const desktopBytes = Buffer.from(JSON.stringify(exportPocketPackage(store, draftId)));
    assert.deepEqual(decodePocketPackage(desktopBytes).snapshot, input);
    assert.deepEqual(storageState(), beforeExport);
    const inputFile = path.join(scratch, `${name}-desktop.qiscript`);
    const oracleFile = path.join(scratch, `${name}-expected.json`);
    const returnFile = path.join(scratch, `${name}-swift.qiscript`);
    fs.writeFileSync(inputFile, desktopBytes);
    fs.writeFileSync(oracleFile, JSON.stringify(input));
    run(binary, ['roundtrip', inputFile, oracleFile, returnFile]);
    assert.deepEqual(fs.readFileSync(inputFile), desktopBytes, 'Swift must leave its source file unchanged');
    const swiftBytes = fs.readFileSync(returnFile);
    const decoded = decodePocketPackage(swiftBytes);
    assert.deepEqual(decoded.snapshot, expected, 'Swift edits and every unedited UTF-16 code unit must match');
    assert.equal(Object.hasOwn(decoded.snapshot, 'targetPages'), targetPages !== undefined);
    const { result, exported, mapped } = returnedCopy(swiftBytes, expected);
    assert.deepEqual(originalState(draftId, developmentId), original, 'Original records, raw JSON, checksums and both revisions must be unchanged');
    store.close(); store = null;
    store = new WorkspaceStore(workspace, validateRecord);
    assert.deepEqual(originalState(draftId, developmentId), original, 'Original state must survive restart unchanged');
    assert.deepEqual(decodePocketPackage(JSON.stringify(exportPocketPackage(store, result.draft.id))).snapshot, mapped);
    const beforeReplay = storageState();
    assert.equal(importPocketPackage(store, swiftBytes, decoded.contentSha256).replayed, true);
    assert.deepEqual(storageState(), beforeReplay, 'Replay after restart must not write');
    for (const [suffix, bytes] of [['desktop', desktopBytes], ['swift', swiftBytes], ['returned', exported]]) {
      artifact(`${name}-${suffix}.qiscript`, bytes);
    }
    report.cases.push({ name, targetPages: targetPages ?? 'absent', sourceDraftId: draftId,
      returnedDraftId: result.draft.id, originalRevisionsPerRecord: 2,
      desktopPayloadSha256: decodePocketPackage(desktopBytes).contentSha256,
      swiftPayloadSha256: decoded.contentSha256, returnedPayloadSha256: decodePocketPackage(exported).contentSha256,
      bodyUtf8Sha256: sha256(Buffer.from(mapped.body)), originalUnchanged: true, restartAndReplay: true });
    passed(`${name}: saved desktop -> Swift edit -> desktop import/export; exact creative contents, separate identity, original history unchanged, restart/replay`);
  }

  const defaultFile = path.join(scratch, 'defaults.qiscript'), populatedFile = path.join(scratch, 'default-rows.qiscript');
  run(binary, ['defaults', defaultFile, populatedFile]);
  const defaultIds = new Set();
  for (const [name, filename] of [['defaults', defaultFile], ['default-rows', populatedFile]]) {
    const bytes = fs.readFileSync(filename), { snapshot } = decodePocketPackage(bytes);
    const expected = defaultSnapshot(snapshot.id);
    if (name === 'default-rows') {
      const dev = snapshot.development;
      expected.development.beats = [{ id: dev.beats[0].id, title: '', description: '' }];
      expected.development.characters = [{ id: dev.characters[0].id, name: '', role: '', description: '', arc: '' }];
      expected.development.researchNotes = [{ id: dev.researchNotes[0].id, title: '', notes: '', source: '' }];
      expected.development.world.elements = [{ id: dev.world.elements[0].id, type: 'location', name: '', description: '',
        storyFunction: '', sensoryDetails: '', continuity: '', status: 'idea', order: 0 }];
      expected.development.world.links = [{ id: dev.world.links[0].id, elementId: dev.world.elements[0].id,
        targetType: 'scene', targetRef: 'opaque:default/海#e\u0301', targetLabel: '', notes: '' }];
    }
    assert.deepEqual(snapshot, expected, 'Public Swift initializer defaults must be valid and exact on desktop');
    const ids = [snapshot.id, ...Object.values(snapshot.development).filter(Array.isArray).flat().map(row => row.id),
      ...snapshot.development.world.elements.map(row => row.id), ...snapshot.development.world.links.map(row => row.id)];
    for (const value of ids) {
      assert.match(value, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      assert.ok(!defaultIds.has(value), 'Default UUIDs must be independent'); defaultIds.add(value);
    }
    assert.equal(Object.hasOwn(snapshot, 'targetPages'), false);
    returnedCopy(bytes, expected);
    artifact(`${name}.qiscript`, bytes);
    passed(`${name}: Swift validate/encode/decode, desktop decode/import/export, absent targetPages, valid independent default IDs`);
  }
  assert.deepEqual(sourceHashes(), report.sources, 'Source files changed during the check; rerun against a stable source snapshot');
  passed('Contract, Package.swift, compiled sources and checked desktop modules unchanged during run');
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.error = error.stack ?? String(error);
  say(`FAIL ${report.error}`);
  process.exitCode = 1;
} finally {
  try { store?.close(); } catch (error) { report.status = 'failed'; process.exitCode = 1; say(`FAIL closing test store: ${error.message}`); }
  if (scratch) {
    try {
      fs.rmSync(scratch, { recursive: true, force: true });
      assert.equal(fs.existsSync(scratch), false);
      report.scratchRemoved = true;
      passed('Only this run\'s temporary workspace, files, executable and module cache removed');
    } catch (error) { report.status = 'failed'; process.exitCode = 1; say(`FAIL scratch cleanup: ${error.message}`); }
  }
  report.finishedAt = new Date().toISOString();
  say(`${report.status === 'passed' ? 'PASS' : 'FAIL'} .qiscript cross-language integration (${report.checks.length} checks)`);
  artifact('evidence.json', JSON.stringify(report, null, 2) + '\n');
  artifact('output.txt', log.join('\n') + '\n');
}
