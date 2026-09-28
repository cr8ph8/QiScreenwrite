import Foundation
import Observation
import ScreenwriteCore

@MainActor @Observable final class PocketStore {
    private(set) var documents: [PocketDocument] = []
    private(set) var loadIssues: [String] = []
    var error: String?
    private(set) var recovering: Set<String> = []
    private var tasks: [String: Task<Void, Never>] = [:]
    private var repository: PocketRepository?

    init(directory: URL? = nil) {
        do {
            let base = try directory ?? FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true).appendingPathComponent(AppIdentity.libraryFolder, isDirectory: true)
            let repository = try PocketRepository(directory: base)
            self.repository = repository
            let loaded = try repository.load(); documents = loaded.documents; loadIssues = loaded.issues
        } catch { self.error = "The local library could not open. \(error.localizedDescription)" }
    }
    func document(_ id: String) -> PocketDocument? { documents.first { $0.id == id } }
    @discardableResult func create(title: String = "Untitled", body: String = "") -> String? {
        do {
            guard let repository else { throw PocketStorageError.invalid("The local library is unavailable.") }
            let document = try repository.newDocument(title: title, body: body)
            documents.insert(document, at: 0); return document.id
        } catch { self.error = error.localizedDescription; return nil }
    }
    func edit(_ id: String, _ change: (inout PocketSnapshot) -> Void) {
        guard let index = documents.firstIndex(where: { $0.id == id }) else { return }
        change(&documents[index].working)
        documents[index].updatedAt = Date()
        recovering.insert(id)
        tasks[id]?.cancel()
        tasks[id] = Task { [weak self] in
            do { try await Task.sleep(for: .milliseconds(400)) } catch { return }
            guard !Task.isCancelled else { return }
            self?.flush(id)
        }
    }
    func flush(_ id: String) {
        tasks[id]?.cancel(); tasks[id] = nil
        guard let document = document(id), let repository else { return }
        do { try repository.persist(document); recovering.remove(id) }
        catch { self.error = "Your latest edits are still in the editor but could not be saved to this iPhone. Export a project copy. \(error.localizedDescription)" }
    }
    func flushAll() { for id in Array(recovering) { flush(id) } }
    func save(_ id: String) {
        tasks[id]?.cancel(); tasks[id] = nil
        guard let index = documents.firstIndex(where: { $0.id == id }), let repository else { return }
        do { documents[index] = try repository.saveRevision(documents[index]); recovering.remove(id) }
        catch { self.error = error.localizedDescription }
    }
    func restore(_ id: String, revision: PocketRevision) {
        edit(id) { snapshot in snapshot = revision.snapshot }
        flush(id)
    }
    func addResearch(_ note: PocketResearchNote, to id: String) {
        guard let document = document(id) else { return }
        do {
            var proposed = document.working
            proposed.development.researchNotes.append(note)
            try proposed.validate()
            edit(id) { $0 = proposed }; flush(id)
        } catch {
            self.error = "The research note could not be added. \(error.localizedDescription)"
        }
    }
    @discardableResult func importPackage(_ data: Data) -> String? {
        do {
            guard let repository else { throw PocketStorageError.invalid("The local library is unavailable.") }
            let document = try repository.importPackage(data, existing: documents)
            if !documents.contains(where: { $0.id == document.id }) { documents.insert(document, at: 0) }
            return document.id
        } catch { self.error = error.localizedDescription; return nil }
    }
    func exportContinuation(_ id: String) throws -> Data {
        guard let document = document(id), let repository else { throw PocketStorageError.invalid("This screenplay is unavailable.") }
        return try repository.exportContinuation(document)
    }
    func exportPackage(_ id: String) throws -> Data {
        guard let document = document(id) else { throw PocketStorageError.invalid("This screenplay is unavailable.") }
        return try PocketPackage.encode(document.working)
    }
}
