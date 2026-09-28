import SwiftUI
import ScreenwriteCore

/// The parent supplies navigation, appearance, persistence and validation.
/// Edits patch one field on the current value; opening a form never rewrites it.
struct WorldBuilderView: View {
    @Binding var world: PocketWorld
    let screenplay: String

    @State private var query = ""
    @State private var category = "all"
    @State private var selectedID: String?
    @State private var scenes: [FountainScene] = []
    @State private var editError: String?

    init(world: Binding<PocketWorld>, screenplay: String) {
        _world = world
        self.screenplay = screenplay
    }

    private var visibleElements: [PocketWorldElement] {
        world.elements.enumerated().filter { _, element in
            (category == "all" || element.type == category) &&
            (query.isEmpty || [element.name, element.description, element.storyFunction,
                              element.sensoryDetails, element.continuity]
                .contains { $0.localizedStandardContains(query) })
        }.sorted {
            $0.element.order == $1.element.order
                ? $0.offset < $1.offset : $0.element.order < $1.element.order
        }.map(\.element)
    }

    var body: some View {
        List {
            Section {
                if let editError { Text(editError).foregroundStyle(.orange) }
                Text("\(world.elements.count) elements · \(world.links.count) connections")
                    .font(.subheadline).foregroundStyle(.secondary)
                Picker("Type", selection: $category) {
                    Text("All types").tag("all")
                    ForEach(WorldElementKind.allCases) { kind in
                        Text(kind.title).tag(kind.rawValue)
                    }
                }
                .accessibilityIdentifier("world.typeFilter")
            }

            Section("Your world") {
                if world.elements.isEmpty {
                    ContentUnavailableView("Build your world", systemImage: "globe",
                        description: Text("Add an element and write what matters to your story."))
                        .accessibilityIdentifier("world.empty")
                } else if visibleElements.isEmpty {
                    ContentUnavailableView.search(text: query)
                    Button("Show all elements") { query = ""; category = "all" }
                        .accessibilityIdentifier("world.clearFilters")
                }
                ForEach(visibleElements) { element in
                    Button { selectedID = element.id } label: {
                        HStack(alignment: .top) {
                            VStack(alignment: .leading, spacing: 5) {
                                Text(worldElementTitle(element)).font(.headline)
                                    .foregroundStyle(.primary)
                                Text("\(WorldElementKind.title(for: element.type)) · \(worldStatusTitle(element.status))")
                                    .font(.caption).foregroundStyle(.secondary)
                                if !element.description.isEmpty {
                                    Text(element.description).font(.subheadline)
                                        .foregroundStyle(.secondary).lineLimit(2)
                                }
                            }
                            Spacer(minLength: 8)
                            Image(systemName: "chevron.right").font(.caption)
                                .foregroundStyle(.secondary).accessibilityHidden(true)
                        }
                        .padding(.vertical, 4)
                    }
                    .accessibilityHint("Edit this world element")
                    .accessibilityIdentifier("world.element.\(element.id)")
                }
            }
            if world.elements.count >= 300 {
                Text("This world has reached the 300-element limit.")
                    .font(.footnote).foregroundStyle(.secondary)
            }
        }
        .navigationTitle("World Builder")
        .searchable(text: $query, prompt: "Search world")
        .accessibilityIdentifier("world.builder")
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Menu {
                    ForEach(WorldElementKind.allCases) { kind in
                        Button(kind.title, systemImage: kind.symbol) { addElement(kind) }
                            .accessibilityIdentifier("world.add.\(kind.rawValue)")
                    }
                } label: { Label("Add element", systemImage: "plus") }
                .disabled(world.elements.count >= 300)
                .accessibilityIdentifier("world.addElement")
            }
        }
        .onChange(of: screenplay, initial: true) { _, text in
            scenes = FountainOutline.scenes(in: text)
        }
        .navigationDestination(item: $selectedID) { id in
            WorldElementEditor(world: $world, elementID: id, scenes: scenes)
        }
    }

    private func addElement(_ kind: WorldElementKind) {
        guard world.elements.count < 300 else { return }
        var element = PocketWorldElement()
        element.type = kind.rawValue
        // Preserve existing order values, including an imported maximum safe integer.
        let lastOrder = world.elements.map(\.order).max() ?? -1
        element.order = lastOrder < 9_007_199_254_740_991 ? lastOrder + 1 : lastOrder
        var candidate = world
        candidate.elements.append(element)
        editError = worldValidationMessage(candidate)
        guard editError == nil else { return }
        world = candidate
        selectedID = element.id
    }
}

private enum WorldElementKind: String, CaseIterable, Identifiable {
    case character, location, world_rule, faction, timeline_note, thematic_note, prop, relationship
    var id: String { rawValue }
    var title: String {
        switch self {
        case .character: "Character"
        case .location: "Location"
        case .world_rule: "World rule"
        case .faction: "Faction"
        case .timeline_note: "Timeline note"
        case .thematic_note: "Thematic note"
        case .prop: "Prop"
        case .relationship: "Relationship"
        }
    }
    var symbol: String {
        switch self {
        case .character: "person"
        case .location: "mappin.and.ellipse"
        case .world_rule: "list.bullet.rectangle"
        case .faction: "person.3"
        case .timeline_note: "clock"
        case .thematic_note: "lightbulb"
        case .prop: "cube"
        case .relationship: "link"
        }
    }
    static func title(for value: String) -> String { Self(rawValue: value)?.title ?? value }
}

private func worldElementTitle(_ element: PocketWorldElement) -> String {
    element.name.isEmpty ? "Untitled \(WorldElementKind.title(for: element.type).lowercased())" : element.name
}

private func worldStatusTitle(_ status: String) -> String {
    switch status {
    case "idea": "Idea"
    case "established": "Established in my story"
    case "needs_review": "Needs review"
    default: status
    }
}

private func worldIDsMatch(_ left: String, _ right: String) -> Bool {
    left.caseInsensitiveCompare(right) == .orderedSame
}

/// Core checks all world fields, identities, flags, references and aggregate limits.
/// The parent's Store also checks the complete development record before persisting.
private func worldValidationMessage(_ world: PocketWorld) -> String? {
    do {
        var development = PocketDevelopment()
        development.world = world
        try PocketSnapshot(development: development).validate()
        return nil
    } catch { return error.localizedDescription }
}

private struct WorldConnectionTarget: Hashable, Identifiable {
    let type: String
    let reference: String
    let label: String
    var id: String { "\(type):\(reference)" }
}

/// Never substitute a scene index, line number or ephemeral scene ID for a reference.
private func worldSceneTargets(_ scenes: [FountainScene]) -> [WorldConnectionTarget] {
    let counts = Dictionary(grouping: scenes.compactMap(\.worldReference), by: { $0 })
    return scenes.compactMap { scene in
        guard let reference = scene.worldReference, !reference.isEmpty,
              counts[reference]?.count == 1,
              reference.utf16.count <= 500, scene.heading.utf16.count <= 500 else { return nil }
        return WorldConnectionTarget(type: "scene", reference: reference, label: scene.heading)
    }
}

private struct WorldElementEditor: View {
    @Binding var world: PocketWorld
    let elementID: String
    let scenes: [FountainScene]
    @State private var connectionSheet: ConnectionSheet?

    private struct ConnectionSheet: Identifiable { let id: String }
    private var element: PocketWorldElement? {
        world.elements.first { worldIDsMatch($0.id, elementID) }
    }
    private var outgoing: [PocketWorldLink] {
        world.links.filter { worldIDsMatch($0.elementId, elementID) }
    }
    private var incoming: [PocketWorldLink] {
        world.links.filter { $0.targetType == "element" && worldIDsMatch($0.targetRef, elementID) }
    }

    var body: some View {
        Group {
            if let element {
                Form {
                    Section("Element") {
                        elementTextField("Name", keyPath: \.name, limit: 160, identifier: "world.name")
                        Picker("Type", selection: field(\.type)) {
                            ForEach(WorldElementKind.allCases) { kind in
                                Text(kind.title).tag(kind.rawValue)
                            }
                        }
                        .accessibilityIdentifier("world.elementType")
                        Picker("Story status", selection: field(\.status)) {
                            Text("Idea").tag("idea")
                            Text("Established in my story").tag("established")
                            Text("Needs review").tag("needs_review")
                        }
                        .accessibilityIdentifier("world.storyStatus")
                        Text("Story status is your writing label.")
                            .font(.footnote).foregroundStyle(.secondary)
                    }
                    Section("Notes") {
                        elementTextField("Description", keyPath: \.description, limit: 8_000, identifier: "world.description")
                        elementTextField("Story function", keyPath: \.storyFunction, limit: 4_000, identifier: "world.storyFunction")
                        elementTextField("Sensory details", keyPath: \.sensoryDetails, limit: 4_000, identifier: "world.sensoryDetails")
                        elementTextField("Continuity", keyPath: \.continuity, limit: 4_000, identifier: "world.continuity")
                    }
                    Section("Connections from this element") {
                        ForEach(outgoing) { link in
                            WorldConnectionRow(world: $world, linkID: link.id, scenes: scenes)
                        }
                        if outgoing.isEmpty {
                            Text("No connections yet.").foregroundStyle(.secondary)
                        }
                        Button("Add connection", systemImage: "link.badge.plus") {
                            connectionSheet = ConnectionSheet(id: element.id)
                        }
                        .disabled(world.links.count >= 1_000)
                        .accessibilityIdentifier("world.addConnection")
                    }
                    if !incoming.isEmpty {
                        Section("Connections to this element") {
                            ForEach(incoming) { link in
                                VStack(alignment: .leading, spacing: 6) {
                                    Text(incomingTitle(link)).font(.headline)
                                    Text("Recorded target: \(link.targetLabel)")
                                        .font(.caption).foregroundStyle(.secondary)
                                    if !link.notes.isEmpty { Text(link.notes).font(.subheadline) }
                                }
                                .textSelection(.enabled)
                                .accessibilityIdentifier("world.incoming.\(link.id)")
                            }
                        }
                    }
                }
                .navigationTitle(worldElementTitle(element))
                .navigationBarTitleDisplayMode(.inline)
                .scrollDismissesKeyboard(.interactively)
                .accessibilityIdentifier("world.editor.\(element.id)")
            } else {
                ContentUnavailableView("Element unavailable", systemImage: "globe",
                    description: Text("This element is no longer in the current world."))
            }
        }
        .sheet(item: $connectionSheet) { sheet in
            NavigationStack {
                WorldConnectionForm(world: $world, elementID: sheet.id, scenes: scenes)
            }
        }
    }

    private func field(_ keyPath: WritableKeyPath<PocketWorldElement, String>) -> Binding<String> {
        Binding(get: { element?[keyPath: keyPath] ?? "" }, set: { value in
            guard let index = world.elements.firstIndex(where: { worldIDsMatch($0.id, elementID) }) else { return }
            var candidate = world
            candidate.elements[index][keyPath: keyPath] = value
            guard worldValidationMessage(candidate) == nil else { return }
            world = candidate
        })
    }

    private func elementTextField(_ title: String, keyPath: WritableKeyPath<PocketWorldElement, String>,
                                  limit: Int, identifier: String) -> some View {
        WorldTextField(title, text: field(keyPath), limit: limit, identifier: identifier) { value in
            guard let index = world.elements.firstIndex(where: { worldIDsMatch($0.id, elementID) }) else {
                return "This element is no longer available."
            }
            var candidate = world
            candidate.elements[index][keyPath: keyPath] = value
            return worldValidationMessage(candidate)
        }
    }

    private func incomingTitle(_ link: PocketWorldLink) -> String {
        world.elements.first { worldIDsMatch($0.id, link.elementId) }.map(worldElementTitle)
            ?? "Unresolved source element"
    }
}

private struct WorldTextField: View {
    let title: String
    @Binding var text: String
    let limit: Int
    let identifier: String
    let validate: (String) -> String?
    @State private var draft: String
    @State private var validationError: String?

    init(_ title: String, text: Binding<String>, limit: Int, identifier: String,
         validate: @escaping (String) -> String? = { _ in nil }) {
        self.title = title
        _text = text
        self.limit = limit
        self.identifier = identifier
        self.validate = validate
        _draft = State(initialValue: text.wrappedValue)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title).font(.caption).foregroundStyle(.secondary)
            TextField(title, text: Binding(get: { draft }, set: { value in
                draft = value
                if value.utf16.count > limit {
                    validationError = "The limit is \(limit) UTF-16 characters."
                } else if value.contains("\0") {
                    validationError = "Remove the null character from this text."
                } else {
                    validationError = validate(value)
                }
                if validationError == nil { text = value }
            }), axis: .vertical)
                .lineLimit(1...8)
                .accessibilityLabel(title)
                .accessibilityIdentifier(identifier)
            if let validationError {
                Label("Not applied: \(validationError) Correct this text before leaving the form.", systemImage: "exclamationmark.triangle")
                    .font(.footnote).foregroundStyle(.orange)
                    .accessibilityIdentifier("\(identifier).limit")
            }
        }
        .onChange(of: text) { previous, current in
            // External refreshes may update the same field. Keep any rejected local input visible.
            if draft == previous { draft = current; validationError = nil }
        }
    }
}

private struct WorldConnectionRow: View {
    @Binding var world: PocketWorld
    let linkID: String
    let scenes: [FountainScene]
    private var link: PocketWorldLink? { world.links.first { worldIDsMatch($0.id, linkID) } }

    var body: some View {
        if let link {
            VStack(alignment: .leading, spacing: 10) {
                Text(link.targetLabel.isEmpty ? "Unlabeled connection" : link.targetLabel).font(.headline)
                Text(link.targetType.capitalized).font(.caption).foregroundStyle(.secondary)
                resolution(link)
                DisclosureGroup("Stored reference") {
                    Text(link.targetRef).font(.footnote.monospaced()).textSelection(.enabled)
                }
                .accessibilityIdentifier("world.reference.\(link.id)")
                WorldTextField("Connection notes", text: Binding(get: { self.link?.notes ?? "" }, set: { value in
                    guard let index = world.links.firstIndex(where: { worldIDsMatch($0.id, linkID) }) else { return }
                    var candidate = world
                    candidate.links[index].notes = value
                    guard worldValidationMessage(candidate) == nil else { return }
                    world = candidate
                }), limit: 2_000, identifier: "world.connectionNotes.\(link.id)") { value in
                    guard let index = world.links.firstIndex(where: { worldIDsMatch($0.id, linkID) }) else {
                        return "This connection is no longer available."
                    }
                    var candidate = world
                    candidate.links[index].notes = value
                    return worldValidationMessage(candidate)
                }
            }
            .padding(.vertical, 4)
            .accessibilityIdentifier("world.connection.\(link.id)")
        }
    }

    @ViewBuilder private func resolution(_ link: PocketWorldLink) -> some View {
        if link.targetType == "element",
           let target = world.elements.first(where: { worldIDsMatch($0.id, link.targetRef) }) {
            Text("Connected to \(worldElementTitle(target))").font(.subheadline).foregroundStyle(.secondary)
        } else if link.targetType == "scene",
                  worldSceneTargets(scenes).contains(where: { $0.reference == link.targetRef && $0.label == link.targetLabel }) {
            Label("Matches current screenplay", systemImage: "checkmark.circle")
                .font(.subheadline).foregroundStyle(.secondary)
        } else {
            Label(link.targetType == "scene" ? "Unresolved scene link" : "Unresolved \(link.targetType) link",
                  systemImage: "exclamationmark.link")
                .font(.subheadline).foregroundStyle(.orange)
                .accessibilityIdentifier("world.unresolved.\(link.id)")
            Text(link.targetType == "character"
                 ? "The character reference is retained. This view cannot verify screenplay character cues."
                 : "The stored label and reference are retained. No matching target can be confirmed here.")
                .font(.footnote).foregroundStyle(.secondary)
        }
    }
}

private struct WorldConnectionForm: View {
    @Environment(\.dismiss) private var dismiss
    @Binding var world: PocketWorld
    let elementID: String
    let scenes: [FountainScene]
    @State private var targetType = "element"
    @State private var selected: WorldConnectionTarget?
    @State private var notes = ""

    private var targets: [WorldConnectionTarget] {
        if targetType == "scene" { return worldSceneTargets(scenes) }
        return world.elements.filter { !worldIDsMatch($0.id, elementID) }.map {
            WorldConnectionTarget(type: "element", reference: $0.id, label: $0.name)
        }
    }
    private var duplicate: Bool {
        guard let selected else { return false }
        return world.links.contains {
            worldIDsMatch($0.elementId, elementID) && $0.targetType == selected.type &&
            (selected.type == "element" ? worldIDsMatch($0.targetRef, selected.reference) : $0.targetRef == selected.reference)
        }
    }
    private var canAdd: Bool {
        guard let selected, targets.contains(selected), !duplicate else { return false }
        return world.elements.contains { worldIDsMatch($0.id, elementID) } &&
            world.links.count < 1_000 && additionError == nil
    }
    private var proposedWorld: PocketWorld? {
        guard let selected else { return nil }
        var candidate = world
        candidate.links.append(PocketWorldLink(elementId: elementID, targetType: selected.type,
            targetRef: selected.reference, targetLabel: selected.label, notes: notes))
        return candidate
    }
    private var additionError: String? {
        guard let proposedWorld else { return nil }
        return worldValidationMessage(proposedWorld)
    }

    var body: some View {
        Form {
            Section("Connect to") {
                Picker("Target type", selection: $targetType) {
                    Text("World element").tag("element")
                    Text("Screenplay scene").tag("scene")
                }
                .accessibilityIdentifier("world.connectionType")
                Picker("Target", selection: $selected) {
                    Text("Choose a target").tag(Optional<WorldConnectionTarget>.none)
                    ForEach(targets) { target in
                        Text(target.label.isEmpty ? "Untitled element" : target.label)
                            .tag(Optional(target))
                    }
                }
                .accessibilityIdentifier("world.connectionTarget")
                if targets.isEmpty {
                    Text(targetType == "scene"
                         ? "No scenes have a unique reference available for linking."
                         : "Add another world element to make a connection.")
                        .font(.footnote).foregroundStyle(.secondary)
                }
                if let selected, !targets.contains(selected) {
                    Text("The target changed. Choose a current target before adding this connection.")
                        .font(.footnote).foregroundStyle(.orange)
                }
                if targetType == "scene" {
                    Text("Only scenes with a canonical reference are offered. Scene links are checked against both their reference and recorded heading.")
                        .font(.footnote).foregroundStyle(.secondary)
                }
                if duplicate { Text("This connection already exists.").foregroundStyle(.secondary) }
            }
            Section("Notes") {
                // This is a local proposal until Add, so keep all typed text for correction.
                TextField("Connection notes", text: $notes, axis: .vertical)
                    .lineLimit(2...8)
                    .accessibilityIdentifier("world.newConnectionNotes")
                if let additionError {
                    Text(additionError).font(.footnote).foregroundStyle(.orange)
                        .accessibilityIdentifier("world.connectionValidation")
                }
            }
        }
        .navigationTitle("Add connection")
        .navigationBarTitleDisplayMode(.inline)
        .scrollDismissesKeyboard(.interactively)
        .onChange(of: targetType) { _, _ in selected = nil }
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("Cancel") { dismiss() }.accessibilityIdentifier("world.cancelConnection")
            }
            ToolbarItem(placement: .confirmationAction) {
                Button("Add") {
                    guard canAdd, let proposedWorld, worldValidationMessage(proposedWorld) == nil else { return }
                    world = proposedWorld
                    dismiss()
                }
                .disabled(!canAdd)
                .accessibilityIdentifier("world.confirmConnection")
            }
        }
    }
}
