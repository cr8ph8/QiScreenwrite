import Foundation
import ScreenwriteCore

struct HostedCreativeConfiguration: Sendable {
    let baseURL: URL
    private let publishableKey: String
    var destination: URL { baseURL.appendingPathComponent("functions/v1/creative-services") }
    var authDestination: URL { baseURL.appendingPathComponent("auth/v1/token") }
    var headers: [String: String] { ["apikey": publishableKey] }

    /// Operator-owned bundle configuration, deliberately absent/disabled in the default build.
    static func load(bundle: Bundle = .main) throws -> Self? {
        var values: [String: Any] = [:]
        if let file = bundle.url(forResource: "CreativeServicesConfig", withExtension: "plist") {
            let data = try Data(contentsOf: file)
            guard data.count <= 16_384, let plist = try PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any] else {
                throw CreativeAnalysisError("Invalid operator creative-services configuration.")
            }
            values = plist
        }
        for key in ["QICreativeHostedEnabled", "QICreativeSupabaseURL", "QICreativePublishableKey"] {
            if let value = bundle.object(forInfoDictionaryKey: key) { values[key] = value }
        }
        guard values["QICreativeHostedEnabled"] as? Bool == true else { return nil }
        guard let raw = values["QICreativeSupabaseURL"] as? String,
              let key = values["QICreativePublishableKey"] as? String else {
            throw CreativeAnalysisError("Hosted services are enabled but operator configuration is incomplete.")
        }
        return try .init(baseURL: raw, publishableKey: key)
    }

    init(baseURL: String, publishableKey: String) throws {
        guard let c = URLComponents(string: baseURL), c.scheme == "https", c.user == nil, c.password == nil,
              c.query == nil, c.fragment == nil, c.path.isEmpty || c.path == "/", c.port == nil || c.port == 443,
              let host = c.host, host.contains("."), !host.hasSuffix(".local"), !host.hasSuffix(".localhost"),
              !host.hasSuffix(".internal"), !host.contains(":"),
              host.unicodeScalars.allSatisfy({ CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.-").contains($0) }),
              host.contains(where: { $0.isLetter }), !baseURL.contains("%"), let url = c.url else {
            throw CreativeAnalysisError("Hosted configuration requires an operator public HTTPS domain without credentials, path or query.")
        }
        // Accept the modern public key only, never a service-role JWT or secret key.
        guard publishableKey.hasPrefix("sb_publishable_"), publishableKey.utf8.count <= 512,
              publishableKey.utf8.count > 20, !publishableKey.contains(where: { $0.isWhitespace }) else {
            throw CreativeAnalysisError("Operator configuration requires a Supabase publishable key. Secret/service-role keys are forbidden.")
        }
        self.baseURL = url; self.publishableKey = publishableKey
    }
}

struct CreativeAccountSession: Sendable {
    let userID: String
    let email: String
    fileprivate let accessToken: String
    let expiresAt: Date
}

struct CreativeCatalog: Decodable, Sendable {
    struct Service: Decodable, Identifiable, Sendable {
        let kind: AnalysisKind
        let model: String
        let credits: Double
        let enabled: Bool
        var id: AnalysisKind { kind }
    }
    let enabled: Bool
    let services: [Service]
    let balance: Double?
}

struct CreativeQuote: Codable, Identifiable, Sendable {
    let id: String
    let kind: AnalysisKind
    let model: String
    let credits: Double
    let expiresAt: String
    let input: AnalysisInput
    var expiration: Date? { CreativeAnalysis.parseDate(expiresAt) }
    var isCurrent: Bool { (expiration ?? .distantPast) > Date() }
}

struct CreativeJob: Decodable, Identifiable, Sendable {
    enum Status: String, Decodable, Sendable { case running, completed, refunded, uncertain }
    let id: String
    let status: Status
    let credits: Double
    let report: AnalysisReport?
    let error: String?
}

struct HostedCreativeClient: Sendable {
    let configuration: HostedCreativeConfiguration
    private let http = CreativeHTTP()

    func signIn(email: String, password: String) async throws -> CreativeAccountSession {
        guard !email.isEmpty, email.utf16.count <= 320, !password.isEmpty, password.utf16.count <= 4096 else {
            throw CreativeAnalysisError("Enter your account email and password.")
        }
        var url = URLComponents(url: configuration.authDestination, resolvingAgainstBaseURL: false)!
        url.queryItems = [.init(name: "grant_type", value: "password")]
        let body = try JSONSerialization.data(withJSONObject: ["email": email, "password": password])
        let data = try await http.request(url.url!, body: body, headers: configuration.headers, maximumBytes: 64 * 1024)
        let root = try CreativeAnalysis.object(CreativeAnalysis.json(data))
        let token = try CreativeAnalysis.text(root["access_token"], limit: 16_384, nonblank: true)
        let seconds = try CreativeAnalysis.number(root["expires_in"], maximum: 604_800)
        let user = try CreativeAnalysis.object(root["user"])
        let id = try CreativeAnalysis.text(user["id"], limit: 120, nonblank: true)
        guard seconds > 0, UUID(uuidString: id) != nil,
              root["token_type"] as? String == "bearer" else { throw CreativeAnalysisError("Invalid account session response.") }
        // Password, refresh token, access token and email are never written to disk.
        return .init(userID: id, email: email, accessToken: token, expiresAt: Date().addingTimeInterval(seconds))
    }

    func catalog(session: CreativeAccountSession?) async throws -> CreativeCatalog {
        let data = try await action(["action": "catalog"], session: session)
        let root = try CreativeAnalysis.object(CreativeAnalysis.json(data), keys: ["enabled", "services", "balance"])
        if !(root["balance"] is NSNull) { _ = try credits(root["balance"]) }
        let services = try CreativeAnalysis.array(root["services"], maximum: AnalysisKind.allCases.count)
        var seen = Set<String>()
        for service in services {
            let s = try CreativeAnalysis.object(service, keys: ["kind", "model", "credits", "enabled"])
            let kind = try CreativeAnalysis.text(s["kind"], limit: 30)
            guard AnalysisKind(rawValue: kind) != nil, seen.insert(kind).inserted else { throw CreativeAnalysisError("Invalid hosted service catalog.") }
            _ = try CreativeAnalysis.text(s["model"], limit: 200, nonblank: true)
            _ = try credits(s["credits"])
        }
        return try JSONDecoder().decode(CreativeCatalog.self, from: data)
    }

    func quote(input: AnalysisInput, session: CreativeAccountSession) async throws -> CreativeQuote {
        try CreativeAnalysis.validate(input)
        let data = try await action(["action": "quote", "input": CreativeAnalysis.json(CreativeAnalysis.encode(input))], session: session)
        let root = try CreativeAnalysis.object(CreativeAnalysis.json(data), keys: ["id", "kind", "model", "credits", "expiresAt", "input"])
        _ = try CreativeAnalysis.text(root["id"], limit: 120, nonblank: true)
        _ = try CreativeAnalysis.text(root["model"], limit: 200, nonblank: true)
        _ = try credits(root["credits"])
        let returned = try CreativeAnalysis.decodeInput(JSONSerialization.data(withJSONObject: CreativeAnalysis.object(root["input"])))
        let quote = try JSONDecoder().decode(CreativeQuote.self, from: data)
        guard try CreativeAnalysis.sameInput(returned, input), quote.kind == input.kind, quote.isCurrent else {
            throw CreativeAnalysisError("Quote changed the reviewed input or is expired. No spend was authorized.")
        }
        return quote
    }

    func submit(quote: CreativeQuote, session: CreativeAccountSession) async throws -> CreativeJob {
        // Server must bind one reservation/job to this quote ID. Retrying always uses the same ID.
        let data = try await action(["action": "submit", "quoteId": quote.id], session: session, timeout: 180)
        return try job(data, quote: quote)
    }

    func status(jobID: String, quote: CreativeQuote, session: CreativeAccountSession) async throws -> CreativeJob {
        let data = try await action(["action": "job", "jobId": jobID], session: session)
        let job = try job(data, quote: quote)
        guard job.id == jobID else { throw CreativeAnalysisError("Service returned a different job identity.") }
        return job
    }

    func recentJobs(session: CreativeAccountSession) async throws -> [CreativeJob] {
        let data = try await action(["action": "jobs"], session: session)
        let root = try CreativeAnalysis.object(CreativeAnalysis.json(data), keys: ["jobs"])
        var seen = Set<String>()
        return try CreativeAnalysis.array(root["jobs"], maximum: 30).map { value in
            let data = try JSONSerialization.data(withJSONObject: CreativeAnalysis.object(value))
            let job = try job(data, quote: nil)
            guard seen.insert(job.id).inserted else { throw CreativeAnalysisError("Duplicate recent job identity.") }
            return job
        }
    }

    private func job(_ data: Data, quote: CreativeQuote?) throws -> CreativeJob {
        let root = try CreativeAnalysis.object(CreativeAnalysis.json(data), keys: ["id", "status", "credits", "report", "error"])
        _ = try CreativeAnalysis.text(root["id"], limit: 120, nonblank: true)
        let charged = try credits(root["credits"])
        if let quote, charged != quote.credits { throw CreativeAnalysisError("Job credits differ from the confirmed quote. Check the same job; do not submit a new quote.") }
        if !(root["error"] is NSNull) { _ = try CreativeAnalysis.text(root["error"], limit: 4000) }
        if !(root["report"] is NSNull) {
            let report = try CreativeAnalysis.decodeReport(JSONSerialization.data(withJSONObject: CreativeAnalysis.object(root["report"])))
            guard report.provider == .hosted, report.platformCredits == charged else {
                throw CreativeAnalysisError("Invalid hosted report provider or credits.")
            }
            if let quote {
                let sameInput = try CreativeAnalysis.sameInput(report.input, quote.input)
                guard report.model == quote.model, sameInput else {
                    throw CreativeAnalysisError("Report does not match the confirmed source, model or credits.")
                }
            }
        }
        let job = try JSONDecoder().decode(CreativeJob.self, from: data)
        guard (job.status == .completed) == (job.report != nil) else { throw CreativeAnalysisError("Job status and report disagree.") }
        if let report = job.report, UUID(uuidString: job.id) != report.id {
            throw CreativeAnalysisError("Report identity does not match its server job.")
        }
        return job
    }

    private func credits(_ value: Any?) throws -> Double {
        let n = try CreativeAnalysis.number(value, maximum: 9_007_199_254_740_991)
        guard n.rounded(.towardZero) == n else { throw CreativeAnalysisError("Invalid authoritative credit amount.") }
        return n
    }

    private func action(_ body: [String: Any], session: CreativeAccountSession?, timeout: TimeInterval = 25) async throws -> Data {
        var headers = configuration.headers
        if let session {
            guard session.expiresAt > Date().addingTimeInterval(5) else { throw CreativeAnalysisError("Your memory-only account session expired. Sign in again.") }
            headers["Authorization"] = "Bearer \(session.accessToken)"
        } else if body["action"] as? String != "catalog" { throw CreativeAnalysisError("Sign in to request hosted services.") }
        return try await http.request(configuration.destination, body: JSONSerialization.data(withJSONObject: body), headers: headers, timeout: timeout)
    }
}
