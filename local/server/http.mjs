// Loopback HTTP service for the local writer. Binds 127.0.0.1 only. Serves the
// built local app and a small JSON API over one private SQLite workspace.
//
// Every private request needs the owner cookie; Host and Origin must match the
// service's own origin. Mutations additionally require an exact Origin header
// and JSON content. This mirrors the QiMovi local service so both can run on
// the same machine with the same trust model.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { WorkspaceStore, LocalError, check, loadConfig, acquireLock, privateDirectory, sha256, ID } from './storage.mjs';
import { validateRecord } from './contracts.mjs';
import { QiMoviBridge } from './qimovi.mjs';
import { QiMoviLibrary } from './qimovi-library.mjs';
import { createBackup } from './backup.mjs';
import { preservationPreview, createPreservationPackage, verifyPreservationPackage, MAX_PRESERVATION_BYTES } from './preservation.mjs';
import { RecoveryStore, DevelopmentRecoveryStore, MAX_RECOVERY_BYTES } from './recovery.mjs';
import { retainEvidence, privateWorksheet, tokenPreview, exportTokenMetadata, RightsRecoveryStore } from './rights.mjs';
import { exportPocketPackage, previewPocketPackage, importPocketPackage, preparePocketContinuation, exportPreparedPocketContinuation, returnPocketContinuation, MAX_POCKET_BYTES } from './pocket-exchange.mjs';
import { CreativeServices } from './creative-services.mjs';

const COOKIE = 'writer_owner';
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.map': 'application/json', '.txt': 'text/plain; charset=utf-8' };
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' https:; worker-src 'self' blob:; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

function json(res, status, value, headers = {}) {
  const bytes = Buffer.from(JSON.stringify(value));
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': bytes.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers });
  res.end(bytes);
}
function body(req, limit = 4 * 1024 * 1024, raw = false) {
  return new Promise((resolve, reject) => {
    check(/^application\/json\b/i.test(req.headers['content-type'] ?? ''), 'JSON_BODY_REQUIRED', 415);
    const chunks = []; let size = 0; let oversized = false;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > limit) { if (!oversized) { oversized = true; chunks.length = 0; reject(new LocalError('BODY_TOO_LARGE', 413)); } }
      else chunks.push(chunk);
    });
    req.on('end', () => { if (oversized) return; try { resolve(raw ? Buffer.concat(chunks) : chunks.length ? JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))) : null); } catch { reject(new LocalError('INVALID_JSON')); } });
    req.on('error', reject);
  });
}
const constantEqual = (left, right) => typeof left === 'string' && typeof right === 'string' && left.length === right.length && crypto.timingSafeEqual(Buffer.from(left), Buffer.from(right));

/**
 * Start the service. `port` 0 chooses a free port. `loginNonce` is an optional
 * one-time, short-lived credential minted by the CLI so a freshly opened
 * browser tab can start a session without the owner pasting the token.
 */
export async function startServer({ directory, port = 0, dist = null, loginNonce = null, sessionLifetimeMs = 12 * 60 * 60 * 1000, bridge, analysisOptions } = {}) {
  directory = privateDirectory(directory);
  const unlock = acquireLock(directory);
  let store;
  try {
    const config = loadConfig(directory);
    store = new WorkspaceStore(directory, validateRecord);
    check(store.project(), 'PROJECT_NOT_INITIALIZED', 409);
    const recovery = new RecoveryStore(store);
    const developmentRecovery = new DevelopmentRecoveryStore(store);
    const rightsRecovery = new RightsRecoveryStore(store);
    const creativeServices = new CreativeServices(directory, store, analysisOptions);
    const qimovi = bridge ?? new QiMoviBridge(directory);
    const qimoviLibrary = new QiMoviLibrary(qimovi, store);
    const sessions = new Map();
    const failures = [];
    let nonce = loginNonce ? { hash: sha256(loginNonce), expiresAt: Date.now() + 2 * 60 * 1000 } : null;
    let expectedOrigin;
    const distRoot = dist && fs.existsSync(dist) ? fs.realpathSync(dist) : null;

    const startSession = (res, status, payload) => {
      const now = Date.now();
      const token = crypto.randomBytes(32).toString('hex');
      sessions.clear(); sessions.set(sha256(token), now + sessionLifetimeMs);
      return json(res, status, payload, { 'Set-Cookie': `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(sessionLifetimeMs / 1000)}` });
    };

    const server = http.createServer(async (req, res) => {
      try {
        check(req.headers.host === new URL(expectedOrigin).host, 'HOST_REJECTED', 403);
        const url = new URL(req.url, expectedOrigin);
        check(!req.headers.origin || req.headers.origin === expectedOrigin, 'ORIGIN_REJECTED', 403);
        const api = url.pathname.startsWith('/api/');
        if (url.pathname === '/api/health' && req.method === 'GET') return json(res, 200, { status: 'ok', mode: 'LOCAL_OWNER', product: 'caniscreenwrite-local-writer' });
        if (api && !['GET', 'HEAD'].includes(req.method)) check(req.headers.origin === expectedOrigin, 'EXACT_ORIGIN_REQUIRED', 403);
        if (url.pathname === '/api/session' && req.method === 'POST') {
          const now = Date.now(); while (failures.length && failures[0] < now - 60_000) failures.shift();
          check(failures.length < 12, 'SESSION_RATE_LIMITED', 429);
          const value = await body(req, 4096);
          const keys = value && typeof value === 'object' ? Object.keys(value).join(',') : '';
          if (keys === 'token' && constantEqual(value.token, config.ownerToken)) return startSession(res, 200, { authenticated: true, actor: config.ownerActorId, method: 'OWNER_TOKEN' });
          if (keys === 'loginNonce' && nonce && nonce.expiresAt > now && typeof value.loginNonce === 'string' && constantEqual(sha256(value.loginNonce), nonce.hash)) {
            nonce = null;
            return startSession(res, 200, { authenticated: true, actor: config.ownerActorId, method: 'ONE_TIME_LINK' });
          }
          failures.push(now); throw new LocalError('OWNER_TOKEN_REJECTED', 401);
        }
        if (api) {
          const token = req.headers.cookie?.split(';').map(s => s.trim()).find(s => s.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
          check(token && (sessions.get(sha256(token)) ?? 0) > Date.now(), 'OWNER_SESSION_REQUIRED', 401);
          if (url.pathname === '/api/session' && req.method === 'DELETE') { sessions.clear(); return json(res, 200, { authenticated: false }, { 'Set-Cookie': `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0` }); }
          if (url.pathname === '/api/bootstrap' && req.method === 'GET') return json(res, 200, { project: store.project(), records: store.list(), connectors: { qimovi: qimovi.status() } });
          if (url.pathname === '/api/creative-services/models' && req.method === 'POST') return json(res, 200, await creativeServices.models(await body(req, 1024)));
          if (url.pathname === '/api/creative-services/local' && req.method === 'POST') return json(res, 200, await creativeServices.run(await body(req, 80000)));
          if (url.pathname === '/api/creative-services/jobs' && req.method === 'GET') {
            const jobs = creativeServices.list(url.searchParams.get('draftId'));
            return json(res, 200, { jobs, issues: creativeServices.issues });
          }
          if (url.pathname === '/api/pocket-exchange/prepare' && req.method === 'POST') {
            const input = await body(req, 1024);
            check(input && !Array.isArray(input) && Object.keys(input).join(',') === 'draftId', 'POCKET_PREPARE_INVALID', 422);
            const packet = preparePocketContinuation(store, input.draftId);
            const { continuation } = JSON.parse(Buffer.from(packet.payloadBase64, 'base64').toString('utf8'));
            return json(res, 200, { exchangeId: continuation.exchangeId, contentSha256: packet.contentSha256 });
          }
          if (url.pathname === '/api/pocket-exchange/linked' && req.method === 'GET') return json(res, 200, exportPreparedPocketContinuation(store, url.searchParams.get('exchangeId')), { 'Content-Disposition': 'attachment; filename="screenplay-linked-trip.qiscript"' });
          if (url.pathname === '/api/pocket-exchange/return' && req.method === 'POST') return json(res, 200, returnPocketContinuation(store, await body(req, MAX_POCKET_BYTES, true), req.headers['x-pocket-content-sha256']));
          if (url.pathname === '/api/pocket-exchange/export' && req.method === 'GET') return json(res, 200, exportPocketPackage(store, url.searchParams.get('draftId')), { 'Content-Disposition': 'attachment; filename="screenplay-snapshot.qiscript"' });
          if (url.pathname === '/api/pocket-exchange/preview' && req.method === 'POST') return json(res, 200, previewPocketPackage(store, await body(req, MAX_POCKET_BYTES, true)));
          if (url.pathname === '/api/pocket-exchange/import' && req.method === 'POST') return json(res, 200, importPocketPackage(store, await body(req, MAX_POCKET_BYTES, true), req.headers['x-pocket-content-sha256']));
          if (url.pathname === '/api/rights/evidence' && req.method === 'POST') return json(res, 200, retainEvidence(store, await body(req, 1500000)));
          if (url.pathname === '/api/rights/recovery' && req.method === 'GET') return json(res, 200, rightsRecovery.get());
          if (url.pathname === '/api/rights/recovery' && req.method === 'PUT') return json(res, 200, rightsRecovery.put(await body(req, 1500000)));
          if (url.pathname === '/api/rights/recovery' && req.method === 'DELETE') return json(res, 200, rightsRecovery.clear(url.searchParams.get('savedAt')));
          if (url.pathname === '/api/rights/worksheet' && req.method === 'POST') return json(res, 200, privateWorksheet(store, await body(req, 1024)));
          if (url.pathname === '/api/rights/token-preview' && req.method === 'POST') return json(res, 200, tokenPreview(store, await body(req, 1024)));
          if (url.pathname === '/api/rights/token-export' && req.method === 'POST') return json(res, 200, exportTokenMetadata(store, await body(req, 2048)));
          if (url.pathname === '/api/preservation' && req.method === 'GET') return json(res, 200, preservationPreview(store));
          if (url.pathname === '/api/preservation/export' && req.method === 'POST') {
            const input = await body(req, 1024);
            check(input && typeof input === 'object' && Object.keys(input).join(',') === 'sourceSha256', 'PRESERVATION_REQUEST_INVALID', 422);
            return json(res, 200, createPreservationPackage(store, input.sourceSha256));
          }
          if (url.pathname === '/api/preservation/verify' && req.method === 'POST') return json(res, 200, verifyPreservationPackage(await body(req, MAX_PRESERVATION_BYTES)));
          if (url.pathname === '/api/backup' && req.method === 'GET') {
            const backup = createBackup(store);
            // A fixed filename never incorporates project titles or path input.
            return json(res, 200, backup, { 'Content-Disposition': 'attachment; filename="caniscreenwrite-workspace-backup.json"' });
          }
          if (url.pathname === '/api/recovery' && req.method === 'GET') return json(res, 200, recovery.list());
          if (url.pathname === '/api/development-recovery' && req.method === 'GET') return json(res, 200, developmentRecovery.list());
          const developmentRecoveryRoute = /^\/api\/development-recovery\/([^/]+)$/.exec(url.pathname);
          if (developmentRecoveryRoute) {
            const id = decodeURIComponent(developmentRecoveryRoute[1]);
            if (req.method === 'GET') return json(res, 200, developmentRecovery.get(id));
            if (req.method === 'PUT') return json(res, 200, developmentRecovery.put(id, await body(req, MAX_RECOVERY_BYTES)));
            if (req.method === 'DELETE') return json(res, 200, developmentRecovery.delete(id, url.searchParams.get('savedAt')));
          }
          const recoveryRoute = /^\/api\/recovery\/([^/]+)$/.exec(url.pathname);
          if (recoveryRoute) {
            const id = decodeURIComponent(recoveryRoute[1]);
            if (req.method === 'GET') return json(res, 200, recovery.get(id));
            if (req.method === 'PUT') return json(res, 200, recovery.put(id, await body(req, MAX_RECOVERY_BYTES)));
            if (req.method === 'DELETE') return json(res, 200, recovery.delete(id, url.searchParams.get('savedAt')));
          }
          if (url.pathname === '/api/records' && req.method === 'GET') { const kind = url.searchParams.get('kind'); check(!kind || ID.test(kind), 'INVALID_RECORD_ID'); return json(res, 200, store.list(kind ?? undefined)); }
          const history = /^\/api\/records\/([^/]+)\/history$/.exec(url.pathname);
          if (history && req.method === 'GET') return json(res, 200, store.history(decodeURIComponent(history[1])));
          const record = /^\/api\/records\/([^/]+)$/.exec(url.pathname);
          if (record && req.method === 'PUT') {
            const id = decodeURIComponent(record[1]); const input = await body(req);
            // QiMovi links are receipts of a save this service confirmed itself, so
            // only the bridge writes them. Competition links are receipts of a hosted
            // save the browser performed, so the browser records those.
            check(!(input?.kind === 'sync-link' || id.startsWith('sync-link:')) || (input?.kind === 'sync-link' && id.startsWith('sync-link:competition:')), 'SYNC_LINK_REQUIRES_CONNECTOR', 409);
            check(input?.kind !== 'universe-sync' && !id.startsWith('universe-sync:'), 'SYNC_LINK_REQUIRES_CONNECTOR', 409);
            check(!['source-document','source-import'].some(kind => input?.kind === kind || id.startsWith(kind + ':')), 'SOURCE_REQUIRES_IMPORT', 409);
            return json(res, 200, store.save(id, input));
          }
          if (url.pathname.startsWith('/api/connectors/qimovi')) {
            const route = url.pathname.slice('/api/connectors/qimovi'.length);
            if (route === '/library' && req.method === 'GET') return json(res, 200, await qimoviLibrary.list());
            if (route === '/library/preview' && req.method === 'POST') return json(res, 200, await qimoviLibrary.preview(await body(req, 4096)));
            if (route === '/library/import' && req.method === 'POST') return json(res, 200, await qimoviLibrary.import(await body(req, 2 * 1024 * 1024)));
            if (route === '' && req.method === 'GET') return json(res, 200, qimovi.status());
            if (route === '/installed' && req.method === 'GET') return json(res, 200, await qimovi.discover());
            if (route === '/installed' && req.method === 'POST') return json(res, 200, await qimovi.configureInstalled(await body(req, 4096)));
            if (route === '/config' && req.method === 'PUT') return json(res, 200, qimovi.configure(await body(req, 4096)));
            if (route === '/config' && req.method === 'DELETE') return json(res, 200, qimovi.clear());
            if (route === '/connect' && req.method === 'POST') { await body(req, 1024); return json(res, 200, await qimovi.connect()); }
            if (route === '/push' && req.method === 'POST') { const input = await body(req, 4096); return json(res, 200, await qimovi.pushDraft(store, input?.draftId)); }
            if (route === '/world' && req.method === 'POST') { const input = await body(req, 4096); return json(res, 200, await qimovi.pushWorld(store, input?.draftId)); }
            if (route === '/world-return/preview' && req.method === 'POST') {
              const input = await body(req, 4096);
              check(input && !Array.isArray(input) && Object.keys(input).join(',') === 'draftId', 'WORLD_RETURN_REQUEST_INVALID', 422);
              return json(res, 200, await qimovi.previewWorldReturn(store, input?.draftId));
            }
            if (route === '/world-return' && req.method === 'POST') {
              const input = await body(req, 256 * 1024);
              check(input && !Array.isArray(input) && Object.keys(input).sort().join(',') === 'choices,draftId,token', 'WORLD_RETURN_REQUEST_INVALID', 422);
              return json(res, 200, await qimovi.pullWorldReturn(store, input?.draftId, input?.token, input?.choices));
            }
            if (route === '/universe/preview' && req.method === 'POST') { const input = await body(req, 4096); return json(res, 200, await qimovi.previewUniverse(store, input?.draftId)); }
            if (route === '/universe' && req.method === 'POST') { const input = await body(req, 4096); return json(res, 200, await qimovi.pushUniverse(store, input?.draftId, input?.token)); }
            if (route === '/pull' && req.method === 'POST') { const input = await body(req, 4096); return json(res, 200, await qimovi.pullDraft(store, input?.remoteRecordId, input?.draftId ?? input?.remoteRecordId)); }
          }
          throw new LocalError('ROUTE_NOT_FOUND', 404);
        }
        check(req.method === 'GET' || req.method === 'HEAD', 'METHOD_NOT_ALLOWED', 405);
        check(distRoot, 'LOCAL_APP_NOT_BUILT', 404, 'Build the local app first: npm run build:local');
        let requested;
        try { requested = decodeURIComponent(url.pathname); } catch { throw new LocalError('INVALID_PATH'); }
        check(!requested.split('/').some(part => part.startsWith('.') && part !== ''), 'STATIC_PATH_REJECTED', 404);
        let filename = path.resolve(distRoot, '.' + requested);
        check(filename === distRoot || filename.startsWith(distRoot + path.sep), 'STATIC_PATH_REJECTED', 404);
        if (!fs.existsSync(filename) || fs.statSync(filename).isDirectory()) filename = path.join(distRoot, fs.existsSync(path.join(distRoot, 'local.html')) ? 'local.html' : 'index.html');
        check(fs.existsSync(filename) && fs.realpathSync(filename).startsWith(distRoot + path.sep), 'STATIC_PATH_REJECTED', 404);
        const bytes = fs.readFileSync(filename);
        res.writeHead(200, { 'Content-Type': MIME[path.extname(filename)] ?? 'application/octet-stream', 'Content-Length': bytes.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': CSP });
        res.end(req.method === 'HEAD' ? undefined : bytes);
      } catch (error) {
        // Shared pure contracts use typed errors without importing this server.
        // Expose only their bounded code/status, never arbitrary exception text.
        const contractError = error instanceof Error && /^(RIGHTS|PARTICIPATION|TOKEN)_[A-Z_]+$/.test(error.code ?? '') && [409, 413, 422].includes(error.status);
        if (!res.headersSent) json(res, error instanceof LocalError || contractError ? error.status : 400, { error: error instanceof LocalError || contractError ? error.code : 'REQUEST_REJECTED', detail: error instanceof LocalError && error.message !== error.code ? error.message : undefined });
        else res.destroy();
      }
    });
    server.requestTimeout = 150_000;
    server.headersTimeout = 10_000;
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
    expectedOrigin = `http://127.0.0.1:${server.address().port}`;
    let closePromise;
    return {
      origin: expectedOrigin,
      loginUrl: loginNonce ? `${expectedOrigin}/#login=${loginNonce}` : null,
      close() {
        return closePromise ??= new Promise((resolve, reject) => { server.close(() => { try { store.close(); resolve(); } catch (error) { reject(error); } finally { unlock(); } }); server.closeIdleConnections(); });
      },
    };
  } catch (error) { try { store?.close(); } finally { unlock(); } throw error; }
}
