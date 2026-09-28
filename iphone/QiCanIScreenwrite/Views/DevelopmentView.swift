import SwiftUI
import ScreenwriteCore

struct DevelopmentView: View {
    @Binding var snapshot: PocketSnapshot
    var body: some View {
        Form {
            Section("Screenplay") {
                TextField("Title", text: $snapshot.title).accessibilityIdentifier("draft-title")
                TextField("Genre", text: $snapshot.genre)
                TextField("Logline", text: $snapshot.logline, axis: .vertical).lineLimit(2...5)
                Picker("Format", selection: $snapshot.projectFormat) {
                    Text("Not set").tag(""); Text("Vertical / social").tag("vertical"); Text("Micro short").tag("micro"); Text("Short film").tag("short"); Text("30-minute pilot").tag("pilot_30"); Text("60-minute pilot").tag("pilot_60"); Text("Feature").tag("feature")
                }
            }
            Section("Story development") {
                field("Concept", text: $snapshot.development.concept)
                field("Development logline", text: $snapshot.development.logline)
                field("Synopsis", text: $snapshot.development.synopsis)
                field("Outline", text: $snapshot.development.outline)
                field("World overview", text: $snapshot.development.worldNotes)
            }
            Section("Beats") {
                ForEach($snapshot.development.beats) { $beat in
                    NavigationLink(beat.title.isEmpty ? "Untitled beat" : beat.title) {
                        Form { TextField("Title", text: $beat.title); field("Description", text: $beat.description) }.navigationTitle("Story beat")
                    }
                }
                Button("Add beat", systemImage: "plus") { snapshot.development.beats.append(.init()) }.disabled(snapshot.development.beats.count >= 200)
            }
            Section("Character development") {
                ForEach($snapshot.development.characters) { $character in
                    NavigationLink(character.name.isEmpty ? "Unnamed character" : character.name) {
                        Form { TextField("Name", text: $character.name); TextField("Role", text: $character.role); field("Description", text: $character.description); field("Arc", text: $character.arc) }.navigationTitle("Character")
                    }
                }
                Button("Add character", systemImage: "plus") { snapshot.development.characters.append(.init()) }.disabled(snapshot.development.characters.count >= 100)
            }
            Section("Research") {
                ForEach($snapshot.development.researchNotes) { $note in
                    NavigationLink(note.title.isEmpty ? "Untitled note" : note.title) {
                        Form { TextField("Title", text: $note.title); field("Notes", text: $note.notes); field("Source", text: $note.source) }.navigationTitle("Research note")
                    }
                }
                Button("Add research note", systemImage: "plus") { snapshot.development.researchNotes.append(.init()) }.disabled(snapshot.development.researchNotes.count >= 100)
                Text("Use Share → Film language & research to add a cited reference to this screenplay.").font(.caption).foregroundStyle(.secondary)
            }
        }
    }
    private func field(_ title: String, text: Binding<String>) -> some View {
        VStack(alignment: .leading, spacing: 6) { Text(title).font(.caption).foregroundStyle(.secondary); TextField(title, text: text, axis: .vertical).lineLimit(3...8).accessibilityLabel(title) }
    }
}
