// Filesystem inspection runs in a disposable process: macOS can block even a
// synchronous open indefinitely while authorizing access to another app's files.
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { LocalError, check, ID } from './storage.mjs';

const WORKER = fileURLToPath(new URL('./qimovi-discovery-worker.mjs', import.meta.url));
const reason = error => /^QIMOVI_[A-Z_]+$/.test(error?.code ?? '') ? error.code : 'QIMOVI_DISCOVERY_UNAVAILABLE';
const failure = code => new LocalError(code, code === 'QIMOVI_DISCOVERY_TIMEOUT' ? 504 : 409,
  code === 'QIMOVI_DISCOVERY_TIMEOUT' ? 'QiMovi discovery timed out. Open QiMovi and try connecting again.' : code);

/** Options are for isolated tests; HTTP callers must not supply these options. */
export function createQiMoviDiscovery({ workspace, preferences, run, host, node, timeoutMs = 3000, fork: startWorker = fork } = {}) {
  check(Number.isSafeInteger(timeoutMs) && timeoutMs >= 10 && timeoutMs <= 10000, 'QIMOVI_DISCOVERY_TIMEOUT_INVALID', 422);
  let active = null;
  function inspect() {
    // Retain the slot after timeout until exit. A process blocked in the kernel
    // must not cause every new HTTP request to leave another blocked child.
    if (active) return active.promise;
    const state = { child: null, promise: null };
    active = state;
    state.promise = new Promise((resolve, reject) => {
      let settled = false, received = false, result, responseError;
      const settle = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error); else resolve(value);
      };
      const terminate = () => {
        const child = state.child;
        if (!child) return;
        // Detached process group also contains defaults/plutil/ps/lsof. Kill
        // those descendants when the helper is stuck waiting for a command.
        try { process.kill(-child.pid, 'SIGKILL'); }
        catch { try { child.kill('SIGKILL'); } catch {} }
        child.unref();
        child.channel?.unref();
      };
      const timer = setTimeout(() => { settle(failure('QIMOVI_DISCOVERY_TIMEOUT')); terminate(); }, timeoutMs);
      const send = message => {
        if (settled || !state.child?.connected) return;
        state.child.send(message, error => {
          if (error) { settle(failure('QIMOVI_DISCOVERY_UNAVAILABLE')); terminate(); }
        });
      };
      try {
        state.child = startWorker(WORKER, [], {
          detached: true, execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        });
        const child = state.child;
        child.on('message', message => {
          if (settled || !message || typeof message !== 'object') return;
          if (message.type === 'command' && typeof run === 'function') {
            // Keep existing test command injections (including mutable native
            // selections) while all filesystem/SQLite work stays in the child.
            Promise.resolve().then(() => run(message.file, message.args)).then(
              output => send({ type: 'command-result', id: message.id, output }),
              error => send({ type: 'command-result', id: message.id, reason: reason(error) }),
            );
          } else if (message.type === 'result' && !received) {
            received = true;
            if (message.reason) responseError = failure(reason({ code: message.reason }));
            else if (message.candidate && typeof message.candidate === 'object') result = message.candidate;
            else responseError = failure('QIMOVI_DISCOVERY_UNAVAILABLE');
          }
        });
        child.once('error', () => {
          settle(failure('QIMOVI_DISCOVERY_UNAVAILABLE'));
          if (!child.pid && active === state) active = null;
          terminate();
        });
        child.once('exit', code => {
          if (active === state) active = null;
          settle(responseError ?? (code === 0 && received && result ? null : failure('QIMOVI_DISCOVERY_UNAVAILABLE')), result);
        });
        send({ type: 'inspect', options: { workspace, preferences, host, node, injectedRun: typeof run === 'function' } });
      } catch {
        settle(failure('QIMOVI_DISCOVERY_UNAVAILABLE'));
        if (!state.child && active === state) active = null;
        terminate();
      }
    });
    return state.promise;
  }
  return {
    async discover() {
      try {
        const { ownerToken: _private, ...candidate } = await inspect();
        return { candidates: [candidate] };
      } catch (error) { return { candidates: [], reason: reason(error) }; }
    },
    async resolve({ candidateId: selected, expectedProjectId }) {
      check(typeof selected === 'string' && typeof expectedProjectId === 'string' && ID.test(expectedProjectId), 'QIMOVI_CANDIDATE_INVALID', 422);
      const candidate = await inspect();
      check(selected === candidate.candidateId, 'QIMOVI_SELECTION_CHANGED', 409, 'QiMovi has selected a different project. Choose the intended project again.');
      check(candidate.project.id === expectedProjectId, 'QIMOVI_PROJECT_CHANGED', 409, 'The selected QiMovi project identity changed. Select it again before connecting.');
      check(candidate.running, 'QIMOVI_NOT_RUNNING', 409, 'Open this project in QiMovi before connecting.');
      return candidate; // private: only the bridge consumes this result
    },
  };
}
export const installedQiMoviDiscovery = createQiMoviDiscovery();
export const discover = () => installedQiMoviDiscovery.discover();
