import SwiftUI
import UniformTypeIdentifiers
import ScreenwriteCore

private enum DraftTool: String, CaseIterable, Identifiable {
    case write = "Write", scenes = "Scenes", world = "World Builder", develop = "Develop", history = "History"
    var id: Self { self }
    var icon: String { switch self { case .write: "square.and.pencil"; case .scenes: "film"; case .world: "globe"; case .develop: "text.book.closed"; case .history: "clock.arrow.circlepath" } }
}

struct DraftDetailView: View {
    @Bindable var store: PocketStore
    let id: String
    @State private var tool = DraftTool.write
    @State private var exporting = false
    @State private var exportFile: ExportFile?
    @State private var exportType = UTType.qiScript
    @State private var exportName = "Screenplay"
    @State private var knowledge = false
    @State private var restore: PocketRevision?
    @State private var keyboardEditing = false

    private var snapshot: PocketSnapshot { store.document(id)?.working ?? .init() }
    private func field<Value>(_ path: WritableKeyPath<PocketSnapshot, Value>) -> Binding<Value> {
        Binding(get: { snapshot[keyPath: path] }, set: { value in store.edit(id) { $0[keyPath: path] = value } })
    }
    var body: some View {
        Group {
            if let document = store.document(id) {
                VStack(spacing: 0) {
                    if !keyboardEditing { status(document) }
                    switch tool {
                    case .write: WritingView(bodyText: field(\.body), onEditingChanged: { keyboardEditing = $0 })
                    case .scenes: scenes
                    case .world: WorldBuilderView(world: field(\.development.world), screenplay: snapshot.body)
                    case .develop: DevelopmentView(snapshot: Binding(get: { snapshot }, set: { value in store.edit(id) { $0 = value } }))
                    case .history: history(document)
                    }
                }
            } else { ContentUnavailableView("Screenplay unavailable", systemImage: "doc.questionmark") }
        }
        .navigationTitle(snapshot.title.isEmpty ? "Untitled" : snapshot.title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar(keyboardEditing ? .hidden : .visible, for: .navigationBar)
        .toolbar(tool == .write ? .hidden : .visible, for: .tabBar)
        .onChange(of: tool) { _, _ in keyboardEditing = false }
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                Menu {
                    Picker("Workspace", selection: $tool) { ForEach(DraftTool.allCases) { item in Label(item.rawValue, systemImage: item.icon).tag(item) } }
                    Divider()
                    NavigationLink("Creative services", destination: CreativeServicesView(draft: snapshot))
                }
                label: { Image(systemName: tool.icon) }.accessibilityLabel("Workspace tools").accessibilityIdentifier("workspace-tools")
            }
            ToolbarItemGroup(placement: .topBarTrailing) {
                Button { store.save(id) } label: { Image(systemName: "checkmark.circle") }.accessibilityLabel("Save revision").accessibilityIdentifier("save-revision")
                    .disabled(store.document(id)?.hasUnsavedRevision != true)
                Menu {
                    if store.document(id)?.continuation != nil {
                        Button("Export return to linked Mac", systemImage: "arrow.uturn.backward") { prepareExport(package: true, linked: true) }
                    }
                    Button("Export project copy", systemImage: "iphone.and.arrow.forward") { prepareExport(package: true) }
                    Button("Export Fountain", systemImage: "doc.plaintext") { prepareExport(package: false) }
                    Divider()
                    Button("Film language & research", systemImage: "books.vertical") { knowledge = true }
                } label: { Image(systemName: "square.and.arrow.up") }.accessibilityLabel("Share and research").accessibilityIdentifier("share-draft")
            }
        }
        .fileExporter(isPresented: $exporting, document: exportFile, contentType: exportType, defaultFilename: exportName) { result in
            if case let .failure(error) = result { store.error = "Export did not complete. \(error.localizedDescription)" }
        }
        .sheet(isPresented: $knowledge) {
            NavigationStack {
                FilmLanguageView(onAddResearch: { note in store.addResearch(note, to: id) })
                    .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { knowledge = false } } }
            }
        }
        .confirmationDialog("Restore saved revision?", isPresented: Binding(get: { restore != nil }, set: { if !$0 { restore = nil } }), titleVisibility: .visible) {
            if let selected = restore { Button("Restore revision \(selected.id) into working copy") { store.restore(id, revision: selected); restore = nil } }
            Button("Cancel", role: .cancel) { restore = nil }
        } message: { Text("This replaces the working screenplay, development and world with the selected revision. All saved revisions remain in history.") }
        .onDisappear { store.flush(id) }
    }
    private func status(_ document: PocketDocument) -> some View {
        HStack {
            Text(tool.rawValue).font(.caption.weight(.semibold)).foregroundStyle(.tint)
            Spacer()
            if store.recovering.contains(id) { Label("Saving working copy…", systemImage: "circle.dotted") }
            else if document.hasUnsavedRevision { Label("Working copy saved", systemImage: "iphone") }
            else { Label("Saved · v\(document.revisions.count)", systemImage: "checkmark.shield") }
        }.font(.caption2).foregroundStyle(.secondary).padding(.horizontal).padding(.vertical, 6).background(.thinMaterial)
    }
    private var scenes: some View {
        List {
            let outline = FountainOutline.scenes(in: snapshot.body)
            if outline.isEmpty { ContentUnavailableView("Your scenes appear here", systemImage: "film", description: Text("Start a paragraph with INT. or EXT. in your screenplay.")) }
            ForEach(Array(outline.enumerated()), id: \.element.id) { index, scene in
                NavigationLink {
                    ScrollView { Text(scene.text).font(.system(.body, design: .monospaced)).frame(maxWidth: .infinity, alignment: .leading).padding().textSelection(.enabled) }.navigationTitle(scene.heading).navigationBarTitleDisplayMode(.inline)
                } label: {
                    HStack(alignment: .top, spacing: 12) {
                        Text(String(format: "%02d", index + 1)).font(.caption.monospaced()).foregroundStyle(.tint)
                        VStack(alignment: .leading, spacing: 5) { Text(scene.heading).font(.subheadline.weight(.semibold)); Text("Line \(scene.line)\(scene.worldReference == nil ? " · Repeated heading; add a unique scene number to link" : "")").font(.caption).foregroundStyle(.secondary) }
                    }.padding(.vertical, 5)
                }
            }
            Section { Text("Outline and read-through from your Fountain text. Write → Pages provides draft page navigation; the desktop writer remains the final PDF layout reference.").font(.footnote).foregroundStyle(.secondary) }
        }
    }
    private func history(_ document: PocketDocument) -> some View {
        List {
            Section { Text("Save revision captures your screenplay, development and world together. Working-copy recovery is automatic and separate.").font(.subheadline).foregroundStyle(.secondary) }
            if document.revisions.isEmpty { ContentUnavailableView("No saved revisions yet", systemImage: "clock.arrow.circlepath", description: Text("Tap Save revision when you want a checkpoint.")) }
            ForEach(document.revisions.reversed()) { revision in
                NavigationLink {
                    List {
                        Section { Text(revision.snapshot.title).font(.headline); Text(revision.savedAt, style: .date); Text("\(revision.snapshot.development.world.elements.count) world elements · \(revision.snapshot.development.researchNotes.count) research notes") }
                        Section { Button("Restore this revision") { restore = revision }.disabled(revision.snapshot == snapshot) }
                        Section("Saved screenplay") { Text(revision.snapshot.body).font(.system(.caption, design: .monospaced)).textSelection(.enabled) }
                    }.navigationTitle("Revision \(revision.id)")
                } label: {
                    VStack(alignment: .leading, spacing: 6) { Text("Revision \(revision.id) · \(revision.snapshot.title)").font(.headline); Text(revision.savedAt, style: .date).font(.caption).foregroundStyle(.secondary) }
                }
            }
        }
    }
    private func prepareExport(package: Bool, linked: Bool = false) {
        do {
            let data = linked ? try store.exportContinuation(id) : package ? try store.exportPackage(id) : Data(snapshot.body.utf8)
            exportFile = .init(data: data); exportType = package ? .qiScript : .fountainScript
            let name = snapshot.title.components(separatedBy: CharacterSet(charactersIn: "/\\:\n\r")).joined(separator: "-")
            exportName = (name.isEmpty ? "Screenplay" : name) + (linked ? "-linked-return" : "")
            exporting = true
        } catch { store.error = error.localizedDescription }
    }
}
