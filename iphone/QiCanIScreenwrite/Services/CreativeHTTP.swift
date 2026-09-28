import Foundation
import ScreenwriteCore

/// A fresh ephemeral session per explicit action. No cookies, credential cache, redirects or automatic retries.
struct CreativeHTTP: Sendable {
    private final class RedirectBlocker: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
        func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                        newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
            completionHandler(nil)
        }
    }

    func request(_ url: URL, body: Data? = nil, headers: [String: String] = [:],
                 timeout: TimeInterval = 25, maximumBytes: Int = CreativeAnalysis.maximumJSONBytes) async throws -> Data {
        guard (body?.count ?? 0) <= 256 * 1024 else { throw CreativeAnalysisError("Request exceeds 256 KiB; nothing was sent.") }
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: timeout)
        request.httpMethod = body == nil ? "GET" : "POST"
        request.httpBody = body
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if body != nil { request.setValue("application/json", forHTTPHeaderField: "Content-Type") }
        for (key, value) in headers { request.setValue(value, forHTTPHeaderField: key) }
        let config = URLSessionConfiguration.ephemeral
        config.urlCache = nil; config.httpCookieStorage = nil; config.urlCredentialStorage = nil
        config.httpShouldSetCookies = false; config.requestCachePolicy = .reloadIgnoringLocalCacheData
        config.timeoutIntervalForRequest = timeout; config.timeoutIntervalForResource = timeout
        config.waitsForConnectivity = false
        // The reviewed destination is contacted directly, including private LAN endpoints.
        config.connectionProxyDictionary = [:]
        let delegate = RedirectBlocker()
        let session = URLSession(configuration: config, delegate: delegate, delegateQueue: nil)
        defer { session.invalidateAndCancel() }
        do {
            let (bytes, response) = try await session.bytes(for: request)
            guard let response = response as? HTTPURLResponse else { throw CreativeAnalysisError("Invalid service response.") }
            guard response.url == url else { throw CreativeAnalysisError("The response destination differs from the reviewed request. Nothing was accepted.") }
            guard !(300...399).contains(response.statusCode) else { throw CreativeAnalysisError("The service redirected the request. Redirects are rejected; verify the configured destination.") }
            guard (200...299).contains(response.statusCode) else {
                if response.statusCode == 401 || response.statusCode == 403 { throw CreativeAnalysisError("The service rejected authorization. Sign in again or check operator configuration.") }
                throw CreativeAnalysisError("Service returned HTTP \(response.statusCode). No successful result was accepted.")
            }
            guard response.mimeType?.lowercased() == "application/json" else { throw CreativeAnalysisError("Service must return application/json. No result was accepted.") }
            guard response.expectedContentLength <= maximumBytes else { throw CreativeAnalysisError("Service response exceeds the size limit; nothing was truncated.") }
            var data = Data()
            for try await byte in bytes {
                try Task.checkCancellation()
                guard data.count < maximumBytes else { throw CreativeAnalysisError("Service response exceeds the size limit; nothing was truncated.") }
                data.append(byte)
            }
            return data
        } catch is CancellationError { throw CancellationError() }
        catch let error as CreativeAnalysisError { throw error }
        catch let error as URLError {
            if error.code == .cancelled { throw CancellationError() }
            if error.code == .timedOut { throw CreativeAnalysisError("Request timed out. For a paid submission, recover the same saved quote; do not assume it failed or was refunded.") }
            throw CreativeAnalysisError("Could not reach the configured service (network code \(error.errorCode)). Check its address, TLS certificate and local-network permission.")
        } catch { throw CreativeAnalysisError("The service request did not finish. No result was accepted.") }
    }
}
