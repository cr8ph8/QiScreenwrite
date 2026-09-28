import Foundation

public struct PocketRevision: Codable, Equatable, Identifiable, Sendable {
    public var id: Int
    public var savedAt: Date
    public var snapshot: PocketSnapshot
    public init(id: Int, savedAt: Date = Date(), snapshot: PocketSnapshot) {
        self.id = id; self.savedAt = savedAt; self.snapshot = snapshot
    }
}

public struct PocketDocument: Codable, Equatable, Identifiable, Sendable {
    public var id: String { working.id }
    public var working: PocketSnapshot
    public var revisions: [PocketRevision]
    public var updatedAt: Date
    public var importedHash: String?
    public var continuation: PocketContinuation?
    public var hasUnsavedRevision: Bool { revisions.last?.snapshot != working }
    public init(working: PocketSnapshot, revisions: [PocketRevision] = [], updatedAt: Date = Date(), importedHash: String? = nil, continuation: PocketContinuation? = nil) {
        self.working = working; self.revisions = revisions; self.updatedAt = updatedAt; self.importedHash = importedHash; self.continuation = continuation
    }
}

public struct PocketLibraryLoad {
    public let documents: [PocketDocument]
    public let issues: [String]
}

public enum PocketStorageError: LocalizedError {
    case invalid(String)
    public var errorDescription: String? { if case let .invalid(message) = self { return message }; return nil }
}

/// One protected, atomic file per screenplay. Working recovery and explicit
/// history commit together; failures leave the previous complete file intact.
public struct PocketRepository {
    public let directory: URL
    public static let maximumFileBytes = 32 * 1024 * 1024
    public static let maximumRevisions = 100
    public init(directory: URL) throws {
        self.directory = directory
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    }
    private func file(_ id: String) throws -> URL {
        guard UUID(uuidString: id) != nil else { throw PocketStorageError.invalid("Invalid screenplay identity.") }
        return directory.appendingPathComponent(id.lowercased()).appendingPathExtension("qilocal")
    }
    private func validate(_ document: PocketDocument) throws {
        try document.working.validate()
        guard document.revisions.count <= Self.maximumRevisions else {
            throw PocketStorageError.invalid("This screenplay has 100 saved revisions. Export a project copy before starting another revision history. Your existing history is retained.")
        }
        for (index, revision) in document.revisions.enumerated() {
            guard revision.id == index + 1, revision.snapshot.id == document.id else { throw PocketStorageError.invalid("The saved history is inconsistent.") }
            try revision.snapshot.validate()
        }
        if let continuation = document.continuation { try PocketPackage.validateContinuation(continuation) }
        if let hash = document.importedHash, hash.range(of: "^[a-f0-9]{64}$", options: .regularExpression) == nil {
            throw PocketStorageError.invalid("The import receipt is invalid.")
        }
    }
    private struct Envelope: Codable {
        var schema = "qicaniscreenwrite-pocket-store/v1"
        var sha256: String
        var payload: Data
    }
    public func persist(_ document: PocketDocument) throws {
        try validate(document)
        let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        let payload = try encoder.encode(document)
        let data = try encoder.encode(Envelope(sha256: PocketPackage.sha256(payload), payload: payload))
        guard data.count <= Self.maximumFileBytes else { throw PocketStorageError.invalid("The local history exceeds 32 MiB. Export your working project before starting another history. The previous saved file is unchanged.") }
        let url = try file(document.id)
        #if os(iOS)
        try data.write(to: url, options: [.atomic, .completeFileProtection])
        #else
        try data.write(to: url, options: .atomic)
        #endif
    }
    public func load() throws -> PocketLibraryLoad {
        var documents: [PocketDocument] = [], issues: [String] = []
        for url in try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: [.fileSizeKey, .isSymbolicLinkKey]).filter({ $0.pathExtension == "qilocal" }) {
            do {
                let info = try url.resourceValues(forKeys: [.fileSizeKey, .isSymbolicLinkKey])
                guard info.isSymbolicLink != true, (info.fileSize ?? Int.max) <= Self.maximumFileBytes else { throw PocketStorageError.invalid("Invalid or oversized file.") }
                let bytes = try Data(contentsOf: url)
                let decoder = JSONDecoder()
                let envelope = try decoder.decode(Envelope.self, from: bytes)
                guard envelope.schema == "qicaniscreenwrite-pocket-store/v1", PocketPackage.sha256(envelope.payload) == envelope.sha256 else { throw PocketStorageError.invalid("The file checksum does not match.") }
                let document = try decoder.decode(PocketDocument.self, from: envelope.payload)
                try validate(document)
                guard url.lastPathComponent == (try file(document.id)).lastPathComponent else { throw PocketStorageError.invalid("The filename does not match the screenplay identity.") }
                documents.append(document)
            } catch { issues.append("\(url.lastPathComponent): \(error.localizedDescription) The file has been left untouched.") }
        }
        return .init(documents: documents.sorted { $0.updatedAt > $1.updatedAt }, issues: issues)
    }
    public func newDocument(title: String = "Untitled", body: String = "") throws -> PocketDocument {
        let document = PocketDocument(working: .init(title: title, body: body))
        try persist(document); return document
    }
    public func saveRevision(_ document: PocketDocument, at date: Date = Date()) throws -> PocketDocument {
        if !document.hasUnsavedRevision { return document }
        var saved = document
        saved.revisions.append(.init(id: saved.revisions.count + 1, savedAt: date, snapshot: saved.working))
        saved.updatedAt = date
        try persist(saved); return saved
    }
    /// The phone file keeps its own identity and history. Only the returned package
    /// uses the originating Mac draft ID; the Mac verifies its issuance receipt.
    public func exportContinuation(_ document: PocketDocument) throws -> Data {
        try validate(document)
        guard let continuation = document.continuation else { throw PocketStorageError.invalid("This draft has no linked Mac trip. Export a project copy instead.") }
        var snapshot = document.working
        snapshot.id = String(continuation.draft.id.dropFirst("screenplay-draft:".count))
        return try PocketPackage.encodeContinuation(snapshot, continuation: continuation)
    }

    public func importPackage(_ data: Data, existing: [PocketDocument]) throws -> PocketDocument {
        let hash = try PocketPackage.contentHash(data)
        if let imported = existing.first(where: { $0.importedHash == hash }) { return imported }
        let transfer = try PocketPackage.decodeTransfer(data)
        var snapshot = transfer.snapshot
        snapshot.id = UUID().uuidString.lowercased()
        var document = PocketDocument(working: snapshot, importedHash: hash, continuation: transfer.continuation)
        document = try saveRevision(document)
        return document
    }
}
