import Foundation
import WebKit
import OSLog
import Darwin

struct LocalFailure: LocalizedError {
    let message: String
    var errorDescription: String? { message }
}

final class NoRedirects: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest,
                    completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
}

/// A timed filesystem read cannot rely on task-group cancellation: an OS file
/// open may remain blocked. Complete the caller once and ignore any late read.
private final class OwnerTokenRead: @unchecked Sendable {
    private let lock = NSLock()
    private var continuation: CheckedContinuation<String, Error>?
    private var result: Result<String, Error>?

    var pending: Bool {
        lock.lock(); defer { lock.unlock() }
        return result == nil
    }

    func install(_ continuation: CheckedContinuation<String, Error>) -> Bool {
        lock.lock()
        if let result {
            lock.unlock()
            continuation.resume(with: result)
            return false
        }
        self.continuation = continuation
        lock.unlock()
        return true
    }

    func finish(_ result: Result<String, Error>) {
        lock.lock()
        guard self.result == nil else { lock.unlock(); return }
        self.result = result
        let continuation = self.continuation
        self.continuation = nil
        lock.unlock()
        continuation?.resume(with: result)
    }
}

@MainActor final class LocalService {
    private(set) var process: Process?
    private(set) var origin: URL?
    // A reconnect in this app session must keep the existing page's origin.
    // Otherwise its unsaved in-memory/browser recovery would be abandoned.
    private var lastPort = 0
    private var input: Pipe?
    private var output: Pipe?
    private var errors: Pipe?
    private var buffer = Data()
    private var generation = UUID()
    var onReady: ((URL) -> Void)?
    var onFailure: ((String) -> Void)?
    var onStopped: (() -> Void)?
    private var stopping = false
    private var starting = false
    // Serialize file reads so repeated reconnects cannot create many blocked
    // file-provider calls. Timed-out queued reads are skipped before opening.
    private nonisolated static let ownerReadQueue = DispatchQueue(label: "com.hampton.qicaniscreenwrite.owner-read", qos: .userInitiated)
    private let logger = Logger(subsystem: "com.hampton.qicaniscreenwrite.local", category: "LocalService")

    func start(workspace: URL) async throws {
        guard process == nil, !starting else { throw LocalFailure(message: "The local service is already starting or running.") }
        guard let resources = Bundle.main.resourceURL else { throw LocalFailure(message: "The app bundle has no runtime resources.") }
        starting = true; stopping = false
        generation = UUID(); let current = generation
        defer { if generation == current { starting = false } }
        // macOS may ask for Documents-folder access on first opening. Resolve
        // that native file access before starting the child's readiness deadline;
        // a human permission prompt is not a stalled server.
        guard generation == current, !stopping, process == nil else { throw CancellationError() }
        try Task.checkCancellation()
        let runtime = resources.appendingPathComponent("runtime")
        let child = Process()
        child.executableURL = resources.appendingPathComponent("node")
        child.arguments = [runtime.appendingPathComponent("local/desktop/host.mjs").path,
                           "--data", workspace.path, "--dist", runtime.appendingPathComponent("dist-local").path,
                           "--port", String(lastPort)]
        child.currentDirectoryURL = runtime
        var environment = ProcessInfo.processInfo.environment
        // Do not inherit Node preload hooks into the private local owner process.
        environment.removeValue(forKey: "NODE_OPTIONS")
        environment.removeValue(forKey: "NODE_PATH")
        // The installed, signed helper is the sole desktop media inspector.
        child.environment = environment
        let stdin = Pipe(), stdout = Pipe(), stderr = Pipe()
        child.standardInput = stdin; child.standardOutput = stdout; child.standardError = stderr
        input = stdin; output = stdout; errors = stderr; buffer = Data(); stopping = false
        stdout.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            Task { @MainActor in self?.receive(data, generation: current) }
        }
        // Drain stderr so a runtime diagnostic cannot deadlock the process. Never expose credentials.
        stderr.fileHandleForReading.readabilityHandler = { handle in _ = handle.availableData }
        child.terminationHandler = { [weak self] task in
            let code = task.terminationStatus
            Task { @MainActor in
                guard let self, self.generation == current else { return }
                let expected = self.stopping
                self.logger.info("Local child stopped: exit=\(code), requested=\(expected)")
                self.output?.fileHandleForReading.readabilityHandler = nil
                self.errors?.fileHandleForReading.readabilityHandler = nil
                self.process = nil; self.origin = nil; self.input = nil
                if !expected { self.onFailure?("The local service stopped (exit \(code)). Your saved project remains on disk. Close any other service using this workspace, then reconnect.") }
                self.onStopped?()
            }
        }
        process = child
        do {
            try child.run()
            logger.info("Local child launched: pid=\(child.processIdentifier)")
        } catch {
            stdout.fileHandleForReading.readabilityHandler = nil
            stderr.fileHandleForReading.readabilityHandler = nil
            process = nil; input = nil; output = nil; errors = nil
            throw error
        }
        Task { [weak self] in
            try? await Task.sleep(for: .seconds(20))
            guard let self, self.generation == current, !self.stopping, self.origin == nil, self.process?.isRunning == true else { return }
            self.logger.error("Local child startup timed out")
            self.onFailure?("The local service did not become ready. Reconnect after checking that this project is not open in another local service.")
            self.stop()
        }
    }

    private func receive(_ data: Data, generation current: UUID) {
        // A queued ready envelope must not revive a child whose shutdown has begun.
        guard generation == current, !stopping, process?.isRunning == true, !data.isEmpty else { return }
        buffer.append(data)
        guard buffer.count <= 65536 else { onFailure?("The service returned an invalid startup response."); stop(); return }
        while let newline = buffer.firstIndex(of: 10) {
            let line = buffer.prefix(upTo: newline); buffer.removeSubrange(...newline)
            guard let value = try? JSONSerialization.jsonObject(with: line) as? [String: Any],
                  value["type"] as? String == "ready", origin == nil,
                  value["pid"] as? Int32 == process?.processIdentifier,
                  let text = value["origin"] as? String, let url = URL(string: text),
                  url.scheme == "http", url.host == "127.0.0.1", let port = url.port, (1...65535).contains(port),
                  url.user == nil, url.password == nil, url.query == nil, url.fragment == nil, url.path.isEmpty else { continue }
            origin = url
            lastPort = port
            logger.info("Local child reported ready: pid=\(self.process?.processIdentifier ?? 0)")
            onReady?(url)
        }
    }

    private nonisolated static func ownerToken(workspace: URL) async throws -> String {
        let read = OwnerTokenRead()
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                guard read.install(continuation) else { return }
                ownerReadQueue.async {
                    guard read.pending else { return }
                    read.finish(Result { try readOwnerToken(workspace: workspace) })
                }
                DispatchQueue.global(qos: .userInitiated).asyncAfter(deadline: .now() + 12) {
                    read.finish(.failure(LocalFailure(message: "Reading this project's local owner configuration timed out. Its files are preserved. Make sure the folder is available on this Mac, then reconnect.")))
                }
            }
        } onCancel: {
            read.finish(.failure(CancellationError()))
        }
    }

    private nonisolated static func readOwnerToken(workspace: URL) throws -> String {
        let configURL = workspace.appendingPathComponent("config.json")
        // Only POSIX type/mode are needed. Foundation's broader metadata read
        // can block startup while querying extended attributes on this file.
        var attributes = stat()
        let result = configURL.path.withCString { lstat($0, &attributes) }
        guard result == 0, (attributes.st_mode & S_IFMT) == S_IFREG,
              attributes.st_mode & 0o077 == 0,
              attributes.st_size > 0, attributes.st_size <= 65_536 else { throw LocalFailure(message: "The owner configuration must be a private regular file of a supported size.") }
        let bytes = try Data(contentsOf: configURL)
        guard bytes.count <= 65_536,
              let config = try JSONSerialization.jsonObject(with: bytes) as? [String: Any],
              config["schema_version"] as? String == "caniscreenwrite-local-writer-config/v1",
              let token = config["ownerToken"] as? String,
              token.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil else { throw LocalFailure(message: "This folder has no valid local owner configuration.") }
        return token
    }

    func authenticate(workspace: URL, cookies: WKHTTPCookieStore) async throws -> URL {
        guard let origin, !stopping, let child = process, child.isRunning else { throw LocalFailure(message: "The local service is not ready. Reconnect to start it again.") }
        let current = generation
        func requireCurrentService() throws {
            guard self.generation == current, !self.stopping, self.process === child,
                  child.isRunning, self.origin == origin else {
                throw LocalFailure(message: "The local service stopped while connecting. Reconnect to start it again.")
            }
        }
        // Re-read at authentication; preflight does not cache owner credentials.
        let token = try await Self.ownerToken(workspace: workspace)
        try requireCurrentService()
        try Task.checkCancellation()
        var request = URLRequest(url: origin.appendingPathComponent("api/session"))
        request.httpMethod = "POST"; request.timeoutInterval = 10
        request.setValue(origin.absoluteString, forHTTPHeaderField: "Origin")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: ["token": token])
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpShouldSetCookies = false
        let session = URLSession(configuration: configuration, delegate: NoRedirects(), delegateQueue: nil)
        defer { session.invalidateAndCancel() }
        let response: URLResponse
        do {
            (_, response) = try await session.data(for: request)
        } catch {
            let failure = error as NSError
            // Log only the error class/code, never the owner request or response.
            logger.error("Local authentication failed: domain=\(failure.domain, privacy: .public), code=\(failure.code)")
            try requireCurrentService()
            throw error
        }
        try requireCurrentService()
        guard let response = response as? HTTPURLResponse, response.statusCode == 200,
              response.url == request.url, let raw = response.value(forHTTPHeaderField: "Set-Cookie"),
              let ownerCookie = HTTPCookie.cookies(withResponseHeaderFields: ["Set-Cookie": raw], for: origin).first(where: { $0.name == "writer_owner" }), ownerCookie.isHTTPOnly else {
            throw LocalFailure(message: "The local owner session could not be opened.")
        }
        await cookies.setCookie(ownerCookie)
        try requireCurrentService()
        logger.info("Local owner session opened")
        return origin
    }

    func stop() {
        if starting { generation = UUID(); starting = false }
        stopping = true
        origin = nil; buffer.removeAll(keepingCapacity: false)
        try? input?.fileHandleForWriting.close()
        if process?.isRunning == true { process?.terminate() }
    }
}
