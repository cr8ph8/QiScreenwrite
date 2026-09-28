import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { initialize, loadConfig, sha256 } from '../server/storage.mjs';
import { startServer } from '../server/http.mjs';
import { RIGHTS_ID, defaultParticipation, recordRef, emptyPublicFields } from '../contracts/writer-rights.mjs';

const installed = process.env.QIMOVI_RUNTIME;
if (!installed || !path.isAbsolute(installed)) throw new Error('Set QIMOVI_RUNTIME to an explicitly chosen compatible QiMovi runtime.');

test('installed QiMovi Library → authenticated writer → editable history, original, rights and preservation', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'writer-library-http-'));
  const directory = path.join(root, 'writer'), remoteDirectory = path.join(root, 'qimovi');
  const remoteImport = file => import(pathToFileURL(path.join(installed, file)));
  const [{ startServer: startRemote }, { createCreativeProject }, { validateRecord }] = await Promise.all([
    remoteImport('local/server/http.mjs'), remoteImport('local/server/creative-project.mjs'), remoteImport('local/contracts/drifter.mjs'),
  ]);
  await createCreativeProject(remoteDirectory, 'Synthetic Library source');
  const remote = await startRemote({ directory: remoteDirectory, port: 0, dist: path.join(root, 'no-ui'), validateRecord });
  initialize(directory, { title: 'Synthetic Library recipient' });
  const writer = await startServer({ directory });
  t.after(async () => { await writer.close(); await remote.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const login = async (service, token) => {
    const r = await fetch(service.origin + '/api/session', { method: 'POST', headers: { Origin: service.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) });
    assert.equal(r.status, 200); return r.headers.get('set-cookie').split(';')[0];
  };
  const remoteToken = JSON.parse(fs.readFileSync(path.join(remoteDirectory, 'config.json'), 'utf8')).ownerToken;
  const native = await login(remote, remoteToken);
  const cookie = await login(writer, loadConfig(directory).ownerToken);
  const remoteHeaders = { Origin: remote.origin, Cookie: native };
  const headers = { Origin: writer.origin, Cookie: cookie, 'Content-Type': 'application/json' };
  const req = async (route, data, extra = {}) => {
    const response = await fetch(writer.origin + route, { headers, ...(data === undefined ? {} : { method: 'POST', body: JSON.stringify(data) }), ...extra });
    return { status: response.status, data: await response.json() };
  };
  const remoteSnapshot = async () => {
    const response = await fetch(remote.origin + '/api/bootstrap', { headers: remoteHeaders });
    assert.equal(response.status, 200, 'native QiMovi session remains usable'); return response.json();
  };
  const remoteProject = (await remoteSnapshot()).project;
  const originals = [
    { filename: 'Synthetic original.fountain', bytes: Buffer.from('Title: Synthetic voyage\r\n\r\nINT. HARBOR - DAY\r\n\r\nA boat arrives.\r\n\r\nANA\r\nAt last.\r\n') },
    { filename: 'Synthetic original.fdx', bytes: Buffer.from('<?xml version="1.0" encoding="UTF-8"?><FinalDraft DocumentType="Script" Template="No" Version="1"><Content><Paragraph Type="Scene Heading"><Text>INT. ROOM - DAY</Text></Paragraph><Paragraph Type="Action"><Text>The light returns.</Text></Paragraph></Content></FinalDraft>') },
  ];
  for (const file of originals) {
    const response = await fetch(remote.origin + '/api/project-library/upload', { method: 'POST', headers: {
      ...remoteHeaders, 'Content-Type': 'application/octet-stream', 'Content-Length': String(file.bytes.length),
      'X-Library-Project-Id': remoteProject.id, 'X-Library-Source-Hash': String(remoteProject.sourceHash),
      'X-Library-Byte-Length': String(file.bytes.length), 'X-Library-Sha256': sha256(file.bytes), 'X-Library-Filename': encodeURIComponent(file.filename),
    }, body: file.bytes });
    const result = await response.json(); assert.equal(response.status, 200, JSON.stringify(result));
    file.record = result.records[0];
  }
  const remoteBefore = await remoteSnapshot();
  assert.equal((await req('/api/connectors/qimovi/config', { origin: remote.origin, ownerToken: remoteToken }, { method: 'PUT' })).status, 200);
  const routes = [['GET','/library'], ['POST','/library/preview'], ['POST','/library/import']];
  for (const [method, route] of routes) {
    const data = method === 'POST' ? {} : undefined;
    assert.equal((await req('/api/connectors/qimovi' + route, data, { method, headers: { ...headers, Cookie: '' } })).status, 401);
    assert.equal((await req('/api/connectors/qimovi' + route, data, { method, headers: { ...headers, Origin: 'https://foreign.invalid' } })).status, 403);
  }
  const catalog = await req('/api/connectors/qimovi/library');
  assert.equal(catalog.status, 200, JSON.stringify(catalog.data));
  assert.equal(catalog.data.assets.length, 2);
  assert.doesNotMatch(JSON.stringify(catalog.data), /sourcePaths|collectionPath|ownerToken/);
  const { project } = (await req('/api/bootstrap')).data;
  const save = (id, data, version = null) => req('/api/records/' + encodeURIComponent(id), { kind: id.split(':')[0], expectedVersion: version, requestId: crypto.randomUUID(), data }, { method: 'PUT' });
  const imported = [];
  for (const file of originals) {
    const preview = await req('/api/connectors/qimovi/library/preview', { recordId: file.record.id });
    assert.equal(preview.status, 200, JSON.stringify(preview.data));
    assert.equal(preview.data.text, file.bytes.toString('utf8'));
    assert.equal(preview.data.asset.contentSha256, sha256(file.bytes));
    const input = { token: preview.data.token, title: file.filename, body: file.filename.endsWith('.fdx') ? 'INT. ROOM - DAY\n\nThe light returns.' : preview.data.text, conversion: file.filename.endsWith('.fdx') ? 'FDX_REVIEWED' : 'FOUNTAIN_UTF8' };
    const result = await req('/api/connectors/qimovi/library/import', input);
    assert.equal(result.status, 200, JSON.stringify(result.data)); imported.push(result.data);
    assert.equal(result.data.replayed, false);
    assert.deepEqual(Buffer.from(result.data.document.data.base64, 'base64'), file.bytes);
    assert.deepEqual(result.data.receipt.data.draftRef, recordRef(result.data.draft));
    assert.equal((await req('/api/connectors/qimovi/library/import', input)).data.replayed, true);
    const changed = { ...result.data.draft.data, body: result.data.draft.data.body + '\n\nA second beat.' };
    assert.equal((await save(result.data.draft.id, changed, 1)).status, 200);
    assert.equal((await req('/api/connectors/qimovi/library/import', input)).data.draft.version, 1, 'retry returns original derivation without replacing working edits');
    assert.equal((await req('/api/bootstrap')).data.records.find(row => row.id === result.data.draft.id).version, 2);
    for (const record of [result.data.document, result.data.receipt]) {
      const forged = await save(record.id, record.data, 1);
      assert.equal(forged.status, 409); assert.equal(forged.data.error, 'SOURCE_REQUIRES_IMPORT');
    }
  }
  const ledger = defaultParticipation(project);
  ledger.parties = [{ id: 'writer', kind: 'PERSON', name: 'Synthetic writer' }];
  ledger.pools = [{ id: 'pool', name: 'Original screenplay interest', kind: 'COPYRIGHT_INTEREST', subject: { kind: 'RECORD', label: 'Retained original', recordRef: recordRef(imported[0].document), assetHash: null }, definition: '', entityName: '', currency: '', receiptsMinor: null, deductionsMinor: null, recoupmentMinor: null, allocations: [{ id: 'share', partyId: 'writer', shareBps: null, agreementStatus: 'PROPOSED', evidenceHashes: [] }] }];
  const savedLedger = await save(RIGHTS_ID, ledger); assert.equal(savedLedger.status, 200, JSON.stringify(savedLedger.data));
  const tokenData = { schemaVersion: 1, projectId: project.id, status: 'DRAFT', subjectRef: recordRef(imported[0].document), participationRef: recordRef(savedLedger.data), standard: 'UNDECIDED', editionCap: null, royaltyRequestBps: null, publicFields: { ...emptyPublicFields(), name: 'Synthetic public description' }, nonce: 'a'.repeat(64) };
  const token = await save('token-preparation:library-test', tokenData); assert.equal(token.status, 200, JSON.stringify(token.data));
  const publicPreview = await req('/api/rights/token-preview', recordRef(token.data));
  assert.equal(publicPreview.status, 200);
  assert.doesNotMatch(JSON.stringify(publicPreview.data.metadata), /base64|boat arrives|sourcePaths|original.fountain|Synthetic writer/);
  const inventory = await req('/api/preservation');
  const archive = await req('/api/preservation/export', { sourceSha256: inventory.data.sourceSha256 });
  assert.equal(archive.status, 200, JSON.stringify(archive.data).slice(0,300));
  const verified = await req('/api/preservation/verify', archive.data);
  assert.equal(verified.status, 200, JSON.stringify(verified.data));
  assert.equal(verified.data.valid, true);
  const all = (await req('/api/bootstrap')).data.records;
  assert.equal(all.filter(row => row.kind === 'source-document').length, 2);
  assert.equal(all.filter(row => row.kind === 'source-import').length, 2);
  assert.equal(all.filter(row => row.kind === 'sync-link').length, 0);
  const remoteAfter = await remoteSnapshot();
  assert.deepEqual(remoteAfter.records, remoteBefore.records, 'reviewed import never mutates remote records');
  assert.deepEqual(remoteAfter.canonical, remoteBefore.canonical);
  assert.deepEqual(remoteAfter.project, remoteBefore.project);
});
