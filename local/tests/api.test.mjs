// Exercise the real TypeScript client, bundled with the already installed
// build tool, using a host bridge and fetch doubles. No native app is launched.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSync } from 'esbuild';
import { fileURLToPath } from 'node:url';

const bundled = buildSync({ entryPoints: [fileURLToPath(new URL('../../src/local/api.ts', import.meta.url))], bundle: true, write: false, format: 'esm', platform: 'browser', logLevel: 'silent' }).outputFiles[0].text;
let instance = 0;
async function client(t, responses, bridge = true) {
  const originalWindow = globalThis.window;
  const originalFetch = globalThis.fetch;
  const host = Object.assign(new EventTarget(), { setTimeout, clearTimeout });
  const calls = [];
  const messages = [];
  let lost = 0;
  host.addEventListener('local-writer:session-lost', () => lost++);
  if (bridge) host.webkit = { messageHandlers: { writerSession: { postMessage(message) {
    messages.push(message);
    if (bridge === 'fail') throw new Error('host not available');
    setTimeout(() => host.dispatchEvent(new Event('writer:session-restored')), 0);
  } } } };
  globalThis.window = host;
  globalThis.fetch = async (pathname, init) => {
    calls.push({ pathname, init });
    const [status, value] = responses.shift() ?? [500, { error: 'UNEXPECTED_RETRY' }];
    return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
  };
  t.after(() => { globalThis.window = originalWindow; globalThis.fetch = originalFetch; });
  const { localApi } = await import(`data:text/javascript;base64,${Buffer.from(bundled).toString('base64')}#${instance++}`);
  return { localApi, calls, messages, lost: () => lost };
}

const denied = [401, { error: 'OWNER_SESSION_REQUIRED' }];
test('native session restoration retries the exact mutation once without passing credentials to JavaScript', async t => {
  const copy = { draftId: 'screenplay-draft:test', data: { body: 'unsaved' } };
  const { localApi, calls, messages, lost } = await client(t, [denied, [200, copy]]);
  assert.deepEqual(await localApi.recovery.put(copy), copy);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].pathname, '/api/recovery/screenplay-draft%3Atest');
  assert.deepEqual(calls[0], calls[1]);
  assert.deepEqual(messages, [{ action: 'restore' }]);
  assert.equal(lost(), 0);
});

test('a still-expired native session stops after one retry and relocks', async t => {
  const { localApi, calls, messages, lost } = await client(t, [denied, denied]);
  await assert.rejects(localApi.recovery.list(), error => error.code === 'OWNER_SESSION_REQUIRED');
  assert.equal(calls.length, 2);
  assert.deepEqual(messages, [{ action: 'restore' }]);
  assert.equal(lost(), 1);
});

test('concurrent denied requests share one native restoration attempt', async t => {
  const { localApi, calls, messages } = await client(t, [denied, denied, [200, []], [200, null]]);
  await Promise.all([localApi.recovery.list(), localApi.recovery.get('screenplay-draft:one')]);
  assert.equal(calls.length, 4);
  assert.deepEqual(messages, [{ action: 'restore' }]);
});

test('browser sessions relock without a native bridge or unbounded retries', async t => {
  const { localApi, calls, messages, lost } = await client(t, [denied], false);
  await assert.rejects(localApi.recovery.list(), error => error.code === 'OWNER_SESSION_REQUIRED');
  assert.equal(calls.length, 1);
  assert.deepEqual(messages, []);
  assert.equal(lost(), 1);
});

test('native bridge failure relocks and session endpoints never recursively restore', async t => {
  const { localApi, calls, messages, lost } = await client(t, [denied, denied], 'fail');
  await assert.rejects(localApi.recovery.list(), error => error.code === 'OWNER_SESSION_REQUIRED');
  await assert.rejects(localApi.logout(), error => error.code === 'OWNER_SESSION_REQUIRED');
  assert.equal(calls.length, 2);
  assert.deepEqual(messages, [{ action: 'restore' }]);
  assert.equal(lost(), 1);
});

test('recovery removal can guard the acknowledged timestamp; backup exposes an ordinary URL', async t => {
  const { localApi, calls } = await client(t, [[200, { deleted: true }]], false);
  assert.equal(localApi.backupUrl, '/api/backup');
  assert.deepEqual(await localApi.recovery.remove('screenplay-draft:one', '2026-09-01T00:00:00.000Z'), { deleted: true });
  assert.equal(calls[0].init.method, 'DELETE');
  assert.equal(calls[0].pathname, '/api/recovery/screenplay-draft%3Aone?savedAt=2026-09-01T00%3A00%3A00.000Z');
});

test('development recovery client preserves the complete envelope and conditional removal interface', async t => {
  const copy = { schema: 'caniscreenwrite-story-development-recovery/v1', draftId: 'screenplay-draft:one', pendingSave: { requestId: 'keep-this-request', data: { concept: 'Submitted' } }, data: { concept: 'Newer working edits' } };
  const { localApi, calls } = await client(t, [[200, copy], [200, [copy]], [200, copy], [200, { deleted: true }]], false);
  assert.deepEqual(await localApi.developmentRecovery.put(copy), copy);
  assert.deepEqual(JSON.parse(calls[0].init.body), copy);
  assert.deepEqual(await localApi.developmentRecovery.list(), [copy]);
  assert.deepEqual(await localApi.developmentRecovery.get(copy.draftId), copy);
  assert.deepEqual(await localApi.developmentRecovery.remove(copy.draftId, '2026-09-01T00:00:00.000Z'), { deleted: true });
  assert.equal(calls[0].pathname, '/api/development-recovery/screenplay-draft%3Aone');
  assert.equal(calls[1].pathname, '/api/development-recovery');
  assert.equal(calls[3].pathname, '/api/development-recovery/screenplay-draft%3Aone?savedAt=2026-09-01T00%3A00%3A00.000Z');
});
