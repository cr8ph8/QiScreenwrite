import SwiftUI
import UniformTypeIdentifiers
import ScreenwriteCore

extension UTType {
    static let qiScript = UTType(exportedAs: "com.hampton.qicaniscreenwrite.pocket", conformingTo: .json)
    static let fountainScript = UTType(exportedAs: "com.hampton.qicaniscreenwrite.fountain", conformingTo: .plainText)
}

struct ExportFile: FileDocument {
    static var readableContentTypes: [UTType] { [.qiScript, .fountainScript, .plainText] }
    var data: Data
    init(data: Data) { self.data = data }
    init(configuration: ReadConfiguration) throws {
        guard let bytes = configuration.file.regularFileContents else { throw CocoaError(.fileReadCorruptFile) }
        data = bytes
    }
    func fileWrapper(configuration: WriteConfiguration) throws -> FileWrapper { FileWrapper(regularFileWithContents: data) }
}

struct ReviewedImport: Identifiable {
    var id = UUID()
    var filename: String
    var bytes: Data
    var snapshot: PocketSnapshot
    var isPackage: Bool
    var continuation: PocketContinuation? = nil
}

struct StudioView: View {
    @Bindable var store: PocketStore
    @State private var path: [String] = []
    @State private var search = ""
    @State private var importing = false
    @State private var review: ReviewedImport?
    @State private var tab = 0

    var body: some View {
        TabView(selection: $tab) {
            NavigationStack(path: $path) {
                library
                    .navigationDestination(for: String.self) { id in DraftDetailView(store: store, id: id) }
                    .navigationTitle(AppIdentity.isQiMoviAlpha ? "My slate" : "My drafts")
                    .toolbar { ToolbarItemGroup(placement: .topBarTrailing) {
                        Button { importing = true } label: { Image(systemName: "square.and.arrow.down") }.accessibilityLabel("Import screenplay")
                        Button { if let id = store.create() { path.append(id) } } label: { Image(systemName: "plus") }.accessibilityLabel("New draft").accessibilityIdentifier("new-draft")
                    } }
                    .searchable(text: $search, prompt: "Find a screenplay")
            }.tabItem { Label(AppIdentity.isQiMoviAlpha ? "Slate" : "Drafts", systemImage: "doc.text") }.tag(0)
            NavigationStack { FilmLanguageView().navigationTitle("Film language") }
                .tabItem { Label("Knowledge", systemImage: "books.vertical") }.tag(1)
            NavigationStack { connections.navigationTitle("Exchange") }
                .tabItem { Label("Exchange", systemImage: "arrow.left.arrow.right") }.tag(2)
        }
        .fileImporter(isPresented: $importing, allowedContentTypes: [.qiScript, .fountainScript, .plainText, .json], allowsMultipleSelection: false) { result in
            do { if let url = try result.get().first { try readImport(url) } }
            catch { store.error = error.localizedDescription }
        }
        .sheet(item: $review) { item in ImportReviewView(item: item) { importReviewed(item) } }
        .alert("Your writing", isPresented: Binding(get: { store.error != nil }, set: { if !$0 { store.error = nil } })) {
            Button("OK", role: .cancel) { store.error = nil }
        } message: { Text(store.error ?? "") }
        .onOpenURL { url in do { try readImport(url) } catch { store.error = error.localizedDescription } }
    }

    private var filtered: [PocketDocument] {
        store.documents.filter { search.isEmpty || $0.working.title.localizedCaseInsensitiveContains(search) || $0.working.logline.localizedCaseInsensitiveContains(search) }
    }
    private var library: some View {
        List {
            Section {
                HStack(spacing: 14) {
                    Image(AppIdentity.mark).resizable().scaledToFit().frame(width: 54, height: 54).accessibilityHidden(true)
                    VStack(alignment: .leading, spacing: 4) {
                        Text(AppIdentity.name).font(.system(.title3, design: .serif).weight(.semibold))
                        Text(AppIdentity.isQiMoviAlpha ? "Writing & worlds · CanIScreenwrite" : "QiMovi · Writing & worlds").font(.subheadline).foregroundStyle(.secondary)
                    }
                }.padding(.vertical, 6)
            }
            if AppIdentity.isQiMoviAlpha {
                Section("Development · Alpha") {
                    Label("Write • Develop • Build your world", systemImage: "film")
                    Text("Open a screenplay to work on pages, story development, characters, worlds and creative feedback.")
                        .font(.footnote).foregroundStyle(.secondary)
                    Text("Storyboards, budgets, production and editorial remain in QiMovi on your Mac. Use Exchange to move reviewed writing between devices.")
                        .font(.footnote).foregroundStyle(.secondary)
                }
            }
            if !store.loadIssues.isEmpty {
                Section("Files need attention") {
                    ForEach(store.loadIssues, id: \.self) { Text($0).font(.caption).foregroundStyle(.orange).textSelection(.enabled) }
                }
            }
            Section("Screenplays · \(filtered.count)") {
                if store.documents.isEmpty {
                    ContentUnavailableView {
                        Label("Your next story", systemImage: "square.and.pencil")
                    } description: { Text("Start a draft or bring a Fountain screenplay or project copy from your Mac.") }
                    actions: { Button("Create a screenplay") { if let id = store.create() { path.append(id) } }.buttonStyle(.borderedProminent) }
                } else if filtered.isEmpty { Text("No matching screenplays.").foregroundStyle(.secondary) }
                ForEach(filtered) { document in
                    NavigationLink(value: document.id) {
                        VStack(alignment: .leading, spacing: 7) {
                            Text(document.working.title.isEmpty ? "Untitled" : document.working.title).font(.headline)
                            if !document.working.logline.isEmpty { Text(document.working.logline).font(.subheadline).foregroundStyle(.secondary).lineLimit(2) }
                            HStack {
                                Label("\(FountainOutline.scenes(in: document.working.body).count) scenes", systemImage: "film")
                                Spacer()
                                Text(document.revisions.isEmpty ? "Working copy" : "Revision \(document.revisions.count)")
                            }.font(.caption).foregroundStyle(.secondary)
                        }.padding(.vertical, 6)
                    }.accessibilityIdentifier("draft-\(document.id)")
                }
            }
            Section { Label("Writing, worlds and reference work offline.", systemImage: "iphone").font(.footnote).foregroundStyle(.secondary) }
        }.listStyle(.insetGrouped)
    }
    private var connections: some View {
        List {
            Section("Continue a linked Mac draft") {
                Text("On your Mac, choose Prepare linked phone trip in Connections → iPhone exchange. Import that file here, edit, then choose Export return to linked Mac in Share and research.")
                Text("Review the return on the same Mac workspace. It updates the original draft only if both saved base revisions still match. Each trip accepts one return; prepare a fresh trip for another cycle. Previous iPhone copies and histories remain here.").font(.footnote).foregroundStyle(.secondary)
            }
            Section("Move an independent copy") {
                Label("QiCanIScreenwrite project copy", systemImage: "macbook.and.iphone").font(.headline)
                Text("Open a screenplay, tap Share, then export a project copy to Files. Send the .qiscript file with AirDrop or another method you choose.")
                Text("On the desktop app, open Connections → iPhone exchange to review and import it. Export a desktop project copy there to bring it back here.")
            }
            Section("What travels") {
                Label("Screenplay and draft details", systemImage: "doc.text")
                Label("Development, research and world elements", systemImage: "globe")
                Text("Phone imports retain separate working copies. Linked trips remember their originating Mac draft and saved revisions; the Mac retains shared-world connections. Publication history, rights, originals, saved history and credentials stay on their original device.").font(.footnote).foregroundStyle(.secondary)
            }
            Section("QiMovi / FilmStack") {
                Text("Use your Mac's reviewed QiMovi connection after importing the phone project. Production and competition decisions stay in those systems.")
                Text("File exchange is manual. Edits in this app and QiCanIScreenwrite stay in their own libraries until you explicitly transfer them. Live sync is not enabled.").font(.footnote).foregroundStyle(.secondary)
            }
            Section { Button("Import from Files") { importing = true }.accessibilityIdentifier("import-files") }
            Section("This build") { Text("\(AppIdentity.name) \(AppIdentity.version) · Local authoring").font(.footnote) }
        }
    }
    private func readImport(_ url: URL) throws {
        let access = url.startAccessingSecurityScopedResource(); defer { if access { url.stopAccessingSecurityScopedResource() } }
        let info = try url.resourceValues(forKeys: [.fileSizeKey])
        guard let size = info.fileSize, size <= 8 * 1024 * 1024 else { throw PocketStorageError.invalid("Choose a project file smaller than 8 MiB.") }
        let data = try Data(contentsOf: url)
        guard data.count <= 8 * 1024 * 1024 else { throw PocketStorageError.invalid("This file is too large.") }
        let isPackage = ["qiscript", "json"].contains(url.pathExtension.lowercased())
        let snapshot: PocketSnapshot
        var continuation: PocketContinuation?
        if isPackage {
            let transfer = try PocketPackage.decodeTransfer(data)
            snapshot = transfer.snapshot; continuation = transfer.continuation
        }
        else {
            guard ["fountain", "txt"].contains(url.pathExtension.lowercased()), let text = String(data: data, encoding: .utf8) else { throw PocketStorageError.invalid("Choose a UTF-8 Fountain file or a QiCanIScreenwrite project copy.") }
            snapshot = .init(title: String(url.deletingPathExtension().lastPathComponent.prefix(200)), body: text)
            try snapshot.validate()
        }
        review = .init(filename: url.lastPathComponent, bytes: data, snapshot: snapshot, isPackage: isPackage, continuation: continuation)
    }
    private func importReviewed(_ item: ReviewedImport) {
        let id = item.isPackage ? store.importPackage(item.bytes) : store.create(title: item.snapshot.title, body: item.snapshot.body)
        if let id { review = nil; tab = 0; path = [id] }
    }
}

private struct ImportReviewView: View {
    let item: ReviewedImport
    let onImport: () -> Void
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        NavigationStack {
            List {
                Section("Source") { Text(item.filename).font(.headline); Text(item.snapshot.title); Text("\(item.snapshot.body.utf16.count) text characters · \(item.snapshot.development.world.elements.count) world elements").font(.caption) }
                if let continuation = item.continuation {
                    Section("Linked Mac trip") {
                        Text("Return edits to the originating Mac draft after review. The Mac checks screenplay v\(continuation.draft.version) and development v\(continuation.development.version) before applying them.")
                        Text("One accepted return per trip. Start a fresh trip on the Mac for another cycle. This creates a separate phone copy and retains all existing phone histories.").font(.footnote).foregroundStyle(.secondary)
                    }
                }
                Section { Text("Create a separate local working copy. Existing screenplays are kept. This project copy contains current creative content, without the source device's saved history or rights records.").font(.subheadline) }
                Section("Screenplay preview") { Text(item.snapshot.body.isEmpty ? "Empty screenplay" : item.snapshot.body).font(.system(.caption, design: .monospaced)).textSelection(.enabled) }
            }.navigationTitle("Review import").navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                    ToolbarItem(placement: .confirmationAction) { Button(item.continuation == nil ? "Import copy" : "Import linked trip", action: onImport).accessibilityIdentifier("confirm-import") }
                }
        }
    }
}
