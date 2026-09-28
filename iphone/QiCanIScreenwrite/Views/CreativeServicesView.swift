import SwiftUI
import UniformTypeIdentifiers
import ScreenwriteCore

struct CreativeServicesView: View {
    let draft: PocketSnapshot
    @State private var model = CreativeServicesModel()
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        Form {
            Section {
                Text("Creative feedback is advisory. It does not update your screenplay, world, rights or competition records.")
                Picker("Service", selection: $model.kind) {
                    ForEach(AnalysisKind.allCases.filter { model.route != .apple || $0 != .coverage }) { Text($0.title).tag($0) }
                }
                if model.kind == .characterProfile {
                    TextField("Fictional character name", text: $model.characterName)
                    Text("Character Diamond: North Star, Counter-Star, Flaw / Mask and Non-Negotiable. Unknowns stay unknown.").font(.caption)
                }
                if model.route != .apple {
                Picker("Scope", selection: $model.scope) {
                    ForEach(AnalysisScope.allCases, id: \.self) { Text($0.title).tag($0) }
                }
                Text("This draft has \(draft.body.utf16.count) characters. Analysis accepts up to 12,000. An opening excerpt describes only that passage, including any scores.")
                    .font(.caption).foregroundStyle(.secondary)
                } else {
                    Text("Opening passage only · up to 1,600 UTF-8 bytes. Review the exact text first. Feedback cannot assess the whole film.")
                        .font(.caption).foregroundStyle(.secondary)
                }
                Picker("Route", selection: $model.route) { ForEach(CreativeRoute.allCases) { Text($0.rawValue).tag($0) } }
            }.disabled(model.busy)

            if model.route == .apple { appleControls }
            else if model.route == .local { localControls } else { hostedControls }

            Section {
                Button("Review exact request", systemImage: "doc.text.magnifyingglass") { model.prepare(draft) }
                    .disabled(model.busy || (model.route == .apple && !model.appleStatus.available) || (model.route == .hosted && (!model.canQuote || model.hostedModel == nil)))
                    .accessibilityIdentifier("creative-review-request")
            }
            activity
            if let pending = model.pending { pendingSection(pending) }
            if let job = model.job { jobSection(job) }
            if !model.recentJobs.isEmpty { recentJobs }
            reports
            if !model.loadIssues.isEmpty {
                Section("Storage needs attention") { ForEach(Array(model.loadIssues.enumerated()), id: \.offset) { Text($0.element).foregroundStyle(.red) } }
            }
        }
        .navigationTitle("Creative services")
        .navigationBarTitleDisplayMode(.inline)
        .onChange(of: model.route) { _, _ in model.routeChanged() }
        .onChange(of: scenePhase) { _, phase in if phase == .active { model.refreshAppleStatus() } }
        .onChange(of: model.endpointText) { _, _ in model.endpointEdited() }
        .sheet(item: $model.review) { review in
            CreativeReviewView(model: model, review: review)
        }
        .onDisappear { model.leave() }
    }

    private var appleControls: some View {
        Section("Apple Intelligence · on-device feedback") {
            Label(model.appleStatus.available ? "Ready on this iPhone" : "Not available right now",
                systemImage: model.appleStatus.available ? "checkmark.circle" : "info.circle")
                .accessibilityIdentifier("creative-apple-availability")
            Text(model.appleStatus.message).font(.footnote)
            Text("A short profile of the passage with observations, questions and revision ideas. Your writing stays unchanged. Results appear in this draft’s reports.")
                .font(.footnote)
            Text("Runs on this device with no provider upload or service credits. Requires iOS 26+, a supported device and Apple Intelligence ready. There is no automatic cloud fallback.")
                .font(.caption).foregroundStyle(.secondary)
            Button("Check availability again") { model.refreshAppleStatus() }
                .accessibilityIdentifier("creative-check-apple")
        }.disabled(model.busy)
    }

    private var localControls: some View {
        Section("Your Ollama machine · zero platform credits") {
            Text("Connect to Ollama already running on your own trusted LAN machine. Inference runs there, not on this iPhone. No model is downloaded. Loopback addresses refer to this device (or the simulator's host).")
                .font(.footnote)
            TextField("http://192.168.1.20:11434", text: $model.endpointText)
                .keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
                .accessibilityLabel("Private Ollama endpoint").accessibilityIdentifier("creative-local-endpoint")
            Text("Use a literal private IPv4 or loopback address. HTTP sends text unencrypted over your LAN; use a trusted network or correctly configured HTTPS.")
                .font(.caption).foregroundStyle(.secondary)
            Button("Refresh installed models", systemImage: "arrow.clockwise") { model.refreshModels() }
                .accessibilityIdentifier("creative-refresh-models")
            Picker("Installed model", selection: $model.selectedModel) {
                Text("Choose a model").tag("")
                ForEach(model.installedModels) { Text(verbatim: $0.name).tag($0.name) }
            }
            if let notice = model.modelNotice { Text(verbatim: notice).font(.caption) }
            Text("Before text is sent, the app checks the model's local metadata and context capacity. Cloud aliases, redirects and incomplete responses are rejected.")
                .font(.caption).foregroundStyle(.secondary)
        }.disabled(model.busy)
    }

    private var hostedControls: some View {
        Section("Hosted account & service credits") {
            if let config = model.configuration {
                Text("Service destination").font(.caption)
                Text(verbatim: config.destination.absoluteString).font(.caption.monospaced()).textSelection(.enabled)
                if model.hasSession, let session = model.session {
                    Text(verbatim: "Signed in as \(session.email)")
                    Text("Credentials stay in memory and are cleared when you leave this screen. Sessions expire; sign in again when needed.").font(.caption)
                    Button("Sign out on this iPhone") { model.signOut() }
                } else {
                    Text("Email/password sign-in destination: \(config.authDestination.absoluteString)").font(.caption)
                    TextField("Account email", text: $model.email).textContentType(.username).keyboardType(.emailAddress)
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                    SecureField("Password", text: $model.password).textContentType(.password)
                    Button("Sign in") { model.signIn() }
                }
                Button("Refresh catalog & wallet") { model.refreshCatalog() }
                Button("Recover recent account jobs") { model.refreshRecentJobs() }.disabled(!model.hasSession)
                if let catalog = model.catalog {
                    Text(catalog.enabled ? "Server catalog is enabled" : "Server catalog is disabled")
                    if let balance = catalog.balance {
                        Text("Server balance: \(balance.formatted(.number.precision(.fractionLength(0)))) service credits")
                    } else { Text("Wallet balance unavailable. Sign in and refresh.") }
                    if let date = model.catalogCheckedAt { Text("Last checked \(date.formatted(date: .abbreviated, time: .shortened))").font(.caption) }
                    ForEach(catalog.services) { service in
                        VStack(alignment: .leading, spacing: 4) {
                            Text(verbatim: service.kind.title + (service.enabled ? "" : " · unavailable"))
                            Text(verbatim: "\(service.model) · \(service.credits.formatted(.number.precision(.fractionLength(0)))) credits").font(.caption)
                        }
                    }
                } else { Text("Catalog and balance have not been checked.").font(.caption) }
            } else {
                Text("Hosted service is not configured. Operator deployment, provider access and prices are pending.")
                if let issue = model.configurationIssue { Text(verbatim: issue).font(.caption).foregroundStyle(.red) }
            }
            Text("Service credits are separate from model input/output tokens and blockchain assets. A quote does not authorize spending.")
                .font(.caption)
            Button("Buy service credits · unavailable") {}.disabled(true)
            Text("Purchases are unavailable. Operator StoreKit product configuration and verified server purchase handling are pending. No external checkout is offered.")
                .font(.caption).foregroundStyle(.secondary)
        }.disabled(model.busy)
    }

    @ViewBuilder private var activity: some View {
        if model.busy {
            Section { ProgressView(model.activity); Button("Stop waiting on this iPhone", role: .cancel) { model.cancel() } }
        }
        if let error = model.error {
            Section("Request needs attention") { Text(verbatim: error).foregroundStyle(.red).textSelection(.enabled) }
        }
    }

    private func pendingSection(_ pending: PendingCreativeSubmission) -> some View {
        Section("Unresolved paid submission") {
            Text("The server may still be working. A timeout or cancellation does not prove failure or a refund. New spending is blocked while this submission is unresolved.")
            Text(verbatim: "Quote: \(pending.quote.id)").font(.caption.monospaced()).textSelection(.enabled)
            Text(verbatim: pending.destination).font(.caption.monospaced()).textSelection(.enabled)
            Text(verbatim: "\(pending.quote.model) · \(pending.quote.credits.formatted()) confirmed service credits")
            if let id = pending.jobID { Text(verbatim: "Job: \(id)").font(.caption.monospaced()) }
            NavigationLink("Review saved submission") {
                Form { CreativeInputDisclosure(input: pending.quote.input, destination: pending.destination, model: pending.quote.model) }
                    .navigationTitle("Saved request")
            }
            Button(pending.jobID == nil ? "Recover same quote submission" : "Refresh this job's status") { model.recoverPending() }
                .disabled(model.busy || !model.hasSession)
            Text("Recovery uses the same confirmed quote. It does not request a new quote or authorize a second purchase.").font(.caption)
        }
    }

    private func jobSection(_ job: CreativeJob) -> some View {
        Section("Latest server job") {
            Text(verbatim: "\(job.id) · \(job.status.rawValue)")
            if job.status == .refunded { Text("Server reports refunded. Refresh the wallet for its current authoritative balance.") }
            if job.status == .uncertain { Text("Settlement is uncertain. Keep this job identity for operator reconciliation.") }
            if let error = job.error { Text(verbatim: error).font(.caption) }
        }
    }

    private var recentJobs: some View {
        Section("Recent account jobs · server response") {
            Text("Latest 30 jobs. Use Recover recent account jobs to check again. Completed reports can be saved to this phone.").font(.caption)
            ForEach(model.recentJobs) { job in
                VStack(alignment: .leading, spacing: 6) {
                    Text(verbatim: "\(job.id) · \(job.status.rawValue)").font(.caption.monospaced())
                    Text("Server credits: \(job.credits.formatted())").font(.caption)
                    if let report = job.report {
                        Text(verbatim: "\(report.input.source.title) · \(report.input.kind.title)")
                        Button("Save completed report on this iPhone") { model.saveRecovered(job) }.disabled(model.busy)
                    }
                    if let error = job.error { Text(verbatim: error).font(.caption) }
                }
            }
        }
    }

    private var reports: some View {
        Section("Reports for this draft") {
            Text("Reports are stored separately from screenplay snapshots. Export reports to keep portable copies.")
                .font(.caption).foregroundStyle(.secondary)
            let reports = model.reports.filter { $0.report.input.source.draftId == draft.id }
            if reports.isEmpty { Text("No reports yet. Reports are saved separately from your writing.").foregroundStyle(.secondary) }
            ForEach(reports) { item in
                NavigationLink {
                    CreativeReportView(item: item, retrySave: { model.retrySave(item) })
                } label: {
                    VStack(alignment: .leading, spacing: 5) {
                        Text(item.report.input.kind.title)
                        Text(verbatim: item.report.input.source.scope.title + " · " + item.report.model).font(.caption)
                        Text(verbatim: item.report.createdAt).font(.caption2).foregroundStyle(.secondary)
                        if !item.saved { Text("Not saved · export now").font(.caption).foregroundStyle(.red) }
                    }
                }
            }
            if model.reports.contains(where: { $0.report.input.source.draftId != draft.id }) {
                NavigationLink("All creative reports on this iPhone") {
                    List(model.reports) { item in
                        NavigationLink {
                            CreativeReportView(item: item, retrySave: { model.retrySave(item) })
                        } label: { Text(verbatim: "\(item.report.input.source.title) · \(item.report.input.kind.title)") }
                    }.navigationTitle("Creative reports")
                }
            }
        }
    }
}

private struct CreativeInputDisclosure: View {
    let input: AnalysisInput
    let destination: String
    let model: String
    var body: some View {
        Section("Frozen request") {
            Text(input.kind.title).font(.headline)
            Text(verbatim: input.source.title)
            Text(input.source.scope.title).font(.headline)
            if input.source.scope == .excerpt { Text("Only this opening passage is being analyzed. Its scores do not represent the full screenplay.") }
            if input.kind == .characterProfile { Text(verbatim: "Character: \(input.characterName)") }
            Text("Destination").font(.caption)
            Text(verbatim: destination).font(.caption.monospaced()).textSelection(.enabled)
            Text(verbatim: "Model: \(model)").textSelection(.enabled)
            Text(verbatim: "Draft ID: \(input.source.draftId)").font(.caption.monospaced())
            Text(verbatim: "Full source SHA-256: \(input.source.bodySha256)").font(.caption2.monospaced()).textSelection(.enabled)
            Text("The hash identifies this source snapshot; it does not establish authorship. This frozen request will not change if your writing changes.").font(.caption)
        }
        Section("Exact text to send · \(input.source.excerpt.utf16.count) characters") {
            Text(verbatim: input.source.excerpt).font(.system(.callout, design: .monospaced)).textSelection(.enabled)
        }
    }
}

private struct CreativeReviewView: View {
    @Bindable var model: CreativeServicesModel
    let review: CreativeRequestReview
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Form {
                CreativeInputDisclosure(input: review.input, destination: review.destination, model: model.quote?.model ?? review.model)
                if review.route == .apple {
                    Section("Confirm on-device feedback") {
                        Text("Only this opening passage is used. No cloud request, scoring or automatic changes to your writing. Review any suggestions before using them.")
                        Button("Create feedback on this iPhone · 0 credits") { model.confirmApple(review) }
                            .disabled(model.busy).accessibilityIdentifier("creative-confirm-apple")
                    }
                } else if review.route == .local {
                    Section("Confirm local analysis") {
                        Text("Zero platform credits. The exact text above is sent to your own Ollama machine. It runs on that machine, not on the iPhone.")
                        if let installed = review.installedModel { Text(verbatim: "Installed digest at refresh: \(installed.digest)").font(.caption2.monospaced()) }
                        Button("Send this text to local Ollama · 0 credits") { model.confirmLocal(review) }
                            .disabled(model.busy).accessibilityIdentifier("creative-confirm-local")
                    }
                } else if let quote = model.quote {
                    Section("Server quote · explicit spend required") {
                        Text(verbatim: "Quote: \(quote.id)").font(.caption.monospaced())
                        Text(verbatim: "Quoted model: \(quote.model)")
                        Text("\(quote.credits.formatted(.number.precision(.fractionLength(0)))) service credits").font(.headline)
                        Text(verbatim: "Expires: \(quote.expiresAt)")
                        Text("Confirming reserves/spends this quote's service credits through your account. The report is advisory.")
                        TimelineView(.periodic(from: .now, by: 1)) { context in
                            let expired = (quote.expiration ?? .distantPast) <= context.date
                            if expired {
                                Text("Quote expired. No spend was authorized.").foregroundStyle(.red)
                                Button("Request a fresh quote for this same text") { model.requestQuote(review) }.disabled(model.busy)
                            } else {
                                Button("Confirm spend · \(quote.credits.formatted(.number.precision(.fractionLength(0)))) service credits") { model.spend(quote) }
                                    .disabled(model.busy).accessibilityIdentifier("creative-confirm-spend")
                            }
                        }
                    }
                } else {
                    Section("Quote request · no spend") {
                        Text("Requesting a quote sends the exact frozen text and source information above to the configured hosted service. Review its returned model, price and expiry before spending.")
                        Button("Send this text & request quote · no spend") { model.requestQuote(review) }
                            .disabled(model.busy).accessibilityIdentifier("creative-request-quote")
                    }
                }
                if model.busy { Section { ProgressView(model.activity); Button("Stop waiting", role: .cancel) { model.cancel() } } }
                if let error = model.error { Section("Request needs attention") { Text(verbatim: error).foregroundStyle(.red) } }
            }
            .navigationTitle("Review & confirm")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() }.disabled(model.busy) } }
            .interactiveDismissDisabled(model.busy)
        }
    }
}

private struct CreativeJSONDocument: FileDocument {
    static var readableContentTypes: [UTType] { [.json] }
    var data: Data
    init(data: Data) { self.data = data }
    init(configuration: ReadConfiguration) throws { data = configuration.file.regularFileContents ?? Data() }
    func fileWrapper(configuration: WriteConfiguration) throws -> FileWrapper { FileWrapper(regularFileWithContents: data) }
}

private struct CreativeReportView: View {
    let item: SavedCreativeReport
    let retrySave: () -> Void
    @State private var exporting = false
    @State private var document: CreativeJSONDocument?
    @State private var error: String?
    private var report: AnalysisReport { item.report }
    var body: some View {
        List {
            Section("Advisory report") {
                Text(report.input.kind.title).font(.headline)
                Text(report.input.source.scope.title)
                Text(verbatim: "\(report.provider.rawValue) · \(report.model)")
                Text(verbatim: report.createdAt)
                Text("Platform service credits: \(report.platformCredits.formatted())")
                Text("Input tokens: \(report.usage.inputTokens.map(String.init) ?? "unknown") · Output tokens: \(report.usage.outputTokens.map(String.init) ?? "unknown")").font(.caption)
                Text("This is creative advice, not official judging, a rights decision or proof of authorship.").font(.caption)
                Text("Reports are stored separately from screenplay snapshots. Export reports to keep portable copies.")
                    .font(.caption).foregroundStyle(.secondary)
                if !item.saved { Text("This report has not been saved. Export before closing.").foregroundStyle(.red); Button("Retry local save", action: retrySave) }
                Button("Export report JSON", systemImage: "square.and.arrow.up") {
                    do { document = .init(data: try CreativeAnalysis.encode(report)); exporting = true }
                    catch { self.error = error.localizedDescription }
                }.accessibilityIdentifier("creative-export-report")
            }
            Section("Summary") { Text(verbatim: report.output.summary).textSelection(.enabled) }
            if let total = report.output.coverageTotal {
                Section(report.input.source.scope == .full ? "Coverage · \(total.formatted()) / 120" : "Opening excerpt coverage · \(total.formatted()) / 120") {
                    ForEach(CreativeAnalysis.rubric, id: \.key) { category in
                        if let score = report.output.scores.first(where: { $0.key == category.key }) {
                            VStack(alignment: .leading, spacing: 5) {
                                Text("\(category.title): \(score.score.formatted()) / \(category.maximum.formatted())")
                                Text(verbatim: score.evidence.isEmpty ? "No supporting passage supplied." : score.evidence).font(.caption).textSelection(.enabled)
                            }
                        }
                    }
                }
            }
            rows("Strengths", report.output.strengths)
            rows("Concerns", report.output.concerns)
            rows("Next steps", report.output.nextSteps)
            ForEach(Array(report.output.sections.enumerated()), id: \.offset) { _, section in
                Section {
                    Text(verbatim: section.body).textSelection(.enabled)
                    Text(verbatim: section.evidence.isEmpty ? "Evidence: unknown / interpretation." : "Evidence: \(section.evidence)")
                        .font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
                } header: { Text(verbatim: section.heading) }
            }
            CreativeInputDisclosure(input: report.input, destination: item.destination, model: report.model)
            if let error { Section { Text(verbatim: error).foregroundStyle(.red) } }
        }
        .navigationTitle("Creative report")
        .navigationBarTitleDisplayMode(.inline)
        .fileExporter(isPresented: $exporting, document: document, contentType: .json,
                      defaultFilename: "Creative-report-\(report.id.uuidString.lowercased())") { result in
            if case let .failure(error) = result { self.error = "Report export did not finish. \(error.localizedDescription)" }
        }
    }
    @ViewBuilder private func rows(_ title: String, _ values: [String]) -> some View {
        if !values.isEmpty { Section(title) { ForEach(Array(values.enumerated()), id: \.offset) { Text(verbatim: $0.element).textSelection(.enabled) } } }
    }
}
