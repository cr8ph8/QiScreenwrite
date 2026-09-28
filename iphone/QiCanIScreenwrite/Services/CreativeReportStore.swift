import Foundation
import ScreenwriteCore

struct SavedCreativeReport: Identifiable, Sendable {
    let report: AnalysisReport
    let destination: String
    var saved: Bool = true
    var id: UUID { report.id }
}

struct PendingCreativeSubmission: Codable, Sendable {
    let accountID: String
    let destination: String
    let quote: CreativeQuote
    var jobID: String?
}

/// This repository has no reference to PocketStore, authored documents, or the exchange schema.
struct CreativeReportStore {
    let directory: URL
    private let fileManager = FileManager.default
    private struct Envelope: Codable {
        let schema: String
        let sha256: String
        let payload: Data
        let destination: String
    }
    private let schema = "qicaniscreenwrite-creative-report/v1"
    private var pendingFile: URL { directory.appendingPathComponent("pending-hosted.json") }

    init(directory: URL? = nil) throws {
        self.directory = try directory ?? FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask,
            appropriateFor: nil, create: true).appendingPathComponent("QiCanIScreenwrite-CreativeServices", isDirectory: true)
        try fileManager.createDirectory(at: self.directory, withIntermediateDirectories: true)
        #if os(iOS)
        try fileManager.setAttributes([.protectionKey: FileProtectionType.complete], ofItemAtPath: self.directory.path)
        #endif
    }

    func save(_ item: SavedCreativeReport) throws {
        let payload = try CreativeAnalysis.encode(item.report)
        _ = try CreativeAnalysis.decodeReport(payload)
        let url = directory.appendingPathComponent(item.id.uuidString.lowercased()).appendingPathExtension("qicreative")
        let envelope = Envelope(schema: schema, sha256: PocketPackage.sha256(payload), payload: payload, destination: item.destination)
        let data = try JSONEncoder().encode(envelope)
        guard data.count <= 2 * CreativeAnalysis.maximumJSONBytes else { throw CreativeAnalysisError("Report file exceeds 2 MiB.") }
        if fileManager.fileExists(atPath: url.path) {
            let existing = try JSONDecoder().decode(Envelope.self, from: read(url))
            guard existing.schema == envelope.schema, existing.sha256 == envelope.sha256,
                  existing.payload == envelope.payload, existing.destination == envelope.destination else {
                throw CreativeAnalysisError("A different or damaged report already has this identity. Its file was left untouched.")
            }
            return
        }
        try write(data, to: url)
    }

    func load() throws -> (reports: [SavedCreativeReport], issues: [String], pending: PendingCreativeSubmission?, pendingDamaged: Bool) {
        var reports: [SavedCreativeReport] = [], issues: [String] = []
        for url in try fileManager.contentsOfDirectory(at: directory, includingPropertiesForKeys: [.fileSizeKey, .isSymbolicLinkKey]) where url.pathExtension == "qicreative" {
            do {
                let envelope = try JSONDecoder().decode(Envelope.self, from: read(url))
                guard envelope.schema == schema, PocketPackage.sha256(envelope.payload) == envelope.sha256 else { throw CreativeAnalysisError("Report checksum does not match.") }
                let report = try CreativeAnalysis.decodeReport(envelope.payload)
                guard url.deletingPathExtension().lastPathComponent == report.id.uuidString.lowercased(),
                      URL(string: envelope.destination) != nil, envelope.destination.utf16.count <= 2000 else { throw CreativeAnalysisError("Invalid report identity or destination.") }
                reports.append(.init(report: report, destination: envelope.destination))
            } catch { issues.append("\(url.lastPathComponent): report could not be read and was left untouched.") }
        }
        var pending: PendingCreativeSubmission?, damaged = false
        if fileManager.fileExists(atPath: pendingFile.path) {
            do {
                let envelope = try JSONDecoder().decode(Envelope.self, from: read(pendingFile))
                guard envelope.schema == "qicaniscreenwrite-creative-pending/v1", PocketPackage.sha256(envelope.payload) == envelope.sha256 else { throw CreativeAnalysisError("Pending submission checksum does not match.") }
                let loaded = try JSONDecoder().decode(PendingCreativeSubmission.self, from: envelope.payload)
                try CreativeAnalysis.validate(loaded.quote.input)
                guard UUID(uuidString: loaded.accountID) != nil, !loaded.quote.id.isEmpty, loaded.quote.id.utf16.count <= 120,
                      loaded.quote.kind == loaded.quote.input.kind, loaded.quote.expiration != nil,
                      loaded.quote.credits.isFinite, loaded.quote.credits >= 0, loaded.quote.credits.rounded() == loaded.quote.credits,
                      loaded.destination == envelope.destination, URL(string: loaded.destination)?.scheme == "https" else {
                    throw CreativeAnalysisError("Invalid pending submission.")
                }
                pending = loaded
            } catch {
                damaged = true
                issues.append("Pending paid submission could not be read. Its file is untouched. New spending is blocked until the operator reconciles the existing server job.")
            }
        }
        reports.sort { ($0.report.createdAt, $0.id.uuidString) > ($1.report.createdAt, $1.id.uuidString) }
        return (reports, issues, pending, damaged)
    }

    func savePending(_ pending: PendingCreativeSubmission) throws {
        let payload = try CreativeAnalysis.encode(pending)
        let envelope = Envelope(schema: "qicaniscreenwrite-creative-pending/v1", sha256: PocketPackage.sha256(payload),
            payload: payload, destination: pending.destination)
        try write(JSONEncoder().encode(envelope), to: pendingFile)
    }

    func finishPending() throws {
        if fileManager.fileExists(atPath: pendingFile.path) { try fileManager.removeItem(at: pendingFile) }
    }

    private func read(_ url: URL) throws -> Data {
        let info = try url.resourceValues(forKeys: [.fileSizeKey, .isSymbolicLinkKey, .isRegularFileKey])
        guard info.isSymbolicLink != true, info.isRegularFile == true, (info.fileSize ?? Int.max) <= 2 * CreativeAnalysis.maximumJSONBytes else {
            throw CreativeAnalysisError("Invalid or oversized report file.")
        }
        return try Data(contentsOf: url)
    }
    private func write(_ data: Data, to url: URL) throws {
        #if os(iOS)
        try data.write(to: url, options: [.atomic, .completeFileProtection])
        #else
        try data.write(to: url, options: .atomic)
        #endif
    }
}
