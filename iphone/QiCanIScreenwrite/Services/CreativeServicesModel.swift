import Foundation
import Observation
import ScreenwriteCore

enum CreativeRoute: String, CaseIterable, Identifiable {
    case apple = "Apple · On this iPhone", local = "My local Ollama", hosted = "Hosted service"
    var id: Self { self }
}

struct CreativeRequestReview: Identifiable {
    let id = UUID()
    let input: AnalysisInput
    let route: CreativeRoute
    let destination: String
    let model: String
    let installedModel: InstalledCreativeModel?
    let accountID: String?
}

@MainActor @Observable final class CreativeServicesModel {
    var route: CreativeRoute = .apple
    private(set) var appleStatus = AppleCreativeClient.status()
    var kind: AnalysisKind = .screenplayProfile
    var scope: AnalysisScope = .full
    var characterName = ""
    var endpointText = UserDefaults.standard.string(forKey: "creative.ollama.endpoint") ?? ""
    var selectedModel = ""
    var email = ""
    var password = ""
    var review: CreativeRequestReview?
    private(set) var quote: CreativeQuote?
    private(set) var quoteAccountID: String?
    private(set) var installedModels: [InstalledCreativeModel] = []
    private(set) var refreshedEndpoint: String?
    private(set) var modelNotice: String?
    private(set) var configuration: HostedCreativeConfiguration?
    private(set) var configurationIssue: String?
    private(set) var session: CreativeAccountSession?
    private(set) var catalog: CreativeCatalog?
    private(set) var catalogCheckedAt: Date?
    private(set) var busy = false
    private(set) var activity = ""
    var error: String?
    private(set) var reports: [SavedCreativeReport] = []
    private(set) var loadIssues: [String] = []
    private(set) var pending: PendingCreativeSubmission?
    private(set) var pendingDamaged = false
    private(set) var job: CreativeJob?
    private(set) var recentJobs: [CreativeJob] = []
    private var store: CreativeReportStore?
    private var task: Task<Void, Never>?

    init() {
        do { configuration = try HostedCreativeConfiguration.load() }
        catch { configurationIssue = error.localizedDescription }
        // Disk reads only. This initializer never contacts a service.
        do {
            let store = try CreativeReportStore(); self.store = store
            let loaded = try store.load()
            reports = loaded.reports; loadIssues = loaded.issues
            pending = loaded.pending; pendingDamaged = loaded.pendingDamaged
        } catch { loadIssues = ["Creative report storage could not open. Existing writing is unchanged."]; pendingDamaged = true }
    }

    var hasSession: Bool { session.map { $0.expiresAt > Date() } ?? false }
    var canQuote: Bool { hasSession && catalog?.enabled == true && pending == nil && !pendingDamaged && store != nil }
    var hostedModel: String? { catalog?.services.first { $0.kind == kind && $0.enabled }?.model }

    func refreshAppleStatus() { appleStatus = AppleCreativeClient.status() }

    func routeChanged() {
        guard !busy else { return }
        review = nil; quote = nil; quoteAccountID = nil; error = nil
        if route == .apple {
            if kind == .coverage { kind = .screenplayProfile }
            refreshAppleStatus()
        }
    }

    func endpointEdited() {
        installedModels = []; selectedModel = ""; refreshedEndpoint = nil; modelNotice = nil
    }

    func refreshModels() {
        let endpoint = endpointText
        installedModels = []; selectedModel = ""; refreshedEndpoint = nil
        perform("Checking installed models…") {
            let client = try OllamaCreativeClient(endpoint: endpoint)
            let result = try await client.models()
            guard self.endpointText == endpoint else { return }
            self.installedModels = result.models
            self.refreshedEndpoint = endpoint
            // Selection is explicit, including when only one model is installed.
            self.modelNotice = "\(result.models.count) installed local models. \(result.rejected) cloud, remote or invalid entries rejected."
            UserDefaults.standard.set(endpoint, forKey: "creative.ollama.endpoint")
        }
    }

    func prepare(_ draft: PocketSnapshot) {
        guard !busy else { return }
        error = nil; quote = nil; quoteAccountID = nil
        do {
            let input = try route == .apple
                ? CreativeAnalysis.freezeOnDevice(draftId: draft.id, title: draft.title, body: draft.body,
                    kind: kind, characterName: characterName)
                : CreativeAnalysis.freeze(draftId: draft.id, title: draft.title, body: draft.body,
                    kind: kind, scope: scope, characterName: characterName)
            switch route {
            case .apple:
                refreshAppleStatus()
                guard appleStatus.available else { throw CreativeAnalysisError(appleStatus.message) }
                review = .init(input: input, route: .apple, destination: "This iPhone · Apple on-device model",
                    model: CreativeAnalysis.onDeviceModelID, installedModel: nil, accountID: nil)
            case .local:
                guard refreshedEndpoint == endpointText, let selected = installedModels.first(where: { $0.name == selectedModel }) else {
                    throw CreativeAnalysisError("Refresh models for this address, then choose an installed local model.")
                }
                let url = try CreativeAnalysis.localEndpoint(endpointText).appendingPathComponent("api/chat")
                review = .init(input: input, route: .local, destination: url.absoluteString, model: selected.name, installedModel: selected, accountID: nil)
            case .hosted:
                guard canQuote, let configuration, let model = hostedModel, let session else {
                    throw CreativeAnalysisError("Sign in, refresh the enabled server catalog, and resolve any pending submission first.")
                }
                review = .init(input: input, route: .hosted, destination: configuration.destination.absoluteString,
                    model: model, installedModel: nil, accountID: session.userID)
            }
        } catch { self.error = error.localizedDescription }
    }

    func confirmApple(_ frozen: CreativeRequestReview) {
        guard frozen.route == .apple else { return }
        perform("Preparing feedback on this iPhone…") {
            let report = try await AppleCreativeClient.analyze(frozen.input)
            try Task.checkCancellation()
            self.review = nil
            try self.retain(report, destination: frozen.destination)
        }
    }

    func confirmLocal(_ frozen: CreativeRequestReview) {
        guard frozen.route == .local, let selected = frozen.installedModel else { return }
        perform("Checking model context and analyzing the frozen text…") {
            // Derive solely from the frozen review, never mutable endpoint/model/source controls.
            let base = URL(string: frozen.destination)!.deletingLastPathComponent().deletingLastPathComponent()
            let report = try await OllamaCreativeClient(endpoint: base.absoluteString).analyze(input: frozen.input, model: selected)
            self.review = nil
            try self.retain(report, destination: frozen.destination)
        }
    }

    func signIn() {
        guard let configuration else { return }
        let email = email.trimmingCharacters(in: .whitespacesAndNewlines), password = password
        self.password = ""
        perform("Signing in to the configured account service…") {
            let session = try await HostedCreativeClient(configuration: configuration).signIn(email: email, password: password)
            self.session = session; self.catalog = nil; self.catalogCheckedAt = nil; self.quote = nil; self.quoteAccountID = nil
        }
    }

    func signOut() {
        guard !busy else { return }
        session = nil; password = ""; email = ""; catalog = nil; catalogCheckedAt = nil
        quote = nil; quoteAccountID = nil; review = nil; recentJobs = []
    }

    func refreshCatalog() {
        guard let configuration else { return }
        perform("Reading server catalog and wallet…") {
            self.catalog = try await HostedCreativeClient(configuration: configuration).catalog(session: self.session)
            self.catalogCheckedAt = Date()
        }
    }

    func refreshRecentJobs() {
        guard let configuration, let session else { error = "Sign in to recover your recent jobs."; return }
        perform("Reading this account's latest 30 jobs…") {
            self.recentJobs = try await HostedCreativeClient(configuration: configuration).recentJobs(session: session)
        }
    }

    func saveRecovered(_ recovered: CreativeJob) {
        guard let configuration, let report = recovered.report else { return }
        do {
            if let pending, pending.jobID == recovered.id { try accept(recovered, pending: pending) }
            else { try retain(report, destination: configuration.destination.absoluteString) }
        } catch { self.error = error.localizedDescription }
    }

    func requestQuote(_ frozen: CreativeRequestReview) {
        guard let configuration, let session, session.userID == frozen.accountID,
              frozen.destination == configuration.destination.absoluteString, canQuote else { error = "Account or configuration changed. Review again."; return }
        perform("Requesting a quote; no spend authorized…") {
            let quote = try await HostedCreativeClient(configuration: configuration).quote(input: frozen.input, session: session)
            self.quote = quote; self.quoteAccountID = session.userID
        }
    }

    func spend(_ confirmed: CreativeQuote) {
        guard let configuration, let session, session.userID == quoteAccountID,
              quote?.id == confirmed.id, confirmed.isCurrent, pending == nil, !pendingDamaged,
              let store else { error = "Quote expired, account changed, or a submission is unresolved. No new spend was sent."; return }
        perform("Submitting the confirmed quote…") {
            let pending = PendingCreativeSubmission(accountID: session.userID, destination: configuration.destination.absoluteString, quote: confirmed, jobID: nil)
            // Durable intent must succeed before any money-related request leaves the app.
            try store.savePending(pending)
            self.pending = pending; self.review = nil; self.quote = nil; self.quoteAccountID = nil
            self.catalog = nil; self.catalogCheckedAt = nil
            let job = try await HostedCreativeClient(configuration: configuration).submit(quote: confirmed, session: session)
            try self.accept(job, pending: pending)
        }
    }

    func recoverPending() {
        guard let configuration, let session, let pending,
              pending.accountID == session.userID, pending.destination == configuration.destination.absoluteString else {
            error = "Sign in to the same account and configured destination used for the pending submission."; return
        }
        perform(pending.jobID == nil ? "Recovering the same quote submission…" : "Checking job status…") {
            let client = HostedCreativeClient(configuration: configuration)
            let job: CreativeJob
            if let id = pending.jobID { job = try await client.status(jobID: id, quote: pending.quote, session: session) }
            else { job = try await client.submit(quote: pending.quote, session: session) }
            try self.accept(job, pending: pending)
        }
    }

    private func accept(_ job: CreativeJob, pending: PendingCreativeSubmission) throws {
        guard let store else { throw CreativeAnalysisError("Creative storage unavailable. Recover this same request later.") }
        self.job = job
        var pending = pending; pending.jobID = job.id
        self.pending = pending
        try store.savePending(pending)
        if let report = job.report { try retain(report, destination: pending.destination) }
        if job.status == .completed || job.status == .refunded {
            try store.finishPending(); self.pending = nil
        }
    }

    private func retain(_ report: AnalysisReport, destination: String) throws {
        var item = SavedCreativeReport(report: report, destination: destination, saved: false)
        reports.removeAll { $0.id == report.id }; reports.insert(item, at: 0)
        guard let store else { throw CreativeAnalysisError("Report is available for export but could not be saved. Export it before closing.") }
        do {
            try store.save(item)
            item.saved = true
            if let index = reports.firstIndex(where: { $0.id == item.id }) { reports[index] = item }
        } catch { throw CreativeAnalysisError("Report is available for export but was not saved. Export it before closing. Existing files are unchanged.") }
    }

    func retrySave(_ item: SavedCreativeReport) {
        do { try retain(item.report, destination: item.destination) }
        catch { self.error = error.localizedDescription }
    }

    func cancel() { task?.cancel() }
    func leave() { cancel(); password = ""; session = nil }

    private func perform(_ activity: String, operation: @escaping @MainActor () async throws -> Void) {
        guard !busy else { return }
        busy = true; self.activity = activity; error = nil
        task = Task { [weak self] in
            guard let self else { return }
            defer { self.busy = false; self.activity = ""; self.task = nil }
            do { try await operation() }
            catch is CancellationError {
                self.error = self.pending == nil ? "Request cancelled. No report was accepted." : "Request stopped on this phone. The server may still be working. Recover the same saved submission."
            }
            catch { self.error = error.localizedDescription }
        }
    }
}
