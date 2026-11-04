// Bridge to a running QiMovi / FilmStack local service (Qi Movie Slate).
//
// QiMovi's service only accepts requests whose Host and Origin match its own
// loopback origin, and it authenticates with an HttpOnly owner cookie. A page
// served from this writer's origin cannot call it from the browser, so the
// bridge runs here, server-to-server, on the same machine. The QiMovi owner
// token is read from connections.json (0600) and is never sent to the browser.
//
// Record identity is shared: a local `screenplay-draft:<uuid>` is pushed to
// QiMovi under the same id, with QiMovi's own CAS versioning. Pushing never
// admits a source, replaces a frozen film screenplay or approves anything;
// the result is an ordinary QiMovi workspace draft the filmmaker can review.
import { LocalError, check, canonicalJson, ID, SHA, sha256, loadConnections, saveConnections } from './storage.mjs';
import { toQiMoviDraft, fromQiMoviDraft, validateScreenplayDraft } from './contracts.mjs';
import { validateDevelopment } from './development.mjs';
import { installedQiMoviDiscovery } from './qimovi-discovery.mjs';
import { universeSource, universeBinding, planUniverse, publicUniversePlan, saveUniverseReceipt } from './qimovi-universe.mjs';
import { previewWorldReturn, pullWorldReturn } from './qimovi-world-return.mjs';

const ORIGIN = /^http:\/\/127\.0\.0\.1:\d{1,5}$/;
const COOKIE = 'caniscreenwrite_bridge';
const PROTOCOL = 'caniscreenwrite-bridge/v1';
const suffix = draftId => draftId.slice('screenplay-draft:'.length);
const revision = record => ({ id: record.id, version: record.version, sha256: record.sha256 });
const upgradeMessage = 'QiMovi needs the scoped CanIScreenwrite bridge update. Install the reviewed update and reopen QiMovi; the writer will not replace its native session.';

// No wall-clock fields: retrying the same saved revisions yields identical bytes.
export function worldExports(store, draftId) {
  check(typeof draftId === 'string' && /^screenplay-draft:[0-9a-f-]{36}$/i.test(draftId), 'INVALID_RECORD_ID', 422);
  const draft = store.current(draftId), development = store.current(`story-development:${suffix(draftId)}`), project = store.project();
  check(draft?.kind === 'screenplay-draft', 'DRAFT_NOT_FOUND', 404);
  check(development?.kind === 'story-development' && [2, 3].includes(development.data.schemaVersion), 'QIMOVI_WORLD_SAVE_REQUIRED', 409, 'Save the structured world in this draft before sending it to QiMovi.');
  validateScreenplayDraft(draft.data, project);
  validateDevelopment(development.data, project, { id: development.id, store });
  for (const record of [draft, development]) check(record.sha256 === sha256(canonicalJson(record.data)), 'QIMOVI_LOCAL_REVISION_INVALID', 409);
  // Canonicalize the validated v2/v3 root separately so its larger node budget
  // applies. The fixed export envelope must not downgrade it to a generic root.
  const snapshot = { schemaVersion: 'caniscreenwrite-world-export/v1', scope: 'DEVELOPMENT_REFERENCE', project: { id: project.id, title: project.title }, draft: { ...revision(draft), title: draft.data.title }, development: { ...revision(development), data: JSON.parse(canonicalJson(development.data)) } };
  const json = Buffer.from(JSON.stringify(snapshot, null, 2) + '\n', 'utf8');
  const lines = ['# CanIScreenwrite development and world', '', 'Authored development reference. No production approval or source admission is implied.', '', `Draft: ${draft.id} · revision ${draft.version} · ${draft.sha256}`, `Development: ${development.id} · revision ${development.version} · ${development.sha256}`, ''];
  const render = (value, label, depth = 2) => {
    lines.push(`${'#'.repeat(Math.min(depth, 6))} ${label}`, '');
    if (Array.isArray(value)) {
      if (!value.length) lines.push('(empty)', '');
      value.forEach((entry, index) => render(entry, `${label} ${index + 1}`, depth + 1));
    } else if (value && typeof value === 'object') {
      for (const [key, entry] of Object.entries(value)) render(entry, key.replace(/([a-z])([A-Z])/g, '$1 $2'), depth + 1);
    } else {
      const text = String(value ?? ''), runs = [...text.matchAll(/~+/g)].map(match => match[0].length);
      const fence = '~'.repeat(Math.max(3, ...runs.map(n => n + 1)));
      lines.push(`${fence}text`, text, fence, '');
    }
  };
  render(snapshot.development.data, 'Saved development');
  const markdown = Buffer.from(lines.join('\n') + '\n', 'utf8');
  const stem = `caniscreenwrite-world-${suffix(draft.id)}-v${development.version}`;
  return { draft: revision(draft), development: revision(development), files: [
    { filename: `${stem}.json`, bytes: json, sha256: sha256(json), mimeType: 'application/json' },
    { filename: `${stem}.md`, bytes: markdown, sha256: sha256(markdown), mimeType: 'text/plain' },
  ] };
}

async function boundedBytes(response, limit) {
  const declared = response.headers.get('content-length');
  check(!declared || /^\d+$/.test(declared) && Number(declared) <= limit, 'QIMOVI_RESPONSE_TOO_LARGE', 502);
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader(), chunks = []; let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      size += value.byteLength;
      check(size <= limit, 'QIMOVI_RESPONSE_TOO_LARGE', 502);
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks);
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

export class QiMoviBridge {
  constructor(directory, { fetch: fetchImpl = globalThis.fetch, timeoutMs = 15000, discovery = installedQiMoviDiscovery } = {}) {
    this.directory = directory;
    this.fetch = fetchImpl;
    this.cookie = null;
    this.remote = null;
    this.timeoutMs = timeoutMs;
    this.discovery = discovery;
    this.signingIn = null;
    this.capabilities = [];
    this.universeBusy = false;
  }
  config() { return loadConnections(this.directory).qimovi ?? null; }
  status() {
    const config = this.config();
    return {
      configured: Boolean(config),
      origin: config?.origin ?? null,
      connected: Boolean(this.cookie && this.remote),
      project: this.remote?.project ?? config?.binding?.project ?? null,
    };
  }
  configure(input) {
    check(input && typeof input === 'object' && Object.keys(input).sort().join(',') === 'origin,ownerToken', 'QIMOVI_CONFIG_INVALID', 422);
    check(typeof input.origin === 'string' && ORIGIN.test(input.origin), 'QIMOVI_ORIGIN_INVALID', 422, 'QiMovi origin must be the exact http://127.0.0.1:<port> the service printed.');
    check(typeof input.ownerToken === 'string' && SHA.test(input.ownerToken), 'QIMOVI_TOKEN_INVALID', 422, 'The QiMovi owner token is the 64-character ownerToken from that project\'s config.json.');
    const connections = loadConnections(this.directory);
    saveConnections(this.directory, { ...connections, qimovi: { origin: input.origin, ownerToken: input.ownerToken } });
    this.cookie = null; this.remote = null;
    return this.status();
  }
  async discover() {
    const result = await this.discovery.discover(), candidate = result.candidates[0];
    if (!candidate) return { available: false, reason: result.reason ?? 'QIMOVI_DISCOVERY_UNAVAILABLE' };
    return { available: candidate.running, ...(candidate.origin ? { origin: candidate.origin } : {}), project: { id: candidate.project.id, title: candidate.project.title }, directory: candidate.workspacePath, ...(!candidate.running ? { reason: 'QIMOVI_NOT_RUNNING' } : {}) };
  }
  async configureInstalled(input) {
    check(input && Object.keys(input).join(',') === 'projectId' && ID.test(input.projectId), 'QIMOVI_CONFIG_INVALID', 422);
    const result = await this.discovery.discover(), candidate = result.candidates[0];
    check(candidate, 'QIMOVI_DISCOVERY_UNAVAILABLE', 409, 'Open the selected project in QiMovi before connecting.');
    const resolved = await this.discovery.resolve({ candidateId: candidate.candidateId, expectedProjectId: input.projectId });
    this.saveInstalled(resolved);
    return this.status();
  }
  saveInstalled(candidate) {
    const connections = loadConnections(this.directory);
    saveConnections(this.directory, { ...connections, qimovi: { origin: candidate.origin, ownerToken: candidate.ownerToken, binding: { candidateId: candidate.candidateId, workspacePath: candidate.workspacePath, project: candidate.project } } });
    this.cookie = null; this.remote = null;
  }
  async refreshInstalled() {
    const config = this.config();
    if (!config?.binding) return;
    const candidate = await this.discovery.resolve({ candidateId: config.binding.candidateId, expectedProjectId: config.binding.project.id });
    check(candidate.workspacePath === config.binding.workspacePath, 'QIMOVI_PROJECT_CHANGED', 409);
    if (candidate.origin !== config.origin || candidate.ownerToken !== config.ownerToken) this.saveInstalled(candidate);
  }
  clear() {
    const { qimovi: _removed, ...connections } = loadConnections(this.directory);
    saveConnections(this.directory, connections);
    this.cookie = null; this.remote = null;
    return this.status();
  }
  async request(pathname, { method = 'GET', body, auth = true, retried = false, bytes, headers: additionalHeaders = {}, responseType = 'json', maxBytes = 32 * 1024 * 1024 } = {}) {
    if (auth) await this.ensureConnected();
    const config = this.config(); check(config, 'QIMOVI_NOT_CONFIGURED', 409);
    const headers = { ...additionalHeaders, Origin: config.origin, Accept: responseType === 'bytes' ? '*/*' : 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (auth) headers.Cookie = `${COOKIE}=${this.cookie}`;
    let response, buffer;
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      response = await this.fetch(config.origin + pathname, { method, headers, body: bytes ?? (body === undefined ? undefined : JSON.stringify(body)), redirect: 'error', signal: controller.signal });
      buffer = await boundedBytes(response, response.ok ? maxBytes : 65536);
    } catch (error) {
      if (error instanceof LocalError) throw error;
      throw new LocalError(controller.signal.aborted ? 'QIMOVI_TIMEOUT' : 'QIMOVI_UNREACHABLE', 502, `QiMovi did not finish the request at ${config.origin}. Reopen it and try again.`);
    } finally { clearTimeout(deadline); }
    let data = null;
    try { if (responseType !== 'bytes' || !response.ok) data = JSON.parse(buffer.toString('utf8')); } catch { /* Protocol validation below rejects non-JSON responses. */ }
    if (!response.ok) {
      if (!auth && pathname === '/api/caniscreenwrite/session' && [401, 404, 405].includes(response.status) && data?.error !== 'OWNER_TOKEN_REJECTED') throw new LocalError('QIMOVI_BRIDGE_UPDATE_REQUIRED', 409, upgradeMessage);
      if (response.status === 401 && auth && !retried) { this.cookie = null; return this.request(pathname, { method, body, auth, bytes, headers: additionalHeaders, responseType, maxBytes, retried: true }); }
      if (response.status === 401) this.cookie = null;
      const code = typeof data?.error === 'string' ? data.error : 'REQUEST_REJECTED';
      throw new LocalError(`QIMOVI_${code}`, [401, 403, 404, 409, 413, 422, 429].includes(response.status) ? response.status : 502, `QiMovi rejected ${method} ${pathname}: ${code}`);
    }
    return { data, response, bytes: buffer };
  }
  async signIn() {
    if (this.signingIn) return this.signingIn;
    this.signingIn = this.openSession();
    try { return await this.signingIn; } finally { this.signingIn = null; }
  }
  async openSession() {
    await this.refreshInstalled();
    const config = this.config();
    check(config, 'QIMOVI_NOT_CONFIGURED', 409);
    this.cookie = null;
    const { data, response } = await this.request('/api/caniscreenwrite/session', { method: 'POST', body: { token: config.ownerToken }, auth: false });
    check(data?.authenticated === true && data.protocol === PROTOCOL, 'QIMOVI_BRIDGE_UPDATE_REQUIRED', 409, upgradeMessage);
    this.capabilities = Array.isArray(data.capabilities) ? data.capabilities : [];
    const cookie = (response.headers.getSetCookie?.() ?? []).map(value => value.split(';')[0]).find(value => value.startsWith(`${COOKIE}=`));
    check(cookie, 'QIMOVI_SESSION_COOKIE_MISSING', 502);
    this.cookie = cookie.slice(COOKIE.length + 1);
  }
  async connect() {
    await this.refreshInstalled();
    await this.ensureConnected();
    return this.bootstrap();
  }
  async ensureConnected() {
    if (!this.cookie) await this.signIn();
  }
  /** Read a minimal financing context for the exact transferred saved revision.
   * No owner-session escalation, financial writes, or implicit screenplay push. */
  async brandContext(store, draftId) {
    check(typeof draftId === 'string' && draftId.startsWith('screenplay-draft:') && ID.test(draftId), 'BRAND_DRAFT_INVALID', 422);
    const local = store.current(draftId), link = store.current(`sync-link:qimovi:${suffix(draftId)}`)?.data;
    check(local?.kind === 'screenplay-draft' && local.sha256 === sha256(canonicalJson(local.data)), 'BRAND_DRAFT_INVALID', 409);
    check(link?.draftVersion === local.version && link.draftSha256 === local.sha256, 'BRAND_TRANSFER_REQUIRED', 409,
      'Transfer this saved revision using Connect → QiMovi before reading its financing context.');
    await this.refreshInstalled(); await this.ensureConnected();
    check(this.capabilities.includes('brand-context/v1'), 'QIMOVI_BRIDGE_UPDATE_REQUIRED', 409, upgradeMessage);
    await this.bootstrap();
    const binding = canonicalJson(this.config()), project = this.remote.project;
    const remote = this.remote.records.find(row => row.id === link.remote.recordId);
    check(project.id === link.remote.projectId && this.config().origin === link.remote.origin
      && remote?.kind === 'screenplay-draft' && remote.version === link.remote.version && remote.sha256 === link.remote.sha256
      && remote.sha256 === sha256(canonicalJson(remote.data)) && remote.data.body === local.data.body, 'BRAND_TRANSFER_DIVERGED', 409);
    const { data } = await this.request('/api/caniscreenwrite/brand-context', { method: 'POST',
      body: { projectId: project.id, sourceId: remote.id, sourceHash: sha256(local.data.body) }, maxBytes: 1024 * 1024 });
    check(data?.schemaVersion === 'qimovi-brand-context/v1' && data.projectId === project.id
      && data.source?.id === remote.id && data.source.sourceHash === sha256(local.data.body)
      && data.source.recordRef?.version === remote.version && data.source.recordRef.sha256 === remote.sha256
      && data.source.fingerprint === sha256(canonicalJson({ id: remote.id, version: remote.version, sha256: remote.sha256 }))
      && data.readOnly === true && data.approvalGranted === false && data.externalVerification === false
      && data.authority === 'OWNER_RECORDED_PLANNING_ONLY' && data.totalsScope === 'PROJECT_NOT_DRAFT'
      && [data.reviews, data.deals, data.totals].every(Array.isArray), 'BRAND_CONTEXT_UNVERIFIED', 502);
    const current = store.current(draftId), currentLink = store.current(`sync-link:qimovi:${suffix(draftId)}`)?.data;
    check(current?.version === local.version && current.sha256 === local.sha256 && canonicalJson(currentLink) === canonicalJson(link)
      && canonicalJson(this.config()) === binding, 'BRAND_SOURCE_CHANGED', 409);
    return { ...data, draftId, draftVersion: local.version, draftSha256: local.sha256 };
  }
  async previewWorldReturn(store, draftId) { return previewWorldReturn(this, store, draftId); }
  async pullWorldReturn(store, draftId, token, choices) { return pullWorldReturn(this, store, draftId, token, choices); }
  async universePlan(store, draftId) {
    await this.refreshInstalled();
    await this.ensureConnected();
    check(this.capabilities.includes('universe-drafts/v1'), 'QIMOVI_BRIDGE_UPDATE_REQUIRED', 409, upgradeMessage);
    await this.bootstrap();
    const source = universeSource(store, draftId), project = this.remote.project, binding = universeBinding(this.config());
    const plan = planUniverse(store, source, project, this.remote.records, binding);
    return { source, project, binding, plan };
  }
  async previewUniverse(store, draftId) {
    return publicUniversePlan((await this.universePlan(store, draftId)).plan);
  }
  async pushUniverse(store, draftId, token) {
    check(typeof token === 'string' && SHA.test(token), 'QIMOVI_UNIVERSE_PREVIEW_REQUIRED', 422);
    check(!this.universeBusy, 'QIMOVI_UNIVERSE_BUSY', 409);
    this.universeBusy = true;
    try {
      const { source, project, binding, plan } = await this.universePlan(store, draftId);
      check(plan.token === token, 'QIMOVI_UNIVERSE_PREVIEW_STALE', 409, 'The saved world, connection or QiMovi entries changed. Preview the transfer again.');
      check(!plan.counts.conflicts, 'QIMOVI_UNIVERSE_CONFLICT', 409, 'Review the conflicting entries in QiMovi before transferring this world.');
      const records = [];
      const assertSource = () => {
        const now = universeSource(store, draftId);
        check(now.draft.sha256 === source.draft.sha256 && now.draft.version === source.draft.version && now.development.sha256 === source.development.sha256 && now.development.version === source.development.version && universeBinding(this.config()) === binding, 'QIMOVI_UNIVERSE_PREVIEW_STALE', 409, 'The world or connection changed during transfer. Preview again to resume safely.');
      };
      // Entities first, then claims/links: QiMovi validates saved target refs.
      const ordered = [...plan.items].sort((a, b) => (a.kind === 'universe-entity' ? 0 : 1) - (b.kind === 'universe-entity' ? 0 : 1));
      for (const item of ordered) {
        assertSource();
        let record = this.remote.records.find(entry => entry.id === item.id);
        if (item.action !== 'unchanged') {
          const expectedVersion = item.current?.version ?? null;
          const { data } = await this.request(`/api/records/${encodeURIComponent(item.id)}`, { method: 'PUT', body: { kind: item.kind, expectedVersion, requestId: `csw-universe:${sha256(canonicalJson([item.id, item.sha256, expectedVersion]))}`, data: item.data } });
          check(data?.id === item.id && data.kind === item.kind && data.version === (expectedVersion ?? 0) + 1 && data.sha256 === item.sha256 && canonicalJson(data.data) === canonicalJson(item.data), 'QIMOVI_UNIVERSE_SAVE_UNCONFIRMED', 502, 'QiMovi did not confirm this entry. Preview again to resume without duplicate entries.');
          record = data;
        }
        saveUniverseReceipt(store, source, project, binding, record);
        records.push({ ...revision(record), kind: record.kind });
      }
      await this.bootstrap();
      assertSource();
      check(this.remote.project.id === project.id && this.remote.project.sourceHash === project.sourceHash && records.every(expected => this.remote.records.some(actual => actual.id === expected.id && actual.kind === expected.kind && actual.version === expected.version && actual.sha256 === expected.sha256 && actual.sha256 === sha256(canonicalJson(actual.data)))), 'QIMOVI_UNIVERSE_READBACK_MISMATCH', 409, 'QiMovi changed while the transfer was being verified. Preview again to review the current entries.');
      return { changed: plan.counts.create + plan.counts.update > 0, project: plan.project, developmentVersion: plan.developmentVersion, records, counts: plan.counts };
    } finally { this.universeBusy = false; }
  }
  async bootstrap() {
    const { data } = await this.request('/api/bootstrap');
    const project = data?.project;
    check(project && typeof project === 'object' && ID.test(project.id) && typeof project.title === 'string' && Array.isArray(data.records), 'QIMOVI_BOOTSTRAP_INVALID', 502);
    const expected = this.config()?.binding?.project;
    check(!expected || project.id === expected.id, 'QIMOVI_PROJECT_CHANGED', 409, 'QiMovi is serving a different project. Select the intended project again.');
    const records = data.records.filter(record => record && ID.test(record.id) && typeof record.kind === 'string' && Number.isSafeInteger(record.version) && SHA.test(record.sha256) && record.data && typeof record.data === 'object');
    this.remote = {
      project: { id: project.id, title: project.title, profile: typeof project.profile === 'string' ? project.profile : 'filmstack-film/v1', sourceHash: typeof project.sourceHash === 'string' ? project.sourceHash : null, sourceStatus: String(data.canonical?.sourceStatus ?? project.sourceStatus ?? 'UNKNOWN') },
      records,
      canonical: data.canonical ?? null,
    };
    return this.summary();
  }
  summary() {
    check(this.remote, 'QIMOVI_SESSION_REQUIRED', 401);
    return {
      ...this.status(),
      canonical: this.remote.canonical,
      drafts: this.remote.records.filter(record => record.kind === 'screenplay-draft').map(record => ({ id: record.id, version: record.version, sha256: record.sha256, title: String(record.data.title ?? ''), bodyLength: typeof record.data.body === 'string' ? record.data.body.length : 0 })),
    };
  }
  link(store, local, remoteRecord, requestNamespace) {
    const config = this.config();
    const data = {
      schemaVersion: 1, projectId: store.project().id, draftId: local.id, draftVersion: local.version, draftSha256: local.sha256, target: 'qimovi',
      remote: { origin: config.origin, projectId: this.remote.project.id, projectTitle: this.remote.project.title, projectProfile: this.remote.project.profile, recordId: remoteRecord.id, version: remoteRecord.version, sha256: remoteRecord.sha256 },
      linkedAt: new Date().toISOString(),
    };
    const id = `sync-link:qimovi:${suffix(local.id)}`;
    const current = store.current(id);
    if (current && canonicalJson({ ...current.data, linkedAt: null }) === canonicalJson({ ...data, linkedAt: null })) return current;
    return store.save(id, { kind: 'sync-link', expectedVersion: current?.version ?? null, requestId: `${requestNamespace}:${suffix(local.id)}:${local.version}:${remoteRecord.version}:${current?.version ?? 0}`, data });
  }
  /** Carry the current local revision of a draft into the connected QiMovi project. */
  async pushDraft(store, draftId) {
    check(typeof draftId === 'string' && draftId.startsWith('screenplay-draft:') && ID.test(draftId), 'INVALID_RECORD_ID', 422);
    const local = store.current(draftId);
    check(local && local.kind === 'screenplay-draft', 'DRAFT_NOT_FOUND', 404);
    await this.refreshInstalled();
    await this.ensureConnected();
    await this.bootstrap();
    const remoteData = toQiMoviDraft(local.data, this.remote.project);
    const remoteCurrent = this.remote.records.find(record => record.id === draftId) ?? null;
    check(!remoteCurrent || remoteCurrent.kind === 'screenplay-draft', 'QIMOVI_RECORD_KIND_CONFLICT', 409);
    check(!remoteCurrent || remoteCurrent.sha256 === sha256(canonicalJson(remoteCurrent.data)), 'QIMOVI_REMOTE_REVISION_INVALID', 502);
    let remoteRecord = remoteCurrent, changed = false;
    const { sceneMap: remoteSceneMap, ...remoteComparable } = remoteCurrent?.data ?? {};
    for (const key of ['inputRefs', 'sceneId']) if (remoteCurrent && Object.hasOwn(remoteCurrent.data, key)) remoteData[key] = remoteCurrent.data[key];
    if (!remoteCurrent || canonicalJson(remoteComparable) !== canonicalJson(remoteData)) {
      const link = store.current(`sync-link:qimovi:${suffix(local.id)}`)?.data;
      check(!remoteCurrent || link?.remote.projectId === this.remote.project.id && link.remote.recordId === draftId && link.remote.version === remoteCurrent.version && link.remote.sha256 === remoteCurrent.sha256, 'QIMOVI_REMOTE_DIVERGED', 409, 'QiMovi has a different revision from the last confirmed transfer. Pull or review that revision before pushing.');
      check(remoteSceneMap === undefined || remoteCurrent.data.body === remoteData.body, 'QIMOVI_SCENE_MAP_REVIEW_REQUIRED', 409, 'This QiMovi draft has saved scene identities. Edit it in QiMovi or transfer a separate draft until scene mapping is supported by the bridge.');
      // An unchanged whole body provides exact range correspondence, including
      // duplicate scenes. Keep every identity and unresolved candidate while
      // binding this metadata-only save to the current remote revision.
      const payload = remoteSceneMap === undefined ? remoteData : {
        ...remoteData,
        sceneMap: {
          ...remoteSceneMap,
          predecessorSha256: remoteCurrent.sha256,
          scenes: remoteSceneMap.scenes.map(scene => ({ ...scene, match: 'EXACT', previousId: scene.id })),
        },
      };
      const expectedVersion = remoteCurrent?.version ?? null;
      const { data } = await this.request(`/api/records/${encodeURIComponent(draftId)}`, { method: 'PUT', body: { kind: 'screenplay-draft', expectedVersion, requestId: `caniscreenwrite-push:${suffix(draftId)}:${local.version}:${expectedVersion ?? 0}`, data: payload } });
      check(data && data.id === draftId && data.kind === 'screenplay-draft' && data.version === (expectedVersion ?? 0) + 1 && data.sha256 === sha256(canonicalJson(payload)) && canonicalJson(data.data) === canonicalJson(payload), 'QIMOVI_SAVE_UNCONFIRMED', 502, 'QiMovi answered, but its saved record does not match what was sent. Reload before continuing.');
      remoteRecord = data; changed = true;
    }
    const link = this.link(store, local, remoteRecord, 'caniscreenwrite-link');
    await this.bootstrap();
    return { changed, remote: { id: remoteRecord.id, version: remoteRecord.version, sha256: remoteRecord.sha256 }, link };
  }
  /** Bring a QiMovi draft revision into this workspace as a new local version. */
  async pullDraft(store, remoteRecordId, draftId = remoteRecordId) {
    check(typeof remoteRecordId === 'string' && ID.test(remoteRecordId) && typeof draftId === 'string' && draftId.startsWith('screenplay-draft:') && ID.test(draftId), 'INVALID_RECORD_ID', 422);
    await this.refreshInstalled();
    await this.ensureConnected();
    await this.bootstrap();
    const remoteRecord = this.remote.records.find(record => record.id === remoteRecordId);
    check(remoteRecord && remoteRecord.kind === 'screenplay-draft', 'QIMOVI_DRAFT_NOT_FOUND', 404);
    check(typeof remoteRecord.data.title === 'string' && typeof remoteRecord.data.body === 'string', 'QIMOVI_DRAFT_INVALID', 502);
    check(remoteRecord.sha256 === sha256(canonicalJson(remoteRecord.data)), 'QIMOVI_REMOTE_REVISION_INVALID', 502);
    const current = store.current(draftId);
    check(!current || current.kind === 'screenplay-draft', 'RECORD_KIND_CONFLICT', 409);
    const localData = fromQiMoviDraft(remoteRecord.data, store.project(), current?.data);
    let local = current, changed = false;
    if (!current || canonicalJson(current.data) !== canonicalJson(localData)) {
      const link = store.current(`sync-link:qimovi:${suffix(draftId)}`)?.data;
      check(!current || link?.draftVersion === current.version && link.draftSha256 === current.sha256 && link.remote.projectId === this.remote.project.id && link.remote.recordId === remoteRecordId, 'QIMOVI_LOCAL_DIVERGED', 409, 'This local draft has changed since its last transfer. Preserve or review it before pulling another revision.');
      local = store.save(draftId, { kind: 'screenplay-draft', expectedVersion: current?.version ?? null, requestId: `caniscreenwrite-pull:${suffix(draftId)}:${remoteRecord.version}:${current?.version ?? 0}`, data: localData });
      changed = true;
    }
    const link = this.link(store, local, remoteRecord, 'caniscreenwrite-link');
    return { changed, local: { id: local.id, version: local.version, sha256: local.sha256 }, link };
  }

  /** Retain exact saved development as project reference assets, never canon. */
  async pushWorld(store, draftId) {
    const exported = worldExports(store, draftId); // snapshot before any await
    await this.refreshInstalled();
    await this.ensureConnected();
    await this.bootstrap();
    const project = { ...this.remote.project }, files = [];
    check(project.sourceHash === null || SHA.test(project.sourceHash), 'QIMOVI_PROJECT_SOURCE_UNKNOWN', 422);
    let changed = false;
    for (const file of exported.files) {
      const { data } = await this.request('/api/project-library/upload', { method: 'POST', bytes: file.bytes, headers: {
        'Content-Type': 'application/octet-stream', 'Content-Length': String(file.bytes.length),
        'X-Library-Project-Id': project.id, 'X-Library-Source-Hash': String(project.sourceHash),
        'X-Library-Byte-Length': String(file.bytes.length), 'X-Library-Sha256': file.sha256,
        'X-Library-Filename': encodeURIComponent(file.filename),
      } });
      const record = data?.records?.[0], asset = record?.data?.asset;
      const recordId = `project-asset:${file.sha256}`;
      check(data?.schemaVersion === 'filmstack-project-library-upload-result/v1' && data.scope === 'PROJECT_REFERENCE' && data.approvalGranted === false && data.sourceHash === project.sourceHash
        && (project.sourceHash !== null || data.projectId === project.id)
        && Array.isArray(data.records) && data.records.length === 1 && [0, 1].includes(data.imported) && data.replayed === 1 - data.imported
        && record?.id === recordId && record.kind === 'project-asset' && record.version === 1 && record.sha256 === sha256(canonicalJson(record.data))
        && record.data.sourceHash === project.sourceHash && (project.sourceHash !== null || record.data.projectId === project.id)
        && record.data.scope === 'PROJECT_REFERENCE' && record.data.review === 'PENDING' && record.data.family === 'TEXT'
        && asset?.sha256 === file.sha256 && asset.byteLength === file.bytes.length && asset.mimeType === file.mimeType,
      'QIMOVI_WORLD_SAVE_UNCONFIRMED', 502, 'QiMovi did not confirm the exact development file. Retry the same saved revision; any retained file is safely reused.');
      const readback = await this.request(`/api/project-library/assets/${encodeURIComponent(recordId)}`, { responseType: 'bytes', maxBytes: file.bytes.length });
      check(readback.response.headers.get('x-asset-sha256') === file.sha256 && readback.response.headers.get('content-type') === file.mimeType && readback.bytes.equals(file.bytes), 'QIMOVI_WORLD_READBACK_MISMATCH', 502, 'QiMovi retained a file, but its readback did not match the export. Retry or inspect the retained reference.');
      changed ||= data.imported === 1;
      files.push({ filename: file.filename, sha256: file.sha256, recordId, verified: true });
    }
    return { changed, developmentVersion: exported.development.version, project: { id: project.id, title: project.title }, draft: exported.draft, development: exported.development, files };
  }
}
