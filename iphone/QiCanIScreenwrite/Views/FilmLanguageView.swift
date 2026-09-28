import SwiftUI
import ScreenwriteCore

/// Bundled reference material; only an explicit source Link can open an online page.
/// Navigation, appearance and research-note persistence belong to the parent.
struct FilmLanguageView: View {
    let onAddResearch: ((PocketResearchNote) -> Void)?
    @State private var catalog: FilmLanguageCatalog?
    @State private var loadError: String?
    @State private var query = ""
    @State private var category = "all"
    @State private var kind = "all"

    init(onAddResearch: ((PocketResearchNote) -> Void)? = nil) {
        self.onAddResearch = onAddResearch
    }

    private var matches: [FilmLanguageEntry] {
        let words = filmSearchText(query).split(separator: " ").map(String.init)
        return (catalog?.entries ?? []).filter { entry in
            (category == "all" || entry.category == category) &&
            (kind == "all" || entry.kind == kind) &&
            words.allSatisfy { entry.searchText.contains($0) }
        }.sorted { $0.title.localizedStandardCompare($1.title) == .orderedAscending }
    }

    var body: some View {
        Group {
            if let catalog {
                List {
                    Section {
                        Text("\(catalog.entries.count) references available offline")
                            .font(.subheadline)
                        Picker("Category", selection: $category) {
                            Text("All categories").tag("all")
                            ForEach(FilmLanguageCatalog.categories, id: \.self) { value in
                                Text(value.capitalized).tag(value)
                            }
                        }
                        .accessibilityIdentifier("filmLanguage.category")
                        Picker("Kind", selection: $kind) {
                            Text("All kinds").tag("all")
                            ForEach(FilmLanguageCatalog.kinds, id: \.self) { value in
                                Text(value.capitalized).tag(value)
                            }
                        }
                        .accessibilityIdentifier("filmLanguage.kind")
                        NavigationLink("Catalog sources") { FilmLanguageSourcesView(catalog: catalog) }
                            .accessibilityIdentifier("filmLanguage.catalogSources")
                    } footer: {
                        Text("Definitions, writing guidance and citations are bundled. Source websites open only when you choose a link.")
                    }
                    if matches.isEmpty {
                        Section {
                            ContentUnavailableView.search(text: query)
                            Button("Show all references") { query = ""; category = "all"; kind = "all" }
                                .accessibilityIdentifier("filmLanguage.clearFilters")
                        }
                    } else {
                        Section("\(matches.count) references") {
                            ForEach(matches) { entry in
                                NavigationLink {
                                    FilmLanguageDetail(entry: entry, updatedOn: catalog.updatedOn,
                                                       onAddResearch: onAddResearch)
                                } label: {
                                    VStack(alignment: .leading, spacing: 5) {
                                        Text(entry.title).font(.headline)
                                        Text("\(entry.category.capitalized) · \(entry.kind.capitalized)")
                                            .font(.caption).foregroundStyle(.secondary)
                                        Text(entry.definition).font(.subheadline)
                                            .foregroundStyle(.secondary).lineLimit(2)
                                    }
                                    .padding(.vertical, 3)
                                }
                                .accessibilityIdentifier("filmLanguage.entry.\(entry.id)")
                            }
                        }
                    }
                }
            } else if let loadError {
                ContentUnavailableView {
                    Label("Film language unavailable", systemImage: "book.closed")
                } description: { Text(loadError) } actions: {
                    Button("Try again", action: loadCatalog)
                        .accessibilityIdentifier("filmLanguage.retry")
                }
            } else {
                ProgressView("Loading offline references")
            }
        }
        .navigationTitle("Film Language")
        .searchable(text: $query, prompt: "Search terms, guidance and sources")
        .accessibilityIdentifier("filmLanguage.library")
        .task { if catalog == nil && loadError == nil { loadCatalog() } }
    }

    private func loadCatalog() {
        do {
            guard let url = Bundle.main.url(forResource: "film-language", withExtension: "json")
                ?? Bundle.main.url(forResource: "film-language", withExtension: "json", subdirectory: "Resources") else {
                throw FilmLanguageError.missingResource
            }
            let decoded = try JSONDecoder().decode(FilmLanguageCatalog.self, from: Data(contentsOf: url))
            try decoded.validate()
            catalog = decoded
            loadError = nil
        } catch {
            loadError = "The bundled film language resource could not be read. \(error.localizedDescription)"
        }
    }
}

private struct FilmLanguageDetail: View {
    let entry: FilmLanguageEntry
    let updatedOn: String
    let onAddResearch: ((PocketResearchNote) -> Void)?
    @State private var noteRequested = false

    private var researchError: String? {
        do {
            // Validate the value before the callback. The parent validates total draft capacity.
            var development = PocketDevelopment()
            development.researchNotes = [entry.researchNote(updatedOn: updatedOn)]
            try PocketSnapshot(development: development).validate()
            return nil
        } catch { return error.localizedDescription }
    }

    var body: some View {
        List {
            Section {
                Text("\(entry.category.capitalized) · \(entry.kind.capitalized)")
                    .font(.subheadline).foregroundStyle(.secondary)
                Text(entry.definition)
            } header: { Text("Definition") }
            if !entry.aliases.isEmpty {
                Section("Also known as") { Text(entry.aliases.joined(separator: ", ")) }
            }
            Section("Application") { Text(entry.application) }
            Section("Writing prompt") { Text(entry.prompt) }
            if !entry.caveats.isEmpty {
                Section("Caveats") {
                    ForEach(Array(entry.caveats.enumerated()), id: \.offset) { _, caveat in Text(caveat) }
                }
            }
            Section {
                ForEach(Array(entry.sources.enumerated()), id: \.offset) { index, source in
                    FilmLanguageSourceRow(source: source, identifier: "filmLanguage.source.\(entry.id).\(index)")
                }
            } header: { Text("Sources") } footer: {
                Text("Source pages open online. The catalog was updated \(updatedOn).")
            }
            if let onAddResearch {
                Section {
                    Button {
                        guard researchError == nil, !noteRequested else { return }
                        onAddResearch(entry.researchNote(updatedOn: updatedOn))
                        noteRequested = true
                    } label: {
                        Label(noteRequested ? "Note sent to research" : "Add to research notes",
                              systemImage: noteRequested ? "checkmark" : "note.text.badge.plus")
                    }
                    .disabled(noteRequested || researchError != nil)
                    .accessibilityIdentifier("filmLanguage.addResearch")
                    if let researchError {
                        Text("This reference cannot be added as one note: \(researchError)")
                            .font(.footnote).foregroundStyle(.orange)
                            .accessibilityIdentifier("filmLanguage.researchError")
                    }
                } footer: {
                    Text("Adds a separate, attributed note with the definition, guidance, caveats and source links. Your draft handles saving.")
                }
            }
        }
        .textSelection(.enabled)
        .navigationTitle(entry.title)
        .navigationBarTitleDisplayMode(.inline)
        .accessibilityIdentifier("filmLanguage.detail.\(entry.id)")
    }
}

private struct FilmLanguageSourcesView: View {
    let catalog: FilmLanguageCatalog
    var body: some View {
        List {
            Section {
                Text("Updated \(catalog.updatedOn)")
                Text("The source decks and entry-specific citations are retained with the offline catalog.")
            }
            Section("Source decks") {
                ForEach(catalog.sources) { deck in
                    VStack(alignment: .leading, spacing: 6) {
                        FilmLanguageSourceRow(source: FilmLanguageSource(title: deck.title, url: deck.url, slideNumber: nil),
                                              identifier: "filmLanguage.deck.\(deck.id)")
                        Text("\(deck.slideCount) slides").font(.caption).foregroundStyle(.secondary)
                    }
                }
            }
        }
        .navigationTitle("Catalog sources")
        .navigationBarTitleDisplayMode(.inline)
        .accessibilityIdentifier("filmLanguage.sources")
    }
}

private struct FilmLanguageSourceRow: View {
    let source: FilmLanguageSource
    let identifier: String
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let url = source.linkURL {
                Link(destination: url) {
                    Label(source.label, systemImage: "arrow.up.right.square")
                }
                .accessibilityHint("Opens the source online")
                .accessibilityIdentifier(identifier)
            } else {
                Text(source.label)
                Text("Source link unavailable").font(.caption).foregroundStyle(.secondary)
            }
            Text(source.url).font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
        }
    }
}

private struct FilmLanguageCatalog: Decodable {
    static let categories = ["story", "image", "camera", "editing", "sound"]
    static let kinds = ["term", "practice", "theory", "technical"]
    let schema: String
    let updatedOn: String
    let sources: [FilmLanguageDeck]
    let entries: [FilmLanguageEntry]

    func validate() throws {
        guard schema == "caniscreenwrite-filmcraft-catalog/v1", !updatedOn.isEmpty, !entries.isEmpty,
              Set(entries.map(\.id)).count == entries.count,
              Set(sources.map(\.id)).count == sources.count else { throw FilmLanguageError.invalidResource }
        for entry in entries {
            guard [entry.id, entry.title, entry.definition, entry.application, entry.prompt].allSatisfy({ !$0.isEmpty }),
                  Self.categories.contains(entry.category), Self.kinds.contains(entry.kind),
                  (entry.aliases + entry.caveats).allSatisfy({ !$0.isEmpty }),
                  !entry.sources.isEmpty, entry.sources.allSatisfy(\.isValid) else {
                throw FilmLanguageError.invalidResource
            }
        }
        for source in sources {
            guard !source.id.isEmpty, source.slideCount > 0,
                  FilmLanguageSource(title: source.title, url: source.url, slideNumber: nil).isValid else {
                throw FilmLanguageError.invalidResource
            }
        }
    }
}

private struct FilmLanguageDeck: Decodable, Identifiable {
    let id: String
    let title: String
    let url: String
    let slideCount: Int
}

private struct FilmLanguageEntry: Decodable, Identifiable {
    let id: String
    let title: String
    let category: String
    let kind: String
    let definition: String
    let application: String
    let prompt: String
    let aliases: [String]
    let caveats: [String]
    let sources: [FilmLanguageSource]

    var searchText: String {
        filmSearchText(([title, category, kind, definition, application, prompt] + aliases + caveats
                        + sources.map { "\($0.label) \($0.url)" }).joined(separator: " "))
    }

    func researchNote(updatedOn: String) -> PocketResearchNote {
        var sections = ["Film language reference: \(title)", "\(category.capitalized) · \(kind.capitalized)", definition]
        if !aliases.isEmpty { sections.append("Also known as\n" + aliases.joined(separator: ", ")) }
        sections += ["Application\n\(application)", "Writing prompt\n\(prompt)"]
        if !caveats.isEmpty { sections.append("Caveats\n" + caveats.map { "• \($0)" }.joined(separator: "\n")) }
        let provenance = (["Bundled film language · \(id) · updated \(updatedOn)"]
                          + sources.map { "\($0.label)\n\($0.linkURL?.absoluteString ?? $0.url)" }).joined(separator: "\n\n")
        return PocketResearchNote(title: title, notes: sections.joined(separator: "\n\n"), source: provenance)
    }
}

private struct FilmLanguageSource: Decodable {
    let title: String
    let url: String
    let slideNumber: Int?
    var isValid: Bool { !title.isEmpty && linkURL != nil && (slideNumber == nil || slideNumber! > 0) }
    var label: String {
        guard let slideNumber else { return title }
        let pattern = "\\bslide\\s*#?\\s*\(slideNumber)\\b"
        return title.range(of: pattern, options: [.regularExpression, .caseInsensitive]) == nil
            ? "\(title) · slide \(slideNumber)" : title
    }
    var linkURL: URL? {
        guard var components = URLComponents(string: url),
              ["https", "http"].contains(components.scheme?.lowercased() ?? ""),
              let host = components.host, !host.isEmpty,
              components.user == nil, components.password == nil else { return nil }
        if let slideNumber, slideNumber > 0, (components.fragment ?? "").isEmpty {
            components.fragment = components.path.lowercased().hasSuffix(".pdf") ? "page=\(slideNumber)" : String(slideNumber)
        }
        return components.url
    }
}

private func filmSearchText(_ value: String) -> String {
    value.folding(options: [.caseInsensitive, .diacriticInsensitive, .widthInsensitive], locale: .current)
        .components(separatedBy: CharacterSet.alphanumerics.inverted)
        .filter { !$0.isEmpty }.joined(separator: " ")
}

private enum FilmLanguageError: LocalizedError {
    case missingResource, invalidResource
    var errorDescription: String? {
        switch self {
        case .missingResource: "film-language.json is missing from the app bundle."
        case .invalidResource: "The installed catalog has an invalid format."
        }
    }
}
